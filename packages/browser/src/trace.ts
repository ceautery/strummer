import { strFromU8, unzipSync } from 'fflate'

/**
 * Query a captured Playwright **trace.zip** by parsing its JSONL event streams
 * directly — no `npx playwright trace` subprocess (its `open` subcommand launches
 * a GUI viewer; there are no `console`/`network`/`errors` subcommands — those live
 * inside the trace itself). This deterministic parser is the agent/CI path; the
 * viewer remains a human affordance.
 *
 * The trace's `*.trace` file is one JSON object per line. The action timeline is
 * the `before`/`after` pairs (matched by `callId`): `before` carries the API call
 * (`class.method`) + params + start time, `after` carries the end time and any
 * error. `console` events carry page console output. `context-options` carries the
 * browser/Playwright metadata.
 *
 * NOTE on secrets: a trace.zip produced by `RunRecorder` is **already redacted**
 * (its text entries — incl. this `.trace` JSONL — are scrubbed before write), so a
 * query over a stored trace surfaces only redacted text.
 */

export interface TraceAction {
  callId: string
  /** The Playwright API call, `${class}.${method}` (e.g. `Frame.click`). */
  api: string
  startTime: number
  endTime?: number
  durationMs?: number
  /** Error message when the call failed. */
  error?: string
  /** Call params — only present when `includeParams` was requested. */
  params?: Record<string, unknown>
}

export interface TraceConsoleEntry {
  /** Console message type (`log`/`warning`/`error`/…). */
  type: string
  text: string
}

export interface TraceQueryResult {
  playwrightVersion?: string
  browserName?: string
  /** The action timeline (filtered + limited per options), time-ordered. */
  actions: TraceAction[]
  console: TraceConsoleEntry[]
  /** Action errors + console `error` texts, for a quick "what went wrong" read. */
  errors: string[]
  summary: {
    /** Total actions after filtering (may exceed `actions.length` when limited). */
    actionCount: number
    errorCount: number
    consoleCount: number
    /** Wall-clock span of the matched actions, in ms. */
    durationMs: number
  }
}

export interface TraceQueryOptions {
  /** Keep only actions whose api contains this substring (case-insensitive). */
  apiFilter?: string
  /** Keep only actions that errored. */
  errorsOnly?: boolean
  /** Cap the number of actions returned (the summary still counts the full set). */
  limit?: number
  /** Include each action's params (can be large/verbose). Default false. */
  includeParams?: boolean
}

interface BeforeEvent {
  type: 'before'
  callId: string
  startTime: number
  class: string
  method: string
  params?: Record<string, unknown>
}
interface AfterEvent {
  type: 'after'
  callId: string
  endTime?: number
  error?: { error?: { message?: string }; message?: string }
}

/** Parse the trace.zip bytes into a structured, filterable query result. */
export function queryTrace(
  zip: Buffer | Uint8Array,
  opts: TraceQueryOptions = {},
): TraceQueryResult {
  const entries = unzipSync(zip instanceof Uint8Array ? zip : new Uint8Array(zip))

  let playwrightVersion: string | undefined
  let browserName: string | undefined
  const befores = new Map<string, BeforeEvent>()
  const afters = new Map<string, AfterEvent>()
  const console: TraceConsoleEntry[] = []

  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.endsWith('.trace')) continue
    for (const line of strFromU8(bytes).split('\n')) {
      if (!line) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        continue // a partial/corrupt line shouldn't sink the whole query
      }
      switch (ev.type) {
        case 'context-options':
          playwrightVersion ??= ev.playwrightVersion as string | undefined
          browserName ??= ev.browserName as string | undefined
          break
        case 'before':
          befores.set(ev.callId as string, ev as unknown as BeforeEvent)
          break
        case 'after':
          afters.set(ev.callId as string, ev as unknown as AfterEvent)
          break
        case 'console':
          console.push({ type: ev.messageType as string, text: (ev.text as string) ?? '' })
          break
      }
    }
  }

  // Pair before/after into the action timeline, time-ordered.
  let actions: TraceAction[] = [...befores.values()]
    .map((b) => {
      const after = afters.get(b.callId)
      const error = after?.error?.error?.message ?? after?.error?.message
      const endTime = after?.endTime
      return {
        callId: b.callId,
        api: `${b.class}.${b.method}`,
        startTime: b.startTime,
        ...(endTime !== undefined ? { endTime, durationMs: round(endTime - b.startTime) } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(b.params !== undefined ? { params: b.params } : {}),
      } satisfies TraceAction
    })
    .sort((a, b) => a.startTime - b.startTime)

  if (opts.apiFilter) {
    const needle = opts.apiFilter.toLowerCase()
    actions = actions.filter((a) => a.api.toLowerCase().includes(needle))
  }
  if (opts.errorsOnly) actions = actions.filter((a) => a.error !== undefined)

  const errors = [
    ...actions.filter((a) => a.error !== undefined).map((a) => a.error as string),
    ...console.filter((c) => c.type === 'error').map((c) => c.text),
  ]
  const starts = actions.map((a) => a.startTime)
  const ends = actions.map((a) => a.endTime ?? a.startTime)
  const durationMs = actions.length === 0 ? 0 : round(Math.max(...ends) - Math.min(...starts))

  const summary = {
    actionCount: actions.length,
    errorCount: errors.length,
    consoleCount: console.length,
    durationMs,
  }

  if (!opts.includeParams) actions = actions.map(({ params: _p, ...rest }) => rest)
  if (opts.limit !== undefined) actions = actions.slice(0, opts.limit)

  return { playwrightVersion, browserName, actions, console, errors, summary }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
