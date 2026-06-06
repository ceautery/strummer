import type { Booking } from './booking.ts'
import { type Interval, overlaps } from './interval.ts'

/**
 * The gaps within `window` for `room` that no booking occupies — the bookable
 * free slots. Bookings in another room, or entirely outside the window, are
 * ignored.
 */
export function freeSlots(bookings: Booking[], room: string, window: Interval): Interval[] {
  const busy = bookings
    .filter((b) => b.room === room && overlaps(b.interval, window))
    .map((b) => b.interval)
    .sort((a, b) => a.start - b.start)

  const slots: Interval[] = []
  let cursor = window.start
  for (const b of busy) {
    if (b.start > cursor) {
      slots.push({ start: cursor, end: Math.min(b.start, window.end) })
    }
    cursor = Math.max(cursor, b.end)
  }
  if (cursor < window.end) {
    slots.push({ start: cursor, end: window.end })
  }
  return slots
}
