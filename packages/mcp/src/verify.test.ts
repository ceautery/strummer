import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
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
