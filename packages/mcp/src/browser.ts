import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type ArtifactStore,
  auditA11y,
  type BrowserGate,
  type BrowserManager,
  compareScreenshots,
  finalizeHar,
  finalizeVideo,
  type HarSummary,
  harPathFor,
  loadFlowCollection,
  PageDriver,
  type PerfAuditResult,
  queryTrace,
  RunRecorder,
  runFlow,
  type VideoSummary,
} from '@sackville-mcp/browser'
import type { Page } from 'playwright-core'
import { z } from 'zod'

/**
 * Agent-facing MCP surface over the `@sackville-mcp/browser` engine (ADR 0006; the
 * `browser-mcp-design` fan-out). Stateful, session-oriented: an agent opens a
 * session, drives it over a sequence of stateless tool calls, and closes it.
 *
 * Safety is **operator-set** and never an agent input: the single `BrowserGate`,
 * the SSRF proxy + Tier-1 routes (wired into the `BrowserManager` by the bin),
 * artifact-capture enablement, and the `Redactor` all come from the server bin's
 * config. No tool argument can flip a safety flag. Large artifacts (snapshots,
 * trace/console/network) are returned **by handle** via the
 * `sackville://browser/run/{runId}/{kind}` resource — never inlined.
 */
export interface BrowserToolsOptions {
  /** The shared manager, built by the bin WITH the operator gate (so each
   * context auto-gets the Tier-1 SSRF route allowlist) and the SSRF-proxy launch. */
  manager: BrowserManager
  /** The same operator gate the manager was built with — threaded into every
   * `PageDriver` so navigation/mutation are gated identically. */
  gate: BrowserGate
  /** Shared on-disk artifact store backing the run-artifact resource. */
  artifacts: ArtifactStore
  /** Operator redactor applied to every text output (snapshots are redacted in the
   * engine; reads + dry-run previews are redacted here). Default identity. */
  redact?: (value: string) => string
  /** Operator artifact-capture enablement. Default: console+network on, trace off
   * (trace.zip is unredacted binary). */
  capture?: { trace?: boolean; console?: boolean; network?: boolean }
  /** Resolve a `{{secret:NAME}}` fill placeholder to the operator's secret value.
   * The cleartext is typed into the browser input and immediately scrubbed from
   * every output by the redactor — it never appears in a tool argument or an
   * agent-visible result. Unknown names fail closed. Omit to disable secret fills. */
  resolveSecret?: (name: string) => string | undefined
  /** Allow `browser_save_storage_state` to capture the (password-equivalent)
   * storageState to an operator-path artifact. Default false — agents cannot
   * harvest session cookies/tokens unless the operator enables it. */
  allowStorageState?: boolean
  /** Allow `browser_screenshot` to capture page PNGs. Default false — a screenshot
   * is unredactable pixels (a secret rendered in the DOM would land in the image),
   * so it is operator-gated like the trace.zip. */
  allowScreenshots?: boolean
  /** Allow `browser_vision_click`/`browser_vision_move` — blind coordinate pointer
   * control for canvas / non-AX-tree UI the ARIA-snapshot path can't reach. Default
   * false: clicking a *point* (not a known element) sidesteps the accessible-tree
   * safety story, so it is an explicit operator opt-in (the click still goes through
   * the mutation gate). Decoupled from `allowScreenshots` — an operator can permit
   * read-only screenshots without permitting blind clicks. */
  allowVision?: boolean
  /** Operator download-quarantine dir. When set (the bin also flips the manager's
   * `acceptDownloads` on), started downloads are saved here and surfaced by
   * `browser_downloads`; when unset, downloads are denied (cancelled). */
  downloadDir?: string
  /** Operator upload-allowlist dir. When set, `browser_upload` may set files
   * resolving to within it; unset ⇒ uploads denied (deny-by-default). */
  uploadDir?: string
  /** Operator "network heavy mode" dir. When set (the bin also passes it to the
   * manager so each context records a HAR), the session's HAR is finalized on
   * close — redacted, stored by handle, surfaced in the close reply. Unset ⇒ no
   * HAR. HAR is a heavy secret surface, so it is operator-gated off by default. */
  harDir?: string
  /** Operator HAR-replay dir. When set, `browser_replay_har` may arm replay from a
   * HAR resolving to within it; unset ⇒ replay denied (deny-by-default). The source
   * archive dictates what the page sees, so it must be operator-trusted. */
  replayDir?: string
  /** Operator persisted-flows dir. When set, `browser_list_flows`/`browser_run_flow`
   * load `.bru` + sidecar flows from it (by name — never a caller-supplied path, so
   * there is no traversal surface). Unset ⇒ the flow tools are disabled
   * (deny-by-default). Flows replay through the same gate/redactor as live steps. */
  flowsDir?: string
  /** Operator video dir. When set (the bin also passes it to the manager so each
   * context records a `.webm`), the session's video is finalized on close — stored
   * by handle, surfaced in the close reply. Unset ⇒ no video. Video is unredactable
   * pixels, so it is operator-gated off by default (same posture as the trace). */
  videoDir?: string
  /** Operator visual-regression baseline dir. When set, `browser_visual_compare`
   * resolves a baseline by name (`<name>.png` within this dir) and diffs the current
   * page against it. Unset ⇒ the tool is disabled (deny-by-default). */
  baselineDir?: string
  /** Allow `browser_visual_compare {update:true}` to (over)write a baseline from the
   * current page. Default false — recording a baseline is the operator's call (the
   * accepted golden), so an agent cannot silently rewrite what "correct" means. */
  allowBaselineUpdate?: boolean
  /** Run a Lighthouse perf audit on a URL, keyed by a server-minted `runId`. The
   * bin binds the operator chromium path + proxied/hardened flags + store + redactor
   * here; absent ⇒ `browser_perf_audit` reports it is not enabled. */
  runPerfAudit?: (url: string, runId: string) => Promise<PerfAuditResult>
  /** Token cap on inlined snapshot text. */
  maxNodes?: number
  /** Exact accessible-name matching when resolving refs. Default true. */
  exact?: boolean
}

interface BrowserSession {
  runId: string
  page: Page
  driver: PageDriver
  recorder?: RunRecorder
  createdAt: number
  lastUsedAt: number
  /** Per-session promise chain serializing all driver calls for this session. */
  tail: Promise<unknown>
  /** Monotonic a11y-audit counter → immutable `a11y-s<n>` handles. */
  auditIndex: number
  /** Monotonic visual-diff counter → immutable `visual-diff-s<n>` handles. */
  visualIndex: number
  recorderStopped: boolean
  /** HAR finalized (redact + store) once, on the first close/reap path to run. */
  harFinalized: boolean
  /** The finalized HAR summary, if any — surfaced in the close reply. */
  harSummary?: HarSummary
  /** Video finalized (store) once, on the first close/reap path to run. */
  videoFinalized: boolean
  /** The finalized video summary, if any — surfaced in the close reply. */
  videoSummary?: VideoSummary
}

const INSTRUCTIONS = `Sackville drives a real browser for UI testing, ARIA-snapshot first.

Open a session with \`browser_open_session\` (returns a sessionId + runId), then
drive it: \`browser_navigate\`, \`browser_snapshot\`, and the interaction tools
(\`browser_click\`/\`browser_fill\`/\`browser_select\`/\`browser_press\`) all return a
token-capped ARIA snapshot whose elements carry [ref=…] ids — pass those refs to
the interaction tools. Refs are per-snapshot: any navigate/snapshot/mutation
supersedes earlier refs, so use the freshest snapshot. Reads
(\`browser_get_text\`/\`browser_get_value\`/\`browser_get_attribute\`) do NOT
invalidate refs. Close with \`browser_close_session\` to release the context and
collect artifact handles. Full snapshots, the a11y report, screenshots
(\`browser_screenshot\`, operator-gated), and trace/console/network logs are
returned by handle — read the \`sackville://browser/run/{runId}/{kind}\` resource.

For deterministic offline runs, \`browser_replay_har\` (operator-gated) serves the
session from a recorded HAR instead of the network — call it BEFORE navigating.

To replay a saved test, \`browser_list_flows\` shows the persisted \`.bru\` flows the
operator made available and \`browser_run_flow\` replays one (by name) on a session
— driving through the same gate/redactor as the step tools.

Prefer ref-based tools. For canvas / non-AX-tree UI the snapshot can't address,
\`browser_vision_click\`/\`browser_vision_move\` (operator-gated) drive the pointer at
a viewport coordinate — a blind click on a point, so use it only as a last resort.

Navigation/mutation are deny-by-default and gated by the OPERATOR (host allowlist +
unsafe unlock); mutations are dry-run unless the operator unlocked them. That is
not something a caller can authorize. Secrets are redacted from everything you see.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

function reply(structured: Record<string, unknown>) {
  return { content: [text(structured)], structuredContent: structured }
}

/** Register Sackville's browser-testing tools + run-artifact resource onto a server. */
export function registerBrowserTools(server: McpServer, opts: BrowserToolsOptions): void {
  const { manager, gate, artifacts } = opts
  const redact = opts.redact ?? ((v: string) => v)
  const capture = {
    trace: opts.capture?.trace ?? false,
    console: opts.capture?.console ?? true,
    network: opts.capture?.network ?? true,
  }
  const allowStorageState = opts.allowStorageState ?? false
  const allowScreenshots = opts.allowScreenshots ?? false
  const allowVision = opts.allowVision ?? false
  const baselineDir = opts.baselineDir
  const allowBaselineUpdate = opts.allowBaselineUpdate ?? false
  const harDir = opts.harDir
  const videoDir = opts.videoDir
  const registry = new Map<string, BrowserSession>()
  const now = () => Date.now()

  // When a session is reaped (idle TTL) or closed, flush its recorder while the
  // context + tracer are still ALIVE. close_session flushes first and sets
  // recorderStopped, so this only flushes the reaper path. The registry entry is
  // dropped in onClosed (after the context closes + the HAR is finalized).
  manager.onReap(async (sessionId) => {
    const session = registry.get(sessionId)
    if (session?.recorder && !session.recorderStopped) {
      session.recorderStopped = true
      await session.recorder.stop()
    }
  })

  // After the context has CLOSED, finalize the HAR (written only on close):
  // redact + store it by handle and stash the summary, then drop the registry
  // entry. Runs for both an explicit close and a reaped/shutdown session, so an
  // unredacted HAR is never left on disk. Guarded so it finalizes once.
  manager.onClosed(async (sessionId) => {
    const session = registry.get(sessionId)
    if (session && harDir && !session.harFinalized) {
      session.harFinalized = true
      const summary = await finalizeHar({
        harPath: harPathFor(harDir, sessionId),
        runId: session.runId,
        store: artifacts,
        redact,
      })
      if (summary) session.harSummary = summary
    }
    // Video is also written only on context close (like the HAR). Playwright
    // auto-names the file, so resolve it from the page's Video object. No redaction
    // pass — video is unredactable pixels (operator-gated, surfaced by handle only).
    if (session && videoDir && !session.videoFinalized) {
      session.videoFinalized = true
      const video = session.page.video()
      if (video) {
        const summary = await finalizeVideo({
          videoPath: await video.path(),
          runId: session.runId,
          store: artifacts,
        })
        if (summary) session.videoSummary = summary
      }
    }
    registry.delete(sessionId)
  })

  /** Resolve a live session or throw a clear, actionable error (never reuse a
   * closed/reaped page). */
  function requireSession(sessionId: string): BrowserSession {
    const session = registry.get(sessionId)
    if (!session || !manager.hasSession(sessionId)) {
      registry.delete(sessionId)
      throw new Error(
        `session ${sessionId} expired or was reaped; open a new one with browser_open_session`,
      )
    }
    manager.touch(sessionId)
    session.lastUsedAt = now()
    return session
  }

  /** Serialize a unit of work on a session behind its mutex (FIFO, error-safe). */
  function enqueue<T>(session: BrowserSession, fn: () => Promise<T>): Promise<T> {
    const result = session.tail.then(fn, fn)
    session.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // Resolve `{{secret:NAME}}` placeholders in a fill value at the surface, just
  // before it reaches the engine's locator.fill(). Fails closed: an unconfigured
  // name (or no resolver at all) throws rather than typing a partial value.
  const SECRET_REF = /\{\{\s*secret:\s*([^}\s]+)\s*\}\}/g
  function resolveSecrets(value: string): string {
    return value.replace(SECRET_REF, (_match, name: string) => {
      const resolved = opts.resolveSecret?.(name)
      if (resolved === undefined) {
        throw new Error(`unknown secret "${name}" — not configured by the operator`)
      }
      return resolved
    })
  }

  const sessionId = z.string().describe('session id from browser_open_session')
  const ref = z.string().describe('a [ref=…] id from the latest snapshot')

  server.registerTool(
    'browser_open_session',
    {
      title: 'Open a browser session',
      description:
        'Open a fresh, isolated browser session. Returns a server-minted sessionId + runId. ' +
        'Takes no input — headless/safety/capture are all operator-set.',
      inputSchema: {},
      outputSchema: {
        sessionId: z.string(),
        runId: z.string(),
        sessionCount: z.number().int(),
        maxContexts: z.number().int(),
        capturing: z.object({ trace: z.boolean(), console: z.boolean(), network: z.boolean() }),
      },
    },
    async () => {
      const id = randomUUID()
      const runId = randomUUID()
      let context: Awaited<ReturnType<BrowserManager['createSession']>>
      try {
        context = await manager.createSession(id)
      } catch (err) {
        throw new Error(
          `${(err as Error).message} (sessionCount=${manager.sessionCount}, maxContexts=${manager.maxContexts})`,
        )
      }
      const page = await context.newPage()
      let recorder: RunRecorder | undefined
      if (capture.trace || capture.console || capture.network) {
        recorder = await RunRecorder.start(page, {
          runId,
          store: artifacts,
          redact,
          trace: capture.trace,
          console: capture.console,
          network: capture.network,
        })
      }
      const driver = new PageDriver(page, {
        runId,
        store: artifacts,
        gate,
        redact,
        maxNodes: opts.maxNodes,
        exact: opts.exact,
        downloadDir: opts.downloadDir,
        uploadDir: opts.uploadDir,
        replayDir: opts.replayDir,
      })
      registry.set(id, {
        runId,
        page,
        driver,
        recorder,
        createdAt: now(),
        lastUsedAt: now(),
        tail: Promise.resolve(),
        auditIndex: 0,
        visualIndex: 0,
        recorderStopped: false,
        harFinalized: false,
        videoFinalized: false,
      })
      return reply({
        sessionId: id,
        runId,
        sessionCount: manager.sessionCount,
        maxContexts: manager.maxContexts,
        capturing: capture,
      })
    },
  )

  server.registerTool(
    'browser_list_sessions',
    {
      title: 'List open browser sessions',
      description:
        'List the open sessions (no page content). Use it to find stragglers at the cap.',
      inputSchema: {},
      outputSchema: {
        sessions: z.array(
          z.object({
            sessionId: z.string(),
            runId: z.string(),
            createdAt: z.number(),
            lastUsedAt: z.number(),
          }),
        ),
        sessionCount: z.number().int(),
        maxContexts: z.number().int(),
      },
    },
    async () => {
      const sessions = [...registry.entries()]
        .filter(([id]) => manager.hasSession(id))
        .map(([id, s]) => ({
          sessionId: id,
          runId: s.runId,
          createdAt: s.createdAt,
          lastUsedAt: s.lastUsedAt,
        }))
      return reply({
        sessions,
        sessionCount: manager.sessionCount,
        maxContexts: manager.maxContexts,
      })
    },
  )

  server.registerTool(
    'browser_replay_har',
    {
      title: 'Replay from a HAR (offline determinism)',
      description:
        'Arm "network heavy mode" replay: serve this session’s requests from a recorded HAR instead ' +
        'of the network, for deterministic offline runs. Call it BEFORE browser_navigate. Unmatched ' +
        'requests are aborted (no egress). Deny-by-default: requires an operator HAR-replay dir, and ' +
        'the HAR must resolve to within it (paths are relative to that dir; no traversal).',
      inputSchema: {
        sessionId,
        har: z.string().describe('HAR file path within the operator replay dir'),
      },
      outputSchema: {
        action: z.literal('replay_har'),
        har: z.string(),
        notFound: z.literal('abort'),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.replayFromHar(args.har))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate',
      description:
        'Navigate the session to a URL (gated by the operator host allowlist) and return the ' +
        'resulting ARIA snapshot.',
      inputSchema: { sessionId, url: z.string().describe('absolute URL to navigate to') },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.navigate(args.url))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_snapshot',
    {
      title: 'Snapshot',
      description:
        'Re-capture the current page ARIA snapshot. NOTE: this bumps the generation and ' +
        'supersedes all earlier refs — use get_text/get_value/get_attribute for ref-preserving reads.',
      inputSchema: { sessionId },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.snapshot())
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_click',
    {
      title: 'Click',
      description:
        'Click a ref. Mutating: dry-run (a redacted preview of the would-be request) unless the ' +
        'operator unlocked execution on an allowlisted host.',
      inputSchema: { sessionId, ref },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.click(args.ref))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_fill',
    {
      title: 'Fill',
      description:
        'Fill a ref (text input) with a value. Use {{secret:NAME}} to fill an operator secret ' +
        '(resolved server-side, never echoed back). Mutating: same gate as click.',
      inputSchema: {
        sessionId,
        ref,
        value: z.string().describe('value to type, or {{secret:NAME}}'),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const value = resolveSecrets(args.value) // fail-closed before touching the page
      const result = await enqueue(session, () => session.driver.fill(args.ref, value))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_fill_form',
    {
      title: 'Fill a form',
      description:
        'Fill several refs in one step (all must belong to the current snapshot). Mutating: same gate.',
      inputSchema: {
        sessionId,
        fields: z
          .array(z.object({ ref: z.string(), value: z.string() }))
          .describe('ref/value pairs from the current snapshot'),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const fields = args.fields.map((f) => ({ ref: f.ref, value: resolveSecrets(f.value) }))
      const result = await enqueue(session, () => session.driver.fillForm(fields))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_select',
    {
      title: 'Select option(s)',
      description: 'Select option(s) on a <select> ref. Mutating: same gate as click.',
      inputSchema: {
        sessionId,
        ref,
        values: z.union([z.string(), z.array(z.string())]).describe('option value(s) to select'),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () =>
        session.driver.selectOption(args.ref, args.values),
      )
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_press',
    {
      title: 'Press a key',
      description:
        'Press a key on a ref (or on the page when ref is omitted). Mutating: same gate as click.',
      inputSchema: {
        sessionId,
        ref: z.string().nullable().optional().describe('target ref, or omit for the page'),
        key: z.string().describe('key to press, e.g. "Enter"'),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.press(args.ref ?? null, args.key))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_upload',
    {
      title: 'Upload file(s)',
      description:
        'Set file(s) on a file-input ref. Deny-by-default: requires an operator upload-allowlist dir, ' +
        'and every path must resolve to within it (no traversal/absolute escape) — an agent cannot ' +
        'upload arbitrary local files. Paths are relative to that dir. The later submit is gated separately.',
      inputSchema: {
        sessionId,
        ref,
        files: z.array(z.string()).describe('file path(s) within the operator upload dir'),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.uploadFiles(args.ref, args.files))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_wait_for',
    {
      title: 'Wait for an element state',
      description:
        'Wait for a ref (or a role + optional accessible name) to reach a state, then re-snapshot. ' +
        'A read-only synchronization affordance.',
      inputSchema: {
        sessionId,
        ref: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
        state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
        timeout: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () =>
        session.driver.waitFor({
          ref: args.ref,
          role: args.role,
          name: args.name,
          state: args.state,
          timeout: args.timeout,
        }),
      )
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_get_text',
    {
      title: 'Get element text',
      description: 'Read a ref’s text content (a free read; does not invalidate refs).',
      inputSchema: { sessionId, ref },
      outputSchema: { text: z.string().nullable() },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const value = await enqueue(session, () => session.driver.getText(args.ref))
      return reply({ text: value === null ? null : redact(value) })
    },
  )

  server.registerTool(
    'browser_get_value',
    {
      title: 'Get input value',
      description: 'Read a ref’s current input value (a free read; redacted).',
      inputSchema: { sessionId, ref },
      outputSchema: { value: z.string() },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const value = await enqueue(session, () => session.driver.getValue(args.ref))
      return reply({ value: redact(value) })
    },
  )

  server.registerTool(
    'browser_get_attribute',
    {
      title: 'Get element attribute',
      description: 'Read an HTML attribute off a ref (a free read; redacted).',
      inputSchema: { sessionId, ref, name: z.string().describe('attribute name') },
      outputSchema: { name: z.string(), value: z.string().nullable() },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const value = await enqueue(session, () => session.driver.getAttribute(args.ref, args.name))
      return reply({ name: args.name, value: value === null ? null : redact(value) })
    },
  )

  server.registerTool(
    'browser_assert',
    {
      title: 'Assert page conditions',
      description:
        'Evaluate declarative assertions against the live page (a free read; does not invalidate ' +
        'refs). Each assertion AUTO-WAITS up to its timeout, so a condition that becomes true after ' +
        'an async update still passes. Element sources (text/value/visible/count) target by ref or ' +
        'role(+name); page sources are url/title/ariaSnapshot. Observed values are redacted.',
      inputSchema: {
        sessionId,
        assertions: z
          .array(
            z.object({
              source: z.enum(['url', 'title', 'ariaSnapshot', 'text', 'value', 'visible', 'count']),
              op: z.enum([
                'equals',
                'notEquals',
                'gt',
                'gte',
                'lt',
                'lte',
                'contains',
                'notContains',
                'matches',
                'exists',
                'notExists',
              ]),
              value: z.unknown().optional(),
              ref: z.string().optional(),
              role: z.string().optional(),
              name: z.string().optional(),
              timeout: z.number().int().positive().optional(),
            }),
          )
          .describe('the assertions to evaluate (each auto-waits to its timeout)'),
      },
      outputSchema: {
        pass: z.boolean(),
        results: z.array(
          z.object({
            source: z.string(),
            op: z.string(),
            ref: z.string().optional(),
            role: z.string().optional(),
            name: z.string().optional(),
            expected: z.unknown().optional(),
            actual: z.unknown(),
            pass: z.boolean(),
          }),
        ),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const results = await enqueue(session, () =>
        session.driver.assert(args.assertions as Parameters<PageDriver['assert']>[0]),
      )
      return reply({ pass: results.every((r) => r.pass), results })
    },
  )

  server.registerTool(
    'browser_audit_a11y',
    {
      title: 'Accessibility audit',
      description:
        'Run an axe-core accessibility audit on the current page (a free read). Returns a compact ' +
        'summary; the full report is by handle.',
      inputSchema: { sessionId },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => {
        session.auditIndex += 1
        return auditA11y(session.page, {
          runId: session.runId,
          store: artifacts,
          index: session.auditIndex,
        })
      })
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description:
        'Capture a PNG screenshot of the current page, stored by handle (never inlined). Returns a ' +
        'summary; read the image via the sackville://browser/run/{runId}/screenshot-s<n> resource. ' +
        'Requires operator enablement — a screenshot is pixels and cannot be redacted.',
      inputSchema: {
        sessionId,
        fullPage: z
          .boolean()
          .optional()
          .describe('capture the full scrollable page instead of just the viewport'),
      },
      outputSchema: {
        handle: z.string(),
        byteSize: z.number().int(),
        contentType: z.literal('image/png'),
        fullPage: z.boolean(),
      },
    },
    async (args) => {
      if (!allowScreenshots) {
        throw new Error('screenshot capture is not enabled by the operator')
      }
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () =>
        session.driver.screenshot({ fullPage: args.fullPage }),
      )
      return reply({ ...result })
    },
  )

  const x = z.number().describe('viewport x coordinate in CSS pixels (e.g. from a screenshot)')
  const y = z.number().describe('viewport y coordinate in CSS pixels (e.g. from a screenshot)')

  server.registerTool(
    'browser_vision_click',
    {
      title: 'Click at a coordinate (vision)',
      description:
        'Click a viewport coordinate (CSS pixels) — the escape hatch for canvas / non-AX-tree UI the ' +
        'ARIA snapshot can’t address. Prefer ref-based browser_click whenever the element is in the ' +
        'snapshot; this is a BLIND click on a point. Mutating: dry-run unless the operator unlocked ' +
        'execution on an allowlisted host. Requires operator vision enablement.',
      inputSchema: { sessionId, x, y },
    },
    async (args) => {
      if (!allowVision) {
        throw new Error('vision/coordinate input is not enabled by the operator')
      }
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.mouseClick(args.x, args.y))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_vision_move',
    {
      title: 'Move the pointer to a coordinate (vision)',
      description:
        'Move the pointer to a viewport coordinate (CSS pixels) — e.g. to hover a canvas widget — then ' +
        're-snapshot. Non-mutating positioning; hover-triggered egress is still governed by the SSRF ' +
        'layer. Requires operator vision enablement.',
      inputSchema: { sessionId, x, y },
    },
    async (args) => {
      if (!allowVision) {
        throw new Error('vision/coordinate input is not enabled by the operator')
      }
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () => session.driver.mouseMove(args.x, args.y))
      return reply({ ...result })
    },
  )

  server.registerTool(
    'browser_visual_compare',
    {
      title: 'Visual regression compare',
      description:
        'Capture the current page (animations frozen, caret hidden) and diff it pixel-for-pixel ' +
        'against a stored baseline (by name) via pixelmatch. Returns pass + diff pixel count/ratio; on ' +
        'a mismatch the diff image is stored by handle (visual-diff-s<n>). Pass maxDiffPixelRatio / ' +
        'maxDiffPixels to set a budget and mask[] to ignore dynamic regions. With update:true (operator-' +
        'gated) it (over)writes the baseline from the current page. Requires an operator baseline dir. ' +
        'Assert on a diff budget, not exact pixels — baselines are platform/browser-specific.',
      inputSchema: {
        sessionId,
        name: z
          .string()
          .describe('baseline name (resolved to <name>.png in the operator baseline dir)'),
        update: z
          .boolean()
          .optional()
          .describe('record/overwrite the baseline from the current page (operator-gated)'),
        fullPage: z.boolean().optional().describe('capture the full scrollable page'),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('pixelmatch per-pixel color sensitivity 0..1 (default 0.1)'),
        maxDiffPixelRatio: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('max differing pixels as a ratio of total (default 0)'),
        maxDiffPixels: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('max differing pixels (absolute)'),
        mask: z
          .array(
            z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }),
          )
          .optional()
          .describe('rectangles (image pixels) to ignore — dynamic regions'),
      },
    },
    async (args) => {
      if (!baselineDir) {
        throw new Error(
          'visual regression is not enabled by the operator (no baseline dir configured)',
        )
      }
      const session = requireSession(args.sessionId)
      const file = join(baselineDir, `${args.name.replace(/[^\w.-]/g, '_')}.png`)
      // Capture under the session mutex; the PNG lands in the store under its handle.
      const shot = await enqueue(session, () =>
        session.driver.screenshot({ fullPage: args.fullPage }),
      )
      const captured = shot.handle ? artifacts.get(shot.handle)?.body : undefined
      if (!captured) {
        throw new Error('screenshot capture failed')
      }
      if (args.update) {
        if (!allowBaselineUpdate) {
          throw new Error('baseline update is not enabled by the operator')
        }
        writeFileSync(file, captured)
        return reply({
          name: args.name,
          updated: true,
          pass: true,
          baselineExists: true,
          capturedHandle: shot.handle,
        })
      }
      if (!existsSync(file)) {
        return reply({
          name: args.name,
          pass: false,
          baselineExists: false,
          capturedHandle: shot.handle,
          note: 'no baseline — re-run with update:true (operator-gated) to record one',
        })
      }
      const result = compareScreenshots(captured, readFileSync(file), {
        threshold: args.threshold,
        maxDiffPixelRatio: args.maxDiffPixelRatio,
        maxDiffPixels: args.maxDiffPixels,
        mask: args.mask,
      })
      let diffHandle: string | undefined
      if (!result.pass && result.diffPng) {
        session.visualIndex += 1
        diffHandle = artifacts.put(
          session.runId,
          `visual-diff-s${session.visualIndex}`,
          result.diffPng,
          'image/png',
        )
      }
      return reply({
        name: args.name,
        baselineExists: true,
        capturedHandle: shot.handle,
        pass: result.pass,
        diffPixels: result.diffPixels,
        totalPixels: result.totalPixels,
        diffPixelRatio: result.diffPixelRatio,
        sizeMismatch: result.sizeMismatch,
        ...(diffHandle ? { diffHandle } : {}),
      })
    },
  )

  server.registerTool(
    'browser_downloads',
    {
      title: 'Collect downloads',
      description:
        'Return file downloads captured since the last call (a free read; does not invalidate refs). ' +
        'Downloads are saved to the operator quarantine dir — only filename/path/size are reported, ' +
        'never the bytes; denied (no quarantine dir) downloads report accepted:false. Pass waitMs to ' +
        'wait briefly for a download triggered by a just-issued click.',
      inputSchema: {
        sessionId,
        waitMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('wait up to this long (ms) for a pending download to start'),
      },
      outputSchema: {
        downloads: z.array(
          z.object({
            suggestedFilename: z.string(),
            savedAs: z.string().optional(),
            byteSize: z.number().int().optional(),
            accepted: z.boolean(),
          }),
        ),
      },
    },
    async (args) => {
      const session = requireSession(args.sessionId)
      const downloads = await enqueue(session, () => session.driver.collectDownloads(args.waitMs))
      return reply({ downloads })
    },
  )

  server.registerTool(
    'browser_save_storage_state',
    {
      title: 'Save storage state',
      description:
        'Capture the session storageState (cookies + localStorage origins) to an OPERATOR-PATH ' +
        'artifact, returned as a handle + counts only — never inlined and NOT served back through ' +
        'the resource (password-equivalent). Requires operator enablement.',
      inputSchema: { sessionId },
      outputSchema: {
        handle: z.string(),
        cookies: z.number().int(),
        origins: z.number().int(),
      },
    },
    async (args) => {
      if (!allowStorageState) {
        throw new Error('storageState capture is not enabled by the operator')
      }
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, async () => {
        const state = await session.page.context().storageState()
        // redact known secrets before write (the file is still operator-path); the agent
        // only ever sees the handle + counts, never the cookie/token values.
        const handle = artifacts.put(
          session.runId,
          'storage-state',
          redact(JSON.stringify(state)),
          'application/json',
        )
        return { handle, cookies: state.cookies.length, origins: state.origins.length }
      })
      return reply(result)
    },
  )

  server.registerTool(
    'browser_list_flows',
    {
      title: 'List persisted flows',
      description:
        'List the persisted browser flows the operator has made available (name + step count). ' +
        'Run one with browser_run_flow. Requires an operator flows dir (deny-by-default).',
      inputSchema: {},
      outputSchema: {
        flows: z.array(z.object({ name: z.string(), steps: z.number().int() })),
      },
    },
    async () => {
      if (!opts.flowsDir) {
        throw new Error('flow replay is not enabled by the operator (no flows dir configured)')
      }
      const collection = loadFlowCollection(opts.flowsDir)
      const flows = [...collection.flows.values()].map((f) => ({
        name: f.name,
        steps: f.steps.length,
      }))
      return reply({ flows })
    },
  )

  server.registerTool(
    'browser_run_flow',
    {
      title: 'Run a persisted flow',
      description:
        'Replay a persisted .bru browser flow (by name, from the operator flows dir) on a session. ' +
        'Steps run sequentially through the SAME operator gate (navigation allowlist + dry-run-vs-execute) ' +
        'and redactor as live tool calls — so unlocking mutations is the operator’s call, not yours. ' +
        'Pass non-secret {{var}} values via `vars`; {{secret:NAME}} placeholders resolve server-side from ' +
        'the operator secret store (fail-closed on an unknown name) and never appear in the result. A step ' +
        'that throws stops the flow; an assertion that does not hold fails the flow but lets it continue.',
      inputSchema: {
        sessionId,
        flow: z.string().describe('name of a flow from browser_list_flows'),
        vars: z
          .record(z.string(), z.string())
          .optional()
          .describe('{{var}} interpolation values (non-secret; secrets are operator-resolved)'),
      },
    },
    async (args) => {
      if (!opts.flowsDir) {
        throw new Error('flow replay is not enabled by the operator (no flows dir configured)')
      }
      const collection = loadFlowCollection(opts.flowsDir)
      const flow = collection.flows.get(args.flow)
      if (!flow) {
        const available = [...collection.flows.keys()].join(', ') || '(none)'
        throw new Error(
          `no flow "${args.flow}" in the operator flows dir — available: ${available}`,
        )
      }
      const session = requireSession(args.sessionId)
      const result = await enqueue(session, () =>
        runFlow(session.driver, flow, {
          vars: args.vars,
          resolveSecret: opts.resolveSecret,
        }),
      )
      // The driver already redacts the values it surfaces (dry-run previews, assertion
      // actuals). Step `error` strings are the one raw channel — redact them here too.
      const steps = result.steps.map((s) => (s.error ? { ...s, error: redact(s.error) } : s))
      return reply({ name: result.name, passed: result.passed, steps })
    },
  )

  server.registerTool(
    'browser_close_session',
    {
      title: 'Close a browser session',
      description:
        'Close the session, releasing its context. Flushes and returns the run artifact handles ' +
        '(console/network/trace, plus a HAR when network-heavy mode is operator-enabled).',
      inputSchema: { sessionId },
    },
    async (args) => {
      const session = registry.get(args.sessionId)
      if (!session || !manager.hasSession(args.sessionId)) {
        registry.delete(args.sessionId)
        throw new Error(`session ${args.sessionId} is not open`)
      }
      const { artifacts: runArtifacts } = await enqueue(session, async () => {
        let runArtifacts: Awaited<ReturnType<RunRecorder['stop']>> | undefined
        if (session.recorder && !session.recorderStopped) {
          session.recorderStopped = true
          runArtifacts = await session.recorder.stop()
        }
        // Flush the recorder BEFORE closing (its trace needs the context alive).
        // closeSession then fires onReap (recorder already stopped → skipped) and,
        // after the context closes, onClosed → which finalizes the HAR + video onto
        // the session and drops the registry entry. We still hold `session`, so we
        // can read its stashed har/video summaries below.
        await manager.closeSession(args.sessionId)
        return { artifacts: runArtifacts }
      })
      const allArtifacts =
        runArtifacts || session.harSummary || session.videoSummary
          ? {
              ...runArtifacts,
              ...(session.harSummary ? { har: session.harSummary } : {}),
              ...(session.videoSummary ? { video: session.videoSummary } : {}),
            }
          : undefined
      return reply({
        closed: true,
        runId: session.runId,
        ...(allArtifacts ? { artifacts: allArtifacts } : {}),
      })
    },
  )

  server.registerTool(
    'browser_perf_audit',
    {
      title: 'Performance audit (Lighthouse)',
      description:
        'Run a Lighthouse performance audit on a URL (gated by the operator host allowlist). Spawns ' +
        'a fresh proxied Chrome and loads the page clean — independent of any session. Returns the ' +
        'performance score + core web-vitals metrics; the full LHR JSON + HTML report are by handle. ' +
        'Assert on metric shape/thresholds, never an exact score (scores vary). Requires operator enablement.',
      inputSchema: { url: z.string().describe('absolute URL to audit') },
      outputSchema: {
        runId: z.string(),
        summary: z.object({
          performanceScore: z.number().nullable(),
          metrics: z.array(
            z.object({
              id: z.string(),
              score: z.number().nullable(),
              numericValue: z.number().optional(),
              displayValue: z.string().optional(),
            }),
          ),
          lighthouseVersion: z.string(),
        }),
        reportHandle: z.string(),
        htmlHandle: z.string(),
      },
    },
    async (args) => {
      if (!opts.runPerfAudit) {
        throw new Error('performance audit is not enabled by the operator')
      }
      gate.checkNavigation(args.url) // same allowlist as browser_navigate
      const runId = randomUUID()
      const result = await opts.runPerfAudit(args.url, runId)
      return reply({ runId, ...result })
    },
  )

  server.registerTool(
    'browser_trace_query',
    {
      title: 'Query a run trace',
      description:
        'Parse a captured trace.zip (by runId; requires trace capture to have been enabled) into a ' +
        'structured action timeline (API calls with timing + errors), console output, and an errors ' +
        'list. No live session needed — query a trace after the session closed. The trace is already ' +
        'redacted. Use apiFilter/errorsOnly/limit to narrow; includeParams adds (verbose) call params.',
      inputSchema: {
        runId: z.string().describe('the runId whose trace to query'),
        apiFilter: z.string().optional().describe('keep only actions whose api contains this'),
        errorsOnly: z.boolean().optional().describe('keep only actions that errored'),
        limit: z.number().int().positive().optional().describe('cap the actions returned'),
        includeParams: z.boolean().optional().describe('include each action’s params'),
      },
    },
    async (args) => {
      const handle = `sackville://browser/run/${args.runId}/trace`
      const artifact = artifacts.get(handle)
      if (!artifact) {
        throw new Error(
          `no trace for run ${args.runId} — was trace capture enabled (SACKVILLE_BROWSER_CAPTURE_TRACE)?`,
        )
      }
      const result = queryTrace(artifact.body, {
        apiFilter: args.apiFilter,
        errorsOnly: args.errorsOnly,
        limit: args.limit,
        includeParams: args.includeParams,
      })
      return reply({ ...result })
    },
  )

  server.registerResource(
    'browser-run',
    new ResourceTemplate('sackville://browser/run/{runId}/{kind}', { list: undefined }),
    {
      title: 'Browser run artifact',
      description:
        'Full stored browser-run artifact (snapshot-s<gen> / a11y-s<n> / screenshot-s<n> / visual-diff-s<n> / trace / console / network / har / video), by handle',
    },
    (uri, variables) => {
      const runId = Array.isArray(variables.runId) ? variables.runId[0] : variables.runId
      const kind = Array.isArray(variables.kind) ? variables.kind[0] : variables.kind
      const handle = `sackville://browser/run/${runId}/${kind}`
      // storageState is password-equivalent: written for the operator, never served
      // back to the agent (it would expose live session cookies/tokens).
      if (kind === 'storage-state') {
        throw new Error(
          `${handle} is an operator-path artifact (password-equivalent) and is not served to the agent; read it from the artifacts directory`,
        )
      }
      const artifact = artifacts.get(handle)
      if (!artifact) {
        throw new Error(`No stored artifact for ${handle}`)
      }
      // Binary artifacts (trace.zip/HAR zip, screenshot PNG, video webm) are returned
      // as a base64 blob; text artifacts (snapshots, a11y/console/network JSON) as UTF-8.
      const isBinary =
        artifact.contentType === 'application/zip' ||
        artifact.contentType.startsWith('image/') ||
        artifact.contentType.startsWith('video/')
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: artifact.contentType,
            ...(isBinary
              ? { blob: artifact.body.toString('base64') }
              : { text: artifact.body.toString('utf8') }),
          },
        ],
      }
    },
  )
}

/** Build a standalone Sackville browser MCP server over a prepared manager. */
export function createBrowserServer(opts: BrowserToolsOptions): McpServer {
  const server = new McpServer(
    { name: 'sackville-browser', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerBrowserTools(server, opts)
  return server
}
