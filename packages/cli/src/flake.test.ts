import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestRunner } from '@strummer/flake'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runFlake } from './flake.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

let dir: string
let db: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strummer-cli-flake-'))
  db = join(dir, 'history.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Write a pytest-json report file and return its path. */
function pytestReport(tests: { nodeid: string; outcome: string }[]): string {
  const p = join(dir, `report-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify({ tests }))
  return p
}

describe('strummer flake CLI', () => {
  it('ingest records a pytest report and status classifies it', async () => {
    const report = pytestReport([
      { nodeid: 'tests/test_x.py::test_a', outcome: 'failed' },
      { nodeid: 'tests/test_x.py::test_b', outcome: 'passed' },
      { nodeid: 'tests/test_x.py::test_skip', outcome: 'skipped' },
    ])
    let c = capture()
    expect(
      await runFlake(
        ['ingest', report, '--db', db, '--format', 'pytest', '--at', '2026-06-01T00:00:00Z'],
        c.io,
      ),
    ).toBe(0)
    expect(c.out()).toMatch(/recorded 2/) // skipped dropped

    c = capture()
    expect(await runFlake(['status', '--db', db, '--json'], c.io)).toBe(0)
    const parsed = JSON.parse(c.out())
    expect(parsed.verdicts.map((v: { id: string }) => v.id).sort()).toEqual([
      'tests/test_x.py::test_a',
      'tests/test_x.py::test_b',
    ])
  })

  it('candidates lists a mixed-history test as flaky', async () => {
    await runFlake(
      [
        'ingest',
        pytestReport([{ nodeid: 'tests/test_x.py::wob', outcome: 'failed' }]),
        '--db',
        db,
        '--format',
        'pytest',
        '--at',
        '2026-06-01T00:00:00Z',
      ],
      capture().io,
    )
    await runFlake(
      [
        'ingest',
        pytestReport([{ nodeid: 'tests/test_x.py::wob', outcome: 'passed' }]),
        '--db',
        db,
        '--format',
        'pytest',
        '--at',
        '2026-06-02T00:00:00Z',
      ],
      capture().io,
    )
    const c = capture()
    expect(await runFlake(['candidates', '--db', db, '--json'], c.io)).toBe(0)
    const parsed = JSON.parse(c.out())
    expect(parsed.candidates.map((v: { id: string }) => v.id)).toEqual(['tests/test_x.py::wob'])
  })

  it('run is refused without --allow-run (deny-by-default, no spawn)', async () => {
    let spawned = false
    const runner: TestRunner = async () => {
      spawned = true
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const c = capture()
    expect(await runFlake(['run', dir, '--db', db], c.io, { runner })).toBe(1)
    expect(spawned).toBe(false)
    expect(c.err()).toMatch(/allow-run|not enabled/i)
  })

  it('run executes the injected runner, records, and classifies with --allow-run', async () => {
    const runner: TestRunner = async (argv) => {
      const outFile = argv.find((a) => a.startsWith('--outputFile='))?.split('=')[1] as string
      writeFileSync(
        outFile,
        JSON.stringify({
          testResults: [
            {
              name: join(dir, 'a.test.ts'),
              assertionResults: [{ ancestorTitles: [], title: 'works', status: 'passed' }],
            },
          ],
        }),
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const c = capture()
    const code = await runFlake(['run', dir, '--db', db, '--allow-run', '--repeat', '2'], c.io, {
      runner,
    })
    expect(code).toBe(0)
    expect(c.out()).toMatch(/recorded 2/)
  })

  it('run --framework pytest drives the pytest runner + ingests its json-report', async () => {
    const runner: TestRunner = async (argv) => {
      // Proves the pytest argv path (no vitest `run`/`--outputFile`).
      expect(argv).toContain('--json-report')
      expect(argv[0]).not.toBe('run')
      const outFile = argv.find((a) => a.startsWith('--json-report-file='))?.split('=')[1] as string
      writeFileSync(
        outFile,
        JSON.stringify({ tests: [{ nodeid: 'tests/test_a.py::test_works', outcome: 'passed' }] }),
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const c = capture()
    const code = await runFlake(
      ['run', dir, '--db', db, '--allow-run', '--framework', 'pytest'],
      c.io,
      { runner },
    )
    expect(code).toBe(0)
    expect(c.out()).toMatch(/recorded 1/)
  })

  it('run rejects an unknown --framework', async () => {
    const c = capture()
    expect(await runFlake(['run', dir, '--db', db, '--framework', 'jest'], c.io)).toBe(1)
    expect(c.err()).toMatch(/unknown framework/i)
  })

  it('quarantine is refused without the operator gate', async () => {
    const c = capture()
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    const code = await runFlake(
      [
        'quarantine',
        'tests/test_x.py::wob',
        '--db',
        db,
        '--reason',
        'flaky',
        '--expires-at',
        expiresAt,
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.err()).toMatch(/allowQuarantine|allow-quarantine|not enabled/i)
  })

  it('quarantine writes with the operator gate, then release lifts it', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    let c = capture()
    expect(
      await runFlake(
        [
          'quarantine',
          'tests/test_x.py::wob',
          '--db',
          db,
          '--reason',
          'intermittent',
          '--expires-at',
          expiresAt,
          '--allow-quarantine',
          '--max-expiry-ms',
          '172800000',
        ],
        c.io,
      ),
    ).toBe(0)
    expect(c.out()).toMatch(/tests\/test_x\.py::wob/)

    c = capture()
    expect(await runFlake(['status', '--db', db, '--json'], c.io)).toBe(0)
    expect(JSON.parse(c.out()).quarantined).toHaveLength(1)

    c = capture()
    expect(await runFlake(['release', 'tests/test_x.py::wob', '--db', db], c.io)).toBe(0)
    expect(c.out()).toMatch(/released/)
  })

  it('errors without --db', async () => {
    const c = capture()
    expect(await runFlake(['status'], c.io)).toBe(1)
    expect(c.err()).toMatch(/--db/)
  })

  it('unknown subcommand exits 1', async () => {
    const c = capture()
    expect(await runFlake(['frobnicate'], c.io)).toBe(1)
    expect(c.err()).toMatch(/unknown flake subcommand/)
  })
})
