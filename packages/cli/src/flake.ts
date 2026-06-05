import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  FlakeGateError,
  type FlakeVerdict,
  HistoryStore,
  Quarantine,
  QuarantineGateError,
  quarantineCandidates,
  runAndRecord,
  runAndRecordPytest,
  type TestRunner,
} from '@sackville/flake'
import type { CliIO } from './index.js'

/**
 * `sackville flake` — the human surface over `@sackville/flake`.
 *
 * Reads (`status`/`candidates`) + `ingest`/`release` are always available against the
 * operator's private run-history DB (`--db`). `run` (spawns vitest) and `quarantine`
 * (the only write) each sit behind their own paired deny-by-default gate. The human IS
 * the operator, so those gates are straight-through flags (`--allow-run` /
 * `--allow-quarantine` + `--max-expiry-ms`), the typed root is auto-allowed, and the
 * vitest runner is injectable so the suite never spawns a real vitest (ADR 0010).
 */
export async function runFlake(
  args: string[],
  io: CliIO,
  deps: { runner?: TestRunner } = {},
): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'status':
      return withStore(rest, io, cmdStatus)
    case 'candidates':
      return withStore(rest, io, cmdCandidates)
    case 'ingest':
      return withStore(rest, io, cmdIngest)
    case 'release':
      return withStore(rest, io, cmdRelease)
    case 'run':
      return withStore(rest, io, (store, a, o) => cmdRun(store, a, o, deps))
    case 'quarantine':
      return withStore(rest, io, cmdQuarantine)
    default:
      io.err(`unknown flake subcommand: ${sub ?? '(none)'}\n`)
      return 1
  }
}

/** Open the operator's history DB (from `--db`/`SACKVILLE_FLAKE_DB`), run the command, close. */
async function withStore(
  args: string[],
  io: CliIO,
  fn: (store: HistoryStore, args: string[], io: CliIO) => number | Promise<number>,
): Promise<number> {
  // `--db` is parsed here too so a missing path is caught before any work; the command
  // re-parses its own flags (parseArgs ignores unknown-but-declared elsewhere is false, so
  // we pass the full args through — each command declares `db` in its own options).
  const dbPath = readDbFlag(args) ?? io.env?.SACKVILLE_FLAKE_DB
  if (!dbPath) {
    io.err('no run-history DB given: pass --db <file> or set SACKVILLE_FLAKE_DB\n')
    return 1
  }
  const store = HistoryStore.open(dbPath)
  try {
    return await fn(store, args, io)
  } finally {
    store.close()
  }
}

/** Pull just `--db <path>` out of an argv without consuming the rest. */
function readDbFlag(args: string[]): string | undefined {
  const i = args.indexOf('--db')
  return i >= 0 ? args[i + 1] : undefined
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function printVerdict(io: CliIO, v: FlakeVerdict): void {
  io.out(
    `  [${v.state}] ${v.id}  runs ${v.runs}  fail ${v.failures}/${v.runs}  score ${v.flakeScore.toFixed(3)}\n`,
  )
}

function cmdStatus(store: HistoryStore, args: string[], io: CliIO): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      'min-runs': { type: 'string' },
      'limit-per-test': { type: 'string' },
      since: { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const verdicts = store.classify({
    minRuns: num(values['min-runs']),
    limitPerTest: num(values['limit-per-test']),
    since: values.since,
  })
  const quarantined = new Quarantine(store, { allowQuarantine: false, maxExpiryMs: 0 }).active()

  if (values.json) {
    const summary: Record<string, number> = {}
    for (const v of verdicts) summary[v.state] = (summary[v.state] ?? 0) + 1
    io.out(`${JSON.stringify({ summary, verdicts, quarantined }, null, 2)}\n`)
    return 0
  }
  const counts = { flaky: 0, reliable: 0, broken: 0, 'insufficient-data': 0 }
  for (const v of verdicts) counts[v.state]++
  io.out(
    `flaky ${counts.flaky}  reliable ${counts.reliable}  broken ${counts.broken}  insufficient-data ${counts['insufficient-data']}\n`,
  )
  if (verdicts.length > 0) {
    io.out('verdicts:\n')
    for (const v of verdicts) printVerdict(io, v)
  }
  if (quarantined.length > 0) {
    io.out(`quarantined (${quarantined.length}):\n`)
    for (const q of quarantined) io.out(`  ${q.testId}  until ${q.expiresAt}  (${q.reason})\n`)
  }
  return 0
}

function cmdCandidates(store: HistoryStore, args: string[], io: CliIO): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      'min-flake-score': { type: 'string' },
      'min-runs': { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const verdicts = store.classify({ minRuns: num(values['min-runs']) })
  const candidates = quarantineCandidates(verdicts, {
    minFlakeScore: num(values['min-flake-score']),
  })

  if (values.json) {
    io.out(`${JSON.stringify({ candidates }, null, 2)}\n`)
    return 0
  }
  if (candidates.length === 0) {
    io.out('no quarantine candidates\n')
    return 0
  }
  io.out(`candidates (${candidates.length}):\n`)
  for (const v of candidates) printVerdict(io, v)
  return 0
}

function cmdIngest(store: HistoryStore, args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      format: { type: 'string' },
      at: { type: 'string' },
      'project-root': { type: 'string' },
      'run-group': { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const reportFile = positionals[0]
  if (!reportFile) {
    io.err('flake ingest needs a <report-file>\n')
    return 1
  }
  const format = values.format ?? 'vitest'
  if (format !== 'vitest' && format !== 'pytest') {
    io.err(`unknown report format: ${format} (expected vitest|pytest)\n`)
    return 1
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  const opts = {
    at: values.at ?? new Date().toISOString(),
    projectRoot: values['project-root'],
    runGroup: values['run-group'],
  }
  const recorded =
    format === 'pytest' ? store.ingestPytestReport(report, opts) : store.ingestReport(report, opts)

  if (values.json) {
    io.out(`${JSON.stringify({ format, recorded }, null, 2)}\n`)
    return 0
  }
  io.out(`recorded ${recorded} run(s) from the ${format} report\n`)
  return 0
}

function cmdRelease(store: HistoryStore, args: string[], io: CliIO): number {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { db: { type: 'string' } },
  })
  const testId = positionals[0]
  if (!testId) {
    io.err('flake release needs a <testId>\n')
    return 1
  }
  const released = new Quarantine(store, { allowQuarantine: false, maxExpiryMs: 0 }).release(testId)
  io.out(released ? `released ${testId}\n` : `${testId} was not quarantined\n`)
  return 0
}

async function cmdRun(
  store: HistoryStore,
  args: string[],
  io: CliIO,
  deps: { runner?: TestRunner },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      framework: { type: 'string' },
      repeat: { type: 'string' },
      file: { type: 'string', multiple: true },
      'run-group': { type: 'string' },
      'allow-run': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const projectRoot = positionals[0]
  if (!projectRoot) {
    io.err('flake run needs a <project-root>\n')
    return 1
  }
  const framework = values.framework ?? 'vitest'
  if (framework !== 'vitest' && framework !== 'pytest') {
    io.err(`unknown framework: ${framework} (expected vitest|pytest)\n`)
    return 1
  }
  try {
    const run = framework === 'pytest' ? runAndRecordPytest : runAndRecord
    const result = await run(
      store,
      {
        projectRoot,
        allowedRoots: [resolve(projectRoot)],
        allowRun: values['allow-run'] ?? false,
        timeoutMs: num(values['timeout-ms']),
      },
      { repeat: num(values.repeat) ?? 1, files: values.file, runGroup: values['run-group'] },
      { runner: deps.runner },
    )
    if (values.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }
    io.out(`ran ${result.iterations} iteration(s); recorded ${result.recorded} run(s)\n`)
    for (const v of result.verdicts) printVerdict(io, v)
    return 0
  } catch (e) {
    if (e instanceof FlakeGateError) {
      io.err(`refused: ${e.message} (pass --allow-run)\n`)
      return 1
    }
    io.err(`${(e as Error).message}\n`)
    return 1
  }
}

function cmdQuarantine(store: HistoryStore, args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      reason: { type: 'string' },
      'expires-at': { type: 'string' },
      'flake-score': { type: 'string' },
      'allow-quarantine': { type: 'boolean' },
      'max-expiry-ms': { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const testId = positionals[0]
  if (!testId || !values.reason || !values['expires-at']) {
    io.err('flake quarantine needs <testId> --reason <r> --expires-at <ISO>\n')
    return 1
  }
  const policy = {
    allowQuarantine: values['allow-quarantine'] ?? false,
    maxExpiryMs: num(values['max-expiry-ms']) ?? 0,
  }
  try {
    const entry = new Quarantine(store, policy).quarantine({
      testId,
      reason: values.reason,
      expiresAt: values['expires-at'],
      flakeScore: num(values['flake-score']),
    })
    if (values.json) {
      io.out(`${JSON.stringify({ entry }, null, 2)}\n`)
      return 0
    }
    io.out(`quarantined ${entry.testId} until ${entry.expiresAt}  (${entry.reason})\n`)
    return 0
  } catch (e) {
    if (e instanceof QuarantineGateError) {
      io.err(`refused: ${e.message} (pass --allow-quarantine and --max-expiry-ms)\n`)
      return 1
    }
    io.err(`${(e as Error).message}\n`)
    return 1
  }
}
