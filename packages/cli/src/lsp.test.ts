import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LspQueryInput, LspQueryResult, LspRenameResult } from '@strummer/lsp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from './index.js'
import { runLsp } from './lsp.js'

const here = dirname(fileURLToPath(import.meta.url))
const GREETER = resolve(here, '../../../examples/lsp/greeter')

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

const SERVERS = '{"typescript":{"command":"typescript-language-server","args":["--stdio"]}}'

const definitionResult: LspQueryResult = {
  status: 'ok',
  kind: 'definition',
  encoding: 'utf-16',
  serverInfo: { name: 'typescript-language-server', version: '5.3.0' },
  locations: [
    {
      uri: 'file:///proj/src/dep.ts',
      range: { start: { line: 10, column: 14 }, end: { line: 10, column: 19 } },
      mapped: true,
    },
  ],
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strummer-cli-lsp-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('strummer lsp CLI', () => {
  it('languages lists the bound languages (no spawn) + live provenance', async () => {
    const c = capture()
    const code = await runLsp(['languages', '--servers', SERVERS, '--json'], c.io, {
      describeServers: () => [
        {
          language: 'typescript',
          projectRoot: '/proj',
          serverInfo: { name: 'typescript-language-server', version: '5.3.0' },
          capabilities: { definitionProvider: true },
        },
      ],
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(c.out())
    expect(parsed.languages).toEqual(['typescript'])
    expect(parsed.servers[0].serverInfo.version).toBe('5.3.0')
  })

  it('definition prints the resolved location and exits 0', async () => {
    const c = capture()
    const code = await runLsp(
      ['definition', 'typescript', 'src/a.ts', '12', '7', '--project', '/proj'],
      c.io,
      { query: async () => definitionResult },
    )
    expect(code).toBe(0)
    expect(c.out()).toMatch(/src\/dep\.ts/)
    expect(c.out()).toMatch(/10:14/)
  })

  it('passes the parsed query input through to the engine', async () => {
    let seen: LspQueryInput | undefined
    const c = capture()
    await runLsp(['references', 'typescript', 'src/a.ts', '3', '5', '--project', '/proj'], c.io, {
      query: async (input) => {
        seen = input
        return { ...definitionResult, kind: 'references' }
      },
    })
    expect(seen).toMatchObject({
      language: 'typescript',
      file: 'src/a.ts',
      line: 3,
      column: 5,
      kind: 'references',
    })
    // projectRoot is resolved absolute from --project.
    expect(seen?.projectRoot).toMatch(/proj$/)
  })

  it('hover prints the hover value', async () => {
    const c = capture()
    const code = await runLsp(
      ['hover', 'typescript', 'src/a.ts', '1', '1', '--project', '/proj'],
      c.io,
      {
        query: async () => ({
          status: 'ok',
          kind: 'hover',
          encoding: 'utf-16',
          hover: { value: 'const x: number' },
        }),
      },
    )
    expect(code).toBe(0)
    expect(c.out()).toMatch(/const x: number/)
  })

  it('symbols (no position) prints the outline', async () => {
    let seen: LspQueryInput | undefined
    const c = capture()
    const code = await runLsp(['symbols', 'typescript', 'src/a.ts', '--project', '/proj'], c.io, {
      query: async (input) => {
        seen = input
        return {
          status: 'ok',
          kind: 'documentSymbols',
          encoding: 'utf-16',
          symbols: [
            {
              name: 'greet',
              kind: 12,
              kindName: 'Function',
              range: { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } },
            },
          ],
        }
      },
    })
    expect(code).toBe(0)
    expect(seen?.kind).toBe('documentSymbols')
    expect(c.out()).toMatch(/greet/)
    expect(c.out()).toMatch(/Function/)
  })

  it('not_ready status exits 2 (transient — retry)', async () => {
    const c = capture()
    const code = await runLsp(
      ['definition', 'typescript', 'src/a.ts', '1', '1', '--project', '/proj'],
      c.io,
      { query: async () => ({ status: 'not_ready', kind: 'definition', encoding: 'utf-16' }) },
    )
    expect(code).toBe(2)
    expect(c.out() + c.err()).toMatch(/indexing|not_ready|not ready/i)
  })

  it('rename is DRY-RUN by default — prints the preview, applies nothing, exits 0', async () => {
    const preview: LspRenameResult = {
      status: 'ok',
      kind: 'rename',
      applied: false,
      newName: 'renamed',
      fileCount: 1,
      totalEditCount: 2,
      encoding: 'utf-16',
      edits: [
        {
          uri: 'file:///proj/src/a.ts',
          file: 'src/a.ts',
          editCount: 2,
          hunks: [
            {
              range: { start: { line: 1, column: 7 }, end: { line: 1, column: 10 } },
              oldText: 'foo',
              newText: 'renamed',
            },
          ],
        },
      ],
    }
    const c = capture()
    const code = await runLsp(
      ['rename', 'typescript', 'src/a.ts', '1', '7', 'renamed', '--project', '/proj'],
      c.io,
      { rename: async () => preview },
    )
    expect(code).toBe(0)
    expect(c.out()).toMatch(/dry-run|not applied/i)
    expect(c.out()).toMatch(/foo.*renamed|renamed/)
  })

  it('rename surfaces a refusal as exit 1', async () => {
    const c = capture()
    const code = await runLsp(
      ['rename', 'typescript', 'src/a.ts', '1', '7', 'x', '--project', '/proj'],
      c.io,
      {
        rename: async () => ({
          status: 'ok',
          kind: 'rename',
          applied: false,
          refused: 'the symbol is not renameable',
          newName: 'x',
          fileCount: 0,
          totalEditCount: 0,
          encoding: 'utf-16',
          edits: [],
        }),
      },
    )
    expect(code).toBe(1)
    expect(c.err() + c.out()).toMatch(/not renameable/)
  })

  it('navigation is refused without --allow-run (real engine build, no spawn)', async () => {
    // No injected query → the real LspQueryEngine is built; its gate throws before any spawn.
    const c = capture()
    const code = await runLsp(
      ['definition', 'typescript', 'src/a.ts', '1', '1', '--project', dir, '--servers', SERVERS],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.err()).toMatch(/allow-run|not enabled/i)
  })

  it('navigation without a bound registry errors', async () => {
    const c = capture()
    const code = await runLsp(
      ['definition', 'typescript', 'src/a.ts', '1', '1', '--project', dir],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.err()).toMatch(/servers|registry/i)
  })

  it('definition needs <language> <file> <line> <col>', async () => {
    const c = capture()
    expect(
      await runLsp(['definition', 'typescript'], c.io, { query: async () => definitionResult }),
    ).toBe(1)
    expect(c.err()).toMatch(/needs/)
  })

  it('unknown subcommand exits 1 (via top-level run)', async () => {
    const c = capture()
    expect(await run(['lsp', 'frobnicate'], c.io)).toBe(1)
    expect(c.err()).toMatch(/unknown lsp subcommand/)
  })
})

// Guards the shipped greeter example (and its README's line:column coordinates) against
// source drift. Offline only — `languages` never spawns, and the coordinate check just
// slices the source files (no real language server runs in the gate, per ADR 0011).
describe('bundled example greeter project', () => {
  it('languages lists typescript from the example servers.json registry', async () => {
    const servers = readFileSync(join(GREETER, 'servers.json'), 'utf8')
    const c = capture()
    expect(await run(['lsp', 'languages', '--servers', servers, '--json'], c.io)).toBe(0)
    expect(JSON.parse(c.out()).languages).toEqual(['typescript'])
  })

  it("the README's documented positions point at the named identifiers", () => {
    // [file, 1-based line, 1-based column, identifier] — must match the example README.
    const coords: [string, number, number, string][] = [
      ['greeter.ts', 2, 17, 'hello'], // the hello declaration
      ['greeter.ts', 7, 14, 'Greeter'], // the Greeter class declaration
      ['greeter.ts', 11, 12, 'hello'], // the hello CALL inside greet()
      ['index.ts', 3, 7, 'greeter'], // the `greeter` value
      ['index.ts', 3, 21, 'Greeter'], // the `new Greeter(...)` reference
    ]
    for (const [file, line, col, name] of coords) {
      const lines = readFileSync(join(GREETER, file), 'utf8').split('\n')
      const text = lines[line - 1] ?? ''
      expect(text.slice(col - 1, col - 1 + name.length)).toBe(name)
    }
  })
})
