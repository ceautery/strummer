/**
 * OSV snapshot loading — read an operator-provisioned on-disk OSV database and parse
 * it into advisories that `matchVulnerabilities` can evaluate. This is the offline
 * data seam: the operator provisions the snapshot out-of-band, and Strummer queries
 * it with **zero network** (network fetching of `all.zip` is a separate, operator-
 * gated slice).
 *
 * Layout mirrors the OSV bucket
 * (`osv-vulnerabilities.storage.googleapis.com/<ECOSYSTEM>/all.zip`): the snapshot
 * directory holds one `all.zip` per ecosystem at `<dir>/<ecosystem>/all.zip`, each
 * zip containing one advisory JSON per entry. We unzip and parse it ourselves (no
 * external `osv-scanner` subprocess).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type { OsvAdvisory } from './osv.js'

export interface OsvSnapshot {
  ecosystem: string
  advisories: OsvAdvisory[]
  /**
   * Staleness proxy: the newest advisory `modified` timestamp (RFC3339) in the
   * snapshot, or `undefined` if none carry one. Callers must surface this so "no
   * known vulnerabilities" is never mistaken for an authoritative, up-to-date answer.
   */
  snapshotDate?: string
}

/**
 * Load the OSV advisories for `ecosystem` from the snapshot directory `dir`. Throws
 * if the ecosystem's `all.zip` is absent (an operator-provisioning error — fail loud
 * rather than silently report zero vulnerabilities). Advisories are returned sorted
 * by `id` for stable, deterministic output.
 */
export function loadOsvSnapshot(dir: string, ecosystem: string): OsvSnapshot {
  const zipPath = join(dir, ecosystem, 'all.zip')
  if (!existsSync(zipPath)) {
    throw new Error(`OSV snapshot not found for ecosystem "${ecosystem}" at ${zipPath}`)
  }

  const entries = unzipSync(readFileSync(zipPath))
  const advisories: OsvAdvisory[] = []
  let snapshotDate: string | undefined
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.endsWith('.json')) continue
    const advisory = JSON.parse(strFromU8(bytes)) as OsvAdvisory
    advisories.push(advisory)
    if (
      advisory.modified !== undefined &&
      (snapshotDate === undefined || advisory.modified > snapshotDate)
    ) {
      snapshotDate = advisory.modified
    }
  }

  advisories.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { ecosystem, advisories, snapshotDate }
}
