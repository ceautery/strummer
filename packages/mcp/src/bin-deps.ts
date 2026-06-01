#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Packument } from '@strummer/deps'
import { resolveAndPin } from '@strummer/safety'
import { createDepsServer, type PackumentFetcher } from './deps.js'

/** Parsed, operator-set configuration for the deps MCP bin (set at launch). */
export interface DepsBinConfig {
  /** Directory of the on-disk OSV snapshot (`<dir>/<ecosystem>/all.zip`). */
  osvDir?: string
  /** Allow network access to fetch package metadata. OFF by default. */
  allowNetwork: boolean
  /** npm registry base URL the packument fetcher targets. */
  registry: string
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
function makeFetcher(registry: string, allowPrivate: boolean): PackumentFetcher {
  return async (packageName, ecosystem) => {
    if (ecosystem !== 'npm') {
      throw new Error(
        `network packument fetch supports the npm ecosystem only (got "${ecosystem}")`,
      )
    }
    const url = packumentUrl(registry, packageName)
    const host = new URL(url).hostname
    await resolveAndPin(host, undefined, { allowPrivate })
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      throw new Error(`registry returned ${res.status} for ${packageName}`)
    }
    return (await res.json()) as Packument
  }
}

/**
 * Build the deps MCP server from operator env. Network is OFF by default; the OSV
 * snapshot is operator-provisioned out-of-band:
 *   STRUMMER_DEPS_OSV_DB_DIR=/var/lib/strummer/osv   # <dir>/<ecosystem>/all.zip
 *   STRUMMER_DEPS_ALLOW_NETWORK=1                     # enable packument fetching
 *   STRUMMER_DEPS_NPM_REGISTRY=https://registry.npmjs.org
 *   STRUMMER_DEPS_ALLOW_PRIVATE=1                     # permit a local registry mirror
 */
export function buildDepsServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltDepsServer {
  const config: DepsBinConfig = {
    osvDir: env.STRUMMER_DEPS_OSV_DB_DIR || undefined,
    allowNetwork: bool(env.STRUMMER_DEPS_ALLOW_NETWORK),
    registry: env.STRUMMER_DEPS_NPM_REGISTRY || 'https://registry.npmjs.org',
    allowPrivate: bool(env.STRUMMER_DEPS_ALLOW_PRIVATE),
  }
  const server = createDepsServer({
    osvDir: config.osvDir,
    fetchPackument: config.allowNetwork
      ? makeFetcher(config.registry, config.allowPrivate)
      : undefined,
  })
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildDepsServerFromEnv()
  await server.connect(new StdioServerTransport())
}
