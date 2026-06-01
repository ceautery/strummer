import { describe, expect, it } from 'vitest'
import { LspRegistryError, parseServerRegistry, resolveServer } from './registry.js'

const VALID = JSON.stringify({
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    initializationOptions: { preferences: {} },
  },
  go: { command: 'gopls', args: [] },
})

describe('parseServerRegistry', () => {
  it('parses an operator JSON registry into typed entries', () => {
    const reg = parseServerRegistry(VALID)
    expect(reg.typescript).toEqual({
      command: 'typescript-language-server',
      args: ['--stdio'],
      initializationOptions: { preferences: {} },
    })
    expect(reg.go).toEqual({ command: 'gopls', args: [] })
  })

  it('defaults a missing args to an empty array', () => {
    const reg = parseServerRegistry(JSON.stringify({ rust: { command: 'rust-analyzer' } }))
    expect(reg.rust).toEqual({ command: 'rust-analyzer', args: [] })
  })

  it('honours an optional languageId override', () => {
    const reg = parseServerRegistry(
      JSON.stringify({ tsx: { command: 'x', args: [], languageId: 'typescriptreact' } }),
    )
    expect(reg.tsx?.languageId).toBe('typescriptreact')
  })

  it('rejects invalid JSON', () => {
    expect(() => parseServerRegistry('{not json')).toThrow(LspRegistryError)
  })

  it('rejects a non-object top level', () => {
    expect(() => parseServerRegistry('[]')).toThrow(LspRegistryError)
    expect(() => parseServerRegistry('"x"')).toThrow(LspRegistryError)
  })

  it('rejects an entry missing a string command (command/args structurally separate, no DSL)', () => {
    expect(() => parseServerRegistry(JSON.stringify({ ts: { args: [] } }))).toThrow(/command/i)
    expect(() => parseServerRegistry(JSON.stringify({ ts: { command: 42 } }))).toThrow(/command/i)
    expect(() => parseServerRegistry(JSON.stringify({ ts: { command: '' } }))).toThrow(/command/i)
  })

  it('rejects args that is not an array of strings', () => {
    expect(() =>
      parseServerRegistry(JSON.stringify({ ts: { command: 'x', args: '--stdio' } })),
    ).toThrow(/args/i)
    expect(() => parseServerRegistry(JSON.stringify({ ts: { command: 'x', args: [1] } }))).toThrow(
      /args/i,
    )
  })

  it('rejects an empty registry (no servers bound is an operator error, not a silent no-op)', () => {
    expect(() => parseServerRegistry('{}')).toThrow(LspRegistryError)
  })
})

describe('resolveServer', () => {
  it('returns the entry for a bound language', () => {
    const reg = parseServerRegistry(VALID)
    expect(resolveServer(reg, 'go').command).toBe('gopls')
  })

  it('refuses an unbound language — never spawns an unregistered server', () => {
    const reg = parseServerRegistry(VALID)
    expect(() => resolveServer(reg, 'python')).toThrow(LspRegistryError)
  })
})
