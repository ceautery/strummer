#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { freeSlots } from './availability.ts'
import type { Booking } from './booking.ts'
import { formatBooking, formatInterval, parseTime } from './format.ts'
import { Schedule } from './schedule.ts'

const STORE = 'schedule.json'

function load(): Schedule {
  if (!existsSync(STORE)) {
    return new Schedule()
  }
  return new Schedule(JSON.parse(readFileSync(STORE, 'utf8')) as Booking[])
}

function save(schedule: Schedule): void {
  writeFileSync(STORE, `${JSON.stringify(schedule.all(), null, 2)}\n`)
}

function main(argv: string[]): number {
  const [command, ...rest] = argv
  const schedule = load()

  switch (command) {
    case 'book': {
      const [room, start, end, ...titleParts] = rest
      const title = titleParts.join(' ').trim()
      if (!room || !start || !end || !title) {
        console.error('usage: book <room> <start HH:MM> <end HH:MM> <title>')
        return 1
      }
      try {
        const booking = schedule.book(room, title, {
          start: parseTime(start),
          end: parseTime(end),
        })
        save(schedule)
        console.log(`booked ${formatBooking(booking)}`)
        return 0
      } catch (e) {
        console.error(`could not book: ${(e as Error).message}`)
        return 1
      }
    }
    case 'ls': {
      const all = schedule.all()
      if (all.length === 0) {
        console.log('(no bookings)')
        return 0
      }
      for (const b of all) {
        console.log(formatBooking(b))
      }
      return 0
    }
    case 'cancel': {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        console.error('usage: cancel <id>')
        return 1
      }
      schedule.cancel(id)
      save(schedule)
      console.log(`cancelled #${id}`)
      return 0
    }
    case 'conflicts': {
      const pairs = schedule.conflicts()
      if (pairs.length === 0) {
        console.log('no conflicts')
        return 0
      }
      for (const [a, b] of pairs) {
        console.log(`#${a.id} ✕ #${b.id}  (${a.room})`)
      }
      return 1
    }
    case 'free': {
      const [room, start, end] = rest
      if (!room || !start || !end) {
        console.error('usage: free <room> <start HH:MM> <end HH:MM>')
        return 1
      }
      const slots = freeSlots(schedule.all(), room, {
        start: parseTime(start),
        end: parseTime(end),
      })
      if (slots.length === 0) {
        console.log('(no free slots)')
        return 0
      }
      for (const s of slots) {
        console.log(formatInterval(s))
      }
      return 0
    }
    default:
      console.error('usage: roomctl <book|ls|cancel|conflicts|free> [args]')
      console.error('  book <room> <start> <end> <title>   reserve a room (HH:MM times)')
      console.error('  free <room> <start> <end>           show bookable gaps')
      return 1
  }
}

process.exit(main(process.argv.slice(2)))
