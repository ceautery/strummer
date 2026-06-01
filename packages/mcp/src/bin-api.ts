#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveSecretStore } from '@strummer/api'
import { createApiServer } from './index.js'

/** Parsed, operator-set configuration for the API MCP bin (set at launch). */
export interface ApiBinConfig {
  allowUnsafe: boolean
  allowedHosts: string[]
  /** Chain the OS keyring ahead of the env secret store. */
  keyring: boolean
  /** Permit loopback/private SSRF targets (default true; STRUMMER_BLOCK_PRIVATE flips it). */
  allowPrivate: boolean
}

export interface BuiltApiServer {
  server: McpServer
  config: ApiBinConfig
}

function bool(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
}

/**
 * Build the API MCP server from operator env. Safety is operator-set, never by
 * the agent (see ADR 0004): mutating requests stay dry-run unless BOTH
 * `STRUMMER_ALLOW_UNSAFE` and a `STRUMMER_ALLOWED_HOSTS` allowlist are present.
 *   STRUMMER_ALLOW_UNSAFE=1
 *   STRUMMER_ALLOWED_HOSTS=api.example.com,127.0.0.1
 *   STRUMMER_KEYRING=1        # chain the OS keyring ahead of STRUMMER_SECRET_<NAME>
 *   STRUMMER_BLOCK_PRIVATE=1  # also refuse loopback/RFC1918 SSRF targets (hardened)
 */
export function buildApiServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltApiServer {
  const config: ApiBinConfig = {
    allowUnsafe: bool(env.STRUMMER_ALLOW_UNSAFE),
    allowedHosts: csv(env.STRUMMER_ALLOWED_HOSTS),
    keyring: bool(env.STRUMMER_KEYRING),
    allowPrivate: !bool(env.STRUMMER_BLOCK_PRIVATE),
  }
  const server = createApiServer({
    allowUnsafe: config.allowUnsafe,
    allowedHosts: config.allowedHosts,
    allowPrivate: config.allowPrivate,
    secrets: config.keyring ? resolveSecretStore({ keyring: true }) : undefined,
  })
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildApiServerFromEnv()
  await server.connect(new StdioServerTransport())
}
