/**
 * CVSS base-score computation — the pure math behind deriving a severity bucket from a
 * CVSS vector when an OSV advisory carries no qualitative `database_specific.severity`
 * string (OSV stores the vector string, not a number). Implements the **CVSS v3.0/v3.1
 * base score** per the first.org specification (the metric weights + the official
 * `Roundup`); v2 and v4 vectors return `undefined` (their formulas differ — v4 is a
 * lookup-table model — and v3 dominates GHSA/OSV data, so they bucket as `unknown`).
 *
 * No dependency: the v3 base formula is fully specified and verified here against the
 * specification's published example vectors, which keeps the deps core pure/offline.
 */

// Base-metric weights (CVSS v3.1 spec §7.4). Privileges-Required depends on Scope.
const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }
const AC: Record<string, number> = { L: 0.77, H: 0.44 }
const UI: Record<string, number> = { N: 0.85, R: 0.62 }
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 }
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 }
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 }

/** Parse a `CVSS:.../K:V/K:V` vector into a metric map (no validation of values). */
function parseVector(vector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of vector.split('/')) {
    const [key, value] = part.split(':')
    if (key !== undefined && value !== undefined) out[key] = value
  }
  return out
}

/**
 * The CVSS `Roundup` function (v3.1 spec §Appendix A): the smallest number, to one
 * decimal place, that is greater than or equal to the input. Integer-arithmetic form
 * to dodge binary-float rounding error.
 */
function roundUp1(input: number): number {
  const scaled = Math.round(input * 100000)
  if (scaled % 10000 === 0) return scaled / 100000
  return (Math.floor(scaled / 10000) + 1) / 10
}

/**
 * Compute the CVSS v3.0/v3.1 base score from a vector string, or `undefined` if the
 * vector is not v3 or is missing a required base metric (AV/AC/PR/UI/S/C/I/A).
 */
export function cvssV3BaseScore(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//.test(vector)) return undefined
  const m = parseVector(vector)
  const scope = m.S
  if (
    m.AV === undefined ||
    m.AC === undefined ||
    m.PR === undefined ||
    m.UI === undefined ||
    (scope !== 'U' && scope !== 'C') ||
    m.C === undefined ||
    m.I === undefined ||
    m.A === undefined
  ) {
    return undefined
  }
  const av = AV[m.AV]
  const ac = AC[m.AC]
  const ui = UI[m.UI]
  const pr = (scope === 'U' ? PR_UNCHANGED : PR_CHANGED)[m.PR]
  const c = CIA[m.C]
  const i = CIA[m.I]
  const a = CIA[m.A]
  if (
    av === undefined ||
    ac === undefined ||
    ui === undefined ||
    pr === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined
  ) {
    return undefined
  }

  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impact = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
  if (impact <= 0) return 0
  const exploitability = 8.22 * av * ac * pr * ui
  const raw = scope === 'U' ? impact + exploitability : 1.08 * (impact + exploitability)
  return roundUp1(Math.min(raw, 10))
}
