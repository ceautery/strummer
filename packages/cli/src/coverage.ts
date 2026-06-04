import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CoverageGateError,
  type CoveragePyReport,
  coveragePyToIstanbul,
  type DiffCoverageReport,
  type FileCoverage,
  runScoped,
  runScopedPython,
  type ScopedPythonResult,
  type ScopeMode,
  type TestRunner,
  uncoveredInDiff,
} from '@strummer/coverage'
import type { CliIO } from './index.js'

/**
 * `strummer coverage` — the human surface over `@strummer/coverage`.
 *
 * `uncovered-in-diff` is the pure forgotten-assertion catch: classify a diff's new lines
 * against an istanbul or coverage.py report and surface the executable-but-unhit ones.
 * `run-scoped` is the gated impact-scoped runner (`vitest related`). The human IS the
 * operator, so the gate is a straight-through `--allow-run` flag and the typed root is
 * auto-allowed; the test runner is injectable so the suite never spawns a real vitest
 * (ADR 0010: no real spawn in the gate). Both commands exit 1 when a new line is uncovered —
 * the catch is CI-actionable, like `strummer browser audit`.
 */
export async function runCoverage(
  args: string[],
  io: CliIO,
  deps: { runner?: TestRunner } = {},
): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'uncovered-in-diff':
      return cmdUncoveredInDiff(rest, io)
    case 'run-scoped':
      return cmdRunScoped(rest, io, deps)
    default:
      io.err(`unknown coverage subcommand: ${sub ?? '(none)'}\n`)
      return 1
  }
}

function printReport(io: CliIO, report: DiffCoverageReport): void {
  const s = report.summary
  io.out(
    `files: ${report.files.length} (${s.filesWithoutCoverage} without coverage)  ` +
      `covered ${s.covered}  uncovered ${s.uncovered}  non-executable ${s.nonExecutable}\n`,
  )
  if (report.uncovered.length === 0) {
    io.out('uncovered new lines: (none)\n')
    return
  }
  io.out(`uncovered new lines (${report.uncovered.length}):\n`)
  for (const u of report.uncovered) {
    io.out(`  ${u.path}:${u.line}\n`)
  }
}

function cmdUncoveredInDiff(args: string[], io: CliIO): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      diff: { type: 'string' },
      coverage: { type: 'string' },
      'coverage-format': { type: 'string' },
      'project-root': { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  if (!values.diff || !values.coverage) {
    io.err('coverage uncovered-in-diff needs --diff <file> and --coverage <file>\n')
    return 1
  }
  const format = values['coverage-format'] ?? 'istanbul'
  if (format !== 'istanbul' && format !== 'coveragepy') {
    io.err(`unknown coverage format: ${format} (expected istanbul|coveragepy)\n`)
    return 1
  }
  const diff = readFileSync(values.diff, 'utf8')
  const parsed = JSON.parse(readFileSync(values.coverage, 'utf8'))
  const coverage: Record<string, FileCoverage> =
    format === 'coveragepy' ? coveragePyToIstanbul(parsed as CoveragePyReport) : parsed
  const report = uncoveredInDiff(diff, coverage, { projectRoot: values['project-root'] })

  if (values.json) {
    io.out(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    printReport(io, report)
  }
  // An executable new line with no test is the catch — exit non-zero so CI fails on it.
  return report.uncovered.length === 0 ? 0 : 1
}

async function cmdRunScoped(
  args: string[],
  io: CliIO,
  deps: { runner?: TestRunner },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'changed-file': { type: 'string', multiple: true },
      diff: { type: 'string' },
      python: { type: 'boolean' },
      measure: { type: 'string', multiple: true },
      'scope-mode': { type: 'string' },
      'allow-run': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const projectRoot = positionals[0]
  if (!projectRoot) {
    io.err('coverage run-scoped needs a <project-root>\n')
    return 1
  }
  const scopeMode = values['scope-mode'] ?? 'report-gap'
  if (values.python && scopeMode !== 'report-gap' && scopeMode !== 'widen') {
    io.err(`unknown scope mode: ${scopeMode} (expected report-gap|widen)\n`)
    return 1
  }
  const timeoutRaw = values['timeout-ms']
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined

  try {
    const config = {
      projectRoot,
      // Human-typed root = the operator allowlist (explicit intent), like `api`'s host.
      allowedRoots: [resolve(projectRoot)],
      allowRun: values['allow-run'] ?? false,
      timeoutMs: timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    }
    const changedFiles = values['changed-file'] ?? []
    const diff = values.diff !== undefined ? readFileSync(values.diff, 'utf8') : undefined

    const result = values.python
      ? await runScopedPython(
          config,
          {
            changedFiles,
            diff,
            measureTargets: values.measure ?? [],
            scopeMode: scopeMode as ScopeMode,
          },
          { runner: deps.runner },
        )
      : await runScoped(config, { changedFiles, diff }, { runner: deps.runner })

    const py = values.python ? (result as ScopedPythonResult) : undefined
    if (values.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`)
    } else if (!result.ran) {
      io.out('no changed files — nothing to run\n')
    } else {
      io.out(
        `ran ${values.python ? 'pytest' : 'vitest'} (exit ${result.exitCode}); tests ${
          py?.inconclusive ? 'INCONCLUSIVE' : result.passed ? 'passed' : 'FAILED'
        }; scoped: ${result.scopedFiles.join(', ')}\n`,
      )
      if (py?.unmatched)
        io.out(`uncovered-by-scope (no mirrored test): ${py.unmatched.join(', ')}\n`)
      if (result.report) printReport(io, result.report)
    }
    // 0 only if tests passed, not inconclusive, AND (when a diff was analysed) no new line uncovered.
    const ok =
      result.passed &&
      !py?.inconclusive &&
      (result.report ? result.report.uncovered.length === 0 : true)
    return ok ? 0 : 1
  } catch (e) {
    if (e instanceof CoverageGateError) {
      io.err(`refused: ${e.message} (pass --allow-run)\n`)
      return 1
    }
    io.err(`${(e as Error).message}\n`)
    return 1
  }
}
