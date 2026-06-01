import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { OsvAdvisory, Packument } from '@strummer/deps'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDepsServer, type PackumentFetcher } from './deps.js'

// ---- fixtures -------------------------------------------------------------

/** lodash: installed 4.17.15 is both outdated (latest 4.17.21) and vulnerable. */
const LODASH_PACKUMENT: Packument = {
  name: 'lodash',
  'dist-tags': { latest: '4.17.21' },
  versions: {
    '4.17.15': { version: '4.17.15' },
    '4.17.20': { version: '4.17.20' },
    '4.17.21': { version: '4.17.21' },
  },
}

/** left-pad: installed version carries a version-scoped deprecation message. */
const LEFTPAD_PACKUMENT: Packument = {
  name: 'left-pad',
  'dist-tags': { latest: '1.3.0' },
  versions: {
    '1.3.0': { version: '1.3.0', deprecated: 'use String.prototype.padStart' },
  },
}

/** A clean, up-to-date dependency: nothing actionable. */
const TINY_PACKUMENT: Packument = {
  name: 'tiny',
  'dist-tags': { latest: '2.0.0' },
  versions: { '2.0.0': { version: '2.0.0' } },
}

const PACKUMENTS: Record<string, Packument> = {
  lodash: LODASH_PACKUMENT,
  'left-pad': LEFTPAD_PACKUMENT,
  tiny: TINY_PACKUMENT,
}

const fetchPackument: PackumentFetcher = async (name) => {
  const p = PACKUMENTS[name]
  if (!p) throw new Error(`no fixture packument for ${name}`)
  return p
}

const LODASH_ADVISORY: OsvAdvisory = {
  id: 'GHSA-lodash-test',
  modified: '2022-06-14T01:00:00Z',
  aliases: ['CVE-2021-23337'],
  summary: 'Command injection in lodash',
  database_specific: { severity: 'HIGH' },
  affected: [
    {
      package: { ecosystem: 'npm', name: 'lodash' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
    },
  ],
}

const tmpDirs: string[] = []

function makeProject(deps: Record<string, string>, installed: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'strummer-deps-proj-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }))
  for (const [name, version] of Object.entries(installed)) {
    const pkgDir = join(dir, 'node_modules', name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }))
  }
  return dir
}

function makeOsvSnapshot(advisories: OsvAdvisory[]): string {
  const root = mkdtempSync(join(tmpdir(), 'strummer-deps-osv-'))
  tmpDirs.push(root)
  const ecoDir = join(root, 'npm')
  mkdirSync(ecoDir, { recursive: true })
  const zipInput: Record<string, Uint8Array> = {}
  for (const a of advisories) zipInput[`${a.id}.json`] = strToU8(JSON.stringify(a))
  writeFileSync(join(ecoDir, 'all.zip'), zipSync(zipInput))
  return root
}

async function connect(server: ReturnType<typeof createDepsServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

// ---- tests ----------------------------------------------------------------

describe('strummer deps MCP surface', () => {
  let osvDir: string
  let project: string
  const clients: Client[] = []

  beforeAll(() => {
    osvDir = makeOsvSnapshot([LODASH_ADVISORY])
    project = makeProject(
      { lodash: '^4.17.0', 'left-pad': '^1.3.0', tiny: '^2.0.0' },
      { lodash: '4.17.15', 'left-pad': '1.3.0', tiny: '2.0.0' },
    )
  })

  afterAll(async () => {
    for (const c of clients) await c.close()
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('exposes audit_dependency and audit_project', async () => {
    const client = await connect(createDepsServer({ fetchPackument }))
    clients.push(client)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('audit_dependency')
    expect(names).toContain('audit_project')
  })

  it('audit_dependency reports vuln + freshness + osv snapshot date for the installed version', async () => {
    const client = await connect(createDepsServer({ fetchPackument, osvDir }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_dependency',
      arguments: { project, package: 'lodash' },
    })
    const sc = res.structuredContent as {
      package: string
      installedVersion: string
      worstSeverity: string
      vulnerabilities: { id: string; severity: string; fixedIn: string[] }[]
      freshness: { latest?: string; isOutdated: boolean }
      recommendedTarget?: string
      snapshotDate?: string
      osvSnapshotLoaded: boolean
      hasFindings: boolean
    }
    expect(sc.package).toBe('lodash')
    expect(sc.installedVersion).toBe('4.17.15')
    expect(sc.worstSeverity).toBe('high')
    expect(sc.vulnerabilities[0]?.id).toBe('GHSA-lodash-test')
    expect(sc.vulnerabilities[0]?.fixedIn).toContain('4.17.21')
    expect(sc.freshness.latest).toBe('4.17.21')
    expect(sc.freshness.isOutdated).toBe(true)
    expect(sc.recommendedTarget).toBe('4.17.21')
    expect(sc.snapshotDate).toBe('2022-06-14T01:00:00Z')
    expect(sc.osvSnapshotLoaded).toBe(true)
    expect(sc.hasFindings).toBe(true)
  })

  it('audit_dependency surfaces a version-scoped deprecation', async () => {
    const client = await connect(createDepsServer({ fetchPackument }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_dependency',
      arguments: { project, package: 'left-pad' },
    })
    const sc = res.structuredContent as {
      deprecated: { isDeprecated: boolean; scope?: string; message?: string }
      osvSnapshotLoaded: boolean
      hasFindings: boolean
    }
    expect(sc.deprecated.isDeprecated).toBe(true)
    expect(sc.deprecated.scope).toBe('version')
    // No snapshot configured ⇒ vulnerability data is NOT authoritative.
    expect(sc.osvSnapshotLoaded).toBe(false)
    expect(sc.hasFindings).toBe(true)
  })

  it('audit_dependency on a clean, current dependency reports no findings', async () => {
    const client = await connect(createDepsServer({ fetchPackument, osvDir }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_dependency',
      arguments: { project, package: 'tiny' },
    })
    const sc = res.structuredContent as { hasFindings: boolean; worstSeverity: string }
    expect(sc.hasFindings).toBe(false)
    expect(sc.worstSeverity).toBe('none')
  })

  it('audit_dependency fails clearly when network/packument fetch is not enabled', async () => {
    const client = await connect(createDepsServer({ osvDir }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_dependency',
      arguments: { project, package: 'lodash' },
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/not enabled|fetch/i)
  })

  it('audit_dependency fails clearly when the version cannot be detected', async () => {
    const client = await connect(createDepsServer({ fetchPackument }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_dependency',
      arguments: { project, package: 'not-installed' },
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/detect/i)
  })

  it('audit_project rolls up every manifest dependency into a compact verdict', async () => {
    const client = await connect(createDepsServer({ fetchPackument, osvDir }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_project',
      arguments: { project },
    })
    const sc = res.structuredContent as {
      summary: {
        total: number
        withFindings: number
        deprecated: number
        outdated: number
        bySeverity: Record<string, number>
        osvSnapshotLoaded: boolean
        snapshotDate?: string
      }
      dependencies: {
        package: string
        installedVersion: string
        worstSeverity: string
        deprecated: boolean
        isOutdated: boolean
        vulnerabilityCount: number
        hasFindings: boolean
      }[]
      errors: { package: string; error: string }[]
    }
    expect(sc.summary.total).toBe(3)
    expect(sc.summary.osvSnapshotLoaded).toBe(true)
    expect(sc.summary.snapshotDate).toBe('2022-06-14T01:00:00Z')
    expect(sc.summary.withFindings).toBe(2) // lodash (vuln) + left-pad (deprecated)
    expect(sc.summary.deprecated).toBe(1)
    expect(sc.summary.bySeverity.high).toBe(1)
    const lodash = sc.dependencies.find((d) => d.package === 'lodash')
    expect(lodash?.worstSeverity).toBe('high')
    expect(lodash?.vulnerabilityCount).toBe(1)
    expect(lodash?.isOutdated).toBe(true)
    const tiny = sc.dependencies.find((d) => d.package === 'tiny')
    expect(tiny?.hasFindings).toBe(false)
    expect(sc.errors).toEqual([])
  })

  it('audit_project records a per-package error without failing the whole scan', async () => {
    const project2 = makeProject({ lodash: '^4.17.0', ghost: '^1.0.0' }, { lodash: '4.17.15' })
    const client = await connect(createDepsServer({ fetchPackument, osvDir }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_project',
      arguments: { project: project2 },
    })
    const sc = res.structuredContent as {
      dependencies: { package: string }[]
      errors: { package: string; error: string }[]
    }
    expect(sc.dependencies.map((d) => d.package)).toEqual(['lodash'])
    expect(sc.errors.map((e) => e.package)).toEqual(['ghost'])
  })
})
