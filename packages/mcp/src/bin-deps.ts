#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ArtifactStore, DEFAULT_SWEEP_INTERVAL_MS, retentionFromEnv } from '@strummer/artifacts'
import {
  CHANGELOG_FILENAMES,
  gemRepoUrl,
  githubOwnerRepo,
  normalizePypiName,
  npmRepoUrl,
  type Packument,
  type PyPiJson,
  pypiJsonToPackument,
  pypiRepoUrl,
  type RubyGemMetadata,
  type RubyGemsVersion,
  rubygemsToPackument,
} from '@strummer/deps'
import { resolveAndPin } from '@strummer/safety'
import {
  type ChangelogFetcher,
  createDepsServer,
  type DepsToolsOptions,
  type PackumentFetcher,
  registerDepsTools,
} from './deps.js'
import type { PillarSetup } from './pillars.js'

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
  /** RubyGems API base URL (`<base>/versions/<name>.json`) the Gem packument fetcher targets. */
  rubygemsRegistry: string
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
  rubygemsRegistry: string,
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
    if (ecosystem === 'RubyGems') {
      const base = rubygemsRegistry.replace(/\/+$/, '')
      const url = `${base}/versions/${encodeURIComponent(packageName)}.json`
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate })
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) {
        throw new Error(`RubyGems returned ${res.status} for ${packageName}`)
      }
      return rubygemsToPackument(packageName, (await res.json()) as RubyGemsVersion[])
    }
    throw new Error(`network packument fetch supports npm, PyPI, and RubyGems (got "${ecosystem}")`)
  }
}

/**
 * The deps NETWORK surface from operator env — the OSV snapshot dir + an SSRF-pinned
 * packument fetcher, gated on `STRUMMER_DEPS_ALLOW_NETWORK` (OFF by default). One source
 * for the security-critical fetcher construction, shared by the deps server bin AND the
 * verify bin's deps run-driving wiring (slice 5d). `fetchPackument` is undefined when
 * network is off. Never reads a verify/run env — the verify bin composes its own
 * `ENABLE_RUN` opt-in on top ("both required").
 */
export function depsNetworkConfig(env: Record<string, string | undefined> = process.env): {
  osvDir?: string
  allowNetwork: boolean
  fetchPackument?: PackumentFetcher
} {
  const allowNetwork = bool(env.STRUMMER_DEPS_ALLOW_NETWORK)
  return {
    osvDir: env.STRUMMER_DEPS_OSV_DB_DIR || undefined,
    allowNetwork,
    fetchPackument: allowNetwork
      ? makeFetcher(
          env.STRUMMER_DEPS_NPM_REGISTRY || 'https://registry.npmjs.org',
          env.STRUMMER_DEPS_PYPI_REGISTRY || 'https://pypi.org/pypi',
          env.STRUMMER_DEPS_RUBYGEMS_REGISTRY || 'https://rubygems.org/api/v1',
          bool(env.STRUMMER_DEPS_ALLOW_PRIVATE),
        )
      : undefined,
  }
}

/** SSRF-pinned JSON GET (pre-flight resolve-and-refuse, then fetch). */
async function pinnedFetchJson(url: string, allowPrivate: boolean): Promise<unknown> {
  await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate })
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`metadata fetch returned ${res.status} for ${url}`)
  return res.json()
}

/**
 * Build an operator-gated, SSRF-pinned changelog fetcher (npm/PyPI/RubyGems). Resolves the
 * package's source GitHub repo from registry metadata — npm packument `repository`, PyPI
 * `info.project_urls`, or the RubyGems gem JSON `source_code_uri`/`homepage_uri` (a SEPARATE
 * `/api/v1/gems/<name>.json` fetch; the packument path stays on the versions array for freshness)
 * — then fetches the CHANGELOG from `raw.githubusercontent.com/<owner>/<repo>/HEAD/<file>`
 * (HEAD = default branch), SSRF-pinning every request. Fails loud if no repo/changelog is found.
 */
function makeChangelogFetcher(
  registry: string,
  pypiRegistry: string,
  rubygemsRegistry: string,
  allowPrivate: boolean,
): ChangelogFetcher {
  const fetchPackument = makeFetcher(registry, pypiRegistry, rubygemsRegistry, allowPrivate)
  const repoUrlFor = async (
    packageName: string,
    ecosystem: string,
  ): Promise<string | undefined> => {
    if (ecosystem === 'npm') return npmRepoUrl(await fetchPackument(packageName, 'npm'))
    if (ecosystem === 'PyPI') {
      const base = pypiRegistry.replace(/\/+$/, '')
      const url = `${base}/${encodeURIComponent(normalizePypiName(packageName))}/json`
      return pypiRepoUrl((await pinnedFetchJson(url, allowPrivate)) as PyPiJson)
    }
    if (ecosystem === 'RubyGems') {
      const base = rubygemsRegistry.replace(/\/+$/, '')
      const url = `${base}/gems/${encodeURIComponent(packageName)}.json`
      return gemRepoUrl((await pinnedFetchJson(url, allowPrivate)) as RubyGemMetadata)
    }
    throw new Error(`changelog fetch supports npm, PyPI, and RubyGems (got "${ecosystem}")`)
  }
  return async (packageName, ecosystem) => {
    const gh = githubOwnerRepo(await repoUrlFor(packageName, ecosystem))
    if (!gh) {
      throw new Error(`could not resolve a GitHub repository for "${packageName}"`)
    }
    for (const file of CHANGELOG_FILENAMES) {
      const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/${file}`
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate })
      const res = await fetch(url)
      if (res.ok) return { text: await res.text(), source: url }
    }
    throw new Error(`no CHANGELOG found in github.com/${gh.owner}/${gh.repo}`)
  }
}

/** Parse the operator env into the deps bin config (single source of truth). */
export function depsConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DepsBinConfig {
  return {
    osvDir: env.STRUMMER_DEPS_OSV_DB_DIR || undefined,
    artifactDir: env.STRUMMER_DEPS_ARTIFACT_DIR || undefined,
    allowNetwork: bool(env.STRUMMER_DEPS_ALLOW_NETWORK),
    registry: env.STRUMMER_DEPS_NPM_REGISTRY || 'https://registry.npmjs.org',
    pypiRegistry: env.STRUMMER_DEPS_PYPI_REGISTRY || 'https://pypi.org/pypi',
    rubygemsRegistry: env.STRUMMER_DEPS_RUBYGEMS_REGISTRY || 'https://rubygems.org/api/v1',
    allowPrivate: bool(env.STRUMMER_DEPS_ALLOW_PRIVATE),
  }
}

/**
 * Build the {@link DepsToolsOptions} the server is configured with — the OSV snapshot dir,
 * the SSRF-pinned packument/changelog fetchers (only when network is enabled), and the
 * by-handle artifact store (only when an artifact dir is set). Single construction path
 * shared by `buildDepsServerFromEnv` and `setupDepsFromEnv` so the two surfaces can't drift.
 */
function depsToolsOptions(
  config: DepsBinConfig,
  env: Record<string, string | undefined>,
): DepsToolsOptions {
  const net = depsNetworkConfig(env)
  return {
    osvDir: net.osvDir,
    fetchPackument: net.fetchPackument,
    fetchChangelog: config.allowNetwork
      ? makeChangelogFetcher(
          config.registry,
          config.pypiRegistry,
          config.rubygemsRegistry,
          config.allowPrivate,
        )
      : undefined,
    artifacts:
      config.artifactDir !== undefined
        ? new ArtifactStore(config.artifactDir, 'deps', {
            retention: retentionFromEnv({
              maxAgeMs: env.STRUMMER_DEPS_ARTIFACT_MAX_AGE_MS,
              maxEntries: env.STRUMMER_DEPS_ARTIFACT_MAX_ENTRIES,
              maxBytes: env.STRUMMER_DEPS_ARTIFACT_MAX_BYTES,
            }),
            sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS,
          })
        : undefined,
  }
}

/**
 * The aggregate-composition seam (ADR 0019): parse env, return a {@link PillarSetup}
 * that registers the deps tools onto a (possibly shared) server. Deps owns no long-lived
 * resource the aggregate must tear down (the optional artifact store's sweep timer is
 * unref'd + opportunistic), so there is no `shutdown`.
 */
export function setupDepsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PillarSetup {
  const opts = depsToolsOptions(depsConfigFromEnv(env), env)
  return { register: (server) => registerDepsTools(server, opts) }
}

/**
 * Build the deps MCP server from operator env. Network is OFF by default; the OSV
 * snapshot is operator-provisioned out-of-band:
 *   STRUMMER_DEPS_OSV_DB_DIR=/var/lib/strummer/osv   # <dir>/<ecosystem>/all.zip
 *   STRUMMER_DEPS_ARTIFACT_DIR=/var/lib/strummer/deps # backs changelog_diff handles
 *   STRUMMER_DEPS_ALLOW_NETWORK=1                     # enable packument + changelog fetch
 *   STRUMMER_DEPS_NPM_REGISTRY=https://registry.npmjs.org
 *   STRUMMER_DEPS_PYPI_REGISTRY=https://pypi.org/pypi  # PyPI JSON API base
 *   STRUMMER_DEPS_RUBYGEMS_REGISTRY=https://rubygems.org/api/v1  # RubyGems API base
 *   STRUMMER_DEPS_ALLOW_PRIVATE=1                     # permit a local registry mirror
 */
export function buildDepsServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltDepsServer {
  const config = depsConfigFromEnv(env)
  const server = createDepsServer(depsToolsOptions(config, env))
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildDepsServerFromEnv()
  await server.connect(new StdioServerTransport())
}
