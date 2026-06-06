import { describe, expect, it } from 'vitest'
import { freeSlots } from '../src/availability.ts'
import { minutes, overlaps } from '../src/interval.ts'
import { Schedule } from '../src/schedule.ts'

// This suite passes — yet the scheduler has a bug. That is the whole lesson: a
// green run is not proof. The tests below check intervals that clearly overlap
// and intervals that clearly don't, but never the *boundary* case where one
// booking ends exactly when the next begins. So the defect at that boundary
// hides. Sackville's mutate (and the docs) surface the gap. See the README.

describe('interval', () => {
  it('measures length in minutes', () => {
    expect(minutes({ start: 540, end: 600 })).toBe(60)
  })

  it('detects intervals that clearly overlap', () => {
    expect(overlaps({ start: 540, end: 600 }, { start: 570, end: 630 })).toBe(true)
  })

  it('detects intervals that clearly do not overlap', () => {
    expect(overlaps({ start: 540, end: 600 }, { start: 660, end: 720 })).toBe(false)
  })

  // Missing: a test for the boundary case — two intervals that touch
  // (one ends at the exact minute the other starts). Adding it is the tutorial.
})

describe('Schedule', () => {
  it('books a free room', () => {
    const schedule = new Schedule()
    const b = schedule.book('Oak', 'standup', { start: 540, end: 600 })
    expect(b.id).toBe(1)
    expect(schedule.all()).toHaveLength(1)
  })

  it('rejects a booking that clearly overlaps an existing one', () => {
    const schedule = new Schedule()
    schedule.book('Oak', 'standup', { start: 540, end: 600 })
    expect(() => schedule.book('Oak', 'sync', { start: 570, end: 630 })).toThrow(/conflict/)
  })

  it('allows the same time in a different room', () => {
    const schedule = new Schedule()
    schedule.book('Oak', 'standup', { start: 540, end: 600 })
    expect(() => schedule.book('Elm', 'sync', { start: 540, end: 600 })).not.toThrow()
  })

  it('cancels a booking by id', () => {
    const schedule = new Schedule()
    const b = schedule.book('Oak', 'standup', { start: 540, end: 600 })
    schedule.cancel(b.id)
    expect(schedule.all()).toHaveLength(0)
  })

  it('reports a clearly-overlapping pair as a conflict', () => {
    const schedule = new Schedule([
      { id: 1, room: 'Oak', title: 'a', interval: { start: 540, end: 600 } },
      { id: 2, room: 'Oak', title: 'b', interval: { start: 570, end: 630 } },
    ])
    expect(schedule.conflicts()).toHaveLength(1)
  })
})

describe('freeSlots', () => {
  it('returns the gaps around a booking', () => {
    const bookings = [{ id: 1, room: 'Oak', title: 'a', interval: { start: 600, end: 660 } }]
    expect(freeSlots(bookings, 'Oak', { start: 540, end: 720 })).toEqual([
      { start: 540, end: 600 },
      { start: 660, end: 720 },
    ])
  })
})
