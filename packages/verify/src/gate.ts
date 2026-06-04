/**
 * The gate-denial brand (ADR 0013 Addendum, milestone 5c — "compose, never widen").
 *
 * A run-driving pillar can reject for two very different reasons: its **own**
 * operator gate denied the run (the pillar was never executed — `skipReason:
 * 'gate-not-set'`), or it ran and **crashed** (`errorReason`). The orchestrator must
 * tell them apart, but it must NOT import any engine runtime to do so (the
 * spawn-free invariant, § gate (e)). So the contract is a structural brand carried
 * on the error itself, keyed by a GLOBAL symbol — `Symbol.for(...)` resolves to the
 * same symbol in every package WITHOUT a shared import, so each pillar's own
 * `*GateError` (and the surface's no-fetcher / no-DB checks) can set it and the
 * orchestrator can read it with zero coupling.
 *
 * This reuses each pillar's REAL gate decision (`assertAllowed`) — there is no
 * reimplemented gate predicate here to drift out of sync.
 */
export const GATE_DENIAL: unique symbol = Symbol.for('strummer.gate-denial')

/** True when `reason` is branded as a pillar gate DENIAL (not a runtime failure). */
export function isGateDenial(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as Record<symbol, unknown>)[GATE_DENIAL] === true
  )
}

/**
 * Mint a gate-denial error. Used by the surface for an unmet gate that does NOT
 * surface as a pillar `*GateError` — e.g. deps with network off (no packument
 * fetcher) or flake with no history DB configured. Both must read as
 * `skipReason:'gate-not-set'`, never `errored` (ADR 0013 Addendum § execution).
 */
export function gateDenied(message: string): Error {
  const err = new Error(message)
  ;(err as unknown as Record<symbol, unknown>)[GATE_DENIAL] = true
  return err
}
