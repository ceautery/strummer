import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerSpawn } from './client.js'
import { LanguageServerManager, LspManagerError } from './manager.js'
import { DEFINITION, type FakeServerOptions, fakeServer, makePeerPair } from './peer.js'
import { parseServerRegistry } from './registry.js'

const REGISTRY = parseServerRegistry(
  JSON.stringify({ typescript: { command: 'tsls', args: ['--stdio'] } }),
)
const ROOT = '/project'
const INPUT = {
  language: 'typescript',
  projectRoot: ROOT,
  uri: 'file:///project/src/index.ts',
  text: 'const a = 1',
}

const flush = () => new Promise((r) => setImmediate(r))

const disposers: Array<() => void> = []

interface SpawnRecord {
  disposed: boolean
}

/** A `ServerSpawn` that returns a fresh in-process fake peer per spawn, tracking disposal. */
function makeSpawn(opts: FakeServerOptions = {}): { spawn: ServerSpawn; spawns: SpawnRecord[] } {
  const spawns: SpawnRecord[] = []
  const spawn: ServerSpawn = () => {
    const { client, server, dispose } = makePeerPair()
    disposers.push(dispose)
    fakeServer(server, opts)
    const rec: SpawnRecord = { disposed: false }
    spawns.push(rec)
    return {
      connection: client,
      dispose: () => {
        rec.disposed = true
        dispose()
      },
    }
  }
  return { spawn, spawns }
}

function makeManager(spawn: ServerSpawn, overrides: Record<string, unknown> = {}) {
  let t = 0
  const mgr = new LanguageServerManager({
    registry: REGISTRY,
    serverSpawn: spawn,
    allowedRoots: [ROOT],
    timeoutMs: 1000,
    idleTtlMs: 1000,
    shutdownGraceMs: 50,
    noRetry: true,
    now: () => t,
    delay: async (ms: number) => {
      t += ms
    },
    ...overrides,
  })
  return { mgr }
}

afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

describe('LanguageServerManager lifecycle', () => {
  it('spawns + initializes a server once and reuses it across calls (shared, lazy)', async () => {
    const { spawn, spawns } = makeSpawn({ onDefinition: () => DEFINITION() })
    const { mgr } = makeManager(spawn)
    const r1 = await mgr.run(INPUT, (c) => c.definition(INPUT.uri, { line: 0, character: 6 }))
    const r2 = await mgr.run(INPUT, (c) => c.definition(INPUT.uri, { line: 0, character: 6 }))
    expect(r1.status).toBe('ok')
    expect(r2.status).toBe('ok')
    expect(spawns).toHaveLength(1) // shared across calls
    expect(mgr.serverCount).toBe(1)
  })

  it('pins rootUri/workspaceFolders to the projectRoot (agent never supplies a root)', async () => {
    let initParams: { rootUri?: string; workspaceFolders?: Array<{ uri: string }> } | undefined
    const { spawn } = makeSpawn({
      onInitialize: (p) => {
        initParams = p as typeof initParams
      },
    })
    const { mgr } = makeManager(spawn)
    await mgr.run(INPUT, async () => 'ok')
    const expected = pathToFileURL(ROOT).toString()
    expect(initParams?.rootUri).toBe(expected)
    expect(initParams?.workspaceFolders?.[0]?.uri).toBe(expected)
  })

  it('refuses a projectRoot outside the operator allowlist', async () => {
    const { spawn, spawns } = makeSpawn()
    const { mgr } = makeManager(spawn)
    await expect(
      mgr.run({ ...INPUT, projectRoot: '/etc' }, async () => 'x'),
    ).rejects.toBeInstanceOf(LspManagerError)
    expect(spawns).toHaveLength(0) // never spawned
  })

  it('refuses an unbound language (never spawns an unregistered server)', async () => {
    const { spawn, spawns } = makeSpawn()
    const { mgr } = makeManager(spawn)
    await expect(mgr.run({ ...INPUT, language: 'python' }, async () => 'x')).rejects.toThrow(
      /python/i,
    )
    expect(spawns).toHaveLength(0)
  })
})

describe('LanguageServerManager per-(server, uri) mutex', () => {
  it('serializes the open+query critical section for the same uri', async () => {
    const { spawn } = makeSpawn()
    const { mgr } = makeManager(spawn)
    await mgr.run(INPUT, async () => 'warmup') // force spawn+init+cache

    const order: string[] = []
    let release1!: () => void
    const gate1 = new Promise<void>((r) => {
      release1 = r
    })
    const p1 = mgr.run(INPUT, async () => {
      order.push('1-enter')
      await gate1
      order.push('1-exit')
      return 'a'
    })
    const p2 = mgr.run(INPUT, async () => {
      order.push('2-enter')
      return 'b'
    })
    await flush()
    expect(order).toEqual(['1-enter']) // p2 is blocked behind p1 on the mutex
    release1()
    await Promise.all([p1, p2])
    expect(order).toEqual(['1-enter', '1-exit', '2-enter'])
  })
})

describe('LanguageServerManager.runWithUris (multi-uri lock, Slice F′)', () => {
  it('serializes two concurrent multi-uri runs sharing uris, regardless of order (deadlock-free)', async () => {
    const { spawn } = makeSpawn()
    const { mgr } = makeManager(spawn)
    await mgr.run(INPUT, async () => 'warmup') // force spawn+init+cache

    let active = 0
    let maxActive = 0
    const body = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await flush()
      active -= 1
      return 'done'
    }
    const uris = ['file:///project/a.ts', 'file:///project/b.ts']
    const results = await Promise.all([
      mgr.runWithUris({ language: 'typescript', projectRoot: ROOT, uris }, body),
      // reversed input order — the SORTED acquisition still prevents a lock-ordering cycle.
      mgr.runWithUris(
        { language: 'typescript', projectRoot: ROOT, uris: [...uris].reverse() },
        body,
      ),
    ])
    expect(results).toEqual(['done', 'done'])
    expect(maxActive).toBe(1) // never overlapped despite the shared uris
  })
})

describe('LanguageServerManager reaper', () => {
  it('reaps an idle server: shutdown → clock-driven grace → dispose', async () => {
    let shut = false
    const { spawn, spawns } = makeSpawn({
      onShutdown: () => {
        shut = true
      },
    })
    const { mgr } = makeManager(spawn)
    await mgr.run(INPUT, async () => 'x')
    const reaped = await mgr.sweepIdle(5000) // well past idleTtlMs
    expect(reaped).toHaveLength(1)
    expect(shut).toBe(true)
    expect(spawns[0]?.disposed).toBe(true)
    expect(mgr.serverCount).toBe(0)
  })

  it('never reaps a server with an in-flight request, even when idle', async () => {
    const { spawn } = makeSpawn()
    const { mgr } = makeManager(spawn)
    await mgr.run(INPUT, async () => 'warmup')

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const inflight = mgr.run(INPUT, async () => {
      await gate
      return 'x'
    })
    await flush() // the request is now in-flight (inFlight > 0)
    const reaped = await mgr.sweepIdle(5000) // idle by the clock, but in-flight
    expect(reaped).toEqual([])
    expect(mgr.serverCount).toBe(1)
    release()
    await inflight
    // Once it drains, it is reapable again.
    expect(await mgr.sweepIdle(99_999)).toHaveLength(1)
  })
})

describe('LanguageServerManager.describe', () => {
  it('reports live servers with provenance + capability flags (for lsp_languages)', async () => {
    const { spawn } = makeSpawn()
    const { mgr } = makeManager(spawn)
    expect(mgr.describe()).toEqual([]) // none live yet
    await mgr.run(INPUT, async () => 'x')
    const desc = mgr.describe()
    expect(desc).toHaveLength(1)
    expect(desc[0]).toMatchObject({
      language: 'typescript',
      projectRoot: ROOT,
      // default INIT fixture advertises definition/references/hover.
      capabilities: { definition: true, references: true, hover: true },
    })
  })
})

describe('LanguageServerManager.shutdown', () => {
  it('gracefully stops and disposes every server', async () => {
    const { spawn, spawns } = makeSpawn()
    const { mgr } = makeManager(spawn)
    await mgr.run(INPUT, async () => 'x')
    await mgr.shutdown()
    expect(spawns[0]?.disposed).toBe(true)
    expect(mgr.serverCount).toBe(0)
  })
})
