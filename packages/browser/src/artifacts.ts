import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BrowserArtifact {
  /** Absolute path of the artifact on disk. */
  path: string
  contentType: string
  byteSize: number
  /** Hex SHA-256 of the bytes — lets a consumer verify/cache by content. */
  sha256: string
}

/**
 * On-disk-backed store for browser-run artifacts, addressed by a
 * `strummer://browser/run/<id>/<kind>` handle. Browser artifacts (traces,
 * screenshots, video, HAR, audit reports) are large/binary, so unlike the API
 * pillar's in-memory body store they are written to disk and returned by handle
 * — never inlined into a tool result. (A persistent/remote backend can replace
 * this later; the handle contract stays the same.)
 */
export class ArtifactStore {
  private artifacts = new Map<string, BrowserArtifact>()

  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true })
  }

  /** Persist `body` under run `runId` as artifact `kind`; returns its handle. */
  put(runId: string, kind: string, body: string | Buffer, contentType: string): string {
    const handle = `strummer://browser/run/${runId}/${kind}`
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    const runDir = join(this.baseDir, runId)
    mkdirSync(runDir, { recursive: true })
    const path = join(runDir, kind)
    writeFileSync(path, buf)
    this.artifacts.set(handle, {
      path,
      contentType,
      byteSize: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
    })
    return handle
  }

  /** Resolve a handle to its metadata + bytes, or `undefined` if unknown. */
  get(handle: string): (BrowserArtifact & { body: Buffer }) | undefined {
    const meta = this.artifacts.get(handle)
    if (!meta) return undefined
    return { ...meta, body: readFileSync(meta.path) }
  }
}
