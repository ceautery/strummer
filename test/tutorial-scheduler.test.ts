import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { overlaps } from '../examples/tutorial/scheduler/src/interval.ts'
import { Schedule } from '../examples/tutorial/scheduler/src/schedule.ts'

// Guard for the level-2 onboarding tutorial (ADR 0020 addendum). The sample app
// lives outside the pnpm workspace and the root Vitest scope, so its own
// (gap-having) suite never runs in the gate — these checks keep the bundled
// files, the docset, and the tutorial's premise in sync.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', 'examples', 'tutorial', 'scheduler')

describe('tutorial(scheduler): bundled files exist', () => {
  for (const rel of [
    'src/interval.ts',
    'src/booking.ts',
    'src/schedule.ts',
    'src/availability.ts',
    'src/format.ts',
    'src/cli.ts',
    'test/schedule.test.ts',
    'docs/scheduler-core/index.json',
    'docs/scheduler-core/db.json',
    'package.json',
    'stryker.config.json',
    'reset.sh',
    'README.md',
  ]) {
    it(`has ${rel}`, () => {
      expect(existsSync(join(root, rel))).toBe(true)
    })
  }
})

describe('tutorial(scheduler): the intentional bug is present', () => {
  // If this block fails because `overlaps` was "fixed", the tutorial's whole
  // premise is gone. Update the tutorial README and this guard together — the
  // bug is intentional (ADR 0020 addendum): `overlaps` uses `<` where it needs
  // `<=`, so intervals that merely TOUCH are wrongly reported as overlapping.
  const touching = () => overlaps({ start: 540, end: 600 }, { start: 600, end: 660 })

  it('wrongly reports touching (back-to-back) intervals as overlapping (the bug to find)', () => {
    // Correct behaviour is `false` (half-open intervals that touch do not share a
    // minute). The shipped code returns `true` — that is the defect.
    expect(touching()).toBe(true)
  })

  it('handles the clear cases correctly (only the boundary is wrong)', () => {
    expect(overlaps({ start: 540, end: 600 }, { start: 570, end: 630 })).toBe(true)
    expect(overlaps({ start: 540, end: 600 }, { start: 660, end: 720 })).toBe(false)
  })

  it('makes Schedule.book wrongly reject a back-to-back booking (the user-visible symptom)', () => {
    const schedule = new Schedule()
    schedule.book('Oak', 'standup', { start: 540, end: 600 })
    expect(() => schedule.book('Oak', 'review', { start: 600, end: 660 })).toThrow(/conflict/)
  })
})

describe('tutorial(scheduler): the docset is internally consistent', () => {
  const index = JSON.parse(readFileSync(join(root, 'docs/scheduler-core/index.json'), 'utf8')) as {
    entries: { name: string; path: string; type: string }[]
  }
  const db = JSON.parse(readFileSync(join(root, 'docs/scheduler-core/db.json'), 'utf8')) as Record<
    string,
    string
  >

  it('every index entry path has a db.json page', () => {
    for (const entry of index.entries) {
      expect(db[entry.path], `missing db page for ${entry.path}`).toBeDefined()
    }
  })

  it('documents that touching intervals do NOT overlap', () => {
    const page = db['api/overlaps'] ?? ''
    expect(page).toContain('overlap')
    expect(page).toContain('touch')
    expect(page).toContain('not')
  })
})

describe('tutorial(scheduler): the README documents the commands it relies on', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const snippet of [
    'sackville-ingest build',
    '--index docs/scheduler-core/index.json',
    'sackville-cli search',
    'lsp references',
    'mutate run',
    'verify run',
    'claude mcp add sackville',
  ]) {
    it(`mentions \`${snippet}\``, () => {
      expect(readme).toContain(snippet)
    })
  }
})
