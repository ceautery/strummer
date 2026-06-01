/**
 * Deny-by-default action gate for the browser pillar (ADR 0006 §4).
 *
 * Reads are free (handled by the driver — they never consult the gate).
 * Navigation is allowed only to an operator-set **host allowlist**. Mutating
 * interactions are **dry-run by default** and only execute with `allowUnsafe`
 * AND an allowlisted current host. The configuration is **operator-set** (from
 * the server bin's env/config), never an agent/tool input — so the safety gate
 * can't be self-authorized.
 *
 * NOTE: this gate covers method/allowlist policy. SSRF private-range blocking
 * and the connection-time DNS-pinning proxy are layered on in the next slice
 * (`@strummer/safety`), which closes the DNS-rebinding hole hostname matching
 * alone cannot see.
 */

/** Thrown when the gate denies an action. Distinguishable from runtime errors. */
export class GateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GateError'
  }
}

export interface BrowserGateOptions {
  /** Operator unlock for mutating interactions. Default false (dry-run only). */
  allowUnsafe?: boolean
  /** Hosts the agent may navigate to / mutate on. Default empty (nothing allowed). */
  allowedHosts?: string[]
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

export class BrowserGate {
  private readonly allowUnsafe: boolean
  private readonly allowedHosts: Set<string>

  constructor(options: BrowserGateOptions = {}) {
    this.allowUnsafe = options.allowUnsafe ?? false
    this.allowedHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()))
  }

  /** True when the URL's host is on the operator allowlist. */
  isHostAllowed(url: string): boolean {
    const host = hostOf(url)
    return host !== undefined && this.allowedHosts.has(host)
  }

  /** Throw unless the navigation target's host is allowlisted. */
  checkNavigation(url: string): void {
    if (!this.isHostAllowed(url)) {
      throw new GateError(
        `navigation to "${hostOf(url) ?? url}" denied — host not in the allowlist`,
      )
    }
  }

  /**
   * Decide how a mutating interaction on `currentUrl` is handled:
   * `'dry-run'` (default — preview only), `'execute'` (allowUnsafe + allowlisted
   * host), or throw `GateError` (allowUnsafe but host not allowlisted).
   */
  decideMutation(currentUrl: string): 'execute' | 'dry-run' {
    if (!this.allowUnsafe) return 'dry-run'
    if (!this.isHostAllowed(currentUrl)) {
      throw new GateError(
        `mutation on "${hostOf(currentUrl) ?? currentUrl}" denied — host not in the allowlist`,
      )
    }
    return 'execute'
  }
}
