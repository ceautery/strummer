import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import {
  planMutmutScope,
  ScopeEmitError,
  synthesizeScopedCosmicRayConfig,
  synthesizeScopedMutmutPyproject,
} from './config.js'

/**
 * These tests are pinned to the SLICE 0 captures (ADR 0010 addendum 2; cosmic-ray 8.4.6 /
 * mutmut 3.5.0) — see `test/fixtures/README.md`. cosmic-ray scopes via a `module-path` FILE LIST
 * and `excluded-modules` SUBTRACTS (exact + fnmatch glob). mutmut scopes via `paths_to_mutate`
 * (NOT `only_mutate`/`source_paths`) and needs the rest of the package `also_copy`'d.
 */

// The captured cosmic-ray 8.4.6 baseline (whole-package `module-path`).
const COSMIC_BASE = `[cosmic-ray]
module-path = "pkg"
timeout = 30.0
excluded-modules = []
test-command = "python -m pytest -x"

[cosmic-ray.distributor]
name = "local"
`

interface ParsedCosmic {
  'cosmic-ray': {
    'module-path'?: unknown
    'excluded-modules'?: unknown
    timeout?: unknown
    'test-command'?: unknown
    distributor?: { name?: unknown }
  }
}
const parseCosmic = (toml: string): ParsedCosmic => parse(toml) as unknown as ParsedCosmic

describe('synthesizeScopedCosmicRayConfig (ADR 0010 addendum 2 — Fork A)', () => {
  it('overrides module-path to the selected FILE LIST, preserving timeout/test-command/distributor', () => {
    const r = synthesizeScopedCosmicRayConfig(COSMIC_BASE, ['pkg/calc.py', 'pkg/strutil.py'])
    expect(r.modulePath).toEqual(['pkg/calc.py', 'pkg/strutil.py'])
    const cr = parseCosmic(r.toml)['cosmic-ray']
    expect(cr['module-path']).toEqual(['pkg/calc.py', 'pkg/strutil.py'])
    expect(cr.timeout).toBe(30)
    expect(cr['test-command']).toBe('python -m pytest -x')
    expect(cr.distributor?.name).toBe('local')
  })

  it('emits module-path as a LIST even for a single file (uniform; 8.4.6 accepts both)', () => {
    const r = synthesizeScopedCosmicRayConfig(COSMIC_BASE, ['pkg/calc.py'])
    expect(r.modulePath).toEqual(['pkg/calc.py'])
    expect(parseCosmic(r.toml)['cosmic-ray']['module-path']).toEqual(['pkg/calc.py'])
  })

  it('normalizes, dedupes and sorts the selected files', () => {
    const r = synthesizeScopedCosmicRayConfig(COSMIC_BASE, ['./pkg/b.py', 'pkg\\a.py', 'pkg/b.py'])
    expect(r.modulePath).toEqual(['pkg/a.py', 'pkg/b.py'])
  })

  it('STRIPS an inherited excluded-modules entry that EXACTLY matches a selected file (blocker #3)', () => {
    const base = COSMIC_BASE.replace(
      'excluded-modules = []',
      'excluded-modules = ["pkg/strutil.py"]',
    )
    const r = synthesizeScopedCosmicRayConfig(base, ['pkg/calc.py', 'pkg/strutil.py'])
    expect(r.strippedExclusions).toEqual(['pkg/strutil.py'])
    expect(parseCosmic(r.toml)['cosmic-ray']['excluded-modules']).toEqual([])
  })

  it('STRIPS an inherited excluded-modules GLOB that matches a selected file (fnmatch, crosses /)', () => {
    const base = COSMIC_BASE.replace('excluded-modules = []', 'excluded-modules = ["*/strutil.py"]')
    const r = synthesizeScopedCosmicRayConfig(base, ['pkg/calc.py', 'pkg/strutil.py'])
    expect(r.strippedExclusions).toEqual(['*/strutil.py'])
    expect(parseCosmic(r.toml)['cosmic-ray']['excluded-modules']).toEqual([])
  })

  it('KEEPS an inherited excluded-modules entry that matches NO selected file', () => {
    const base = COSMIC_BASE.replace(
      'excluded-modules = []',
      'excluded-modules = ["pkg/other.py", "pkg/strutil.py"]',
    )
    const r = synthesizeScopedCosmicRayConfig(base, ['pkg/calc.py', 'pkg/strutil.py'])
    expect(r.strippedExclusions).toEqual(['pkg/strutil.py'])
    expect(parseCosmic(r.toml)['cosmic-ray']['excluded-modules']).toEqual(['pkg/other.py'])
  })

  it('throws ScopeEmitError on an empty selection (the caller handles the pre-spawn noop)', () => {
    expect(() => synthesizeScopedCosmicRayConfig(COSMIC_BASE, [])).toThrow(ScopeEmitError)
  })

  it('throws ScopeEmitError when the base config has no [cosmic-ray] table', () => {
    expect(() => synthesizeScopedCosmicRayConfig('[other]\nx = 1\n', ['pkg/a.py'])).toThrow(
      ScopeEmitError,
    )
  })
})

describe('planMutmutScope (ADR 0010 addendum 2 — Fork B, corrected by slice 0)', () => {
  const ALL = ['pkg/__init__.py', 'pkg/calc.py', 'pkg/geo.py', 'pkg/strutil.py']

  it('scopes paths_to_mutate to the selected files; also_copy = the rest of the source tree', () => {
    const plan = planMutmutScope(['pkg/calc.py'], ALL)
    expect(plan.pathsToMutate).toEqual(['pkg/calc.py'])
    expect(plan.alsoCopy).toEqual(['pkg/__init__.py', 'pkg/geo.py', 'pkg/strutil.py'])
  })

  it('normalizes/dedupes/sorts and never lists a selected file in also_copy', () => {
    const plan = planMutmutScope(['./pkg/calc.py', 'pkg\\calc.py', 'pkg/geo.py'], ALL)
    expect(plan.pathsToMutate).toEqual(['pkg/calc.py', 'pkg/geo.py'])
    expect(plan.alsoCopy).toEqual(['pkg/__init__.py', 'pkg/strutil.py'])
  })

  it('STRIPS an inherited do_not_mutate glob that would exclude a selected file (blocker #3, mutmut form)', () => {
    const plan = planMutmutScope(['pkg/calc.py'], ALL, ['*/calc.py', 'pkg/legacy.py'])
    expect(plan.strippedDoNotMutate).toEqual(['*/calc.py'])
    expect(plan.doNotMutate).toEqual(['pkg/legacy.py'])
  })

  it('throws ScopeEmitError on an empty selection', () => {
    expect(() => planMutmutScope([], ALL)).toThrow(ScopeEmitError)
  })
})

describe('synthesizeScopedMutmutPyproject (ADR 0010 addendum 2 — Fork F: only verified keys)', () => {
  interface ParsedPyproject {
    'build-system'?: { requires?: unknown }
    tool: {
      mutmut: {
        paths_to_mutate?: unknown
        also_copy?: unknown
        do_not_mutate?: unknown
        pytest_add_cli_args?: unknown
      }
      pytest?: { ini_options?: { testpaths?: unknown } }
    }
  }
  const parsePyproject = (toml: string): ParsedPyproject =>
    parse(toml) as unknown as ParsedPyproject

  it('writes [tool.mutmut] paths_to_mutate + also_copy, preserving other tool sections', () => {
    const base = `[build-system]
requires = ["setuptools"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`
    const plan = planMutmutScope(['pkg/calc.py'], ['pkg/calc.py', 'pkg/geo.py'])
    const parsed = parsePyproject(synthesizeScopedMutmutPyproject(base, plan))
    expect(parsed.tool.mutmut.paths_to_mutate).toEqual(['pkg/calc.py'])
    expect(parsed.tool.mutmut.also_copy).toEqual(['pkg/geo.py'])
    // other sections preserved
    expect(parsed['build-system']?.requires).toEqual(['setuptools'])
    expect(parsed.tool.pytest?.ini_options?.testpaths).toEqual(['tests'])
  })

  it('merges scope keys into an inherited [tool.mutmut], preserving verified keys and dropping stripped do_not_mutate', () => {
    const base = `[tool.mutmut]
pytest_add_cli_args = ["-x"]
do_not_mutate = ["*/calc.py", "pkg/legacy.py"]
`
    const plan = planMutmutScope(
      ['pkg/calc.py'],
      ['pkg/calc.py', 'pkg/geo.py'],
      ['*/calc.py', 'pkg/legacy.py'],
    )
    const parsed = parsePyproject(synthesizeScopedMutmutPyproject(base, plan))
    expect(parsed.tool.mutmut.paths_to_mutate).toEqual(['pkg/calc.py'])
    expect(parsed.tool.mutmut.also_copy).toEqual(['pkg/geo.py'])
    expect(parsed.tool.mutmut.pytest_add_cli_args).toEqual(['-x'])
    // the colliding do_not_mutate glob is stripped; the harmless one is kept
    expect(parsed.tool.mutmut.do_not_mutate).toEqual(['pkg/legacy.py'])
  })

  it('omits an empty do_not_mutate entirely (no key when nothing remains)', () => {
    const plan = planMutmutScope(['pkg/calc.py'], ['pkg/calc.py', 'pkg/geo.py'])
    const parsed = parsePyproject(synthesizeScopedMutmutPyproject('', plan))
    expect(parsed.tool.mutmut.do_not_mutate).toBeUndefined()
    expect(parsed.tool.mutmut.paths_to_mutate).toEqual(['pkg/calc.py'])
  })
})
