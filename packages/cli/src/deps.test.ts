import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OsvAdvisory, Packument } from '@sackville-mcp/deps'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDeps } from './deps.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

const LODASH: Packument = {
  name: 'lodash',
  'dist-tags': { latest: '4.17.21' },
  versions: {
    '4.17.15': { version: '4.17.15' },
    '4.17.21': { version: '4.17.21' },
  },
}
const TINY: Packument = {
  name: 'tiny',
  'dist-tags': { latest: '2.0.0' },
  versions: { '2.0.0': { version: '2.0.0' } },
}
const PACKUMENTS: Record<string, Packument> = { lodash: LODASH, tiny: TINY }

const fetchPackument = async (name: string): Promise<Packument> => {
  const p = PACKUMENTS[name]
  if (!p) throw new Error(`no fixture packument for ${name}`)
  return p
}

const LODASH_CHANGELOG = `# Changelog

## [4.17.21] - 2021-02-20
- Fix command injection

## [4.17.15] - 2019-07-19
- Old release
`
const fetchChangelog = async () => ({
  text: LODASH_CHANGELOG,
  source: 'https://example.test/lodash/CHANGELOG.md',
})

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

let dir: string
let project: string
let osvDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sackville-cli-deps-'))
  // A project with lodash (vulnerable + outdated) and tiny (clean) installed.
  project = join(dir, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.0', tiny: '^2.0.0' } }),
  )
  const installed: [string, string][] = [
    ['lodash', '4.17.15'],
    ['tiny', '2.0.0'],
  ]
  for (const [name, version] of installed) {
    const pkgDir = join(project, 'node_modules', name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }))
  }
  // An OSV snapshot holding the lodash advisory.
  osvDir = join(dir, 'osv')
  mkdirSync(join(osvDir, 'npm'), { recursive: true })
  writeFileSync(
    join(osvDir, 'npm', 'all.zip'),
    zipSync({ 'a.json': strToU8(JSON.stringify(LODASH_ADVISORY)) }),
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sackville deps CLI', () => {
  it('audit reports a vulnerable, outdated package and exits 1', async () => {
    const c = capture()
    const code = await runDeps(['audit', project, 'lodash', '--osv-db', osvDir], c.io, {
      fetchPackument,
    })
    expect(code).toBe(1)
    expect(c.out()).toMatch(/4\.17\.15/)
    expect(c.out()).toMatch(/GHSA-lodash-test/)
    expect(c.out()).toMatch(/high/i)
  })

  it('audit --json includes the structured verdict + osvSnapshotLoaded', async () => {
    const c = capture()
    const code = await runDeps(['audit', project, 'tiny', '--osv-db', osvDir, '--json'], c.io, {
      fetchPackument,
    })
    expect(code).toBe(0) // tiny is clean + up to date
    const parsed = JSON.parse(c.out())
    expect(parsed.installedVersion).toBe('2.0.0')
    expect(parsed.osvSnapshotLoaded).toBe(true)
    expect(parsed.worstSeverity).toBe('none')
  })

  it('audit without an OSV snapshot reports osvSnapshotLoaded:false', async () => {
    const c = capture()
    const code = await runDeps(['audit', project, 'tiny', '--json'], c.io, { fetchPackument })
    expect(code).toBe(0)
    expect(JSON.parse(c.out()).osvSnapshotLoaded).toBe(false)
  })

  it('audit-project rolls up the manifest and exits 1 on a finding', async () => {
    const c = capture()
    const code = await runDeps(['audit-project', project, '--osv-db', osvDir, '--json'], c.io, {
      fetchPackument,
    })
    expect(code).toBe(1)
    const parsed = JSON.parse(c.out())
    expect(parsed.summary.total).toBe(2)
    expect(
      parsed.dependencies.find((d: { package: string }) => d.package === 'lodash').worstSeverity,
    ).toBe('high')
  })

  it('changelog slices the sections between installed and target', async () => {
    const c = capture()
    const code = await runDeps(
      ['changelog', 'lodash', '--project', project, '--to', '4.17.21'],
      c.io,
      { fetchPackument, fetchChangelog },
    )
    expect(code).toBe(0)
    expect(c.out()).toMatch(/4\.17\.21/)
    expect(c.out()).toMatch(/command injection/i)
    // The older, already-installed section is excluded.
    expect(c.out()).not.toMatch(/Old release/)
  })

  it('audit needs <project> and <package>', async () => {
    const c = capture()
    expect(await runDeps(['audit', project], c.io, { fetchPackument })).toBe(1)
    expect(c.err()).toMatch(/audit needs/)
  })

  it('unknown subcommand exits 1', async () => {
    const c = capture()
    expect(await runDeps(['frobnicate'], c.io)).toBe(1)
    expect(c.err()).toMatch(/unknown deps subcommand/)
  })
})
