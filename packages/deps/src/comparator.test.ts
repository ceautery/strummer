import { describe, expect, it } from 'vitest'
import { semverComparator } from './comparator.js'

describe('semverComparator', () => {
  const c = semverComparator

  it('validates and detects prereleases', () => {
    expect(c.isValid('1.2.3')).toBe(true)
    expect(c.isValid('not-a-version')).toBe(false)
    expect(c.isPrerelease('1.2.3-rc.1')).toBe(true)
    expect(c.isPrerelease('1.2.3')).toBe(false)
  })

  it('orders versions (compare/gt/lt/lte)', () => {
    expect(c.compare('1.2.3', '1.2.4')).toBe(-1)
    expect(c.compare('2.0.0', '1.9.9')).toBe(1)
    expect(c.compare('1.0.0', '1.0.0')).toBe(0)
    expect(c.gt('2.0.0', '1.0.0')).toBe(true)
    expect(c.lt('1.0.0', '2.0.0')).toBe(true)
    expect(c.lte('1.0.0', '1.0.0')).toBe(true)
  })

  it('cleans/coerces version-ish strings (preserving the existing osv.clean behavior)', () => {
    expect(c.clean('1.2.3')).toBe('1.2.3')
    expect(c.clean('v1.2')).toBe('1.2.0')
    expect(c.clean('garbage')).toBeNull()
  })

  it('exposes release components as [major, minor, patch], null for invalid', () => {
    expect(c.releaseComponents('2.3.4')).toEqual([2, 3, 4])
    expect(c.releaseComponents('nope')).toBeNull()
  })
})
