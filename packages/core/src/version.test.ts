import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { listVersions, resolveVersion } from './version.js'

const AVAIL = ['19.2', '18.3.1', '17.0.2']

describe('resolveVersion', () => {
  it('returns an exact match when a release satisfies the request', () => {
    const r = resolveVersion(AVAIL, '18.3.1')
    expect(r).toMatchObject({ resolved: '18.3.1', exact: true })
  })

  it('treats a caret range as satisfied by the newest in-range release', () => {
    const r = resolveVersion(AVAIL, '^18.0.0')
    expect(r).toMatchObject({ resolved: '18.3.1', exact: true })
  })

  it('falls back to the newest same-major release and flags it', () => {
    const r = resolveVersion(AVAIL, '18.2.0')
    expect(r.resolved).toBe('18.3.1')
    expect(r.exact).toBe(false)
    expect(r.note).toContain('nearest')
  })

  it('resolves a bare major to the newest release of that major', () => {
    expect(resolveVersion(AVAIL, '17').resolved).toBe('17.0.2')
  })

  it('refuses when no release shares the requested major', () => {
    const r = resolveVersion(AVAIL, '16.8.0')
    expect(r.resolved).toBeNull()
    expect(r.note).toContain('available versions')
  })

  it('handles an empty index', () => {
    expect(resolveVersion([], '18.0.0')).toMatchObject({ resolved: null })
  })
})

describe('listVersions', () => {
  it('returns distinct versions for a library, newest first', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE docs(id INTEGER PRIMARY KEY, library TEXT, version TEXT, body TEXT)')
    const ins = db.prepare('INSERT INTO docs(library, version, body) VALUES (?, ?, ?)')
    for (const [lib, ver] of [
      ['react', '19.2'],
      ['react', '18.3.1'],
      ['react', '18.3.1'],
      ['react', '17.0.2'],
      ['vue', '3.5.0'],
    ] as const) {
      ins.run(lib, ver, 'x')
    }
    expect(listVersions(db, 'react')).toEqual(['19.2', '18.3.1', '17.0.2'])
    expect(listVersions(db, 'vue')).toEqual(['3.5.0'])
    db.close()
  })
})
