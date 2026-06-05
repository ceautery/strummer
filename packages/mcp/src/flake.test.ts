import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HistoryStore, type TestRunner } from '@sackville-mcp/flake'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFlakeServer, type FlakeToolsOptions } from './flake.js'

const NOW = '2026-06-01T00:00:00Z'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

async function connect(opts: FlakeToolsOptions) {
  const server = createFlakeServer(opts)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).sort()
}

function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args }) as Promise<{
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }>
}

describe('flake MCP surface', () => {
  let store: HistoryStore

  beforeEach(() => {
    store = HistoryStore.memory()
    // a flaky test (6 mixed runs) and a reliable one (6 passes)
    store.recordRuns([
      ...Array.from({ length: 6 }, (_, i) => ({
        testId: 'flaky',
        passed: i % 2 === 0,
        at: `2026-05-2${i}T00:00:00Z`,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        testId: 'solid',
        passed: true,
        at: `2026-05-2${i}T00:00:00Z`,
      })),
    ])
  })

  it('always exposes the read + ingest tools; gates run/quarantine off by default', async () => {
    const client = await connect({ store })
    expect(await toolNames(client)).toEqual([
      'flake_candidates',
      'flake_ingest',
      'flake_release',
      'flake_status',
    ])
  })

  it('flake_ingest records a pytest report (CI-produced, no spawn) and classifies it', async () => {
    const fresh = HistoryStore.memory()
    const client = await connect({ store: fresh })
    const report = {
      tests: [
        { nodeid: 'tests/test_x.py::test_wobbles', outcome: 'failed' },
        { nodeid: 'tests/test_x.py::test_solid', outcome: 'passed' },
        { nodeid: 'tests/test_x.py::test_skip', outcome: 'skipped' },
      ],
    }
    const r1 = await call(client, 'flake_ingest', {
      format: 'pytest',
      report,
      at: '2026-06-01T00:00:00Z',
    })
    expect(r1.structuredContent?.recorded).toBe(2) // skipped dropped
    // A second, all-pass ingest makes test_wobbles a mixed history → flaky.
    await call(client, 'flake_ingest', {
      format: 'pytest',
      report: { tests: [{ nodeid: 'tests/test_x.py::test_wobbles', outcome: 'passed' }] },
      at: '2026-06-02T00:00:00Z',
    })
    const verdicts = r1.structuredContent?.verdicts as { id: string; state: string }[]
    expect(verdicts.find((v) => v.id === 'tests/test_x.py::test_wobbles')).toBeTruthy()
    const status = await call(client, 'flake_status', {})
    const byId = Object.fromEntries(
      (status.structuredContent?.verdicts as { id: string; state: string }[]).map((v) => [
        v.id,
        v.state,
      ]),
    )
    expect(byId['tests/test_x.py::test_wobbles']).toBe('flaky')
    fresh.close()
  })

  it('flake_ingest records a vitest report too (format-discriminated)', async () => {
    const fresh = HistoryStore.memory()
    const client = await connect({ store: fresh })
    const res = await call(client, 'flake_ingest', {
      format: 'vitest',
      report: {
        testResults: [
          {
            name: '/abs/project/src/x.test.ts',
            assertionResults: [{ ancestorTitles: ['x'], title: 'works', status: 'passed' }],
          },
        ],
      },
      at: '2026-06-01T00:00:00Z',
      projectRoot: '/abs/project',
    })
    expect(res.structuredContent?.recorded).toBe(1)
    fresh.close()
  })

  it('registers flake_run only with the paired run gate', async () => {
    const client = await connect({
      store,
      runConfig: { allowRun: true, allowedRoots: ['/abs/project'] },
    })
    expect(await toolNames(client)).toContain('flake_run')
  })

  it('does not register flake_run when the allowlist is empty (load-bearing)', async () => {
    const client = await connect({ store, runConfig: { allowRun: true, allowedRoots: [] } })
    expect(await toolNames(client)).not.toContain('flake_run')
  })

  it('registers flake_quarantine only with the paired quarantine gate', async () => {
    const client = await connect({
      store,
      quarantinePolicy: { allowQuarantine: true, maxExpiryMs: WEEK_MS },
    })
    expect(await toolNames(client)).toContain('flake_quarantine')
  })

  it('flake_status classifies the store', async () => {
    const client = await connect({ store, now: () => NOW })
    const res = await call(client, 'flake_status', {})
    const verdicts = res.structuredContent?.verdicts as { id: string; state: string }[]
    const byId = Object.fromEntries(verdicts.map((v) => [v.id, v.state]))
    expect(byId.flaky).toBe('flaky')
    expect(byId.solid).toBe('reliable')
  })

  it('flake_candidates ranks flaky tests', async () => {
    const client = await connect({ store })
    const res = await call(client, 'flake_candidates', {})
    const ids = (res.structuredContent?.candidates as { id: string }[]).map((c) => c.id)
    expect(ids).toEqual(['flaky'])
  })

  it('flake_quarantine writes through the gate, status reflects it, release lifts it', async () => {
    const client = await connect({
      store,
      now: () => NOW,
      quarantinePolicy: { allowQuarantine: true, maxExpiryMs: WEEK_MS },
    })
    const q = await call(client, 'flake_quarantine', {
      testId: 'flaky',
      reason: 'fails ~50% on CI',
      expiresAt: '2026-06-03T00:00:00Z',
      flakeScore: 0.2,
    })
    expect((q.structuredContent?.entry as { testId: string }).testId).toBe('flaky')

    const status = await call(client, 'flake_status', {})
    expect((status.structuredContent?.quarantined as { testId: string }[])[0]?.testId).toBe('flaky')

    const rel = await call(client, 'flake_release', { testId: 'flaky' })
    expect(rel.structuredContent?.released).toBe(true)
    const after = await call(client, 'flake_status', {})
    expect(after.structuredContent?.quarantined).toEqual([])
  })

  it('flake_run records via the injected runner and reports flaky', async () => {
    const fresh = HistoryStore.memory()
    const runner: TestRunner = async (argv) => {
      const out = argv.find((a) => a.startsWith('--outputFile='))?.slice('--outputFile='.length)
      const passed = (runner as unknown as { i: number }).i++ % 2 === 1
      const report = {
        testResults: [
          {
            name: '/abs/project/src/x.test.ts',
            assertionResults: [
              { ancestorTitles: ['x'], title: 'wobbles', status: passed ? 'passed' : 'failed' },
            ],
          },
        ],
      }
      if (out) writeFileSync(out, JSON.stringify(report))
      return { exitCode: passed ? 0 : 1, stdout: '', stderr: '' }
    }
    ;(runner as unknown as { i: number }).i = 0

    const client = await connect({
      store: fresh,
      runConfig: { allowRun: true, allowedRoots: ['/abs/project'] },
      runner,
    })
    const res = await call(client, 'flake_run', {
      projectRoot: '/abs/project',
      repeat: 3,
    })
    expect(res.structuredContent?.recorded).toBe(3)
    const verdicts = res.structuredContent?.verdicts as { id: string; state: string }[]
    expect(verdicts.find((v) => v.id === 'src/x.test.ts > x > wobbles')?.state).toBe('flaky')
    fresh.close()
  })
})
