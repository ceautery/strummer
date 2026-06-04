import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { type BuiltVerifyServer, buildVerifyServerFromEnv } from './bin-verify.js'

async function toolNames(built: BuiltVerifyServer): Promise<string[]> {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([built.server.connect(st), c.connect(ct)])
  const { tools } = await c.listTools()
  return tools.map((t) => t.name)
}

describe('strummer-verify-mcp bin config (operator env)', () => {
  it('defaults to compose-only: no artifacts root, capture off, run-driving off', () => {
    expect(buildVerifyServerFromEnv({}).config).toEqual({
      artifactsRoot: undefined,
      allowCapture: false,
      enableRun: false,
    })
  })

  it('reads the shared artifacts root + the capture gate', () => {
    const { config } = buildVerifyServerFromEnv({
      STRUMMER_ARTIFACTS_ROOT: '/tmp/strummer-artifacts',
      STRUMMER_VERIFY_ALLOW_CAPTURE: '1',
    })
    expect(config.artifactsRoot).toBe('/tmp/strummer-artifacts')
    expect(config.allowCapture).toBe(true)
  })
})

describe('the "both required" run-driving gate (§3c / §gate(b))', () => {
  it('per-pillar *_ALLOW_RUN envs are IGNORED without the explicit ENABLE_RUN opt-in', async () => {
    // The §3c guard, strengthened: setting the pillar SERVERS' grants must NOT silently
    // enable the verify server to drive runs. With ENABLE_RUN unset, verify_change is
    // not even registered, and the config carries no per-pillar run flag.
    const built = buildVerifyServerFromEnv({
      STRUMMER_COVERAGE_ALLOW_RUN: '1',
      STRUMMER_COVERAGE_PROJECT_ROOTS: '/repo',
      STRUMMER_FLAKE_ALLOW_RUN: '1',
      STRUMMER_MUTATE_ALLOW_RUN: '1',
    })
    expect(built.config).toEqual({
      artifactsRoot: undefined,
      allowCapture: false,
      enableRun: false,
    })
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN alone (no pillar gate satisfied) does NOT register verify_change', async () => {
    const built = buildVerifyServerFromEnv({ STRUMMER_VERIFY_ENABLE_RUN: '1' })
    expect(built.config.enableRun).toBe(true)
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN + a pillar whose OWN gate is satisfied registers verify_change', async () => {
    const built = buildVerifyServerFromEnv({
      STRUMMER_VERIFY_ENABLE_RUN: '1',
      STRUMMER_COVERAGE_ALLOW_RUN: '1',
      STRUMMER_COVERAGE_PROJECT_ROOTS: '/repo',
    })
    expect(await toolNames(built)).toContain('verify_change')
  })

  it('ENABLE_RUN + a pillar ALLOW_RUN but EMPTY roots does NOT wire it (deny-by-default)', async () => {
    // allowRun without an allowlisted root is not a satisfied gate.
    const built = buildVerifyServerFromEnv({
      STRUMMER_VERIFY_ENABLE_RUN: '1',
      STRUMMER_COVERAGE_ALLOW_RUN: '1',
      // no STRUMMER_COVERAGE_PROJECT_ROOTS
    })
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN + STRUMMER_DEPS_ALLOW_NETWORK wires deps run-driving (registers verify_change)', async () => {
    const built = buildVerifyServerFromEnv({
      STRUMMER_VERIFY_ENABLE_RUN: '1',
      STRUMMER_DEPS_ALLOW_NETWORK: '1',
    })
    expect(await toolNames(built)).toContain('verify_change')
  })

  it('STRUMMER_DEPS_ALLOW_NETWORK alone (no ENABLE_RUN) does NOT wire deps run-driving', async () => {
    // The deps network grant for the deps SERVER must not silently enable THIS server to
    // drive a deps audit — that needs the separate ENABLE_RUN opt-in (compose, never widen).
    const built = buildVerifyServerFromEnv({ STRUMMER_DEPS_ALLOW_NETWORK: '1' })
    expect(built.config.enableRun).toBe(false)
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN + the capture gate registers verify_change for the consume-only contract path', async () => {
    const built = buildVerifyServerFromEnv({
      STRUMMER_VERIFY_ENABLE_RUN: '1',
      STRUMMER_ARTIFACTS_ROOT: '/tmp/strummer-artifacts',
      STRUMMER_VERIFY_ALLOW_CAPTURE: '1',
    })
    expect(await toolNames(built)).toContain('verify_change')
  })
})

describe('5e live-capture (produce) gate — the full browser gate composes on top', () => {
  async function call(env: Record<string, string>, args: Record<string, unknown>) {
    const built = buildVerifyServerFromEnv(env)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([built.server.connect(st), c.connect(ct)])
    return c.callTool({ name: 'verify_change', arguments: { projectRoot: '/repo', ...args } })
  }

  const CAPTURE_ENV = {
    STRUMMER_VERIFY_ENABLE_RUN: '1',
    STRUMMER_ARTIFACTS_ROOT: '/tmp/strummer-artifacts-5e',
    STRUMMER_VERIFY_ALLOW_CAPTURE: '1',
  }

  it('a PRODUCE request is gate-denied (no spawn) when the browser gate is unmet', async () => {
    // ENABLE_RUN + capture gate are set, but NOT the browser gate (hosts/HAR/flows), so a
    // live-capture request must NOT spawn — it surfaces skipReason:'gate-not-set' ⇒ inconclusive.
    const res = await call(CAPTURE_ENV, { contract: { flow: 'login' } })
    const sc = res.structuredContent as {
      status: string
      ok: boolean
      pillars: { pillar: string; status: string; skipReason?: string }[]
    }
    const contract = sc.pillars.find((p) => p.pillar === 'contract')
    expect(contract).toMatchObject({ status: 'no-signal', skipReason: 'gate-not-set' })
    expect(sc.status).toBe('inconclusive')
    expect(sc.ok).toBe(false)
  })

  it('registers verify_change with the full produce gate set (hosts + HAR + flows)', async () => {
    const built = buildVerifyServerFromEnv({
      ...CAPTURE_ENV,
      STRUMMER_BROWSER_ALLOWED_HOSTS: 'app.test',
      STRUMMER_BROWSER_HAR_DIR: '/tmp/har',
      STRUMMER_BROWSER_FLOWS_DIR: '/tmp/flows',
    })
    expect(await toolNames(built)).toContain('verify_change')
  })
})
