import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ArtifactStore,
  type ContractResult,
  type ImportFormat,
  importToCollection,
  isGraphqlEnvelope,
  loadCollection,
  resolveSecretStore,
  runRequest,
  runSequence,
  type SecretStore,
  validateCapturedTraffic,
  validateGraphqlOperation,
  validateOpenApiRequest,
  validateOpenApiResponse,
} from '@strummer/api'
import type { CliIO } from './index.js'

/** Matches `{{secret:NAME}}` references; captures the NAME only (never a value). */
const SECRET_RE = /\{\{\s*secret:\s*([^}\s]+)\s*\}\}/g

/** Collect sorted, unique secret NAMES referenced anywhere in a string. */
function secretNames(...sources: (string | undefined)[]): string[] {
  const names = new Set<string>()
  for (const s of sources) {
    if (!s) continue
    for (const m of s.matchAll(SECRET_RE)) {
      if (m[1]) names.add(m[1])
    }
  }
  return [...names].sort()
}

/** Replace `{{secret:NAME}}` references with a `[secret:NAME]` placeholder. */
function maskSecrets(s: string): string {
  return s.replace(SECRET_RE, (_m, name) => `[secret:${name}]`)
}

/** Parse repeatable `--var k=v` flags (split on the FIRST `=`) into a record. */
function parseVars(raw: string[] | undefined): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const item of raw ?? []) {
    const eq = item.indexOf('=')
    if (eq === -1) {
      vars[item] = ''
    } else {
      vars[item.slice(0, eq)] = item.slice(eq + 1)
    }
  }
  return vars
}

export async function runApi(args: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'list':
      return cmdList(rest, io)
    case 'get':
      return cmdGet(rest, io)
    case 'run':
      return cmdRun(rest, io)
    case 'run-collection':
      return cmdRunCollection(rest, io)
    case 'validate':
      return cmdValidate(rest, io)
    case 'validate-request':
      return cmdValidateRequest(rest, io)
    case 'validate-capture':
      return cmdValidateCapture(rest, io)
    case 'import':
      return cmdImport(rest, io)
    default:
      io.err(`unknown api subcommand: ${sub ?? '(none)'}\n`)
      return 1
  }
}

function cmdList(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  })
  const dir = positionals[0]
  if (!dir) {
    io.err('api list needs <dir>\n')
    return 1
  }
  const collection = loadCollection(dir)
  const requests = [...collection.requests.values()].map((e) => ({
    name: e.request.name,
    method: e.request.method,
    url: e.request.url,
  }))
  if (values.json) {
    io.out(`${JSON.stringify({ requests }, null, 2)}\n`)
    return 0
  }
  for (const r of requests) {
    io.out(`${r.method}  ${r.name}  ${r.url}\n`)
  }
  return 0
}

function cmdGet(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  })
  const [dir, name] = positionals
  if (!dir || !name) {
    io.err('api get needs <dir> <name>\n')
    return 1
  }
  const collection = loadCollection(dir)
  const entry = collection.requests.get(name)
  if (!entry) {
    io.err(`no request named ${name}\n`)
    return 1
  }
  const { request } = entry
  // Secret NAMES referenced in url/headers/body — never their values.
  const secrets = secretNames(
    request.url,
    ...request.headers.flatMap((h) => [h.name, h.value]),
    request.body?.content,
  )
  if (values.json) {
    io.out(
      `${JSON.stringify(
        {
          name: request.name,
          method: request.method,
          url: request.url,
          headers: request.headers,
          requiredSecrets: secrets,
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }
  // Show headers but mask secret references so the value column never carries a
  // `{{secret:NAME}}` template (the required-secrets line is the canonical list).
  io.out(`${request.method}  ${maskSecrets(request.url)}\n`)
  for (const h of request.headers) {
    io.out(`  ${h.name}: ${maskSecrets(h.value)}\n`)
  }
  io.out(`required secrets: ${secrets.length ? secrets.join(', ') : '(none)'}\n`)
  return 0
}

/** Shared run-option flags for `run` and `run-collection`. */
const RUN_OPTIONS = {
  var: { type: 'string', multiple: true },
  env: { type: 'string' },
  unsafe: { type: 'boolean' },
  'allow-host': { type: 'string', multiple: true },
  'block-private': { type: 'boolean' },
  'max-redirects': { type: 'string' },
  keyring: { type: 'boolean' },
  json: { type: 'boolean' },
} as const

/** Parse `--max-redirects` (a non-negative integer) or undefined. */
function parseMaxRedirects(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/** Secret store for a run: opt into the OS keyring (chained ahead of env) with
 * `--keyring`, else the env default (`STRUMMER_SECRET_<NAME>`). */
function secretsFor(keyring: boolean | undefined): SecretStore | undefined {
  return keyring ? resolveSecretStore({ keyring: true }) : undefined
}

/** Read a stored response body by handle and JSON-parse it; fall back to raw. */
function parseStoredBody(artifacts: ArtifactStore, handle: string): unknown {
  const raw = artifacts.get(handle)?.body ?? ''
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function printContract(io: CliIO, contract: ContractResult): void {
  io.out(`contract: ${contract.valid ? 'valid' : 'INVALID'}\n`)
  for (const f of contract.findings) {
    io.out(`  ${f.severity.toUpperCase()} ${f.kind}: ${f.message}${f.path ? ` (${f.path})` : ''}\n`)
  }
}

async function cmdRun(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...RUN_OPTIONS, openapi: { type: 'string' } },
  })
  const [dir, name] = positionals
  if (!dir || !name) {
    io.err('api run needs <dir> <name>\n')
    return 1
  }
  const collection = loadCollection(dir)
  if (!collection.requests.has(name)) {
    io.err(`no request named ${name}\n`)
    return 1
  }
  const artifacts = new ArtifactStore()
  // --unsafe/--allow-host are operator (human) controlled here — correct for a
  // CLI the human runs; pass them straight through to the engine.
  const result = await runRequest(collection, name, {
    vars: parseVars(values.var),
    env: values.env,
    allowUnsafe: values.unsafe ?? false,
    allowedHosts: values['allow-host'],
    allowPrivate: !values['block-private'],
    maxRedirects: parseMaxRedirects(values['max-redirects']),
    secrets: secretsFor(values.keyring),
    artifacts,
  })

  let contract: ContractResult | undefined
  if (values.openapi && result.sent && result.response) {
    const spec = JSON.parse(readFileSync(values.openapi, 'utf8'))
    const url = new URL(result.request.url)
    contract = validateOpenApiResponse(
      spec,
      { method: result.request.method, path: url.pathname },
      {
        status: result.response.status,
        headers: result.response.headers,
        body: parseStoredBody(artifacts, result.response.bodyHandle),
      },
      // External local-file $refs resolve relative to the spec file's directory.
      { baseDir: dirname(values.openapi) },
    )
  }

  // Return code: 0 only if SENT and every assertion passed and (if validated)
  // the contract is valid; 1 otherwise — including a dry-run, since a withheld
  // request verified nothing.
  const assertionsOk = !!result.response?.assertions.every((a) => a.pass)
  const ok = result.sent && assertionsOk && (contract ? contract.valid : true)

  if (values.json) {
    io.out(`${JSON.stringify(contract ? { ...result, contract } : result, null, 2)}\n`)
    return ok ? 0 : 1
  }

  io.out(`${result.request.method}  ${result.request.url}\n`)
  if (result.sent) {
    io.out('sent\n')
  } else {
    io.out(`dry-run (not sent)${result.reason ? `: ${result.reason}` : ''}\n`)
  }
  if (result.response) {
    const res = result.response
    io.out(`status ${res.status}  ${res.latencyMs}ms\n`)
    for (const a of res.assertions) {
      io.out(`${a.pass ? 'PASS' : 'FAIL'}  ${a.source} ${a.op}${a.path ? ` ${a.path}` : ''}\n`)
    }
    for (const t of res.scriptTests) {
      io.out(`${t.pass ? 'PASS' : 'FAIL'}  script: ${t.name}${t.error ? ` — ${t.error}` : ''}\n`)
    }
    io.out(`body: ${res.bodyHandle}\n`)
  }
  if (contract) printContract(io, contract)
  return ok ? 0 : 1
}

async function cmdRunCollection(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...RUN_OPTIONS, 'stop-on-failure': { type: 'boolean' } },
  })
  const [dir, ...names] = positionals
  if (!dir || names.length === 0) {
    io.err('api run-collection needs <dir> <name...>\n')
    return 1
  }
  const artifacts = new ArtifactStore()
  const result = await runSequence(loadCollection(dir), names, {
    vars: parseVars(values.var),
    env: values.env,
    allowUnsafe: values.unsafe ?? false,
    allowedHosts: values['allow-host'],
    allowPrivate: !values['block-private'],
    maxRedirects: parseMaxRedirects(values['max-redirects']),
    secrets: secretsFor(values.keyring),
    stopOnFailure: values['stop-on-failure'] ?? false,
    artifacts,
  })

  // 0 only if every SENT step passed its assertions.
  const ok = result.steps.every(
    (s) => s.result.sent && (s.result.response?.assertions.every((a) => a.pass) ?? false),
  )

  if (values.json) {
    io.out(`${JSON.stringify(result, null, 2)}\n`)
    return ok ? 0 : 1
  }

  for (const step of result.steps) {
    const res = step.result
    const status = res.sent ? String(res.response?.status ?? '-') : 'dry-run'
    const passed = res.sent && (res.response?.assertions.every((a) => a.pass) ?? false)
    io.out(`${step.name}  ${status}  ${passed ? 'PASS' : 'FAIL'}\n`)
  }
  io.out(`captured: ${Object.keys(result.captured).join(', ') || '(none)'}\n`)
  return ok ? 0 : 1
}

const IMPORT_FORMATS = new Set<ImportFormat>(['postman', 'insomnia', 'openapi', 'har'])

function cmdImport(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { name: { type: 'string' } },
  })
  const [format, source, dest] = positionals
  if (!format || !source || !dest) {
    io.err('api import needs <postman|insomnia|openapi|har> <source-file> <dest-dir>\n')
    return 1
  }
  if (!IMPORT_FORMATS.has(format as ImportFormat)) {
    io.err(`unknown import format: ${format} (expected postman|insomnia|openapi|har)\n`)
    return 1
  }
  const text = readFileSync(source, 'utf8')
  const count = importToCollection(format as ImportFormat, text, dest, { name: values.name })
  io.out(`imported ${count} request(s) into ${dest}\n`)
  return 0
}

function cmdValidate(args: string[], io: CliIO): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      graphql: { type: 'string' },
      query: { type: 'string' },
      operation: { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  if (!values.graphql || !values.query) {
    io.err('api validate needs --graphql <schemafile> --query <queryfile>\n')
    return 1
  }
  const sdl = readFileSync(values.graphql, 'utf8')
  const query = readFileSync(values.query, 'utf8')
  const contract = validateGraphqlOperation(sdl, query, { operationName: values.operation })

  if (values.json) {
    io.out(`${JSON.stringify(contract, null, 2)}\n`)
    return contract.valid ? 0 : 1
  }
  io.out(`valid: ${contract.valid}\n`)
  for (const f of contract.findings) {
    io.out(`  ${f.severity.toUpperCase()} ${f.kind}: ${f.message}${f.path ? ` (${f.path})` : ''}\n`)
  }
  return contract.valid ? 0 : 1
}

/**
 * `api validate-request --openapi <spec.json> --method <M> --path </p> [--body <file>]
 * [--query k=v]…` — a preflight: validate a request's body + params against an OpenAPI
 * operation BEFORE sending it. The human supplies the real request, so body presence
 * and params are authoritative. (A GraphQL envelope is refused, not schema-failed.)
 */
function cmdValidateRequest(args: string[], io: CliIO): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      openapi: { type: 'string' },
      method: { type: 'string' },
      path: { type: 'string' },
      body: { type: 'string' },
      query: { type: 'string', multiple: true },
      header: { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  })
  if (!values.openapi || !values.method || !values.path) {
    io.err('api validate-request needs --openapi <spec.json> --method <M> --path </p>\n')
    return 1
  }
  const spec = JSON.parse(readFileSync(values.openapi, 'utf8'))
  const body = values.body !== undefined ? JSON.parse(readFileSync(values.body, 'utf8')) : undefined
  if (isGraphqlEnvelope(body)) {
    io.err(
      'the request body is a GraphQL envelope ({query}); use `api validate --graphql` instead\n',
    )
    return 1
  }
  // `--query name=value` (repeatable; repeated names collect into an array).
  const query: Record<string, string | string[]> = {}
  for (const kv of values.query ?? []) {
    const eq = kv.indexOf('=')
    if (eq < 0) continue
    const k = kv.slice(0, eq)
    const v = kv.slice(eq + 1)
    const cur = query[k]
    query[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v]
  }
  // `--header name:value` (repeatable), lower-cased.
  const headers: Record<string, string> = {}
  for (const hv of values.header ?? []) {
    const c = hv.indexOf(':')
    if (c < 0) continue
    headers[hv.slice(0, c).trim().toLowerCase()] = hv.slice(c + 1).trim()
  }

  const contract = validateOpenApiRequest(
    spec,
    {
      method: values.method,
      path: values.path,
      body,
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    {
      baseDir: dirname(values.openapi),
      bodyPresenceAuthoritative: true,
      paramsAuthoritative: true,
    },
  )

  if (values.json) {
    io.out(`${JSON.stringify(contract, null, 2)}\n`)
    return contract.valid ? 0 : 1
  }
  io.out(`valid: ${contract.valid}\n`)
  for (const f of contract.findings) {
    io.out(`  ${f.severity.toUpperCase()} ${f.kind}: ${f.message}${f.path ? ` (${f.path})` : ''}\n`)
  }
  return contract.valid ? 0 : 1
}

/**
 * `api validate-capture <har.zip> --openapi <spec.json> | --graphql <schema.graphql>`
 * — validate the traffic in a captured HAR against an OpenAPI and/or GraphQL
 * contract (ADR 0013, the capture→contract bridge). The human is the operator, so
 * the local HAR file is read directly (no surface capture gate). REST entries are
 * checked against the OpenAPI spec; GraphQL entries (at `--graphql-endpoint`,
 * default `/graphql`) are checked against the SDL. Exits 1 when not clean.
 */
function cmdValidateCapture(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      openapi: { type: 'string' },
      graphql: { type: 'string' },
      'graphql-endpoint': { type: 'string' },
      origin: { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  })
  const [harPath] = positionals
  if (!harPath || (!values.openapi && !values.graphql)) {
    io.err(
      'api validate-capture needs <har.zip> and --openapi <spec.json> and/or --graphql <schema.graphql>\n',
    )
    return 1
  }
  const harZip = readFileSync(harPath)
  const contract: import('@strummer/api').CaptureContract = {
    ...(values.openapi ? { openapi: JSON.parse(readFileSync(values.openapi, 'utf8')) } : {}),
    ...(values.graphql
      ? {
          graphql: {
            endpointPath: values['graphql-endpoint'] ?? '/graphql',
            sdl: readFileSync(values.graphql, 'utf8'),
          },
        }
      : {}),
  }
  const verdict = validateCapturedTraffic(harZip, contract, {
    allowedOrigins: values.origin,
  })

  if (values.json) {
    io.out(`${JSON.stringify(verdict, null, 2)}\n`)
    return verdict.clean ? 0 : 1
  }
  io.out(
    `capture: ${verdict.clean ? 'clean' : 'NOT CLEAN'} (${verdict.entriesValidated} entries)\n`,
  )
  for (const [kind, count] of Object.entries(verdict.findingsByKind)) {
    io.out(`  ${count}× ${kind}\n`)
  }
  if (verdict.firstFailing) {
    const f = verdict.firstFailing
    io.out(`  first failing: ${f.method} ${f.path} — ${f.kind}: ${f.message}\n`)
  }
  io.out(`  exercised: ${verdict.exercisedOperations.join(', ') || '(none)'}\n`)
  if (verdict.unexercisedOperations.length > 0) {
    io.out(`  unexercised: ${verdict.unexercisedOperations.join(', ')}\n`)
  }
  return verdict.clean ? 0 : 1
}
