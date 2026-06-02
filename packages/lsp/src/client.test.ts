import { afterEach, describe, expect, it } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import { LspClient } from './client.js'
import {
  CALL_HIERARCHY_INCOMING,
  CALL_HIERARCHY_OUTGOING,
  CALL_HIERARCHY_PREPARE,
  DEFINITION,
  DIAGNOSTICS,
  DOCUMENT_SYMBOLS,
  type FakeServerOptions,
  fakeServer,
  HOVER,
  INIT,
  INIT_RENAME,
  INIT_UTF8,
  makePeerPair,
  PREPARE_RENAME,
  PROGRESS_BEGIN,
  PROGRESS_END,
  REFERENCES,
  RENAME_CHANGES,
  TYPE_DEFINITION,
  WORKSPACE_SYMBOLS,
} from './peer.js'

const GREETER_URI = 'file:///project/src/greeter.ts'

/** The base init fixture predates the client declaring the callHierarchy capability; the real
 * server advertises `callHierarchyProvider: true` once it does (confirmed in the capture). */
function initWithCallHierarchy(): unknown {
  const init = INIT() as { capabilities: Record<string, unknown> }
  init.capabilities.callHierarchyProvider = true
  return init
}

const ROOT = 'file:///project'
const INDEX_URI = 'file:///project/src/index.ts'
const POS = { line: 2, character: 16 }

const disposers: Array<() => void> = []

async function connectedClient(
  opts: FakeServerOptions & {
    clientOptions?: ConstructorParameters<typeof LspClient>[1]
  } = {},
): Promise<{ client: LspClient; server: MessageConnection }> {
  const { client: cConn, server, dispose } = makePeerPair()
  disposers.push(dispose)
  fakeServer(server, opts)
  const client = new LspClient(cConn, { timeoutMs: 1000, ...opts.clientOptions })
  await client.initialize(ROOT)
  return { client, server }
}

afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

describe('LspClient.initialize (handshake)', () => {
  it('reads back the negotiated encoding — spec-default UTF-16 when the server omits it', async () => {
    const { client } = await connectedClient()
    expect(client.encoding).toBe('utf-16')
  })

  it('reads back a negotiated UTF-8 encoding and the serverInfo provenance', async () => {
    const { client } = await connectedClient({ initialize: INIT_UTF8() })
    expect(client.encoding).toBe('utf-8')
    expect(client.serverInfo).toEqual({ name: 'typescript-language-server', version: '5.3.0' })
  })

  it('exposes the server capabilities', async () => {
    const { client } = await connectedClient()
    expect(client.supports('definitionProvider')).toBe(true)
    expect(client.supports('typeDefinitionProvider')).toBe(true)
    expect(client.supports('referencesProvider')).toBe(true)
    expect(client.supports('hoverProvider')).toBe(true)
  })
})

describe('LspClient navigation (tri-state + normalization over recorded payloads)', () => {
  it('definition: normalizes a real LocationLink[] to ok with the symbol + full range', async () => {
    const { client } = await connectedClient({ onDefinition: () => DEFINITION() })
    const r = await client.definition(INDEX_URI, POS)
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(2)
    expect(r.result[0]).toMatchObject({
      uri: 'file:///project/src/greeter.ts',
      range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
      fullRange: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    })
    expect(r.encoding).toBe('utf-16')
  })

  it('typeDefinition: normalizes a real Location[] (server ignores linkSupport here) to ok', async () => {
    const { client } = await connectedClient({ onTypeDefinition: () => TYPE_DEFINITION() })
    const r = await client.typeDefinition(INDEX_URI, POS)
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(1)
    expect(r.result[0]).toMatchObject({
      uri: 'file:///project/src/greeter.ts',
      range: { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } },
    })
    // A plain Location has no enclosing range.
    expect(r.result[0]?.fullRange).toBeUndefined()
  })

  it('references: normalizes a real Location[] to ok', async () => {
    const { client } = await connectedClient({ onReferences: () => REFERENCES() })
    const r = await client.references(INDEX_URI, POS)
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(3)
  })

  it('hover: normalizes real MarkupContent to a single string', async () => {
    const { client } = await connectedClient({ onHover: () => HOVER() })
    const r = await client.hover(INDEX_URI, POS)
    expect(r.status).toBe('ok')
    expect(r.result?.value).toContain('Greeter')
  })

  it('documentSymbols: normalizes a real hierarchical DocumentSymbol[] with children + kind names', async () => {
    const { client } = await connectedClient({ onDocumentSymbol: () => DOCUMENT_SYMBOLS() })
    const r = await client.documentSymbols('file:///project/src/greeter.ts')
    expect(r.status).toBe('ok')
    const greeter = r.result.find((s) => s.name === 'Greeter')
    expect(greeter?.kindName).toBe('Class')
    expect(greeter?.children?.some((c) => c.name === 'greet')).toBe(true)
  })

  it('workspaceSymbols: normalizes a real cross-file SymbolInformation[] to ok with kind names', async () => {
    const { client } = await connectedClient({ onWorkspaceSymbol: () => WORKSPACE_SYMBOLS() })
    const r = await client.workspaceSymbols('Greeter')
    expect(r.status).toBe('ok')
    expect(r.result.map((s) => s.name)).toEqual(['greeter', 'Greeter'])
    const cls = r.result.find((s) => s.name === 'Greeter')
    expect(cls?.kindName).toBe('Class')
    expect(cls?.uri).toBe('file:///project/greeter.ts')
    expect(cls?.range).toEqual({
      start: { line: 6, character: 0 },
      end: { line: 12, character: 1 },
    })
  })

  it('workspaceSymbols: empty result while READY is no_result (tri-state)', async () => {
    const { client } = await connectedClient({
      onWorkspaceSymbol: () => [],
      clientOptions: { timeoutMs: 1000, noRetry: true },
    })
    const r = await client.workspaceSymbols('Nonexistent')
    expect(r.status).toBe('no_result')
    expect(r.result).toEqual([])
  })

  it('callHierarchy incoming: prepare → incomingCalls, the edge item is the CALLER', async () => {
    const { client } = await connectedClient({
      initialize: initWithCallHierarchy(),
      onPrepareCallHierarchy: () => CALL_HIERARCHY_PREPARE(),
      onIncomingCalls: () => CALL_HIERARCHY_INCOMING(),
    })
    const r = await client.callHierarchy(GREETER_URI, { line: 0, character: 16 }, 'incoming')
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(1) // one prepared item: hello
    expect(r.result[0]?.source.name).toBe('hello')
    expect(r.result[0]?.source.kindName).toBe('Function')
    expect(r.result[0]?.calls[0]?.item.name).toBe('greet') // greet calls hello
    expect(r.result[0]?.calls[0]?.fromRanges.length).toBeGreaterThan(0)
  })

  it('callHierarchy outgoing: the edge item is the CALLEE', async () => {
    const { client } = await connectedClient({
      initialize: initWithCallHierarchy(),
      onPrepareCallHierarchy: () => CALL_HIERARCHY_PREPARE(),
      onOutgoingCalls: () => CALL_HIERARCHY_OUTGOING(),
    })
    const r = await client.callHierarchy(GREETER_URI, { line: 0, character: 16 }, 'outgoing')
    expect(r.status).toBe('ok')
    expect(r.result[0]?.calls[0]?.item.name).toBe('hello') // greet calls hello
  })

  it('callHierarchy: empty prepare while ready is no_result (no symbol at the position)', async () => {
    const { client } = await connectedClient({
      initialize: initWithCallHierarchy(),
      onPrepareCallHierarchy: () => null,
      clientOptions: { timeoutMs: 1000, noRetry: true },
    })
    const r = await client.callHierarchy(GREETER_URI, { line: 1, character: 0 }, 'incoming')
    expect(r.status).toBe('no_result')
    expect(r.result).toEqual([])
  })

  it('no_result: an empty result with no indexing in progress (single attempt)', async () => {
    const { client } = await connectedClient({
      onDefinition: () => null,
      clientOptions: { timeoutMs: 1000, noRetry: true },
    })
    const r = await client.definition(INDEX_URI, POS)
    expect(r.status).toBe('no_result')
    expect(r.result).toEqual([])
  })

  it('not_ready: still indexing at the deadline ⇒ not_ready (never "no definition")', async () => {
    // The server keeps a $/progress token open and never ends it: the client waits out the
    // whole deadline (fake clock) and only THEN, still indexing, reports not_ready.
    let t = 0
    const { client, server } = await connectedClient({
      clientOptions: {
        timeoutMs: 1000,
        now: () => t,
        delay: async (ms) => {
          t += ms
        },
      },
    })
    server.onRequest('textDocument/definition', () => {
      server.sendNotification('$/progress', PROGRESS_BEGIN()) // begin, never end
      return null
    })
    const r = await client.definition(INDEX_URI, POS)
    expect(r.status).toBe('not_ready')
  })

  it('re-queries after indexing drains, returning the full result not the mid-load partial', async () => {
    // Mirrors the live tsserver timeline (ADR 0011 addendum): the FIRST query is answered from
    // the still-loading inferred project (a non-empty BUT partial 1-location answer) while a
    // $/progress token is active; once it ends, the configured project answers in full.
    const begin = PROGRESS_BEGIN() as { token: string }
    const end = { token: begin.token, value: { kind: 'end' } }
    const full = REFERENCES() as unknown[]
    const partial = [full[0]] // the inferred-project answer: only the opened file
    let calls = 0
    const { client, server } = await connectedClient()
    server.onRequest('textDocument/references', () => {
      calls += 1
      if (calls === 1) {
        server.sendNotification('$/progress', begin) // indexing active at response time
        setTimeout(() => server.sendNotification('$/progress', end), 5) // ...then it finishes
        return partial
      }
      return full // the loaded configured project — the complete cross-file set
    })
    const r = await client.references(INDEX_URI, POS)
    expect(calls).toBe(2) // it did NOT trust the mid-load partial; it re-queried
    expect(r.status).toBe('ok')
    expect(r.result.length).toBe(3) // the full set, not the 1-location partial
  })

  it('retries an empty-but-not-indexing result within the deadline, then returns ok', async () => {
    let t = 0
    let calls = 0
    const { client } = await connectedClient({
      onDefinition: () => {
        calls += 1
        return calls >= 2 ? DEFINITION() : null
      },
      clientOptions: {
        timeoutMs: 1000,
        now: () => t,
        delay: async (ms) => {
          t += ms
        },
      },
    })
    const r = await client.definition(INDEX_URI, POS)
    expect(calls).toBe(2)
    expect(r.status).toBe('ok')
  })
})

describe('LspClient write-mode (rename / prepareRename)', () => {
  it('advertises the rename + workspaceEdit client capabilities in the handshake', async () => {
    let initParams: { capabilities?: Record<string, Record<string, unknown>> } | undefined
    await connectedClient({
      initialize: INIT_RENAME(),
      onInitialize: (p) => {
        initParams = p as typeof initParams
      },
    })
    const td = initParams?.capabilities?.textDocument as Record<string, Record<string, unknown>>
    expect(td?.rename?.prepareSupport).toBe(true)
    const ws = initParams?.capabilities?.workspace as Record<string, Record<string, unknown>>
    expect(ws?.workspaceEdit?.documentChanges).toBe(true)
    expect(ws?.workspaceEdit?.resourceOperations).toEqual([])
  })

  it('detects the OBJECT-form renameProvider {prepareProvider:true} from the real capture', async () => {
    const { client } = await connectedClient({ initialize: INIT_RENAME() })
    expect(client.supports('renameProvider')).toBe(true)
    expect(client.supportsPrepareRename).toBe(true)
  })

  it('prepareRename: normalizes the real bare Range to an ok renameable outcome', async () => {
    const { client } = await connectedClient({
      initialize: INIT_RENAME(),
      onPrepareRename: () => PREPARE_RENAME(),
    })
    const r = await client.prepareRename(GREETER_URI, { line: 4, character: 14 })
    expect(r.status).toBe('ok')
    expect(r.result?.range).toEqual({
      start: { line: 4, character: 13 },
      end: { line: 4, character: 20 },
    })
  })

  it('prepareRename: ready null ⇒ no_result (engine maps to a "not renameable here" refusal)', async () => {
    const { client } = await connectedClient({
      initialize: INIT_RENAME(),
      onPrepareRename: () => null,
      clientOptions: { timeoutMs: 1000, noRetry: true },
    })
    const r = await client.prepareRename(GREETER_URI, { line: 1, character: 0 })
    expect(r.status).toBe('no_result')
    expect(r.result).toBeNull()
  })

  it('prepareRename: throws when the server advertises only the bare renameProvider:true', async () => {
    const { client } = await connectedClient() // base INIT: renameProvider true (no prepare)
    expect(client.supports('renameProvider')).toBe(true)
    expect(client.supportsPrepareRename).toBe(false)
    await expect(client.prepareRename(GREETER_URI, POS)).rejects.toThrow(/prepareRename/i)
  })

  it('rename: normalizes the REAL multi-file `changes` map to ok', async () => {
    const { client } = await connectedClient({
      initialize: INIT_RENAME(),
      onRename: () => RENAME_CHANGES(),
    })
    const r = await client.rename(GREETER_URI, { line: 4, character: 14 }, 'Greeter2')
    expect(r.status).toBe('ok')
    expect(r.result.files.map((f) => f.uri)).toEqual([
      'file:///project/greeter.ts',
      'file:///project/index.ts',
    ])
    expect(r.result.resourceOps).toEqual([])
  })

  it('rename: still indexing at the deadline ⇒ not_ready (never "cannot rename")', async () => {
    let t = 0
    const { client, server } = await connectedClient({
      initialize: INIT_RENAME(),
      clientOptions: {
        timeoutMs: 1000,
        now: () => t,
        delay: async (ms) => {
          t += ms
        },
      },
    })
    server.onRequest('textDocument/rename', () => {
      server.sendNotification('$/progress', PROGRESS_BEGIN()) // begin, never end
      return null
    })
    const r = await client.rename(GREETER_URI, { line: 4, character: 14 }, 'Greeter2')
    expect(r.status).toBe('not_ready')
  })

  it('rename: throws when the server does not advertise renameProvider', async () => {
    const init = INIT() as { capabilities: Record<string, unknown> }
    init.capabilities.renameProvider = false
    const { client } = await connectedClient({ initialize: init })
    await expect(client.rename(GREETER_URI, POS, 'X')).rejects.toThrow(/rename/i)
  })
})

describe('LspClient.documentDiagnostics (push model)', () => {
  const DIAG_URI = 'file:///project/diag.ts'
  const publishFor = (uri: string, diagnostics: unknown[]) => ({ uri, diagnostics })
  const errorDiags = () => (DIAGNOSTICS() as { diagnostics: unknown[] }).diagnostics

  it('returns ok with the pushed diagnostics after didOpen (no capability gate — push has none)', async () => {
    const { client } = await connectedClient({
      diagnosticsOnOpen: publishFor(DIAG_URI, errorDiags()),
    })
    client.ensureOpen(DIAG_URI, 'typescript', 'const _bad: number = "x"\n')
    const r = await client.documentDiagnostics(DIAG_URI)
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(1)
    expect(r.result[0]).toMatchObject({ severityName: 'Error', code: 2322, source: 'typescript' })
  })

  it('treats an empty publish as ok (a clean file, NOT no_result)', async () => {
    const { client } = await connectedClient({ diagnosticsOnOpen: publishFor(DIAG_URI, []) })
    client.ensureOpen(DIAG_URI, 'typescript', 'const ok = 1\n')
    const r = await client.documentDiagnostics(DIAG_URI)
    expect(r.status).toBe('ok')
    expect(r.result).toEqual([])
  })

  it('waits out the project-load $/progress, then returns the post-settle publish', async () => {
    const { client } = await connectedClient({
      progressOnOpen: [PROGRESS_BEGIN(), PROGRESS_END()],
      diagnosticsOnOpen: publishFor(DIAG_URI, errorDiags()),
    })
    client.ensureOpen(DIAG_URI, 'typescript', 'const _bad: number = "x"\n')
    const r = await client.documentDiagnostics(DIAG_URI)
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(1)
  })

  it('not_ready when the project never settles and no diagnostics are published', async () => {
    let t = 0
    const { client } = await connectedClient({
      progressOnOpen: [PROGRESS_BEGIN()], // begin, no end ⇒ indexing stays active
      clientOptions: {
        timeoutMs: 1000,
        now: () => t,
        delay: async (ms: number) => {
          t += ms
        },
      },
    })
    client.ensureOpen(DIAG_URI, 'typescript', 'const x = 1\n')
    const r = await client.documentDiagnostics(DIAG_URI)
    expect(r.status).toBe('not_ready')
  })
})

describe('LspClient capability gating', () => {
  it('throws when the server does not advertise the provider', async () => {
    const init = INIT() as { capabilities: Record<string, unknown> }
    init.capabilities.hoverProvider = false
    const { client } = await connectedClient({ initialize: init })
    await expect(client.hover(INDEX_URI, POS)).rejects.toThrow(/hover/i)
  })

  it('throws for workspaceSymbols when the server does not advertise it', async () => {
    const init = INIT() as { capabilities: Record<string, unknown> }
    init.capabilities.workspaceSymbolProvider = false
    const { client } = await connectedClient({ initialize: init })
    await expect(client.workspaceSymbols('X')).rejects.toThrow(/workspace symbol/i)
  })

  it('throws for callHierarchy when the base server does not advertise it', async () => {
    const { client } = await connectedClient() // base INIT: no callHierarchyProvider
    expect(client.supports('callHierarchyProvider')).toBe(false)
    await expect(client.callHierarchy(INDEX_URI, POS, 'incoming')).rejects.toThrow(/callHierarchy/i)
  })
})

describe('LspClient document lifecycle (open-once / refcount / no didClose)', () => {
  it('sends didOpen exactly once for the same uri across repeated ensureOpen calls', async () => {
    let opens = 0
    let firstOpen!: () => void
    const opened = new Promise<void>((r) => {
      firstOpen = r
    })
    const { client } = await connectedClient({
      onDidOpen: () => {
        opens += 1
        firstOpen()
      },
      clientOptions: { timeoutMs: 1000, noRetry: true },
    })
    client.ensureOpen(INDEX_URI, 'typescript', 'const a = 1')
    client.ensureOpen(INDEX_URI, 'typescript', 'const a = 1')
    client.releaseDoc(INDEX_URI)
    await opened // the first didOpen has traversed the in-memory stream
    // A second round-trip drains any (erroneous) further didOpen the duplicate would emit.
    expect(await client.definition(INDEX_URI, POS)).toBeDefined()
    expect(opens).toBe(1)
  })
})

describe('LspClient deadlock-safe inbound server requests', () => {
  it('answers workspace/configuration, workDoneProgress/create, and registerCapability', async () => {
    const { server } = await connectedClient()
    const config = await server.sendRequest('workspace/configuration', { items: [{}, {}] })
    expect(config).toEqual([null, null])
    expect(await server.sendRequest('window/workDoneProgress/create', { token: 't' })).toBeNull()
    expect(await server.sendRequest('client/registerCapability', { registrations: [] })).toBeNull()
  })

  it('answers an inbound workspace/applyEdit with applied:false instead of deadlocking', async () => {
    const { server } = await connectedClient({ initialize: INIT_RENAME() })
    const res = (await server.sendRequest('workspace/applyEdit', { edit: { changes: {} } })) as {
      applied: boolean
    }
    expect(res.applied).toBe(false)
  })
})

describe('LspClient.applyEdited (post-write didChange doc-sync)', () => {
  type DidChange = { textDocument: { version: number }; contentChanges: Array<{ text: string }> }

  it('sends a full-text didChange with strictly-increasing versions after didOpen (v1)', async () => {
    const changes: DidChange[] = []
    const waiters: Array<() => void> = []
    const { client, server } = await connectedClient({ initialize: INIT_RENAME() })
    server.onNotification('textDocument/didChange', (p) => {
      changes.push(p as DidChange)
      waiters.shift()?.()
    })
    client.ensureOpen(INDEX_URI, 'typescript', 'const a = 1') // didOpen version 1
    const c1 = new Promise<void>((r) => waiters.push(r))
    const c2 = new Promise<void>((r) => waiters.push(r))
    client.applyEdited(INDEX_URI, 'const a = 2')
    client.applyEdited(INDEX_URI, 'const a = 3')
    await Promise.all([c1, c2])
    expect(changes.map((c) => c.textDocument.version)).toEqual([2, 3]) // strictly > didOpen's 1
    expect(changes[1]?.contentChanges[0]?.text).toBe('const a = 3')
  })

  it('does NOT send didChange for a uri the server never opened', async () => {
    const changes: unknown[] = []
    const { client, server } = await connectedClient({
      initialize: INIT_RENAME(),
      onDefinition: () => null,
      clientOptions: { timeoutMs: 1000, noRetry: true },
    })
    server.onNotification('textDocument/didChange', (p) => changes.push(p))
    client.applyEdited('file:///project/never-opened.ts', 'x')
    // A full client→server→client round-trip drains any (erroneous) didChange first.
    await client.definition(INDEX_URI, POS)
    expect(changes).toHaveLength(0)
  })
})

describe('LspClient.shutdown', () => {
  it('sends shutdown + exit', async () => {
    let shut = false
    const { client } = await connectedClient({
      onShutdown: () => {
        shut = true
      },
    })
    await client.shutdown()
    expect(shut).toBe(true)
  })
})
