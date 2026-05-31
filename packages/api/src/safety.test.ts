import { describe, expect, it } from 'vitest'
import { checkGate, isMutating } from './safety.js'

describe('isMutating', () => {
  it('treats GET/HEAD/OPTIONS as safe and the rest as mutating', () => {
    for (const m of ['GET', 'head', 'OPTIONS']) expect(isMutating(m)).toBe(false)
    for (const m of ['POST', 'put', 'PATCH', 'DELETE']) expect(isMutating(m)).toBe(true)
  })
})

describe('checkGate', () => {
  it('always allows safe methods', () => {
    expect(checkGate('GET', 'example.com', {}).allowed).toBe(true)
  })

  it('withholds mutations without allowUnsafe', () => {
    const d = checkGate('POST', 'example.com', {})
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/mutating/i)
  })

  it('withholds mutations to a non-allowlisted host even with allowUnsafe', () => {
    const d = checkGate('DELETE', 'evil.example', {
      allowUnsafe: true,
      allowedHosts: ['api.example'],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/allowlist/i)
  })

  it('allows a mutation only when unlocked and allowlisted', () => {
    const d = checkGate('POST', 'api.example', { allowUnsafe: true, allowedHosts: ['api.example'] })
    expect(d.allowed).toBe(true)
  })
})
