import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type Diagnostic,
  decideStatus,
  type Hover,
  type Location,
  type LocationLink,
  normalizeDiagnostics,
  normalizeDocumentSymbols,
  normalizeHover,
  normalizeLocations,
  normalizePrepareRename,
  normalizeWorkspaceEdit,
  normalizeWorkspaceSymbols,
  type RawWorkspaceEdit,
  symbolKindName,
  type WorkspaceSymbol,
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

describe('normalizeWorkspaceSymbols', () => {
  it('returns [] for null', () => {
    expect(normalizeWorkspaceSymbols(null)).toEqual([])
  })

  it('normalizes the real SymbolInformation[] payload (location.range present + kind names)', () => {
    const result = normalizeWorkspaceSymbols(fixture('workspace-symbols.json'))
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.name)).toEqual(['greeter', 'Greeter'])
    expect(result.map((s) => s.kindName)).toEqual(['Constant', 'Class'])
    expect(result[0]?.uri).toBe('file:///project/index.ts')
    expect(result[1]?.uri).toBe('file:///project/greeter.ts')
    // The full enclosing range rides through (these are SymbolInformation, range present).
    expect(result[1]?.range).toEqual({
      start: { line: 6, character: 0 },
      end: { line: 12, character: 1 },
    })
  })

  it('carries containerName → container when present', () => {
    const syms: WorkspaceSymbol[] = [
      {
        name: 'greet',
        kind: 6,
        containerName: 'Greeter',
        location: { uri: 'file:///g.ts', range: RANGE },
      },
    ]
    expect(normalizeWorkspaceSymbols(syms)[0]?.container).toBe('Greeter')
  })

  it('handles a uri-only WorkspaceSymbol (range absent — would need workspaceSymbol/resolve)', () => {
    // The LSP 3.17 WorkspaceSymbol form may carry a location with ONLY a uri; the server did not
    // emit this (see fixtures README), so the range-absent policy is asserted on a hand-authored
    // input: surface the uri, omit the range, never crash reading `location.range`.
    const syms: WorkspaceSymbol[] = [{ name: 'Lazy', kind: 5, location: { uri: 'file:///x.ts' } }]
    const out = normalizeWorkspaceSymbols(syms)
    expect(out[0]).toEqual({ name: 'Lazy', kind: 5, kindName: 'Class', uri: 'file:///x.ts' })
    expect(out[0]?.range).toBeUndefined()
  })
})

describe('normalizeDiagnostics', () => {
  it('returns [] for null', () => {
    expect(normalizeDiagnostics(null)).toEqual([])
  })

  it('normalizes the real publishDiagnostics payload (severity name, numeric code, source)', () => {
    const params = fixture<{ diagnostics: Diagnostic[] }>('diagnostics-publish.json')
    const result = normalizeDiagnostics(params.diagnostics)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      severity: 1,
      severityName: 'Error',
      code: 2322,
      source: 'typescript',
    })
    expect(result[0]?.message).toContain('not assignable')
    expect(result[0]?.range.start).toEqual({ line: 5, character: 6 })
    // An empty `tags: []` is dropped (not surfaced as an empty array).
    expect(result[0]?.tags).toBeUndefined()
  })

  it('maps severities + tags to names, keeps a string code, and carries relatedInformation', () => {
    const diags: Diagnostic[] = [
      {
        range: RANGE,
        message: 'unused + deprecated',
        severity: 2,
        code: 'no-unused',
        tags: [1, 2],
        relatedInformation: [
          { location: { uri: 'file:///other.ts', range: RANGE }, message: 'first declared here' },
        ],
      },
    ]
    const [d] = normalizeDiagnostics(diags)
    expect(d?.severityName).toBe('Warning')
    expect(d?.code).toBe('no-unused')
    expect(d?.tags).toEqual(['Unnecessary', 'Deprecated'])
    expect(d?.related?.[0]).toEqual({
      uri: 'file:///other.ts',
      range: RANGE,
      message: 'first declared here',
    })
  })

  it('omits severityName when the server sent no severity', () => {
    const [d] = normalizeDiagnostics([{ range: RANGE, message: 'bare' }])
    expect(d?.severity).toBeUndefined()
    expect(d?.severityName).toBeUndefined()
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

describe('normalizeWorkspaceEdit', () => {
  it('returns empty for null/undefined and an edit with neither shape', () => {
    expect(normalizeWorkspaceEdit(null)).toEqual({ files: [], resourceOps: [] })
    expect(normalizeWorkspaceEdit(undefined)).toEqual({ files: [], resourceOps: [] })
    expect(normalizeWorkspaceEdit({})).toEqual({ files: [], resourceOps: [] })
  })

  it('normalizes the REAL captured `changes` map (tsserver 5.3.0 rename), order preserved', () => {
    const raw = fixture<RawWorkspaceEdit>('rename-changes.json')
    const out = normalizeWorkspaceEdit(raw)
    expect(out.resourceOps).toEqual([])
    expect(out.files.map((f) => f.uri)).toEqual([
      'file:///project/greeter.ts',
      'file:///project/index.ts',
    ])
    expect(out.files[0]?.edits).toHaveLength(1)
    expect(out.files[1]?.edits).toHaveLength(2)
    expect(out.files[0]?.edits[0]).toEqual({
      range: { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } },
      newText: 'Greeter2',
    })
    // per-file edit order preserved (import binding before the `new Greeter` usage)
    expect(out.files[1]?.edits[0]?.range.start.line).toBe(0)
    expect(out.files[1]?.edits[1]?.range.start.line).toBe(2)
  })

  it('normalizes the synthesized `documentChanges` form to the same files/edits', () => {
    const dc = normalizeWorkspaceEdit(fixture<RawWorkspaceEdit>('rename-documentchanges.json'))
    const ch = normalizeWorkspaceEdit(fixture<RawWorkspaceEdit>('rename-changes.json'))
    expect(dc).toEqual(ch)
  })

  it('gives documentChanges PRECEDENCE when both shapes are present (never merges)', () => {
    const raw: RawWorkspaceEdit = {
      changes: { 'file:///project/ignored.ts': [{ range: RANGE, newText: 'NO' }] },
      documentChanges: [
        {
          textDocument: { uri: 'file:///project/win.ts', version: 3 },
          edits: [{ range: RANGE, newText: 'YES' }],
        },
      ],
    }
    const out = normalizeWorkspaceEdit(raw)
    expect(out.files.map((f) => f.uri)).toEqual(['file:///project/win.ts'])
  })

  it('flags resource operations under resourceOps and NEVER as a file edit', () => {
    const raw: RawWorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///project/a.ts', version: 1 },
          edits: [{ range: RANGE, newText: 'x' }],
        },
        { kind: 'rename', oldUri: 'file:///project/a.ts', newUri: 'file:///project/b.ts' },
        { kind: 'delete', uri: 'file:///project/old.ts' },
      ],
    }
    const out = normalizeWorkspaceEdit(raw)
    expect(out.files.map((f) => f.uri)).toEqual(['file:///project/a.ts'])
    expect(out.resourceOps).toEqual([
      { kind: 'rename', uris: ['file:///project/a.ts', 'file:///project/b.ts'] },
      { kind: 'delete', uris: ['file:///project/old.ts'] },
    ])
  })

  it('carries a needsConfirmation annotation as a preview-only signal (never silently dropped)', () => {
    const raw: RawWorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///project/a.ts', version: 1 },
          edits: [{ range: RANGE, newText: 'x', annotationId: 'danger' }],
        },
      ],
      changeAnnotations: { danger: { label: 'Risky rename', needsConfirmation: true } },
    }
    const edit = normalizeWorkspaceEdit(raw).files[0]?.edits[0]
    expect(edit?.needsConfirmation).toBe(true)
    expect(edit?.annotationLabel).toBe('Risky rename')
  })
})

describe('normalizePrepareRename', () => {
  it('returns null when the position is not renameable', () => {
    expect(normalizePrepareRename(null)).toBeNull()
    expect(normalizePrepareRename(undefined)).toBeNull()
  })

  it('normalizes the REAL bare Range (tsserver 5.3.0)', () => {
    const range = { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } }
    expect(normalizePrepareRename(range)).toEqual({ range })
  })

  it('normalizes the {range, placeholder} form', () => {
    expect(normalizePrepareRename({ range: RANGE, placeholder: 'Greeter' })).toEqual({
      range: RANGE,
      placeholder: 'Greeter',
    })
  })

  it('normalizes the {defaultBehavior} form (renameable, server derives the range)', () => {
    expect(normalizePrepareRename({ defaultBehavior: true })).toEqual({ defaultBehavior: true })
  })
})
