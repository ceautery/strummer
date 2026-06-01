import { describe, expect, it } from 'vitest'
import { buildCoverageServerFromEnv } from './bin-coverage.js'

describe('strummer-coverage-mcp bin config (operator env)', () => {
  it('defaults to run disabled, no roots, no timeout (read-only analysis only)', () => {
    expect(buildCoverageServerFromEnv({}).config).toEqual({
      allowRun: false,
      allowedRoots: [],
      timeoutMs: undefined,
    })
  })

  it('parses the paired gate: STRUMMER_COVERAGE_ALLOW_RUN + _PROJECT_ROOTS (+ _TIMEOUT_MS)', () => {
    const { config } = buildCoverageServerFromEnv({
      STRUMMER_COVERAGE_ALLOW_RUN: '1',
      STRUMMER_COVERAGE_PROJECT_ROOTS: '/abs/a, /abs/b ,',
      STRUMMER_COVERAGE_TIMEOUT_MS: '120000',
    })
    expect(config.allowRun).toBe(true)
    expect(config.allowedRoots).toEqual(['/abs/a', '/abs/b'])
    expect(config.timeoutMs).toBe(120000)
  })

  it('ignores a non-numeric timeout', () => {
    expect(
      buildCoverageServerFromEnv({ STRUMMER_COVERAGE_TIMEOUT_MS: 'soon' }).config.timeoutMs,
    ).toBeUndefined()
  })

  it('always builds a usable server', () => {
    expect(buildCoverageServerFromEnv({}).server).toBeDefined()
    expect(
      buildCoverageServerFromEnv({
        STRUMMER_COVERAGE_ALLOW_RUN: '1',
        STRUMMER_COVERAGE_PROJECT_ROOTS: '/x',
      }).server,
    ).toBeDefined()
  })
})
