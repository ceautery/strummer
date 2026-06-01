import { describe, expect, it } from 'vitest'
import { normalizePypiName, type PyPiJson, pypiJsonToPackument } from './pypi.js'

describe('normalizePypiName (PEP 503)', () => {
  it('lowercases and collapses runs of -_. to a single dash', () => {
    expect(normalizePypiName('Django')).toBe('django')
    expect(normalizePypiName('ruamel.yaml')).toBe('ruamel-yaml')
    expect(normalizePypiName('foo_bar.baz')).toBe('foo-bar-baz')
    expect(normalizePypiName('A--B__C')).toBe('a-b-c')
  })
})

describe('pypiJsonToPackument', () => {
  const json: PyPiJson = {
    info: { name: 'Django', version: '5.0.1' },
    releases: {
      '5.0.0': [{ yanked: false }],
      '5.0.1': [{ yanked: false }],
      '4.9.9': [{ yanked: true }], // fully yanked → dropped
      '5.0.2rc1': [{ yanked: false }],
      '0.0.0': [], // no installable file → dropped
    },
  }

  it('maps releases into a Packument, dropping fully-yanked and file-less releases', () => {
    const p = pypiJsonToPackument(json)
    expect(Object.keys(p.versions).sort()).toEqual(['5.0.0', '5.0.1', '5.0.2rc1'])
    expect(p.versions['5.0.1']).toEqual({ version: '5.0.1' })
    expect(p['dist-tags']?.latest).toBe('5.0.1')
    expect(p.name).toBe('Django')
  })

  it('tolerates a degenerate report', () => {
    expect(pypiJsonToPackument({}).versions).toEqual({})
    expect(pypiJsonToPackument({ info: { name: 'x' } })['dist-tags']).toBeUndefined()
  })
})
