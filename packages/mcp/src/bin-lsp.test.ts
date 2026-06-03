import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, describe, expect, it } from 'vitest'
import { type BuiltLspServer, buildLspServerFromEnv } from './bin-lsp.js'

const SERVERS = JSON.stringify({
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
})

const clients: Client[] = []
async function toolNames(built: BuiltLspServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)])
  clients.push(client)
  return (await client.listTools()).tools.map((t) => t.name).sort()
}

afterAll(async () => {
  for (const c of clients) await c.close()
})

describe('buildLspServerFromEnv', () => {
  it('defaults to navigation OFF — only lsp_languages, no registry', async () => {
    const built = buildLspServerFromEnv({})
    expect(built.config.allowRun).toBe(false)
    expect(built.config.registry).toBeUndefined()
    expect(built.manager).toBeUndefined()
    expect(await toolNames(built)).toEqual(['lsp_languages'])
  })

  it('enables the navigation tools with the full gate (allowRun + roots + registry)', async () => {
    const built = buildLspServerFromEnv({
      STRUMMER_LSP_ALLOW_RUN: '1',
      STRUMMER_LSP_PROJECT_ROOTS: '/abs/project,/abs/other',
      STRUMMER_LSP_SERVERS: SERVERS,
      STRUMMER_LSP_TIMEOUT_MS: '15000',
      STRUMMER_LSP_MAX_SERVERS: '4',
      STRUMMER_LSP_IDLE_TTL_MS: '600000',
    })
    expect(built.config).toMatchObject({
      allowRun: true,
      allowedRoots: ['/abs/project', '/abs/other'],
      timeoutMs: 15000,
      maxServers: 4,
      idleTtlMs: 600000,
    })
    expect(built.config.registry?.typescript?.command).toBe('typescript-language-server')
    expect(built.config.allowWrite).toBe(false) // default off — dry-run preview only
    expect(built.manager).toBeDefined()
    expect(await toolNames(built)).toEqual([
      'lsp_call_hierarchy',
      'lsp_diagnostics',
      'lsp_document_symbols',
      'lsp_find_definition',
      'lsp_find_references',
      'lsp_hover',
      'lsp_languages',
      'lsp_rename', // wired whenever navigation is (dry-run by default)
      'lsp_type_definition',
      'lsp_workspace_symbols',
    ])
  })

  it('parses STRUMMER_LSP_ALLOW_WRITE (still exposes lsp_rename — apply is the engine decision)', async () => {
    const built = buildLspServerFromEnv({
      STRUMMER_LSP_ALLOW_RUN: '1',
      STRUMMER_LSP_ALLOW_WRITE: '1',
      STRUMMER_LSP_PROJECT_ROOTS: '/abs/project',
      STRUMMER_LSP_SERVERS: SERVERS,
    })
    expect(built.config.allowWrite).toBe(true)
    expect(await toolNames(built)).toContain('lsp_rename')
  })

  it('parses STRUMMER_LSP_ALLOW_PARTIAL_RENAME (default off — suspect renames refused for write)', () => {
    const off = buildLspServerFromEnv({
      STRUMMER_LSP_ALLOW_RUN: '1',
      STRUMMER_LSP_PROJECT_ROOTS: '/abs/project',
      STRUMMER_LSP_SERVERS: SERVERS,
    })
    expect(off.config.allowPartialRename).toBe(false)
    const on = buildLspServerFromEnv({
      STRUMMER_LSP_ALLOW_RUN: '1',
      STRUMMER_LSP_ALLOW_WRITE: '1',
      STRUMMER_LSP_ALLOW_PARTIAL_RENAME: '1',
      STRUMMER_LSP_PROJECT_ROOTS: '/abs/project',
      STRUMMER_LSP_SERVERS: SERVERS,
    })
    expect(on.config.allowPartialRename).toBe(true)
  })

  it('parses STRUMMER_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS (default off)', () => {
    const off = buildLspServerFromEnv({
      STRUMMER_LSP_ALLOW_RUN: '1',
      STRUMMER_LSP_PROJECT_ROOTS: '/abs/project',
      STRUMMER_LSP_SERVERS: SERVERS,
    })
    expect(off.config.allowDestructiveResourceOps).toBe(false)
    const on = buildLspServerFromEnv({
      STRUMMER_LSP_ALLOW_RUN: '1',
      STRUMMER_LSP_ALLOW_WRITE: '1',
      STRUMMER_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS: '1',
      STRUMMER_LSP_PROJECT_ROOTS: '/abs/project',
      STRUMMER_LSP_SERVERS: SERVERS,
    })
    expect(on.config.allowDestructiveResourceOps).toBe(true)
  })

  it('HARD-ERRORS when allowDestructiveResourceOps is set without allowWrite', () => {
    expect(() =>
      buildLspServerFromEnv({
        STRUMMER_LSP_ALLOW_RUN: '1',
        STRUMMER_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS: '1',
        STRUMMER_LSP_PROJECT_ROOTS: '/abs/project',
        STRUMMER_LSP_SERVERS: SERVERS,
      }),
    ).toThrow(/STRUMMER_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS requires STRUMMER_LSP_ALLOW_WRITE/)
  })

  it('HARD-ERRORS when allowWrite is set without allowRun (cannot write without a live server)', () => {
    expect(() =>
      buildLspServerFromEnv({
        STRUMMER_LSP_ALLOW_WRITE: '1',
        STRUMMER_LSP_PROJECT_ROOTS: '/abs/project',
        STRUMMER_LSP_SERVERS: SERVERS,
      }),
    ).toThrow(/STRUMMER_LSP_ALLOW_WRITE requires STRUMMER_LSP_ALLOW_RUN/)
  })

  it('a registry without allowRun keeps navigation OFF (gate is paired)', async () => {
    const built = buildLspServerFromEnv({ STRUMMER_LSP_SERVERS: SERVERS })
    expect(built.config.registry).toBeDefined()
    expect(await toolNames(built)).toEqual(['lsp_languages'])
  })

  it('a registry + allowRun WITHOUT a root allowlist keeps navigation OFF (allowlist load-bearing)', async () => {
    const built = buildLspServerFromEnv({
      STRUMMER_LSP_ALLOW_RUN: '1',
      STRUMMER_LSP_SERVERS: SERVERS,
    })
    expect(await toolNames(built)).toEqual(['lsp_languages'])
  })

  it('fails loud on a malformed registry (operator misconfiguration is not silent)', () => {
    expect(() => buildLspServerFromEnv({ STRUMMER_LSP_SERVERS: '{not json' })).toThrow()
  })
})
