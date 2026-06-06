import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TodoList } from '../examples/tutorial/todo/src/todo.ts'

// Guard for the onboarding tutorial (ADR 0020). The sample app lives outside the
// pnpm workspace and the root Vitest scope, so its own (gap-having) suite never
// runs in the gate — these checks keep the bundled files, the docset, and the
// tutorial's premise in sync.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', 'examples', 'tutorial', 'todo')

describe('tutorial: bundled files exist', () => {
  for (const rel of [
    'src/todo.ts',
    'src/cli.ts',
    'test/todo.test.ts',
    'docs/todo-core/index.json',
    'docs/todo-core/db.json',
    'package.json',
    'reset.sh',
    'README.md',
  ]) {
    it(`has ${rel}`, () => {
      expect(existsSync(join(root, rel))).toBe(true)
    })
  }
})

describe('tutorial: the intentional bug is present', () => {
  // If this block fails because `filter('active')` was "fixed", the tutorial's
  // whole premise is gone. Update the tutorial README and this guard together —
  // the bug is intentional (ADR 0020).
  const list = new TodoList()
  const active = list.add('still to do')
  const completed = list.add('already done')
  list.toggle(completed.id)

  it("filter('active') wrongly returns the completed todo (the bug to find)", () => {
    expect(list.filter('active').map((t) => t.id)).toEqual([completed.id])
  })

  it("filter('completed') and 'all' are correct (only 'active' is wrong)", () => {
    expect(list.filter('completed').map((t) => t.id)).toEqual([completed.id])
    expect(list.filter('all').map((t) => t.id)).toEqual([active.id, completed.id])
  })
})

describe('tutorial: the docset is internally consistent', () => {
  const index = JSON.parse(readFileSync(join(root, 'docs/todo-core/index.json'), 'utf8')) as {
    entries: { name: string; path: string; type: string }[]
  }
  const db = JSON.parse(readFileSync(join(root, 'docs/todo-core/db.json'), 'utf8')) as Record<
    string,
    string
  >

  it('every index entry path has a db.json page', () => {
    for (const entry of index.entries) {
      expect(db[entry.path], `missing db page for ${entry.path}`).toBeDefined()
    }
  })

  it('documents that active means NOT done', () => {
    expect(db['api/filter']).toContain('not')
    expect(db['api/filter']).toContain('active')
  })
})

describe('tutorial: the README documents the commands it relies on', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const snippet of [
    'sackville-ingest build',
    '--index docs/todo-core/index.json',
    'sackville-cli search',
    'coverage run-scoped',
    'verify run',
    'claude mcp add sackville',
  ]) {
    it(`mentions \`${snippet}\``, () => {
      expect(readme).toContain(snippet)
    })
  }
})
