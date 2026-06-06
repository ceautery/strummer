/**
 * A half-open time interval, in minutes since midnight. `{ start, end }` covers
 * `start` up to but *not* including `end` — so `{ start: 540, end: 600 }` is
 * 09:00 up to (not including) 10:00.
 */
export interface Interval {
  start: number
  end: number
}

/** The length of an interval, in minutes. */
export function minutes(i: Interval): number {
  return i.end - i.start
}

/**
 * Whether two intervals overlap — i.e. share at least one minute.
 *
 * Intervals are half-open (see {@link Interval}). The exact behaviour when one
 * interval ends at the very minute another begins is defined by the
 * `scheduler-core` docs — search them if you're unsure.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  if (a.end < b.start || b.end < a.start) {
    return false
  }
  return true
}
