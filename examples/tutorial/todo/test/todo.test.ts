import { describe, expect, it } from 'vitest'
import { TodoList } from '../src/todo.ts'

// This suite passes — yet the app has a bug. That is the whole lesson: a green
// run is not proof. See the tutorial README; `filter('active')` is never asserted
// here, so its defect hides. Sackville's coverage/mutate tools surface the gap.
describe('TodoList', () => {
  it('adds todos as not-done', () => {
    const list = new TodoList()
    const todo = list.add('buy milk')
    expect(todo.done).toBe(false)
    expect(list.all()).toHaveLength(1)
  })

  it('toggles a todo done and back', () => {
    const list = new TodoList()
    const todo = list.add('buy milk')
    list.toggle(todo.id)
    expect(list.all()[0]?.done).toBe(true)
    list.toggle(todo.id)
    expect(list.all()[0]?.done).toBe(false)
  })

  it('removes a todo by id', () => {
    const list = new TodoList()
    const a = list.add('a')
    list.add('b')
    list.remove(a.id)
    expect(list.all().map((t) => t.title)).toEqual(['b'])
  })

  it('lists all todos', () => {
    const list = new TodoList()
    list.add('a')
    list.add('b')
    expect(list.filter('all')).toHaveLength(2)
  })

  it('filters completed todos', () => {
    const list = new TodoList()
    const a = list.add('a')
    list.add('b')
    list.toggle(a.id)
    expect(list.filter('completed').map((t) => t.title)).toEqual(['a'])
  })

  // Missing: a test for filter('active'). Adding it is part of the tutorial.
})
