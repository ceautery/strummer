import { describe, expect, it } from 'vitest'
import { buildVerifyServerFromEnv } from './bin-verify.js'

describe('strummer-verify-mcp bin config (operator env)', () => {
  it('defaults to compose-only with no artifacts root and capture off', () => {
    expect(buildVerifyServerFromEnv({}).config).toEqual({
      artifactsRoot: undefined,
      allowCapture: false,
    })
  })

  it('reads the shared artifacts root + the capture gate', () => {
    const { config } = buildVerifyServerFromEnv({
      STRUMMER_ARTIFACTS_ROOT: '/tmp/strummer-artifacts',
      STRUMMER_VERIFY_ALLOW_CAPTURE: '1',
    })
    expect(config.artifactsRoot).toBe('/tmp/strummer-artifacts')
    expect(config.allowCapture).toBe(true)
  })

  it('does NOT read any per-pillar *_ALLOW_RUN env (the §3c guard)', () => {
    const { config } = buildVerifyServerFromEnv({
      STRUMMER_COVERAGE_ALLOW_RUN: '1',
      STRUMMER_FLAKE_ALLOW_RUN: '1',
      STRUMMER_MUTATE_ALLOW_RUN: '1',
      STRUMMER_LSP_ALLOW_RUN: '1',
    })
    // The config shape carries no per-pillar run flag — a shared env name can't
    // silently grant a future verify run path an operator's per-pillar grant.
    expect(config).toEqual({ artifactsRoot: undefined, allowCapture: false })
  })
})
