/**
 * The gated LSP query engine (ADR 0011, slice 4) — the agent-facing entry that ties the
 * operator gate, the `LanguageServerManager`, and the encoding core together. Mirrors
 * coverage's `runScoped`: a **paired deny-by-default operator gate** (`allowRun` +
 * `allowedRoots` + the manager's per-request deadline), because every navigation answer
 * requires a live, code-executing, indexing daemon to exist. There is **no "free read" tier**
 * here — unlike `search_docs`/`list_requests`.
 *
 * The engine owns the I/O the protocol-level client must not: it **confines the queried file
 * to the project root** (no traversal), reads its text, converts the human 1-based line:col to
 * a 0-based LSP `Position` in the server's **negotiated encoding**, drives `manager.run`, and
 * maps the result ranges back to human 1-based line:col (reading each target file's text for an
 * encoding-faithful inverse; best-effort `+1` fallback when a target — e.g. a dep's `.d.ts` —
 * is unreadable). Tri-state status passes through untouched (never collapse `not_ready` into
 * "no result"). `serverInfo` provenance rides on every result; its absence is surfaced as a
 * `versionWarning` (an answer that cannot be attributed to a server version). The richer
 * warn-on-toolchain-mismatch heuristic (reusing `core.detectInstalledVersion`) is staged to the
 * surface, which can pass detected `toolchain` provenance to echo here.
 */

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { NavResult, ServerInfo } from './client.js'
import {
  fromLspPosition,
  type HumanPosition,
  type PositionEncoding,
  toLspPosition,
} from './encoding.js'
import type { LanguageServerManager } from './manager.js'
import type { LspRange, NormalizedHover, NormalizedLocation, QueryStatus } from './normalize.js'

/** Thrown when the paired operator gate denies a query (allowRun off, root/file out of bounds). */
export class LspGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspGateError'
  }
}

/** Reads a file's text, or `undefined` if it cannot be read. */
export type FileReader = (absolutePath: string) => string | undefined

const defaultReadFile: FileReader = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

export interface LspQueryEngineOptions {
  manager: LanguageServerManager
  /** OPERATOR opt-in to run navigation (which requires a live indexing daemon). Deny-by-default. */
  allowRun: boolean
  /** OPERATOR allowlist of project roots. Load-bearing even with allowRun. */
  allowedRoots: string[]
  /** Injected file reader (default `readFileSync`). */
  readFile?: FileReader
}

export type LspQueryKind = 'definition' | 'references' | 'hover'

export interface LspQueryInput {
  /** The agent-facing language (resolved against the operator registry). */
  language: string
  /** Project root — must be in `allowedRoots`; pinned to the server's `rootUri`. */
  projectRoot: string
  /** The file to query, relative to `projectRoot` (or absolute within it). */
  file: string
  /** 1-based human line. */
  line: number
  /** 1-based human column (counts Unicode code points). */
  column: number
  kind: LspQueryKind
  /** Optional toolchain provenance to echo (the surface computes via `detectInstalledVersion`). */
  toolchain?: { name: string; version: string | null }
}

export interface HumanRange {
  start: HumanPosition
  end: HumanPosition
}

export interface ResultLocation {
  uri: string
  range: HumanRange
  /** The full enclosing range, when the server sent a LocationLink. */
  fullRange?: HumanRange
  /** False ⇒ the target file was unreadable; the range is a best-effort `+1` of the LSP offsets. */
  mapped: boolean
}

export interface LspQueryResult {
  status: QueryStatus
  kind: LspQueryKind
  locations?: ResultLocation[]
  hover?: { value: string; range?: HumanRange }
  serverInfo?: ServerInfo
  toolchain?: { name: string; version: string | null }
  encoding: PositionEncoding
  versionWarning?: string
}

export class LspQueryEngine {
  private readonly manager: LanguageServerManager
  private readonly allowRun: boolean
  private readonly allowedRoots: string[]
  private readonly readFile: FileReader

  constructor(options: LspQueryEngineOptions) {
    this.manager = options.manager
    this.allowRun = options.allowRun
    this.allowedRoots = options.allowedRoots
    this.readFile = options.readFile ?? defaultReadFile
  }

  async query(input: LspQueryInput): Promise<LspQueryResult> {
    this.assertAllowed(input.projectRoot)
    const absFile = this.confineFile(input.projectRoot, input.file)
    const text = this.readFile(absFile)
    if (text === undefined) {
      throw new LspGateError(`cannot read file ${input.file} in ${input.projectRoot}`)
    }
    const uri = pathToFileURL(absFile).toString()

    const nav = await this.manager.run<
      NavResult<NormalizedLocation[]> | NavResult<NormalizedHover | null>
    >(
      { language: input.language, projectRoot: input.projectRoot, uri, text },
      (client): Promise<NavResult<NormalizedLocation[]> | NavResult<NormalizedHover | null>> => {
        const pos = toLspPosition(text, input.line, input.column, client.encoding)
        switch (input.kind) {
          case 'definition':
            return client.definition(uri, pos)
          case 'references':
            return client.references(uri, pos)
          case 'hover':
            return client.hover(uri, pos)
        }
      },
    )

    return this.shape(input, nav, uri, text)
  }

  private shape(
    input: LspQueryInput,
    nav: NavResult<NormalizedLocation[]> | NavResult<NormalizedHover | null>,
    queriedUri: string,
    queriedText: string,
  ): LspQueryResult {
    const { encoding, serverInfo } = nav
    const versionWarning =
      serverInfo === undefined
        ? 'the language server did not report its version (serverInfo); the answer cannot be attributed to a specific server version'
        : undefined

    const base: LspQueryResult = {
      status: nav.status,
      kind: input.kind,
      encoding,
      ...(serverInfo ? { serverInfo } : {}),
      ...(input.toolchain ? { toolchain: input.toolchain } : {}),
      ...(versionWarning ? { versionWarning } : {}),
    }

    if (input.kind === 'hover') {
      const hover = (nav as NavResult<NormalizedHover | null>).result
      if (!hover) return base
      return {
        ...base,
        hover: {
          value: hover.value,
          // A hover range is in the QUERIED document.
          ...(hover.range ? { range: this.mapRange(queriedText, hover.range, encoding) } : {}),
        },
      }
    }

    const locations = (nav as NavResult<NormalizedLocation[]>).result
    const cache = new Map<string, string | undefined>()
    return {
      ...base,
      locations: locations.map((loc) =>
        this.mapLocation(loc, encoding, queriedUri, queriedText, cache),
      ),
    }
  }

  private mapLocation(
    loc: NormalizedLocation,
    encoding: PositionEncoding,
    queriedUri: string,
    queriedText: string,
    cache: Map<string, string | undefined>,
  ): ResultLocation {
    // The target file's OWN text is needed for an encoding-faithful inverse; a definition
    // legitimately lives in another file (incl. a dependency outside the project root), so
    // reading it for line:col mapping is read-only and not gated.
    const text = loc.uri === queriedUri ? queriedText : this.textForUri(loc.uri, cache)
    return {
      uri: loc.uri,
      range: this.mapRange(text, loc.range, encoding),
      ...(loc.fullRange ? { fullRange: this.mapRange(text, loc.fullRange, encoding) } : {}),
      mapped: text !== undefined,
    }
  }

  private textForUri(uri: string, cache: Map<string, string | undefined>): string | undefined {
    if (cache.has(uri)) return cache.get(uri)
    let text: string | undefined
    try {
      text = this.readFile(fileURLToPath(uri))
    } catch {
      text = undefined // a non-file:// uri (e.g. an in-memory or jdt:// scheme)
    }
    cache.set(uri, text)
    return text
  }

  /** Map an LSP 0-based range to a human 1-based range, encoding-faithfully when text is known. */
  private mapRange(
    text: string | undefined,
    range: LspRange,
    encoding: PositionEncoding,
  ): HumanRange {
    if (text === undefined) {
      // Best-effort fallback: the file is unreadable, so we cannot count code units — surface
      // the raw LSP offsets +1 (documented; `mapped:false` flags it).
      return {
        start: { line: range.start.line + 1, column: range.start.character + 1 },
        end: { line: range.end.line + 1, column: range.end.character + 1 },
      }
    }
    return {
      start: fromLspPosition(text, range.start, encoding),
      end: fromLspPosition(text, range.end, encoding),
    }
  }

  private assertAllowed(projectRoot: string): void {
    if (!this.allowRun) {
      throw new LspGateError('LSP navigation is not enabled (the operator must set allowRun)')
    }
    const root = resolve(projectRoot)
    if (!this.allowedRoots.map((r) => resolve(r)).includes(root)) {
      throw new LspGateError(`project root ${projectRoot} is not in the operator allowlist`)
    }
  }

  private confineFile(projectRoot: string, file: string): string {
    const root = resolve(projectRoot)
    const abs = resolve(root, file)
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new LspGateError(`file ${file} escapes the project root ${projectRoot}`)
    }
    return abs
  }
}
