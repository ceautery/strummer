/**
 * The LSP JSON-RPC client (ADR 0011, slice 2) — one live, stateful, bidirectional session
 * with a language-server subprocess, the documented exception to ARCHITECTURE §1's
 * no-live-RPC rule. It leans on Microsoft's reference transport (`vscode-jsonrpc` for
 * Content-Length framing + id correlation, `vscode-languageserver-protocol` for method
 * constants) — the playwright-core pattern, NOT a hand-rolled framing layer.
 *
 * The five corners the adversarial pass flagged as load-bearing, all handled here:
 *
 * 1. **Encoding negotiation.** Advertise `positionEncodings: ["utf-16","utf-8"]`, read back
 *    `ServerCapabilities.positionEncoding`, and do ALL offset math in that unit (via
 *    `encoding.ts`). Absent ⇒ spec-default UTF-16; present-but-unsupported ⇒ fail loud.
 * 2. **Tri-state readiness.** An empty result is `no_result` only when the server is READY;
 *    while an indexing `$/progress` work-done token is active it is `not_ready` — never
 *    collapsed into "no definition". One authoritative deadline (the operator timeout) with
 *    the bounded retry/backoff living INSIDE it; the first call returns `not_ready` fast.
 * 3. **Deadlock-safe inbound replies.** The client MUST answer every id-bearing server
 *    request (`workspace/configuration`, `window/workDoneProgress/create`,
 *    `client/registerCapability`) or it deadlocks — in particular it must answer
 *    `workDoneProgress/create` before the `$/progress` that drives readiness arrives.
 * 4. **Document lifecycle.** `didOpen` full-text once, reference-counted, NO `didClose` by
 *    default (the per-(server,uri) mutex that serializes the open+query critical section
 *    lives in the manager — slice 3).
 * 5. **Capability gating + provenance.** Every request is gated on its `*Provider`
 *    capability; `serverInfo.{name,version}` rides on every result (turns "silently wrong"
 *    into "wrong-but-attributed").
 *
 * All time-based code goes through the injected clock (`now`/`delay`) — the production code
 * never calls `setTimeout`/`setInterval` directly except inside the default `delay` seam, so
 * the gate drives retry/backoff deterministically with a fake clock.
 */

import { spawn } from 'node:child_process'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'
import {
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  ConfigurationRequest,
  DefinitionRequest,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  ReferencesRequest,
  RegistrationRequest,
  ShutdownRequest,
  TypeDefinitionRequest,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
} from 'vscode-languageserver-protocol'
import { type PositionEncoding, PREFERRED_ENCODINGS, resolvePositionEncoding } from './encoding.js'
import {
  type CallHierarchyItem,
  type DocumentSymbol,
  decideStatus,
  type Hover,
  type Location,
  type LocationLink,
  type NormalizedCall,
  type NormalizedCallItem,
  type NormalizedHover,
  type NormalizedLocation,
  type NormalizedSymbol,
  normalizeCallHierarchyItem,
  normalizeDocumentSymbols,
  normalizeHover,
  normalizeIncomingCalls,
  normalizeLocations,
  normalizeOutgoingCalls,
  type QueryStatus,
  type SymbolInformation,
} from './normalize.js'

/** An operator-registry server entry: the binary + argv to spawn (structurally separate). */
export interface ServerSpec {
  command: string
  args: string[]
  initializationOptions?: unknown
}

/** An established connection to a language server, plus how to tear the process down. */
export interface LspConnection {
  connection: MessageConnection
  /** Hard teardown (SIGKILL + stream close) — last resort after graceful `shutdown`. */
  dispose(): void
}

/** Injected spawn seam — the only place a real process is created (tests inject a fake peer). */
export type ServerSpawn = (spec: ServerSpec) => LspConnection

/** Default live spawn: a child process over stdio, framed by the reference transport. */
export const defaultServerSpawn: ServerSpawn = (spec) => {
  const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  )
  return {
    connection,
    dispose() {
      connection.dispose()
      child.kill('SIGKILL')
    },
  }
}

export interface LspClientOptions {
  /** OPERATOR per-request wall-clock cap (ms) — the single authoritative deadline. */
  timeoutMs: number
  /** Single-attempt mode: no retry/backoff (the gate's deterministic default). */
  noRetry?: boolean
  /** Injected clock. Default `Date.now`. */
  now?: () => number
  /** Injected cancellable delay. Default a `setTimeout` promise (the one seam that may). */
  delay?: (ms: number) => Promise<void>
  /** Base backoff (ms) for the empty-result retry. Default 50. */
  baseBackoffMs?: number
  /** Max backoff (ms). Default 1000. */
  maxBackoffMs?: number
}

/** Server provenance from `initialize` — `serverInfo`, optional per the protocol. */
export interface ServerInfo {
  name: string
  version?: string
}

/** A call-hierarchy group: one prepared source item + the calls in the requested direction. */
export interface CallHierarchyGroup {
  source: NormalizedCallItem
  calls: NormalizedCall[]
}

export type CallDirection = 'incoming' | 'outgoing'

/** A navigation result with its tri-state status and version/encoding provenance. */
export interface NavResult<T> {
  status: QueryStatus
  result: T
  serverInfo?: ServerInfo
  encoding: PositionEncoding
}

export interface InitializeSummary {
  encoding: PositionEncoding
  serverInfo?: ServerInfo
  capabilities: ServerCapabilities
}

/** The subset of `ServerCapabilities` this slice reads (any non-`false`/non-absent ⇒ enabled). */
type ServerCapabilities = Record<string, unknown>

interface InitializeResult {
  capabilities?: ServerCapabilities
  serverInfo?: ServerInfo
}

interface ProgressParams {
  token: string | number
  value?: { kind?: string }
}

/** Thrown when a navigation is requested against a capability the server did not advertise. */
export class LspUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspUnsupportedError'
  }
}

const defaultDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class LspClient {
  private readonly conn: MessageConnection
  private readonly timeoutMs: number
  private readonly noRetry: boolean
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number

  private listening = false
  private _encoding: PositionEncoding = 'utf-16'
  private _serverInfo: ServerInfo | undefined
  private _capabilities: ServerCapabilities = {}

  /** Active indexing work-done-progress tokens — non-empty ⇒ the server is still indexing. */
  private readonly activeProgress = new Set<string | number>()
  /** Open documents: uri → reference count (open-once, no didClose by default). */
  private readonly open = new Map<string, number>()

  constructor(connection: MessageConnection, options: LspClientOptions) {
    this.conn = connection
    this.timeoutMs = options.timeoutMs
    this.noRetry = options.noRetry ?? false
    this.now = options.now ?? Date.now
    this.delay = options.delay ?? defaultDelay
    this.baseBackoffMs = options.baseBackoffMs ?? 50
    this.maxBackoffMs = options.maxBackoffMs ?? 1000
  }

  get encoding(): PositionEncoding {
    return this._encoding
  }
  get serverInfo(): ServerInfo | undefined {
    return this._serverInfo
  }
  get capabilities(): ServerCapabilities {
    return this._capabilities
  }
  /** Indexing is active when at least one `$/progress` work-done token is open. */
  get indexing(): boolean {
    return this.activeProgress.size > 0
  }

  /** Any non-`false`, non-absent `*Provider` value counts as enabled (LSP convention). */
  supports(provider: string): boolean {
    const v = this._capabilities[provider]
    return v !== undefined && v !== false
  }

  /**
   * Handshake. Registers the deadlock-safe inbound handlers + the `$/progress` listener
   * BEFORE `listen()`, advertises the preferred encodings, then reads back the negotiated
   * encoding + capabilities + provenance and sends `initialized`.
   */
  async initialize(
    rootUri: string,
    opts: { initializationOptions?: unknown } = {},
  ): Promise<InitializeSummary> {
    this.installInboundHandlers()
    if (!this.listening) {
      this.conn.listen()
      this.listening = true
    }
    const result = (await this.conn.sendRequest(InitializeRequest.method, {
      processId: process.pid ?? null,
      clientInfo: { name: 'strummer-lsp' },
      rootUri,
      capabilities: {
        general: { positionEncodings: PREFERRED_ENCODINGS },
        textDocument: {
          synchronization: { dynamicRegistration: false },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false },
        },
        window: { workDoneProgress: true },
        workspace: { configuration: true, workspaceFolders: true },
      },
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      initializationOptions: opts.initializationOptions,
    })) as InitializeResult

    this._capabilities = result.capabilities ?? {}
    this._serverInfo = result.serverInfo
    this._encoding = resolvePositionEncoding(
      this._capabilities.positionEncoding as string | undefined,
    )
    this.conn.sendNotification(InitializedNotification.method, {})
    return {
      encoding: this._encoding,
      serverInfo: this._serverInfo,
      capabilities: this._capabilities,
    }
  }

  /** Register the id-bearing inbound replies (deadlock-safe) + the `$/progress` tracker. */
  private installInboundHandlers(): void {
    this.conn.onRequest(ConfigurationRequest.method, (params: { items?: unknown[] }) =>
      (params?.items ?? []).map(() => null),
    )
    this.conn.onRequest(WorkDoneProgressCreateRequest.method, () => null)
    this.conn.onRequest(RegistrationRequest.method, () => null)
    this.conn.onRequest(UnregistrationRequest.method, () => null)
    this.conn.onNotification('$/progress', (p: ProgressParams) => {
      const kind = p?.value?.kind
      if (kind === 'begin') this.activeProgress.add(p.token)
      else if (kind === 'end') this.activeProgress.delete(p.token)
    })
  }

  /** Open a document full-text once; subsequent calls just bump the refcount (no resend). */
  ensureOpen(uri: string, languageId: string, text: string): void {
    const refs = this.open.get(uri)
    if (refs !== undefined) {
      this.open.set(uri, refs + 1)
      return
    }
    this.open.set(uri, 1)
    this.conn.sendNotification(DidOpenTextDocumentNotification.method, {
      textDocument: { uri, languageId, version: 1, text },
    })
  }

  /** Decrement a document's refcount. Does NOT `didClose` (close happens only on reap). */
  releaseDoc(uri: string): void {
    const refs = this.open.get(uri)
    if (refs === undefined) return
    if (refs <= 1) this.open.set(uri, 0)
    else this.open.set(uri, refs - 1)
  }

  async definition(
    uri: string,
    position: { line: number; character: number },
  ): Promise<NavResult<NormalizedLocation[]>> {
    if (!this.supports('definitionProvider')) {
      throw new LspUnsupportedError('server does not advertise definition support')
    }
    return this.navigateLocations(DefinitionRequest.method, { textDocument: { uri }, position })
  }

  async typeDefinition(
    uri: string,
    position: { line: number; character: number },
  ): Promise<NavResult<NormalizedLocation[]>> {
    if (!this.supports('typeDefinitionProvider')) {
      throw new LspUnsupportedError('server does not advertise typeDefinition support')
    }
    return this.navigateLocations(TypeDefinitionRequest.method, { textDocument: { uri }, position })
  }

  async references(
    uri: string,
    position: { line: number; character: number },
  ): Promise<NavResult<NormalizedLocation[]>> {
    if (!this.supports('referencesProvider')) {
      throw new LspUnsupportedError('server does not advertise references support')
    }
    return this.navigateLocations(ReferencesRequest.method, {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    })
  }

  async hover(
    uri: string,
    position: { line: number; character: number },
  ): Promise<NavResult<NormalizedHover | null>> {
    if (!this.supports('hoverProvider')) {
      throw new LspUnsupportedError('server does not advertise hover support')
    }
    return this.withRetry(
      () => this.conn.sendRequest(HoverRequest.method, { textDocument: { uri }, position }),
      (raw) => normalizeHover(raw as Hover | null),
      (h) => h === null,
    )
  }

  /** Document symbols — the file outline. Position-less (whole document); tri-state like the rest. */
  async documentSymbols(uri: string): Promise<NavResult<NormalizedSymbol[]>> {
    if (!this.supports('documentSymbolProvider')) {
      throw new LspUnsupportedError('server does not advertise documentSymbol support')
    }
    return this.withRetry(
      () => this.conn.sendRequest(DocumentSymbolRequest.method, { textDocument: { uri } }),
      (raw) => normalizeDocumentSymbols(raw as DocumentSymbol[] | SymbolInformation[] | null),
      (syms) => syms.length === 0,
    )
  }

  /**
   * Call hierarchy — a TWO-round-trip protocol. `prepareCallHierarchy` resolves the symbol at
   * `position` to one or more `CallHierarchyItem`s (null vs empty is distinct; overloads yield
   * MANY — we keep them all, never silently the first); then per item we fetch incoming or
   * outgoing calls. Tri-state lives on the PREPARE step (empty-while-indexing ⇒ not_ready). A
   * prepared item with no callers/callees is a legitimate `ok` with empty `calls`. The RAW item
   * is passed back to the calls request (it may carry an opaque `data` field the server needs).
   */
  async callHierarchy(
    uri: string,
    position: { line: number; character: number },
    direction: CallDirection,
  ): Promise<NavResult<CallHierarchyGroup[]>> {
    if (!this.supports('callHierarchyProvider')) {
      throw new LspUnsupportedError('server does not advertise callHierarchy support')
    }
    const prepared = await this.withRetry(
      () =>
        this.conn.sendRequest(CallHierarchyPrepareRequest.method, {
          textDocument: { uri },
          position,
        }),
      (raw) => (raw as CallHierarchyItem[] | null) ?? [],
      (items) => items.length === 0,
    )
    if (prepared.status !== 'ok') return this.wrap(prepared.status, [])

    const method =
      direction === 'incoming'
        ? CallHierarchyIncomingCallsRequest.method
        : CallHierarchyOutgoingCallsRequest.method
    const groups: CallHierarchyGroup[] = []
    for (const item of prepared.result) {
      const raw = await this.conn.sendRequest(method, { item })
      const calls =
        direction === 'incoming'
          ? normalizeIncomingCalls(
              raw as
                | { from: CallHierarchyItem; fromRanges: NormalizedLocation['range'][] }[]
                | null,
            )
          : normalizeOutgoingCalls(
              raw as { to: CallHierarchyItem; fromRanges: NormalizedLocation['range'][] }[] | null,
            )
      groups.push({ source: normalizeCallHierarchyItem(item), calls })
    }
    return this.wrap('ok', groups)
  }

  private navigateLocations(
    method: string,
    params: unknown,
  ): Promise<NavResult<NormalizedLocation[]>> {
    return this.withRetry(
      () => this.conn.sendRequest(method, params),
      (raw) => normalizeLocations(raw as Location | Location[] | LocationLink[] | null),
      (locs) => locs.length === 0,
    )
  }

  /**
   * The tri-state request loop: send → normalize → decide. A non-empty result is `ok`; an
   * empty result while indexing is `not_ready` (returned fast); an empty result with no
   * indexing is `no_result` — and ONLY that case is retried, with bounded backoff strictly
   * inside the single operator deadline.
   */
  private async withRetry<T>(
    send: () => Promise<unknown>,
    normalize: (raw: unknown) => T,
    isEmpty: (value: T) => boolean,
  ): Promise<NavResult<T>> {
    const deadline = this.now() + this.timeoutMs
    let attempt = 0
    while (true) {
      const value = normalize(await send())
      const status = decideStatus(isEmpty(value), !this.indexing)
      if (status !== 'no_result') return this.wrap(status, value)

      attempt += 1
      const backoff = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs)
      if (this.noRetry || this.now() + backoff > deadline) return this.wrap('no_result', value)
      await this.delay(backoff)
    }
  }

  private wrap<T>(status: QueryStatus, result: T): NavResult<T> {
    return { status, result, serverInfo: this._serverInfo, encoding: this._encoding }
  }

  /** Graceful teardown: LSP `shutdown` request then the `exit` notification. */
  async shutdown(): Promise<void> {
    try {
      await this.conn.sendRequest(ShutdownRequest.method)
    } catch {
      // a dead/uncooperative server — fall through to exit.
    }
    try {
      this.conn.sendNotification(ExitNotification.method)
    } catch {
      // best-effort.
    }
  }
}
