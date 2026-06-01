import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { MutationRunner } from '@strummer/mutate'
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
  dir = mkdtempSync(join(tmpdir(), 'strummer-mutate-mcp-'))
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
    const runner: MutationRunner = async () => {
      copyFileSync(FIXTURE, reportPath)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const client = await connect({
      allowRun: true,
      allowedRoots: ['/abs/project'],
      reportPath,
      runner,
    })
    const res = await call(client, 'mutate_run', {
      projectRoot: '/abs/project',
      mutateFiles: ['src/math.ts'],
    })
    expect(res.structuredContent?.scopedFiles).toEqual(['src/math.ts'])
    expect((res.structuredContent?.metrics as { detected: number }).detected).toBe(2)
    expect(res.structuredContent?.survivors).toHaveLength(3)
  })
})
