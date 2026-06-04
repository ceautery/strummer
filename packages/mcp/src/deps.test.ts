import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ArtifactStore } from '@strummer/artifacts'
import type { OsvAdvisory, Packument } from '@strummer/deps'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  auditProjectDependencies,
  type ChangelogFetcher,
  createDepsServer,
  type PackumentFetcher,
} from './deps.js'

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

const LODASH_CHANGELOG = `# Changelog

## [4.17.21] - 2021-02-20
### Security
- Fix command injection (CVE-2021-23337)

## [4.17.20] - 2020-08-13
- Misc fixes

## [4.17.15] - 2019-07-19
- Old release
`

const fetchChangelog: ChangelogFetcher = async (name) => {
  if (name !== 'lodash') throw new Error(`no fixture changelog for ${name}`)
  return { text: LODASH_CHANGELOG, source: 'https://example.test/lodash/CHANGELOG.md' }
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

function makeOsvSnapshot(advisories: OsvAdvisory[], ecosystem = 'npm'): string {
  const root = mkdtempSync(join(tmpdir(), 'strummer-deps-osv-'))
  tmpDirs.push(root)
  const ecoDir = join(root, ecosystem)
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
        minimumSafeUpgrade?: string
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
    expect(lodash?.minimumSafeUpgrade).toBe('4.17.21') // 4.17.20 still vulnerable, 4.17.21 clears it
    const tiny = sc.dependencies.find((d) => d.package === 'tiny')
    expect(tiny?.hasFindings).toBe(false)
    expect(sc.errors).toEqual([])
  })

  // ---- the reusable per-package pipeline (slice 5d-4) --------------------

  it('auditProjectDependencies audits every declared dependency and reports osvSnapshotLoaded', async () => {
    const r = await auditProjectDependencies({
      project,
      ecosystem: 'npm',
      osvDir,
      fetchPackument,
    })
    expect(r.osvSnapshotLoaded).toBe(true)
    expect(r.audits.map((a) => a.package).sort()).toEqual(['left-pad', 'lodash', 'tiny'])
    expect(r.errors).toEqual([])
    expect(r.audits.find((a) => a.package === 'lodash')?.worstSeverity).toBe('high')
  })

  it('auditProjectDependencies scopes to an explicit names list (diff-changed deps)', async () => {
    const r = await auditProjectDependencies({ project, names: ['lodash'], osvDir, fetchPackument })
    expect(r.audits.map((a) => a.package)).toEqual(['lodash'])
    expect(r.errors).toEqual([])
  })

  it('auditProjectDependencies isolates a per-package error (undetectable package)', async () => {
    const r = await auditProjectDependencies({
      project,
      names: ['lodash', 'ghost'],
      osvDir,
      fetchPackument,
    })
    expect(r.audits.map((a) => a.package)).toEqual(['lodash'])
    expect(r.errors.map((e) => e.package)).toEqual(['ghost'])
  })

  it('auditProjectDependencies reports osvSnapshotLoaded:false when no snapshot is configured', async () => {
    const r = await auditProjectDependencies({ project, names: ['tiny'], fetchPackument })
    expect(r.osvSnapshotLoaded).toBe(false)
    expect(r.audits.map((a) => a.package)).toEqual(['tiny'])
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

  it('audit_project omits a detail handle when no artifact store is configured', async () => {
    const client = await connect(createDepsServer({ fetchPackument, osvDir }))
    clients.push(client)
    const res = await client.callTool({ name: 'audit_project', arguments: { project } })
    expect((res.structuredContent as { detailHandle?: string }).detailHandle).toBeUndefined()
  })

  it('audit_project stores the full per-package verdicts by handle when a store is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strummer-deps-art-'))
    tmpDirs.push(dir)
    const client = await connect(
      createDepsServer({ fetchPackument, osvDir, artifacts: new ArtifactStore(dir, 'deps') }),
    )
    clients.push(client)

    const res = await client.callTool({ name: 'audit_project', arguments: { project } })
    const handle = (res.structuredContent as { detailHandle: string }).detailHandle
    expect(handle).toMatch(/^strummer:\/\/deps\/.+\/audit$/)

    // The full detail (vulnerability ids, deprecation messages, freshness) is by handle,
    // never inlined in the compact roll-up.
    const read = await client.readResource({ uri: handle })
    const content = read.contents[0] as { text: string; mimeType: string }
    expect(content.mimeType).toBe('application/json')
    const detail = JSON.parse(content.text) as {
      audits: {
        package: string
        vulnerabilities: { id: string; fixedIn: string[] }[]
        deprecated: { isDeprecated: boolean; message?: string }
        freshness: { latest?: string }
      }[]
    }
    const lodash = detail.audits.find((a) => a.package === 'lodash')
    expect(lodash?.vulnerabilities[0]?.id).toBe('GHSA-lodash-test')
    expect(lodash?.vulnerabilities[0]?.fixedIn).toContain('4.17.21')
    expect(lodash?.freshness.latest).toBe('4.17.21')
    const leftPad = detail.audits.find((a) => a.package === 'left-pad')
    expect(leftPad?.deprecated.message).toContain('padStart')
  })

  it('exposes changelog_diff only when an artifact store + fetcher are configured', async () => {
    const without = await connect(createDepsServer({ fetchPackument }))
    clients.push(without)
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain('changelog_diff')

    const dir = mkdtempSync(join(tmpdir(), 'strummer-deps-art-'))
    tmpDirs.push(dir)
    const withCl = await connect(
      createDepsServer({ fetchChangelog, artifacts: new ArtifactStore(dir, 'deps') }),
    )
    clients.push(withCl)
    expect((await withCl.listTools()).tools.map((t) => t.name)).toContain('changelog_diff')
  })

  it('changelog_diff slices the installed→target range and returns it by handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strummer-deps-art-'))
    tmpDirs.push(dir)
    const store = new ArtifactStore(dir, 'deps')
    const client = await connect(createDepsServer({ fetchChangelog, artifacts: store }))
    clients.push(client)

    const res = await client.callTool({
      name: 'changelog_diff',
      arguments: { project, package: 'lodash', to: '4.17.21' },
    })
    const sc = res.structuredContent as {
      from: string
      to: string | null
      versionsCovered: string[]
      entryCount: number
      handle: string
      source: string
      byteSize: number
    }
    // installed lodash is 4.17.15 (auto-detected) → covers 4.17.20 and 4.17.21.
    expect(sc.from).toBe('4.17.15')
    expect(sc.to).toBe('4.17.21')
    expect(sc.versionsCovered).toEqual(['4.17.21', '4.17.20'])
    expect(sc.entryCount).toBe(2)
    expect(sc.source).toBe('https://example.test/lodash/CHANGELOG.md')
    expect(sc.handle).toBe('strummer://deps/lodash-4.17.15-to-4.17.21/changelog')
    expect(sc.byteSize).toBeGreaterThan(0)

    // The full sliced markdown is fetchable via the resource (never inlined in the tool).
    const read = await client.readResource({ uri: sc.handle })
    const body = (read.contents[0] as { text: string }).text
    expect(body).toContain('CVE-2021-23337')
    expect(body).toContain('### Security')
    expect(body).not.toContain('Old release') // 4.17.15 itself is excluded
  })

  it('changelog_diff drives the PyPI ecosystem (fetcher + PEP 440 comparator)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strummer-deps-art-'))
    tmpDirs.push(dir)
    const store = new ArtifactStore(dir, 'deps')
    const fetchPyChangelog: ChangelogFetcher = async (name, ecosystem) => {
      expect(ecosystem).toBe('PyPI')
      expect(name).toBe('requests')
      return {
        text: '## 2.32.0\n- big change\n\n## 2.31.1\n- a fix\n\n## 2.31.0\n- baseline\n',
        source: 'https://raw.githubusercontent.com/psf/requests/HEAD/HISTORY.md',
      }
    }
    const client = await connect(
      createDepsServer({ fetchChangelog: fetchPyChangelog, artifacts: store }),
    )
    clients.push(client)

    const res = await client.callTool({
      name: 'changelog_diff',
      arguments: { package: 'requests', ecosystem: 'PyPI', from: '2.31.0', to: '2.32.0' },
    })
    const sc = res.structuredContent as { ecosystem: string; versionsCovered: string[] }
    expect(sc.ecosystem).toBe('PyPI')
    expect(sc.versionsCovered).toEqual(['2.32.0', '2.31.1'])
  })

  it('changelog_diff fails clearly when not enabled', async () => {
    const client = await connect(createDepsServer({ fetchPackument }))
    clients.push(client)
    // The tool is not even registered without a store/fetcher, so calling it errors.
    const res = await client.callTool({
      name: 'changelog_diff',
      arguments: { project, package: 'lodash' },
    })
    expect(res.isError).toBe(true)
  })

  // ---- PyPI (ADR 0012 slice 3) -------------------------------------------

  it('audit_dependency audits an installed PyPI package with PEP 440 + a normalized OSV name', async () => {
    // Django 5.0.0 is installed (requirements.txt), vulnerable per a PyPI ECOSYSTEM range.
    const pyProject = mkdtempSync(join(tmpdir(), 'strummer-deps-py-'))
    tmpDirs.push(pyProject)
    writeFileSync(join(pyProject, 'requirements.txt'), 'Django==5.0.0\n')

    const djangoPackument: Packument = {
      name: 'django',
      'dist-tags': { latest: '5.0.4' },
      versions: {
        '5.0.0': { version: '5.0.0' },
        '5.0.3': { version: '5.0.3' },
        '5.0.4': { version: '5.0.4' },
      },
    }
    const fetchPyPi: PackumentFetcher = async (name, ecosystem) => {
      expect(ecosystem).toBe('PyPI')
      // The agent typed "Django"; OSV/PyPI canonical name is "django".
      if (name === 'Django') return djangoPackument
      throw new Error(`no fixture packument for ${name}`)
    }

    const djangoAdvisory: OsvAdvisory = {
      id: 'PYSEC-2024-1',
      modified: '2024-03-01T00:00:00Z',
      aliases: ['CVE-2024-0001'],
      summary: 'SQL injection in Django',
      database_specific: { severity: 'CRITICAL' },
      affected: [
        {
          package: { ecosystem: 'PyPI', name: 'django' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '5.0' }, { fixed: '5.0.3' }] }],
        },
      ],
    }
    const pyOsvDir = makeOsvSnapshot([djangoAdvisory], 'PyPI')

    const client = await connect(createDepsServer({ fetchPackument: fetchPyPi, osvDir: pyOsvDir }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_dependency',
      arguments: { project: pyProject, package: 'Django', ecosystem: 'PyPI' },
    })
    const sc = res.structuredContent as {
      package: string
      ecosystem: string
      installedVersion: string
      worstSeverity: string
      vulnerabilities: { id: string; fixedIn: string[] }[]
      recommendedTarget?: string
      minimumSafeUpgrade?: string
      osvSnapshotLoaded: boolean
    }
    expect(sc.package).toBe('django') // PEP 503-normalized for the OSV match
    expect(sc.ecosystem).toBe('PyPI')
    expect(sc.installedVersion).toBe('5.0.0')
    expect(sc.worstSeverity).toBe('critical')
    expect(sc.vulnerabilities[0]?.id).toBe('PYSEC-2024-1')
    expect(sc.vulnerabilities[0]?.fixedIn).toContain('5.0.3')
    expect(sc.minimumSafeUpgrade).toBe('5.0.3') // lowest stable clearing the advisory
    expect(sc.recommendedTarget).toBe('5.0.4') // newest same-major
    expect(sc.osvSnapshotLoaded).toBe(true)
  })

  it('audit_dependency audits an installed RubyGems package with Gem::Version ordering', async () => {
    // rails 7.0.4 is installed (Gemfile.lock), vulnerable per a RubyGems ECOSYSTEM range.
    const rbProject = mkdtempSync(join(tmpdir(), 'strummer-deps-rb-'))
    tmpDirs.push(rbProject)
    writeFileSync(
      join(rbProject, 'Gemfile.lock'),
      'GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.0.4)\n',
    )

    const railsPackument: Packument = {
      name: 'rails',
      versions: {
        '7.0.4': { version: '7.0.4' },
        '7.0.8': { version: '7.0.8' },
        '7.1.0': { version: '7.1.0' },
        '7.1.0.rc1': { version: '7.1.0.rc1' },
      },
    }
    const fetchGem: PackumentFetcher = async (name, ecosystem) => {
      expect(ecosystem).toBe('RubyGems')
      if (name === 'rails') return railsPackument
      throw new Error(`no fixture packument for ${name}`)
    }

    const railsAdvisory: OsvAdvisory = {
      id: 'GHSA-rails-test',
      modified: '2024-05-01T00:00:00Z',
      summary: 'XSS in rails',
      database_specific: { severity: 'HIGH' },
      affected: [
        {
          package: { ecosystem: 'RubyGems', name: 'rails' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '7.0.0' }, { fixed: '7.0.8' }] }],
        },
      ],
    }
    const rbOsvDir = makeOsvSnapshot([railsAdvisory], 'RubyGems')

    const client = await connect(createDepsServer({ fetchPackument: fetchGem, osvDir: rbOsvDir }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_dependency',
      arguments: { project: rbProject, package: 'rails', ecosystem: 'RubyGems' },
    })
    const sc = res.structuredContent as {
      installedVersion: string
      worstSeverity: string
      vulnerabilities: { id: string; fixedIn: string[] }[]
      minimumSafeUpgrade?: string
      recommendedTarget?: string
      freshness: { latest?: string }
    }
    expect(sc.installedVersion).toBe('7.0.4')
    expect(sc.worstSeverity).toBe('high')
    expect(sc.vulnerabilities[0]?.id).toBe('GHSA-rails-test')
    expect(sc.minimumSafeUpgrade).toBe('7.0.8') // lowest stable clearing the advisory
    expect(sc.recommendedTarget).toBe('7.1.0') // newest same-major (the .rc1 prerelease is excluded)
    expect(sc.freshness.latest).toBe('7.1.0')
  })

  it('audit_project rolls up a PyPI project from requirements.txt', async () => {
    const pyProject = mkdtempSync(join(tmpdir(), 'strummer-deps-pyproj-'))
    tmpDirs.push(pyProject)
    writeFileSync(join(pyProject, 'requirements.txt'), 'Django==5.0.0\nrequests==2.31.0\n')

    const packuments: Record<string, Packument> = {
      django: {
        name: 'django',
        'dist-tags': { latest: '5.0.4' },
        versions: { '5.0.0': { version: '5.0.0' }, '5.0.4': { version: '5.0.4' } },
      },
      requests: {
        name: 'requests',
        'dist-tags': { latest: '2.31.0' },
        versions: { '2.31.0': { version: '2.31.0' } },
      },
    }
    const fetchPyPi: PackumentFetcher = async (name, ecosystem) => {
      expect(ecosystem).toBe('PyPI')
      const p = packuments[name]
      if (!p) throw new Error(`no fixture for ${name}`)
      return p
    }
    const djangoAdvisory: OsvAdvisory = {
      id: 'PYSEC-2024-1',
      modified: '2024-03-01T00:00:00Z',
      database_specific: { severity: 'CRITICAL' },
      affected: [
        {
          package: { ecosystem: 'PyPI', name: 'django' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '5.0' }, { fixed: '5.0.4' }] }],
        },
      ],
    }
    const osv = makeOsvSnapshot([djangoAdvisory], 'PyPI')
    const client = await connect(createDepsServer({ fetchPackument: fetchPyPi, osvDir: osv }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_project',
      arguments: { project: pyProject, ecosystem: 'PyPI' },
    })
    const sc = res.structuredContent as {
      summary: { total: number; bySeverity: Record<string, number> }
      dependencies: { package: string; worstSeverity: string; vulnerabilityCount: number }[]
    }
    expect(sc.summary.total).toBe(2)
    expect(sc.dependencies.map((d) => d.package).sort()).toEqual(['django', 'requests'])
    expect(sc.dependencies.find((d) => d.package === 'django')?.worstSeverity).toBe('critical')
    expect(sc.dependencies.find((d) => d.package === 'requests')?.vulnerabilityCount).toBe(0)
    expect(sc.summary.bySeverity.critical).toBe(1)
  })

  it('audit_project rolls up a RubyGems project from Gemfile.lock', async () => {
    const rbProject = mkdtempSync(join(tmpdir(), 'strummer-deps-rbproj-'))
    tmpDirs.push(rbProject)
    writeFileSync(
      join(rbProject, 'Gemfile.lock'),
      [
        'GEM',
        '  remote: https://rubygems.org/',
        '  specs:',
        '    puma (6.4.0)',
        '    rails (7.0.4)',
        '',
        'PLATFORMS',
        '  ruby',
        '',
        'DEPENDENCIES',
        '  puma',
        '  rails (~> 7.0)',
        '',
        'BUNDLED WITH',
        '   2.4.0',
        '',
      ].join('\n'),
    )

    const packuments: Record<string, Packument> = {
      rails: {
        name: 'rails',
        versions: { '7.0.4': { version: '7.0.4' }, '7.0.8': { version: '7.0.8' } },
      },
      puma: { name: 'puma', versions: { '6.4.0': { version: '6.4.0' } } },
    }
    const fetchGem: PackumentFetcher = async (name, ecosystem) => {
      expect(ecosystem).toBe('RubyGems')
      const p = packuments[name]
      if (!p) throw new Error(`no fixture for ${name}`)
      return p
    }
    const railsAdvisory: OsvAdvisory = {
      id: 'GHSA-rails-test',
      modified: '2024-05-01T00:00:00Z',
      database_specific: { severity: 'HIGH' },
      affected: [
        {
          package: { ecosystem: 'RubyGems', name: 'rails' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '7.0.0' }, { fixed: '7.0.8' }] }],
        },
      ],
    }
    const osv = makeOsvSnapshot([railsAdvisory], 'RubyGems')
    const client = await connect(createDepsServer({ fetchPackument: fetchGem, osvDir: osv }))
    clients.push(client)
    const res = await client.callTool({
      name: 'audit_project',
      arguments: { project: rbProject, ecosystem: 'RubyGems' },
    })
    const sc = res.structuredContent as {
      summary: { total: number }
      dependencies: { package: string; worstSeverity: string }[]
    }
    // Declared deps (puma, rails) — NOT every resolved spec.
    expect(sc.dependencies.map((d) => d.package).sort()).toEqual(['puma', 'rails'])
    expect(sc.dependencies.find((d) => d.package === 'rails')?.worstSeverity).toBe('high')
  })
})
