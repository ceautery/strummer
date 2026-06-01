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
/** `'global'` = routable unicast; `'private'` = loopback/RFC1918/CGNAT/unique-local
 * (reachable only under an explicit `allowPrivate` opt-in for local-app testing);
 * `'blocked'` = always refused (link-local incl. 169.254 metadata, multicast,
 * unspecified, reserved, …). Unparseable input is `'blocked'` (fail-closed). */
export type AddressClass = 'global' | 'private' | 'blocked'

const PRIVATE_RANGES = new Set(['loopback', 'private', 'carrierGradeNat', 'uniqueLocal'])

export function classifyAddress(ip: string): AddressClass {
  let addr: ReturnType<typeof ipaddr.parse>
  try {
    addr = ipaddr.parse(ip)
  } catch {
    return 'blocked'
  }
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address()
  }
  const range = addr.range()
  if (range === 'unicast') return 'global'
  if (PRIVATE_RANGES.has(range)) return 'private'
  return 'blocked'
}

export interface RangeOptions {
  /** Permit loopback/private/CGNAT/unique-local targets (local-app testing).
   * Link-local/metadata and other always-dangerous ranges stay blocked. */
  allowPrivate?: boolean
}

/** True unless the IP may be reached: `'global'` always may; `'private'` only
 * with `allowPrivate`; `'blocked'` never. */
export function isBlockedIp(ip: string, opts: RangeOptions = {}): boolean {
  const cls = classifyAddress(ip)
  if (cls === 'global') return false
  if (cls === 'private') return !opts.allowPrivate
  return true
}

/**
 * True when a request to this host should be blocked on the host string alone —
 * a cloud-metadata literal, or an IP literal in a blocked range. A regular
 * hostname returns false here: the allowlist governs whether it's reachable, and
 * the resolved-IP check belongs to the connection-time proxy (`resolveAndPin`),
 * since the route layer never sees the IP a hostname resolves to.
 */
export function isBlockedHost(host: string): boolean {
  if (isBlockedHostLiteral(host)) return true
  if (ipaddr.isValid(host)) return isBlockedIp(host)
  return false
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
  opts: RangeOptions = {},
): Promise<string> {
  if (isBlockedHostLiteral(host)) {
    throw new SsrfError(`host "${host}" is blocked`)
  }
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host, opts)) throw new SsrfError(`address ${host} is in a blocked range`)
    return host
  }
  const { address } = await lookup(host)
  if (isBlockedIp(address, opts)) {
    throw new SsrfError(`host "${host}" resolved to blocked address ${address}`)
  }
  return address
}
