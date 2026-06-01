import type { DnsLookup } from '@strummer/safety'
import { describe, expect, it } from 'vitest'
import { assertSsrfAllowed, checkGate, isMutating } from './safety.js'

describe('isMutating', () => {
  it('treats GET/HEAD/OPTIONS as safe and the rest as mutating', () => {
    for (const m of ['GET', 'head', 'OPTIONS']) expect(isMutating(m)).toBe(false)
    for (const m of ['POST', 'put', 'PATCH', 'DELETE']) expect(isMutating(m)).toBe(true)
  })
})

describe('checkGate', () => {
  it('always allows safe methods', () => {
    expect(checkGate('GET', 'example.com', {}).allowed).toBe(true)
  })

  it('withholds mutations without allowUnsafe', () => {
    const d = checkGate('POST', 'example.com', {})
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/mutating/i)
  })

  it('withholds mutations to a non-allowlisted host even with allowUnsafe', () => {
    const d = checkGate('DELETE', 'evil.example', {
      allowUnsafe: true,
      allowedHosts: ['api.example'],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/allowlist/i)
  })

  it('allows a mutation only when unlocked and allowlisted', () => {
    const d = checkGate('POST', 'api.example', { allowUnsafe: true, allowedHosts: ['api.example'] })
    expect(d.allowed).toBe(true)
  })
})

describe('assertSsrfAllowed', () => {
  const toMeta: DnsLookup = async () => ({ address: '169.254.169.254', family: 4 })
  const toPrivate: DnsLookup = async () => ({ address: '10.0.0.5', family: 4 })
  const toPublic: DnsLookup = async () => ({ address: '93.184.216.34', family: 4 })

  it('blocks cloud-metadata host literals', async () => {
    await expect(assertSsrfAllowed('http://metadata.google.internal/x')).rejects.toThrow()
  })

  it('blocks the link-local metadata IP for ALL methods, even with allowPrivate', async () => {
    await expect(
      assertSsrfAllowed('http://169.254.169.254/latest/meta-data/', { allowPrivate: true }),
    ).rejects.toThrow()
  })

  it('allows loopback by default (local API testing)', async () => {
    await expect(assertSsrfAllowed('http://127.0.0.1:8080/health')).resolves.toBeUndefined()
  })

  it('blocks loopback/private when allowPrivate is false (hardened posture)', async () => {
    await expect(assertSsrfAllowed('http://127.0.0.1/', { allowPrivate: false })).rejects.toThrow()
  })

  it('blocks a hostname that resolves into a private range when hardened', async () => {
    await expect(
      assertSsrfAllowed('http://internal.test/', { allowPrivate: false, lookup: toPrivate }),
    ).rejects.toThrow()
  })

  it('blocks a hostname that resolves to the metadata IP even with allowPrivate', async () => {
    await expect(
      assertSsrfAllowed('http://rebind.test/', { allowPrivate: true, lookup: toMeta }),
    ).rejects.toThrow()
  })

  it('allows a hostname that resolves to a public address', async () => {
    await expect(
      assertSsrfAllowed('http://example.test/', { lookup: toPublic }),
    ).resolves.toBeUndefined()
  })

  it('rejects an unparseable URL (fail closed)', async () => {
    await expect(assertSsrfAllowed('not a url')).rejects.toThrow()
  })
})
