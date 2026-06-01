import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  assertAllowed,
  confineEditedUri,
  confineEditedUris,
  confineFile,
  LspGateError,
} from './confine.js'

describe('assertAllowed (paired gate: allowRun + root allowlist)', () => {
  it('throws when allowRun is off', () => {
    expect(() => assertAllowed(false, ['/p'], '/p')).toThrow(/not enabled/i)
  })
  it('throws when the root is not in the allowlist', () => {
    expect(() => assertAllowed(true, ['/allowed'], '/other')).toThrow(
      /not in the operator allowlist/i,
    )
  })
  it('passes for an allowlisted root with allowRun on', () => {
    expect(() => assertAllowed(true, ['/allowed'], '/allowed')).not.toThrow()
  })
})

describe('confineFile (lexical, read path)', () => {
  it('accepts an in-root relative file', () => {
    expect(confineFile('/project', 'src/a.ts')).toBe('/project/src/a.ts')
  })
  it('refuses a .. traversal', () => {
    expect(() => confineFile('/project', '../evil.ts')).toThrow(LspGateError)
  })
  it('refuses an absolute path outside the root', () => {
    expect(() => confineFile('/project', '/etc/passwd')).toThrow(/escapes the project root/i)
  })
})

describe('confineEditedUri (realpath-hardened, write path)', () => {
  // Real filesystem: a symlink INSIDE the root pointing OUTSIDE it must be refused. A lexical
  // resolve() (the read path) passes it; a write would clobber the out-of-root target.
  let root: string
  let outside: string
  beforeAll(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-confine-')))
    root = join(base, 'project')
    outside = join(base, 'outside')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
  })

  it('accepts an in-root file:// URI', () => {
    const f = join(root, 'a.ts')
    writeFileSync(f, 'x')
    expect(confineEditedUri(root, pathToFileURL(f).toString())).toBe(f)
  })

  it('refuses a symlink inside the root that resolves outside it', () => {
    const secret = join(outside, 'secret.ts')
    writeFileSync(secret, 'secret')
    const link = join(root, 'escape.ts')
    symlinkSync(secret, link)
    expect(() => confineEditedUri(root, pathToFileURL(link).toString())).toThrow(
      /escapes the project root/i,
    )
  })

  it('refuses a non-file:// scheme', () => {
    expect(() => confineEditedUri(root, 'jdt://contents/Foo.class')).toThrow(/not a file/i)
  })

  it('refuses a file:// URI with .. that escapes the root', () => {
    expect(() => confineEditedUri('/project', 'file:///project/../evil.ts')).toThrow(LspGateError)
  })
})

describe('confineEditedUris (all-or-nothing)', () => {
  it('throws on the first out-of-root URI', () => {
    expect(() =>
      confineEditedUris('/project', ['file:///project/a.ts', 'file:///etc/passwd']),
    ).toThrow(LspGateError)
  })
})
