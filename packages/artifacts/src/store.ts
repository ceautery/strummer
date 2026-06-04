import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/**
 * Bounds on a store's own `<baseDir>/<prefix>` subtree (ADR 0017). All optional; an
 * unset dimension is not enforced, and a policy with no dimension set is a no-op (so
 * a store with no retention NEVER deletes — fully backward-compatible).
 */
export interface RetentionPolicy {
  /** Evict `<id>` dirs whose mtime is older than `now - maxAgeMs`. */
  maxAgeMs?: number
  /** Keep at most this many `<id>` dirs (newest by mtime). */
  maxEntries?: number
  /** Keep the subtree's total bytes at or under this cap (evict oldest-first). */
  maxBytes?: number
}

/** A sane default throttle for the server bins' opportunistic `put()` sweep — a hot
 * write loop re-scans the subtree at most once a minute, GC stays responsive enough. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

export interface ArtifactStoreOptions {
  /** Retention bounds; absent ⇒ the store is append-only (no GC). */
  retention?: RetentionPolicy
  /** Clock injection (testing / determinism). Default `Date.now`. */
  now?: () => number
  /** Minimum ms between opportunistic `put()`-triggered sweeps. Default 0 (every put). */
  sweepIntervalMs?: number
}

/**
 * Parse a `RetentionPolicy` from raw env strings (each bin's per-pillar
 * `STRUMMER_<PILLAR>_ARTIFACT_MAX_AGE_MS` / `_MAX_ENTRIES` / `_MAX_BYTES`). Returns
 * `undefined` when NONE is set (⇒ no GC — opt-in). A non-numeric or negative value is
 * ignored (treated as unset) so a typo never silently deletes everything.
 */
export function retentionFromEnv(raw: {
  maxAgeMs?: string
  maxEntries?: string
  maxBytes?: string
}): RetentionPolicy | undefined {
  const n = (v: string | undefined): number | undefined => {
    if (!v) return undefined
    const x = Number(v)
    return Number.isFinite(x) && x >= 0 ? x : undefined
  }
  const policy: RetentionPolicy = {}
  const age = n(raw.maxAgeMs)
  const entries = n(raw.maxEntries)
  const bytes = n(raw.maxBytes)
  if (age !== undefined) policy.maxAgeMs = age
  if (entries !== undefined) policy.maxEntries = entries
  if (bytes !== undefined) policy.maxBytes = bytes
  return Object.keys(policy).length > 0 ? policy : undefined
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
  private readonly retention?: RetentionPolicy
  private readonly now: () => number
  private readonly sweepIntervalMs: number
  private lastSweepAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly baseDir: string,
    private readonly prefix: string,
    opts: ArtifactStoreOptions = {},
  ) {
    for (const seg of prefix.split('/')) assertSafeSegment(seg, 'prefix')
    mkdirSync(baseDir, { recursive: true })
    this.retention = opts.retention
    this.now = opts.now ?? Date.now
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 0
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
    this.maybeSweep()
    return handle
  }

  private hasPolicy(): boolean {
    const r = this.retention
    return (
      !!r && (r.maxAgeMs !== undefined || r.maxEntries !== undefined || r.maxBytes !== undefined)
    )
  }

  /** Opportunistic, THROTTLED sweep after a write (ADR 0017): at most once per
   * `sweepIntervalMs` so a hot write loop doesn't re-scan the subtree every put. */
  private maybeSweep(): void {
    if (!this.hasPolicy()) return
    const t = this.now()
    if (t - this.lastSweepAt < this.sweepIntervalMs) return
    this.lastSweepAt = t
    this.sweep(t)
  }

  /**
   * Evict `<id>` dirs under THIS store's own `<baseDir>/<prefix>` subtree per the
   * `RetentionPolicy` — age (`maxAgeMs`) then count (`maxEntries`) then size
   * (`maxBytes`), oldest-first by dir mtime (so a just-written run is evicted last).
   * Disk-based (a cold process's in-process map is empty), confinement-checked before
   * every delete (never deletes THROUGH a symlink escaping `baseDir`), and a no-op when
   * no policy is set. Returns the evicted ids. Public so a bin can sweep on startup.
   */
  sweep(nowMs: number = this.now()): string[] {
    if (!this.hasPolicy()) return []
    const root = join(this.baseDir, this.prefix)
    if (!existsSync(root)) return []
    const r = this.retention as RetentionPolicy

    interface Entry {
      id: string
      dir: string
      mtimeMs: number
      bytes: number
    }
    const entries: Entry[] = []
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = join(root, d.name)
      try {
        const st = statSync(dir)
        let bytes = 0
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (f.isFile()) bytes += statSync(join(dir, f.name)).size
        }
        entries.push({ id: d.name, dir, mtimeMs: st.mtimeMs, bytes })
      } catch {
        // a racing delete / unreadable entry — skip it this pass
      }
    }

    const evict = new Set<string>()
    if (r.maxAgeMs !== undefined) {
      const cut = nowMs - r.maxAgeMs
      for (const e of entries) if (e.mtimeMs < cut) evict.add(e.id)
    }
    // Newest-first survivors drive the count + size caps (oldest evicted first).
    let kept = entries.filter((e) => !evict.has(e.id)).sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (r.maxEntries !== undefined && kept.length > r.maxEntries) {
      for (const e of kept.slice(r.maxEntries)) evict.add(e.id)
      kept = kept.slice(0, r.maxEntries)
    }
    if (r.maxBytes !== undefined) {
      let total = 0
      for (const e of kept) {
        total += e.bytes
        if (total > r.maxBytes) evict.add(e.id)
      }
    }

    const evicted: string[] = []
    for (const e of entries) {
      if (!evict.has(e.id)) continue
      try {
        this.assertConfined(e.dir) // never delete THROUGH a symlink escaping baseDir
      } catch {
        continue
      }
      rmSync(e.dir, { recursive: true, force: true })
      this.dropHandles(e.id)
      evicted.push(e.id)
    }
    return evicted
  }

  /** Forget the in-process handles of an evicted id, so a later `get()` misses → disk
   * (also gone) → `undefined`, never a read of a deleted path. */
  private dropHandles(id: string): void {
    const p = `strummer://${this.prefix}/${id}/`
    for (const key of this.artifacts.keys()) if (key.startsWith(p)) this.artifacts.delete(key)
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
