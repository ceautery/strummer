import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ArtifactStore, retentionFromEnv } from './store.js'

/** Stamp an <id> dir's mtime deterministically (seconds) so eviction order is stable. */
function stampMtime(baseDir: string, prefix: string, id: string, seconds: number): void {
  utimesSync(join(baseDir, ...prefix.split('/'), id), seconds, seconds)
}

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
    // The on-disk layout is <baseDir>/<prefix>/<id>/<kind> (prefix INTO the path,
    // per ADR 0013 slice 1 — so one shared baseDir is collision-free across pillars).
    expect(readFileSync(join(dir, 'browser', 'run', 'r', 'console'), 'utf8')).toBe('log line')
  })
})

describe('ArtifactStore — cross-prefix resolution + hardening (ADR 0013 slice 1)', () => {
  it('resolves a foreign-prefix handle over a shared baseDir (rehydrate-on-miss)', () => {
    const dir = tmp()
    // The browser pillar writes a HAR; a different store (the verify pillar) over
    // the SAME baseDir must resolve that handle it never put() itself.
    const browser = new ArtifactStore(dir, 'browser/run')
    const handle = browser.put('run42', 'har', '{"log":{}}', 'application/json')

    const verify = new ArtifactStore(dir, 'verify')
    const got = verify.get(handle)
    expect(got?.body.toString('utf8')).toBe('{"log":{}}')
    expect(got?.contentType).toBe('application/json')
    expect(got?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does NOT clobber: same id+kind under different prefixes are distinct on disk', () => {
    const dir = tmp()
    const a = new ArtifactStore(dir, 'browser/run')
    const b = new ArtifactStore(dir, 'verify')
    a.put('shared', 'blob', 'from-browser', 'text/plain')
    b.put('shared', 'blob', 'from-verify', 'text/plain')
    // Each resolves its OWN bytes — no overwrite.
    expect(a.get('strummer://browser/run/shared/blob')?.body.toString('utf8')).toBe('from-browser')
    expect(b.get('strummer://verify/shared/blob')?.body.toString('utf8')).toBe('from-verify')
  })

  it('recovers contentType from the sidecar on rehydrate; legacy artifact ⇒ inferred octet-stream', () => {
    const dir = tmp()
    const writer = new ArtifactStore(dir, 'deps')
    writer.put('lodash', 'changelog', '# diff', 'text/markdown')
    // A fresh store (cold process) has an empty in-process map — forces rehydrate.
    const reader = new ArtifactStore(dir, 'deps')
    const got = reader.get('strummer://deps/lodash/changelog')
    expect(got?.contentType).toBe('text/markdown')
    expect(got?.contentTypeInferred).toBeFalsy()

    // A legacy artifact written without a sidecar: bytes on disk, no <kind>.meta.json.
    const legacyDir = join(dir, 'deps', 'legacy')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'blob'), 'raw')
    const legacy = reader.get('strummer://deps/legacy/blob')
    expect(legacy?.body.toString('utf8')).toBe('raw')
    expect(legacy?.contentType).toBe('application/octet-stream')
    expect(legacy?.contentTypeInferred).toBe(true)
  })

  it('refuses a handle whose id/kind contains traversal or separators', () => {
    const store = new ArtifactStore(tmp(), 'verify')
    expect(() => store.get('strummer://verify/../../etc/passwd')).toThrow()
    expect(() => store.get('strummer://verify/ok/..')).toThrow()
    // A prefix segment cannot escape either.
    expect(() => store.get('strummer://../evil/id/kind')).toThrow()
  })

  it('refuses to put() an id/kind that is not a safe segment', () => {
    const store = new ArtifactStore(tmp(), 'verify')
    expect(() => store.put('../escape', 'kind', 'x', 'text/plain')).toThrow()
    expect(() => store.put('id', 'a/b', 'x', 'text/plain')).toThrow()
  })

  it('refuses a rehydrate that realpath-escapes baseDir via a symlinked prefix dir', () => {
    const dir = tmp()
    const outside = tmp()
    writeFileSync(join(outside, 'secret'), 'TOP SECRET')
    // Plant a symlink <baseDir>/verify/leak -> <outside>, so a well-formed handle
    // strummer://verify/leak/secret would resolve through it.
    mkdirSync(join(dir, 'verify'), { recursive: true })
    symlinkSync(outside, join(dir, 'verify', 'leak'), 'dir')
    const store = new ArtifactStore(dir, 'verify')
    expect(() => store.get('strummer://verify/leak/secret')).toThrow()
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

describe('ArtifactStore — retention / GC (ADR 0017)', () => {
  it('with NO policy, never deletes (backward-compatible)', () => {
    const dir = tmp()
    const store = new ArtifactStore(dir, 'p')
    for (const id of ['a', 'b', 'c']) store.put(id, 'k', 'x', 'text/plain')
    expect(store.sweep()).toEqual([]) // explicit sweep is a no-op without a policy
    for (const id of ['a', 'b', 'c']) {
      expect(store.get(`strummer://p/${id}/k`)?.body.toString('utf8')).toBe('x')
    }
  })

  it('maxEntries keeps the newest N <id> dirs, evicting the oldest by mtime', () => {
    const dir = tmp()
    const store = new ArtifactStore(dir, 'p', {
      retention: { maxEntries: 2 },
      sweepIntervalMs: 1e9,
    })
    store.put('old', 'k', 'x', 'text/plain')
    store.put('mid', 'k', 'x', 'text/plain')
    store.put('new', 'k', 'x', 'text/plain')
    stampMtime(dir, 'p', 'old', 1000)
    stampMtime(dir, 'p', 'mid', 2000)
    stampMtime(dir, 'p', 'new', 3000)
    expect(store.sweep().sort()).toEqual(['old'])
    expect(store.get('strummer://p/old/k')).toBeUndefined()
    expect(store.get('strummer://p/mid/k')).toBeDefined()
    expect(store.get('strummer://p/new/k')).toBeDefined()
  })

  it('maxAgeMs evicts <id> dirs older than now - maxAgeMs (mtime), keeps fresher', () => {
    const dir = tmp()
    const now = 100_000
    const store = new ArtifactStore(dir, 'p', { retention: { maxAgeMs: 5000 }, now: () => now })
    store.put('stale', 'k', 'x', 'text/plain')
    store.put('fresh', 'k', 'x', 'text/plain')
    stampMtime(dir, 'p', 'stale', (now - 10_000) / 1000) // 10s old → evicted
    stampMtime(dir, 'p', 'fresh', (now - 1000) / 1000) // 1s old → kept
    expect(store.sweep().sort()).toEqual(['stale'])
    expect(store.get('strummer://p/stale/k')).toBeUndefined()
    expect(store.get('strummer://p/fresh/k')).toBeDefined()
  })

  it('maxBytes evicts oldest-first until the prefix subtree is under the cap', () => {
    const dir = tmp()
    // Each run is ~128 bytes on disk (100-byte body + its ~28-byte meta sidecar). A cap
    // of 300 keeps the newest 2 (~256 ≤ 300) and evicts the oldest (the 3rd → ~384 > 300).
    const body = 'x'.repeat(100)
    const store = new ArtifactStore(dir, 'p', {
      retention: { maxBytes: 300 },
      sweepIntervalMs: 1e9,
    })
    store.put('o1', 'k', body, 'text/plain')
    store.put('o2', 'k', body, 'text/plain')
    store.put('o3', 'k', body, 'text/plain')
    stampMtime(dir, 'p', 'o1', 1000)
    stampMtime(dir, 'p', 'o2', 2000)
    stampMtime(dir, 'p', 'o3', 3000)
    expect(store.sweep().sort()).toEqual(['o1'])
    expect(store.get('strummer://p/o1/k')).toBeUndefined()
    expect(store.get('strummer://p/o2/k')).toBeDefined()
    expect(store.get('strummer://p/o3/k')).toBeDefined()
  })

  it('a sweep only touches its OWN prefix subtree (never a foreign pillar)', () => {
    const dir = tmp()
    const browser = new ArtifactStore(dir, 'browser/run')
    browser.put('b1', 'har', 'x', 'application/json')
    // A deps store with an aggressive policy must NOT evict the browser artifact.
    const deps = new ArtifactStore(dir, 'deps', { retention: { maxEntries: 0 } })
    deps.put('d1', 'changelog', 'y', 'text/markdown')
    deps.sweep()
    expect(browser.get('strummer://browser/run/b1/har')).toBeDefined()
  })

  it('put() runs a THROTTLED opportunistic sweep (injected clock, sweepIntervalMs)', () => {
    const dir = tmp()
    let t = 0
    const store = new ArtifactStore(dir, 'p', {
      retention: { maxEntries: 1 },
      sweepIntervalMs: 1000,
      now: () => t,
    })
    t = 0
    store.put('a', 'k', 'x', 'text/plain') // sweep@0: only `a`, nothing to evict
    stampMtime(dir, 'p', 'a', 1)
    t = 500
    store.put('b', 'k', 'x', 'text/plain') // 500 < 1000 ⇒ THROTTLED, no sweep
    stampMtime(dir, 'p', 'b', 2)
    // Proof of throttle: despite maxEntries:1, `a` is still present (no sweep yet).
    expect(store.get('strummer://p/a/k')).toBeDefined()
    t = 1500
    store.put('c', 'k', 'x', 'text/plain') // 1500 - 0 ≥ 1000 ⇒ sweep: keep newest 1 (`c`)
    expect(store.get('strummer://p/a/k')).toBeUndefined()
    expect(store.get('strummer://p/b/k')).toBeUndefined()
    expect(store.get('strummer://p/c/k')).toBeDefined()
  })

  it('retentionFromEnv parses set dimensions, ignores invalid, and is undefined when unset', () => {
    expect(retentionFromEnv({ maxAgeMs: '5000', maxEntries: '20', maxBytes: '1048576' })).toEqual({
      maxAgeMs: 5000,
      maxEntries: 20,
      maxBytes: 1048576,
    })
    expect(retentionFromEnv({ maxEntries: '10' })).toEqual({ maxEntries: 10 })
    expect(retentionFromEnv({})).toBeUndefined()
    // A typo / negative never silently deletes everything (ignored ⇒ unset).
    expect(retentionFromEnv({ maxBytes: 'lots', maxAgeMs: '-1' })).toBeUndefined()
    // 0 is a legitimate cap (keep none).
    expect(retentionFromEnv({ maxEntries: '0' })).toEqual({ maxEntries: 0 })
  })

  it('never deletes THROUGH a symlinked <id> dir that escapes baseDir', () => {
    const dir = tmp()
    const outside = tmp()
    writeFileSync(join(outside, 'secret'), 'TOP SECRET')
    mkdirSync(join(dir, 'p'), { recursive: true })
    symlinkSync(outside, join(dir, 'p', 'leak'), 'dir') // an "old" id dir that escapes
    utimesSync(join(dir, 'p', 'leak'), 1, 1)
    const store = new ArtifactStore(dir, 'p', { retention: { maxAgeMs: 1 }, now: () => 1e9 })
    store.sweep()
    // The escaping symlink target's content must survive (never deleted through).
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('TOP SECRET')
  })
})
