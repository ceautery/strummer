import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore } from '@sackville-mcp/artifacts'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserFlow, FlowResult } from './flow.js'
import type { HarSummary } from './har.js'
import { type CaptureRuntime, driveBrowserFlowToHar, type LiveCaptureDeps } from './live-capture.js'

/** A fake runtime whose browser ops are stubs — no real chromium / proxy. */
function fakeRuntime(): CaptureRuntime {
  return {
    manager: {
      createSession: async () => ({ newPage: async () => ({}) }),
      closeSession: async () => {},
    },
    gate: {},
    redact: (s: string) => s,
    resolveSecret: () => undefined,
    config: { harDir: '/tmp/sackville-har' },
    shutdown: vi.fn(async () => {}),
  } as unknown as CaptureRuntime
}

const HAR_SUMMARY: HarSummary = {
  handle: 'PLACEHOLDER',
  byteSize: 3,
  entryCount: 0,
  byStatus: {},
  byMethod: {},
}

/** Build deps with all browser-touching seams faked; `store` is a REAL verify-prefix store
 * so the finalize handle is genuinely `sackville://verify/<id>/har`. */
function deps(
  flowResult: FlowResult,
  over: Partial<LiveCaptureDeps> = {},
): { deps: LiveCaptureDeps; runtime: CaptureRuntime } {
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'sackville-lc-')), 'verify')
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
    finalizeHar: async ({ runId, store: s }) => {
      const handle = s.put(runId, 'har', Buffer.from('zip'), 'application/zip')
      return { ...HAR_SUMMARY, handle }
    },
    harPathFor: (dir, id) => `${dir}/${id}.zip`,
    ...over,
  }
  return { deps: d, runtime }
}

const PASSED: FlowResult = {
  name: 'login',
  passed: true,
  steps: [{ action: 'navigate', ok: true }],
}

describe('driveBrowserFlowToHar (5e)', () => {
  it('drives a completed flow → returns the stored HAR under the store prefix', async () => {
    const { deps: d, runtime } = deps(PASSED)
    const out = await driveBrowserFlowToHar({ flow: 'login' }, d)
    expect(out.harHandle).toMatch(/^sackville:\/\/verify\/cap-1\/har$/)
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
    await expect(driveBrowserFlowToHar({ flow: 'login' }, d)).rejects.toThrow(
      /did not complete.*click/,
    )
    expect(runtime.shutdown).toHaveBeenCalledOnce() // teardown still runs (finally)
    expect(finalize).not.toHaveBeenCalled() // never finalized/validated the partial HAR
  })

  it('REJECTS when no HAR was captured (absence is never a pass)', async () => {
    const { deps: d, runtime } = deps(PASSED, { finalizeHar: async () => undefined })
    await expect(driveBrowserFlowToHar({ flow: 'login' }, d)).rejects.toThrow(/no HAR was captured/)
    expect(runtime.shutdown).toHaveBeenCalledOnce()
  })

  it('REJECTS an unknown flow name without building a runtime', async () => {
    const { deps: d, runtime } = deps(PASSED)
    await expect(driveBrowserFlowToHar({ flow: 'nope' }, d)).rejects.toThrow(/no flow "nope"/)
    expect(runtime.shutdown).not.toHaveBeenCalled()
  })
})
