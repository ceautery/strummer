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
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CallDirection, CallHierarchyGroup, NavResult, ServerInfo } from './client.js'
import { assertAllowed, confineFile, LspGateError } from './confine.js'
import {
  fromLspPosition,
  type HumanPosition,
  type PositionEncoding,
  toLspPosition,
} from './encoding.js'
import type { LanguageServerManager } from './manager.js'
import type {
  LspRange,
  NormalizedCallItem,
  NormalizedHover,
  NormalizedLocation,
  NormalizedSymbol,
  QueryStatus,
} from './normalize.js'

// The paired-gate + confinement guards now live in `confine.ts` (shared with the write engine);
// re-exported here so existing importers (barrel, tests) are unaffected.
export { LspGateError }

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

export type LspQueryKind =
  | 'definition'
  | 'typeDefinition'
  | 'references'
  | 'hover'
  | 'documentSymbols'
  | 'callHierarchy'

/** The position-based kinds — those that require a `line`/`column`. */
const POSITION_KINDS: ReadonlySet<LspQueryKind> = new Set([
  'definition',
  'typeDefinition',
  'references',
  'hover',
  'callHierarchy',
])

export interface LspQueryInput {
  /** The agent-facing language (resolved against the operator registry). */
  language: string
  /** Project root — must be in `allowedRoots`; pinned to the server's `rootUri`. */
  projectRoot: string
  /** The file to query, relative to `projectRoot` (or absolute within it). */
  file: string
  /** 1-based human line — required for the position-based kinds, ignored for `documentSymbols`. */
  line?: number
  /** 1-based human column (code points) — required for the position-based kinds. */
  column?: number
  kind: LspQueryKind
  /** Call-hierarchy direction (callers vs callees); defaults to `incoming`. */
  direction?: CallDirection
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

/** A document symbol with its range mapped to human 1-based coords; children recurse. */
export interface ResultSymbol {
  name: string
  kind: number
  kindName: string
  detail?: string
  range: HumanRange
  /** Set only for flat `SymbolInformation` results. */
  container?: string
  children?: ResultSymbol[]
}

/** A call-hierarchy item with its ranges mapped to human 1-based coords. */
export interface ResultCallItem {
  name: string
  kind: number
  kindName: string
  detail?: string
  uri: string
  range: HumanRange
  selectionRange: HumanRange
}

/** One call edge: the other item + the human-coord ranges where the call occurs. */
export interface ResultCall {
  item: ResultCallItem
  fromRanges: HumanRange[]
}

export interface ResultCallGroup {
  source: ResultCallItem
  direction: CallDirection
  calls: ResultCall[]
}

export interface LspQueryResult {
  status: QueryStatus
  kind: LspQueryKind
  locations?: ResultLocation[]
  hover?: { value: string; range?: HumanRange }
  symbols?: ResultSymbol[]
  callHierarchy?: ResultCallGroup[]
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
    assertAllowed(this.allowRun, this.allowedRoots, input.projectRoot)
    const absFile = confineFile(input.projectRoot, input.file)
    const text = this.readFile(absFile)
    if (text === undefined) {
      throw new LspGateError(`cannot read file ${input.file} in ${input.projectRoot}`)
    }
    const uri = pathToFileURL(absFile).toString()
    if (
      POSITION_KINDS.has(input.kind) &&
      (input.line === undefined || input.column === undefined)
    ) {
      throw new LspGateError(`the ${input.kind} query requires a line and column`)
    }

    type Nav =
      | NavResult<NormalizedLocation[]>
      | NavResult<NormalizedHover | null>
      | NavResult<NormalizedSymbol[]>
      | NavResult<CallHierarchyGroup[]>
    const nav = await this.manager.run<Nav>(
      { language: input.language, projectRoot: input.projectRoot, uri, text },
      (client): Promise<Nav> => {
        switch (input.kind) {
          case 'documentSymbols':
            return client.documentSymbols(uri)
          default: {
            const pos = toLspPosition(
              text,
              input.line as number,
              input.column as number,
              client.encoding,
            )
            switch (input.kind) {
              case 'definition':
                return client.definition(uri, pos)
              case 'typeDefinition':
                return client.typeDefinition(uri, pos)
              case 'references':
                return client.references(uri, pos)
              case 'hover':
                return client.hover(uri, pos)
              case 'callHierarchy':
                return client.callHierarchy(uri, pos, input.direction ?? 'incoming')
            }
          }
        }
      },
    )

    return this.shape(input, nav, uri, text)
  }

  private shape(
    input: LspQueryInput,
    nav:
      | NavResult<NormalizedLocation[]>
      | NavResult<NormalizedHover | null>
      | NavResult<NormalizedSymbol[]>
      | NavResult<CallHierarchyGroup[]>,
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

    if (input.kind === 'documentSymbols') {
      const symbols = (nav as NavResult<NormalizedSymbol[]>).result
      // Document symbols are all in the QUERIED file; map every range with its text.
      return { ...base, symbols: symbols.map((s) => this.mapSymbol(s, queriedText, encoding)) }
    }

    if (input.kind === 'callHierarchy') {
      const direction = input.direction ?? 'incoming'
      const groups = (nav as NavResult<CallHierarchyGroup[]>).result
      const cache = new Map<string, string | undefined>([[queriedUri, queriedText]])
      return {
        ...base,
        callHierarchy: groups.map((g) =>
          this.mapCallGroup(g, direction, encoding, queriedUri, cache),
        ),
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

  /** Map a normalized document symbol (and its children) to human coords in the queried file. */
  private mapSymbol(s: NormalizedSymbol, text: string, encoding: PositionEncoding): ResultSymbol {
    const out: ResultSymbol = {
      name: s.name,
      kind: s.kind,
      kindName: s.kindName,
      range: this.mapRange(text, s.range, encoding),
    }
    if (s.detail !== undefined) out.detail = s.detail
    if (s.container !== undefined) out.container = s.container
    if (s.children && s.children.length > 0) {
      out.children = s.children.map((c) => this.mapSymbol(c, text, encoding))
    }
    return out
  }

  private mapCallItem(
    item: NormalizedCallItem,
    encoding: PositionEncoding,
    cache: Map<string, string | undefined>,
  ): ResultCallItem {
    const text = this.textForUri(item.uri, cache)
    return {
      name: item.name,
      kind: item.kind,
      kindName: item.kindName,
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
      uri: item.uri,
      range: this.mapRange(text, item.range, encoding),
      selectionRange: this.mapRange(text, item.selectionRange, encoding),
    }
  }

  private mapCallGroup(
    g: CallHierarchyGroup,
    direction: CallDirection,
    encoding: PositionEncoding,
    queriedUri: string,
    cache: Map<string, string | undefined>,
  ): ResultCallGroup {
    return {
      source: this.mapCallItem(g.source, encoding, cache),
      direction,
      calls: g.calls.map((c) => {
        // fromRanges live in the CALLER's file: incoming ⇒ the edge item (the caller);
        // outgoing ⇒ the source (the queried caller) itself.
        const fromText = this.textForUri(direction === 'incoming' ? c.item.uri : queriedUri, cache)
        return {
          item: this.mapCallItem(c.item, encoding, cache),
          fromRanges: c.fromRanges.map((r) => this.mapRange(fromText, r, encoding)),
        }
      }),
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
}
