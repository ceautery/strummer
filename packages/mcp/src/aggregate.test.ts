import { readdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import type {
  ApiToolsOptions,
  BrowserToolsOptions,
  CoverageToolsOptions,
  DepsToolsOptions,
  DocsToolsOptions,
  FlakeToolsOptions,
  LspToolsOptions,
  MutateToolsOptions,
  VerifyToolsOptions,
} from './index.js'
import {
  registerApiTools,
  registerBrowserTools,
  registerCoverageTools,
  registerDepsTools,
  registerDocsTools,
  registerFlakeTools,
  registerLspTools,
  registerMutateTools,
  registerVerifyTools,
} from './index.js'

// Aggregate-server architecture guards (ADR 0019, Phase 6).

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Records tool/resource registrations and THROWS on a duplicate name, mirroring
 * `@modelcontextprotocol/sdk` 1.29 (`registerTool`/resource throw hard on a dup).
 * Handlers are never invoked at registration time, so stub opts suffice.
 */
class RecordingServer {
  readonly tools: string[] = []
  readonly resources: string[] = []
  registerTool(name: string) {
    if (this.tools.includes(name)) throw new Error(`Tool ${name} is already registered`)
    this.tools.push(name)
    return {}
  }
  registerResource(name: string) {
    if (this.resources.includes(name)) throw new Error(`Resource ${name} is already registered`)
    this.resources.push(name)
    return {}
  }
}

/** Register all nine pillars onto one server with opts that maximize the tool set. */
function registerAllPillars(server: McpServer): void {
  registerDocsTools(server, { db: {} } as unknown as DocsToolsOptions)
  registerApiTools(server, {
    allowUnsafe: true,
    allowedHosts: ['example.test'],
    allowCapture: true,
    resolveHar: () => undefined,
    verifyRedact: (v: string) => v,
    storeVerifyDetail: () => 'h',
    scalarCoercers: {},
  } as unknown as ApiToolsOptions)
  registerBrowserTools(server, {
    // onReap/onClosed are wired at registration time; the rest run in handlers.
    manager: { onReap: () => {}, onClosed: () => {} },
    gate: {},
    artifacts: {},
    allowScreenshots: true,
    allowVision: true,
    allowStorageState: true,
    allowBaselineUpdate: true,
    downloadDir: '/d',
    uploadDir: '/u',
    harDir: '/h',
    replayDir: '/rep',
    flowsDir: '/f',
    videoDir: '/v',
    baselineDir: '/b',
    runPerfAudit: async () => ({}),
  } as unknown as BrowserToolsOptions)
  registerCoverageTools(server, {
    allowRun: true,
    allowedRoots: ['/r'],
  } as unknown as CoverageToolsOptions)
  registerDepsTools(server, {
    osvDir: '/o',
    fetchPackument: async () => ({}),
    fetchChangelog: async () => ({}),
    artifacts: {},
  } as unknown as DepsToolsOptions)
  registerFlakeTools(server, {
    // Quarantine's ctor runs migrate(store.database) at registration — a
    // sqlite-shaped no-op db satisfies it without opening a real better-sqlite3.
    store: {
      database: {
        exec: () => {},
        pragma: () => {},
        prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
      },
    },
    runConfig: { allowRun: true, allowedRoots: ['/r'] },
    quarantinePolicy: { allowQuarantine: true, maxExpiryMs: 1000 },
  } as unknown as FlakeToolsOptions)
  registerLspTools(server, {
    registry: {},
    allowRun: true,
    allowedRoots: ['/r'],
    query: async () => ({}),
    rename: async () => ({}),
    describeServers: () => [],
    artifacts: {},
  } as unknown as LspToolsOptions)
  registerMutateTools(server, {
    allowRun: true,
    allowedRoots: ['/r'],
  } as unknown as MutateToolsOptions)
  registerVerifyTools(server, {
    runDriving: {},
    storeVerdict: () => 'h',
    resolveVerdict: () => undefined,
  } as unknown as VerifyToolsOptions)
}

describe('tool/resource name uniqueness across all pillars (ADR 0019 §A5)', () => {
  it('registers every pillar onto ONE server with no duplicate name', () => {
    // SDK 1.29 throws hard on a duplicate registerTool/resource — so a future
    // pillar that shadows an existing tool name would break the aggregate. This
    // guard makes that a test failure, not a startup crash.
    const server = new RecordingServer()
    expect(() => registerAllPillars(server as unknown as McpServer)).not.toThrow()

    // Sanity: registration actually happened and is collision-free.
    expect(server.tools.length).toBeGreaterThanOrEqual(50)
    expect(new Set(server.tools).size).toBe(server.tools.length)
    expect(new Set(server.resources).size).toBe(server.resources.length)

    // Every pillar contributed (so the guard can't pass by silently no-op'ing one).
    expect(server.tools).toContain('search_docs') // docs
    expect(server.tools).toContain('run_request') // api
    expect(server.tools).toContain('uncovered_in_diff') // coverage
    expect(server.tools).toContain('audit_dependency') // deps
    expect(server.tools).toContain('mutate_summarize') // mutate
    expect(server.tools).toContain('request_verdict') // verify
    expect(server.tools.some((t) => t.startsWith('browser_'))).toBe(true)
    expect(server.tools.some((t) => t.startsWith('flake_'))).toBe(true)
    expect(server.tools.some((t) => t.startsWith('lsp_'))).toBe(true)
  })

  it('throws on a duplicate tool name (the guard mechanism mirrors SDK 1.29)', () => {
    const server = new RecordingServer()
    const opts = { db: {} } as unknown as DocsToolsOptions
    registerDocsTools(server as unknown as McpServer, opts)
    expect(() => registerDocsTools(server as unknown as McpServer, opts)).toThrow(
      /already registered/,
    )
  })
})

const binFiles = readdirSync(here)
  .filter((f) => f.startsWith('bin') && f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort()

describe('no bin imports the index barrel (ADR 0019 §A4)', () => {
  it('finds the bin entrypoints', () => {
    expect(binFiles.length).toBeGreaterThanOrEqual(9)
  })

  for (const file of binFiles) {
    it(`${file} imports its pillar module directly, never ./index.js`, () => {
      // index.ts statically re-exports EVERY pillar, so a bin importing the
      // barrel loads all pillars (and their heavy deps: playwright/sqlite/onnx)
      // at process start. Each bin must import only the module it serves.
      const src = readFileSync(`${here}/${file}`, 'utf8')
      expect(src).not.toMatch(/from\s+'\.\/index\.js'/)
    })
  }
})
