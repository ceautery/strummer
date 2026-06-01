import { describe, expect, it } from 'vitest'
import { gemComparator } from './gem.js'

const c = gemComparator

describe('gemComparator', () => {
  it('treats trailing-zero releases as equal (1.0 == 1.0.0)', () => {
    expect(c.compare('1.0', '1.0.0')).toBe(0)
    expect(c.lte('1.0', '1.0.0')).toBe(true)
  })

  it('orders releases above their pre-releases, and pre-releases lexically', () => {
    expect(c.compare('1.0.0.rc1', '1.0.0')).toBe(-1) // prerelease < release
    expect(c.compare('1.0.0.beta', '1.0.0.rc1')).toBe(-1)
    expect(c.compare('1.0.0.alpha', '1.0.0.beta')).toBe(-1)
    expect(c.gt('1.0.0', '1.0.0.rc1')).toBe(true)
  })

  it('compares numeric segments numerically (split mixed segments)', () => {
    expect(c.compare('1.0.a9', '1.0.a10')).toBe(-1)
    expect(c.compare('2.0', '10.0')).toBe(-1)
  })

  it('orders a longer numeric tail above the shorter release', () => {
    expect(c.compare('5.1.0', '5.1.0.2')).toBe(-1)
    expect(c.gt('5.1.0.2', '5.1.0')).toBe(true)
  })

  it('detects pre-releases (any letter segment)', () => {
    expect(c.isPrerelease('1.0.0.rc1')).toBe(true)
    expect(c.isPrerelease('2.0.0.beta')).toBe(true)
    expect(c.isPrerelease('1.0.0')).toBe(false)
  })

  it('validates gem versions and rejects junk', () => {
    expect(c.isValid('1.0.0.rc1')).toBe(true)
    expect(c.isValid('not a version')).toBe(false)
    expect(c.clean('1.0.0')).toBe('1.0.0')
    expect(c.clean('not a version')).toBeNull()
  })

  it('exposes leading numeric release components', () => {
    expect(c.releaseComponents('2.3.4')).toEqual([2, 3, 4])
    expect(c.releaseComponents('1.0')).toEqual([1, 0])
    expect(c.releaseComponents('not a version')).toBeNull()
  })
})
