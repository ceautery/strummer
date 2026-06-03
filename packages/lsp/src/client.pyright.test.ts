import { afterEach, describe, expect, it } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import { LspClient } from './client.js'
import {
  DEFINITION_PYRIGHT,
  DIAGNOSTICS_PYRIGHT,
  type FakeServerOptions,
  fakeServer,
  INIT_PYRIGHT,
  makePeerPair,
  RENAME_PYRIGHT,
} from './peer.js'

/**
 * The LSP Python adapter (ADR 0011): a THIRD real server in the gate, replaying RECORDED
 * `pyright-langserver` 1.1.410 payloads (provenance in `test/fixtures/README.md`). pyright's
 * shapes differ from tsserver's and rust-analyzer's in ways that exercise paths neither did
 * against a real payload — object-form provider capabilities, no `serverInfo`, no
 * `positionEncoding`, no `diagnosticProvider` (push diagnostics with a STRING code), definition
 * as a flat `Location[]`, and a `documentChanges` rename with `version: null`. The gate NEVER
 * spawns a real server; these were captured live against the `examples/lsp/pygreeter` project.
 */

const ROOT = 'file:///project'
const GREETER_URI = 'file:///project/greeter.py'

const disposers: Array<() => void> = []

async function connectedClient(
  opts: FakeServerOptions & {
    clientOptions?: ConstructorParameters<typeof LspClient>[1]
  } = {},
): Promise<{ client: LspClient; server: MessageConnection }> {
  const { client: cConn, server, dispose } = makePeerPair()
  disposers.push(dispose)
  fakeServer(server, { initialize: INIT_PYRIGHT(), ...opts })
  const client = new LspClient(cConn, { timeoutMs: 1000, ...opts.clientOptions })
  await client.initialize(ROOT)
  return { client, server }
}

afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

describe('LspClient against pyright (recorded payloads)', () => {
  it('handshake: utf-16 default (no positionEncoding), absent serverInfo, object-form caps', async () => {
    const { client } = await connectedClient()
    // pyright sends no `positionEncoding` ⇒ spec-default utf-16.
    expect(client.encoding).toBe('utf-16')
    // pyright sends no `serverInfo` ⇒ provenance is unattributable (the surface warns).
    expect(client.serverInfo).toBeUndefined()
    // Object-form provider capabilities (`{workDoneProgress: true}`) count as supported.
    expect(client.supports('definitionProvider')).toBe(true)
    expect(client.supports('referencesProvider')).toBe(true)
    expect(client.supports('renameProvider')).toBe(true)
    // The object-form `renameProvider: {prepareProvider: true}` enables prepareRename.
    expect(client.supportsPrepareRename).toBe(true)
    // pyright advertises NO diagnosticProvider ⇒ the pull model is unavailable (push only).
    expect(client.supports('diagnosticProvider')).toBe(false)
  })

  it('definition: a flat Location[] (pyright ignores linkSupport) normalizes to ok', async () => {
    const { client } = await connectedClient({ onDefinition: () => DEFINITION_PYRIGHT() })
    const r = await client.definition(GREETER_URI, { line: 15, character: 15 })
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(1)
    expect(r.result[0]).toMatchObject({
      uri: 'file:///project/greeter.py',
      range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } },
    })
    // A plain Location carries no enclosing range (the LocationLink-only field).
    expect(r.result[0]?.fullRange).toBeUndefined()
  })

  it('push diagnostics: a real publish with a STRING code + source "Pyright" normalizes to ok', async () => {
    const DIAG_URI = 'file:///project/bad.py'
    const { client } = await connectedClient({ diagnosticsOnOpen: DIAGNOSTICS_PYRIGHT() })
    client.ensureOpen(DIAG_URI, 'python', 'result: str = add(1, 2)\n')
    const r = await client.documentDiagnostics(DIAG_URI)
    expect(r.status).toBe('ok')
    expect(r.result).toHaveLength(1)
    // pyright uses a STRING rule code, unlike tsserver's numeric code — both must round-trip.
    expect(r.result[0]).toMatchObject({
      severityName: 'Error',
      code: 'reportAssignmentType',
      source: 'Pyright',
    })
  })

  it('rename: a real documentChanges WorkspaceEdit with version:null normalizes to a multi-file edit', async () => {
    const { client } = await connectedClient({ onRename: () => RENAME_PYRIGHT() })
    const r = await client.rename(GREETER_URI, { line: 8, character: 6 }, 'Welcomer')
    expect(r.status).toBe('ok')
    // Cross-file: the declaration in greeter.py + the import & usage in main.py.
    expect(r.result.files).toHaveLength(2)
    expect(r.result.resourceOps).toEqual([])
    const byFile = Object.fromEntries(r.result.files.map((f) => [f.uri.split('/').pop(), f]))
    expect(byFile['greeter.py']?.edits).toHaveLength(1)
    expect(byFile['main.py']?.edits).toHaveLength(2)
    for (const f of r.result.files) {
      for (const e of f.edits) expect(e.newText).toBe('Welcomer')
    }
  })
})
