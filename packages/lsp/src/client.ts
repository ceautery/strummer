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
  ApplyWorkspaceEditRequest,
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  ConfigurationRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PrepareRenameRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RegistrationRequest,
  RenameRequest,
  ShutdownRequest,
  TypeDefinitionRequest,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
  WorkspaceSymbolRequest,
} from 'vscode-languageserver-protocol'
import { type PositionEncoding, PREFERRED_ENCODINGS, resolvePositionEncoding } from './encoding.js'
import {
  type CallHierarchyItem,
  type Diagnostic,
  type DocumentSymbol,
  decideStatus,
  type Hover,
  type Location,
  type LocationLink,
  type NormalizedCall,
  type NormalizedCallItem,
  type NormalizedDiagnostic,
  type NormalizedHover,
  type NormalizedLocation,
  type NormalizedSymbol,
  type NormalizedWorkspaceEdit,
  type NormalizedWorkspaceSymbol,
  normalizeCallHierarchyItem,
  normalizeDiagnostics,
  normalizeDocumentSymbols,
  normalizeHover,
  normalizeIncomingCalls,
  normalizeLocations,
  normalizeOutgoingCalls,
  normalizePrepareRename,
  normalizeWorkspaceEdit,
  normalizeWorkspaceSymbols,
  type PrepareRenameOutcome,
  type QueryStatus,
  type RawPrepareRename,
  type RawWorkspaceEdit,
  type SymbolInformation,
  type WorkspaceSymbol,
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
  /** Resolvers waiting for indexing to DRAIN (the active set to empty); fired on the final `end`. */
  private readonly drainWaiters: Array<() => void> = []
  /**
   * Open documents (open-once, no `didClose` by default). `version` is the per-uri monotonic
   * document version: seeded at 1 by `didOpen`, pre-incremented by each `applyEdited` `didChange`
   * — versions MUST strictly increase or the server ignores the change and keeps stale text.
   */
  private readonly open = new Map<string, { refs: number; version: number }>()

  /**
   * Pushed diagnostics per uri (the PUSH model — `textDocument/publishDiagnostics` is a server
   * notification, not a request; tsserver advertises no `diagnosticProvider`, so pull diagnostics
   * are unavailable). An entry's absence ⇒ the server hasn't published for that uri yet.
   */
  private readonly diagnostics = new Map<string, { items: Diagnostic[] }>()
  /** Uris freshly `didOpen`ed whose first post-open publish hasn't arrived yet. */
  private readonly awaitingDiagnostics = new Set<string>()
  /** Resolvers waiting for the NEXT publish on a uri (keyed); fired by the publish handler. */
  private readonly diagnosticsWaiters = new Map<string, Array<() => void>>()

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
   * `prepareRename` is advertised only by the OBJECT form `renameProvider: {prepareProvider:true}`
   * — the boolean `supports()` helper cannot detect it, so the engine must check this before
   * calling `prepareRename` (bare `renameProvider: true` supports rename but not prepare).
   */
  get supportsPrepareRename(): boolean {
    const rp = this._capabilities.renameProvider as
      | { prepareProvider?: boolean }
      | boolean
      | undefined
    return typeof rp === 'object' && rp !== null && rp.prepareProvider === true
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
          // Push diagnostics (ADR 0011 staged tail): advertise client support so the server sends
          // related-information + tags. There is NO `*Provider` to gate on — every server may push.
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
            versionSupport: true,
            codeDescriptionSupport: true,
          },
          callHierarchy: { dynamicRegistration: false },
          rename: {
            dynamicRegistration: false,
            prepareSupport: true,
            prepareSupportDefaultBehavior: 1,
          },
        },
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          // workspace/symbol search (ADR 0011 staged tail). No `resolveSupport` — v1 does not do
          // the `workspaceSymbol/resolve` round-trip, so the server returns full `Location`s
          // (range present) rather than the uri-only `WorkspaceSymbol` form.
          symbol: { dynamicRegistration: false },
          // Write-mode (ADR 0011 addendum): advertise WorkspaceEdit support so the server returns
          // a good rename edit. resourceOperations:[] honestly signals we do NOT apply file ops
          // (we still defend on apply); normalizesLineEndings:false — we send bytes verbatim.
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: [],
            normalizesLineEndings: false,
          },
        },
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
    // Server-initiated `workspace/applyEdit` (e.g. a server that drives renames by asking the
    // client to apply). Its result is an OBJECT (not null) — an unanswered id-bearing request
    // deadlocks the shared server. Strummer applies rename edits itself, so we DECLINE.
    this.conn.onRequest(ApplyWorkspaceEditRequest.method, () => ({
      applied: false,
      failureReason: 'strummer applies rename edits itself; server-initiated edits are declined',
    }))
    // Push diagnostics: cache the latest per uri, clear the "awaiting first publish" flag, and wake
    // any `documentDiagnostics` waiter. An empty `diagnostics` array is a legitimate publish (the
    // server clearing a now-clean file), so it counts as a real answer.
    this.conn.onNotification(
      PublishDiagnosticsNotification.method,
      (p: { uri: string; diagnostics?: Diagnostic[] }) => {
        this.diagnostics.set(p.uri, { items: p.diagnostics ?? [] })
        this.awaitingDiagnostics.delete(p.uri)
        for (const w of this.diagnosticsWaiters.get(p.uri)?.splice(0) ?? []) w()
      },
    )
    this.conn.onNotification('$/progress', (p: ProgressParams) => {
      const kind = p?.value?.kind
      if (kind === 'begin') this.activeProgress.add(p.token)
      else if (kind === 'end') {
        this.activeProgress.delete(p.token)
        // The project finished loading — wake anyone waiting for the index to settle.
        if (this.activeProgress.size === 0) {
          for (const w of this.drainWaiters.splice(0)) w()
        }
      }
    })
  }

  /** A promise that resolves the next time indexing drains to empty (an `end` clears the set). */
  private indexingDrain(): Promise<void> {
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  /**
   * Wait until the server is NOT indexing, bounded by `deadline`. Returns true if it settled,
   * false if the deadline elapsed while still indexing. Event-driven (resolves on the `$/progress`
   * `end`), with the injected `delay` as the deadline backstop — so the gate drives it
   * deterministically and a real session blocks no longer than the operator timeout.
   */
  private async awaitIndexingSettled(deadline: number): Promise<boolean> {
    while (this.indexing) {
      const remaining = deadline - this.now()
      if (remaining <= 0) return false
      const drained = this.indexingDrain()
      if (!this.indexing) return true // an `end` raced in between the check and the registration
      await Promise.race([drained, this.delay(remaining)])
    }
    return true
  }

  /** Open a document full-text once (version 1); subsequent calls just bump the refcount. */
  ensureOpen(uri: string, languageId: string, text: string): void {
    const entry = this.open.get(uri)
    if (entry !== undefined) {
      entry.refs += 1
      return
    }
    this.open.set(uri, { refs: 1, version: 1 })
    // A fresh open triggers the server's first diagnostics publish for this uri; mark it pending so
    // `documentDiagnostics` waits for that publish rather than trusting a stale/absent cache.
    this.awaitingDiagnostics.add(uri)
    this.conn.sendNotification(DidOpenTextDocumentNotification.method, {
      textDocument: { uri, languageId, version: 1, text },
    })
  }

  /** Decrement a document's refcount (keeps the entry + version). Does NOT `didClose`. */
  releaseDoc(uri: string): void {
    const entry = this.open.get(uri)
    if (entry === undefined) return
    entry.refs = Math.max(0, entry.refs - 1)
  }

  /**
   * After Strummer writes `newText` to `uri` on disk (write-mode, ADR 0011 addendum), resync the
   * server's in-memory buffer with a **full-text `didChange`** so a later navigation sees
   * post-rename positions (we never `didClose`, so the server still holds the pre-rename text).
   * The version is **pre-incremented** — it must be strictly greater than the last `didOpen`/
   * `didChange` or the server ignores the change. No-op for a uri the server never opened (it
   * re-reads fresh on the next `didOpen`). Full-text (no incremental ranges) — correctness over
   * bytes, and it avoids re-introducing offset math on the server-bound path.
   */
  applyEdited(uri: string, newText: string): void {
    const entry = this.open.get(uri)
    if (entry === undefined) return
    entry.version += 1
    this.conn.sendNotification(DidChangeTextDocumentNotification.method, {
      textDocument: { uri, version: entry.version },
      contentChanges: [{ text: newText }],
    })
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

  /** A promise that resolves on the next `publishDiagnostics` for `uri`. */
  private nextDiagnostics(uri: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.diagnosticsWaiters.get(uri) ?? []
      list.push(resolve)
      this.diagnosticsWaiters.set(uri, list)
    })
  }

  /**
   * Diagnostics for an OPEN document (ADR 0011 staged tail; PUSH model). NOT capability-gated —
   * `textDocument/publishDiagnostics` is a server notification every server may send, and tsserver
   * advertises no `diagnosticProvider` (pull diagnostics are staged). The caller (manager.run) has
   * already `didOpen`ed the file, which triggers the server's publish.
   *
   * Readiness (grounded in the captured timeline — `didOpen` → `$/progress` begin/end → publish
   * ~60ms AFTER the project loads): wait out the project-load `$/progress`, then return the publish
   * once the file's first post-open publish has arrived. An EMPTY publish is a legitimate `ok` (a
   * clean file), never `no_result`. If the project never settles or no publish arrives within the
   * deadline ⇒ `not_ready` (retry), the same honest-tri-state posture as the navigation reads.
   */
  async documentDiagnostics(uri: string): Promise<NavResult<NormalizedDiagnostic[]>> {
    const deadline = this.now() + this.timeoutMs
    while (true) {
      await this.awaitIndexingSettled(deadline)
      // Once the project is loaded AND the file's first post-open publish has landed, the cached
      // diagnostics are authoritative (a warm re-query takes this path immediately).
      if (!this.indexing && !this.awaitingDiagnostics.has(uri)) {
        const cached = this.diagnostics.get(uri)
        return this.wrap('ok', normalizeDiagnostics(cached?.items))
      }
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        const cached = this.diagnostics.get(uri)
        return this.wrap('not_ready', normalizeDiagnostics(cached?.items))
      }
      await Promise.race([this.nextDiagnostics(uri), this.delay(remaining)])
    }
  }

  /**
   * `workspace/symbol` — project-wide symbol search by name (ADR 0011 staged tail). Position-less
   * and file-less: the query is just a name fragment matched against the whole indexed workspace,
   * so it needs no open document (the project is loaded at `initialize`). Tri-state like the rest —
   * an empty result while the project is still indexing is `not_ready`, never collapsed into
   * "no such symbol" (the cold-load trap the rest of the client already guards). Handles both the
   * flat `SymbolInformation[]` (range present) and the uri-only `WorkspaceSymbol[]` shapes.
   */
  async workspaceSymbols(query: string): Promise<NavResult<NormalizedWorkspaceSymbol[]>> {
    if (!this.supports('workspaceSymbolProvider')) {
      throw new LspUnsupportedError('server does not advertise workspace symbol support')
    }
    return this.withRetry(
      () => this.conn.sendRequest(WorkspaceSymbolRequest.method, { query }),
      (raw) => normalizeWorkspaceSymbols(raw as WorkspaceSymbol[] | null),
      (syms) => syms.length === 0,
    )
  }

  /**
   * `textDocument/prepareRename` — the cheap validate-first pre-flight (write-mode, ADR 0011
   * addendum). Tri-state: `null` while indexing ⇒ `not_ready`; `null` while ready ⇒ `no_result`
   * (the engine maps that to a structured "not renameable here" refusal); a non-null outcome ⇒
   * `ok`. Only callable when {@link supportsPrepareRename} (the engine skips it otherwise).
   */
  async prepareRename(
    uri: string,
    position: { line: number; character: number },
  ): Promise<NavResult<PrepareRenameOutcome | null>> {
    if (!this.supportsPrepareRename) {
      throw new LspUnsupportedError('server does not advertise prepareRename support')
    }
    return this.withRetry(
      () => this.conn.sendRequest(PrepareRenameRequest.method, { textDocument: { uri }, position }),
      (raw) => normalizePrepareRename(raw as RawPrepareRename | null),
      (outcome) => outcome === null,
    )
  }

  /**
   * `textDocument/rename` — compute the cross-file `WorkspaceEdit` for renaming the symbol at
   * `position` to `newName`. Capability-gated on `renameProvider`; normalized to the uniform
   * `files`/`resourceOps` shape; tri-state (empty/`null` while indexing ⇒ `not_ready`). This
   * computes only — applying the edit to disk is the gated engine's job (Slice F), never here.
   */
  async rename(
    uri: string,
    position: { line: number; character: number },
    newName: string,
  ): Promise<NavResult<NormalizedWorkspaceEdit>> {
    if (!this.supports('renameProvider')) {
      throw new LspUnsupportedError('server does not advertise rename support')
    }
    return this.withRetry(
      () =>
        this.conn.sendRequest(RenameRequest.method, { textDocument: { uri }, position, newName }),
      (raw) => normalizeWorkspaceEdit(raw as RawWorkspaceEdit | null),
      (we) => we.files.length === 0 && we.resourceOps.length === 0,
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
   * The tri-state request loop: settle → send → decide, all inside one operator deadline.
   *
   * The load-bearing rule (ADR 0011 addendum — proven by a live `typescript-language-server`
   * capture): **a result returned while the server is still indexing the project is NOT
   * trustworthy** — tsserver answers an early request from a single-file *inferred* project
   * (a non-empty BUT PARTIAL answer — e.g. a cross-file rename that sees only the opened file)
   * and only *then* finishes loading the configured project. So:
   *
   * 1. Before sending, wait out any in-flight indexing (`awaitIndexingSettled`) so we hit the
   *    loaded project.
   * 2. After sending, if indexing is active (the send itself triggered the configured-project
   *    load), the answer is from the unstable inferred project — loop to settle + re-query.
   * 3. Once the server is settled: a non-empty result is `ok`; an empty result is `no_result`
   *    (retried with bounded backoff) — or `not_ready` only if we hit the deadline still indexing.
   *
   * This trades the old "return `not_ready` fast" for "wait for the correct answer within the
   * deadline" — correctness over latency, bounded by the operator timeout.
   */
  private async withRetry<T>(
    send: () => Promise<unknown>,
    normalize: (raw: unknown) => T,
    isEmpty: (value: T) => boolean,
  ): Promise<NavResult<T>> {
    const deadline = this.now() + this.timeoutMs
    let attempt = 0
    while (true) {
      // (1) Never query a still-loading project; wait for the indexing $/progress to drain.
      await this.awaitIndexingSettled(deadline)
      const value = normalize(await send())
      // (2) The send may have kicked off the configured-project load and been answered from the
      // inferred project — re-query once it settles (unless we are out of deadline).
      if (this.indexing && this.now() < deadline) continue

      const status = decideStatus(isEmpty(value), !this.indexing)
      if (status !== 'no_result') return this.wrap(status, value)

      // (3) Empty + settled: retry with bounded backoff strictly inside the deadline.
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
