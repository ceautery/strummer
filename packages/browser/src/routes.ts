import type { BrowserContext } from 'playwright-core'
import type { BrowserGate } from './gate.js'

/**
 * Tier-1 SSRF defense: a deny-by-default `browserContext.route` installed on
 * every gated context. It runs at the network layer — so it governs *every*
 * request (navigations, subresources, XHR/fetch), not just top-level
 * navigation — and aborts anything whose host is not on the operator allowlist.
 *
 * The allowlist is authoritative: private/link-local/metadata literals
 * (169.254.169.254, 10/8, …) are blocked because they're simply never
 * allowlisted — while an operator can still deliberately allowlist `127.0.0.1`
 * to test a local app. What Tier-1 cannot see is the IP a *hostname* resolves to
 * (Playwright exposes no resolved IP at intercept time), so an allowlisted
 * hostname that DNS-rebinds to a private IP is closed by the Tier-2
 * connection-time proxy (`@sackville-mcp/safety` `resolveAndPin`), layered on next.
 */
export async function installSafetyRoutes(
  context: BrowserContext,
  gate: BrowserGate,
): Promise<void> {
  await context.route('**/*', async (route) => {
    if (gate.isHostAllowed(route.request().url())) {
      await route.continue()
    } else {
      await route.abort('blockedbyclient')
    }
  })
}
