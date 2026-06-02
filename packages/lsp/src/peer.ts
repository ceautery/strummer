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
import type { ServerSpawn } from './client.js'

export function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), 'utf8'),
  )
}

export const INIT = () => loadFixture('initialize-result.json')
export const INIT_UTF8 = () => loadFixture('initialize-result-utf8.json')
export const DEFINITION = () => loadFixture('definition-locationlink.json')
export const TYPE_DEFINITION = () => loadFixture('type-definition-locations.json')
export const REFERENCES = () => loadFixture('references-locations.json')
export const HOVER = () => loadFixture('hover-markup.json')
export const DOCUMENT_SYMBOLS = () => loadFixture('document-symbols-hierarchical.json')
export const WORKSPACE_SYMBOLS = () => loadFixture('workspace-symbols.json')
export const DIAGNOSTICS = () => loadFixture('diagnostics-publish.json')
export const CALL_HIERARCHY_PREPARE = () => loadFixture('call-hierarchy-prepare.json')
export const CALL_HIERARCHY_INCOMING = () => loadFixture('call-hierarchy-incoming.json')
export const CALL_HIERARCHY_OUTGOING = () => loadFixture('call-hierarchy-outgoing.json')
export const PROGRESS_BEGIN = () => loadFixture('progress-begin.json')
export const PROGRESS_END = () => loadFixture('progress-end.json')
export const INIT_RENAME = () => loadFixture('initialize-result-rename.json')
export const PREPARE_RENAME = () => loadFixture('prepare-rename.json')
export const RENAME_CHANGES = () => loadFixture('rename-changes.json')
// rust-analyzer captures (write-mode resource ops). RA emits a real RenameFile on a module rename.
export const INIT_RUST = () => loadFixture('initialize-result-rust.json')
export const RENAME_RENAMEFILE = () => loadFixture('rename-renamefile.json')

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
  onDefinition?: (params: unknown) => unknown
  onTypeDefinition?: (params: unknown) => unknown
  onReferences?: (params: unknown) => unknown
  onHover?: (params: unknown) => unknown
  onDocumentSymbol?: (params: unknown) => unknown
  onWorkspaceSymbol?: (params: unknown) => unknown
  onPrepareCallHierarchy?: (params: unknown) => unknown
  onIncomingCalls?: (params: unknown) => unknown
  onOutgoingCalls?: (params: unknown) => unknown
  onPrepareRename?: (params: unknown) => unknown
  onRename?: (params: unknown) => unknown
  onShutdown?: () => void
  onDidOpen?: (params: unknown) => void
  onDidChange?: (params: unknown) => void
  onDidClose?: (params: unknown) => void
  /** When set, the definition handler emits this `$/progress` notification before replying. */
  emitProgressBeforeDefinition?: unknown
  /** `$/progress` notifications the server emits (in order) right after `didOpen`. */
  progressOnOpen?: unknown[]
  /** A `textDocument/publishDiagnostics` params object the server pushes after `didOpen`/progress. */
  diagnosticsOnOpen?: unknown
}

/** Wire a fake LSP server: answers the handshake + drained notifications, plus the given replies. */
export function fakeServer(server: MessageConnection, opts: FakeServerOptions = {}): void {
  server.onRequest('initialize', (params: unknown) => {
    opts.onInitialize?.(params)
    return opts.initialize ?? INIT()
  })
  server.onNotification('initialized', () => {})
  server.onNotification('textDocument/didOpen', (params: unknown) => {
    opts.onDidOpen?.(params)
    // Push-diagnostics model: the server emits its project-load progress then publishes
    // diagnostics for the opened file (mirrors the captured real-server timeline).
    for (const pr of opts.progressOnOpen ?? []) server.sendNotification('$/progress', pr)
    if (opts.diagnosticsOnOpen !== undefined) {
      server.sendNotification('textDocument/publishDiagnostics', opts.diagnosticsOnOpen)
    }
  })
  server.onNotification('textDocument/didChange', (params: unknown) => opts.onDidChange?.(params))
  server.onNotification('textDocument/didClose', (params: unknown) => opts.onDidClose?.(params))
  server.onRequest('textDocument/definition', (params: unknown) => {
    if (opts.emitProgressBeforeDefinition !== undefined) {
      server.sendNotification('$/progress', opts.emitProgressBeforeDefinition)
    }
    return opts.onDefinition?.(params) ?? null
  })
  server.onRequest(
    'textDocument/typeDefinition',
    (params: unknown) => opts.onTypeDefinition?.(params) ?? null,
  )
  server.onRequest(
    'textDocument/references',
    (params: unknown) => opts.onReferences?.(params) ?? null,
  )
  server.onRequest('textDocument/hover', (params: unknown) => opts.onHover?.(params) ?? null)
  server.onRequest(
    'textDocument/documentSymbol',
    (params: unknown) => opts.onDocumentSymbol?.(params) ?? null,
  )
  server.onRequest(
    'workspace/symbol',
    (params: unknown) => opts.onWorkspaceSymbol?.(params) ?? null,
  )
  server.onRequest(
    'textDocument/prepareCallHierarchy',
    (params: unknown) => opts.onPrepareCallHierarchy?.(params) ?? null,
  )
  server.onRequest(
    'callHierarchy/incomingCalls',
    (params: unknown) => opts.onIncomingCalls?.(params) ?? null,
  )
  server.onRequest(
    'callHierarchy/outgoingCalls',
    (params: unknown) => opts.onOutgoingCalls?.(params) ?? null,
  )
  server.onRequest(
    'textDocument/prepareRename',
    (params: unknown) => opts.onPrepareRename?.(params) ?? null,
  )
  server.onRequest('textDocument/rename', (params: unknown) => opts.onRename?.(params) ?? null)
  server.onRequest('shutdown', () => {
    opts.onShutdown?.()
    return null
  })
  server.onNotification('exit', () => {})
  server.listen()
}

export interface SpawnTracker {
  /** A `ServerSpawn` returning a fresh fake peer per call (each wired with `fakeServer`). */
  spawn: ServerSpawn
  /** One record per spawn — `disposed` flips when the manager calls `dispose()`. */
  spawns: Array<{ disposed: boolean }>
  /** Tear down every peer created by this tracker (call in `afterEach`). */
  disposeAll: () => void
}

/** A `ServerSpawn` over fresh in-process fake peers, tracking spawn count + disposal. */
export function fakeSpawn(opts: FakeServerOptions = {}): SpawnTracker {
  const spawns: Array<{ disposed: boolean }> = []
  const peerDisposers: Array<() => void> = []
  const spawn: ServerSpawn = () => {
    const { client, server, dispose } = makePeerPair()
    fakeServer(server, opts)
    const rec = { disposed: false }
    spawns.push(rec)
    peerDisposers.push(dispose)
    return {
      connection: client,
      dispose: () => {
        rec.disposed = true
        dispose()
      },
    }
  }
  return {
    spawn,
    spawns,
    disposeAll: () => {
      for (const d of peerDisposers) d()
    },
  }
}
