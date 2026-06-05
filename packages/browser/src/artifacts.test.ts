import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ArtifactStore } from './artifacts.js'

const tmpDirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sackville-browser-artifacts-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('browser ArtifactStore (browser/run prefix) — forwards retention opts (ADR 0017)', () => {
  it('bakes in the browser/run prefix and still applies a forwarded RetentionPolicy', () => {
    const dir = tmp()
    const store = new ArtifactStore(dir, { retention: { maxEntries: 1 }, sweepIntervalMs: 1e9 })
    store.put('old', 'trace', 'x', 'application/zip')
    store.put('new', 'trace', 'y', 'application/zip')
    // Deterministic eviction order via mtime (prefix has a `/`, so two path segments).
    utimesSync(join(dir, 'browser', 'run', 'old'), 1, 1)
    utimesSync(join(dir, 'browser', 'run', 'new'), 2, 2)
    expect(store.sweep()).toEqual(['old'])
    expect(store.get('sackville://browser/run/old/trace')).toBeUndefined()
    expect(store.get('sackville://browser/run/new/trace')?.body.toString('utf8')).toBe('y')
  })

  it('with no opts, never deletes (backward-compatible)', () => {
    const dir = tmp()
    const store = new ArtifactStore(dir)
    store.put('r', 'trace', 'x', 'application/zip')
    expect(store.sweep()).toEqual([])
    expect(store.get('sackville://browser/run/r/trace')).toBeDefined()
  })
})
