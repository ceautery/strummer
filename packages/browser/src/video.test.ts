import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { finalizeVideo } from './video.js'

describe('finalizeVideo — store a recorded webm by handle', () => {
  let dir: string
  let store: ArtifactStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strummer-video-'))
    store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'strummer-video-store-')))
  })
  afterEach(() => {
    // store/dir are temp; leave cleanup to the OS (tests are isolated by mkdtemp).
  })

  it('reads the webm, stores it by the run/video handle, removes the temp file', async () => {
    const videoPath = join(dir, 'abc123.webm')
    writeFileSync(videoPath, Buffer.from('fake-webm-bytes'))

    const summary = await finalizeVideo({ videoPath, runId: 'run-1', store })

    expect(summary).toBeDefined()
    expect(summary?.handle).toBe('strummer://browser/run/run-1/video')
    expect(summary?.contentType).toBe('video/webm')
    expect(summary?.byteSize).toBe(Buffer.from('fake-webm-bytes').byteLength)
    // the artifact is retrievable as the raw bytes (video is unredactable pixels)
    const artifact = store.get(summary?.handle ?? '')
    expect(artifact?.body.toString('utf8')).toBe('fake-webm-bytes')
    expect(artifact?.contentType).toBe('video/webm')
    // the temp recording is removed — the store owns the canonical copy
    expect(existsSync(videoPath)).toBe(false)
  })

  it('returns undefined when the video file is absent (recording disabled / never written)', async () => {
    const summary = await finalizeVideo({
      videoPath: join(dir, 'missing.webm'),
      runId: 'run-2',
      store,
    })
    expect(summary).toBeUndefined()
  })
})
