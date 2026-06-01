import { describe, expect, it } from 'vitest'
import { isBlockedHostLiteral, isBlockedIp, resolveAndPin, SsrfError } from './ssrf.js'

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, metadata, and unspecified ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.5.5.5',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1', // carrier-grade NAT
      '::1',
      'fe80::1', // ipv6 link-local
      'fc00::1', // ipv6 unique-local
      '::ffff:127.0.0.1', // ipv4-mapped loopback
    ]) {
      expect(isBlockedIp(ip)).toBe(true)
    }
  })

  it('allows globally-routable unicast addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isBlockedIp(ip)).toBe(false)
    }
  })

  it('fails closed on an unparseable address', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true)
    expect(isBlockedIp('')).toBe(true)
  })
})

describe('isBlockedHostLiteral', () => {
  it('blocks the cloud-metadata hostnames, case-insensitively', () => {
    expect(isBlockedHostLiteral('metadata.google.internal')).toBe(true)
    expect(isBlockedHostLiteral('METADATA.GOOGLE.INTERNAL')).toBe(true)
    expect(isBlockedHostLiteral('example.com')).toBe(false)
  })
})

describe('resolveAndPin', () => {
  it('returns the pinned IP for a host that resolves to a public address', async () => {
    const pinned = await resolveAndPin('example.com', async () => ({
      address: '93.184.216.34',
      family: 4,
    }))
    expect(pinned).toBe('93.184.216.34')
  })

  it('rejects a host that resolves into a blocked range (DNS-rebinding defense)', async () => {
    await expect(
      resolveAndPin('rebind.evil.test', async () => ({ address: '169.254.169.254', family: 4 })),
    ).rejects.toThrow(SsrfError)
  })

  it('checks IP-literal hosts directly without a lookup', async () => {
    expect(await resolveAndPin('8.8.8.8', async () => ({ address: 'unused', family: 4 }))).toBe(
      '8.8.8.8',
    )
    await expect(
      resolveAndPin('127.0.0.1', async () => ({ address: 'unused', family: 4 })),
    ).rejects.toThrow(SsrfError)
  })

  it('rejects blocked host literals before any lookup', async () => {
    await expect(
      resolveAndPin('metadata.google.internal', async () => ({ address: '8.8.8.8', family: 4 })),
    ).rejects.toThrow(SsrfError)
  })
})
