import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LspGateError } from './confine.js'
import { LanguageServerManager } from './manager.js'
import {
  type FakeServerOptions,
  fakeSpawn,
  INIT_RENAME,
  INIT_RUST,
  RENAME_EDIT_RENAMEFILE,
} from './peer.js'
import {
  defaultRenameWriter,
  LspRenameEngine,
  type PhysicalOp,
  type RenameWriter,
} from './rename.js'

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
// The INDEPENDENTLY hand-computed goldens (NOT applyTextEdits output — avoids a tautology).
const GREETER2_TS = GREETER_TS.replace('export class Greeter {', 'export class Greeter2 {')
const INDEX2_TS = `import { Greeter2 } from './greeter'

const g = new Greeter2('world')
console.log(g.greet())
`

const DECL_RANGE = { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } } // `Greeter`
const IMPORT_RANGE = { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } }
const USAGE_RANGE = { start: { line: 2, character: 14 }, end: { line: 2, character: 21 } }

const THROWING_WRITER: RenameWriter = {
  commit: () => {
    throw new Error('writer must not be called')
  },
}

/** A writer that records the physical ops it's asked to commit (and reports them all completed). */
function capturingWriter(): { writer: RenameWriter; ops: PhysicalOp[] } {
  const ops: PhysicalOp[] = []
  return {
    ops,
    writer: {
      commit: (o) => {
        ops.push(...o)
        return { completed: o, partial: false }
      },
    },
  }
}
const writeOps = (ops: PhysicalOp[]) =>
  ops.filter((o): o is Extract<PhysicalOp, { kind: 'write' }> => o.kind === 'write')

describe('defaultRenameWriter (real physical commit on disk)', () => {
  it('stages writes, then executes write (mkdir -p) / rename / delete in order', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-writer-')))
    writeFileSync(join(dir, 'old.ts'), 'old')
    writeFileSync(join(dir, 'del.ts'), 'bye')
    const res = defaultRenameWriter.commit([
      { kind: 'write', absPath: join(dir, 'sub', 'created.ts'), newText: 'created' }, // new dir
      { kind: 'rename', fromAbs: join(dir, 'old.ts'), toAbs: join(dir, 'renamed.ts') },
      { kind: 'delete', absPath: join(dir, 'del.ts') },
    ])
    expect(res.partial).toBe(false)
    expect(readFileSync(join(dir, 'sub', 'created.ts'), 'utf8')).toBe('created')
    expect(readFileSync(join(dir, 'renamed.ts'), 'utf8')).toBe('old')
    expect(existsSync(join(dir, 'old.ts'))).toBe(false)
    expect(existsSync(join(dir, 'del.ts'))).toBe(false)
  })
})

const disposers: Array<() => void> = []
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

function setup(opts: {
  onRename: FakeServerOptions['onRename']
  onPrepareRename?: FakeServerOptions['onPrepareRename']
  /** Extra fake-server hooks (e.g. onDidOpen/onDidChange/onDidClose to observe doc resync). */
  server?: Partial<FakeServerOptions>
}): { root: string; manager: LanguageServerManager } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-rename-')))
  writeFileSync(join(root, 'greeter.ts'), GREETER_TS)
  writeFileSync(join(root, 'index.ts'), INDEX_TS)
  const tracker = fakeSpawn({
    initialize: INIT_RENAME(),
    onRename: opts.onRename,
    onPrepareRename: opts.onPrepareRename ?? (() => DECL_RANGE),
    ...opts.server,
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
    const { writer, ops } = capturingWriter()
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
    const writes = writeOps(ops)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.absPath).toBe(join(root, 'greeter.ts'))
    expect(writes[0]?.newText).toBe(GREETER2_TS) // byte-matches the independent golden
    expect(r.digests?.[0]?.file).toBe('greeter.ts')
    expect(r.digests?.[0]?.before).not.toBe(r.digests?.[0]?.after)
  })

  it('applies a MULTI-FILE rename atomically across all edited files (Slice F′)', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({ onRename: multiFileEdit })
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
    expect(r.fileCount).toBe(2)
    // BOTH files staged in one commit (stage-then-commit-all), byte-matching the goldens.
    const byPath = new Map(writeOps(ops).map((w) => [w.absPath, w.newText]))
    expect(byPath.get(join(root, 'greeter.ts'))).toBe(GREETER2_TS)
    expect(byPath.get(join(root, 'index.ts'))).toBe(INDEX2_TS)
    expect(r.digests?.map((d) => d.file).sort()).toEqual(['greeter.ts', 'index.ts'])
  })

  it('REFUSES a multi-file apply when ANY edited file is out of the project root', async () => {
    const { root, manager } = setup({
      onRename: (params) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri
        return {
          changes: {
            [uri]: [{ newText: 'Greeter2', range: DECL_RANGE }],
            'file:///etc/evil.ts': [{ newText: 'Greeter2', range: DECL_RANGE }],
          },
        }
      },
    })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer: THROWING_WRITER, // confine-all aborts before any write
    })
    const r = await engine.rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/outside the project root/i)
  })

  it('REFUSES the apply when an edit site no longer matches the renamed symbol (drift)', async () => {
    const { root, manager } = setup({ onRename: multiFileEdit })
    // Drift index.ts on disk so the usage edit site no longer holds `Greeter`.
    writeFileSync(
      join(root, 'index.ts'),
      "import { Greeter } from './greeter'\n\nconst g = new Flobber('world')\nconsole.log(g.greet())\n",
    )
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer: THROWING_WRITER,
    })
    const r = await engine.rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/no longer matches|changed on disk/i)
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
})

describe('LspRenameEngine — resource operations (CreateFile/RenameFile/DeleteFile)', () => {
  // Mirrors the REAL rust-analyzer module rename: edits on the queried file + a RenameFile of the
  // backing file. Renaming `greeter` in greeter.ts edits greeter.ts AND renames index.ts → moved.ts.
  const renameWithFileRename = (params: unknown): unknown => {
    const uri = (params as { textDocument: { uri: string } }).textDocument.uri
    const dir = uri.slice(0, uri.lastIndexOf('/'))
    return {
      documentChanges: [
        {
          textDocument: { uri: `${dir}/greeter.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: DECL_RANGE }],
        },
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
      ],
    }
  }

  it('APPLIES a RenameFile: edits the queried file AND renames the backing file on disk', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({ onRename: renameWithFileRename })
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
    // The text edit to greeter.ts is a `write`; the RenameFile is a `rename` physical op.
    expect(writeOps(ops).map((w) => w.absPath)).toEqual([join(root, 'greeter.ts')])
    const renameOp = ops.find((o) => o.kind === 'rename') as Extract<PhysicalOp, { kind: 'rename' }>
    expect(renameOp?.fromAbs).toBe(join(root, 'index.ts'))
    expect(renameOp?.toAbs).toBe(join(root, 'moved.ts'))
    // The audit records both the content write and the move (project-relative).
    expect(r.digests?.map((d) => d.file)).toEqual(['greeter.ts', 'index.ts → moved.ts'])
    // The preview surfaces the resource op project-relative (never an absolute URI).
    expect(r.resourceOps).toEqual([{ kind: 'rename', uris: ['index.ts', 'moved.ts'] }])
  })

  it('APPLIES a Move-to-file (CreateFile → edit-new → DeleteFile)', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: (params) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri
        const dir = uri.slice(0, uri.lastIndexOf('/'))
        return {
          documentChanges: [
            { kind: 'create', uri: `${dir}/new.ts` },
            {
              textDocument: { uri: `${dir}/new.ts`, version: 1 },
              edits: [
                {
                  newText: 'export const moved = 1\n',
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                },
              ],
            },
            { kind: 'delete', uri: `${dir}/index.ts` },
          ],
        }
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
    expect(r.applied).toBe(true)
    // CreateFile+edit folds into ONE write of the new file with the inserted content.
    const w = writeOps(ops)
    expect(w.map((x) => x.absPath)).toEqual([join(root, 'new.ts')])
    expect(w[0]?.newText).toBe('export const moved = 1\n')
    expect(ops.some((o) => o.kind === 'delete' && o.absPath === join(root, 'index.ts'))).toBe(true)
  })

  it('REFUSES an overwrite resource op without the destructive-resource-ops gate (previewed only)', async () => {
    const { root, manager } = setup({
      onRename: (params) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri
        const dir = uri.slice(0, uri.lastIndexOf('/'))
        return {
          documentChanges: [
            {
              kind: 'rename',
              oldUri: `${dir}/index.ts`,
              newUri: `${dir}/moved.ts`,
              options: { overwrite: true },
            },
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
    expect(r.refused).toMatch(/overwrite requires.*destructive-resource-ops gate/i)
  })

  it('REFUSES to apply when a resource-op endpoint escapes every allowlisted root (zero writes)', async () => {
    const { root, manager } = setup({
      onRename: (params) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri
        const dir = uri.slice(0, uri.lastIndexOf('/'))
        return {
          documentChanges: [
            { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: 'file:///etc/evil.ts' },
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
    expect(r.refused).toMatch(/outside the project root/i)
  })

  it('reports partial:true (terminal, no rollback) when a later physical op faults mid-commit', async () => {
    // A writer that commits the first op then faults — mimics an irreversible mid-batch failure.
    const partialWriter: RenameWriter = {
      commit: (o) => ({ completed: o.slice(0, 1), partial: true, error: 'EIO on rename' }),
    }
    const { root, manager } = setup({ onRename: renameWithFileRename })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer: partialWriter,
    })
    const r = await engine.rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(r.partial).toBe(true)
    expect(r.partialError).toMatch(/EIO/)
    expect(r.digests).toHaveLength(1) // only the op that landed is audited
  })
})

describe('LspRenameEngine — resource-op options (safe-subset ignoreIf*)', () => {
  // Build a documentChanges result whose paths are relative to the queried uri's directory.
  const docChanges =
    (build: (dir: string) => unknown[]) =>
    (params: unknown): unknown => {
      const uri = (params as { textDocument: { uri: string } }).textDocument.uri
      const dir = uri.slice(0, uri.lastIndexOf('/'))
      return { documentChanges: build(dir) }
    }
  const engineFor = (root: string, manager: LanguageServerManager, writer: RenameWriter) =>
    new LspRenameEngine({ manager, allowRun: true, allowedRoots: [root], allowWrite: true, writer })
  /** Same, but with the operator destructive-resource-ops gate ON (overwrite may apply). */
  const destructiveEngineFor = (
    root: string,
    manager: LanguageServerManager,
    writer: RenameWriter,
  ) =>
    new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      allowDestructiveResourceOps: true,
      writer,
    })

  it('A1: create + ignoreIfExists SKIPS (not refuses) when the target already exists', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/index.ts`, options: { ignoreIfExists: true } },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.status).toBe('ok')
    expect(r.applied).toBe(false)
    expect(r.refused).toBeUndefined() // skipped silently, NOT refused
  })

  it('A2: create on an existing target with NO option is refused (no write)', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [{ kind: 'create', uri: `${dir}/index.ts` }]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/cannot create .*already exists/i)
  })

  it('A3: rename + ignoreIfExists SKIPS when the target already exists (old stays)', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          kind: 'rename',
          oldUri: `${dir}/index.ts`,
          newUri: `${dir}/greeter.ts`,
          options: { ignoreIfExists: true },
        },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toBeUndefined()
    expect(existsSync(join(root, 'index.ts'))).toBe(true) // untouched
  })

  it('A4: rename onto an existing target with NO option is refused', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/greeter.ts` },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/cannot rename to .*already exists/i)
  })

  it('A5: delete + ignoreIfNotExists SKIPS when the file is missing', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'delete', uri: `${dir}/nope.ts`, options: { ignoreIfNotExists: true } },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toBeUndefined()
  })

  it('A6: delete of a missing file with NO option is refused', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [{ kind: 'delete', uri: `${dir}/nope.ts` }]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/cannot delete .*does not exist/i)
  })

  it('A7: create + overwrite is refused WITHOUT the destructive-resource-ops gate', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/new.ts`, options: { overwrite: true } },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/overwrite requires.*destructive-resource-ops gate/i)
  })

  it('A8: delete + recursive is refused EVEN WITH the destructive gate on (never enabled)', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'delete', uri: `${dir}/index.ts`, options: { recursive: true } },
      ]),
    })
    const r = await destructiveEngineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/recursive.*delete.*(unsupported|refused)/i)
  })

  it('A8b: overwrite on a DELETE op is refused as a malformed option (even with the gate)', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'delete', uri: `${dir}/index.ts`, options: { overwrite: true } },
      ]),
    })
    const r = await destructiveEngineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/overwrite is not a valid option on a delete/i)
  })

  it('A9: create + ignoreIfExists PROCEEDS when the target does NOT exist (no-op option)', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/fresh.ts`, options: { ignoreIfExists: true } },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(writeOps(ops).map((w) => w.absPath)).toEqual([join(root, 'fresh.ts')])
    expect(writeOps(ops)[0]?.newText).toBe('')
  })
})

describe('LspRenameEngine — destructive resource-ops: CreateFile overwrite (operator-gated)', () => {
  const docChanges =
    (build: (dir: string) => unknown[]) =>
    (params: unknown): unknown => {
      const uri = (params as { textDocument: { uri: string } }).textDocument.uri
      const dir = uri.slice(0, uri.lastIndexOf('/'))
      return { documentChanges: build(dir) }
    }
  const destructiveEngineFor = (
    root: string,
    manager: LanguageServerManager,
    writer: RenameWriter,
  ) =>
    new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      allowDestructiveResourceOps: true,
      writer,
    })
  const OVERWRITE_CONTENT = 'export const moved = 1\n'

  it('2a: create + overwrite on an EXISTING file truncates-and-replaces it (gated), audits prior bytes', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/index.ts`, options: { overwrite: true } },
        {
          textDocument: { uri: `${dir}/index.ts`, version: 1 },
          edits: [
            {
              newText: OVERWRITE_CONTENT,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          ],
        },
      ]),
    })
    const r = await destructiveEngineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    const w = writeOps(ops)
    expect(w.map((x) => x.absPath)).toEqual([join(root, 'index.ts')])
    expect(w[0]?.newText).toBe(OVERWRITE_CONTENT)
    const d = r.digests?.find((x) => x.file === 'index.ts')
    expect(d?.before).toBe(createHash('sha256').update(INDEX_TS).digest('hex')) // the CLOBBERED prior bytes
    expect(d?.after).toBe(createHash('sha256').update(OVERWRITE_CONTENT).digest('hex'))
    expect(r.overwritten).toContain('index.ts') // the destructive clobber is surfaced
  })

  it('2b: [create-overwrite(f), delete(f)] emits a PHYSICAL delete (not a silent net-no-op)', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/index.ts`, options: { overwrite: true } },
        { kind: 'delete', uri: `${dir}/index.ts` },
      ]),
    })
    const r = await destructiveEngineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    // BLOCKER 2.1: an overwrite-create is a REAL on-disk inode, so a following delete MUST delete it.
    expect(ops.some((o) => o.kind === 'delete' && o.absPath === join(root, 'index.ts'))).toBe(true)
    expect(writeOps(ops)).toHaveLength(0) // the create-overwrite write is overridden by the delete
  })

  it('2c: create + overwrite that WOULD write is still refused without the gate (writer untouched)', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/index.ts`, options: { overwrite: true } },
        {
          textDocument: { uri: `${dir}/index.ts`, version: 1 },
          edits: [
            {
              newText: OVERWRITE_CONTENT,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          ],
        },
      ]),
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
    expect(r.refused).toMatch(/overwrite requires.*destructive-resource-ops gate/i)
  })
})

describe('LspRenameEngine — edit composed with rename/delete (safe-subset v1 cuts)', () => {
  const docChanges =
    (build: (dir: string) => unknown[]) =>
    (params: unknown): unknown => {
      const uri = (params as { textDocument: { uri: string } }).textDocument.uri
      const dir = uri.slice(0, uri.lastIndexOf('/'))
      return { documentChanges: build(dir) }
    }
  const engineFor = (
    root: string,
    manager: LanguageServerManager,
    writer: RenameWriter = defaultRenameWriter,
  ) =>
    new LspRenameEngine({ manager, allowRun: true, allowedRoots: [root], allowWrite: true, writer })
  const renameOpOf = (ops: PhysicalOp[]) =>
    ops.find((o): o is Extract<PhysicalOp, { kind: 'rename' }> => o.kind === 'rename')

  // INDEX_TS with only the import-symbol occurrence renamed (a fix-up edit in the moved file).
  const INDEX_IMPORT2 = INDEX_TS.replace('import { Greeter }', 'import { Greeter2 }')

  it('B1: rename(index→moved) THEN edit(moved) applies the fix-up to the moved content', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          textDocument: { uri: `${dir}/greeter.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: DECL_RANGE }],
        },
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
        {
          textDocument: { uri: `${dir}/moved.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: IMPORT_RANGE }],
        },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    const byPath = new Map(writeOps(ops).map((w) => [w.absPath, w.newText]))
    expect(byPath.get(join(root, 'greeter.ts'))).toBe(GREETER2_TS)
    expect(byPath.get(join(root, 'moved.ts'))).toBe(INDEX_IMPORT2)
    // the RenameFile executes BEFORE the write to the moved path
    const renameIdx = ops.findIndex((o) => o.kind === 'rename')
    const movedWriteIdx = ops.findIndex(
      (o) => o.kind === 'write' && o.absPath === join(root, 'moved.ts'),
    )
    expect(renameIdx).toBeGreaterThanOrEqual(0)
    expect(renameIdx).toBeLessThan(movedWriteIdx)
    expect(r.digests?.map((d) => d.file)).toContain('index.ts → moved.ts')
  })

  it('B2: edit(A) THEN rename(A→B) writes the edited content to the new path', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          textDocument: { uri: `${dir}/index.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: IMPORT_RANGE }],
        },
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(writeOps(ops).map((w) => w.absPath)).toEqual([join(root, 'moved.ts')])
    expect(writeOps(ops)[0]?.newText).toBe(INDEX_IMPORT2)
    expect(renameOpOf(ops)).toMatchObject({
      fromAbs: join(root, 'index.ts'),
      toAbs: join(root, 'moved.ts'),
    })
    const d = r.digests?.find((x) => x.file === 'index.ts → moved.ts')
    expect(d?.before).not.toBe(d?.after)
  })

  it('B3: edit(A) THEN rename(A→B) THEN edit(B) composes both edits onto the moved content', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          textDocument: { uri: `${dir}/index.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: IMPORT_RANGE }],
        },
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
        {
          textDocument: { uri: `${dir}/moved.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: USAGE_RANGE }],
        },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    // both the import AND usage occurrences renamed = INDEX2_TS
    expect(writeOps(ops).find((w) => w.absPath === join(root, 'moved.ts'))?.newText).toBe(INDEX2_TS)
  })

  it('B5: create(C) THEN delete(C) is a net no-op', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/scratch.ts` },
        { kind: 'delete', uri: `${dir}/scratch.ts` },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(existsSync(join(root, 'scratch.ts'))).toBe(false)
  })

  it('B7: edit(A) THEN delete(A) discards the edit; delete digest before = original content', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          textDocument: { uri: `${dir}/index.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: IMPORT_RANGE }],
        },
        { kind: 'delete', uri: `${dir}/index.ts` },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(writeOps(ops)).toHaveLength(0)
    expect(ops.some((o) => o.kind === 'delete' && o.absPath === join(root, 'index.ts'))).toBe(true)
    const d = r.digests?.find((x) => x.file === 'index.ts (deleted)')
    expect(d?.before).toBe(createHash('sha256').update(INDEX_TS).digest('hex'))
    expect(d?.after).toBe('')
  })

  it('B8: rename(A→B) THEN delete(B) deletes the origin, emits no rename', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
        { kind: 'delete', uri: `${dir}/moved.ts` },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(renameOpOf(ops)).toBeUndefined()
    expect(ops.some((o) => o.kind === 'delete' && o.absPath === join(root, 'index.ts'))).toBe(true)
    expect(r.digests?.map((d) => d.file)).toContain('index.ts (deleted)')
  })

  it('B9: delete(A) THEN create(A) (revive) writes empty; digest before = original content', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'delete', uri: `${dir}/index.ts` },
        { kind: 'create', uri: `${dir}/index.ts` },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(writeOps(ops).map((w) => [w.absPath, w.newText])).toEqual([[join(root, 'index.ts'), '']])
    const d = r.digests?.find((x) => x.file === 'index.ts')
    expect(d?.before).toBe(createHash('sha256').update(INDEX_TS).digest('hex'))
    expect(d?.after).toBe(createHash('sha256').update('').digest('hex'))
  })

  it('B10: delete(A) THEN rename(B→A) is refused (delete path is a rename target)', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'delete', uri: `${dir}/index.ts` },
        { kind: 'rename', oldUri: `${dir}/other.ts`, newUri: `${dir}/index.ts` },
      ]),
    })
    writeFileSync(join(root, 'other.ts'), 'export const x = 1\n')
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/its path is a rename or create target in this edit/i)
  })

  it('B11: rename(A→B) THEN rename(B→A) (swap) is refused as a cycle', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
        { kind: 'rename', oldUri: `${dir}/moved.ts`, newUri: `${dir}/index.ts` },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/rename cycle/i)
  })

  it('B12: rename(A→X) THEN rename(B→X) (two into one) is refused', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
        { kind: 'rename', oldUri: `${dir}/other.ts`, newUri: `${dir}/moved.ts` },
      ]),
    })
    writeFileSync(join(root, 'other.ts'), 'export const x = 1\n')
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/already a target in this edit/i)
  })

  it('B13: create(C) THEN rename(A→C) is refused (target already exists)', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/scratch.ts` },
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/scratch.ts` },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/cannot rename to .*already exists/i)
  })

  it('B15: create(C) THEN rename(C→D) writes once at D (no fs rename)', async () => {
    const { writer, ops } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'create', uri: `${dir}/scratch.ts` },
        { kind: 'rename', oldUri: `${dir}/scratch.ts`, newUri: `${dir}/final.ts` },
      ]),
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(renameOpOf(ops)).toBeUndefined()
    expect(writeOps(ops).map((w) => w.absPath)).toEqual([join(root, 'final.ts')])
    expect(r.digests?.map((d) => d.file)).toEqual(['final.ts'])
  })

  it('B16: rename(A→B) THEN edit(A) (edit the renamed-away path) is refused', async () => {
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        { kind: 'rename', oldUri: `${dir}/index.ts`, newUri: `${dir}/moved.ts` },
        {
          textDocument: { uri: `${dir}/index.ts`, version: 1 },
          edits: [{ newText: 'X', range: IMPORT_RANGE }],
        },
      ]),
    })
    const r = await engineFor(root, manager, THROWING_WRITER).rename(renameInput(root))
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/was renamed in this edit; address the new path/i)
  })

  // --- resync of the OPEN (queried) file: only the queried file is opened, so this is the only
  // place the server-buffer migration is observable. ---
  function captureSync() {
    const opened: Array<{ uri: string; text: string }> = []
    const closed: string[] = []
    const changed: Array<{ uri: string; text: string }> = []
    return {
      opened,
      closed,
      changed,
      hooks: {
        // biome-ignore lint/suspicious/noExplicitAny: test capture of raw JSON-RPC params
        onDidOpen: (p: any) => opened.push({ uri: p.textDocument.uri, text: p.textDocument.text }),
        // biome-ignore lint/suspicious/noExplicitAny: test capture
        onDidClose: (p: any) => closed.push(p.textDocument.uri),
        // biome-ignore lint/suspicious/noExplicitAny: test capture
        onDidChange: (p: any) =>
          changed.push({ uri: p.textDocument.uri, text: p.contentChanges[0].text }),
      } as Partial<FakeServerOptions>,
    }
  }
  const flush = () => new Promise((r) => setTimeout(r, 30))

  it('B17: queried file edited AND renamed migrates the open buffer (didClose old + didOpen new)', async () => {
    const sync = captureSync()
    const { writer } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          textDocument: { uri: `${dir}/greeter.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: DECL_RANGE }],
        },
        { kind: 'rename', oldUri: `${dir}/greeter.ts`, newUri: `${dir}/greeter2.ts` },
      ]),
      server: sync.hooks,
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    await flush()
    const greeterUri = pathToFileURL(join(root, 'greeter.ts')).toString()
    const g2Uri = pathToFileURL(join(root, 'greeter2.ts')).toString()
    expect(sync.closed).toContain(greeterUri)
    expect(sync.opened.find((o) => o.uri === g2Uri)?.text).toBe(GREETER2_TS)
  })

  it('B18: queried file deleted closes+evicts the open buffer', async () => {
    const sync = captureSync()
    const { writer } = capturingWriter()
    const { root, manager } = setup({
      onRename: docChanges((dir) => [{ kind: 'delete', uri: `${dir}/greeter.ts` }]),
      server: sync.hooks,
    })
    const r = await engineFor(root, manager, writer).rename(renameInput(root))
    expect(r.applied).toBe(true)
    await flush()
    expect(sync.closed).toContain(pathToFileURL(join(root, 'greeter.ts')).toString())
  })

  it('B19: PARTIAL (rename lands, write faults) resyncs the open buffer with PRISTINE bytes', async () => {
    const sync = captureSync()
    // commit only the first physical op (the rename), then fault on the write.
    const partialWriter: RenameWriter = {
      commit: (o) => ({ completed: o.slice(0, 1), partial: true, error: 'EIO on write' }),
    }
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          textDocument: { uri: `${dir}/greeter.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: DECL_RANGE }],
        },
        { kind: 'rename', oldUri: `${dir}/greeter.ts`, newUri: `${dir}/greeter2.ts` },
      ]),
      server: sync.hooks,
    })
    const r = await engineFor(root, manager, partialWriter).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(r.partial).toBe(true)
    expect(r.digests).toHaveLength(1) // the combined row still surfaces (shared digest index)
    await flush()
    const g2Uri = pathToFileURL(join(root, 'greeter2.ts')).toString()
    // The write faulted, so disk holds the PRISTINE bytes; the buffer must match disk, not the edit.
    expect(sync.opened.find((o) => o.uri === g2Uri)?.text).toBe(GREETER_TS)
  })

  it('B20: PARTIAL where only the write half lands still surfaces the combined digest row', async () => {
    // An injected writer that lands ONLY the write op (index 1), not the rename — proves the shared
    // digest index keeps the audit non-empty when the rename half is the one that did not land.
    const writeOnlyWriter: RenameWriter = {
      commit: (o) => {
        const w = o.filter((x) => x.kind === 'write')
        return { completed: w, partial: true, error: 'EIO on rename' }
      },
    }
    const { root, manager } = setup({
      onRename: docChanges((dir) => [
        {
          textDocument: { uri: `${dir}/greeter.ts`, version: 1 },
          edits: [{ newText: 'Greeter2', range: DECL_RANGE }],
        },
        { kind: 'rename', oldUri: `${dir}/greeter.ts`, newUri: `${dir}/greeter2.ts` },
      ]),
    })
    const r = await engineFor(root, manager, writeOnlyWriter).rename(renameInput(root))
    expect(r.applied).toBe(true)
    expect(r.partial).toBe(true)
    expect(r.digests).toHaveLength(1)
    expect(r.digests?.[0]?.file).toBe('greeter.ts → greeter2.ts')
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

// A monorepo: the symbol is declared in pkg-a and consumed from pkg-b. A cross-root rename edits
// files in BOTH allowlisted roots, so the edited URIs must confine to the GROUP, not just the
// primary projectRoot. pkg-b's index.ts is byte-for-byte INDEX_TS except it imports across roots.
const PKGB_INDEX_TS = INDEX_TS.replace("'./greeter'", "'../pkg-a/greeter'")
const PKGB_INDEX2_TS = INDEX2_TS.replace("'./greeter'", "'../pkg-a/greeter'")

function setupMonorepo(): { pkgA: string; pkgB: string; manager: LanguageServerManager } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-rename-mono-')))
  const pkgA = join(base, 'pkg-a')
  const pkgB = join(base, 'pkg-b')
  mkdirSync(pkgA)
  mkdirSync(pkgB)
  writeFileSync(join(pkgA, 'greeter.ts'), GREETER_TS)
  writeFileSync(join(pkgB, 'index.ts'), PKGB_INDEX_TS)
  // The rename of `Greeter` (queried in pkg-a) edits pkg-a/greeter.ts AND pkg-b/index.ts.
  const onRename = () => ({
    changes: {
      [pathToFileURL(join(pkgA, 'greeter.ts')).toString()]: [
        { newText: 'Greeter2', range: DECL_RANGE },
      ],
      [pathToFileURL(join(pkgB, 'index.ts')).toString()]: [
        { newText: 'Greeter2', range: IMPORT_RANGE },
        { newText: 'Greeter2', range: USAGE_RANGE },
      ],
    },
  })
  const tracker = fakeSpawn({
    initialize: INIT_RENAME(),
    onRename,
    onPrepareRename: () => DECL_RANGE,
  })
  disposers.push(tracker.disposeAll)
  const manager = new LanguageServerManager({
    registry: { typescript: { command: 'x', args: [] } },
    allowedRoots: [pkgA, pkgB],
    timeoutMs: 1000,
    serverSpawn: tracker.spawn,
    noRetry: true,
    delay: async () => {},
  })
  disposers.push(() => {
    void manager.shutdown()
  })
  return { pkgA, pkgB, manager }
}

describe('LspRenameEngine — multi-root (workspaceRoots)', () => {
  it('applies a cross-root rename across both allowlisted roots', async () => {
    const { pkgA, pkgB, manager } = setupMonorepo()
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [pkgA, pkgB],
      allowWrite: true,
    })
    const r = await engine.rename({
      language: 'typescript',
      projectRoot: pkgA,
      file: 'greeter.ts',
      line: 5,
      column: 14,
      newName: 'Greeter2',
      workspaceRoots: [pkgB],
    })
    expect(r.status).toBe('ok')
    expect(r.applied).toBe(true)
    expect(r.fileCount).toBe(2)
    // The edit in the SECONDARY root landed on disk (group confinement let it through).
    expect(readFileSync(join(pkgA, 'greeter.ts'), 'utf8')).toBe(GREETER2_TS)
    expect(readFileSync(join(pkgB, 'index.ts'), 'utf8')).toBe(PKGB_INDEX2_TS)
  })

  it('refuses to apply when an edit escapes EVERY allowlisted root', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-rename-mono-')))
    const pkgA = join(base, 'pkg-a')
    const pkgB = join(base, 'pkg-b')
    mkdirSync(pkgA)
    mkdirSync(pkgB)
    writeFileSync(join(pkgA, 'greeter.ts'), GREETER_TS)
    const tracker = fakeSpawn({
      initialize: INIT_RENAME(),
      onPrepareRename: () => DECL_RANGE,
      onRename: () => ({
        changes: {
          [pathToFileURL(join(pkgA, 'greeter.ts')).toString()]: [
            { newText: 'Greeter2', range: DECL_RANGE },
          ],
          // Outside pkg-a AND pkg-b — must abort the whole batch before any write.
          'file:///etc/evil.ts': [{ newText: 'Greeter2', range: DECL_RANGE }],
        },
      }),
    })
    disposers.push(tracker.disposeAll)
    const manager = new LanguageServerManager({
      registry: { typescript: { command: 'x', args: [] } },
      allowedRoots: [pkgA, pkgB],
      timeoutMs: 1000,
      serverSpawn: tracker.spawn,
      noRetry: true,
      delay: async () => {},
    })
    disposers.push(() => {
      void manager.shutdown()
    })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [pkgA, pkgB],
      allowWrite: true,
      writer: THROWING_WRITER, // confine-all aborts before any write
    })
    const r = await engine.rename({
      language: 'typescript',
      projectRoot: pkgA,
      file: 'greeter.ts',
      line: 5,
      column: 14,
      newName: 'Greeter2',
      workspaceRoots: [pkgB],
    })
    expect(r.applied).toBe(false)
    expect(r.refused).toMatch(/outside the project root|escapes every/i)
  })

  it('refuses a workspaceRoot outside the operator allowlist (never spawns)', async () => {
    const { pkgA, manager } = setupMonorepo()
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [pkgA], // pkg-b NOT allowlisted here
      allowWrite: true,
      writer: THROWING_WRITER,
    })
    await expect(
      engine.rename({
        language: 'typescript',
        projectRoot: pkgA,
        file: 'greeter.ts',
        line: 5,
        column: 14,
        newName: 'Greeter2',
        workspaceRoots: ['/not/allowlisted'],
      }),
    ).rejects.toThrow(LspGateError)
  })
})

// The REAL rust-analyzer 0.3.2921 editing-a-renamed-file payload (captured out-of-gate; see
// test/fixtures/README.md) replayed through the APPLY engine: a module rename whose module file
// self-references its crate path (`crate::greeter::`). RA edits main.rs AND greeter.rs, then renames
// greeter.rs→welcome.rs — so greeter.rs is edited AND renamed in one batch (the old code refused it).
const RUST_MAIN = `mod greeter;

fn main() {
    let _g = greeter::make();
}
`
const RUST_GREETER = `pub struct Greeter;

pub fn make() -> crate::greeter::Greeter {
    Greeter
}
`
// Independent golden: the moved file must carry the EDITED self-reference (crate::welcome::).
const RUST_WELCOME = RUST_GREETER.replace('crate::greeter::', 'crate::welcome::')

describe('LspRenameEngine — real rust-analyzer payload (editing-a-renamed-file)', () => {
  it('applies the captured RA module-rename: edits main.rs AND moves greeter.rs→welcome.rs with edited content', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-rename-rust-')))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.rs'), RUST_MAIN)
    writeFileSync(join(root, 'src', 'greeter.rs'), RUST_GREETER)
    const rootUri = pathToFileURL(root).toString()
    // Replay the captured fixture, rebasing its `/project` paths onto this temp root.
    const onRename = () =>
      JSON.parse(JSON.stringify(RENAME_EDIT_RENAMEFILE()).replaceAll('file:///project', rootUri))
    const tracker = fakeSpawn({
      initialize: INIT_RUST(),
      onRename,
      // RA advertises prepareProvider; the module id `greeter` sits at main.rs line 0, char 4–11.
      onPrepareRename: () => ({
        start: { line: 0, character: 4 },
        end: { line: 0, character: 11 },
      }),
    })
    disposers.push(tracker.disposeAll)
    const manager = new LanguageServerManager({
      registry: { rust: { command: 'x', args: [] } },
      allowedRoots: [root],
      timeoutMs: 1000,
      serverSpawn: tracker.spawn,
      noRetry: true,
      delay: async () => {},
    })
    disposers.push(() => {
      void manager.shutdown()
    })
    const { writer, ops } = capturingWriter()
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer,
    })
    const r = await engine.rename({
      language: 'rust',
      projectRoot: root,
      file: 'src/main.rs',
      line: 1, // human 1-based → LSP line 0 (the `mod greeter;` declaration)
      column: 5, // human 1-based → LSP char 4 (the `greeter` module id)
      newName: 'welcome',
    })
    expect(r.status).toBe('ok')
    expect(r.applied).toBe(true)
    expect(r.partial).toBeUndefined()
    const byPath = new Map(writeOps(ops).map((w) => [w.absPath, w.newText]))
    // main.rs rewritten; the MOVED file carries the edited self-reference (crate::welcome::).
    expect(byPath.get(join(root, 'src', 'main.rs'))).toBe(
      RUST_MAIN.replaceAll('greeter', 'welcome'),
    )
    expect(byPath.get(join(root, 'src', 'welcome.rs'))).toBe(RUST_WELCOME)
    // greeter.rs is renamed (not separately written) and the audit collapses to one combined row.
    const renameOp = ops.find(
      (o): o is Extract<PhysicalOp, { kind: 'rename' }> => o.kind === 'rename',
    )
    expect(renameOp).toMatchObject({
      fromAbs: join(root, 'src', 'greeter.rs'),
      toAbs: join(root, 'src', 'welcome.rs'),
    })
    expect(r.digests?.map((d) => d.file)).toEqual([
      'src/main.rs',
      'src/greeter.rs → src/welcome.rs',
    ])
  })
})
