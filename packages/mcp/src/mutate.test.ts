import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { MutationRunner } from '@sackville-mcp/mutate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMutateServer, type MutateToolsOptions } from './mutate.js'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../mutate/test/fixtures/mutation-report.json',
)

async function connect(opts: MutateToolsOptions) {
  const server = createMutateServer(opts)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args }) as Promise<{
    structuredContent?: Record<string, unknown>
  }>
}

let dir: string
let reportPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sackville-mutate-mcp-'))
  reportPath = join(dir, 'mutation.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('mutate MCP surface', () => {
  it('always exposes mutate_summarize; gates mutate_run off by default', async () => {
    const client = await connect({})
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('mutate_summarize')
    expect(names).not.toContain('mutate_run')
  })

  it('registers mutate_run only with allowRun + a non-empty allowlist', async () => {
    const yes = await connect({ allowRun: true, allowedRoots: ['/abs/project'] })
    expect((await yes.listTools()).tools.map((t) => t.name)).toContain('mutate_run')
    const noRoots = await connect({ allowRun: true, allowedRoots: [] })
    expect((await noRoots.listTools()).tools.map((t) => t.name)).not.toContain('mutate_run')
  })

  it('mutate_summarize reads a report by path', async () => {
    const client = await connect({})
    const res = await call(client, 'mutate_summarize', { reportPath: FIXTURE })
    const metrics = res.structuredContent?.metrics as { mutationScore: number }
    expect(metrics.mutationScore).toBeCloseTo(40, 6)
  })

  it('mutate_summarize handles mutmut results text via format=mutmut', async () => {
    const client = await connect({})
    const mutmutText = [
      'calc.x_add__mutmut_1: killed',
      'calc.x_sub__mutmut_1: survived',
      'calc.x_mul__mutmut_1: no tests',
    ].join('\n')
    const res = await call(client, 'mutate_summarize', { report: mutmutText, format: 'mutmut' })
    const sc = res.structuredContent as {
      metrics: { detected: number; mutationScore: number }
      survivors: { mutatorName: string }[]
    }
    expect(sc.metrics.detected).toBe(1) // only the killed mutant
    // valid = detected(1) + undetected(survived 1 + noCoverage 1) = 3 → 1/3.
    expect(sc.metrics.mutationScore).toBeCloseTo((1 / 3) * 100, 6)
    expect(sc.survivors.map((s) => s.mutatorName).sort()).toEqual([
      'calc.x_mul__mutmut_1',
      'calc.x_sub__mutmut_1',
    ])
  })

  it('mutate_run runs the injected runner, scopes, and returns metrics', async () => {
    // The diff scope is existence-checked, so the requested file must exist on disk.
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/math.ts'), 'export const add = (a, b) => a + b\n')
    const runner: MutationRunner = async () => {
      copyFileSync(FIXTURE, reportPath)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const client = await connect({
      allowRun: true,
      allowedRoots: [dir],
      reportPath,
      runner,
    })
    const res = await call(client, 'mutate_run', {
      projectRoot: dir,
      mutateFiles: ['src/math.ts'],
    })
    expect(res.structuredContent?.scopedFiles).toEqual(['src/math.ts'])
    expect((res.structuredContent?.metrics as { detected: number }).detected).toBe(2)
    expect(res.structuredContent?.survivors).toHaveLength(3)
  })

  it('mutate_run cosmic-ray + diff line-scopes the summary to the changed lines', async () => {
    mkdirSync(join(dir, 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'pkg', 'calc.py'), 'def add(a, b):\n    return a + b\n')
    writeFileSync(
      join(dir, 'cosmic-ray.toml'),
      '[cosmic-ray]\nmodule-path = "pkg"\ntimeout = 30.0\nexcluded-modules = []\ntest-command = "x"\n\n[cosmic-ray.distributor]\nname = "local"\n',
    )
    // A survivor on line 1 (out-of-diff) + a killed mutant on line 2 (the changed line).
    const dump = [
      '[{"mutations":[{"module_path":"pkg/calc.py","operator_name":"core/Op","start_pos":[1,5],"end_pos":[1,6]}]},{"worker_outcome":"normal","test_outcome":"survived"}]',
      '[{"mutations":[{"module_path":"pkg/calc.py","operator_name":"core/Op","start_pos":[2,5],"end_pos":[2,6]}]},{"worker_outcome":"normal","test_outcome":"killed"}]',
    ].join('\n')
    const runner: MutationRunner = async (argv) =>
      argv[0] === 'dump'
        ? { exitCode: 0, stdout: dump, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    const client = await connect({ allowRun: true, allowedRoots: [dir], runner })
    const diff =
      '--- a/pkg/calc.py\n+++ b/pkg/calc.py\n@@ -2 +2 @@\n-    return a + b\n+    return a - b\n'
    const res = await call(client, 'mutate_run', {
      projectRoot: dir,
      tool: 'cosmic-ray',
      mutateFiles: ['pkg/calc.py'],
      diff,
    })
    expect(res.structuredContent?.lineScoped).toBe(true)
    // The line-1 survivor is out-of-diff ⇒ excluded; only the killed line-2 mutant counts.
    expect(res.structuredContent?.survivors).toHaveLength(0)
    expect((res.structuredContent?.metrics as { detected: number }).detected).toBe(1)
  })
})
