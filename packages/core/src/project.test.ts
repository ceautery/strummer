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

function writeText(rel: string, text: string) {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
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

describe('detectInstalledVersion — Python', () => {
  it('prefers the installed dist-info METADATA version (canonical name match)', () => {
    // Project asks for "Django"; the installed dist-info uses the same canonical name.
    writeText(
      '.venv/lib/python3.12/site-packages/django-5.0.1.dist-info/METADATA',
      'Metadata-Version: 2.1\nName: Django\nVersion: 5.0.1\n',
    )
    writeText('requirements.txt', 'Django>=4.0\n')
    expect(detectInstalledVersion(dir, 'Django', { ecosystem: 'python' })).toEqual({
      version: '5.0.1',
      source: 'python:dist-info',
    })
  })

  it('reads a pinned version from requirements.txt (extras + markers tolerated)', () => {
    writeText('requirements.txt', '# deps\nflask[async] == 3.0.2 ; python_version >= "3.9"\n')
    expect(detectInstalledVersion(dir, 'Flask', { ecosystem: 'python' })).toEqual({
      version: '3.0.2',
      source: 'python:requirements',
    })
  })

  it('reads a version from uv.lock / poetry.lock package blocks', () => {
    writeText(
      'uv.lock',
      '[[package]]\nname = "httpx"\nversion = "0.27.0"\n\n[[package]]\nname = "idna"\nversion = "3.6"\n',
    )
    expect(detectInstalledVersion(dir, 'httpx', { ecosystem: 'python' })).toEqual({
      version: '0.27.0',
      source: 'python:lock',
    })
  })

  it('falls back to the declared range in pyproject.toml', () => {
    writeText(
      'pyproject.toml',
      '[project]\nname = "app"\ndependencies = [\n  "requests>=2.31,<3",\n  "rich",\n]\n',
    )
    expect(detectInstalledVersion(dir, 'requests', { ecosystem: 'python' })).toEqual({
      version: '>=2.31,<3',
      source: 'python:pyproject',
    })
  })
})

describe('detectInstalledVersion — Ruby', () => {
  it('prefers the locked spec version in Gemfile.lock', () => {
    writeText(
      'Gemfile.lock',
      'GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.1.3)\n    rack (3.0.9)\n',
    )
    writeText('Gemfile', "gem 'rails', '~> 7.0'\n")
    expect(detectInstalledVersion(dir, 'rails', { ecosystem: 'ruby' })).toEqual({
      version: '7.1.3',
      source: 'ruby:Gemfile.lock',
    })
  })

  it('falls back to the declared constraint in Gemfile', () => {
    writeText('Gemfile', "source 'https://rubygems.org'\ngem 'sinatra', '~> 3.1'\n")
    expect(detectInstalledVersion(dir, 'sinatra', { ecosystem: 'ruby' })).toEqual({
      version: '~> 3.1',
      source: 'ruby:Gemfile',
    })
  })
})

describe('detectInstalledVersion — ecosystem dispatch', () => {
  it('auto-probes ecosystems when none is specified (Python project)', () => {
    writeText('requirements.txt', 'numpy==1.26.4\n')
    expect(detectInstalledVersion(dir, 'numpy')).toEqual({
      version: '1.26.4',
      source: 'python:requirements',
    })
  })

  it('honors an explicit ecosystem even when other manifests exist', () => {
    // A polyglot repo: a Node manifest AND a Gemfile. Force Ruby.
    write('package.json', { dependencies: { rails: '*' } })
    writeText('Gemfile', "gem 'rails', '~> 7.1'\n")
    expect(detectInstalledVersion(dir, 'rails', { ecosystem: 'ruby' })).toEqual({
      version: '~> 7.1',
      source: 'ruby:Gemfile',
    })
  })

  it('reports nothing when the package is in no ecosystem', () => {
    writeText('requirements.txt', 'numpy==1.26.4\n')
    expect(detectInstalledVersion(dir, 'tensorflow')).toEqual({ version: null, source: 'none' })
  })
})
