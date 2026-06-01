import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { FileCoverage, TestRunner } from '@strummer/coverage'
import { afterAll, describe, expect, it } from 'vitest'
import { type CoverageToolsOptions, createCoverageServer } from './coverage.js'

const tmpDirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strummer-cov-mcp-'))
  tmpDirs.push(dir)
  return dir
}

const clients: Client[] = []
async function connect(opts: CoverageToolsOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([
    createCoverageServer(opts).connect(serverTransport),
    client.connect(clientTransport),
  ])
  clients.push(client)
  return client
}

afterAll(async () => {
  for (const c of clients) await c.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const mathCoverage = (path: string): Record<string, FileCoverage> => ({
  [path]: {
    path,
    statementMap: {
      '0': { start: { line: 2, column: 2 }, end: { line: 2, column: 9 } },
      '1': { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } },
    },
    s: { '0': 1, '1': 0 },
  },
})

const diff = `--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,5 @@
 const a = 1
+const b = 2
+
+const c = noTest()
 const d = 4
`

describe('coverage MCP surface', () => {
  it('always exposes uncovered_in_diff; gates run_scoped behind the operator', async () => {
    const free = await connect({})
    expect((await free.listTools()).tools.map((t) => t.name)).toEqual(['uncovered_in_diff'])

    const gated = await connect({ allowRun: true, allowedRoots: ['/abs/repo'] })
    expect((await gated.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'run_scoped',
      'uncovered_in_diff',
    ])

    // allowRun without an allowlist must NOT register run_scoped (allowlist load-bearing).
    const half = await connect({ allowRun: true, allowedRoots: [] })
    expect((await half.listTools()).tools.map((t) => t.name)).toEqual(['uncovered_in_diff'])
  })

  it('uncovered_in_diff (inline) returns the executable-but-unhit new lines', async () => {
    const client = await connect({})
    const res = await client.callTool({
      name: 'uncovered_in_diff',
      arguments: {
        diff,
        coverage: mathCoverage('/abs/repo/src/math.ts'),
        projectRoot: '/abs/repo',
      },
    })
    const sc = res.structuredContent as { uncovered: { path: string; line: number }[] }
    expect(sc.uncovered).toEqual([{ path: 'src/math.ts', line: 4 }])
  })

  it('uncovered_in_diff reads coverage from a path', async () => {
    const dir = tmp()
    const covPath = join(dir, 'coverage-final.json')
    writeFileSync(covPath, JSON.stringify(mathCoverage('/abs/repo/src/math.ts')))
    const client = await connect({})
    const res = await client.callTool({
      name: 'uncovered_in_diff',
      arguments: { diff, coveragePath: covPath, projectRoot: '/abs/repo' },
    })
    const sc = res.structuredContent as { summary: { uncovered: number } }
    expect(sc.summary.uncovered).toBe(1)
  })

  it('uncovered_in_diff accepts a coverage.py report via coverageFormat', async () => {
    const pyDiff = `--- a/src/math.py
+++ b/src/math.py
@@ -1,1 +1,4 @@
 def f(x):
+    y = x + 1
+    return y
+    z = never()
`
    const client = await connect({})
    const res = await client.callTool({
      name: 'uncovered_in_diff',
      arguments: {
        diff: pyDiff,
        coverageFormat: 'coveragepy',
        coverage: {
          files: {
            '/abs/repo/src/math.py': {
              executed_lines: [1, 2, 3],
              missing_lines: [4],
              excluded_lines: [],
            },
          },
        },
        projectRoot: '/abs/repo',
      },
    })
    const sc = res.structuredContent as { uncovered: { path: string; line: number }[] }
    expect(sc.uncovered).toEqual([{ path: 'src/math.py', line: 4 }])
  })

  it('run_scoped runs the gated, injected runner and reports the diff coverage', async () => {
    const root = '/abs/repo'
    // Fake runner writes the coverage-final.json runScoped points it at via argv.
    const runner: TestRunner = async (argv) => {
      const dir = argv
        .find((a) => a.startsWith('--coverage.reportsDirectory='))
        ?.split('=')[1] as string
      writeFileSync(
        join(dir, 'coverage-final.json'),
        JSON.stringify(mathCoverage(`${root}/src/math.ts`)),
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const client = await connect({ allowRun: true, allowedRoots: [root], runner })
    const res = await client.callTool({
      name: 'run_scoped',
      arguments: { projectRoot: root, changedFiles: ['src/math.ts'], diff },
    })
    const sc = res.structuredContent as {
      ran: boolean
      passed: boolean
      report: { uncovered: { path: string; line: number }[] }
    }
    expect(sc.ran).toBe(true)
    expect(sc.passed).toBe(true)
    expect(sc.report.uncovered).toEqual([{ path: 'src/math.ts', line: 4 }])
  })

  it('run_scoped errors when the project root is not on the operator allowlist', async () => {
    const client = await connect({
      allowRun: true,
      allowedRoots: ['/allowed'],
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    const res = await client.callTool({
      name: 'run_scoped',
      arguments: { projectRoot: '/not-allowed', changedFiles: ['src/x.ts'] },
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/allowlist/i)
  })
})
