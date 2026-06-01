/**
 * Quarantine — the only flake surface that **writes**, and therefore the one with teeth.
 *
 * Quarantining a test tells the gate to tolerate its failure for a bounded window. That
 * is exactly the capability an agent could abuse to turn a red suite green, so per ADR
 * 0010 it sits behind the house **paired deny-by-default operator gate**, adapted to this
 * surface: the pair is `allowQuarantine` (the boolean) + `maxExpiryMs` (the load-bearing
 * bound — a zero/absent cap denies every write even when the boolean is set, and an
 * **expiry is mandatory** so a quarantine can never be permanent). Both are operator-set;
 * no caller input can self-authorize, lengthen past the cap (we fail loud rather than
 * silently clamp), or make a quarantine open-ended.
 *
 * Reads (`isQuarantined`/`active`/`all`) and `release` are ungated: an expired quarantine
 * is automatically inactive, and releasing a test only ever makes the gate stricter.
 */

import type Database from 'better-sqlite3'
import type { FlakeVerdict } from './classify.js'
import type { HistoryStore } from './store.js'

/** Thrown when the paired operator gate denies a quarantine write. */
export class QuarantineGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuarantineGateError'
  }
}

/** Operator-set quarantine policy (the paired gate). */
export interface QuarantinePolicy {
  /** OPERATOR opt-in to allow quarantine writes. Deny-by-default. */
  allowQuarantine: boolean
  /**
   * OPERATOR cap on quarantine duration (ms from `quarantinedAt`). Load-bearing: a
   * zero/non-positive cap denies every write even with `allowQuarantine`, and a request
   * whose expiry exceeds it is refused (never silently clamped).
   */
  maxExpiryMs: number
}

export interface QuarantineRequest {
  testId: string
  /** Why it is quarantined — mandatory, non-empty (audit trail). */
  reason: string
  /** ISO expiry; mandatory, must be in the future and within `maxExpiryMs` of `now`. */
  expiresAt: string
  /** The flakeScore that justified it (for audit/ranking). */
  flakeScore?: number
  /** Reference time; defaults to now. */
  now?: string
}

export interface QuarantineEntry {
  testId: string
  reason: string
  flakeScore: number | null
  quarantinedAt: string
  expiresAt: string
}

interface QRow {
  test_id: string
  reason: string
  flake_score: number | null
  quarantined_at: string
  expires_at: string
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quarantine (
      test_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      flake_score REAL,
      quarantined_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `)
}

function toEntry(r: QRow): QuarantineEntry {
  return {
    testId: r.test_id,
    reason: r.reason,
    flakeScore: r.flake_score,
    quarantinedAt: r.quarantined_at,
    expiresAt: r.expires_at,
  }
}

export class Quarantine {
  private readonly db: Database.Database
  private readonly policy: QuarantinePolicy

  constructor(store: HistoryStore | Database.Database, policy: QuarantinePolicy) {
    this.db = 'database' in store ? store.database : store
    this.policy = policy
    migrate(this.db)
  }

  /** Quarantine a test for a bounded window. Throws {@link QuarantineGateError} on denial. */
  quarantine(req: QuarantineRequest): QuarantineEntry {
    if (!this.policy.allowQuarantine) {
      throw new QuarantineGateError(
        'quarantine writes are not enabled (the operator must set allowQuarantine)',
      )
    }
    if (!(this.policy.maxExpiryMs > 0)) {
      throw new QuarantineGateError(
        'no quarantine expiry bound is configured (operator maxExpiryMs must be > 0)',
      )
    }
    const reason = req.reason.trim()
    if (reason === '') {
      throw new QuarantineGateError('a non-empty quarantine reason is required')
    }
    const now = req.now ?? new Date().toISOString()
    const nowMs = Date.parse(now)
    const expiryMs = Date.parse(req.expiresAt)
    if (Number.isNaN(expiryMs)) {
      throw new QuarantineGateError(`unparseable expiresAt: ${req.expiresAt}`)
    }
    if (expiryMs <= nowMs) {
      throw new QuarantineGateError('expiresAt must be in the future')
    }
    if (expiryMs - nowMs > this.policy.maxExpiryMs) {
      throw new QuarantineGateError(
        `expiry exceeds the operator cap of ${this.policy.maxExpiryMs}ms`,
      )
    }
    this.db
      .prepare(
        `INSERT INTO quarantine (test_id, reason, flake_score, quarantined_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(test_id) DO UPDATE SET
           reason = excluded.reason,
           flake_score = excluded.flake_score,
           quarantined_at = excluded.quarantined_at,
           expires_at = excluded.expires_at`,
      )
      .run(req.testId, reason, req.flakeScore ?? null, now, req.expiresAt)
    return {
      testId: req.testId,
      reason,
      flakeScore: req.flakeScore ?? null,
      quarantinedAt: now,
      expiresAt: req.expiresAt,
    }
  }

  /** Lift a quarantine. Ungated. Returns true if a row was removed. */
  release(testId: string): boolean {
    const info = this.db.prepare('DELETE FROM quarantine WHERE test_id = ?').run(testId)
    return info.changes > 0
  }

  /** Whether a test is currently quarantined (expiry-aware). */
  isQuarantined(testId: string, now: string = new Date().toISOString()): boolean {
    const row = this.db
      .prepare('SELECT expires_at FROM quarantine WHERE test_id = ?')
      .get(testId) as { expires_at: string } | undefined
    return row !== undefined && Date.parse(row.expires_at) > Date.parse(now)
  }

  /** Currently-active (unexpired) quarantines, ordered by expiry. */
  active(now: string = new Date().toISOString()): QuarantineEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM quarantine WHERE expires_at > ? ORDER BY expires_at, test_id')
      .all(now) as QRow[]
    return rows.map(toEntry)
  }

  /** Every quarantine row, including expired ones (audit). */
  all(): QuarantineEntry[] {
    const rows = this.db.prepare('SELECT * FROM quarantine ORDER BY test_id').all() as QRow[]
    return rows.map(toEntry)
  }
}

export interface CandidateOptions {
  /** Only verdicts with `flakeScore >= minFlakeScore` (default 0 — every flaky test). */
  minFlakeScore?: number
}

/**
 * Pure helper: rank quarantine candidates from classifier verdicts — `flaky` tests whose
 * `flakeScore` clears the floor, highest first. Never selects `broken` (a real, consistent
 * failure to FIX, not hide) or `reliable`/`insufficient-data`. The write itself is still
 * gated; this only proposes.
 */
export function quarantineCandidates(
  verdicts: FlakeVerdict[],
  opts: CandidateOptions = {},
): FlakeVerdict[] {
  const floor = opts.minFlakeScore ?? 0
  return verdicts
    .filter((v) => v.state === 'flaky' && v.flakeScore >= floor)
    .sort((a, b) => b.flakeScore - a.flakeScore)
}
