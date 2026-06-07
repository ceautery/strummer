/**
 * cosmic-ray adapter (a Python mutation-testing tool) — converts `cosmic-ray dump <session.sqlite>`
 * JSON-lines into the mutation-testing-elements {@link MutationReport} that {@link summarizeMutation}
 * already consumes, so the summarizer is reused unchanged across Stryker (JS), mutmut, and cosmic-ray.
 *
 * Unlike mutmut, cosmic-ray's dump carries the REAL source path + line + operator per mutant, so its
 * survivors are actionable (file:line:operator). Each dump line is a JSON array
 * `[work_item, work_result | null]` (captured from cosmic-ray 8.4.6 — see
 * `test/fixtures/cosmic-ray-dump.jsonl`):
 *
 *   - `work_item.mutations[]` — one entry per mutation in the job (single-mutation jobs in practice);
 *     each has `module_path` (the file key), `operator_name` (the mutator), and `start_pos: [line, col]`.
 *   - `work_result` — `{ worker_outcome, test_outcome? }`, or `null` when the job has not been executed.
 *
 * Status mapping (cosmic-ray → mutation-testing-elements), chosen to never overstate the score and to
 * fold ambiguity to a neutral `Pending` (never `Survived`/`Killed`):
 *   - `work_result === null`               → Pending (not yet executed)
 *   - worker_outcome `normal` + test_outcome `killed`/`survived` → Killed / Survived
 *   - worker_outcome `normal` + test_outcome `incompetent`       → RuntimeError (the mutant broke the run)
 *   - worker_outcome `no_test`             → NoCoverage (no test exercised the mutation)
 *   - worker_outcome `skipped`             → Ignored
 *   - worker_outcome `exception`/`abnormal`→ RuntimeError (invalid — excluded from the score)
 *   - worker_outcome `timeout`             → Timeout
 *   - anything else / missing test_outcome → Pending (ambiguity ⇒ neutral, never a phantom survivor)
 */

import type { Mutant, MutantStatus, MutationFile, MutationReport } from './summarize.js'

interface CosmicMutation {
  module_path?: string
  operator_name?: string
  start_pos?: [number, number] | { line?: number; column?: number }
  end_pos?: [number, number] | { line?: number; column?: number }
}
interface CosmicWorkItem {
  mutations?: CosmicMutation[]
}
interface CosmicWorkResult {
  worker_outcome?: string
  test_outcome?: string | null
}

/** worker_outcome (other than `normal`) → status. `normal` defers to test_outcome. */
const WORKER_STATUS: Record<string, MutantStatus> = {
  no_test: 'NoCoverage',
  skipped: 'Ignored',
  exception: 'RuntimeError',
  abnormal: 'RuntimeError',
  timeout: 'Timeout',
}
/** test_outcome (when worker_outcome === 'normal') → status. */
const TEST_STATUS: Record<string, MutantStatus> = {
  killed: 'Killed',
  survived: 'Survived',
  incompetent: 'RuntimeError',
}

function statusOf(result: CosmicWorkResult | null): MutantStatus {
  if (result === null) return 'Pending' // not yet executed
  const worker = result.worker_outcome
  if (worker === 'normal') return TEST_STATUS[result.test_outcome ?? ''] ?? 'Pending'
  return (worker !== undefined && WORKER_STATUS[worker]) || 'Pending'
}

function lineColOf(
  pos: CosmicMutation['start_pos'],
): { line: number; column?: number } | undefined {
  if (Array.isArray(pos)) return { line: pos[0], column: pos[1] }
  if (pos && typeof pos.line === 'number') return { line: pos.line, column: pos.column }
  return undefined
}

/** Parse `cosmic-ray dump <session.sqlite>` JSON-lines into a mutation-testing-elements report. Pure. */
export function parseCosmicRayDump(jsonl: string): MutationReport {
  const files: Record<string, MutationFile> = {}
  let index = 0
  for (const raw of jsonl.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let parsed: [CosmicWorkItem, CosmicWorkResult | null]
    try {
      parsed = JSON.parse(line) as [CosmicWorkItem, CosmicWorkResult | null]
    } catch {
      continue // a non-JSON line (e.g. a stray log) is skipped, never a phantom mutant
    }
    const [workItem, workResult] = parsed
    const mutation = workItem?.mutations?.[0]
    const path = mutation?.module_path
    if (!path) continue
    const status = statusOf(workResult ?? null)
    const loc = lineColOf(mutation.start_pos)
    const mutant: Mutant = {
      id: `${path}:${index}`,
      mutatorName: mutation.operator_name ?? 'unknown',
      status,
    }
    if (loc) {
      // Capture end_pos too so the diff line-scope filter range-intersects [start..end] exactly
      // as cosmic-ray's own cr-filter-git does (most mutations are single-line: end === start).
      const end = lineColOf(mutation.end_pos)
      mutant.location = end ? { start: loc, end } : { start: loc }
    }
    const entry = files[path] ?? { language: 'python', mutants: [] }
    entry.mutants.push(mutant)
    files[path] = entry
    index++
  }
  return { files }
}
