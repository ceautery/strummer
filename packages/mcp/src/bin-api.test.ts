import { describe, expect, it } from 'vitest'
import { buildApiServerFromEnv } from './bin-api.js'

describe('strummer-api-mcp bin config (operator env)', () => {
  it('defaults to safe + no keyring', () => {
    expect(buildApiServerFromEnv({}).config).toEqual({
      allowUnsafe: false,
      allowedHosts: [],
      keyring: false,
    })
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
