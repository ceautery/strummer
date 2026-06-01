/**
 * Pure LSP-result normalizers (ADR 0011, slice 1). LSP responses are polymorphic in ways
 * that silently corrupt an agent-facing tool if mishandled — these reducers collapse each
 * shape to one Strummer form, with no I/O. The traps the adversarial pass flagged:
 *
 * - **`Location` vs `LocationLink`.** definition/typeDefinition return
 *   `Location | Location[] | LocationLink[] | null`; `LocationLink` uses `targetUri` /
 *   `targetSelectionRange` — DIFFERENT field names than `Location`'s `uri`/`range`. Reading
 *   `.uri`/`.range` off a link yields `undefined` → silently empty navigation.
 * - **`DocumentSymbol` vs `SymbolInformation`.** documentSymbol returns hierarchical
 *   `DocumentSymbol[]` (has `children`/`selectionRange`) OR flat `SymbolInformation[]` (has
 *   `location`) — two incompatible shapes under one method.
 * - **Hover contents** can be `MarkupContent | MarkedString | MarkedString[]`.
 *
 * Ranges are kept in LSP 0-based form here; mapping them back to human 1-based line:column
 * needs the file text + the negotiated encoding and lives in `encoding.ts`
 * (`fromLspPosition`), applied at the surface.
 */

export interface LspPosition {
  line: number
  character: number
}
export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface Location {
  uri: string
  range: LspRange
}

export interface LocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange: LspRange
  originSelectionRange?: LspRange
}

export interface NormalizedLocation {
  uri: string
  /** The precise symbol range (LocationLink.targetSelectionRange, or Location.range). */
  range: LspRange
  /** The full enclosing range, when the server sent a LocationLink. */
  fullRange?: LspRange
}

function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return (item as LocationLink).targetUri !== undefined
}

/** Normalize any definition/references/typeDefinition result shape to a flat location list. */
export function normalizeLocations(
  result: Location | Location[] | LocationLink[] | null | undefined,
): NormalizedLocation[] {
  if (result == null) return []
  const items = Array.isArray(result) ? result : [result]
  return items.map((item) => {
    if (isLocationLink(item)) {
      return { uri: item.targetUri, range: item.targetSelectionRange, fullRange: item.targetRange }
    }
    return { uri: item.uri, range: item.range }
  })
}

export type MarkedString = string | { language: string; value: string }
export interface MarkupContent {
  kind: 'plaintext' | 'markdown'
  value: string
}
export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[]
  range?: LspRange
}

export interface NormalizedHover {
  value: string
  range?: LspRange
}

function markedToString(m: MarkedString): string {
  if (typeof m === 'string') return m
  return `\`\`\`${m.language}\n${m.value}\n\`\`\``
}

/** Normalize hover contents (MarkupContent | MarkedString | MarkedString[]) to one string. */
export function normalizeHover(hover: Hover | null | undefined): NormalizedHover | null {
  if (hover == null) return null
  const c = hover.contents
  let value: string
  if (Array.isArray(c)) {
    value = c.map(markedToString).join('\n\n')
  } else if (typeof c === 'string') {
    value = c
  } else if ('kind' in c) {
    value = c.value // MarkupContent
  } else {
    value = markedToString(c) // {language, value} MarkedString
  }
  return hover.range ? { value, range: hover.range } : { value }
}

// LSP SymbolKind enum (1-based), https://microsoft.github.io/language-server-protocol/.
const SYMBOL_KIND_NAMES = [
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
] as const

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind - 1] ?? 'Unknown'
}

export interface DocumentSymbol {
  name: string
  kind: number
  detail?: string
  range: LspRange
  selectionRange: LspRange
  children?: DocumentSymbol[]
}

export interface SymbolInformation {
  name: string
  kind: number
  location: Location
  containerName?: string
}

export interface NormalizedSymbol {
  name: string
  kind: number
  kindName: string
  detail?: string
  range: LspRange
  children?: NormalizedSymbol[]
  /** Set only for flat SymbolInformation results. */
  container?: string
}

function isSymbolInformation(s: DocumentSymbol | SymbolInformation): s is SymbolInformation {
  return (s as SymbolInformation).location !== undefined
}

function normalizeDocumentSymbol(s: DocumentSymbol): NormalizedSymbol {
  const out: NormalizedSymbol = {
    name: s.name,
    kind: s.kind,
    kindName: symbolKindName(s.kind),
    range: s.range,
  }
  if (s.detail !== undefined) out.detail = s.detail
  if (s.children && s.children.length > 0) out.children = s.children.map(normalizeDocumentSymbol)
  return out
}

/** Normalize documentSymbol's dual shape (hierarchical DocumentSymbol[] or flat SymbolInformation[]). */
export function normalizeDocumentSymbols(
  result: DocumentSymbol[] | SymbolInformation[] | null | undefined,
): NormalizedSymbol[] {
  if (result == null || result.length === 0) return []
  const first = result[0] as DocumentSymbol | SymbolInformation
  if (isSymbolInformation(first)) {
    return (result as SymbolInformation[]).map((s) => {
      const out: NormalizedSymbol = {
        name: s.name,
        kind: s.kind,
        kindName: symbolKindName(s.kind),
        range: s.location.range,
      }
      if (s.containerName !== undefined) out.container = s.containerName
      return out
    })
  }
  return (result as DocumentSymbol[]).map(normalizeDocumentSymbol)
}

// --- Call hierarchy (ADR 0011 staged tail) -------------------------------------------------

/** A raw `CallHierarchyItem` (prepareCallHierarchy result + the node inside incoming/outgoing). */
export interface CallHierarchyItem {
  name: string
  kind: number
  detail?: string
  uri: string
  range: LspRange
  selectionRange: LspRange
}

export interface NormalizedCallItem {
  name: string
  kind: number
  kindName: string
  detail?: string
  uri: string
  range: LspRange
  selectionRange: LspRange
}

/** One edge of the call hierarchy: the other item + the ranges where the call occurs. */
export interface NormalizedCall {
  item: NormalizedCallItem
  fromRanges: LspRange[]
}

export function normalizeCallHierarchyItem(item: CallHierarchyItem): NormalizedCallItem {
  const out: NormalizedCallItem = {
    name: item.name,
    kind: item.kind,
    kindName: symbolKindName(item.kind),
    uri: item.uri,
    range: item.range,
    selectionRange: item.selectionRange,
  }
  if (item.detail !== undefined && item.detail !== '') out.detail = item.detail
  return out
}

export function normalizeCallHierarchyItems(
  result: CallHierarchyItem[] | null | undefined,
): NormalizedCallItem[] {
  if (result == null) return []
  return result.map(normalizeCallHierarchyItem)
}

/** `callHierarchy/incomingCalls` → `{from, fromRanges}[]`; the edge item is the CALLER. */
export function normalizeIncomingCalls(
  result: { from: CallHierarchyItem; fromRanges: LspRange[] }[] | null | undefined,
): NormalizedCall[] {
  if (result == null) return []
  return result.map((c) => ({
    item: normalizeCallHierarchyItem(c.from),
    fromRanges: c.fromRanges ?? [],
  }))
}

/** `callHierarchy/outgoingCalls` → `{to, fromRanges}[]`; the edge item is the CALLEE. */
export function normalizeOutgoingCalls(
  result: { to: CallHierarchyItem; fromRanges: LspRange[] }[] | null | undefined,
): NormalizedCall[] {
  if (result == null) return []
  return result.map((c) => ({
    item: normalizeCallHierarchyItem(c.to),
    fromRanges: c.fromRanges ?? [],
  }))
}

/**
 * The tri-state query outcome (ADR 0011): an empty result is only authoritatively
 * `no_result` when the server is READY; while it is still indexing an empty result is
 * `not_ready` and must never be collapsed into "no definition" (an agent would act on the
 * lie). Readiness is decided by the client (slice 2); this is the pure combinator.
 */
export type QueryStatus = 'ok' | 'not_ready' | 'no_result'

export function decideStatus(isEmpty: boolean, ready: boolean): QueryStatus {
  if (!isEmpty) return 'ok'
  return ready ? 'no_result' : 'not_ready'
}
