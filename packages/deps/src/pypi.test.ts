import { describe, expect, it } from 'vitest'
import {
  normalizePypiName,
  type PyPiJson,
  pypiJsonToPackument,
  pythonManifestNames,
} from './pypi.js'

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

describe('pythonManifestNames', () => {
  it('reads PEP 621 [project] dependencies + optional-dependencies (includeDev), normalized', () => {
    const pyproject = `
[project]
name = "app"
dependencies = [
  "Flask>=2.0",
  "requests",
  "ruamel.yaml<1",
]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff"]
`
    expect(pythonManifestNames({ pyproject }, { includeDev: true })).toEqual([
      'flask',
      'pytest',
      'requests',
      'ruamel-yaml',
      'ruff',
    ])
    // Without dev, the optional-dependencies group is excluded.
    expect(pythonManifestNames({ pyproject }, { includeDev: false })).toEqual([
      'flask',
      'requests',
      'ruamel-yaml',
    ])
  })

  it('reads Poetry deps + group deps, skipping the python constraint', () => {
    const pyproject = `
[tool.poetry.dependencies]
python = "^3.11"
django = "^5.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
`
    expect(pythonManifestNames({ pyproject }, { includeDev: true })).toEqual(['django', 'pytest'])
    expect(pythonManifestNames({ pyproject }, { includeDev: false })).toEqual(['django'])
  })

  it('falls back to requirements.txt when pyproject declares none', () => {
    const requirements = `# deps
Django==5.0.0
requests>=2,<3
-e .
--hash=sha256:abc
https://example.test/pkg.whl
`
    expect(pythonManifestNames({ requirements })).toEqual(['django', 'requests'])
  })
})
