import type { Booking } from './booking.ts'
import { type Interval, overlaps } from './interval.ts'

/**
 * An in-memory set of room bookings — the subject of the Sackville tutorial.
 *
 * It is deliberately dependency-free so the tutorial's guard test can import it
 * directly. The conflict rule it enforces has a defect; finding it is the point.
 */
export class Schedule {
  private bookings: Booking[]
  private nextId: number

  constructor(bookings: Booking[] = []) {
    this.bookings = bookings.map((b) => ({ ...b, interval: { ...b.interval } }))
    this.nextId = this.bookings.reduce((max, b) => Math.max(max, b.id), 0) + 1
  }

  /**
   * Reserve `room` for `interval`. Throws if it conflicts with an existing
   * booking in the same room.
   */
  book(room: string, title: string, interval: Interval): Booking {
    const clash = this.bookings.find((b) => b.room === room && overlaps(b.interval, interval))
    if (clash) {
      throw new Error(`conflicts with #${clash.id} (${clash.title})`)
    }
    const booking: Booking = { id: this.nextId, room, title, interval }
    this.nextId += 1
    this.bookings.push(booking)
    return booking
  }

  /** Cancel a booking by id (a no-op if there is no such booking). */
  cancel(id: number): void {
    this.bookings = this.bookings.filter((b) => b.id !== id)
  }

  /** Every pair of same-room bookings that overlap. */
  conflicts(): Array<[Booking, Booking]> {
    const pairs: Array<[Booking, Booking]> = []
    for (let i = 0; i < this.bookings.length; i += 1) {
      for (let j = i + 1; j < this.bookings.length; j += 1) {
        const a = this.bookings[i]
        const b = this.bookings[j]
        if (a && b && a.room === b.room && overlaps(a.interval, b.interval)) {
          pairs.push([a, b])
        }
      }
    }
    return pairs
  }

  all(): Booking[] {
    return this.bookings.map((b) => ({ ...b, interval: { ...b.interval } }))
  }
}
