import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runnerEnv } from './spawn.js'

describe('runnerEnv — prepends the project-local node_modules/.bin to PATH', () => {
  it('puts <cwd>/node_modules/.bin first so a project-local vitest/pytest/stryker is found', () => {
    const env = runnerEnv('/abs/repo', { PATH: '/usr/bin' })
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(env.PATH).toBe(`${join('/abs/repo', 'node_modules', '.bin')}${sep}/usr/bin`)
  })

  it('works when PATH is unset and never mutates the input env', () => {
    const input = { FOO: 'bar' } as NodeJS.ProcessEnv
    const env = runnerEnv('/abs/repo', input)
    expect(env.PATH).toBe(join('/abs/repo', 'node_modules', '.bin'))
    expect(env.FOO).toBe('bar')
    expect(input.PATH).toBeUndefined()
  })
})
