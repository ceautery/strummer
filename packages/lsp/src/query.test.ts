import { afterEach, describe, expect, it } from 'vitest'
import { LanguageServerManager } from './manager.js'
import {
  CALL_HIERARCHY_INCOMING,
  CALL_HIERARCHY_PREPARE,
  DEFINITION,
  DOCUMENT_SYMBOLS,
  fakeSpawn,
  HOVER,
  INIT,
  INIT_UTF8,
  PROGRESS_BEGIN,
  type SpawnTracker,
  TYPE_DEFINITION,
  WORKSPACE_SYMBOLS,
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
// The `workspace/symbol` fixture was captured against the greeter project at the root (no `src/`
// prefix), so its result uris are `file:///project/{greeter,index}.ts`. Serve those exact files so
// the cross-file symbol ranges map back encoding-faithfully (mapped:true).
const WSYM_GREETER_TEXT = `/** A free function the Greeter calls. */
export function hello(name: string): string {
  return \`Hello, \${name}!\`
}

/** The greeter class — imported and instantiated in \`index.ts\`. */
export class Greeter {
  constructor(private readonly name: string) {}

  greet(): string {
    return hello(this.name)
  }
}
`
const WSYM_INDEX_TEXT = `import { Greeter } from './greeter.js'

const greeter = new Greeter('world')
console.log(greeter.greet())
`
const FILES: Record<string, string> = {
  '/project/src/index.ts': INDEX_TEXT,
  '/project/src/greeter.ts': GREETER_TEXT,
  '/project/greeter.ts': WSYM_GREETER_TEXT,
  '/project/index.ts': WSYM_INDEX_TEXT,
}
const readFile = (path: string): string | undefined => FILES[path]

const trackers: SpawnTracker[] = []
afterEach(() => {
  for (const t of trackers.splice(0)) t.disposeAll()
})

function makeEngine(
  opts: Parameters<typeof fakeSpawn>[0] = {},
  allowRun = true,
  allowedRoots: string[] = [ROOT],
): LspQueryEngine {
  const tracker = fakeSpawn(opts)
  trackers.push(tracker)
  let t = 0
  const manager = new LanguageServerManager({
    registry: REGISTRY,
    serverSpawn: tracker.spawn,
    allowedRoots,
    timeoutMs: 1000,
    noRetry: true,
    now: () => t,
    delay: async (ms: number) => {
      t += ms
    },
  })
  return new LspQueryEngine({ manager, allowRun, allowedRoots, readFile })
}

// Push diagnostics arrive as an async server notification (stream I/O), which a real timer loses
// to but the instant injected clock would race ahead of. So the diagnostics "ok" cases use a real
// timer (the publish lands in ~1ms; the 1s backstop never fires) — `not_ready` stays on the clock.
function makeRealTimerEngine(opts: Parameters<typeof fakeSpawn>[0] = {}): LspQueryEngine {
  const tracker = fakeSpawn(opts)
  trackers.push(tracker)
  const manager = new LanguageServerManager({
    registry: REGISTRY,
    serverSpawn: tracker.spawn,
    allowedRoots: [ROOT],
    timeoutMs: 1000,
  })
  return new LspQueryEngine({ manager, allowRun: true, allowedRoots: [ROOT], readFile })
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

describe('LspQueryEngine workspaceSymbol (file-less, position-less)', () => {
  const WSYM_INPUT = {
    language: 'typescript',
    projectRoot: ROOT,
    kind: 'workspaceSymbol' as const,
    query: 'Greeter',
  }

  it('searches the workspace by name and maps cross-file ranges back to human coords', async () => {
    let sent: { query?: string } | undefined
    const engine = makeEngine({
      onWorkspaceSymbol: (p) => {
        sent = p as typeof sent
        return WORKSPACE_SYMBOLS()
      },
    })
    const r = await engine.query(WSYM_INPUT)
    expect(sent?.query).toBe('Greeter')
    expect(r.status).toBe('ok')
    expect(r.kind).toBe('workspaceSymbol')
    expect(r.workspaceSymbols?.map((s) => s.name)).toEqual(['greeter', 'Greeter'])
    const cls = r.workspaceSymbols?.find((s) => s.name === 'Greeter')
    expect(cls?.kindName).toBe('Class')
    expect(cls?.uri).toBe('file:///project/greeter.ts')
    // LSP 0-based line 6 → human line 7; the target file is served so the map is faithful.
    expect(cls?.range?.start.line).toBe(7)
    expect(cls?.mapped).toBe(true)
  })

  it('does not require a file or a line/column (file-less, for eager indexers)', async () => {
    let opened = false
    const engine = makeEngine({
      onDidOpen: () => {
        opened = true
      },
      onWorkspaceSymbol: () => WORKSPACE_SYMBOLS(),
    })
    // No `file`, no `line`/`column` — must resolve, not throw, and open NO document.
    await expect(engine.query(WSYM_INPUT)).resolves.toMatchObject({ status: 'ok' })
    expect(opened).toBe(false)
  })

  it('opens the anchor `file` first when given (so a tsserver-style project loads)', async () => {
    let openedUri: string | undefined
    const engine = makeEngine({
      onDidOpen: (p) => {
        openedUri = (p as { textDocument: { uri: string } }).textDocument.uri
      },
      onWorkspaceSymbol: () => WORKSPACE_SYMBOLS(),
    })
    const r = await engine.query({ ...WSYM_INPUT, file: 'src/index.ts' })
    expect(r.status).toBe('ok')
    // The anchor file was opened to establish the project before the search ran.
    expect(openedUri).toBe('file:///project/src/index.ts')
  })

  it('refuses an anchor file that escapes the project root', async () => {
    const engine = makeEngine({ onWorkspaceSymbol: () => WORKSPACE_SYMBOLS() })
    await expect(engine.query({ ...WSYM_INPUT, file: '../secrets.ts' })).rejects.toBeInstanceOf(
      LspGateError,
    )
  })

  it('refuses a workspaceSymbol query with no `query` string', async () => {
    const engine = makeEngine({ onWorkspaceSymbol: () => WORKSPACE_SYMBOLS() })
    await expect(
      engine.query({ language: 'typescript', projectRoot: ROOT, kind: 'workspaceSymbol' }),
    ).rejects.toBeInstanceOf(LspGateError)
  })

  it('no_result: an empty workspace search while ready (no invented symbols)', async () => {
    const engine = makeEngine({ onWorkspaceSymbol: () => [] })
    const r = await engine.query({ ...WSYM_INPUT, query: 'Nope' })
    expect(r.status).toBe('no_result')
    expect(r.workspaceSymbols ?? []).toHaveLength(0)
  })

  it('still gated: refuses when allowRun is off', async () => {
    const engine = makeEngine({ onWorkspaceSymbol: () => WORKSPACE_SYMBOLS() }, false)
    await expect(engine.query(WSYM_INPUT)).rejects.toBeInstanceOf(LspGateError)
  })
})

describe('LspQueryEngine multi-root (workspaceRoots)', () => {
  const ROOT_B = '/project-b'

  it('binds the workspaceRoots group as workspace folders and queries the primary file', async () => {
    let initParams: { workspaceFolders?: Array<{ uri: string }> } | undefined
    const engine = makeEngine(
      {
        onInitialize: (p) => {
          initParams = p as typeof initParams
        },
        onDefinition: () => DEFINITION(),
      },
      true,
      [ROOT, ROOT_B],
    )
    const r = await engine.query({ ...DEF_INPUT, workspaceRoots: [ROOT_B] })
    expect(r.status).toBe('ok')
    expect(initParams?.workspaceFolders?.map((f) => f.uri).sort()).toEqual([
      'file:///project',
      'file:///project-b',
    ])
  })

  it('refuses a workspaceRoot outside the allowlist (paired gate)', async () => {
    const engine = makeEngine({ onDefinition: () => DEFINITION() }, true, [ROOT]) // ROOT_B not allowed
    await expect(engine.query({ ...DEF_INPUT, workspaceRoots: [ROOT_B] })).rejects.toBeInstanceOf(
      LspGateError,
    )
  })
})

describe('LspQueryEngine diagnostics (push, file-based, position-less)', () => {
  const DIAG_INPUT = {
    language: 'typescript',
    projectRoot: ROOT,
    file: 'src/index.ts',
    kind: 'diagnostics' as const,
  }
  // A publish for the opened file (uri must match `pathToFileURL(<root>/src/index.ts)`), with a
  // diagnostic whose LSP range lands inside INDEX_TEXT so it maps to human coords faithfully.
  const PUBLISH = (diagnostics: unknown[]) => ({
    diagnosticsOnOpen: {
      uri: 'file:///project/src/index.ts',
      diagnostics,
    },
  })
  const errorAt = {
    range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } },
    message: "Type 'string' is not assignable to type 'number'.",
    severity: 1,
    code: 2322,
    source: 'typescript',
  }

  it('opens the file, returns the pushed diagnostics mapped to human coords (no position)', async () => {
    const engine = makeRealTimerEngine(PUBLISH([errorAt]))
    const r = await engine.query(DIAG_INPUT)
    expect(r.status).toBe('ok')
    expect(r.kind).toBe('diagnostics')
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics?.[0]?.severityName).toBe('Error')
    // LSP 0-based line 2 char 6 → human line 3 column 7.
    expect(r.diagnostics?.[0]?.range.start).toEqual({ line: 3, column: 7 })
  })

  it('a clean file (empty publish) is ok with no diagnostics (not no_result)', async () => {
    const engine = makeRealTimerEngine(PUBLISH([]))
    const r = await engine.query(DIAG_INPUT)
    expect(r.status).toBe('ok')
    expect(r.diagnostics).toEqual([])
  })

  it('not_ready while the project is still indexing and nothing is published', async () => {
    const engine = makeEngine({ progressOnOpen: [PROGRESS_BEGIN()] }) // begin, no end, no publish
    const r = await engine.query(DIAG_INPUT)
    expect(r.status).toBe('not_ready')
  })

  it('still gated: refuses when allowRun is off', async () => {
    const engine = makeEngine(PUBLISH([errorAt]), false)
    await expect(engine.query(DIAG_INPUT)).rejects.toBeInstanceOf(LspGateError)
  })
})

describe('LspQueryEngine callHierarchy', () => {
  function initWithCallHierarchy(): unknown {
    const init = INIT() as { capabilities: Record<string, unknown> }
    init.capabilities.callHierarchyProvider = true
    return init
  }

  it('returns incoming-call groups with the source + edge items mapped to human coords', async () => {
    const engine = makeEngine({
      initialize: initWithCallHierarchy(),
      onPrepareCallHierarchy: () => CALL_HIERARCHY_PREPARE(),
      onIncomingCalls: () => CALL_HIERARCHY_INCOMING(),
    })
    const r = await engine.query({
      ...DEF_INPUT,
      file: 'src/greeter.ts',
      kind: 'callHierarchy',
      direction: 'incoming',
    })
    expect(r.status).toBe('ok')
    expect(r.kind).toBe('callHierarchy')
    expect(r.callHierarchy).toHaveLength(1)
    const group = r.callHierarchy?.[0]
    expect(group?.direction).toBe('incoming')
    expect(group?.source.name).toBe('hello')
    expect(group?.calls[0]?.item.name).toBe('greet')
    // ranges are mapped to human 1-based coords (line ≥ 1)
    expect(group?.calls[0]?.item.range.start.line).toBeGreaterThanOrEqual(1)
    expect(group?.calls[0]?.fromRanges[0]?.start.line).toBeGreaterThanOrEqual(1)
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
