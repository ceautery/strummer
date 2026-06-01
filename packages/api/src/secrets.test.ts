import { describe, expect, it } from 'vitest'
import {
  ChainedSecretStore,
  EnvSecretStore,
  Redactor,
  resolveSecretStore,
  StaticSecretStore,
} from './secrets.js'

describe('secret stores', () => {
  it('StaticSecretStore returns injected values', async () => {
    const store = new StaticSecretStore({ TOKEN: 'abc' })
    expect(await store.get('TOKEN')).toBe('abc')
    expect(await store.get('MISSING')).toBeUndefined()
  })

  it('EnvSecretStore reads STRUMMER_SECRET_<NAME>', async () => {
    const store = new EnvSecretStore({ STRUMMER_SECRET_API_KEY: 'k123' })
    expect(await store.get('API_KEY')).toBe('k123')
    expect(await store.get('OTHER')).toBeUndefined()
  })

  it('ChainedSecretStore returns the first store that has the value', async () => {
    const store = new ChainedSecretStore([
      new StaticSecretStore({ A: 'first' }),
      new StaticSecretStore({ A: 'second', B: 'only-second' }),
    ])
    expect(await store.get('A')).toBe('first')
    expect(await store.get('B')).toBe('only-second')
    expect(await store.get('C')).toBeUndefined()
  })
})

describe('resolveSecretStore', () => {
  it('defaults to env-only', async () => {
    process.env.STRUMMER_SECRET_RS_DEFAULT = 'envval'
    try {
      expect(await resolveSecretStore().get('RS_DEFAULT')).toBe('envval')
    } finally {
      delete process.env.STRUMMER_SECRET_RS_DEFAULT
    }
  })

  it('keyring:true chains the keyring ahead of env but still falls back to env', async () => {
    // No OS keyring entry in CI/container, so the keyring store resolves
    // undefined and the chained env store supplies the value.
    process.env.STRUMMER_SECRET_RS_KEYRING = 'envfallback'
    try {
      expect(await resolveSecretStore({ keyring: true }).get('RS_KEYRING')).toBe('envfallback')
    } finally {
      delete process.env.STRUMMER_SECRET_RS_KEYRING
    }
  })
})

describe('Redactor', () => {
  it('redacts the raw value and its base64/url-encoded encodings', () => {
    const value = 'p@ss w/rd'
    const r = new Redactor()
    r.register('PW', value)
    const base64 = Buffer.from(value, 'utf8').toString('base64')
    const urlEncoded = encodeURIComponent(value)

    expect(r.redact(`token=${value}`)).toBe('token=[redacted:PW]')
    expect(r.redact(`b64=${base64}`)).toBe('b64=[redacted:PW]')
    expect(r.redact(`url=${urlEncoded}`)).toBe('url=[redacted:PW]')
  })

  it('redacts header values', () => {
    const r = new Redactor()
    r.register('TOKEN', 'secret123')
    expect(r.redactHeaders({ authorization: 'Bearer secret123', accept: '*/*' })).toEqual({
      authorization: 'Bearer [redacted:TOKEN]',
      accept: '*/*',
    })
  })

  it('ignores empty secret values', () => {
    const r = new Redactor()
    r.register('EMPTY', '')
    expect(r.redact('nothing to redact')).toBe('nothing to redact')
  })
})
