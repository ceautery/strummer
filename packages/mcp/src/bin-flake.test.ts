import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFlakeServerFromEnv } from './bin-flake.js'

describe('sackville-flake-mcp bin config (operator env)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sackville-flake-bin-'))
    dbPath = join(dir, 'history.db')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('requires SACKVILLE_FLAKE_DB', () => {
    expect(() => buildFlakeServerFromEnv({})).toThrow(/SACKVILLE_FLAKE_DB/)
  })

  it('defaults both gates off (read-only) when only the DB is set', () => {
    const { server, store, config } = buildFlakeServerFromEnv({ SACKVILLE_FLAKE_DB: dbPath })
    expect(config).toEqual({
      dbPath,
      allowRun: false,
      allowedRoots: [],
      timeoutMs: undefined,
      allowQuarantine: false,
      maxExpiryMs: 0,
    })
    expect(server).toBeDefined()
    store.close()
  })

  it('parses the run gate and the quarantine gate independently', () => {
    const { store, config } = buildFlakeServerFromEnv({
      SACKVILLE_FLAKE_DB: dbPath,
      SACKVILLE_FLAKE_ALLOW_RUN: 'true',
      SACKVILLE_FLAKE_PROJECT_ROOTS: '/abs/a, /abs/b ,',
      SACKVILLE_FLAKE_TIMEOUT_MS: '300000',
      SACKVILLE_FLAKE_ALLOW_QUARANTINE: 'yes',
      SACKVILLE_FLAKE_MAX_EXPIRY_MS: '604800000',
    })
    expect(config.allowRun).toBe(true)
    expect(config.allowedRoots).toEqual(['/abs/a', '/abs/b'])
    expect(config.timeoutMs).toBe(300000)
    expect(config.allowQuarantine).toBe(true)
    expect(config.maxExpiryMs).toBe(604800000)
    store.close()
  })

  it('opens a working, persistent history store at the configured path', () => {
    const a = buildFlakeServerFromEnv({ SACKVILLE_FLAKE_DB: dbPath })
    a.store.recordRun({ testId: 't', passed: false, at: '2026-06-01T00:00:00Z' })
    a.store.close()
    const b = buildFlakeServerFromEnv({ SACKVILLE_FLAKE_DB: dbPath })
    expect(b.store.history('t').runs).toHaveLength(1)
    b.store.close()
  })
})
