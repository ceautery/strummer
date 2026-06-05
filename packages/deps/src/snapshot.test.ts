import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { afterAll, describe, expect, it } from 'vitest'
import { matchVulnerabilities, type OsvAdvisory } from './osv.js'
import { loadOsvSnapshot } from './snapshot.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

const lodashAdvisories = JSON.parse(
  readFileSync(resolve(FIXTURES, 'lodash-osv.json'), 'utf8'),
) as OsvAdvisory[]

const tmpDirs: string[] = []

/**
 * Build an OSV snapshot dir on disk: `<root>/<ecosystem>/all.zip`, one JSON entry per
 * advisory, plus any extra (non-advisory) entries. Returns the snapshot root.
 */
function buildSnapshot(
  ecosystem: string,
  advisories: OsvAdvisory[],
  extraEntries: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'sackville-osv-'))
  tmpDirs.push(root)
  const ecoDir = join(root, ecosystem)
  mkdirSync(ecoDir, { recursive: true })
  const zipInput: Record<string, Uint8Array> = {}
  for (const advisory of advisories) {
    zipInput[`${advisory.id}.json`] = strToU8(JSON.stringify(advisory))
  }
  for (const [name, content] of Object.entries(extraEntries)) {
    zipInput[name] = strToU8(content)
  }
  writeFileSync(join(ecoDir, 'all.zip'), zipSync(zipInput))
  return root
}

afterAll(() => {
  for (const dir of tmpDirs) {
    // best-effort cleanup; tmpdir is reclaimed by the OS regardless
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadOsvSnapshot — read advisories from an on-disk OSV snapshot', () => {
  it('unzips all.zip, parses advisories (sorted by id), and derives the newest modified as snapshotDate', () => {
    const root = buildSnapshot('npm', lodashAdvisories)
    const snapshot = loadOsvSnapshot(root, 'npm')

    expect(snapshot.ecosystem).toBe('npm')
    expect(snapshot.advisories.map((a) => a.id)).toEqual([
      'GHSA-35jh-r3h4-6jhm',
      'GHSA-jf85-cpcp-j695',
    ])
    expect(snapshot.snapshotDate).toBe('2022-06-14T01:00:00Z')
  })

  it('produces advisories that feed straight into matchVulnerabilities', () => {
    const root = buildSnapshot('npm', lodashAdvisories)
    const { advisories } = loadOsvSnapshot(root, 'npm')

    const matches = matchVulnerabilities(
      advisories,
      { ecosystem: 'npm', name: 'lodash' },
      '4.17.15',
    )
    expect(matches.map((m) => m.id)).toEqual(['GHSA-35jh-r3h4-6jhm'])
  })

  it('ignores non-JSON entries in the zip', () => {
    const root = buildSnapshot('npm', lodashAdvisories, {
      'README.md': '# OSV npm',
      'index.csv': 'a,b',
    })
    const { advisories } = loadOsvSnapshot(root, 'npm')
    expect(advisories).toHaveLength(2)
  })

  it('leaves snapshotDate undefined when no advisory carries a modified timestamp', () => {
    const root = buildSnapshot('npm', [
      { id: 'OSV-NODATE', affected: [{ package: { ecosystem: 'npm', name: 'x' } }] },
    ])
    expect(loadOsvSnapshot(root, 'npm').snapshotDate).toBeUndefined()
  })

  it('throws a clear error when the ecosystem snapshot is absent (fail loud, not silent zero)', () => {
    const root = buildSnapshot('npm', lodashAdvisories)
    expect(() => loadOsvSnapshot(root, 'PyPI')).toThrow(/OSV snapshot not found.*PyPI/)
  })
})
