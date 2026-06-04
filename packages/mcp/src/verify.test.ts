import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { createVerifyServer, type VerifyToolsOptions } from './verify.js'

async function connect(opts: VerifyToolsOptions = {}): Promise<Client> {
  const server = createVerifyServer(opts)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(st), c.connect(ct)])
  return c
}

const contractError = {
  valid: false,
  findings: [{ kind: 'response-schema', message: 'must be integer', severity: 'error' }],
}

describe('request_verdict (ADR 0013 slice 10)', () => {
  it('an empty fold is inconclusive (ok:false), never pass', async () => {
    const c = await connect()
    const res = await c.callTool({ name: 'request_verdict', arguments: {} })
    const sc = res.structuredContent as { ok: boolean; status: string; missing: string[] }
    expect(sc.ok).toBe(false)
    expect(sc.status).toBe('inconclusive')
    expect(sc.missing).toHaveLength(5)
  })

  it('a contract error fails the verdict; failAtOrAbove threads with no baked-in default', async () => {
    const c = await connect()
    // A deps moderate vuln alone stays `warn` without a policy...
    const deps = {
      audits: [{ worstSeverity: 'moderate', deprecated: { isDeprecated: false } }],
      osvSnapshotLoaded: true,
    }
    const warnRes = await c.callTool({ name: 'request_verdict', arguments: { deps } })
    expect((warnRes.structuredContent as { status: string }).status).toBe('warn')

    // ...and fails when the caller declares the cut.
    const failRes = await c.callTool({
      name: 'request_verdict',
      arguments: { deps, failAtOrAbove: 'moderate' },
    })
    expect((failRes.structuredContent as { status: string }).status).toBe('fail')

    // A contract error fails regardless of policy.
    const contractRes = await c.callTool({
      name: 'request_verdict',
      arguments: { contract: { results: [contractError], source: 'capture-from-HAR' } },
    })
    const sc = contractRes.structuredContent as { status: string; worstPillar: string }
    expect(sc.status).toBe('fail')
    expect(sc.worstPillar).toBe('contract')
  })

  it('stores the full verdict by handle and serves it via the resource', async () => {
    const store = new Map<string, string>()
    const c = await connect({
      storeVerdict: (id, kind, body) => {
        const handle = `strummer://verify/${id}/${kind}`
        store.set(handle, body)
        return handle
      },
      resolveVerdict: (handle) => {
        const body = store.get(handle)
        return body ? { contentType: 'application/json', body: Buffer.from(body) } : undefined
      },
    })
    const res = await c.callTool({
      name: 'request_verdict',
      arguments: { contract: { results: [contractError] } },
    })
    const handle = (res.structuredContent as { detailHandle: string }).detailHandle
    expect(handle).toMatch(/^strummer:\/\/verify\/.+\/verdict$/)
    const resource = await c.readResource({ uri: handle })
    const first = resource.contents[0] as { text: string }
    expect(JSON.parse(first.text).status).toBe('fail')
  })
})

const uncoveredReport = {
  files: [],
  uncovered: [{ path: 'a.ts', line: 10 }],
  summary: { covered: 0, uncovered: 1, nonExecutable: 0, total: 1, filesWithoutCoverage: 0 },
}
const cleanAudit = { worstSeverity: 'none', deprecated: { isDeprecated: false } }

async function listToolNames(c: Client): Promise<string[]> {
  const { tools } = await c.listTools()
  return tools.map((t) => t.name)
}

type Pillars = NonNullable<VerifyToolsOptions['runDriving']>

describe('verify_change — run-driving orchestration (slice 4)', () => {
  it('is NOT registered without run-driving wired (deny-by-default registration)', async () => {
    const c = await connect()
    expect(await listToolNames(c)).not.toContain('verify_change')
    expect(await listToolNames(c)).toContain('request_verdict')
  })

  it('is registered once ≥1 pillar runner is wired', async () => {
    const c = await connect({
      runDriving: { deps: async () => ({ audits: [], osvSnapshotLoaded: true }) },
    })
    expect(await listToolNames(c)).toContain('verify_change')
  })

  it('drives the wired pillars and folds them into one verdict', async () => {
    const runDriving: Pillars = {
      coverage: async () => uncoveredReport as never,
      deps: async () => ({ audits: [cleanAudit as never], osvSnapshotLoaded: true }),
    }
    const c = await connect({ runDriving })
    const res = await c.callTool({
      name: 'verify_change',
      arguments: { projectRoot: '/repo', changedFiles: ['a.ts'] },
    })
    const sc = res.structuredContent as {
      status: string
      worstPillar: string
      pillars: { pillar: string; status: string }[]
    }
    expect(sc.status).toBe('fail') // coverage uncovered line dominates
    expect(sc.worstPillar).toBe('coverage')
    expect(sc.pillars.find((p) => p.pillar === 'deps')?.status).toBe('pass')
    // flake/mutate were not wired and not requested ⇒ missing (not skipped)
    expect(sc.pillars.find((p) => p.pillar === 'flake')?.status).toBe('missing')
  })

  it('an explicitly-requested but UNWIRED pillar is skipped:gate-not-set, never run', async () => {
    const coverage = vi.fn() // wired? no — only deps is wired
    const c = await connect({
      runDriving: {
        deps: async () => ({ audits: [cleanAudit as never], osvSnapshotLoaded: true }),
      },
    })
    const res = await c.callTool({
      name: 'verify_change',
      arguments: { projectRoot: '/repo', pillars: ['deps', 'coverage'] },
    })
    const sc = res.structuredContent as {
      status: string
      ok: boolean
      pillars: { pillar: string; status: string; skipReason?: string }[]
    }
    const cov = sc.pillars.find((p) => p.pillar === 'coverage')
    expect(cov).toMatchObject({ status: 'no-signal', skipReason: 'gate-not-set' })
    expect(coverage).not.toHaveBeenCalled()
    expect(sc.ok).toBe(false)
    expect(sc.status).toBe('inconclusive') // deps pass + coverage gate-not-set ⇒ inconclusive
  })

  it('folds the consume contract sub-verdict from a HAR handle (mode:consume)', async () => {
    const contract = vi.fn(async (ctx: { mode: string; harHandle?: string }) => {
      expect(ctx.mode).toBe('consume')
      expect(ctx.harHandle).toBe('strummer://browser/run/x/har')
      return { results: [contractError as never] }
    })
    const c = await connect({ runDriving: { contract } })
    const res = await c.callTool({
      name: 'verify_change',
      arguments: {
        projectRoot: '/repo',
        contract: { harHandle: 'strummer://browser/run/x/har' },
      },
    })
    const sc = res.structuredContent as {
      status: string
      pillars: { pillar: string; status: string; source?: string }[]
    }
    expect(contract).toHaveBeenCalledOnce()
    expect(sc.pillars.find((p) => p.pillar === 'contract')).toMatchObject({
      status: 'fail',
      source: 'capture-from-HAR',
    })
    expect(sc.status).toBe('fail')
  })

  it('drives a PRODUCE capture (flow/vars) and SURFACES the stored HAR handle (5e slice 7)', async () => {
    const contract = vi.fn(async (ctx: { mode: string; flow?: string; vars?: unknown }) => {
      expect(ctx.mode).toBe('produce')
      expect(ctx.flow).toBe('login')
      expect(ctx.vars).toEqual({ user: 'alice' })
      // produce mode returns the contract results + the stored HAR handle for auditability
      return {
        results: [contractError as never],
        harHandle: 'strummer://verify/cap-9/har',
        summary: { handle: 'strummer://verify/cap-9/har', byteSize: 5, entryCount: 2 } as never,
      }
    })
    const c = await connect({ runDriving: { contract } })
    const res = await c.callTool({
      name: 'verify_change',
      arguments: {
        projectRoot: '/repo',
        contract: { flow: 'login', vars: { user: 'alice' } },
      },
    })
    const sc = res.structuredContent as {
      status: string
      capture?: { harHandle: string; summary?: { entryCount: number } }
    }
    expect(contract).toHaveBeenCalledOnce()
    expect(sc.status).toBe('fail') // the contract error dominates
    expect(sc.capture?.harHandle).toBe('strummer://verify/cap-9/har') // surfaced for audit
    expect(sc.capture?.summary?.entryCount).toBe(2)
  })

  it('derives changedFiles from a diff so one diff scopes the file-scoped pillars (slice 5d-3)', async () => {
    let seen: string[] | undefined
    const c = await connect({
      runDriving: {
        coverage: async (ctx) => {
          seen = ctx.changedFiles
          return uncoveredReport as never
        },
      },
    })
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1,2 @@
 a
+b
diff --git a/src/y.ts b/src/y.ts
--- a/src/y.ts
+++ b/src/y.ts
@@ -1 +1,2 @@
 c
+d
`
    await c.callTool({ name: 'verify_change', arguments: { projectRoot: '/repo', diff } })
    expect(seen).toEqual(['src/x.ts', 'src/y.ts'])
  })

  it('an explicit changedFiles wins over the diff-derived set', async () => {
    let seen: string[] | undefined
    const c = await connect({
      runDriving: {
        coverage: async (ctx) => {
          seen = ctx.changedFiles
          return uncoveredReport as never
        },
      },
    })
    const diff = `--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1,2 @@
 a
+b
`
    await c.callTool({
      name: 'verify_change',
      arguments: { projectRoot: '/repo', changedFiles: ['explicit.ts'], diff },
    })
    expect(seen).toEqual(['explicit.ts'])
  })

  it('stores the run-driven verdict by handle', async () => {
    const store = new Map<string, string>()
    const c = await connect({
      runDriving: {
        deps: async () => ({ audits: [cleanAudit as never], osvSnapshotLoaded: true }),
      },
      storeVerdict: (id, kind, body) => {
        const handle = `strummer://verify/${id}/${kind}`
        store.set(handle, body)
        return handle
      },
    })
    const res = await c.callTool({
      name: 'verify_change',
      arguments: { projectRoot: '/repo' },
    })
    const handle = (res.structuredContent as { detailHandle: string }).detailHandle
    expect(handle).toMatch(/^strummer:\/\/verify\/.+\/verdict$/)
    expect(store.has(handle)).toBe(true)
  })
})
