import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ArtifactStore } from '@sackville/artifacts'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BuiltVerifyServer, buildVerifyServerFromEnv } from './bin-verify.js'

const API_SAMPLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../api/test/fixtures/sample',
)

async function toolNames(built: BuiltVerifyServer): Promise<string[]> {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([built.server.connect(st), c.connect(ct)])
  const { tools } = await c.listTools()
  return tools.map((t) => t.name)
}

describe('sackville-verify-mcp bin config (operator env)', () => {
  it('defaults to compose-only: no artifacts root, capture off, run-driving off', () => {
    expect(buildVerifyServerFromEnv({}).config).toEqual({
      artifactsRoot: undefined,
      allowCapture: false,
      enableRun: false,
    })
  })

  it('reads the shared artifacts root + the capture gate', () => {
    const { config } = buildVerifyServerFromEnv({
      SACKVILLE_ARTIFACTS_ROOT: '/tmp/sackville-artifacts',
      SACKVILLE_VERIFY_ALLOW_CAPTURE: '1',
    })
    expect(config.artifactsRoot).toBe('/tmp/sackville-artifacts')
    expect(config.allowCapture).toBe(true)
  })
})

describe('the "both required" run-driving gate (§3c / §gate(b))', () => {
  it('per-pillar *_ALLOW_RUN envs are IGNORED without the explicit ENABLE_RUN opt-in', async () => {
    // The §3c guard, strengthened: setting the pillar SERVERS' grants must NOT silently
    // enable the verify server to drive runs. With ENABLE_RUN unset, verify_change is
    // not even registered, and the config carries no per-pillar run flag.
    const built = buildVerifyServerFromEnv({
      SACKVILLE_COVERAGE_ALLOW_RUN: '1',
      SACKVILLE_COVERAGE_PROJECT_ROOTS: '/repo',
      SACKVILLE_FLAKE_ALLOW_RUN: '1',
      SACKVILLE_MUTATE_ALLOW_RUN: '1',
    })
    expect(built.config).toEqual({
      artifactsRoot: undefined,
      allowCapture: false,
      enableRun: false,
    })
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN alone (no pillar gate satisfied) does NOT register verify_change', async () => {
    const built = buildVerifyServerFromEnv({ SACKVILLE_VERIFY_ENABLE_RUN: '1' })
    expect(built.config.enableRun).toBe(true)
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN + a pillar whose OWN gate is satisfied registers verify_change', async () => {
    const built = buildVerifyServerFromEnv({
      SACKVILLE_VERIFY_ENABLE_RUN: '1',
      SACKVILLE_COVERAGE_ALLOW_RUN: '1',
      SACKVILLE_COVERAGE_PROJECT_ROOTS: '/repo',
    })
    expect(await toolNames(built)).toContain('verify_change')
  })

  it('ENABLE_RUN + a pillar ALLOW_RUN but EMPTY roots does NOT wire it (deny-by-default)', async () => {
    // allowRun without an allowlisted root is not a satisfied gate.
    const built = buildVerifyServerFromEnv({
      SACKVILLE_VERIFY_ENABLE_RUN: '1',
      SACKVILLE_COVERAGE_ALLOW_RUN: '1',
      // no SACKVILLE_COVERAGE_PROJECT_ROOTS
    })
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN + SACKVILLE_DEPS_ALLOW_NETWORK wires deps run-driving (registers verify_change)', async () => {
    const built = buildVerifyServerFromEnv({
      SACKVILLE_VERIFY_ENABLE_RUN: '1',
      SACKVILLE_DEPS_ALLOW_NETWORK: '1',
    })
    expect(await toolNames(built)).toContain('verify_change')
  })

  it('SACKVILLE_DEPS_ALLOW_NETWORK alone (no ENABLE_RUN) does NOT wire deps run-driving', async () => {
    // The deps network grant for the deps SERVER must not silently enable THIS server to
    // drive a deps audit — that needs the separate ENABLE_RUN opt-in (compose, never widen).
    const built = buildVerifyServerFromEnv({ SACKVILLE_DEPS_ALLOW_NETWORK: '1' })
    expect(built.config.enableRun).toBe(false)
    expect(await toolNames(built)).not.toContain('verify_change')
  })

  it('ENABLE_RUN + the capture gate registers verify_change for the consume-only contract path', async () => {
    const built = buildVerifyServerFromEnv({
      SACKVILLE_VERIFY_ENABLE_RUN: '1',
      SACKVILLE_ARTIFACTS_ROOT: '/tmp/sackville-artifacts',
      SACKVILLE_VERIFY_ALLOW_CAPTURE: '1',
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
    SACKVILLE_VERIFY_ENABLE_RUN: '1',
    SACKVILLE_ARTIFACTS_ROOT: '/tmp/sackville-artifacts-5e',
    SACKVILLE_VERIFY_ALLOW_CAPTURE: '1',
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
      SACKVILLE_BROWSER_ALLOWED_HOSTS: 'app.test',
      SACKVILLE_BROWSER_HAR_DIR: '/tmp/har',
      SACKVILLE_BROWSER_FLOWS_DIR: '/tmp/flows',
    })
    expect(await toolNames(built)).toContain('verify_change')
  })
})

describe('5f produce-api capture — the api pillar gate composes on top', () => {
  let server: Server
  let baseUrl: string
  let artifactsRoot: string
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    artifactsRoot = mkdtempSync(join(tmpdir(), 'sackville-verify-5f-'))
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  async function call(env: Record<string, string>, args: Record<string, unknown>) {
    const built = buildVerifyServerFromEnv(env)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([built.server.connect(st), c.connect(ct)])
    return c.callTool({ name: 'verify_change', arguments: { projectRoot: '/repo', ...args } })
  }

  const baseEnv = () => ({
    SACKVILLE_VERIFY_ENABLE_RUN: '1',
    SACKVILLE_ARTIFACTS_ROOT: artifactsRoot,
    SACKVILLE_VERIFY_ALLOW_CAPTURE: '1',
  })

  it('gate-denies a produce-api request (no fetch) when SACKVILLE_API_COLLECTIONS_DIR is unset', async () => {
    const res = await call(baseEnv(), {
      pillars: ['contract'],
      contract: { request: 'get-health' },
    })
    const sc = res.structuredContent as {
      status: string
      pillars: { pillar: string; status: string; skipReason?: string }[]
    }
    expect(sc.pillars.find((p) => p.pillar === 'contract')).toMatchObject({
      status: 'no-signal',
      skipReason: 'gate-not-set',
    })
    expect(sc.status).toBe('inconclusive')
  })

  it('a MUTATING request without SACKVILLE_ALLOW_UNSAFE dry-runs ⇒ inconclusive (no HAR, no fetch)', async () => {
    const res = await call(
      { ...baseEnv(), SACKVILLE_API_COLLECTIONS_DIR: API_SAMPLE },
      { pillars: ['contract'], contract: { request: 'create-thing', vars: { baseUrl } } },
    )
    const sc = res.structuredContent as {
      status: string
      pillars: { pillar: string; status: string; errorReason?: string }[]
      capture?: unknown
    }
    const contract = sc.pillars.find((p) => p.pillar === 'contract')
    expect(contract?.status).toBe('no-signal') // the driver threw (withheld) ⇒ errored no-signal
    expect(sc.status).toBe('inconclusive')
    expect(sc.capture).toBeUndefined() // nothing produced
  })

  it('drives a safe GET, produces + validates a stored HAR, surfaces the handle (loopback)', async () => {
    const res = await call(
      {
        ...baseEnv(),
        SACKVILLE_API_COLLECTIONS_DIR: API_SAMPLE,
        SACKVILLE_ALLOWED_HOSTS: '127.0.0.1',
      },
      {
        pillars: ['contract'],
        contract: {
          request: 'get-health',
          vars: { baseUrl },
          openapiSpec: {
            openapi: '3.1.0',
            paths: {
              '/health': {
                get: {
                  responses: {
                    '200': { content: { 'application/json': { schema: { type: 'object' } } } },
                  },
                },
              },
            },
          },
        },
      },
    )
    const sc = res.structuredContent as {
      pillars: { pillar: string; status: string }[]
      capture?: { harHandle: string }
    }
    expect(sc.pillars.find((p) => p.pillar === 'contract')?.status).toBe('pass')
    expect(sc.capture?.harHandle).toMatch(/^sackville:\/\/verify\/.+\/har$/)
    // The produced HAR is stored + resolvable, and carries the real captured exchange.
    const har = new ArtifactStore(artifactsRoot, 'verify').get(sc.capture?.harHandle ?? '')?.body
    expect(har).toBeDefined()
    const harJson = Object.entries(unzipSync(new Uint8Array(har as Buffer))).find(([n]) =>
      n.endsWith('.har'),
    )
    expect(strFromU8(harJson?.[1] as Uint8Array)).toContain('/health')
  })
})
