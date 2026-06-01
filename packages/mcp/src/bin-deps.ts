#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ArtifactStore } from '@strummer/artifacts'
import {
  normalizePypiName,
  type Packument,
  type PyPiJson,
  pypiJsonToPackument,
} from '@strummer/deps'
import { resolveAndPin } from '@strummer/safety'
import { type ChangelogFetcher, createDepsServer, type PackumentFetcher } from './deps.js'

/** Parsed, operator-set configuration for the deps MCP bin (set at launch). */
export interface DepsBinConfig {
  /** Directory of the on-disk OSV snapshot (`<dir>/<ecosystem>/all.zip`). */
  osvDir?: string
  /** Directory backing `changelog_diff`'s by-handle output. Absent ⇒ the tool is
   * not enabled (it emits large, multi-version markdown by handle). */
  artifactDir?: string
  /** Allow network access to fetch package metadata + changelogs. OFF by default. */
  allowNetwork: boolean
  /** npm registry base URL the packument fetcher targets. */
  registry: string
  /** PyPI JSON-API base URL (`<base>/<project>/json`) the PyPI packument fetcher targets. */
  pypiRegistry: string
  /** Permit a loopback/private registry mirror (e.g. a local Verdaccio). Default
   * false — the public registry is global, so private targets are refused unless
   * the operator opts in. */
  allowPrivate: boolean
}

export interface BuiltDepsServer {
  server: McpServer
  config: DepsBinConfig
}

function bool(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())
}

/** npm packument path: keep a scope's `@` but escape the `/` (registry idiom). */
function packumentUrl(registry: string, packageName: string): string {
  const base = registry.replace(/\/+$/, '')
  return `${base}/${packageName.replace('/', '%2f')}`
}

/**
 * Build an operator-gated, SSRF-pinned npm packument fetcher. Pre-flight resolves
 * the registry host and refuses a blocked range (metadata/link-local always; private
 * unless `allowPrivate`) before the request leaves — mirroring the API pillar's
 * pre-flight resolve-and-refuse (an accepted narrow TOCTOU vs the browser proxy's
 * true pinning; the registry is operator-configured, not agent-supplied).
 */
function makeFetcher(
  registry: string,
  pypiRegistry: string,
  allowPrivate: boolean,
): PackumentFetcher {
  return async (packageName, ecosystem) => {
    if (ecosystem === 'npm') {
      const url = packumentUrl(registry, packageName)
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate })
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) {
        throw new Error(`registry returned ${res.status} for ${packageName}`)
      }
      return (await res.json()) as Packument
    }
    if (ecosystem === 'PyPI') {
      const base = pypiRegistry.replace(/\/+$/, '')
      const url = `${base}/${encodeURIComponent(normalizePypiName(packageName))}/json`
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate })
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) {
        throw new Error(`PyPI returned ${res.status} for ${packageName}`)
      }
      return pypiJsonToPackument((await res.json()) as PyPiJson)
    }
    throw new Error(`network packument fetch supports npm and PyPI (got "${ecosystem}")`)
  }
}

/** Pull an `owner/repo` out of a packument `repository` field (string or `{url}`). */
function githubRepo(packument: Packument): { owner: string; repo: string } | undefined {
  const repo = (packument as { repository?: unknown }).repository
  const url = typeof repo === 'string' ? repo : (repo as { url?: string } | undefined)?.url
  const m = url?.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/#].*)?$/i)
  return m ? { owner: m[1] as string, repo: m[2] as string } : undefined
}

// CHANGELOG filenames seen in the wild, in priority order; first 200 wins.
const CHANGELOG_FILES = [
  'CHANGELOG.md',
  'CHANGELOG.markdown',
  'CHANGELOG',
  'changelog.md',
  'History.md',
  'HISTORY.md',
]

/**
 * Build an operator-gated, SSRF-pinned changelog fetcher. Resolves the package's
 * GitHub repo from its packument, then fetches the CHANGELOG from
 * `raw.githubusercontent.com/<owner>/<repo>/HEAD/<file>` (HEAD = default branch),
 * SSRF-pinning the raw host on every attempt. Fails loud if no repo/changelog is found.
 */
function makeChangelogFetcher(
  registry: string,
  pypiRegistry: string,
  allowPrivate: boolean,
): ChangelogFetcher {
  const fetchPackument = makeFetcher(registry, pypiRegistry, allowPrivate)
  return async (packageName, ecosystem) => {
    if (ecosystem !== 'npm') {
      throw new Error(`changelog fetch supports the npm ecosystem only (got "${ecosystem}")`)
    }
    const packument = await fetchPackument(packageName, ecosystem)
    const gh = githubRepo(packument)
    if (!gh) {
      throw new Error(`could not resolve a GitHub repository for "${packageName}"`)
    }
    for (const file of CHANGELOG_FILES) {
      const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/${file}`
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate })
      const res = await fetch(url)
      if (res.ok) return { text: await res.text(), source: url }
    }
    throw new Error(`no CHANGELOG found in github.com/${gh.owner}/${gh.repo}`)
  }
}

/**
 * Build the deps MCP server from operator env. Network is OFF by default; the OSV
 * snapshot is operator-provisioned out-of-band:
 *   STRUMMER_DEPS_OSV_DB_DIR=/var/lib/strummer/osv   # <dir>/<ecosystem>/all.zip
 *   STRUMMER_DEPS_ARTIFACT_DIR=/var/lib/strummer/deps # backs changelog_diff handles
 *   STRUMMER_DEPS_ALLOW_NETWORK=1                     # enable packument + changelog fetch
 *   STRUMMER_DEPS_NPM_REGISTRY=https://registry.npmjs.org
 *   STRUMMER_DEPS_PYPI_REGISTRY=https://pypi.org/pypi  # PyPI JSON API base
 *   STRUMMER_DEPS_ALLOW_PRIVATE=1                     # permit a local registry mirror
 */
export function buildDepsServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltDepsServer {
  const config: DepsBinConfig = {
    osvDir: env.STRUMMER_DEPS_OSV_DB_DIR || undefined,
    artifactDir: env.STRUMMER_DEPS_ARTIFACT_DIR || undefined,
    allowNetwork: bool(env.STRUMMER_DEPS_ALLOW_NETWORK),
    registry: env.STRUMMER_DEPS_NPM_REGISTRY || 'https://registry.npmjs.org',
    pypiRegistry: env.STRUMMER_DEPS_PYPI_REGISTRY || 'https://pypi.org/pypi',
    allowPrivate: bool(env.STRUMMER_DEPS_ALLOW_PRIVATE),
  }
  const server = createDepsServer({
    osvDir: config.osvDir,
    fetchPackument: config.allowNetwork
      ? makeFetcher(config.registry, config.pypiRegistry, config.allowPrivate)
      : undefined,
    fetchChangelog: config.allowNetwork
      ? makeChangelogFetcher(config.registry, config.pypiRegistry, config.allowPrivate)
      : undefined,
    artifacts:
      config.artifactDir !== undefined ? new ArtifactStore(config.artifactDir, 'deps') : undefined,
  })
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildDepsServerFromEnv()
  await server.connect(new StdioServerTransport())
}
