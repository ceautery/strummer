import { describe, expect, it } from 'vitest'
import { pep440Comparator } from './pep440.js'

const c = pep440Comparator

describe('pep440Comparator', () => {
  // PEP 440's own canonical increasing sequence — the authoritative ordering fixture.
  const ORDERED = [
    '1.dev0',
    '1.0.dev456',
    '1.0a1',
    '1.0a2.dev456',
    '1.0a12.dev456',
    '1.0a12',
    '1.0b1.dev456',
    '1.0b2',
    '1.0b2.post345.dev456',
    '1.0b2.post345',
    '1.0rc1.dev456',
    '1.0rc1',
    '1.0',
    '1.0+abc.5',
    '1.0+abc.7',
    '1.0+5',
    '1.0.post456.dev34',
    '1.0.post456',
    '1.0.15',
    '1.1.dev1',
  ]

  it('orders the canonical PEP 440 sequence strictly ascending', () => {
    for (let i = 0; i < ORDERED.length - 1; i++) {
      const a = ORDERED[i] as string
      const b = ORDERED[i + 1] as string
      expect(c.compare(a, b), `${a} < ${b}`).toBe(-1)
      expect(c.gt(b, a)).toBe(true)
      expect(c.lt(a, b)).toBe(true)
    }
  })

  it('treats zero-padded releases as equal (1.0 == 1.0.0 == 1.0.0.0)', () => {
    expect(c.compare('1.0', '1.0.0')).toBe(0)
    expect(c.compare('1.0.0', '1.0.0.0')).toBe(0)
    expect(c.lte('1.0', '1.0.0')).toBe(true)
  })

  it('honours epoch dominance', () => {
    expect(c.compare('1!1.0', '2.0')).toBe(1)
    expect(c.compare('1.0', '1!0.1')).toBe(-1)
  })

  it('compares numeric release segments numerically, not lexically', () => {
    expect(c.compare('1.0.9', '1.0.10')).toBe(-1)
  })

  it('detects pre-releases (dev/a/b/rc) and treats finals/post as stable', () => {
    expect(c.isPrerelease('1.0.0rc1')).toBe(true)
    expect(c.isPrerelease('1.0.0.dev1')).toBe(true)
    expect(c.isPrerelease('1.0a1')).toBe(true)
    expect(c.isPrerelease('1.0.0')).toBe(false)
    expect(c.isPrerelease('1.0.0.post1')).toBe(false)
  })

  it('validates PEP 440 strings (and rejects junk)', () => {
    expect(c.isValid('1!2.0.post1')).toBe(true)
    expect(c.isValid('1.0.0rc1')).toBe(true)
    expect(c.isValid('not-a-version')).toBe(false)
    expect(c.clean('1.0.0')).not.toBeNull()
    expect(c.clean('garbage')).toBeNull()
  })

  it('exposes the release tuple as components (epoch-independent)', () => {
    expect(c.releaseComponents('2.3.4')).toEqual([2, 3, 4])
    expect(c.releaseComponents('1.0')).toEqual([1, 0])
    expect(c.releaseComponents('nope')).toBeNull()
  })

  it('versionTokens surfaces PEP 440 heading shapes (≥2 segments; no bare years)', () => {
    expect(c.versionTokens?.('## 1.0 - 2024-01-15')).toEqual(['1.0'])
    expect(c.versionTokens?.('## 2.0.0rc1')).toEqual(['2.0.0rc1'])
    expect(c.versionTokens?.('## 2.0.0a1 (alpha)')).toEqual(['2.0.0a1'])
    expect(c.versionTokens?.('## 1!2.3.4')).toEqual(['1!2.3.4'])
    // a bare year / single numeric segment is never a candidate
    expect(c.versionTokens?.('## Released 2024')).toEqual([])
  })
})
