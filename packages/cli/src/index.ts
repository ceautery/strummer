import { parseArgs } from 'node:util'
import {
  detectInstalledVersion,
  type Ecosystem,
  getDoc,
  listVersions,
  openDb,
  resolveVersion,
  searchDocs,
} from '@strummer/core'
import type { Embedder } from '@strummer/embed'
import type DatabaseType from 'better-sqlite3'
import { runApi } from './api.js'
import { runBrowser } from './browser.js'
import { runCoverage } from './coverage.js'
import { runDeps } from './deps.js'
import { runFlake } from './flake.js'
import { runLsp } from './lsp.js'
import { runMutate } from './mutate.js'

/** Output sinks and dependencies injected into `run` (so it is testable). */
export interface CliIO {
  out: (text: string) => void
  err: (text: string) => void
  /** When present, queries are embedded for hybrid search. */
  embedder?: Embedder
  env?: Record<string, string | undefined>
}

const HELP = `strummer — version-pinned documentation search

Usage:
  strummer search <query…>  [-l <lib>] [--version <v>] [--installed <v>] [-p <dir>] [--ecosystem <e>] [--type <t>] [--limit <n>] [--json]
  strummer get <id>         [--json]
  strummer versions <library>
  strummer detect <project> <library>  [--ecosystem <node|python|ruby>]

API testing:
  strummer api list <dir>                               [--json]
  strummer api get <dir> <name>                         [--json]
  strummer api run <dir> <name>                         [--var k=v…] [--env <e>] [--unsafe] [--allow-host <h>…] [--keyring] [--block-private] [--max-redirects <n>] [--openapi <spec.json>] [--json]
  strummer api run-collection <dir> <name…>             [--var k=v…] [--env <e>] [--unsafe] [--allow-host <h>…] [--keyring] [--block-private] [--max-redirects <n>] [--stop-on-failure] [--json]
  strummer api validate --graphql <schema> --query <q>  [--operation <name>] [--json]
  strummer api import <postman|insomnia|openapi|har> <source-file> <dest-dir>  [--name <n>]

Browser testing (single-shot; the typed host is auto-allowed):
  strummer browser snapshot <url>    [--allow-host <h>…] [--allow-private] [--no-sandbox] [--headed] [--engine chromium|firefox|webkit] [--json]
  strummer browser audit <url>       [same flags]   (exit 1 if any a11y violations)
  strummer browser screenshot <url>  [--out <file>] [--full-page] [same flags]
  strummer browser run <flow.bru>    [--var k=v…] [--unsafe] [--allow-host <h>…] [same flags]  (replay a persisted flow; exit 1 on failure)

Mutation testing:
  strummer mutate summarize <report-file>  [--format stryker|mutmut] [--json]
  strummer mutate run <project-root>        [--file <f>…] [--incremental] [--allow-run] [--timeout-ms <n>] [--report-path <p>] [--json]  (gated; needs --allow-run)

Coverage (impact-scoped; exit 1 when a new line is uncovered):
  strummer coverage uncovered-in-diff --diff <file> --coverage <file>  [--coverage-format istanbul|coveragepy] [--project-root <p>] [--json]
  strummer coverage run-scoped <project-root>  --changed-file <f>…  [--diff <file>] [--allow-run] [--timeout-ms <n>] [--json]  (gated; needs --allow-run)

Flaky-test detection (--db <run-history.db> or STRUMMER_FLAKE_DB):
  strummer flake status                  [--min-runs <n>] [--limit-per-test <n>] [--since <ISO>] [--json]
  strummer flake candidates              [--min-flake-score <0..1>] [--min-runs <n>] [--json]
  strummer flake ingest <report-file>    [--format vitest|pytest] [--at <ISO>] [--project-root <p>] [--run-group <g>] [--json]
  strummer flake release <testId>
  strummer flake run <project-root>      [--repeat <n>] [--file <f>…] [--run-group <g>] [--allow-run] [--timeout-ms <n>] [--json]  (gated)
  strummer flake quarantine <testId>     --reason <r> --expires-at <ISO> [--flake-score <s>] [--allow-quarantine] [--max-expiry-ms <n>] [--json]  (gated write)

Dependency/version intelligence (for the INSTALLED version; exit 1 on a finding):
  strummer deps audit <project> <package>  [--ecosystem npm|PyPI|RubyGems] [--version <v>] [--osv-db <dir>] [--registry <url>] [--allow-private] [--json]
  strummer deps audit-project <project>     [--ecosystem <e>] [--skip-dev] [--osv-db <dir>] [--registry <url>] [--allow-private] [--json]
  strummer deps changelog <package>         (--from <v> | --project <dir>) [--to <v>] [--ecosystem <e>] [--registry <url>] [--json]

Semantic code navigation (LSP; single-shot; --servers <json> or STRUMMER_LSP_SERVERS binds the server registry):
  strummer lsp languages                                          [--servers <json>] [--json]
  strummer lsp definition|type-definition|references|hover <lang> <file> <line> <col>  --project <dir> --allow-run [--servers <json>] [--timeout-ms <n>] [--json]
  strummer lsp symbols <lang> <file>                              --project <dir> --allow-run [--servers <json>] [--json]
  strummer lsp call-hierarchy <lang> <file> <line> <col>          --project <dir> --allow-run [--direction incoming|outgoing] [--json]
  strummer lsp rename <lang> <file> <line> <col> <newName>        --project <dir> --allow-run [--allow-write] [--json]  (dry-run unless --allow-write)
  (exit 2 = server still indexing, retry)

Global:
  -i, --index <file>   index to query (or set STRUMMER_INDEX)
`

export async function run(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'search':
      return cmdSearch(rest, io)
    case 'get':
      return cmdGet(rest, io)
    case 'versions':
      return cmdVersions(rest, io)
    case 'detect':
      return cmdDetect(rest, io)
    case 'api':
      return runApi(rest, io)
    case 'browser':
      return runBrowser(rest, io)
    case 'mutate':
      return runMutate(rest, io)
    case 'coverage':
      return runCoverage(rest, io)
    case 'flake':
      return runFlake(rest, io)
    case 'deps':
      return runDeps(rest, io)
    case 'lsp':
      return runLsp(rest, io)
    case 'help':
    case '--help':
    case '-h':
      io.out(HELP)
      return 0
    case undefined:
      io.err(HELP)
      return 1
    default:
      io.err(`unknown command: ${command}\n`)
      io.err(HELP)
      return 1
  }
}

function openIndex(indexFlag: string | undefined, io: CliIO): DatabaseType.Database | null {
  const path = indexFlag ?? io.env?.STRUMMER_INDEX
  if (!path) {
    io.err('no index given: pass --index <file> or set STRUMMER_INDEX\n')
    return null
  }
  return openDb(path)
}

async function cmdSearch(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      index: { type: 'string', short: 'i' },
      library: { type: 'string', short: 'l' },
      version: { type: 'string' },
      installed: { type: 'string' },
      project: { type: 'string', short: 'p' },
      ecosystem: { type: 'string' },
      type: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const query = positionals.join(' ').trim()
  if (!query) {
    io.err('search needs a query\n')
    return 1
  }
  const db = openIndex(values.index, io)
  if (!db) return 1

  try {
    // Version precedence: --version > --installed > --project (auto-detect).
    let effectiveVersion = values.version
    let note: string | undefined
    if (!values.version && (values.installed || values.project) && values.library) {
      let requested = values.installed
      if (!requested && values.project) {
        const detected = detectInstalledVersion(values.project, values.library, {
          ecosystem: values.ecosystem as Ecosystem | undefined,
        })
        requested = detected.version ?? undefined
        if (!requested) note = `could not detect ${values.library} in ${values.project}`
      }
      if (requested) {
        const res = resolveVersion(listVersions(db, values.library), requested)
        note = res.note
        if (res.resolved) effectiveVersion = res.resolved
      }
    }

    let queryVector: number[] | undefined
    if (io.embedder) {
      try {
        queryVector = await io.embedder.embed(query)
      } catch {
        queryVector = undefined
      }
    }

    const results = searchDocs(db, query, {
      library: values.library,
      version: effectiveVersion,
      type: values.type,
      limit: values.limit ? Number(values.limit) : undefined,
      queryVector,
    })

    if (values.json) {
      io.out(
        `${JSON.stringify({ query, version: effectiveVersion ?? null, note, results }, null, 2)}\n`,
      )
      return 0
    }
    if (note) io.err(`${note}\n`)
    if (results.length === 0) {
      io.out('no matches\n')
      return 0
    }
    for (const r of results) {
      const sym = r.symbol ? `  (${r.symbol})` : ''
      io.out(`${r.version}  [${r.type ?? '-'}]  ${r.title}${sym}\n`)
      io.out(`    ${r.snippet}\n`)
      io.out(`    strummer://doc/${r.id}\n`)
    }
    return 0
  } finally {
    db.close()
  }
}

function cmdGet(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { index: { type: 'string', short: 'i' }, json: { type: 'boolean' } },
  })
  const id = Number(positionals[0])
  if (!Number.isInteger(id)) {
    io.err('get needs a numeric id\n')
    return 1
  }
  const db = openIndex(values.index, io)
  if (!db) return 1
  try {
    const doc = getDoc(db, id)
    if (!doc) {
      io.err(`no document with id ${id}\n`)
      return 1
    }
    if (values.json) {
      io.out(`${JSON.stringify(doc, null, 2)}\n`)
      return 0
    }
    io.out(`${doc.title}  [${doc.type ?? '-'}]  ${doc.library} ${doc.version}\n`)
    if (doc.headingPath) io.out(`${doc.headingPath}\n`)
    if (doc.url) io.out(`${doc.url}\n`)
    io.out(`\n${doc.body}\n`)
    if (doc.attribution) io.out(`\n— ${doc.attribution}\n`)
    return 0
  } finally {
    db.close()
  }
}

function cmdVersions(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { index: { type: 'string', short: 'i' } },
  })
  const library = positionals[0]
  if (!library) {
    io.err('versions needs a library\n')
    return 1
  }
  const db = openIndex(values.index, io)
  if (!db) return 1
  try {
    const versions = listVersions(db, library)
    io.out(versions.length ? `${versions.join('\n')}\n` : `no versions indexed for ${library}\n`)
    return 0
  } finally {
    db.close()
  }
}

function cmdDetect(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { index: { type: 'string', short: 'i' }, ecosystem: { type: 'string' } },
  })
  const [project, library] = positionals
  if (!project || !library) {
    io.err('detect needs <project> <library>\n')
    return 1
  }
  const db = openIndex(values.index, io)
  if (!db) return 1
  try {
    const detected = detectInstalledVersion(project, library, {
      ecosystem: values.ecosystem as Ecosystem | undefined,
    })
    const res = resolveVersion(listVersions(db, library), detected.version ?? '')
    io.out(`detected: ${detected.version ?? '(none)'} (${detected.source})\n`)
    io.out(`resolved: ${res.resolved ?? '(none)'}\n`)
    io.out(`${res.note}\n`)
    return 0
  } finally {
    db.close()
  }
}
