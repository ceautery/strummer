import type { Browser, BrowserContext } from 'playwright-core'
import type { BrowserGate } from './gate.js'
import { installSafetyRoutes } from './routes.js'

export interface BrowserManagerOptions {
  /** How to launch the shared browser. Called lazily, at most once per live
   * browser (re-invoked after a shutdown). */
  launch: () => Promise<Browser>
  /** Max concurrent sessions (isolated contexts). Default 8. */
  maxContexts?: number
  /** Idle time before a session is eligible for reaping, in ms. Default 5 min. */
  idleTtlMs?: number
  /** Per-action default timeout applied to each context, in ms. */
  defaultTimeoutMs?: number
  /** Per-navigation default timeout applied to each context, in ms. */
  defaultNavigationTimeoutMs?: number
  /** Clock injection (testing). Default `Date.now`. */
  now?: () => number
  /** When set, every session's context gets the Tier-1 SSRF route allowlist. */
  gate?: BrowserGate
}

interface Session {
  context: BrowserContext
  lastUsedAt: number
}

/**
 * Owns the single shared browser and the per-session isolated contexts. One
 * browser per server; one ephemeral `BrowserContext` per session (separate
 * cookies/storage). Bounds resource use with a concurrency cap and an idle
 * reaper, and tears everything down on shutdown. The browser is launched lazily
 * on first use so constructing a manager is cheap.
 */
export class BrowserManager {
  private readonly opts: Required<Omit<BrowserManagerOptions, 'launch' | 'gate'>> &
    Pick<BrowserManagerOptions, 'launch' | 'gate'>
  private readonly sessions = new Map<string, Session>()
  private readonly reapCallbacks: ((sessionId: string) => void | Promise<void>)[] = []
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
      gate: options.gate,
    }
  }

  get sessionCount(): number {
    return this.sessions.size
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
    const context = await browser.newContext()
    if (this.opts.gate) await installSafetyRoutes(context, this.opts.gate)
    if (this.opts.defaultTimeoutMs > 0) context.setDefaultTimeout(this.opts.defaultTimeoutMs)
    if (this.opts.defaultNavigationTimeoutMs > 0) {
      context.setDefaultNavigationTimeout(this.opts.defaultNavigationTimeoutMs)
    }
    this.sessions.set(sessionId, { context, lastUsedAt: this.opts.now() })
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

  /** Close and forget a session's context. Unknown ids are a no-op. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    for (const cb of this.reapCallbacks) await cb(sessionId)
    await session.context.close()
  }

  /** Close every session idle for at least `idleTtlMs`. Returns the reaped ids. */
  async sweepIdle(nowMs: number = this.opts.now()): Promise<string[]> {
    const reaped: string[] = []
    for (const [id, session] of this.sessions) {
      if (nowMs - session.lastUsedAt >= this.opts.idleTtlMs) reaped.push(id)
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
    const contexts = [...this.sessions.values()].map((s) => s.context)
    this.sessions.clear()
    await Promise.all(contexts.map((c) => c.close()))
    const browser = this.browser
    this.browser = undefined
    await browser?.close()
  }
}
