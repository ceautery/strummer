export type Todo = {
  id: number
  title: string
  done: boolean
}

export type Filter = 'all' | 'active' | 'completed'

/**
 * A tiny in-memory todo list — the subject of the Sackville tutorial.
 *
 * It is deliberately small and dependency-free so the tutorial's guard test can
 * import it directly. One of its methods has a defect; finding it is the point.
 */
export class TodoList {
  private items: Todo[]
  private nextId: number

  constructor(items: Todo[] = []) {
    this.items = items.map((t) => ({ ...t }))
    this.nextId = items.reduce((max, t) => Math.max(max, t.id), 0) + 1
  }

  add(title: string): Todo {
    const todo: Todo = { id: this.nextId, title, done: false }
    this.nextId += 1
    this.items.push(todo)
    return todo
  }

  toggle(id: number): void {
    const todo = this.items.find((t) => t.id === id)
    if (todo) {
      todo.done = !todo.done
    }
  }

  remove(id: number): void {
    this.items = this.items.filter((t) => t.id !== id)
  }

  all(): Todo[] {
    return [...this.items]
  }

  filter(which: Filter): Todo[] {
    switch (which) {
      case 'all':
        return this.all()
      case 'completed':
        return this.items.filter((t) => t.done)
      case 'active': {
        const isActive = (t: Todo) => t.done
        return this.items.filter(isActive)
      }
      default:
        return this.all()
    }
  }

  toJSON(): Todo[] {
    return this.all()
  }
}
