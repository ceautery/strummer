import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore } from '@strummer/artifacts'
import type { BrowserFlow, FlowResult, HarSummary } from '@strummer/browser'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserRuntime } from './bin-browser.js'
import { driveBrowserFlowToHar, type LiveCaptureDeps } from './live-capture.js'

/** A fake runtime whose browser ops are stubs — no real chromium / proxy. */
function fakeRuntime(over: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return {
    manager: {
      createSession: async () => ({ newPage: async () => ({}) }),
      closeSession: async () => {},
    },
    gate: {},
    proxy: {},
    store: {},
    engine: 'chromium',
    redactor: {},
    redact: (s: string) => s,
    resolveSecret: () => undefined,
    runPerfAudit: (async () => ({})) as never,
    config: { harDir: '/tmp/strummer-har' } as never,
    shutdown: vi.fn(async () => {}),
    ...over,
  } as unknown as BrowserRuntime
}

const HAR_SUMMARY: HarSummary = {
  handle: 'PLACEHOLDER',
  byteSize: 3,
  entryCount: 0,
  byStatus: {},
  byMethod: {},
}

/** Build deps with all browser-touching seams faked; `store` is a REAL verify-prefix store
 * so the finalize handle is genuinely `strummer://verify/<id>/har`. */
function deps(
  flowResult: FlowResult,
  over: Partial<LiveCaptureDeps> = {},
): { deps: LiveCaptureDeps; runtime: BrowserRuntime; store: ArtifactStore } {
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'strummer-lc-')), 'verify')
  const runtime = fakeRuntime()
  const d: LiveCaptureDeps = {
    runtimeFactory: async () => runtime,
    store,
    flowsDir: '/operator/flows',
    idFactory: () => 'cap-1',
    loadCollection: () =>
      ({
        flows: new Map<string, BrowserFlow>([
          ['login', { name: 'login', steps: [] } as BrowserFlow],
        ]),
      }) as never,
    makeDriver: () => ({}) as never,
    runFlow: async () => flowResult,
    // finalize writes real bytes into the verify store so the handle prefix is genuine.
    finalizeHar: async ({ runId, store: s }) => {
      const handle = s.put(runId, 'har', Buffer.from('zip'), 'application/zip')
      return { ...HAR_SUMMARY, handle }
    },
    harPathFor: (dir, id) => `${dir}/${id}.zip`,
    ...over,
  }
  return { deps: d, runtime, store }
}

const PASSED: FlowResult = {
  name: 'login',
  passed: true,
  steps: [{ action: 'navigate', ok: true }],
}

describe('driveBrowserFlowToHar (5e slice 4)', () => {
  it('drives a completed flow → returns the stored HAR under the VERIFY prefix', async () => {
    const { deps: d, runtime } = deps(PASSED)
    const out = await driveBrowserFlowToHar({ mode: 'produce', flow: 'login' }, d)
    expect(out.harHandle).toMatch(/^strummer:\/\/verify\/cap-1\/har$/)
    expect(runtime.shutdown).toHaveBeenCalledOnce() // single-shot teardown
  })

  it('REJECTS an incomplete flow (a swallowed step error) — never validates a partial HAR', async () => {
    // runFlow swallows the gate denial → passed:false with a non-empty HAR. The
    // completeness guard must reject so the verdict is inconclusive, never a pass.
    const partial: FlowResult = {
      name: 'login',
      passed: false,
      steps: [
        { action: 'navigate', ok: true },
        { action: 'click', ok: false, error: 'GateError: host not allowlisted' },
      ],
    }
    const finalize = vi.fn(async () => HAR_SUMMARY)
    const { deps: d, runtime } = deps(partial, { finalizeHar: finalize })
    await expect(driveBrowserFlowToHar({ mode: 'produce', flow: 'login' }, d)).rejects.toThrow(
      /did not complete.*click/,
    )
    expect(runtime.shutdown).toHaveBeenCalledOnce() // teardown still runs (finally)
    expect(finalize).not.toHaveBeenCalled() // never finalized/validated the partial HAR
  })

  it('REJECTS when no HAR was captured (absence is never a pass)', async () => {
    const { deps: d, runtime } = deps(PASSED, { finalizeHar: async () => undefined })
    await expect(driveBrowserFlowToHar({ mode: 'produce', flow: 'login' }, d)).rejects.toThrow(
      /no HAR was captured/,
    )
    expect(runtime.shutdown).toHaveBeenCalledOnce()
  })

  it('REJECTS an unknown flow name without building a runtime', async () => {
    const { deps: d, runtime } = deps(PASSED)
    await expect(driveBrowserFlowToHar({ mode: 'produce', flow: 'nope' }, d)).rejects.toThrow(
      /no flow "nope"/,
    )
    expect(runtime.shutdown).not.toHaveBeenCalled()
  })
})
