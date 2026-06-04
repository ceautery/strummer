import { describe, expect, it } from 'vitest'
import { buildApiServerFromEnv } from './bin-api.js'

describe('strummer-api-mcp bin config (operator env)', () => {
  it('defaults to safe, no keyring, private allowed (local-API testing)', () => {
    expect(buildApiServerFromEnv({}).config).toEqual({
      allowUnsafe: false,
      allowedHosts: [],
      keyring: false,
      allowPrivate: true,
      artifactsRoot: undefined,
      allowCapture: false,
    })
  })

  it('the capture gate (ADR 0013) is off by default and opt-in via env', () => {
    expect(buildApiServerFromEnv({}).config.allowCapture).toBe(false)
    const { config } = buildApiServerFromEnv({
      STRUMMER_ARTIFACTS_ROOT: '/tmp/strummer-artifacts',
      STRUMMER_VERIFY_ALLOW_CAPTURE: '1',
    })
    expect(config.allowCapture).toBe(true)
    expect(config.artifactsRoot).toBe('/tmp/strummer-artifacts')
  })

  it('STRUMMER_BLOCK_PRIVATE hardens the SSRF posture', () => {
    expect(buildApiServerFromEnv({ STRUMMER_BLOCK_PRIVATE: '1' }).config.allowPrivate).toBe(false)
  })

  it('parses allowUnsafe + allowedHosts (trimmed, empties dropped)', () => {
    const { config } = buildApiServerFromEnv({
      STRUMMER_ALLOW_UNSAFE: '1',
      STRUMMER_ALLOWED_HOSTS: 'api.example.com, 127.0.0.1, ',
    })
    expect(config.allowUnsafe).toBe(true)
    expect(config.allowedHosts).toEqual(['api.example.com', '127.0.0.1'])
  })

  it('enables the keyring secret chain only via STRUMMER_KEYRING', () => {
    expect(buildApiServerFromEnv({ STRUMMER_KEYRING: 'true' }).config.keyring).toBe(true)
    expect(buildApiServerFromEnv({}).config.keyring).toBe(false)
  })
})
