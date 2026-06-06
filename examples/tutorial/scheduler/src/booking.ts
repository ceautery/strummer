import type { Interval } from './interval.ts'

/** A reservation of a room for a time interval. */
export interface Booking {
  id: number
  room: string
  title: string
  interval: Interval
}
