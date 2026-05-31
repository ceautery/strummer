import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { run } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../../fixtures/golden.sqlite')

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

describe('cli run', () => {
  it('versions lists indexed versions', async () => {
    const c = capture()
    expect(await run(['versions', 'react', '--index', FIXTURE], c.io)).toBe(0)
    expect(c.out()).toContain('19.0')
  })

  it('search finds a fragment (FTS-only, no embedder)', async () => {
    const c = capture()
    expect(await run(['search', 'useState', '--library', 'react', '--index', FIXTURE], c.io)).toBe(
      0,
    )
    expect(c.out()).toContain('useState')
    expect(c.out()).toContain('strummer://doc/')
  })

  it('search --json emits structured output', async () => {
    const c = capture()
    await run(['search', 'useState', '--index', FIXTURE, '--json'], c.io)
    const parsed = JSON.parse(c.out())
    expect(parsed.results[0].symbol).toBe('useState')
  })

  it('get prints the full body', async () => {
    const c = capture()
    expect(await run(['get', '1', '--index', FIXTURE], c.io)).toBe(0)
    expect(c.out()).toContain('state variable')
  })

  it('errors without an index', async () => {
    const c = capture()
    expect(await run(['versions', 'react'], c.io)).toBe(1)
    expect(c.err()).toContain('no index')
  })

  it('unknown command returns non-zero', async () => {
    const c = capture()
    expect(await run(['frobnicate'], c.io)).toBe(1)
  })
})
