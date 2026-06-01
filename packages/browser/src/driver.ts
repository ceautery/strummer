import type { Locator, Page } from 'playwright-core'
import type { ArtifactStore } from './artifacts.js'
import { captureSnapshot, diffSnapshots, type RefDescriptor, type Snapshot } from './snapshot.js'

type Role = Parameters<Page['getByRole']>[0]
type WaitState = 'attached' | 'detached' | 'visible' | 'hidden'

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

  constructor(
    private readonly page: Page,
    private readonly opts: PageDriverOptions = {},
  ) {}

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
    await this.page.goto(url, { waitUntil: 'load' })
    return this.settle('navigate')
  }

  async click(ref: string): Promise<StepResult> {
    await this.locator(ref).click()
    return this.settle('click', ref)
  }

  async fill(ref: string, value: string): Promise<StepResult> {
    await this.locator(ref).fill(value)
    return this.settle('fill', ref)
  }

  /** Fill several fields (resolved against the current snapshot) then settle once. */
  async fillForm(fields: { ref: string; value: string }[]): Promise<StepResult> {
    for (const field of fields) await this.locator(field.ref).fill(field.value)
    return this.settle('fill_form')
  }

  async selectOption(ref: string, values: string | string[]): Promise<StepResult> {
    await this.locator(ref).selectOption(values)
    return this.settle('select', ref)
  }

  /** Press a key on a ref's element, or on the page when `ref` is null. */
  async press(ref: string | null, key: string): Promise<StepResult> {
    if (ref === null) await this.page.keyboard.press(key)
    else await this.locator(ref).press(key)
    return this.settle('press', ref ?? undefined)
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
