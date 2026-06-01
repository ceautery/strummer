import { describe, expect, it } from 'vitest'
import {
  applyTextEdits,
  isPlausibleRenameName,
  OverlappingEditError,
  type TextEdit,
} from './apply.js'
import type { PositionEncoding } from './encoding.js'

/** Build a single-line TextEdit (line 0) from character span [from,to) → newText. */
function edit(line: number, from: number, to: number, newText: string): TextEdit {
  return { range: { start: { line, character: from }, end: { line, character: to } }, newText }
}

describe('applyTextEdits', () => {
  const u16: PositionEncoding = 'utf-16'

  it('replaces a single mid-line span', () => {
    expect(applyTextEdits('const x = 1', [edit(0, 6, 7, 'y')], u16)).toBe('const y = 1')
  })

  it('applies multiple non-overlapping edits regardless of input order (right-to-left)', () => {
    const aaa = edit(0, 0, 3, 'X')
    const ccc = edit(0, 8, 11, 'Z')
    // 'aaa bbb ccc' → 'X bbb Z'
    expect(applyTextEdits('aaa bbb ccc', [ccc, aaa], u16)).toBe('X bbb Z')
    // reverse-order independence: the other input order is byte-identical.
    expect(applyTextEdits('aaa bbb ccc', [aaa, ccc], u16)).toBe('X bbb Z')
  })

  it('handles an insertion (empty range)', () => {
    expect(applyTextEdits('ab', [edit(0, 1, 1, 'X')], u16)).toBe('aXb')
  })

  it('handles a deletion (empty newText)', () => {
    expect(applyTextEdits('abc', [edit(0, 1, 2, '')], u16)).toBe('ac')
  })

  it('inserts at offset 0 and at end of text', () => {
    expect(applyTextEdits('ab', [edit(0, 0, 0, 'X')], u16)).toBe('Xab')
    expect(applyTextEdits('ab', [edit(0, 2, 2, 'Y')], u16)).toBe('abY')
  })

  it('ALLOWS adjacent (touching, non-overlapping) edits', () => {
    // 'abcd' → replace `b` then `c`; edit1.end (2) == edit2.start (2) is adjacency, not overlap.
    expect(applyTextEdits('abcd', [edit(0, 1, 2, 'B'), edit(0, 2, 3, 'C')], u16)).toBe('aBCd')
  })

  it('THROWS on a true overlap', () => {
    expect(() => applyTextEdits('abcde', [edit(0, 1, 3, 'X'), edit(0, 2, 4, 'Y')], u16)).toThrow(
      OverlappingEditError,
    )
  })

  it('THROWS on two edits sharing a start offset (subsumes zero-length double insert)', () => {
    expect(() => applyTextEdits('abc', [edit(0, 1, 1, 'X'), edit(0, 1, 1, 'Y')], u16)).toThrow(
      OverlappingEditError,
    )
  })

  it('produces IDENTICAL output whether ranges are utf-16 or utf-8 offsets (non-BMP)', () => {
    const text = '😀b = 1' // emoji 2 JS units / 4 utf-8 bytes; `b` follows it.
    // utf-16: `b` at character 2..3. utf-8: `b` at character 4..5. Both replace `b`→`Z`.
    const out16 = applyTextEdits(text, [edit(0, 2, 3, 'Z')], 'utf-16')
    const out8 = applyTextEdits(text, [edit(0, 4, 5, 'Z')], 'utf-8')
    expect(out16).toBe('😀Z = 1')
    expect(out8).toBe('😀Z = 1')
    expect(out16).toBe(out8)
  })

  it('preserves CRLF terminators when editing a line between them', () => {
    expect(applyTextEdits('a\r\nx\r\nb', [edit(1, 0, 1, 'YY')], u16)).toBe('a\r\nYY\r\nb')
  })

  it('applies a multi-line range spanning a terminator', () => {
    // 'abc\ndef' delete from {0,1} to {1,1} (covers 'bc\nd') → 'aef'.
    const e: TextEdit = {
      range: { start: { line: 0, character: 1 }, end: { line: 1, character: 1 } },
      newText: '',
    }
    expect(applyTextEdits('abc\ndef', [e], u16)).toBe('aef')
  })
})

describe('isPlausibleRenameName', () => {
  it('accepts ordinary identifiers (incl. non-ASCII letters)', () => {
    for (const n of ['foo', 'Foo2', '_bar', '$x', 'café', 'naïve']) {
      expect(isPlausibleRenameName(n)).toBe(true)
    }
  })

  it('rejects empty, over-length, newline, path separators and control chars', () => {
    expect(isPlausibleRenameName('')).toBe(false)
    expect(isPlausibleRenameName('a'.repeat(256))).toBe(false)
    expect(isPlausibleRenameName('foo\nbar')).toBe(false)
    expect(isPlausibleRenameName('foo/bar')).toBe(false)
    expect(isPlausibleRenameName('foo\\bar')).toBe(false)
    expect(isPlausibleRenameName('foo\tbar')).toBe(false)
  })
})
