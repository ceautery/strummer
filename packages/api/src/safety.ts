/** Methods that don't mutate server state run freely. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

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
