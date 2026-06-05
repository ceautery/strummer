import { readFileSync, unlinkSync } from 'node:fs'
import type { ArtifactStore } from './artifacts.js'

/**
 * Video capture for the browser pillar (ROADMAP Phase 3; ADR 0006). When a context
 * is created with `recordVideo`, Playwright records a `.webm` per page and writes
 * it **on context close** (the same after-close timing as the HAR). Playwright
 * auto-names the file inside the operator's video dir, so the path is resolved from
 * the page's `Video` object (`page.video().path()`) rather than a deterministic name.
 *
 * A video is **unredactable pixels** — a secret rendered in the DOM would be visible
 * in the frames — so, exactly like a screenshot or the trace.zip, video capture is
 * **operator-gated off by default** and the bytes are stored verbatim (no redaction
 * pass) and only ever surfaced by **handle**, never inlined.
 */

/** A finished video capture, returned by handle with a compact summary. */
export interface VideoSummary {
  /** `sackville://browser/run/<id>/video` — the recorded webm, by handle. */
  handle: string
  byteSize: number
  contentType: 'video/webm'
}

export interface FinalizeVideoOptions {
  /** Path Playwright wrote the `.webm` to (from `page.video().path()`). */
  videoPath: string
  /** Run id used to key the stored artifact. */
  runId: string
  store: ArtifactStore
}

/**
 * Finalize a recorded video: read the `.webm` Playwright wrote on context close,
 * store it by handle, return a compact summary, and remove the temp recording (the
 * store owns the canonical copy). Returns `undefined` when no file is present
 * (recording was disabled, or Playwright had not flushed one).
 */
export async function finalizeVideo(opts: FinalizeVideoOptions): Promise<VideoSummary | undefined> {
  let bytes: Buffer
  try {
    bytes = readFileSync(opts.videoPath)
  } catch {
    return undefined
  }
  const handle = opts.store.put(opts.runId, 'video', bytes, 'video/webm')

  // Drop the temp recording — the store now holds the canonical copy.
  try {
    unlinkSync(opts.videoPath)
  } catch {
    // already gone; nothing to clean up
  }

  return { handle, byteSize: bytes.byteLength, contentType: 'video/webm' }
}
