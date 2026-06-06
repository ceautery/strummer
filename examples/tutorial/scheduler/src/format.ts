import type { Booking } from './booking.ts'
import type { Interval } from './interval.ts'

/** Parse an `HH:MM` clock time into minutes since midnight. */
export function parseTime(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m?.[1] || !m[2]) {
    throw new Error(`bad time "${hhmm}" (expected HH:MM)`)
  }
  const hours = Number(m[1])
  const mins = Number(m[2])
  if (hours > 23 || mins > 59) {
    throw new Error(`bad time "${hhmm}" (out of range)`)
  }
  return hours * 60 + mins
}

/** Render minutes-since-midnight back as `HH:MM`. */
export function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

/** Render an interval as `HH:MM–HH:MM`. */
export function formatInterval(i: Interval): string {
  return `${formatTime(i.start)}–${formatTime(i.end)}`
}

/** A one-line human description of a booking. */
export function formatBooking(b: Booking): string {
  return `#${b.id} ${b.room}  ${formatInterval(b.interval)}  ${b.title}`
}
