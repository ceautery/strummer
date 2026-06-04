#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ArtifactStore } from '@strummer/artifacts'
import { createVerifyServer } from './index.js'

/**
 * Operator-set config for the verify MCP bin. v1 is COMPOSE-ONLY / zero-spawn:
 * `request_verdict` folds pillar results the caller already gathered, so the bin
 * reads ONLY the shared artifacts root (for verdict-by-handle) + the capture gate.
 * It deliberately does NOT read any per-pillar `*_ALLOW_RUN` env — wiring those
 * here would silently grant a future verify code path an operator's per-pillar
 * runner grant via a shared name (ADR 0013 §3c). Run-driving is staged.
 */
export interface VerifyBinConfig {
  artifactsRoot?: string
  /** Reserved for when verify hosts capture resolution; threaded, never per-pillar run. */
  allowCapture: boolean
}

export interface BuiltVerifyServer {
  server: McpServer
  config: VerifyBinConfig
}

function bool(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())
}

export function buildVerifyServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltVerifyServer {
  const config: VerifyBinConfig = {
    artifactsRoot: env.STRUMMER_ARTIFACTS_ROOT || undefined,
    allowCapture: bool(env.STRUMMER_VERIFY_ALLOW_CAPTURE),
  }
  let storeVerdict:
    | ((id: string, kind: string, body: string, contentType: string) => string)
    | undefined
  let resolveVerdict:
    | ((handle: string) => { contentType: string; body: Buffer } | undefined)
    | undefined
  if (config.artifactsRoot) {
    const store = new ArtifactStore(config.artifactsRoot, 'verify')
    storeVerdict = (id, kind, body, contentType) => store.put(id, kind, body, contentType)
    resolveVerdict = (handle) => {
      const a = store.get(handle)
      return a ? { contentType: a.contentType, body: a.body } : undefined
    }
  }
  const server = createVerifyServer({ storeVerdict, resolveVerdict })
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildVerifyServerFromEnv()
  await server.connect(new StdioServerTransport())
}
