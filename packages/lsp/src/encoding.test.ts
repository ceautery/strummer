import { describe, expect, it } from 'vitest'
import {
  fromLspCharacter,
  fromLspPosition,
  type PositionEncoding,
  resolvePositionEncoding,
  toLspCharacter,
  toLspPosition,
} from './encoding.js'

// 😀 = U+1F600: 1 codepoint, 2 UTF-16 code units (surrogate pair), 4 UTF-8 bytes.
// é (precomposed, U+00E9): 1 codepoint, 1 UTF-16 unit, 2 UTF-8 bytes.
const EMOJI = '😀'

describe('resolvePositionEncoding', () => {
  it('defaults to utf-16 when the server reports nothing (spec default)', () => {
    expect(resolvePositionEncoding(undefined)).toBe('utf-16')
  })

  it('honours a supported negotiated encoding', () => {
    expect(resolvePositionEncoding('utf-8')).toBe('utf-8')
    expect(resolvePositionEncoding('utf-16')).toBe('utf-16')
    expect(resolvePositionEncoding('utf-32')).toBe('utf-32')
  })

  it('FAILS LOUD on a present-but-unsupported encoding (never silently defaults)', () => {
    expect(() => resolvePositionEncoding('ascii')).toThrow(/unsupported/i)
  })
})

describe('toLspCharacter', () => {
  it('maps a 1-based human column to a 0-based offset on ASCII (col 1 → 0)', () => {
    const enc: PositionEncoding = 'utf-16'
    expect(toLspCharacter('const x = 1', 1, enc)).toBe(0)
    expect(toLspCharacter('const x = 1', 7, enc)).toBe(6) // before `x`
  })

  it('clamps a column past the line end to the full line length', () => {
    expect(toLspCharacter('abc', 99, 'utf-16')).toBe(3)
  })

  it('counts UTF-16 code units (a surrogate pair is 2)', () => {
    // line: "😀b" — column 2 sits before `b`, after the 2-unit emoji.
    expect(toLspCharacter(`${EMOJI}b`, 2, 'utf-16')).toBe(2)
    expect(toLspCharacter(`${EMOJI}b`, 3, 'utf-16')).toBe(3)
  })

  it('counts UTF-8 bytes (the emoji is 4)', () => {
    expect(toLspCharacter(`${EMOJI}b`, 2, 'utf-8')).toBe(4)
    expect(toLspCharacter(`${EMOJI}b`, 3, 'utf-8')).toBe(5)
  })

  it('counts UTF-32 code points (the emoji is 1)', () => {
    expect(toLspCharacter(`${EMOJI}b`, 2, 'utf-32')).toBe(1)
    expect(toLspCharacter(`${EMOJI}b`, 3, 'utf-32')).toBe(2)
  })
})

describe('fromLspCharacter (inverse)', () => {
  it('maps an offset back to a 1-based column on ASCII', () => {
    expect(fromLspCharacter('const x = 1', 0, 'utf-16')).toBe(1)
    expect(fromLspCharacter('const x = 1', 6, 'utf-16')).toBe(7)
  })

  it('round-trips with toLspCharacter across encodings and non-BMP content', () => {
    const lines = [`${EMOJI}b café ${EMOJI}`, 'plain ascii', 'mixed café']
    for (const enc of ['utf-16', 'utf-8', 'utf-32'] as PositionEncoding[]) {
      for (const line of lines) {
        const cols = [...line].length + 1
        for (let col = 1; col <= cols; col++) {
          const ch = toLspCharacter(line, col, enc)
          expect(fromLspCharacter(line, ch, enc)).toBe(col)
        }
      }
    }
  })

  it('clamps an offset that lands inside a multi-unit codepoint to that codepoint', () => {
    // UTF-8: emoji occupies bytes 0..3; offset 2 is mid-emoji → column 1 (its start).
    expect(fromLspCharacter(`${EMOJI}b`, 2, 'utf-8')).toBe(1)
  })
})

describe('toLspPosition / fromLspPosition', () => {
  it('splits lines on LF/CR/CRLF without normalizing the document', () => {
    const text = 'line0\r\nconst x = 1\nlast'
    // human line 2, column 7 → 0-based line 1, character 6 (before `x`).
    expect(toLspPosition(text, 2, 7, 'utf-16')).toEqual({ line: 1, character: 6 })
  })

  it('strips a leading BOM before line-1 column math', () => {
    const text = '﻿const x = 1'
    expect(toLspPosition(text, 1, 1, 'utf-16')).toEqual({ line: 0, character: 0 })
    expect(toLspPosition(text, 1, 7, 'utf-16')).toEqual({ line: 0, character: 6 })
  })

  it('maps an LSP position back to human 1-based line:column', () => {
    const text = 'line0\r\n😀b\nlast'
    expect(fromLspPosition(text, { line: 1, character: 2 }, 'utf-16')).toEqual({
      line: 2,
      column: 2,
    })
  })
})
