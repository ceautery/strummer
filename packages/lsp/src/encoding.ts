/**
 * Position-encoding conversion — the single highest-correctness-risk corner of the LSP
 * bridge (ADR 0011), and the reason this is the first slice. An LSP `Position.character`
 * is a 0-based offset measured in **code units of the negotiated encoding**, NOT a column.
 * JS strings are UTF-16, so a naive `col - 1` passes every ASCII test and then silently
 * points at the WRONG symbol the moment a line contains a non-BMP character (emoji, CJK,
 * combining marks) under a server that negotiated UTF-8. That is the worst failure for an
 * agent tool — plausible, wrong, and silent — so the conversion is a pure, separately
 * unit-tested function exercised against non-BMP fixtures here, before any server exists.
 *
 * Human columns are 1-based and count **Unicode code points** (what a person counts);
 * LSP characters are 0-based code-unit offsets in the negotiated encoding.
 */

export type PositionEncoding = 'utf-8' | 'utf-16' | 'utf-32'

const SUPPORTED: readonly string[] = ['utf-8', 'utf-16', 'utf-32']

/**
 * The encodings we advertise to the server, in preference order. UTF-16 is first
 * deliberately: it is the JS-native, best-tested path (a server honouring our preference
 * picks the one we exercise most). We still implement all three for servers that only
 * speak UTF-8 (e.g. clangd).
 */
export const PREFERRED_ENCODINGS: readonly PositionEncoding[] = ['utf-16', 'utf-8']

/**
 * Resolve the encoding to use from the server's reported `positionEncoding`. Absent ⇒ the
 * spec default, UTF-16. **Present but unsupported ⇒ throw** — never silently default, or
 * we would do offset math in the wrong unit and return wrong locations.
 */
export function resolvePositionEncoding(reported: string | undefined): PositionEncoding {
  if (reported === undefined) return 'utf-16'
  if (SUPPORTED.includes(reported)) return reported as PositionEncoding
  throw new Error(
    `server negotiated an unsupported position encoding: ${reported} (expected one of ${SUPPORTED.join(', ')})`,
  )
}

/** Length of a string in the code units of `encoding`. */
function codeUnits(s: string, encoding: PositionEncoding): number {
  switch (encoding) {
    case 'utf-16':
      return s.length // a JS string's length IS its UTF-16 code-unit count
    case 'utf-8':
      return Buffer.byteLength(s, 'utf8')
    case 'utf-32':
      return [...s].length // code points
  }
}

/** Strip a single leading BOM (U+FEFF) — it must not shift line-1 column math. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Convert a 1-based human column (counting code points) on `lineText` to a 0-based LSP
 * `character` offset in `encoding`. A column past the line end clamps to the line length.
 */
export function toLspCharacter(
  lineText: string,
  humanColumn: number,
  encoding: PositionEncoding,
): number {
  const cps = [...lineText]
  const take = Math.max(0, Math.min(humanColumn - 1, cps.length))
  return codeUnits(cps.slice(0, take).join(''), encoding)
}

/**
 * Inverse of {@link toLspCharacter}: map a 0-based LSP `character` offset back to a 1-based
 * human code-point column. An offset landing inside a multi-unit code point clamps to that
 * code point's start; an offset past the line end clamps to one past the last column.
 */
export function fromLspCharacter(
  lineText: string,
  lspCharacter: number,
  encoding: PositionEncoding,
): number {
  if (lspCharacter <= 0) return 1
  const cps = [...lineText]
  let units = 0
  for (let k = 0; k < cps.length; k++) {
    const u = codeUnits(cps[k] as string, encoding)
    // Offset lands inside code point k → clamp to its (1-based) column.
    if (units + u > lspCharacter) return k + 1
    units += u
  }
  return cps.length + 1
}

export interface LspPositionParts {
  line: number
  character: number
}

/** Split text into line contents on LF / CR / CRLF, excluding the terminators (LSP's model). */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * Convert a human 1-based line:column over the full source `text` to a 0-based LSP
 * `Position` in `encoding`. Lines are split on LF/CR/CRLF WITHOUT normalizing the document
 * (the text we send the server is its source of truth); a leading BOM is stripped before
 * line-1 column math.
 */
export function toLspPosition(
  text: string,
  humanLine: number,
  humanColumn: number,
  encoding: PositionEncoding,
): LspPositionParts {
  const lines = splitLines(stripBom(text))
  const lineText = lines[humanLine - 1] ?? ''
  return { line: humanLine - 1, character: toLspCharacter(lineText, humanColumn, encoding) }
}

export interface HumanPosition {
  line: number
  column: number
}

/** Inverse of {@link toLspPosition}: map an LSP `Position` back to human 1-based line:column. */
export function fromLspPosition(
  text: string,
  position: LspPositionParts,
  encoding: PositionEncoding,
): HumanPosition {
  const lines = splitLines(stripBom(text))
  const lineText = lines[position.line] ?? ''
  return {
    line: position.line + 1,
    column: fromLspCharacter(lineText, position.character, encoding),
  }
}
