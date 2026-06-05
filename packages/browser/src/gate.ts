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
 * (`@sackville/safety`), which closes the DNS-rebinding hole hostname matching
 * alone cannot see.
 */

/** Thrown when the gate denies an action. Distinguishable from runtime errors. */
export class GateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GateError'
    // Brand as a gate DENIAL (ADR 0013 Addendum 3, milestone 5e): the run-driving
    // `@sackville/verify` reads this global-registry symbol via `isGateDenial` to map a
    // denial to `skipReason:'gate-not-set'` (never `errored`) WITHOUT importing engine
    // code — matching CoverageGateError/FlakeGateError/MutationGateError. The
    // `Symbol.for` key string is the cross-package contract. (Inert for in-flow denials
    // that `runFlow` swallows — verify gates on flow completeness — but load-bearing for
    // the pre-`runFlow` `createSession`→`checkNavigation` reject path.)
    ;(this as unknown as Record<symbol, unknown>)[Symbol.for('sackville.gate-denial')] = true
  }
}

export interface BrowserGateOptions {
  /** Operator unlock for mutating interactions. Default false (dry-run only). */
  allowUnsafe?: boolean
  /** Hosts the agent may navigate to / mutate on. Default empty (nothing allowed). */
  allowedHosts?: string[]
  /** Operator unlock for JS dialogs (alert/confirm/prompt/beforeunload). Default
   * false: dialogs are auto-**dismissed** (a `confirm` returns false, a `prompt`
   * returns null), so a destructive flow gated behind a confirm cannot proceed.
   * When true, dialogs are auto-**accepted**. Operator-set, never a tool input. */
  allowDialogs?: boolean
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
  private readonly allowDialogs: boolean

  constructor(options: BrowserGateOptions = {}) {
    this.allowUnsafe = options.allowUnsafe ?? false
    this.allowedHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()))
    this.allowDialogs = options.allowDialogs ?? false
  }

  /** True when the operator has unlocked accepting JS dialogs (else dismiss). */
  allowsDialogs(): boolean {
    return this.allowDialogs
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
