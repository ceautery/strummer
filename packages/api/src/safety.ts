import { type DnsLookup, resolveAndPin, SsrfError } from '@sackville/safety'

/** Methods that don't mutate server state run freely. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface SsrfOptions {
  /** Permit loopback/RFC1918/CGNAT/unique-local targets. Defaults to **true**
   * (local-API testing is a primary use case). Link-local (incl. the
   * 169.254.169.254 metadata IP), multicast, and other always-dangerous ranges
   * are refused regardless. Set false for a hardened, internet-only posture. */
  allowPrivate?: boolean
  /** Injectable DNS resolver (tests). */
  lookup?: DnsLookup
}

/**
 * Refuse a request on SSRF grounds before it leaves. Applies to EVERY request
 * (safe + mutating) — the cloud-metadata endpoint is reachable by a plain GET.
 * Reuses the shared `@sackville/safety` classifier: metadata host literals and
 * blocked-range IPs are always refused; loopback/private are refused only when
 * `allowPrivate` is false; a hostname is resolved and its address vetted (so a
 * name pointing at an internal/metadata IP is caught). Throws `SsrfError` when
 * blocked. NOTE: this is a pre-flight resolve-and-refuse, not a connection pin —
 * a narrow DNS-rebinding TOCTOU window remains (the browser pillar's proxy does
 * true pinning); for operator-authored API collections that is an accepted
 * limitation, documented in ADR 0004.
 */
export async function assertSsrfAllowed(url: string, opts: SsrfOptions = {}): Promise<void> {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new SsrfError(`invalid request URL: ${url}`)
  }
  // URL IPv6 literals are bracketed (`[::1]`); strip for classification.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  // resolveAndPin throws SsrfError on a blocked literal / IP / resolved address;
  // we discard the pinned IP (no connection pinning — see the note above).
  await resolveAndPin(host, opts.lookup, { allowPrivate: opts.allowPrivate ?? true })
}

export interface SafetyOptions {
  /** Opt in to actually sending mutating requests. */
  allowUnsafe?: boolean
  /** Hostnames a mutating request is permitted to reach. */
  allowedHosts?: string[]
}

export interface SafetyDecision {
  allowed: boolean
  reason: string
}

export function isMutating(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase())
}

/**
 * Decide whether a request may actually be sent. Safe methods always may.
 * Mutating methods are withheld (dry-run) unless explicitly unlocked
 * (`allowUnsafe`) AND the target host is on the allowlist — never silently fired.
 */
export function checkGate(method: string, host: string, opts: SafetyOptions = {}): SafetyDecision {
  if (!isMutating(method)) {
    return { allowed: true, reason: `${method.toUpperCase()} is a safe method` }
  }
  if (!opts.allowUnsafe) {
    return {
      allowed: false,
      reason: `${method.toUpperCase()} is a mutating method; dry-run only (pass allowUnsafe to send)`,
    }
  }
  const allowed = opts.allowedHosts ?? []
  if (!allowed.includes(host)) {
    return {
      allowed: false,
      reason: `host ${host} is not in the allowlist for mutating requests (${allowed.join(', ') || 'none'})`,
    }
  }
  return { allowed: true, reason: `${method.toUpperCase()} to ${host} is allowlisted` }
}
