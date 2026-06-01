/**
 * mutmut adapter (the Python mutation-testing tool) — converts `mutmut results --all true`
 * output into the mutation-testing-elements {@link MutationReport} that {@link summarizeMutation}
 * already consumes, so the summarizer is reused unchanged across Stryker (JS) and mutmut (Python).
 *
 * mutmut 3.x has no native mutation-testing-elements / JSON-per-mutant report; its richest
 * machine-readable per-mutant output is `mutmut results --all true`, one line per mutant:
 *
 *     calc.x_add__mutmut_1: killed
 *     calc.x_sub__mutmut_1: survived
 *     calc.x_mul__mutmut_1: no tests
 *
 * (Captured from mutmut 3.5.0 — see `test/fixtures/mutmut-results.txt`.) The mutant name is
 * `<dotted module>.x_<function>__mutmut_<n>`, so we group mutants by their module as the "file"
 * key (mutmut does not surface a source path or line here — `line` is 0, `mutatorName` is the
 * mutant name, the best identifier available).
 *
 * Status vocabulary mapping (mutmut → mutation-testing-elements), chosen to never overstate the
 * score: `suspicious` (the suite behaved oddly — not a confirmed kill) maps to `Survived` so it
 * surfaces as a gap; `segfault` maps to `RuntimeError` (invalid, excluded from the score); an
 * unrecognized status maps to `Pending` (neutral — excluded from `valid`, not a survivor).
 */

import type { MutantStatus, MutationFile, MutationReport } from './summarize.js'

const MUTMUT_STATUS: Record<string, MutantStatus> = {
  killed: 'Killed',
  survived: 'Survived',
  'no tests': 'NoCoverage',
  timeout: 'Timeout',
  suspicious: 'Survived',
  skipped: 'Ignored',
  segfault: 'RuntimeError',
}

/** The module portion of a mutmut mutant name (`pkg.mod.x_fn__mutmut_3` → `pkg.mod`). */
function moduleOf(name: string): string {
  const m = /^(.*)\.x_.+__mutmut_\d+$/.exec(name)
  if (m?.[1]) return m[1]
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Parse `mutmut results --all true` text into a mutation-testing-elements report. Pure. */
export function parseMutmutResults(text: string): MutationReport {
  const files: Record<string, MutationFile> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const name = line.slice(0, idx).trim()
    if (!name) continue
    const statusText = line
      .slice(idx + 1)
      .trim()
      .toLowerCase()
    const status = MUTMUT_STATUS[statusText] ?? 'Pending'
    const file = moduleOf(name)
    const entry = files[file] ?? { mutants: [] }
    entry.mutants.push({ id: name, mutatorName: name, status })
    files[file] = entry
  }
  return { files }
}
