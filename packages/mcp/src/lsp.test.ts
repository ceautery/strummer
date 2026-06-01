import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ArtifactStore } from '@strummer/artifacts'
import type {
  LspQueryInput,
  LspQueryResult,
  LspRenameInput,
  LspRenameResult,
  ServerDescription,
  ServerRegistry,
} from '@strummer/lsp'
import { afterAll, describe, expect, it } from 'vitest'
import { createLspServer, type LspToolsOptions } from './lsp.js'

const REGISTRY: ServerRegistry = {
  typescript: { command: 'tsls', args: ['--stdio'] },
  go: { command: 'gopls', args: [] },
}

interface ToolJson {
  status?: string
  kind?: string
  encoding?: string
  serverInfo?: { name: string; version?: string }
  toolchain?: { name: string; version: string | null }
  versionWarning?: string
  locationCount?: number
  locations?: Array<{ uri: string; range: { start: { line: number; column: number } } }>
  truncated?: boolean
  fullHandle?: string
  hover?: { value: string }
  symbolCount?: number
  symbols?: Array<{ name: string; kindName: string; children?: unknown[] }>
  direction?: string
  callCount?: number
  callHierarchy?: Array<{ source: { name: string }; calls: Array<{ item: { name: string } }> }>
  languages?: string[]
  servers?: unknown
}

/** Parse the first text block of an MCP content/contents array. */
function firstJson<T = ToolJson>(arr: unknown): T {
  const first = (arr as Array<{ text: string }>)[0]
  if (!first) throw new Error('no content')
  return JSON.parse(first.text) as T
}

const tmpDirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strummer-lsp-mcp-'))
  tmpDirs.push(dir)
  return dir
}

const clients: Client[] = []
async function connect(opts: LspToolsOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([
    createLspServer(opts).connect(serverTransport),
    client.connect(clientTransport),
  ])
  clients.push(client)
  return client
}

afterAll(async () => {
  for (const c of clients) await c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const okDefinition: LspQueryResult = {
  status: 'ok',
  kind: 'definition',
  encoding: 'utf-16',
  serverInfo: { name: 'typescript-language-server', version: '5.3.0' },
  locations: [
    {
      uri: 'file:///project/src/greeter.ts',
      range: { start: { line: 1, column: 14 }, end: { line: 1, column: 21 } },
      mapped: true,
    },
  ],
}

/** A stubbed query engine that records the last input and returns a canned result. */
function stubQuery(result: LspQueryResult): {
  query: (input: LspQueryInput) => Promise<LspQueryResult>
  last: () => LspQueryInput | undefined
} {
  let last: LspQueryInput | undefined
  return {
    query: async (input) => {
      last = input
      return { ...result, kind: input.kind }
    },
    last: () => last,
  }
}

const GATED: Omit<LspToolsOptions, 'query'> = {
  registry: REGISTRY,
  allowRun: true,
  allowedRoots: ['/project'],
}

const DEF_ARGS = {
  language: 'typescript',
  projectRoot: '/project',
  file: 'src/index.ts',
  line: 3,
  column: 17,
}

describe('lsp MCP surface gating', () => {
  it('always exposes lsp_languages; gates the navigation tools as a group', async () => {
    const free = await connect({ registry: REGISTRY })
    expect((await free.listTools()).tools.map((t) => t.name)).toEqual(['lsp_languages'])

    const gated = await connect({ ...GATED, query: stubQuery(okDefinition).query })
    expect((await gated.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'lsp_call_hierarchy',
      'lsp_document_symbols',
      'lsp_find_definition',
      'lsp_find_references',
      'lsp_hover',
      'lsp_languages',
      'lsp_type_definition',
    ])

    // allowRun without an allowlist must NOT register the navigation tools.
    const half = await connect({ ...GATED, allowedRoots: [], query: stubQuery(okDefinition).query })
    expect((await half.listTools()).tools.map((t) => t.name)).toEqual(['lsp_languages'])

    // No registry ⇒ nothing is bindable, so the navigation tools stay off.
    const noReg = await connect({
      allowRun: true,
      allowedRoots: ['/project'],
      query: stubQuery(okDefinition).query,
    })
    expect((await noReg.listTools()).tools.map((t) => t.name)).toEqual(['lsp_languages'])
  })
})

describe('lsp_languages', () => {
  it('reports the bound languages and any live-server provenance (never the command/path)', async () => {
    const servers: ServerDescription[] = [
      {
        language: 'typescript',
        projectRoot: '/project',
        serverInfo: { name: 'typescript-language-server', version: '5.3.0' },
        capabilities: { definition: true, references: true, hover: true },
      },
    ]
    const client = await connect({ registry: REGISTRY, describeServers: () => servers })
    const res = await client.callTool({ name: 'lsp_languages', arguments: {} })
    const data = firstJson(res.content)
    expect(data.languages).toEqual(['go', 'typescript'])
    expect(data.servers).toEqual(servers)
    // The serialized output must never leak the operator command/argv.
    expect(JSON.stringify(data)).not.toContain('tsls')
    expect(JSON.stringify(data)).not.toContain('gopls')
  })
})

describe('lsp navigation tools', () => {
  it('lsp_find_definition returns mapped locations + provenance', async () => {
    const stub = stubQuery(okDefinition)
    const client = await connect({ ...GATED, query: stub.query })
    const res = await client.callTool({ name: 'lsp_find_definition', arguments: DEF_ARGS })
    const data = firstJson(res.content)
    expect(stub.last()?.kind).toBe('definition')
    expect(data.status).toBe('ok')
    expect(data.locationCount).toBe(1)
    expect(data.locations?.[0]?.range.start).toEqual({ line: 1, column: 14 })
    expect(data.serverInfo).toEqual({ name: 'typescript-language-server', version: '5.3.0' })
  })

  it('lsp_type_definition queries the typeDefinition kind', async () => {
    const stub = stubQuery(okDefinition)
    const client = await connect({ ...GATED, query: stub.query })
    const res = await client.callTool({ name: 'lsp_type_definition', arguments: DEF_ARGS })
    const data = firstJson(res.content)
    expect(stub.last()?.kind).toBe('typeDefinition')
    expect(data.status).toBe('ok')
    expect(data.locationCount).toBe(1)
  })

  it('lsp_hover returns the hover value', async () => {
    const stub = stubQuery({
      status: 'ok',
      kind: 'hover',
      encoding: 'utf-16',
      hover: { value: '(alias) class Greeter' },
    })
    const client = await connect({ ...GATED, query: stub.query })
    const res = await client.callTool({ name: 'lsp_hover', arguments: DEF_ARGS })
    const data = firstJson(res.content)
    expect(stub.last()?.kind).toBe('hover')
    expect(data.hover?.value).toContain('Greeter')
  })

  it('lsp_document_symbols returns the outline (no position arg) for the documentSymbols kind', async () => {
    const stub = stubQuery({
      status: 'ok',
      kind: 'documentSymbols',
      encoding: 'utf-16',
      symbols: [
        {
          name: 'Greeter',
          kind: 5,
          kindName: 'Class',
          range: { start: { line: 1, column: 1 }, end: { line: 6, column: 2 } },
          children: [
            {
              name: 'greet',
              kind: 6,
              kindName: 'Method',
              range: { start: { line: 3, column: 3 }, end: { line: 5, column: 4 } },
            },
          ],
        },
      ],
    })
    const client = await connect({ ...GATED, query: stub.query })
    const res = await client.callTool({
      name: 'lsp_document_symbols',
      arguments: { language: 'typescript', projectRoot: '/project', file: 'src/greeter.ts' },
    })
    const data = firstJson(res.content)
    expect(stub.last()?.kind).toBe('documentSymbols')
    expect(stub.last()?.line).toBeUndefined() // position-less
    expect(data.symbolCount).toBe(1)
    expect(data.symbols?.[0]?.name).toBe('Greeter')
    expect(data.symbols?.[0]?.children?.length).toBe(1)
  })

  it('lsp_call_hierarchy queries the callHierarchy kind with a direction', async () => {
    const stub = stubQuery({
      status: 'ok',
      kind: 'callHierarchy',
      encoding: 'utf-16',
      callHierarchy: [
        {
          source: {
            name: 'hello',
            kind: 12,
            kindName: 'Function',
            uri: 'file:///project/src/greeter.ts',
            range: { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } },
            selectionRange: { start: { line: 1, column: 17 }, end: { line: 1, column: 22 } },
          },
          direction: 'incoming',
          calls: [
            {
              item: {
                name: 'greet',
                kind: 6,
                kindName: 'Method',
                uri: 'file:///project/src/greeter.ts',
                range: { start: { line: 10, column: 3 }, end: { line: 12, column: 4 } },
                selectionRange: { start: { line: 10, column: 3 }, end: { line: 10, column: 8 } },
              },
              fromRanges: [{ start: { line: 11, column: 12 }, end: { line: 11, column: 17 } }],
            },
          ],
        },
      ],
    })
    const client = await connect({ ...GATED, query: stub.query })
    const res = await client.callTool({
      name: 'lsp_call_hierarchy',
      arguments: { ...DEF_ARGS, direction: 'incoming' },
    })
    const data = firstJson(res.content)
    expect(stub.last()?.kind).toBe('callHierarchy')
    expect(stub.last()?.direction).toBe('incoming')
    expect(data.direction).toBe('incoming')
    expect(data.callCount).toBe(1)
    expect(data.callHierarchy?.[0]?.source.name).toBe('hello')
    expect(data.callHierarchy?.[0]?.calls[0]?.item.name).toBe('greet')
  })

  it('passes through detected toolchain provenance', async () => {
    const stub = stubQuery(okDefinition)
    const client = await connect({
      ...GATED,
      query: stub.query,
      detectToolchain: (_root, language) => ({
        name: language === 'typescript' ? 'typescript' : language,
        version: '5.7.2',
      }),
    })
    await client.callTool({ name: 'lsp_find_definition', arguments: DEF_ARGS })
    expect(stub.last()?.toolchain).toEqual({ name: 'typescript', version: '5.7.2' })
  })

  it('surfaces a versionWarning from the engine', async () => {
    const stub = stubQuery({ ...okDefinition, serverInfo: undefined, versionWarning: 'no version' })
    const client = await connect({ ...GATED, query: stub.query })
    const res = await client.callTool({ name: 'lsp_find_definition', arguments: DEF_ARGS })
    const data = firstJson(res.content)
    expect(data.versionWarning).toMatch(/version/i)
  })

  it('does NOT register lsp_rename unless a rename engine is wired', async () => {
    const gated = await connect({ ...GATED, query: stubQuery(okDefinition).query })
    expect((await gated.listTools()).tools.map((t) => t.name)).not.toContain('lsp_rename')
  })

  it('stores a large reference list by handle and serves it via the resource', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      uri: `file:///project/src/f${i}.ts`,
      range: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 5 } },
      mapped: true,
    }))
    const stub = stubQuery({
      status: 'ok',
      kind: 'references',
      encoding: 'utf-16',
      locations: many,
    })
    const artifacts = new ArtifactStore(tmp(), 'lsp')
    const client = await connect({ ...GATED, query: stub.query, artifacts })
    const res = await client.callTool({ name: 'lsp_find_references', arguments: DEF_ARGS })
    const data = firstJson(res.content)
    expect(data.locationCount).toBe(120)
    expect(data.locations?.length).toBeLessThan(120) // only the head is inlined
    expect(data.truncated).toBe(true)
    expect(data.fullHandle).toMatch(/^strummer:\/\/lsp\//)

    const full = await client.readResource({ uri: data.fullHandle as string })
    const served = firstJson<unknown[]>(full.contents)
    expect(served).toHaveLength(120)
  })
})

interface RenameJson {
  status?: string
  kind?: string
  applied?: boolean
  refused?: string
  newName?: string
  fileCount?: number
  totalEditCount?: number
  edits?: Array<{
    uri: string
    file: string
    editCount: number
    hunks?: Array<{ oldText: string; newText: string }>
  }>
  digests?: Array<{ file: string }>
  truncated?: boolean
  fullHandle?: string
}

function stubRename(result: LspRenameResult): {
  rename: (input: LspRenameInput) => Promise<LspRenameResult>
  last: () => LspRenameInput | undefined
} {
  let last: LspRenameInput | undefined
  return {
    rename: async (input) => {
      last = input
      return result
    },
    last: () => last,
  }
}

const previewResult: LspRenameResult = {
  status: 'ok',
  kind: 'rename',
  applied: false,
  newName: 'Greeter2',
  fileCount: 1,
  totalEditCount: 1,
  encoding: 'utf-16',
  serverInfo: { name: 'typescript-language-server', version: '5.3.0' },
  edits: [
    {
      uri: 'file:///project/src/greeter.ts',
      file: 'src/greeter.ts',
      editCount: 1,
      hunks: [
        {
          range: { start: { line: 5, column: 14 }, end: { line: 5, column: 21 } },
          oldText: 'Greeter',
          newText: 'Greeter2',
        },
      ],
    },
  ],
}

const RENAME_ARGS = { ...DEF_ARGS, newName: 'Greeter2' }

describe('lsp_rename (write-mode surface)', () => {
  it('registers only when a rename engine is wired (alongside navigation)', async () => {
    const client = await connect({
      ...GATED,
      query: stubQuery(okDefinition).query,
      rename: stubRename(previewResult).rename,
    })
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('lsp_rename')
  })

  it('returns a dry-run preview (applied:false) with per-file hunks; has NO write input', async () => {
    const stub = stubRename(previewResult)
    const client = await connect({
      ...GATED,
      query: stubQuery(okDefinition).query,
      rename: stub.rename,
    })
    const tool = (await client.listTools()).tools.find((t) => t.name === 'lsp_rename')
    // The tool surface exposes no input that could turn writing on.
    expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain('write')
    const res = await client.callTool({ name: 'lsp_rename', arguments: RENAME_ARGS })
    const data = firstJson<RenameJson>(res.content)
    expect(stub.last()?.newName).toBe('Greeter2')
    expect(data.applied).toBe(false)
    expect(data.fileCount).toBe(1)
    expect(data.edits?.[0]?.hunks?.[0]).toMatchObject({ oldText: 'Greeter', newText: 'Greeter2' })
  })

  it('surfaces an applied result with digests', async () => {
    const applied: LspRenameResult = {
      ...previewResult,
      applied: true,
      digests: [{ file: 'src/greeter.ts', before: 'aaa', after: 'bbb' }],
    }
    const client = await connect({
      ...GATED,
      query: stubQuery(okDefinition).query,
      rename: stubRename(applied).rename,
    })
    const res = await client.callTool({ name: 'lsp_rename', arguments: RENAME_ARGS })
    const data = firstJson<RenameJson>(res.content)
    expect(data.applied).toBe(true)
    expect(data.digests?.[0]?.file).toBe('src/greeter.ts')
  })

  it('offloads a large edit set by handle (rename-preview) and serves it', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      uri: `file:///project/src/f${i}.ts`,
      file: `src/f${i}.ts`,
      editCount: 1,
      hunks: [
        {
          range: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } },
          oldText: 'Greeter',
          newText: 'Greeter2',
        },
      ],
    }))
    const big: LspRenameResult = {
      ...previewResult,
      fileCount: 120,
      totalEditCount: 120,
      edits: many,
    }
    const artifacts = new ArtifactStore(tmp(), 'lsp')
    const client = await connect({
      ...GATED,
      query: stubQuery(okDefinition).query,
      rename: stubRename(big).rename,
      artifacts,
    })
    const res = await client.callTool({ name: 'lsp_rename', arguments: RENAME_ARGS })
    const data = firstJson<RenameJson>(res.content)
    expect(data.truncated).toBe(true)
    expect(data.fullHandle).toMatch(/^strummer:\/\/lsp\/rename-preview-/)
    const full = await client.readResource({ uri: data.fullHandle as string })
    const served = firstJson<LspRenameResult>(full.contents)
    expect(served.edits).toHaveLength(120)
  })
})
