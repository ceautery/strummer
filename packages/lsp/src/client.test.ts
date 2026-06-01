import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'
import { LspClient } from './client.js'

/**
 * The deterministic harness (ADR 0011): a fake in-process JSON-RPC PEER — a second
 * `createMessageConnection` over paired in-memory duplex streams (vscode-jsonrpc's own
 * `TestDuplex` pattern) — so the client exercises REAL Content-Length framing + id
 * correlation while staying offline. The peer replays the RECORDED real-server payloads
 * committed under `test/fixtures/` (see the fixtures README for provenance), turning the
 * gate from a tautology into a real net for the encoding/shape bugs.
 */
function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), 'utf8'),
  )
}

const INIT = () => loadFixture('initialize-result.json')
const INIT_UTF8 = () => loadFixture('initialize-result-utf8.json')
const DEFINITION = () => loadFixture('definition-locationlink.json')
const REFERENCES = () => loadFixture('references-locations.json')
const HOVER = () => loadFixture('hover-markup.json')
const PROGRESS_BEGIN = () => loadFixture('progress-begin.json')

const ROOT = 'file:///project'
const INDEX_URI = 'file:///project/src/index.ts'
const POS = { line: 2, character: 16 }

interface Peer {
  client: MessageConnection
  server: MessageConnection
}

const disposers: Array<() => void> = []

function makePeerPair(): Peer {
  const c2s = new PassThrough()
  const s2c = new PassThrough()
  const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
  const server = createMessageConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
  disposers.push(() => {
    client.dispose()
    server.dispose()
  })
  return { client, server }
}

/** A fake server that always answers the handshake + drained notifications, plus the given replies. */
function fakeServer(
  server: MessageConnection,
  opts: {
    initialize?: unknown
    onDefinition?: () => unknown
    onReferences?: () => unknown
    onHover?: () => unknown
    onShutdown?: () => void
    onDidOpen?: () => void
  } = {},
): void {
  server.onRequest('initialize', () => opts.initialize ?? INIT())
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

async function connectedClient(
  opts: Parameters<typeof fakeServer>[1] & {
    clientOptions?: ConstructorParameters<typeof LspClient>[1]
  } = {},
): Promise<{ client: LspClient; server: MessageConnection }> {
  const { client: cConn, server } = makePeerPair()
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

  it('no_result: an empty result with no indexing in progress (single attempt)', async () => {
    const { client } = await connectedClient({
      onDefinition: () => null,
      clientOptions: { timeoutMs: 1000, noRetry: true },
    })
    const r = await client.definition(INDEX_URI, POS)
    expect(r.status).toBe('no_result')
    expect(r.result).toEqual([])
  })

  it('not_ready: an empty result WHILE a $/progress work-done token is active (never "no definition")', async () => {
    const { client, server } = await connectedClient()
    // The server emits a real indexing $/progress BEGIN, then replies empty — stream order
    // guarantees the client marks indexing active before the empty response resolves.
    server.onRequest('textDocument/definition', () => {
      server.sendNotification('$/progress', PROGRESS_BEGIN())
      return null
    })
    const r = await client.definition(INDEX_URI, POS)
    expect(r.status).toBe('not_ready')
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

describe('LspClient capability gating', () => {
  it('throws when the server does not advertise the provider', async () => {
    const init = INIT() as { capabilities: Record<string, unknown> }
    init.capabilities.hoverProvider = false
    const { client } = await connectedClient({ initialize: init })
    await expect(client.hover(INDEX_URI, POS)).rejects.toThrow(/hover/i)
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
