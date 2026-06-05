import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openDb } from '@sackville-mcp/core'
import type DatabaseType from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSackvilleServer } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../../fixtures/golden.sqlite')

const tempProjects: string[] = []

/** Create a temp project with `react` installed at the given concrete version. */
function makeReactProject(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sackville-proj-'))
  tempProjects.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { react: `^${version}` } }),
  )
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version }),
  )
  return dir
}

describe('sackville MCP server', () => {
  let db: DatabaseType.Database
  let client: Client

  beforeAll(async () => {
    db = openDb(FIXTURE)
    const server = createSackvilleServer(db)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })
  afterAll(async () => {
    await client?.close()
    db?.close()
    for (const dir of tempProjects) rmSync(dir, { recursive: true, force: true })
  })

  it('exposes the search_docs and get_doc tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('search_docs')
    expect(names).toContain('get_doc')
  })

  it('search_docs returns compact results with resource links', async () => {
    const res = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'useState', library: 'react' },
    })
    const structured = res.structuredContent as {
      results: {
        id: number
        symbol: string
        version: string
        resourceUri: string
        body?: unknown
      }[]
    }
    expect(structured.results).toHaveLength(1)
    const hit = structured.results[0]!
    expect(hit).toMatchObject({ symbol: 'useState', version: '19.0' })
    expect(hit.resourceUri).toBe(`sackville://doc/${hit.id}`)
    // Compact by design: search results must NOT carry the full body.
    expect(hit.body).toBeUndefined()
  })

  it('get_doc returns the full fragment body', async () => {
    const search = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'useState' },
    })
    const id = (search.structuredContent as { results: { id: number }[] }).results[0]!.id

    const res = await client.callTool({ name: 'get_doc', arguments: { id } })
    const doc = res.structuredContent as { body: string; url: string; attribution: string }
    expect(doc.body).toContain('state variable')
    expect(doc.url).toContain('react.dev')
    expect(doc.attribution).toContain('MIT')
  })

  it('get_doc reports an error for an unknown id', async () => {
    const res = await client.callTool({ name: 'get_doc', arguments: { id: 999_999 } })
    expect(res.isError).toBe(true)
  })

  it('serves the same fragment via the sackville://doc/{id} resource', async () => {
    const search = await client.callTool({ name: 'search_docs', arguments: { query: 'useState' } })
    const id = (search.structuredContent as { results: { id: number }[] }).results[0]!.id

    const res = await client.readResource({ uri: `sackville://doc/${id}` })
    const first = res.contents[0] as { text: string }
    const doc = JSON.parse(first.text)
    expect(doc).toMatchObject({ id, symbol: 'useState' })
  })

  it('lists the indexed versions for a library', async () => {
    const res = await client.callTool({ name: 'list_versions', arguments: { library: 'react' } })
    expect(res.structuredContent).toMatchObject({ library: 'react', versions: ['19.0'] })
  })

  it('resolves an installed version to a doc release', async () => {
    const res = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'useState', library: 'react', installed: '19.0.0' },
    })
    const sc = res.structuredContent as { resolvedVersion: string; results: unknown[] }
    expect(sc.resolvedVersion).toBe('19.0')
    expect(sc.results).toHaveLength(1)
  })

  it('reports when the installed major is not indexed (no silent wrong version)', async () => {
    const res = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'useState', library: 'react', installed: '18.0.0' },
    })
    const sc = res.structuredContent as { resolvedVersion: string | null; versionNote: string }
    expect(sc.resolvedVersion).toBeNull()
    expect(sc.versionNote).toContain('available versions')
  })

  it('detect_version detects an installed version and resolves it', async () => {
    const project = makeReactProject('19.0.0')
    const res = await client.callTool({
      name: 'detect_version',
      arguments: { project, library: 'react' },
    })
    expect(res.structuredContent).toMatchObject({
      detectedVersion: '19.0.0',
      detectedSource: 'node_modules',
      resolvedVersion: '19.0',
      exact: true,
    })
  })

  it('search_docs auto-detects the version from a project path', async () => {
    const project = makeReactProject('19.0.0')
    const res = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'useState', library: 'react', project },
    })
    const sc = res.structuredContent as {
      detectedVersion: string
      resolvedVersion: string
      results: unknown[]
    }
    expect(sc.detectedVersion).toBe('19.0.0')
    expect(sc.resolvedVersion).toBe('19.0')
    expect(sc.results).toHaveLength(1)
  })
})
