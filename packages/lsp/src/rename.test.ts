import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LspGateError } from './confine.js'
import { LanguageServerManager } from './manager.js'
import { type FakeServerOptions, fakeSpawn, INIT_RENAME } from './peer.js'
import { type FileWrite, LspRenameEngine, type RenameWriter } from './rename.js'

// The real capture project's files (see test/fixtures/README.md). `Greeter` is declared on
// line 5 (1-based), column 14, and used in index.ts.
const GREETER_TS = `export function hello(name: string): string {
  return \`Hello, \${name}!\`
}

export class Greeter {
  constructor(private readonly who: string) {}

  greet(): string {
    return hello(this.who)
  }
}
`
const INDEX_TS = `import { Greeter } from './greeter'

const g = new Greeter('world')
console.log(g.greet())
`
// The INDEPENDENTLY hand-computed golden (NOT applyTextEdits output — avoids a tautology).
const GREETER2_TS = GREETER_TS.replace('export class Greeter {', 'export class Greeter2 {')

const DECL_RANGE = { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } } // `Greeter`
const IMPORT_RANGE = { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } }
const USAGE_RANGE = { start: { line: 2, character: 14 }, end: { line: 2, character: 21 } }

const THROWING_WRITER: RenameWriter = {
  commit: () => {
    throw new Error('writer must not be called')
  },
}

const disposers: Array<() => void> = []
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

function setup(opts: {
  onRename: FakeServerOptions['onRename']
  onPrepareRename?: FakeServerOptions['onPrepareRename']
}): { root: string; manager: LanguageServerManager } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-rename-')))
  writeFileSync(join(root, 'greeter.ts'), GREETER_TS)
  writeFileSync(join(root, 'index.ts'), INDEX_TS)
  const tracker = fakeSpawn({
    initialize: INIT_RENAME(),
    onRename: opts.onRename,
    onPrepareRename: opts.onPrepareRename ?? (() => DECL_RANGE),
  })
  disposers.push(tracker.disposeAll)
  const manager = new LanguageServerManager({
    registry: { typescript: { command: 'x', args: [] } },
    allowedRoots: [root],
    timeoutMs: 1000,
    serverSpawn: tracker.spawn,
    noRetry: true,
    delay: async () => {}, // no real shutdown grace in tests
  })
  disposers.push(() => {
    void manager.shutdown()
  })
  return { root, manager }
}

const renameInput = (root: string) => ({
  language: 'typescript',
  projectRoot: root,
  file: 'greeter.ts',
  line: 5,
  column: 14,
  newName: 'Greeter2',
})

/** A dynamic multi-file `changes` map keyed by the REAL queried uri's directory. */
function multiFileEdit(params: unknown): unknown {
  const uri = (params as { textDocument: { uri: string } }).textDocument.uri
  const dir = uri.slice(0, uri.lastIndexOf('/'))
  return {
    changes: {
      [`${dir}/greeter.ts`]: [{ newText: 'Greeter2', range: DECL_RANGE }],
      [`${dir}/index.ts`]: [
        { newText: 'Greeter2', range: IMPORT_RANGE },
        { newText: 'Greeter2', range: USAGE_RANGE },
      ],
    },
  }
}

describe('LspRenameEngine — gating', () => {
  it('refuses when allowRun is off (never spawns)', async () => {
    const { root, manager } = setup({ onRename: multiFileEdit })
    const engine = new LspRenameEngine({
      manager,
      allowRun: false,
      allowedRoots: [root],
      allowWrite: false,
    })
    await expect(engine.rename(renameInput(root))).rejects.toThrow(/not enabled/i)
  })

  it('rejects an implausible newName before reaching the server', async () => {
    const { root, manager } = setup({ onRename: multiFileEdit })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
    })
    await expect(engine.rename({ ...renameInput(root), newName: 'bad\nname' })).rejects.toThrow(
      LspGateError,
    )
  })
})

describe('LspRenameEngine — dry-run preview (allowWrite off)', () => {
  it('computes the edit, shows redaction-clean hunks with human ranges, and writes NOTHING', async () => {
    const { root, manager } = setup({ onRename: multiFileEdit })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: false,
      writer: THROWING_WRITER, // proves dry-run never reaches the writer
    })
    const r = await engine.rename(renameInput(root))
    expect(r.status).toBe('ok')
    expect(r.applied).toBe(false)
    expect(r.fileCount).toBe(2)
    expect(r.totalEditCount).toBe(3)
    const g = r.edits.find((e) => e.file === 'greeter.ts')
    expect(g?.hunks?.[0]).toMatchObject({ oldText: 'Greeter', newText: 'Greeter2' })
    // human 1-based range (line 5, col 14), mapped back via fromLspPosition
    expect(g?.hunks?.[0]?.range.start).toEqual({ line: 5, column: 14 })
    const idx = r.edits.find((e) => e.file === 'index.ts')
    expect(idx?.editCount).toBe(2)
    expect(idx?.hunks?.[0]?.oldText).toBe('Greeter')
  })

  it('applies secret redaction to every surfaced hunk', async () => {
    const { root, manager } = setup({ onRename: multiFileEdit })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: false,
      redact: (s) => s.replaceAll('Greeter', 'XXX'),
    })
    const r = await engine.rename(renameInput(root))
    const g = r.edits.find((e) => e.file === 'greeter.ts')
    expect(g?.hunks?.[0]?.oldText).toBe('XXX')
    expect(g?.hunks?.[0]?.newText).toBe('XXX2')
  })
})

describe('LspRenameEngine — single-file apply (allowWrite on)', () => {
  it('writes the rename to disk via the writer + records pre/post digests', async () => {
    const writes: FileWrite[] = []
    const writer: RenameWriter = {
      commit: (w) => {
        writes.push(...w)
        return { written: w.map((x) => x.absPath) }
      },
    }
    const { root, manager } = setup({
      onRename: (params) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri
        return { changes: { [uri]: [{ newText: 'Greeter2', range: DECL_RANGE }] } } // single file = queried
      },
    })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer,
    })
    const r = await engine.rename(renameInput(root))
    expect(r.status).toBe('ok')
    expect(r.applied).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.absPath).toBe(join(root, 'greeter.ts'))
    expect(writes[0]?.newText).toBe(GREETER2_TS) // byte-matches the independent golden
    expect(r.digests?.[0]?.file).toBe('greeter.ts')
    expect(r.digests?.[0]?.before).not.toBe(r.digests?.[0]?.after)
  })

  it('REFUSES to apply a multi-file rename (previewed only) until the multi-URI lock lands', async () => {
    const { root, manager } = setup({ onRename: multiFileEdit })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer: THROWING_WRITER,
    })
    const r = await engine.rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/multi-file/i)
    expect(r.fileCount).toBe(2)
  })

  it('flags an out-of-root edit, never reads its bytes, and refuses the apply', async () => {
    const { root, manager } = setup({
      onRename: () => ({
        changes: { 'file:///etc/evil.ts': [{ newText: 'X', range: DECL_RANGE }] },
      }),
    })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer: THROWING_WRITER,
    })
    const r = await engine.rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/outside the project root/i)
    expect(r.edits[0]?.outOfRoot).toBe(true)
    expect(r.edits[0]?.hunks).toBeUndefined() // bytes never surfaced
  })

  it('REFUSES to apply when the edit carries resource operations', async () => {
    const { root, manager } = setup({
      onRename: (params) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri
        return {
          documentChanges: [
            {
              textDocument: { uri, version: 1 },
              edits: [{ newText: 'Greeter2', range: DECL_RANGE }],
            },
            { kind: 'rename', oldUri: uri, newUri: `${uri}.bak` },
          ],
        }
      },
    })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer: THROWING_WRITER,
    })
    const r = await engine.rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/resource operations/i)
    expect(r.resourceOps?.[0]?.kind).toBe('rename')
  })
})

describe('LspRenameEngine — prepareRename validation', () => {
  it('refuses (no write) when prepareRename says the position is not renameable', async () => {
    const { root, manager } = setup({ onRename: multiFileEdit, onPrepareRename: () => null })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer: THROWING_WRITER,
    })
    const r = await engine.rename(renameInput(root))
    expect(r.status).toBe('no_result')
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/not valid at this position/i)
  })
})
