#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { type Filter, type Todo, TodoList } from './todo.ts'

const STORE = 'todos.json'

function load(): TodoList {
  if (!existsSync(STORE)) {
    return new TodoList()
  }
  const saved = JSON.parse(readFileSync(STORE, 'utf8')) as Todo[]
  return new TodoList(saved)
}

function save(list: TodoList): void {
  writeFileSync(STORE, `${JSON.stringify(list.toJSON(), null, 2)}\n`)
}

function print(todos: Todo[]): void {
  if (todos.length === 0) {
    console.log('(no todos)')
    return
  }
  for (const t of todos) {
    console.log(`${t.done ? '[x]' : '[ ]'} #${t.id} ${t.title}`)
  }
}

function main(argv: string[]): number {
  const [command, ...rest] = argv
  const list = load()

  switch (command) {
    case 'add': {
      const title = rest.join(' ').trim()
      if (!title) {
        console.error('usage: add <title>')
        return 1
      }
      const todo = list.add(title)
      save(list)
      console.log(`added #${todo.id} ${todo.title}`)
      return 0
    }
    case 'ls': {
      let which: Filter = 'all'
      if (rest.includes('--active')) {
        which = 'active'
      } else if (rest.includes('--completed')) {
        which = 'completed'
      }
      print(list.filter(which))
      return 0
    }
    case 'done': {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        console.error('usage: done <id>')
        return 1
      }
      list.toggle(id)
      save(list)
      print(list.all())
      return 0
    }
    case 'rm': {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        console.error('usage: rm <id>')
        return 1
      }
      list.remove(id)
      save(list)
      print(list.all())
      return 0
    }
    default:
      console.error('usage: todo <add|ls|done|rm> [args]')
      console.error('  ls [--active|--completed]')
      return 1
  }
}

process.exit(main(process.argv.slice(2)))
