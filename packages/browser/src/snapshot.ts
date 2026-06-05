import type { ArtifactStore } from './artifacts.js'

/**
 * ARIA-snapshot capture + serializer.
 *
 * playwright-core 1.60.0 (our pin) has neither `page._snapshotForAI()` nor
 * ref-ids in `locator.ariaSnapshot()` — those are 1.61-alpha features that
 * `@playwright/mcp` rides (hence its alpha pin). So rather than copy that
 * serializer (ADR 0006's open-fork default, which assumed `_snapshotForAI`
 * output as input), Sackville parses the *public, stable* `ariaSnapshot()` YAML
 * and mints its own ref-ids. Each ref maps to a semantic-locator descriptor
 * (`{role, name, nth}`) so step tools can resolve it via
 * `getByRole(role, {name}).nth(nth)`. Refs are per-snapshot and never persisted
 * across steps (the DOM changes, refs invalidate).
 */

/** A minted reference to an element, resolvable as a semantic locator. */
export interface RefDescriptor {
  role: string
  name?: string
  /** Index among elements sharing this (role, name), in document order. */
  nth: number
}

type LineKind = 'element' | 'text' | 'property'

interface ParsedLine {
  indent: number
  kind: LineKind
  /** Element/text descriptor without trailing colon or ref, e.g. `button "Go" [disabled]`. */
  descriptor: string
  role?: string
  name?: string
  /** Semantic key for diffing — role + name + attrs, ref-independent. */
  semantic?: string
}

export interface Snapshot {
  /** Token-capped serialized tree with `[ref=…]` annotations (what the agent sees). */
  text: string
  /** Full, uncapped serialized tree — stored by handle, never inlined when large. */
  fullText: string
  /** Minted ref → semantic-locator descriptor. */
  refs: Map<string, RefDescriptor>
  /** Number of element nodes (excludes text/property nodes). */
  nodeCount: number
  /** True when `text` was capped below `nodeCount`. */
  truncated: boolean
  /** `sackville://browser/run/<id>/snapshot` when captured with a store. */
  fullHandle?: string
}

export interface BuildSnapshotOptions {
  /** Max element nodes to include in `text` before truncating. Default 60. */
  maxNodes?: number
  /** Prefix for minted ref-ids. Default `'e'` → `e1`. The driver passes a
   * per-capture generation (e.g. `'s2e'` → `s2e1`) so a ref from an old snapshot
   * fails to resolve instead of silently matching a different element. */
  idPrefix?: string
  /** Applied to the serialized `text` + `fullText` before they are returned (and
   * before the full tree is stored), so a secret reflected into the DOM never
   * lands in a snapshot the agent sees or in the stored artifact. Default
   * identity; the server bin wires the real `@sackville-mcp/safety` `Redactor` here. */
  redact?: (text: string) => string
}

/** Anything exposing Playwright's `ariaSnapshot` (a `Locator`, or a fake in tests). */
export interface AriaSnapshotSource {
  ariaSnapshot(): Promise<string>
}

const ATTR_RE = /\[([\w-]+)(?:=([^\]]*))?\]/g
const DESCRIPTOR_RE = /^([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/

function parseDescriptor(descriptor: string): { role: string; name?: string; semantic: string } {
  const m = DESCRIPTOR_RE.exec(descriptor)
  if (!m) return { role: descriptor, semantic: descriptor }
  const role = m[1] ?? descriptor
  const name = m[2]
  const attrs: string[] = []
  const rest = m[3] ?? ''
  for (const a of rest.matchAll(ATTR_RE)) attrs.push(a[0])
  attrs.sort()
  const semantic = `${role}${name !== undefined ? ` "${name}"` : ''}${attrs.length ? ` ${attrs.join(' ')}` : ''}`
  return { role, name, semantic }
}

function parseLines(yaml: string): ParsedLine[] {
  const out: ParsedLine[] = []
  for (const raw of yaml.split('\n')) {
    if (raw.trim() === '') continue
    const indent = raw.length - raw.trimStart().length
    let body = raw.trimStart()
    if (body.startsWith('- ')) body = body.slice(2)
    else if (body === '-') body = ''
    // Property line: `/url: /a`, `/checked: true`
    if (body.startsWith('/')) {
      out.push({ indent, kind: 'property', descriptor: body })
      continue
    }
    // Text value node: `text: Email`
    const textMatch = /^text:\s*(.*)$/.exec(body)
    if (textMatch) {
      out.push({ indent, kind: 'text', descriptor: body })
      continue
    }
    // Element node — strip a trailing `:` that marks "has children".
    const descriptor = body.endsWith(':') ? body.slice(0, -1) : body
    const { role, name, semantic } = parseDescriptor(descriptor)
    out.push({ indent, kind: 'element', descriptor, role, name, semantic })
  }
  return out
}

function mintRefs(
  lines: ParsedLine[],
  idPrefix: string,
): {
  refs: Map<string, RefDescriptor>
  refOf: Map<number, string>
} {
  const refs = new Map<string, RefDescriptor>()
  const refOf = new Map<number, string>()
  const nthByKey = new Map<string, number>()
  let n = 0
  lines.forEach((line, i) => {
    if (line.kind !== 'element' || !line.role) return
    // `\x1f` (unit separator) joins role+name into a collision-proof dedup key —
    // it can't appear in an ARIA role/name. (Was a raw NUL, which made git treat
    // this file as binary and silently skip it in text tooling.)
    const key = `${line.role}\x1f${line.name ?? ''}`
    const nth = nthByKey.get(key) ?? 0
    nthByKey.set(key, nth + 1)
    const ref = `${idPrefix}${++n}`
    refs.set(
      ref,
      line.name === undefined
        ? { role: line.role, nth }
        : { role: line.role, name: line.name, nth },
    )
    refOf.set(i, ref)
  })
  return { refs, refOf }
}

function serialize(
  lines: ParsedLine[],
  refOf: Map<number, string>,
  maxNodes: number,
): { text: string; truncated: boolean; nodeCount: number } {
  const nodeCount = lines.filter((l) => l.kind === 'element').length
  const rendered: string[] = []
  let emittedElements = 0
  let truncated = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.kind === 'element') {
      if (emittedElements >= maxNodes) {
        truncated = true
        break
      }
      emittedElements++
    }
    const pad = ' '.repeat(line.indent)
    const ref = refOf.get(i)
    rendered.push(ref ? `${pad}- ${line.descriptor} [ref=${ref}]` : `${pad}- ${line.descriptor}`)
  }
  if (truncated) {
    rendered.push(`- … (${nodeCount - maxNodes} more elements)`)
  }
  return { text: rendered.join('\n'), truncated, nodeCount }
}

/** Parse an `ariaSnapshot()` YAML string into a ref-annotated, token-capped snapshot. */
export function buildSnapshot(yaml: string, options: BuildSnapshotOptions = {}): Snapshot {
  const maxNodes = options.maxNodes ?? 60
  const redact = options.redact ?? ((t) => t)
  const lines = parseLines(yaml)
  const { refs, refOf } = mintRefs(lines, options.idPrefix ?? 'e')
  const capped = serialize(lines, refOf, maxNodes)
  const full = serialize(lines, refOf, Number.POSITIVE_INFINITY)
  return {
    text: redact(capped.text),
    fullText: redact(full.text),
    refs,
    nodeCount: capped.nodeCount,
    truncated: capped.truncated,
  }
}

export interface CaptureSnapshotOptions extends BuildSnapshotOptions {
  /** When provided with `runId`, stores the full tree and sets `fullHandle`. */
  store?: ArtifactStore
  runId?: string
  /** Snapshot generation. When set, the artifact is keyed `snapshot-s<generation>`
   * so a later capture never overwrites an earlier handle — a `fullHandle`
   * returned in one step always resolves to exactly the tree that produced it. */
  generation?: number
}

/** Capture an ARIA snapshot from a source (a `Locator`), build it, and optionally store the full tree. */
export async function captureSnapshot(
  source: AriaSnapshotSource,
  options: CaptureSnapshotOptions = {},
): Promise<Snapshot> {
  const yaml = await source.ariaSnapshot()
  const snap = buildSnapshot(yaml, options)
  if (options.store && options.runId) {
    const kind = options.generation === undefined ? 'snapshot' : `snapshot-s${options.generation}`
    snap.fullHandle = options.store.put(options.runId, kind, snap.fullText, 'text/plain')
  }
  return snap
}

/** Semantic (role + name + attrs) lines of element/text nodes, ref-independent. */
function semanticNodes(snap: Snapshot | string): { label: string; key: string }[] {
  const yaml = typeof snap === 'string' ? snap : snap.fullText
  const out: { label: string; key: string }[] = []
  for (const line of parseLines(yaml)) {
    if (line.kind === 'element') {
      out.push({ label: line.descriptor, key: line.semantic ?? line.descriptor })
    } else if (line.kind === 'text') {
      out.push({ label: line.descriptor, key: line.descriptor })
    }
  }
  return out
}

/**
 * A compact, ref-independent diff of two snapshots: semantic nodes present in
 * one but not the other. Identical content with different minted refs diffs to
 * the empty string. The emitted lines are capped (`maxLines`, default 50) with a
 * `… (N more changes)` tail so a navigation between two large disjoint pages
 * can't inline an unbounded diff into a step result.
 */
export function diffSnapshots(
  prev: Snapshot | string,
  next: Snapshot | string,
  options: { maxLines?: number } = {},
): string {
  const prevNodes = semanticNodes(prev)
  const nextNodes = semanticNodes(next)
  const remaining = new Map<string, number>()
  for (const n of nextNodes) remaining.set(n.key, (remaining.get(n.key) ?? 0) + 1)

  const removed: string[] = []
  for (const node of prevNodes) {
    const count = remaining.get(node.key) ?? 0
    if (count > 0) remaining.set(node.key, count - 1)
    else removed.push(`- ${node.label}`)
  }
  // Whatever is still "remaining" in next was not matched by a prev node → added.
  const leftover = new Map<string, number>()
  for (const node of prevNodes) leftover.set(node.key, (leftover.get(node.key) ?? 0) + 1)
  const added: string[] = []
  for (const node of nextNodes) {
    const count = leftover.get(node.key) ?? 0
    if (count > 0) leftover.set(node.key, count - 1)
    else added.push(`+ ${node.label}`)
  }
  const all = [...removed, ...added]
  const maxLines = options.maxLines ?? 50
  if (all.length <= maxLines) return all.join('\n')
  return [...all.slice(0, maxLines), `… (${all.length - maxLines} more changes)`].join('\n')
}
