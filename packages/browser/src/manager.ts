import type { Browser, BrowserContext } from 'playwright-core'
import type { BrowserGate } from './gate.js'
import { harPathFor } from './har.js'
import { installSafetyRoutes } from './routes.js'

export interface BrowserManagerOptions {
  /** How to launch the shared browser. Called lazily, at most once per live
   * browser (re-invoked after a shutdown). */
  launch: () => Promise<Browser>
  /** Max concurrent sessions (isolated contexts). Default 8. */
  maxContexts?: number
  /** Idle time before a session is eligible for reaping, in ms. Default 5 min. */
  idleTtlMs?: number
  /** Max wall-clock lifetime of a session, in ms — reaped past this even if active.
   * Unset = no wall-clock cap (idle TTL still applies). */
  maxSessionMs?: number
  /** Max pages (tabs) per session context; pages opened beyond this (e.g. popups)
   * are closed. Unset = no cap. */
  maxPages?: number
  /** Per-action default timeout applied to each context, in ms. */
  defaultTimeoutMs?: number
  /** Per-navigation default timeout applied to each context, in ms. */
  defaultNavigationTimeoutMs?: number
  /** Clock injection (testing). Default `Date.now`. */
  now?: () => number
  /** When set, every session's context gets the Tier-1 SSRF route allowlist. */
  gate?: BrowserGate
  /** Operator-set HTTP Basic credentials applied to every session context
   * (optionally scoped to an `origin`). Operator config, never an agent input. */
  httpCredentials?: { username: string; password: string; origin?: string }
  /** Whether contexts accept file downloads. Default false: Playwright **cancels**
   * every download (race-free deny-by-default). The bin sets this true only when an
   * operator download-quarantine dir is configured, so the `PageDriver` can save +
   * record them. Operator config, never an agent input. */
  acceptDownloads?: boolean
  /** Operator dir for "network heavy mode" HAR capture. When set, every session's
   * context records a HAR (`content:'attach'`, `mode:'full'`) to `<dir>/<id>.zip`,
   * written by Playwright on context close. Unset = no HAR. Operator config, never
   * an agent input — HAR is a heavy secret surface (gated off by default). */
  harDir?: string
  /** Operator dir for video capture. When set, every session's context records a
   * `.webm` per page (Playwright auto-names it inside this dir), written on context
   * close. Unset = no video. Operator config, never an agent input — video is
   * unredactable pixels (gated off by default, like the trace/screenshots). */
  videoDir?: string
  /** Optional frame-size cap for recorded video (`recordVideo.size`). Unset =
   * Playwright's default (scaled from the viewport). */
  videoSize?: { width: number; height: number }
}

interface Session {
  context: BrowserContext
  lastUsedAt: number
  createdAt: number
}

/**
 * Owns the single shared browser and the per-session isolated contexts. One
 * browser per server; one ephemeral `BrowserContext` per session (separate
 * cookies/storage). Bounds resource use with a concurrency cap and an idle
 * reaper, and tears everything down on shutdown. The browser is launched lazily
 * on first use so constructing a manager is cheap.
 */
export class BrowserManager {
  private readonly opts: Required<
    Omit<
      BrowserManagerOptions,
      | 'launch'
      | 'gate'
      | 'httpCredentials'
      | 'maxSessionMs'
      | 'maxPages'
      | 'harDir'
      | 'videoDir'
      | 'videoSize'
    >
  > &
    Pick<
      BrowserManagerOptions,
      | 'launch'
      | 'gate'
      | 'httpCredentials'
      | 'maxSessionMs'
      | 'maxPages'
      | 'harDir'
      | 'videoDir'
      | 'videoSize'
    >
  private readonly sessions = new Map<string, Session>()
  private readonly reapCallbacks: ((sessionId: string) => void | Promise<void>)[] = []
  private readonly closedCallbacks: ((sessionId: string) => void | Promise<void>)[] = []
  private browser: Browser | undefined
  private launching: Promise<Browser> | undefined
  private reaper: ReturnType<typeof setInterval> | undefined

  constructor(options: BrowserManagerOptions) {
    this.opts = {
      launch: options.launch,
      maxContexts: options.maxContexts ?? 8,
      idleTtlMs: options.idleTtlMs ?? 5 * 60_000,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 0,
      defaultNavigationTimeoutMs: options.defaultNavigationTimeoutMs ?? 0,
      now: options.now ?? Date.now,
      acceptDownloads: options.acceptDownloads ?? false,
      gate: options.gate,
      httpCredentials: options.httpCredentials,
      maxSessionMs: options.maxSessionMs,
      maxPages: options.maxPages,
      harDir: options.harDir,
      videoDir: options.videoDir,
      videoSize: options.videoSize,
    }
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  /** The operator-set concurrency cap (max live sessions). */
  get maxContexts(): number {
    return this.opts.maxContexts
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Launch the shared browser if needed; concurrent callers share one launch. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser
    if (!this.launching) {
      this.launching = Promise.resolve(this.opts.launch()).then((b) => {
        this.browser = b
        this.launching = undefined
        return b
      })
    }
    return this.launching
  }

  /** Create a fresh isolated context for `sessionId` and return it. */
  async createSession(sessionId: string): Promise<BrowserContext> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`)
    }
    if (this.sessions.size >= this.opts.maxContexts) {
      throw new Error(
        `max contexts reached (${this.opts.maxContexts}); close a session or wait for the reaper`,
      )
    }
    const browser = await this.ensureBrowser()
    // Hardening default: block service workers — a registered SW can cache/intercept
    // requests and persist across the context, bypassing the route-based SSRF layer.
    const context = await browser.newContext({
      serviceWorkers: 'block',
      // deny-by-default: Playwright cancels downloads unless the operator enabled them
      acceptDownloads: this.opts.acceptDownloads,
      ...(this.opts.httpCredentials ? { httpCredentials: this.opts.httpCredentials } : {}),
      // "network heavy mode": when the operator set a harDir, record a full HAR with
      // bodies attached; Playwright flushes it to disk when this context closes.
      ...(this.opts.harDir
        ? {
            recordHar: {
              path: harPathFor(this.opts.harDir, sessionId),
              content: 'attach' as const,
              mode: 'full' as const,
            },
          }
        : {}),
      // Video capture: Playwright records a .webm per page into this dir (auto-named)
      // and writes it on context close. Gated off by default — video is unredactable.
      ...(this.opts.videoDir
        ? {
            recordVideo: {
              dir: this.opts.videoDir,
              ...(this.opts.videoSize ? { size: this.opts.videoSize } : {}),
            },
          }
        : {}),
    })
    if (this.opts.gate) await installSafetyRoutes(context, this.opts.gate)
    if (this.opts.defaultTimeoutMs > 0) context.setDefaultTimeout(this.opts.defaultTimeoutMs)
    if (this.opts.defaultNavigationTimeoutMs > 0) {
      context.setDefaultNavigationTimeout(this.opts.defaultNavigationTimeoutMs)
    }
    if (this.opts.maxPages !== undefined) {
      const cap = this.opts.maxPages
      // Close any page opened beyond the cap (e.g. a popup/new tab) — bounds the
      // per-session page fan-out an app or executed action can create.
      context.on('page', (page) => {
        if (context.pages().length > cap) void page.close().catch(() => {})
      })
    }
    const now = this.opts.now()
    this.sessions.set(sessionId, { context, lastUsedAt: now, createdAt: now })
    return context
  }

  /** Return the session's context (marking it freshly used), or undefined. */
  getContext(sessionId: string): BrowserContext | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    session.lastUsedAt = this.opts.now()
    return session.context
  }

  /** Mark a session as freshly used, resetting its idle timer. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) session.lastUsedAt = this.opts.now()
  }

  /**
   * Register a callback fired with a session id when that session is closed or
   * reaped, **before** its context is torn down — so a consumer (the MCP
   * surface) can flush a `RunRecorder`'s artifacts while the context (and its
   * tracer) is still alive. Callbacks run in registration order and are awaited.
   */
  onReap(cb: (sessionId: string) => void | Promise<void>): void {
    this.reapCallbacks.push(cb)
  }

  /**
   * Register a callback fired with a session id **after** its context has been
   * closed — the mirror of {@link onReap}. A HAR is only written to disk when the
   * context closes, so the surface uses this to finalize (redact + store) the HAR
   * for both an explicit close and a reaped session. Callbacks run in registration
   * order and are awaited.
   */
  onClosed(cb: (sessionId: string) => void | Promise<void>): void {
    this.closedCallbacks.push(cb)
  }

  /** Close and forget a session's context. Unknown ids are a no-op. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    for (const cb of this.reapCallbacks) await cb(sessionId)
    await session.context.close()
    for (const cb of this.closedCallbacks) await cb(sessionId)
  }

  /**
   * Close every session that is idle for at least `idleTtlMs` OR has exceeded the
   * `maxSessionMs` wall-clock cap (if set). Returns the reaped ids.
   */
  async sweepIdle(nowMs: number = this.opts.now()): Promise<string[]> {
    const { idleTtlMs, maxSessionMs } = this.opts
    const reaped: string[] = []
    for (const [id, session] of this.sessions) {
      const idle = nowMs - session.lastUsedAt >= idleTtlMs
      const expired = maxSessionMs !== undefined && nowMs - session.createdAt >= maxSessionMs
      if (idle || expired) reaped.push(id)
    }
    await Promise.all(reaped.map((id) => this.closeSession(id)))
    return reaped
  }

  /** Start a timer that reaps idle sessions every `intervalMs`. */
  startReaper(intervalMs: number): void {
    this.stopReaper()
    this.reaper = setInterval(() => {
      void this.sweepIdle()
    }, intervalMs)
    // Don't keep the process alive just for the reaper.
    this.reaper.unref?.()
  }

  /** Stop the idle reaper timer. */
  stopReaper(): void {
    if (this.reaper) {
      clearInterval(this.reaper)
      this.reaper = undefined
    }
  }

  /** Close all sessions and the browser; the manager can be reused afterward. */
  async shutdown(): Promise<void> {
    this.stopReaper()
    const ids = [...this.sessions.keys()]
    const contexts = [...this.sessions.values()].map((s) => s.context)
    this.sessions.clear()
    await Promise.all(contexts.map((c) => c.close()))
    // Fire onClosed for each session AFTER its context closed — so a consumer can
    // finalize/clean a HAR (written on close) instead of leaving it raw on disk.
    for (const id of ids) for (const cb of this.closedCallbacks) await cb(id)
    const browser = this.browser
    this.browser = undefined
    await browser?.close()
  }
}
