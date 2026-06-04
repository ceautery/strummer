import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
