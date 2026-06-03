import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LanguageServerManager } from './manager.js'
import { type FakeServerOptions, fakeSpawn, INIT_RENAME } from './peer.js'
import {
  defaultListFiles,
  LspRenameEngine,
  type ProjectFileLister,
  type RenameWriter,
} from './rename.js'

/**
 * The partial-rename completeness guard (ADR 0011 — added after a follow-up live deep-dive showed
 * pyright scopes BOTH `references` and `rename` to OPEN files, so a cross-file rename can be silently
 * partial). The engine scans the allowlisted root group for same-language files that mention the old
 * identifier but are NOT in the server's edit; a `suspect` verdict refuses the WRITE deny-by-default
 * (overridable by the operator-only `allowPartialRename`). The guard is OFF until a lister is wired
 * (the bin/CLI/MCP wire `defaultListFiles`); here we wire the real walker over a temp tree.
 */

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
// A THIRD file that uses Greeter — the file an open-files-scoped server's edit silently omits.
const EXTRA_TS = `import { Greeter } from './greeter'

export const other = new Greeter('extra')
`
const DECL_RANGE = { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } }
const IMPORT_RANGE = { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } }
const USAGE_RANGE = { start: { line: 2, character: 14 }, end: { line: 2, character: 21 } }

const THROWING_WRITER: RenameWriter = {
  commit: () => {
    throw new Error('writer must not be called when the rename is refused')
  },
}
function capturingWriter(): { writer: RenameWriter; called: () => boolean } {
  let called = false
  return {
    called: () => called,
    writer: {
      commit: (ops) => {
        called = true
        return { completed: ops, partial: false }
      },
    },
  }
}

const disposers: Array<() => void> = []
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

function setup(onRename: FakeServerOptions['onRename']): {
  root: string
  manager: LanguageServerManager
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-complete-')))
  writeFileSync(join(root, 'greeter.ts'), GREETER_TS)
  writeFileSync(join(root, 'index.ts'), INDEX_TS)
  writeFileSync(join(root, 'extra.ts'), EXTRA_TS)
  const tracker = fakeSpawn({
    initialize: INIT_RENAME(),
    onRename,
    onPrepareRename: () => DECL_RANGE,
  })
  disposers.push(tracker.disposeAll)
  const manager = new LanguageServerManager({
    registry: { typescript: { command: 'x', args: [] } },
    allowedRoots: [root],
    timeoutMs: 1000,
    serverSpawn: tracker.spawn,
    noRetry: true,
    delay: async () => {},
  })
  disposers.push(() => void manager.shutdown())
  return { root, manager }
}

const input = (root: string) => ({
  language: 'typescript',
  projectRoot: root,
  file: 'greeter.ts',
  line: 5,
  column: 14, // the `Greeter` class declaration
  newName: 'Welcomer',
})

const dirOf = (params: unknown) => {
  const uri = (params as { textDocument: { uri: string } }).textDocument.uri
  return uri.slice(0, uri.lastIndexOf('/'))
}
/** Edit covering ONLY the declaration file — the open-files-scoped (partial) shape. */
const declOnlyEdit = (params: unknown) => ({
  changes: { [`${dirOf(params)}/greeter.ts`]: [{ newText: 'Welcomer', range: DECL_RANGE }] },
})
/** Edit covering EVERY file that mentions Greeter — a whole-project-rename server's shape. */
const allFilesEdit = (params: unknown) => {
  const dir = dirOf(params)
  return {
    changes: {
      [`${dir}/greeter.ts`]: [{ newText: 'Welcomer', range: DECL_RANGE }],
      [`${dir}/index.ts`]: [
        { newText: 'Welcomer', range: IMPORT_RANGE },
        { newText: 'Welcomer', range: USAGE_RANGE },
      ],
      [`${dir}/extra.ts`]: [{ newText: 'Welcomer', range: IMPORT_RANGE }],
    },
  }
}

describe('LspRenameEngine — partial-rename completeness guard', () => {
  it('dry-run flags a declaration-only edit as suspect + lists the missed files (does not throw)', async () => {
    const { root, manager } = setup(declOnlyEdit)
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: false,
      listFiles: defaultListFiles,
    })
    const r = await engine.rename(input(root))
    expect(r.status).toBe('ok')
    expect(r.completeness).toBe('suspect')
    expect(r.suspectedMissedFiles?.sort()).toEqual(['extra.ts', 'index.ts'])
    expect(r.applied).toBe(false) // dry-run anyway
  })

  it('REFUSES the write for a suspect rename (deny-by-default) — nothing is written', async () => {
    const { root, manager } = setup(declOnlyEdit)
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      listFiles: defaultListFiles,
      writer: THROWING_WRITER, // throws if the apply phase is reached
    })
    const r = await engine.rename(input(root))
    expect(r.applied).toBe(false)
    expect(r.completeness).toBe('suspect')
    expect(r.refused).toMatch(/incomplete/i)
    expect(r.refused).toMatch(/allowPartialRename/)
  })

  it('APPLIES a suspect rename when the operator set allowPartialRename', async () => {
    const { root, manager } = setup(declOnlyEdit)
    const { writer, called } = capturingWriter()
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      allowPartialRename: true,
      listFiles: defaultListFiles,
      writer,
    })
    const r = await engine.rename(input(root))
    expect(r.applied).toBe(true)
    expect(called()).toBe(true)
    expect(r.completeness).toBe('suspect') // still surfaced — the operator chose to proceed
  })

  it('APPLIES (and reports complete) when every mentioning file is covered', async () => {
    const { root, manager } = setup(allFilesEdit)
    const { writer, called } = capturingWriter()
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      listFiles: defaultListFiles,
      writer,
    })
    const r = await engine.rename(input(root))
    expect(r.completeness).toBe('complete')
    expect(r.suspectedMissedFiles).toBeUndefined()
    expect(r.applied).toBe(true)
    expect(called()).toBe(true)
  })

  it('reports unknown (and applies) when the scan was truncated with no suspect found', async () => {
    const { root, manager } = setup(allFilesEdit)
    const { writer } = capturingWriter()
    const truncatedLister: ProjectFileLister = () => ({ files: [], truncated: true })
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      listFiles: truncatedLister,
      writer,
    })
    const r = await engine.rename(input(root))
    expect(r.completeness).toBe('unknown')
    expect(r.applied).toBe(true) // unknown does not block (else big repos could never rename)
  })

  it('guard is INACTIVE when no lister is wired (a partial edit applies, no completeness verdict)', async () => {
    const { root, manager } = setup(declOnlyEdit)
    const { writer, called } = capturingWriter()
    const engine = new LspRenameEngine({
      manager,
      allowRun: true,
      allowedRoots: [root],
      allowWrite: true,
      writer, // no listFiles ⇒ guard off
    })
    const r = await engine.rename(input(root))
    expect(r.completeness).toBeUndefined()
    expect(r.applied).toBe(true)
    expect(called()).toBe(true)
  })
})
