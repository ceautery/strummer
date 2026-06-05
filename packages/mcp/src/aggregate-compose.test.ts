import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { buildAggregateServer, type PillarRegistry, parseToolsets } from './aggregate.js'

// Composition guards (ADR 0019 §A — selection, dynamic-load isolation, lifecycle).
// A FAKE registry lets us prove the composition logic (only enabled pillars are
// loaded; teardown fires) without importing any real heavy engine.

/** A fake pillar that registers one uniquely-named tool + an optional shutdown spy. */
function fakePillar(
  name: string,
  isDefault: boolean,
  calls: string[],
  opts: { shutdown?: () => void; fail?: 'module' | 'fatal'; disable?: boolean } = {},
) {
  return {
    default: isDefault,
    pkg: `@strummer/${name}`,
    load: async () => {
      calls.push(name)
      if (opts.fail === 'module') {
        throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' })
      }
      return () => {
        if (opts.fail === 'fatal') throw new Error('contradictory gate')
        if (opts.disable) return undefined
        return {
          register: (server: McpServer) =>
            server.registerTool(`fake_${name}`, { description: name }, async () => ({
              content: [{ type: 'text' as const, text: 'ok' }],
            })),
          shutdown: opts.shutdown,
        }
      }
    },
  }
}

function makeRegistry(
  calls: string[],
  overrides: Record<string, Parameters<typeof fakePillar>[3]> = {},
): PillarRegistry {
  const defaults = ['docs', 'api', 'deps', 'verify']
  const all = [...defaults, 'browser', 'coverage', 'flake', 'lsp', 'mutate']
  const reg: PillarRegistry = {}
  for (const n of all) reg[n] = fakePillar(n, defaults.includes(n), calls, overrides[n] ?? {})
  return reg
}

async function listToolNames(server: McpServer): Promise<string[]> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([client.connect(clientT), server.connect(serverT)])
  const { tools } = await client.listTools()
  await client.close()
  return tools.map((t) => t.name).sort()
}

describe('parseToolsets — subtractive selection (ADR 0019 §A)', () => {
  const reg = makeRegistry([])

  it('unset ⇒ the curated read-heavy default set', () => {
    expect(parseToolsets(undefined, reg).sort()).toEqual(['api', 'deps', 'docs', 'verify'])
    expect(parseToolsets('  ', reg).sort()).toEqual(['api', 'deps', 'docs', 'verify'])
  })

  it('set ⇒ exactly the named pillars (a subset, dedup, trimmed)', () => {
    expect(parseToolsets('api, deps ,api', reg)).toEqual(['api', 'deps'])
    expect(parseToolsets('lsp', reg)).toEqual(['lsp'])
  })

  it('throws (loud) on an unknown name — typo protection, never silently ignored', () => {
    expect(() => parseToolsets('api,nope', reg)).toThrow(/unknown STRUMMER_TOOLSETS/)
  })
})

describe('buildAggregateServer — composition + dynamic-load isolation (ADR 0019 §A)', () => {
  it('loads + registers ONLY the enabled pillars (others never imported)', async () => {
    const calls: string[] = []
    const { server, enabled } = await buildAggregateServer(
      { STRUMMER_TOOLSETS: 'api,deps' },
      { registry: makeRegistry(calls), log: () => {} },
    )
    expect(enabled.sort()).toEqual(['api', 'deps'])
    expect(calls.sort()).toEqual(['api', 'deps']) // browser/flake/etc. NEVER loaded
    expect(await listToolNames(server)).toEqual(['fake_api', 'fake_deps'])
  })

  it('unset toolsets ⇒ the curated default registers', async () => {
    const calls: string[] = []
    const { enabled } = await buildAggregateServer(
      {},
      { registry: makeRegistry(calls), log: () => {} },
    )
    expect(enabled.sort()).toEqual(['api', 'deps', 'docs', 'verify'])
  })
})

describe('buildAggregateServer — isolation: loud-disable vs fatal (ADR 0019 §A7/§9)', () => {
  it('a MISSING engine (module-not-found) ⇒ loud disable, server still starts', async () => {
    const calls: string[] = []
    const logs: string[] = []
    const { server, enabled, disabled } = await buildAggregateServer(
      { STRUMMER_TOOLSETS: 'api,browser' },
      { registry: makeRegistry(calls, { browser: { fail: 'module' } }), log: (m) => logs.push(m) },
    )
    expect(enabled).toEqual(['api'])
    expect(disabled).toEqual([
      { pillar: 'browser', reason: 'engine not installed (@strummer/browser)' },
    ])
    expect(logs.join('\n')).toMatch(/browser.*disabled.*not installed/)
    expect(await listToolNames(server)).toEqual(['fake_api'])
  })

  it('a pillar returning undefined (e.g. docs with no index) ⇒ loud disable', async () => {
    const { enabled, disabled } = await buildAggregateServer(
      { STRUMMER_TOOLSETS: 'docs,api' },
      { registry: makeRegistry([], { docs: { disable: true } }), log: () => {} },
    )
    expect(enabled).toEqual(['api'])
    expect(disabled).toEqual([{ pillar: 'docs', reason: 'no STRUMMER_INDEX configured' }])
  })

  it('a CONTRADICTORY gate (setup throws) ⇒ FATAL, never swallowed', async () => {
    await expect(
      buildAggregateServer(
        { STRUMMER_TOOLSETS: 'api,lsp' },
        { registry: makeRegistry([], { lsp: { fail: 'fatal' } }), log: () => {} },
      ),
    ).rejects.toThrow(/contradictory gate/)
  })
})

describe('buildAggregateServer — lifecycle (ADR 0019 §A13)', () => {
  it('collects every enabled pillar shutdown and runs them all', async () => {
    const apiDown = vi.fn()
    const verifyDown = vi.fn()
    const { shutdown } = await buildAggregateServer(
      { STRUMMER_TOOLSETS: 'api,verify' },
      {
        registry: makeRegistry([], {
          api: { shutdown: apiDown },
          verify: { shutdown: verifyDown },
        }),
        log: () => {},
      },
    )
    await shutdown()
    expect(apiDown).toHaveBeenCalledOnce()
    expect(verifyDown).toHaveBeenCalledOnce()
  })

  it('a throwing shutdown does not stop the others (best-effort teardown)', async () => {
    const good = vi.fn()
    const { shutdown } = await buildAggregateServer(
      { STRUMMER_TOOLSETS: 'api,verify' },
      {
        registry: makeRegistry([], {
          api: {
            shutdown: () => {
              throw new Error('boom')
            },
          },
          verify: { shutdown: good },
        }),
        log: () => {},
      },
    )
    await expect(shutdown()).resolves.toBeUndefined()
    expect(good).toHaveBeenCalledOnce()
  })
})
