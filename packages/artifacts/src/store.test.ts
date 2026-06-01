import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ArtifactStore } from './store.js'

const tmpDirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strummer-artifacts-'))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('ArtifactStore — shared on-disk store with a parameterized handle prefix', () => {
  it('mints handles under the configured prefix (browser pillar)', () => {
    const store = new ArtifactStore(tmp(), 'browser/run')
    const handle = store.put('run1', 'trace', 'hi', 'application/zip')
    expect(handle).toBe('strummer://browser/run/run1/trace')
  })

  it('mints handles under a different prefix (deps pillar) over the same code', () => {
    const store = new ArtifactStore(tmp(), 'deps')
    const handle = store.put('lodash', 'changelog', 'diff', 'text/markdown')
    expect(handle).toBe('strummer://deps/lodash/changelog')
  })

  it('writes bytes to disk and resolves them back by handle with metadata', () => {
    const dir = tmp()
    const store = new ArtifactStore(dir, 'browser/run')
    const handle = store.put('r', 'console', 'log line', 'text/plain')
    const got = store.get(handle)
    expect(got?.body.toString('utf8')).toBe('log line')
    expect(got?.contentType).toBe('text/plain')
    expect(got?.byteSize).toBe(Buffer.byteLength('log line'))
    expect(got?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(got?.path ?? '')).toBe(true)
    // The on-disk layout is <baseDir>/<runId>/<kind>.
    expect(readFileSync(join(dir, 'r', 'console'), 'utf8')).toBe('log line')
  })

  it('accepts Buffer bodies (binary artifacts) unchanged', () => {
    const store = new ArtifactStore(tmp(), 'browser/run')
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
    const handle = store.put('r', 'video', bytes, 'video/webm')
    const got = store.get(handle)
    expect(got?.body.equals(bytes)).toBe(true)
    expect(got?.byteSize).toBe(4)
  })

  it('returns undefined for an unknown handle', () => {
    const store = new ArtifactStore(tmp(), 'browser/run')
    expect(store.get('strummer://browser/run/nope/trace')).toBeUndefined()
  })

  it('exposes handleFor so callers can reconstruct a handle without re-storing', () => {
    const store = new ArtifactStore(tmp(), 'browser/run')
    expect(store.handleFor('r', 'har')).toBe('strummer://browser/run/r/har')
  })
})
