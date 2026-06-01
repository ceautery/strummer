import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadFlow, loadFlowCollection } from './flow.js'

const here = dirname(fileURLToPath(import.meta.url))

// A Bruno-openable .bru (meta only — the browser flow lives in the sidecar).
const BRU = `meta {
  name: Login
  type: http
}
`

const SIDECAR = `steps:
  - navigate: "{{baseUrl}}/login"
  - fill: { role: textbox, name: Username, value: "{{secret:USER}}" }
  - fill: { role: textbox, name: Password, value: "{{secret:PASS}}" }
  - click: { role: button, name: Sign in }
  - press: { key: Enter }
  - select: { role: combobox, name: Plan, values: pro }
  - wait_for: { role: heading, name: Dashboard, state: visible, timeout: 8000 }
  - assert:
      - { source: url, op: contains, value: /dashboard }
      - { source: text, role: heading, name: Dashboard, op: contains, value: Dashboard }
`

describe('loadFlow / loadFlowCollection — .bru + sidecar persistence', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strummer-flow-'))
  })
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function write(stem: string, bru = BRU, sidecar = SIDECAR) {
    writeFileSync(join(dir, `${stem}.bru`), bru)
    writeFileSync(join(dir, `${stem}.strummer.yml`), sidecar)
  }

  it('loads a flow: meta name from the .bru, ordered steps from the sidecar', () => {
    write('login')
    const flow = loadFlow(join(dir, 'login.bru'))
    expect(flow.name).toBe('Login')
    expect(flow.steps.map((s) => s.action)).toEqual([
      'navigate',
      'fill',
      'fill',
      'click',
      'press',
      'select',
      'wait_for',
      'assert',
    ])
  })

  it('parses each step kind into the typed model', () => {
    write('login')
    const flow = loadFlow(join(dir, 'login.bru'))
    const [nav, fill, , click, press, select, waitFor, assert] = flow.steps

    expect(nav).toEqual({ action: 'navigate', url: '{{baseUrl}}/login' })
    expect(fill).toEqual({
      action: 'fill',
      target: { role: 'textbox', name: 'Username' },
      value: '{{secret:USER}}',
    })
    expect(click).toEqual({ action: 'click', target: { role: 'button', name: 'Sign in' } })
    expect(press).toEqual({ action: 'press', key: 'Enter' })
    expect(select).toEqual({
      action: 'select',
      target: { role: 'combobox', name: 'Plan' },
      values: 'pro',
    })
    expect(waitFor).toEqual({
      action: 'wait_for',
      target: { role: 'heading', name: 'Dashboard' },
      state: 'visible',
      timeout: 8000,
    })
    expect(assert).toEqual({
      action: 'assert',
      assertions: [
        { source: 'url', op: 'contains', value: '/dashboard' },
        { source: 'text', role: 'heading', name: 'Dashboard', op: 'contains', value: 'Dashboard' },
      ],
    })
  })

  it('falls back to the .bru filename when meta.name is absent', () => {
    write('checkout', 'meta {\n  type: http\n}\n', 'steps:\n  - navigate: "/"\n')
    const flow = loadFlow(join(dir, 'checkout.bru'))
    expect(flow.name).toBe('checkout')
  })

  it('rejects an unknown step action (fail-loud)', () => {
    write('bad', BRU, 'steps:\n  - teleport: { to: mars }\n')
    expect(() => loadFlow(join(dir, 'bad.bru'))).toThrow(/unknown step action.*teleport/i)
  })

  it('rejects a step missing a required field (fail-loud)', () => {
    write('bad', BRU, 'steps:\n  - fill: { role: textbox, name: User }\n') // no value
    expect(() => loadFlow(join(dir, 'bad.bru'))).toThrow(/fill.*value/i)
  })

  it('loadFlowCollection walks a dir, keyed by flow name; skips collection/folder .bru', () => {
    write('login')
    write(
      'checkout',
      'meta {\n  name: Checkout\n  type: http\n}\n',
      'steps:\n  - navigate: "/cart"\n',
    )
    writeFileSync(join(dir, 'collection.bru'), 'meta {\n  name: c\n}\n')
    const coll = loadFlowCollection(dir)
    expect([...coll.flows.keys()].sort()).toEqual(['Checkout', 'Login'])
    expect(coll.dir).toBe(dir)
  })
})

describe('bundled example flow (kept in sync with the parser)', () => {
  it('loads examples/browser/login into the typed model', () => {
    const flow = loadFlow(resolve(here, '../../../examples/browser/login/login.bru'))
    expect(flow.name).toBe('Login')
    expect(flow.steps.map((s) => s.action)).toEqual([
      'navigate',
      'fill',
      'fill',
      'click',
      'wait_for',
      'assert',
    ])
  })
})
