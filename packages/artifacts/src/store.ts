import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Artifact {
  /** Absolute path of the artifact on disk. */
  path: string
  contentType: string
  byteSize: number
  /** Hex SHA-256 of the bytes — lets a consumer verify/cache by content. */
  sha256: string
}

/**
 * On-disk-backed store for verification artifacts (traces, screenshots, video,
 * HAR, audit reports, changelog diffs, coverage reports…), addressed by a
 * `strummer://<prefix>/<id>/<kind>` handle. Artifacts are large/binary, so they
 * are written to disk and returned by handle — never inlined into a tool result.
 *
 * The handle `prefix` is **parameterized** so each pillar emits its own handle
 * space over one shared store (`browser/run` → `strummer://browser/run/<id>/<kind>`;
 * `deps` → `strummer://deps/<id>/<kind>`). Extracted from the browser pillar per
 * ADR 0010; a persistent/remote backend can replace this later — the handle
 * contract stays the same.
 */
export class ArtifactStore {
  private artifacts = new Map<string, Artifact>()

  /**
   * @param baseDir on-disk root for stored artifact bytes (created if absent).
   * @param prefix the handle namespace between `strummer://` and `/<id>/<kind>`.
   */
  constructor(
    private readonly baseDir: string,
    private readonly prefix: string,
  ) {
    mkdirSync(baseDir, { recursive: true })
  }

  /** The handle a (`runId`, `kind`) pair maps to — reconstruct without re-storing. */
  handleFor(runId: string, kind: string): string {
    return `strummer://${this.prefix}/${runId}/${kind}`
  }

  /** Persist `body` under run `runId` as artifact `kind`; returns its handle. */
  put(runId: string, kind: string, body: string | Buffer, contentType: string): string {
    const handle = this.handleFor(runId, kind)
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
  get(handle: string): (Artifact & { body: Buffer }) | undefined {
    const meta = this.artifacts.get(handle)
    if (!meta) return undefined
    return { ...meta, body: readFileSync(meta.path) }
  }
}
