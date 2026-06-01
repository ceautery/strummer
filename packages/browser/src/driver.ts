import type { Locator, Page, Route } from 'playwright-core'
import type { ArtifactStore } from './artifacts.js'
import type { BrowserGate } from './gate.js'
import { captureSnapshot, diffSnapshots, type RefDescriptor, type Snapshot } from './snapshot.js'

type Role = Parameters<Page['getByRole']>[0]
type WaitState = 'attached' | 'detached' | 'visible' | 'hidden'

/** The request a dry-run interaction would have fired (captured + aborted). */
export interface WouldRequest {
  method: string
  url: string
  postData?: string
}

export interface StepResult {
  /** The step kind: `navigate` | `click` | `fill` | `fill_form` | `select` | `press` | `wait_for` | `snapshot`. */
  action: string
  /** The ref acted on, when applicable. */
  ref?: string
  /** Ref-independent scoped diff of the page vs. the pre-action snapshot. */
  diff: string
  /** Token-capped serialized snapshot after the action (carries the fresh refs). */
  snapshot: string
  /** True when `snapshot` was capped below the full node count. */
  truncated: boolean
  /** Handle to the full post-action snapshot, when a store is configured. */
  snapshotHandle?: string
  /** True when the gate ran this interaction in dry-run (network suppressed). */
  dryRun?: boolean
  /** In dry-run, the first request the action would have fired (then aborted). */
  wouldRequest?: WouldRequest | null
}

export interface PageDriverOptions {
  /** Run id used to key stored artifacts. */
  runId?: string
  /** When set (with `runId`), each snapshot's full tree is stored by handle. */
  store?: ArtifactStore
  /** Max element nodes in the returned (capped) snapshot text. */
  maxNodes?: number
  /** Exact accessible-name matching when resolving refs. Default true. */
  exact?: boolean
  /** Operator-set deny-by-default gate. Omit for the raw, ungated layer (the MCP
   * surface always supplies one). */
  gate?: BrowserGate
  /** Redactor applied to the dry-run preview (both `url` and `postData`) before it
   * surfaces. Default identity; the server bin wires the real `@strummer/safety`
   * `Redactor` here so registered secrets never leak via a query string or body. */
  redact?: (value: string) => string
}

export interface WaitForOptions {
  /** Wait for a ref from the current snapshot to reach `state`. */
  ref?: string
  /** Or wait for a role (optionally + accessible name) to reach `state`. */
  role?: string
  name?: string
  state?: WaitState
  timeout?: number
}

/**
 * Drives a single page with imperative, agent-facing step tools. Element
 * targeting goes through the ARIA-snapshot refs minted by `snapshot.ts`: a ref
 * resolves to a semantic Playwright locator (`getByRole(role,{name}).nth(n)`)
 * with auto-waiting. Each navigating/mutating step re-captures a snapshot under
 * a new generation, so a ref from an earlier snapshot fails to resolve rather
 * than silently matching a different element.
 *
 * Safety note: this is the raw interaction layer. Deny-by-default gating of
 * navigation/mutation (operator unlock + allowlist + dry-run) is layered on at
 * the action-gate slice; the MCP surface drives this through that gate.
 */
export class PageDriver {
  private current: Snapshot | undefined
  private generation = 0
  private readonly gate: BrowserGate | undefined
  private readonly redact: (value: string) => string

  constructor(
    private readonly page: Page,
    private readonly opts: PageDriverOptions = {},
  ) {
    this.gate = opts.gate
    this.redact = opts.redact ?? ((v) => v)
  }

  /** The current snapshot's ref → descriptor map (empty before the first capture). */
  get refs(): Map<string, RefDescriptor> {
    return this.current?.refs ?? new Map()
  }

  /** The current token-capped snapshot text. */
  get snapshotText(): string {
    return this.current?.text ?? ''
  }

  private locator(ref: string): Locator {
    const desc = this.current?.refs.get(ref)
    if (!desc) {
      throw new Error(
        `unknown ref "${ref}" — refs are per-snapshot; capture a fresh snapshot and use its refs`,
      )
    }
    const byRole =
      desc.name === undefined
        ? this.page.getByRole(desc.role as Role)
        : this.page.getByRole(desc.role as Role, {
            name: desc.name,
            exact: this.opts.exact ?? true,
          })
    return byRole.nth(desc.nth)
  }

  private async capture(): Promise<Snapshot> {
    this.generation += 1
    return captureSnapshot(this.page.locator('body'), {
      store: this.opts.store,
      runId: this.opts.runId,
      maxNodes: this.opts.maxNodes,
      idPrefix: `s${this.generation}e`,
    })
  }

  /** Re-capture, diff against the prior snapshot, and make it current. */
  private async settle(action: string, ref?: string): Promise<StepResult> {
    const prev = this.current
    const next = await this.capture()
    this.current = next
    return {
      action,
      ...(ref !== undefined ? { ref } : {}),
      diff: prev ? diffSnapshots(prev, next) : '',
      snapshot: next.text,
      truncated: next.truncated,
      ...(next.fullHandle !== undefined ? { snapshotHandle: next.fullHandle } : {}),
    }
  }

  /** Capture (or re-capture) the page snapshot without acting. */
  async snapshot(): Promise<StepResult> {
    return this.settle('snapshot')
  }

  async navigate(url: string): Promise<StepResult> {
    this.gate?.checkNavigation(url)
    await this.page.goto(url, { waitUntil: 'load' })
    return this.settle('navigate')
  }

  async click(ref: string): Promise<StepResult> {
    return this.interact('click', ref, () => this.locator(ref).click())
  }

  async fill(ref: string, value: string): Promise<StepResult> {
    return this.interact('fill', ref, () => this.locator(ref).fill(value))
  }

  /** Fill several fields (resolved against the current snapshot) then settle once. */
  async fillForm(fields: { ref: string; value: string }[]): Promise<StepResult> {
    return this.interact('fill_form', undefined, async () => {
      for (const field of fields) await this.locator(field.ref).fill(field.value)
    })
  }

  async selectOption(ref: string, values: string | string[]): Promise<StepResult> {
    return this.interact('select', ref, () => this.locator(ref).selectOption(values))
  }

  /** Press a key on a ref's element, or on the page when `ref` is null. */
  async press(ref: string | null, key: string): Promise<StepResult> {
    return this.interact('press', ref ?? undefined, () =>
      ref === null ? this.page.keyboard.press(key) : this.locator(ref).press(key),
    )
  }

  /**
   * Run a mutating interaction through the gate: execute it directly when no
   * gate is configured or the gate authorizes it; otherwise dry-run it (perform
   * the action with a one-shot route that captures + aborts the first request)
   * and report what it would have sent. Throws `GateError` on a hard deny.
   */
  private async interact(
    action: string,
    ref: string | undefined,
    perform: () => Promise<unknown>,
  ): Promise<StepResult> {
    if (this.gate && this.gate.decideMutation(this.page.url()) === 'dry-run') {
      const wouldRequest = await this.dryRun(perform)
      return { ...(await this.settle(action, ref)), dryRun: true, wouldRequest }
    }
    await perform()
    return this.settle(action, ref)
  }

  /** Perform `action` while intercepting + aborting its first request, returning that request. */
  private async dryRun(perform: () => Promise<unknown>): Promise<WouldRequest | null> {
    let captured: WouldRequest | null = null
    const handler = async (route: Route): Promise<void> => {
      if (!captured) {
        const req = route.request()
        const body = req.postData()
        captured = {
          method: req.method(),
          url: this.redact(req.url()),
          ...(body ? { postData: this.redact(body) } : {}),
        }
      }
      await route.abort()
    }
    await this.page.route('**/*', handler)
    try {
      await perform()
      await this.page.waitForTimeout(300) // let any triggered request reach the interceptor
    } catch {
      // an aborted navigation/request can reject the action — expected in dry-run
    } finally {
      await this.page.unroute('**/*', handler)
    }
    return captured
  }

  async waitFor(options: WaitForOptions): Promise<StepResult> {
    const state = options.state ?? 'visible'
    const timeout = options.timeout
    let locator: Locator
    if (options.ref !== undefined) {
      locator = this.locator(options.ref)
    } else if (options.role !== undefined) {
      locator =
        options.name === undefined
          ? this.page.getByRole(options.role as Role)
          : this.page.getByRole(options.role as Role, {
              name: options.name,
              exact: this.opts.exact ?? true,
            })
    } else {
      throw new Error('waitFor requires a ref or a role')
    }
    await locator.first().waitFor(timeout === undefined ? { state } : { state, timeout })
    return this.settle('wait_for', options.ref)
  }

  /** Read an element's text content (a free read — no re-snapshot). */
  async getText(ref: string): Promise<string | null> {
    return this.locator(ref).textContent()
  }

  /** Read an element's current input value (a free read). */
  async getValue(ref: string): Promise<string> {
    return this.locator(ref).inputValue()
  }

  /** Read an element's HTML attribute (a free read). */
  async getAttribute(ref: string, name: string): Promise<string | null> {
    return this.locator(ref).getAttribute(name)
  }
}
