import { describe, expect, it } from 'vitest'
import { buildMutateServerFromEnv } from './bin-mutate.js'

describe('sackville-mutate-mcp bin config (operator env)', () => {
  it('defaults to run disabled, no roots (read-only summarize only)', () => {
    expect(buildMutateServerFromEnv({}).config).toEqual({
      allowRun: false,
      allowedRoots: [],
      timeoutMs: undefined,
      reportPath: undefined,
    })
  })

  it('parses the paired gate + report path override', () => {
    const { config } = buildMutateServerFromEnv({
      SACKVILLE_MUTATE_ALLOW_RUN: 'yes',
      SACKVILLE_MUTATE_PROJECT_ROOTS: '/abs/a, /abs/b ,',
      SACKVILLE_MUTATE_TIMEOUT_MS: '1800000',
      SACKVILLE_MUTATE_REPORT_PATH: '/abs/a/reports/mutation/mutation.json',
    })
    expect(config.allowRun).toBe(true)
    expect(config.allowedRoots).toEqual(['/abs/a', '/abs/b'])
    expect(config.timeoutMs).toBe(1800000)
    expect(config.reportPath).toBe('/abs/a/reports/mutation/mutation.json')
  })

  it('ignores a non-numeric timeout and always builds a server', () => {
    const { server, config } = buildMutateServerFromEnv({ SACKVILLE_MUTATE_TIMEOUT_MS: 'soon' })
    expect(config.timeoutMs).toBeUndefined()
    expect(server).toBeDefined()
  })
})
