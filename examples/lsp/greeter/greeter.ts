/** A free function the Greeter calls — gives `call-hierarchy` a real caller→callee edge. */
export function hello(name: string): string {
  return `Hello, ${name}!`
}

/** The greeter class — imported and instantiated in `index.ts`. */
export class Greeter {
  constructor(private readonly name: string) {}

  greet(): string {
    return hello(this.name)
  }
}
