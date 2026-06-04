import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

export interface Artifact {
  /** Absolute path of the artifact on disk. */
  path: string
  contentType: string
  byteSize: number
  /** Hex SHA-256 of the bytes — lets a consumer verify/cache by content. */
  sha256: string
  /**
   * True when `contentType` could not be recovered (a legacy artifact rehydrated
   * with no `<kind>.meta.json` sidecar) and was defaulted to
   * `application/octet-stream` — never a silent failure (ADR 0013 §4).
   */
  contentTypeInferred?: boolean
}

/** A handle parsed into its on-disk-addressing parts. */
interface ParsedHandle {
  /** The handle namespace (may contain `/`, e.g. `browser/run`). */
  prefix: string
  id: string
  kind: string
}

/**
 * A single safe path segment: an agent-supplied `id`/`kind` (or a prefix segment
 * parsed out of a foreign handle) may only contain these characters and is never
 * `.`/`..` — so it cannot traverse, separate, or escape. Mirrors the `safeId`
 * allowlist the deps surface uses (`packages/mcp/src/deps.ts`).
 */
function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value)
}

function assertSafeSegment(value: string, what: string): void {
  if (!isSafeSegment(value)) {
    throw new Error(`ArtifactStore: unsafe ${what} segment ${JSON.stringify(value)}`)
  }
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
 *
 * The on-disk layout is `<baseDir>/<prefix>/<id>/<kind>` — the prefix lives IN the
 * path (ADR 0013 slice 1), so one shared `baseDir` is collision-free across pillars
 * and a store can **rehydrate a foreign-prefix handle** it never `put()` itself
 * (the cross-pillar verify read). Because a rehydrate is a filesystem read
 * addressed by an agent-supplied string, every segment is allowlist-validated and
 * the resolved path is realpath-confined under `baseDir`.
 */
export class ArtifactStore {
  private artifacts = new Map<string, Artifact>()

  /**
   * @param baseDir on-disk root for stored artifact bytes (created if absent).
   * @param prefix the handle namespace between `strummer://` and `/<id>/<kind>`
   *   (may contain `/`, e.g. `browser/run`); each segment must be a safe segment.
   */
  constructor(
    private readonly baseDir: string,
    private readonly prefix: string,
  ) {
    for (const seg of prefix.split('/')) assertSafeSegment(seg, 'prefix')
    mkdirSync(baseDir, { recursive: true })
  }

  /** The handle a (`runId`, `kind`) pair maps to — reconstruct without re-storing. */
  handleFor(runId: string, kind: string): string {
    return `strummer://${this.prefix}/${runId}/${kind}`
  }

  /** Persist `body` under run `runId` as artifact `kind`; returns its handle. */
  put(runId: string, kind: string, body: string | Buffer, contentType: string): string {
    assertSafeSegment(runId, 'id')
    assertSafeSegment(kind, 'kind')
    const handle = this.handleFor(runId, kind)
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    const dir = join(this.baseDir, this.prefix, runId)
    mkdirSync(dir, { recursive: true })
    this.assertConfined(dir)
    const path = join(dir, kind)
    writeFileSync(path, buf)
    // Sidecar so a cold-process rehydrate recovers contentType (not inferable
    // from raw bytes). One per artifact: `<kind>.meta.json`.
    writeFileSync(`${path}.meta.json`, JSON.stringify({ contentType }))
    this.artifacts.set(handle, {
      path,
      contentType,
      byteSize: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
    })
    return handle
  }

  /**
   * Resolve a handle to its metadata + bytes, or `undefined` if no such artifact
   * exists. A handle this store `put()` resolves from the in-process map; any other
   * well-formed handle is **rehydrated from disk** by its own prefix/id/kind.
   * Throws on a malformed/unsafe handle (a traversal or separator in a segment).
   */
  get(handle: string): (Artifact & { body: Buffer }) | undefined {
    const meta = this.artifacts.get(handle)
    if (meta) return { ...meta, body: readFileSync(meta.path) }

    const { prefix, id, kind } = this.parseHandle(handle)
    const path = join(this.baseDir, prefix, id, kind)
    if (!existsSync(path)) return undefined
    this.assertConfined(path)
    const buf = readFileSync(path)
    const { contentType, contentTypeInferred } = this.readSidecar(path)
    return {
      path,
      contentType,
      contentTypeInferred,
      byteSize: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
      body: buf,
    }
  }

  /** Parse `strummer://<prefix>/<id>/<kind>`; validate every segment. */
  private parseHandle(handle: string): ParsedHandle {
    const rest = handle.startsWith('strummer://') ? handle.slice('strummer://'.length) : undefined
    if (rest === undefined) throw new Error(`ArtifactStore: not a strummer:// handle: ${handle}`)
    const parts = rest.split('/')
    if (parts.length < 3) throw new Error(`ArtifactStore: malformed handle: ${handle}`)
    const kind = parts.pop() as string
    const id = parts.pop() as string
    assertSafeSegment(id, 'id')
    assertSafeSegment(kind, 'kind')
    for (const seg of parts) assertSafeSegment(seg, 'prefix')
    return { prefix: parts.join('/'), id, kind }
  }

  private readSidecar(path: string): { contentType: string; contentTypeInferred?: boolean } {
    const sidecar = `${path}.meta.json`
    if (!existsSync(sidecar))
      return { contentType: 'application/octet-stream', contentTypeInferred: true }
    try {
      const parsed = JSON.parse(readFileSync(sidecar, 'utf8')) as { contentType?: unknown }
      if (typeof parsed.contentType === 'string' && parsed.contentType.length > 0) {
        return { contentType: parsed.contentType }
      }
    } catch {
      // fall through to the inferred default below
    }
    return { contentType: 'application/octet-stream', contentTypeInferred: true }
  }

  /**
   * Realpath-confine `path` under `baseDir` — defends against a symlinked
   * prefix/id dir escaping the store root even though every segment is allowlisted
   * (the same realpath posture the LSP write-mode confinement uses).
   */
  private assertConfined(path: string): void {
    const root = realpathSync(this.baseDir)
    const resolved = realpathSync(path)
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`ArtifactStore: path escapes baseDir: ${path}`)
    }
  }
}
