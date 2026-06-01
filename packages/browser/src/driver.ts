import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { Dialog, Download, Locator, Page, Route } from 'playwright-core'
import type { ArtifactStore } from './artifacts.js'
import {
  type BrowserAssertionResult,
  type BrowserAssertionSpec,
  evaluateBrowserAssertions,
} from './assertions.js'
import { type BrowserGate, GateError } from './gate.js'
import { captureSnapshot, diffSnapshots, type RefDescriptor, type Snapshot } from './snapshot.js'

type Role = Parameters<Page['getByRole']>[0]
type WaitState = 'attached' | 'detached' | 'visible' | 'hidden'

/** The request a dry-run interaction would have fired (captured + aborted). */
export interface WouldRequest {
  method: string
  url: string
  postData?: string
}

/** A JS dialog the page raised during a step (alert/confirm/prompt/beforeunload). */
export interface DialogEvent {
  type: string
  /** The dialog text, redacted. */
  message: string
  /** True when the operator unlocked dialogs (accepted); false when dismissed. */
  accepted: boolean
}

/** A file download the page started (saved to the operator quarantine dir, or denied). */
export interface DownloadEvent {
  /** The browser-suggested filename, redacted. */
  suggestedFilename: string
  /** Absolute path in the operator quarantine dir, when saved. */
  savedAs?: string
  /** Saved file size in bytes, when saved. */
  byteSize?: number
  /** True when saved to the quarantine dir; false when denied (no dir configured). */
  accepted: boolean
}

/** basename + strip anything but word chars/.-/ and any leading dots (no traversal). */
function sanitizeFilename(name: string): string {
  const safe = basename(name)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '')
  return safe || 'download'
}

/** Resolve `file` (relative → under `root`) and confirm it stays inside `root`. */
function resolveWithin(root: string, file: string): string {
  const r = resolve(root)
  const abs = isAbsolute(file) ? resolve(file) : resolve(r, file)
  if (abs !== r && !abs.startsWith(r + sep)) {
    throw new GateError(`upload "${file}" denied — outside the operator upload allowlist`)
  }
  return abs
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
  /** In dry-run, true when `wouldRequest` targets a host NOT on the allowlist —
   * the gate authorizes on the *document* host, so this surfaces a would-be
   * egress to a different host for accurate operator review. */
  crossOriginEgress?: boolean
  /** JS dialogs the page raised during this step (handled deny-by-default —
   * dismissed unless the operator unlocked dialogs). Omitted when none fired. */
  dialogs?: DialogEvent[]
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
  /** Operator download-quarantine dir. When set (and the context was created with
   * `acceptDownloads: true`), a started download is saved here under a sanitized,
   * indexed name and recorded; when unset, downloads are denied (the manager's
   * `acceptDownloads: false` already cancels them). Operator config, never a tool input. */
  downloadDir?: string
  /** Operator upload-allowlist dir. `uploadFiles` may only set files resolving to
   * within this dir; unset ⇒ uploads denied entirely (deny-by-default). This is the
   * exfiltration control — an agent cannot upload arbitrary local files. Operator
   * config, never a tool input. */
  uploadDir?: string
}

export interface ScreenshotOptions {
  /** Capture the full scrollable page rather than just the viewport. Default false. */
  fullPage?: boolean
}

export interface ScreenshotResult {
  action: 'screenshot'
  /** `strummer://browser/run/<id>/screenshot-s<n>` — the PNG, by handle (when a
   * store + runId are configured). The image is NEVER inlined into the result. */
  handle?: string
  /** PNG byte size. */
  byteSize: number
  contentType: 'image/png'
  /** Whether the full scrollable page (vs. just the viewport) was captured. */
  fullPage: boolean
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
  private screenshotIndex = 0
  private readonly gate: BrowserGate | undefined
  private readonly redact: (value: string) => string
  /** Dialogs raised since the last `settle()`, drained onto its StepResult. */
  private pendingDialogs: DialogEvent[] = []
  /** Downloads saved/denied since the last `collectDownloads()`. */
  private downloadsCollected: DownloadEvent[] = []
  /** In-flight saveAs promises, awaited by `collectDownloads()`. */
  private downloadsInFlight: Promise<void>[] = []
  private downloadIndex = 0

  constructor(
    private readonly page: Page,
    private readonly opts: PageDriverOptions = {},
  ) {
    this.gate = opts.gate
    this.redact = opts.redact ?? ((v) => v)
    // Deny-by-default dialog handling. Registering ANY dialog listener overrides
    // Playwright's auto-dismiss, so this handler always resolves the dialog
    // (dismiss, or accept when the operator unlocked it) — a missing handler
    // would hang the page. Guarded for the raw unit layer where `page` is a stub.
    if (typeof this.page.on === 'function') {
      this.page.on('dialog', (dialog) => {
        void this.handleDialog(dialog)
      })
      this.page.on('download', (download) => this.handleDownload(download))
    }
  }

  /** Save a started download to the quarantine dir (or deny it), recording it. */
  private handleDownload(download: Download): void {
    const task = (async () => {
      const suggested = this.redact(download.suggestedFilename())
      if (this.opts.downloadDir === undefined) {
        // No quarantine dir → deny. (The manager's acceptDownloads:false also cancels.)
        this.downloadsCollected.push({ suggestedFilename: suggested, accepted: false })
        await download.cancel().catch(() => {})
        return
      }
      this.downloadIndex += 1
      const savedAs = join(
        this.opts.downloadDir,
        `${this.downloadIndex}-${sanitizeFilename(download.suggestedFilename())}`,
      )
      await download.saveAs(savedAs)
      const { size } = await stat(savedAs)
      this.downloadsCollected.push({
        suggestedFilename: suggested,
        savedAs,
        byteSize: size,
        accepted: true,
      })
    })().catch(() => {
      // saveAs/stat/cancel can reject (context closing, fs error) — best-effort record
    })
    this.downloadsInFlight.push(task)
  }

  /**
   * Return downloads captured since the last call (awaiting any in-flight saves
   * first), then clear them. A free read — does not invalidate refs. Downloads are
   * collected as they arrive (not tied to a single step), so call this after the
   * action(s) that may have triggered them. When `waitMs > 0` and nothing has
   * arrived yet, wait up to that long for a download to start (closes the gap
   * between the click that triggers a download and the async `download` event).
   */
  async collectDownloads(waitMs = 0): Promise<DownloadEvent[]> {
    if (
      waitMs > 0 &&
      this.downloadsInFlight.length === 0 &&
      this.downloadsCollected.length === 0 &&
      typeof this.page.waitForEvent === 'function'
    ) {
      // our persistent 'download' listener also fires → populates downloadsInFlight
      await this.page.waitForEvent('download', { timeout: waitMs }).catch(() => {})
    }
    await Promise.all(this.downloadsInFlight.splice(0))
    return this.downloadsCollected.splice(0)
  }

  /** Dismiss (default) or accept (operator-unlocked) a dialog, recording it. */
  private async handleDialog(dialog: Dialog): Promise<void> {
    const accepted = this.gate?.allowsDialogs() ?? false
    this.pendingDialogs.push({
      type: dialog.type(),
      message: this.redact(dialog.message()),
      accepted,
    })
    try {
      if (accepted) await dialog.accept()
      else await dialog.dismiss()
    } catch {
      // the dialog may already be handled (e.g. page closing) — safe to ignore
    }
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
    if (!this.current) {
      throw new Error('no snapshot yet — call navigate or snapshot before acting on a ref')
    }
    const desc = this.current.refs.get(ref)
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
      generation: this.generation,
      redact: this.redact,
    })
  }

  /** Re-capture, diff against the prior snapshot, and make it current. */
  private async settle(action: string, ref?: string): Promise<StepResult> {
    const prev = this.current
    const next = await this.capture()
    this.current = next
    const dialogs = this.pendingDialogs.splice(0)
    return {
      action,
      ...(ref !== undefined ? { ref } : {}),
      diff: prev ? diffSnapshots(prev, next) : '',
      snapshot: next.text,
      truncated: next.truncated,
      ...(next.fullHandle !== undefined ? { snapshotHandle: next.fullHandle } : {}),
      ...(dialogs.length ? { dialogs } : {}),
    }
  }

  /** Capture (or re-capture) the page snapshot without acting. */
  async snapshot(): Promise<StepResult> {
    return this.settle('snapshot')
  }

  /**
   * Capture a PNG screenshot of the current page and store it by handle (never
   * inlined). Unlike the ARIA snapshot this does NOT re-capture or bump the
   * generation, so existing refs stay valid.
   *
   * Safety: a screenshot is **pixels** and cannot be redacted, so a secret
   * rendered in the DOM would land in the image — exactly the property that
   * keeps the trace.zip off by default. The MCP surface therefore gates this
   * tool off by default (operator opt-in), mirroring the unredactable-binary
   * posture; this engine method is the raw capability the surface gates.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const fullPage = options.fullPage ?? false
    const buf = await this.page.screenshot({ fullPage })
    this.screenshotIndex += 1
    const handle =
      this.opts.store && this.opts.runId !== undefined
        ? this.opts.store.put(
            this.opts.runId,
            `screenshot-s${this.screenshotIndex}`,
            buf,
            'image/png',
          )
        : undefined
    return {
      action: 'screenshot',
      ...(handle !== undefined ? { handle } : {}),
      byteSize: buf.byteLength,
      contentType: 'image/png',
      fullPage,
    }
  }

  async navigate(url: string): Promise<StepResult> {
    this.gate?.checkNavigation(url)
    await this.page.goto(url, { waitUntil: 'load' })
    return this.settle('navigate')
  }

  async click(ref: string): Promise<StepResult> {
    const locator = this.locator(ref) // resolve eagerly so a bad ref throws before the gate/dry-run
    return this.interact('click', ref, () => locator.click())
  }

  async fill(ref: string, value: string): Promise<StepResult> {
    const locator = this.locator(ref)
    return this.interact('fill', ref, () => locator.fill(value))
  }

  /** Fill several fields (resolved against the current snapshot) then settle once. */
  async fillForm(fields: { ref: string; value: string }[]): Promise<StepResult> {
    const resolved = fields.map((field) => ({
      locator: this.locator(field.ref),
      value: field.value,
    }))
    return this.interact('fill_form', undefined, async () => {
      for (const { locator, value } of resolved) await locator.fill(value)
    })
  }

  async selectOption(ref: string, values: string | string[]): Promise<StepResult> {
    const locator = this.locator(ref)
    return this.interact('select', ref, () => locator.selectOption(values))
  }

  /**
   * Set files on a file-input ref. **Deny-by-default:** requires an operator
   * upload-allowlist dir, and every path must resolve to within it (no `..`
   * traversal, no absolute escape) — so an agent cannot exfiltrate arbitrary local
   * files. Selecting a file makes no network request; the subsequent submit is
   * gated separately by the mutation gate. Re-snapshots like other interactions.
   */
  async uploadFiles(ref: string, files: string[]): Promise<StepResult> {
    if (this.opts.uploadDir === undefined) {
      throw new GateError('uploads not enabled — no operator upload dir configured')
    }
    const dir = this.opts.uploadDir
    const resolved = files.map((f) => resolveWithin(dir, f)) // throws on escape, before any DOM change
    const locator = this.locator(ref)
    await locator.setInputFiles(resolved)
    return this.settle('upload', ref)
  }

  /** Press a key on a ref's element, or on the page when `ref` is null. */
  async press(ref: string | null, key: string): Promise<StepResult> {
    const locator = ref === null ? null : this.locator(ref)
    return this.interact('press', ref ?? undefined, () =>
      locator === null ? this.page.keyboard.press(key) : locator.press(key),
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
      const { wouldRequest, crossOriginEgress } = await this.dryRun(perform)
      return {
        ...(await this.settle(action, ref)),
        dryRun: true,
        wouldRequest,
        ...(crossOriginEgress !== undefined ? { crossOriginEgress } : {}),
      }
    }
    await perform()
    return this.settle(action, ref)
  }

  /**
   * Perform `action` while intercepting + aborting its requests (network
   * suppressed), returning the first would-be request and whether it targets a
   * non-allowlisted host. Popups (`window.open` spawns a page our route never
   * sees) are closed for the duration, so a dry-run has no side effects.
   */
  private async dryRun(
    perform: () => Promise<unknown>,
  ): Promise<{ wouldRequest: WouldRequest | null; crossOriginEgress?: boolean }> {
    let captured: WouldRequest | null = null
    let crossOriginEgress: boolean | undefined
    const handler = async (route: Route): Promise<void> => {
      if (!captured) {
        const req = route.request()
        const rawUrl = req.url()
        const body = req.postData()
        captured = {
          method: req.method(),
          url: this.redact(rawUrl),
          ...(body ? { postData: this.redact(body) } : {}),
        }
        // compute from the RAW url (redaction can mangle the host) before it surfaces
        crossOriginEgress = this.gate ? !this.gate.isHostAllowed(rawUrl) : undefined
      }
      await route.abort()
    }
    const context = this.page.context()
    const onPopup = (popup: Page): void => {
      void popup.close().catch(() => {})
    }
    context.on('page', onPopup)
    await this.page.route('**/*', handler)
    try {
      await perform()
      await this.page.waitForTimeout(300) // let any triggered request reach the interceptor
    } catch {
      // an aborted navigation/request can reject the action — expected in dry-run
    } finally {
      context.off('page', onPopup)
      try {
        await this.page.unroute('**/*', handler)
      } catch {
        // the page may be closing mid-dry-run — unroute can reject; safe to ignore
      }
    }
    return { wouldRequest: captured, crossOriginEgress }
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

  /**
   * Evaluate declarative assertions against the live page (a free read — no
   * re-snapshot, refs preserved). Each assertion **auto-waits** up to its timeout,
   * so a condition that only becomes true after an async update still passes. Uses
   * the shared `@strummer/assert` operator vocabulary (one engine across pillars);
   * observed string values are redacted before they surface.
   */
  async assert(specs: BrowserAssertionSpec[]): Promise<BrowserAssertionResult[]> {
    return evaluateBrowserAssertions(
      {
        page: this.page,
        locatorForRef: (ref) => this.locator(ref),
        redact: this.redact,
        now: () => Date.now(),
      },
      specs,
    )
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
