/**
 * The deterministic test harness for the LSP pillar (ADR 0011) — NOT production code (it is
 * not exported from `index.ts` and never reaches `dist`). A fake in-process JSON-RPC PEER:
 * a second `createMessageConnection` over paired in-memory duplex streams (vscode-jsonrpc's
 * own `TestDuplex` pattern), so the client/manager exercise REAL Content-Length framing + id
 * correlation while staying offline. The peer replays the RECORDED real-server payloads under
 * `test/fixtures/` (provenance: that dir's README), turning the gate from a tautology into a
 * real net for the encoding/shape bugs. The gate NEVER spawns a real language server.
 */

import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'

export function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), 'utf8'),
  )
}

export const INIT = () => loadFixture('initialize-result.json')
export const INIT_UTF8 = () => loadFixture('initialize-result-utf8.json')
export const DEFINITION = () => loadFixture('definition-locationlink.json')
export const REFERENCES = () => loadFixture('references-locations.json')
export const HOVER = () => loadFixture('hover-markup.json')
export const PROGRESS_BEGIN = () => loadFixture('progress-begin.json')

export interface PeerPair {
  client: MessageConnection
  server: MessageConnection
  dispose: () => void
}

/** A connected client/server `MessageConnection` pair over in-memory duplex streams. */
export function makePeerPair(): PeerPair {
  const c2s = new PassThrough()
  const s2c = new PassThrough()
  const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
  const server = createMessageConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
  return {
    client,
    server,
    dispose: () => {
      client.dispose()
      server.dispose()
    },
  }
}

export interface FakeServerOptions {
  initialize?: unknown
  onInitialize?: (params: unknown) => void
  onDefinition?: () => unknown
  onReferences?: () => unknown
  onHover?: () => unknown
  onShutdown?: () => void
  onDidOpen?: () => void
}

/** Wire a fake LSP server: answers the handshake + drained notifications, plus the given replies. */
export function fakeServer(server: MessageConnection, opts: FakeServerOptions = {}): void {
  server.onRequest('initialize', (params: unknown) => {
    opts.onInitialize?.(params)
    return opts.initialize ?? INIT()
  })
  server.onNotification('initialized', () => {})
  server.onNotification('textDocument/didOpen', () => opts.onDidOpen?.())
  server.onRequest('textDocument/definition', () => opts.onDefinition?.() ?? null)
  server.onRequest('textDocument/references', () => opts.onReferences?.() ?? null)
  server.onRequest('textDocument/hover', () => opts.onHover?.() ?? null)
  server.onRequest('shutdown', () => {
    opts.onShutdown?.()
    return null
  })
  server.onNotification('exit', () => {})
  server.listen()
}
