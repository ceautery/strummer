import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMainModule } from './is-main.js'

describe('isMainModule — survives symlink invocation (the npx bin trap)', () => {
  let dir: string
  let target: string
  let link: string
  const savedArgv1: string | undefined = process.argv[1]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sackville-ismain-'))
    target = join(dir, 'bin.mjs')
    link = join(dir, 'bin-link.mjs')
    writeFileSync(target, '// entry\n')
    symlinkSync(target, link)
  })

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring a possibly-undefined argv slot.
    ;(process.argv as any)[1] = savedArgv1
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns true when argv[1] is a SYMLINK to the module (how npm/.bin invokes)', () => {
    process.argv[1] = link
    expect(isMainModule(pathToFileURL(target).href)).toBe(true)
  })

  it('returns true when argv[1] is the real path (direct `node bin.mjs`)', () => {
    process.argv[1] = target
    expect(isMainModule(pathToFileURL(target).href)).toBe(true)
  })

  it('returns false when argv[1] is an unrelated path (imported as a module)', () => {
    process.argv[1] = join(dir, 'some-test-runner.mjs')
    expect(isMainModule(pathToFileURL(target).href)).toBe(false)
  })

  it('returns false when argv[1] is undefined', () => {
    // biome-ignore lint/suspicious/noExplicitAny: simulating a no-argv process.
    ;(process.argv as any)[1] = undefined
    expect(isMainModule(pathToFileURL(target).href)).toBe(false)
  })
})
