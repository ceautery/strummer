import { afterEach, describe, expect, it } from 'vitest'
import { LanguageServerManager } from './manager.js'
import {
  DEFINITION,
  DOCUMENT_SYMBOLS,
  fakeSpawn,
  HOVER,
  INIT_UTF8,
  PROGRESS_BEGIN,
  type SpawnTracker,
  TYPE_DEFINITION,
} from './peer.js'
import { LspGateError, LspQueryEngine } from './query.js'
import { parseServerRegistry } from './registry.js'

const REGISTRY = parseServerRegistry(
  JSON.stringify({ typescript: { command: 'tsls', args: ['--stdio'] } }),
)
const ROOT = '/project'

// The capture project's two files (the recorded fixtures point into greeter.ts).
const GREETER_TEXT = `export class Greeter {
  constructor(private name: string) {}
  greet(): string {
    return \`Hello, \${this.name}\`
  }
}
`
const INDEX_TEXT = `import { Greeter } from './greeter'

const g = new Greeter('world')
console.log(g.greet())
`
const FILES: Record<string, string> = {
  '/project/src/index.ts': INDEX_TEXT,
  '/project/src/greeter.ts': GREETER_TEXT,
}
const readFile = (path: string): string | undefined => FILES[path]

const trackers: SpawnTracker[] = []
afterEach(() => {
  for (const t of trackers.splice(0)) t.disposeAll()
})

function makeEngine(opts: Parameters<typeof fakeSpawn>[0] = {}, allowRun = true): LspQueryEngine {
  const tracker = fakeSpawn(opts)
  trackers.push(tracker)
  let t = 0
  const manager = new LanguageServerManager({
    registry: REGISTRY,
    serverSpawn: tracker.spawn,
    allowedRoots: [ROOT],
    timeoutMs: 1000,
    noRetry: true,
    now: () => t,
    delay: async (ms: number) => {
      t += ms
    },
  })
  return new LspQueryEngine({ manager, allowRun, allowedRoots: [ROOT], readFile })
}

const DEF_INPUT = {
  language: 'typescript',
  projectRoot: ROOT,
  file: 'src/index.ts',
  line: 3,
  column: 17, // the `Greeter` in `new Greeter('world')`
  kind: 'definition' as const,
}

describe('LspQueryEngine gate (paired deny-by-default)', () => {
  it('refuses when allowRun is off — and never spawns', async () => {
    const tracker = fakeSpawn()
    trackers.push(tracker)
    const manager = new LanguageServerManager({
      registry: REGISTRY,
      serverSpawn: tracker.spawn,
      allowedRoots: [ROOT],
      timeoutMs: 1000,
    })
    const engine = new LspQueryEngine({
      manager,
      allowRun: false,
      allowedRoots: [ROOT],
      readFile,
    })
    await expect(engine.query(DEF_INPUT)).rejects.toBeInstanceOf(LspGateError)
    expect(tracker.spawns).toHaveLength(0)
  })

  it('refuses a projectRoot outside the allowlist', async () => {
    const engine = makeEngine()
    await expect(engine.query({ ...DEF_INPUT, projectRoot: '/etc' })).rejects.toBeInstanceOf(
      LspGateError,
    )
  })

  it('refuses a file that escapes the project root (no traversal)', async () => {
    const engine = makeEngine()
    await expect(engine.query({ ...DEF_INPUT, file: '../secrets.ts' })).rejects.toBeInstanceOf(
      LspGateError,
    )
  })
})

describe('LspQueryEngine position mapping (human ↔ LSP, over recorded payloads)', () => {
  it('sends the queried human line:col as a 0-based LSP position', async () => {
    let sent: { position?: { line: number; character: number } } | undefined
    const engine = makeEngine({
      onDefinition: (p) => {
        sent = p as typeof sent
        return DEFINITION()
      },
    })
    await engine.query(DEF_INPUT)
    // human line 3, column 17 → 0-based line 2, character 16.
    expect(sent?.position).toEqual({ line: 2, character: 16 })
  })

  it('maps the result LocationLink ranges back to human 1-based line:col', async () => {
    const engine = makeEngine({ initialize: INIT_UTF8(), onDefinition: () => DEFINITION() })
    const r = await engine.query(DEF_INPUT)
    expect(r.status).toBe('ok')
    expect(r.locations).toHaveLength(2)
    // greeter.ts class-name symbol: LSP {line:0,char:13}..{line:0,char:20} → human L1 C14..C21.
    expect(r.locations?.[0]).toMatchObject({
      uri: 'file:///project/src/greeter.ts',
      range: { start: { line: 1, column: 14 }, end: { line: 1, column: 21 } },
    })
    expect(r.encoding).toBe('utf-8')
    expect(r.serverInfo).toEqual({ name: 'typescript-language-server', version: '5.3.0' })
  })
})

describe('LspQueryEngine typeDefinition', () => {
  it('returns the type definition location (a plain Location[], no fullRange) mapped to human coords', async () => {
    const engine = makeEngine({ onTypeDefinition: () => TYPE_DEFINITION() })
    const r = await engine.query({ ...DEF_INPUT, kind: 'typeDefinition' })
    expect(r.status).toBe('ok')
    expect(r.kind).toBe('typeDefinition')
    expect(r.locations).toHaveLength(1)
    expect(r.locations?.[0]).toMatchObject({
      uri: 'file:///project/src/greeter.ts',
      range: { start: { line: 5 } }, // LSP 0-based line 4 → human line 5
      mapped: true,
    })
    expect(r.locations?.[0]?.fullRange).toBeUndefined()
  })
})

describe('LspQueryEngine documentSymbols (position-less)', () => {
  it('returns the file outline with ranges mapped to human coords + recurses children', async () => {
    const engine = makeEngine({ onDocumentSymbol: () => DOCUMENT_SYMBOLS() })
    const r = await engine.query({
      language: 'typescript',
      projectRoot: ROOT,
      file: 'src/greeter.ts',
      kind: 'documentSymbols',
    })
    expect(r.status).toBe('ok')
    expect(r.kind).toBe('documentSymbols')
    const greeter = r.symbols?.find((s) => s.name === 'Greeter')
    expect(greeter?.kindName).toBe('Class')
    expect(greeter?.range.start.line).toBe(1) // LSP line 0 → human line 1
    expect(greeter?.children?.map((c) => c.name)).toContain('greet')
  })

  it('requires no position, but a position-based kind without line/column is refused', async () => {
    const engine = makeEngine({ onDefinition: () => DEFINITION() })
    await expect(
      engine.query({
        language: 'typescript',
        projectRoot: ROOT,
        file: 'src/index.ts',
        kind: 'definition',
      }),
    ).rejects.toBeInstanceOf(LspGateError)
  })
})

describe('LspQueryEngine hover + tri-state', () => {
  it('returns the hover value', async () => {
    const engine = makeEngine({ onHover: () => HOVER() })
    const r = await engine.query({ ...DEF_INPUT, kind: 'hover' })
    expect(r.status).toBe('ok')
    expect(r.hover?.value).toContain('Greeter')
  })

  it('no_result: an empty result while ready, no invented locations', async () => {
    const engine = makeEngine({ onDefinition: () => null })
    const r = await engine.query(DEF_INPUT)
    expect(r.status).toBe('no_result')
    expect(r.locations ?? []).toHaveLength(0)
  })

  it('not_ready: empty WHILE a $/progress indexing token is active', async () => {
    const engine = makeEngine({
      onDefinition: () => null,
      emitProgressBeforeDefinition: PROGRESS_BEGIN(),
    })
    const r = await engine.query(DEF_INPUT)
    expect(r.status).toBe('not_ready')
    expect(r.locations ?? []).toHaveLength(0)
  })
})

describe('LspQueryEngine version provenance', () => {
  it('warns when the server reports no version (answer cannot be attributed)', async () => {
    const engine = makeEngine({ onDefinition: () => DEFINITION() }) // default INIT: no serverInfo
    const r = await engine.query(DEF_INPUT)
    expect(r.serverInfo).toBeUndefined()
    expect(r.versionWarning).toMatch(/version/i)
  })

  it('no warning when serverInfo is present', async () => {
    const engine = makeEngine({ initialize: INIT_UTF8(), onDefinition: () => DEFINITION() })
    const r = await engine.query(DEF_INPUT)
    expect(r.versionWarning).toBeUndefined()
  })
})
