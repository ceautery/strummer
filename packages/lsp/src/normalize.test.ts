import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decideStatus,
  type Hover,
  type Location,
  type LocationLink,
  normalizeDocumentSymbols,
  normalizeHover,
  normalizeLocations,
  symbolKindName,
} from './normalize.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as T
}

const RANGE = { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }

describe('normalizeLocations', () => {
  it('returns [] for null', () => {
    expect(normalizeLocations(null)).toEqual([])
  })

  it('normalizes a single Location', () => {
    const loc: Location = { uri: 'file:///a.ts', range: RANGE }
    expect(normalizeLocations(loc)).toEqual([{ uri: 'file:///a.ts', range: RANGE }])
  })

  it('normalizes a Location[]', () => {
    const locs: Location[] = [
      { uri: 'file:///a.ts', range: RANGE },
      { uri: 'file:///b.ts', range: RANGE },
    ]
    expect(normalizeLocations(locs).map((l) => l.uri)).toEqual(['file:///a.ts', 'file:///b.ts'])
  })

  it('normalizes LocationLink[] — targetSelectionRange→range, targetRange→fullRange', () => {
    const full = { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } }
    const link: LocationLink = {
      targetUri: 'file:///c.ts',
      targetRange: full,
      targetSelectionRange: RANGE,
    }
    expect(normalizeLocations([link])).toEqual([
      { uri: 'file:///c.ts', range: RANGE, fullRange: full },
    ])
  })
})

describe('normalizeHover', () => {
  it('returns null for null', () => {
    expect(normalizeHover(null)).toBeNull()
  })

  it('reads MarkupContent value', () => {
    const h: Hover = { contents: { kind: 'markdown', value: '```ts\nconst x: number\n```' } }
    expect(normalizeHover(h)?.value).toContain('const x: number')
  })

  it('reads a plain string MarkedString', () => {
    expect(normalizeHover({ contents: 'just text' })?.value).toBe('just text')
  })

  it('fences a {language,value} MarkedString', () => {
    const h: Hover = { contents: { language: 'typescript', value: 'const x: number' } }
    expect(normalizeHover(h)?.value).toBe('```typescript\nconst x: number\n```')
  })

  it('joins a MarkedString[] (mixed forms)', () => {
    const h: Hover = { contents: ['summary', { language: 'ts', value: 'x: number' }] }
    expect(normalizeHover(h)?.value).toBe('summary\n\n```ts\nx: number\n```')
  })
})

describe('symbolKindName', () => {
  it('maps the LSP SymbolKind enum', () => {
    expect(symbolKindName(5)).toBe('Class')
    expect(symbolKindName(12)).toBe('Function')
    expect(symbolKindName(6)).toBe('Method')
  })
  it('falls back for an out-of-range kind', () => {
    expect(symbolKindName(999)).toBe('Unknown')
  })
})

describe('normalizeDocumentSymbols', () => {
  it('returns [] for null', () => {
    expect(normalizeDocumentSymbols(null)).toEqual([])
  })

  it('normalizes hierarchical DocumentSymbol[] with children + kind names', () => {
    const result = normalizeDocumentSymbols(fixture('document-symbols-hierarchical.json'))
    expect(result).toHaveLength(1)
    const cls = result[0]
    expect(cls?.name).toBe('Greeter')
    expect(cls?.kindName).toBe('Class')
    expect(cls?.children?.map((c) => c.name)).toEqual(['greeting', 'greet'])
    expect(cls?.children?.[1]?.kindName).toBe('Method')
  })

  it('normalizes flat SymbolInformation[] (location→range, no children)', () => {
    const result = normalizeDocumentSymbols(fixture('document-symbols-flat.json'))
    expect(result.map((s) => s.name)).toEqual(['Greeter', 'greet'])
    expect(result[0]?.kindName).toBe('Class')
    expect(result[0]?.children).toBeUndefined()
    expect(result[1]?.container).toBe('Greeter')
  })
})

describe('decideStatus (tri-state)', () => {
  it('ok when non-empty', () => {
    expect(decideStatus(false, true)).toBe('ok')
    expect(decideStatus(false, false)).toBe('ok')
  })
  it('no_result when empty AND ready', () => {
    expect(decideStatus(true, true)).toBe('no_result')
  })
  it('not_ready when empty AND not ready (never collapse into no_result)', () => {
    expect(decideStatus(true, false)).toBe('not_ready')
  })
})
