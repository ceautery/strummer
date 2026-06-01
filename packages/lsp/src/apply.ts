/**
 * The pure write-mode apply core (ADR 0011 write-mode addendum, Slice A). No I/O, no spawn —
 * the most defensible TDD entry for write-mode, pinning down the corruption-class vectors
 * (encoding-wrong offsets, overlapping edits, edit-ordering) before any disk write exists.
 *
 * The silent-wrong trap mirrors the read path: a TextEdit `range.character` is in the
 * NEGOTIATED encoding's code units, so applying it must resolve each position to an absolute
 * JS index via `lspPositionToOffset` (which is CRLF/BOM/non-BMP faithful) and never via a
 * naive line:column arithmetic.
 */

import { lspPositionToOffset, type PositionEncoding } from './encoding.js'
import type { LspRange } from './normalize.js'

export interface TextEdit {
  range: LspRange
  newText: string
}

/** Thrown when two edits in one document overlap or share a start offset. */
export class OverlappingEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OverlappingEditError'
  }
}

/**
 * Apply a set of LSP TextEdits to one document's `text`, encoding-faithfully. Each edit's
 * positions are resolved to absolute JS offsets, validated, then spliced in DESCENDING start
 * order so an earlier edit never invalidates a later one's offsets.
 *
 * Enforced invariants (throw {@link OverlappingEditError}, never silently corrupt):
 * - Two edits sharing a start offset are refused (subsumes a zero-length double insertion);
 *   with distinct starts the splice order is total and JS sort stability is never relied on.
 * - A true overlap (`prev.end > next.start`) is refused. Adjacency (`prev.end == next.start`)
 *   is allowed.
 */
export function applyTextEdits(
  text: string,
  edits: TextEdit[],
  encoding: PositionEncoding,
): string {
  const spans = edits.map((e) => {
    const start = lspPositionToOffset(text, e.range.start, encoding)
    const end = lspPositionToOffset(text, e.range.end, encoding)
    if (end < start) {
      throw new OverlappingEditError(
        `edit range end (${end}) precedes its start (${start}) — malformed range`,
      )
    }
    return { start, end, newText: e.newText }
  })
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1] as (typeof sorted)[number]
    const cur = sorted[k] as (typeof sorted)[number]
    if (cur.start === prev.start) {
      throw new OverlappingEditError(`two edits share start offset ${cur.start}`)
    }
    if (prev.end > cur.start) {
      throw new OverlappingEditError(
        `edits overlap: [${prev.start},${prev.end}) and [${cur.start},${cur.end})`,
      )
    }
  }
  let out = text
  for (let k = sorted.length - 1; k >= 0; k--) {
    const s = sorted[k] as (typeof sorted)[number]
    out = out.slice(0, s.start) + s.newText + out.slice(s.end)
  }
  return out
}

const MAX_RENAME_NAME_LENGTH = 255

/**
 * A coarse injection guard for a rename target. `newName` is sent verbatim to the server and
 * then written verbatim into EVERY edited site, so a newline or path separator in it is a
 * corruption/injection vector. This is a defensive bound, NOT a per-language identifier
 * validator: it rejects empty / over-length / multi-line / path-separator / control-character
 * names and accepts everything else (incl. non-ASCII letters). Validated before the rename
 * request is sent to the server.
 */
export function isPlausibleRenameName(newName: string): boolean {
  if (typeof newName !== 'string') return false
  if (newName.length === 0 || newName.length > MAX_RENAME_NAME_LENGTH) return false
  if (newName.includes('/') || newName.includes('\\')) return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the intent
  if (/[\u0000-\u001f\u007f]/.test(newName)) return false
  return true
}
