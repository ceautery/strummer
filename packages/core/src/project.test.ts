import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectInstalledVersion } from './project.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strummer-proj-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, json: unknown) {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, JSON.stringify(json))
}

describe('detectInstalledVersion', () => {
  it('prefers the concrete version installed in node_modules', () => {
    write('package.json', { dependencies: { react: '^18.2.0' } })
    write('node_modules/react/package.json', { name: 'react', version: '18.3.1' })
    expect(detectInstalledVersion(dir, 'react')).toEqual({
      version: '18.3.1',
      source: 'node_modules',
    })
  })

  it('reads a concrete version from package-lock.json when node_modules is absent', () => {
    write('package.json', { dependencies: { react: '^18.0.0' } })
    write('package-lock.json', { packages: { 'node_modules/react': { version: '18.2.0' } } })
    expect(detectInstalledVersion(dir, 'react')).toEqual({
      version: '18.2.0',
      source: 'package-lock.json',
    })
  })

  it('falls back to the declared range in package.json', () => {
    write('package.json', { devDependencies: { react: '^17.0.0' } })
    expect(detectInstalledVersion(dir, 'react')).toEqual({
      version: '^17.0.0',
      source: 'package.json',
    })
  })

  it('resolves scoped package names', () => {
    write('node_modules/@scope/pkg/package.json', { version: '2.1.0' })
    expect(detectInstalledVersion(dir, '@scope/pkg')).toEqual({
      version: '2.1.0',
      source: 'node_modules',
    })
  })

  it('reports nothing when the package is absent', () => {
    write('package.json', { dependencies: { vue: '^3.0.0' } })
    expect(detectInstalledVersion(dir, 'react')).toEqual({ version: null, source: 'none' })
  })
})
