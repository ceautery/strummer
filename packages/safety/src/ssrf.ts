import ipaddr from 'ipaddr.js'

/** Thrown when an address/host is refused for SSRF safety. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

/** Hostnames that must never be reached regardless of resolution. */
const BLOCKED_HOST_LITERALS = new Set(['metadata.google.internal', 'metadata.goog'])

/** True for cloud-metadata (and similar) hostnames that must always be refused. */
export function isBlockedHostLiteral(host: string): boolean {
  return BLOCKED_HOST_LITERALS.has(host.trim().toLowerCase())
}

/**
 * True unless `ip` is a globally-routable unicast address. Every other
 * range — loopback, private, link-local (incl. 169.254.169.254 metadata),
 * unique-local, carrier-grade NAT, reserved, unspecified, … — is blocked, and
 * an unparseable value fails closed (blocked). IPv4-mapped IPv6 is unwrapped
 * and checked as IPv4.
 */
export function isBlockedIp(ip: string): boolean {
  let addr: ReturnType<typeof ipaddr.parse>
  try {
    addr = ipaddr.parse(ip)
  } catch {
    return true
  }
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address()
  }
  return addr.range() !== 'unicast'
}

export type DnsLookup = (host: string) => Promise<{ address: string; family: number }>

const defaultLookup: DnsLookup = async (host) => {
  const { lookup } = await import('node:dns/promises')
  return lookup(host)
}

/**
 * Resolve `host` to an IP and refuse it if that IP is in a blocked range —
 * returning the **pinned** address so the caller connects to exactly what was
 * vetted (closing the DNS-rebinding gap where a re-resolve could land on a
 * private IP). IP-literal hosts are checked directly; blocked host literals are
 * refused before any lookup. Inject `lookup` in tests.
 */
export async function resolveAndPin(
  host: string,
  lookup: DnsLookup = defaultLookup,
): Promise<string> {
  if (isBlockedHostLiteral(host)) {
    throw new SsrfError(`host "${host}" is blocked`)
  }
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`address ${host} is in a blocked range`)
    return host
  }
  const { address } = await lookup(host)
  if (isBlockedIp(address)) {
    throw new SsrfError(`host "${host}" resolved to blocked address ${address}`)
  }
  return address
}
