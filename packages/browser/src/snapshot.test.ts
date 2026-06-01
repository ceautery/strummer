import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { buildSnapshot, captureSnapshot, diffSnapshots } from './snapshot.js'

// A representative slice of Playwright's public `locator.ariaSnapshot()` output:
// element lines (`- role "name" [attr=v]`), a `text:` value node, and `/url`
// property lines nested under links. (playwright-core 1.60.0 has no ref ids and
// no _snapshotForAI, so Strummer mints its own refs over this stable format.)
const YAML = `- heading "Hello" [level=1]
- navigation:
  - link "Home":
    - /url: /a
  - link "Docs":
    - /url: /b
- button "Sign in"
- text: Email
- textbox "Email"
- img`

describe('buildSnapshot (pure: parse → mint refs → serialize)', () => {
  it('mints sequential refs for element nodes only (not text/property nodes)', () => {
    const snap = buildSnapshot(YAML)
    // 7 element nodes: heading, navigation, link, link, button, textbox, img
    expect(snap.nodeCount).toBe(7)
    expect([...snap.refs.keys()]).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'])
    expect(snap.refs.get('e3')).toEqual({ role: 'link', name: 'Home', nth: 0 })
    expect(snap.refs.get('e5')).toEqual({ role: 'button', name: 'Sign in', nth: 0 })
    expect(snap.refs.get('e6')).toEqual({ role: 'textbox', name: 'Email', nth: 0 })
  })

  it('annotates the serialized tree with [ref=…] on element lines and keeps structure', () => {
    const snap = buildSnapshot(YAML)
    expect(snap.text).toContain('button "Sign in" [ref=e5]')
    expect(snap.text).toContain('textbox "Email" [ref=e6]')
    // structure preserved: the nested link keeps its indent and its /url property
    expect(snap.text).toMatch(/ {2}- link "Home" \[ref=e3\]/)
    expect(snap.text).toContain('/url: /a')
    // text/property nodes never get a ref
    expect(snap.text).not.toMatch(/text: Email \[ref=/)
    expect(snap.text).not.toMatch(/\/url: \/a \[ref=/)
  })

  it('disambiguates duplicate (role, name) pairs with an nth index', () => {
    const snap = buildSnapshot('- button "Go"\n- button "Go"\n- button "Stop"')
    expect(snap.refs.get('e1')).toEqual({ role: 'button', name: 'Go', nth: 0 })
    expect(snap.refs.get('e2')).toEqual({ role: 'button', name: 'Go', nth: 1 })
    expect(snap.refs.get('e3')).toEqual({ role: 'button', name: 'Stop', nth: 0 })
  })

  it('token-caps the serialized output at maxNodes with a truncation marker', () => {
    const snap = buildSnapshot(YAML, { maxNodes: 3 })
    expect(snap.truncated).toBe(true)
    expect(snap.text).toContain('… (4 more elements)')
    // only the first 3 element refs appear in the capped text
    expect(snap.text).toContain('[ref=e3]')
    expect(snap.text).not.toContain('[ref=e4]')
    // the full (uncapped) text is still available for the handle
    expect(snap.fullText).toContain('[ref=e7]')
    expect(snap.fullText).not.toContain('… (')
  })
})

describe('snapshot redaction seam', () => {
  const mask = (s: string) => s.split('SEKRET').join('[redacted:token]')
  const SECRET_YAML = '- heading "Hello"\n- text: my token is SEKRET\n- textbox "SEKRET"'

  it('redacts both the capped text and the full text via the redact hook', () => {
    const snap = buildSnapshot(SECRET_YAML, { redact: mask })
    expect(snap.text).not.toContain('SEKRET')
    expect(snap.fullText).not.toContain('SEKRET')
    expect(snap.text).toContain('[redacted:token]')
    expect(snap.fullText).toContain('[redacted:token]')
  })

  it('redacts the stored snapshot artifact before it is written to disk', async () => {
    const source = { ariaSnapshot: async () => SECRET_YAML }
    const { ArtifactStore } = await import('./artifacts.js')
    const store = new ArtifactStore(
      (await import('node:fs')).mkdtempSync(
        (await import('node:path')).join((await import('node:os')).tmpdir(), 'strummer-snap-'),
      ),
    )
    const snap = await captureSnapshot(source, { runId: 'r1', store, redact: mask })
    const stored = store.get(snap.fullHandle as string)
    expect(stored?.body.toString('utf8')).not.toContain('SEKRET')
    expect(stored?.body.toString('utf8')).toContain('[redacted:token]')
  })
})

describe('diffSnapshots (scoped, ref-independent)', () => {
  it('reports added and removed semantic nodes', () => {
    const a = buildSnapshot('- button "Sign in"\n- textbox "Email"')
    const b = buildSnapshot('- button "Sign out"\n- textbox "Email"')
    const diff = diffSnapshots(a, b)
    expect(diff).toContain('- button "Sign in"')
    expect(diff).toContain('+ button "Sign out"')
    expect(diff).not.toContain('textbox "Email"') // unchanged → omitted
  })

  it('ignores ref churn: identical content with different refs is an empty diff', () => {
    // same semantic content, but minted refs would differ if order changed
    const a = buildSnapshot('- link "A"\n- button "B"')
    const b = buildSnapshot('- link "A"\n- button "B"')
    expect(diffSnapshots(a, b)).toBe('')
  })
})

describe('captureSnapshot (structural source; no browser)', () => {
  it('captures from any ariaSnapshot source and stores the full tree by handle', async () => {
    const source = { ariaSnapshot: async () => YAML }
    const { ArtifactStore } = await import('./artifacts.js')
    const store = new ArtifactStore(
      (await import('node:fs')).mkdtempSync(
        (await import('node:path')).join((await import('node:os')).tmpdir(), 'strummer-snap-'),
      ),
    )
    const snap = await captureSnapshot(source, { runId: 'r1', store })
    expect(snap.nodeCount).toBe(7)
    expect(snap.fullHandle).toBe('strummer://browser/run/r1/snapshot')
    const stored = store.get(snap.fullHandle as string)
    expect(stored?.body.toString('utf8')).toContain('[ref=e7]')
  })
})

describe('captureSnapshot (real headless chromium)', () => {
  let server: Server
  let baseUrl: string

  it('captures a real page and resolves a minted ref to a live element', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>T</title><h1>Hi</h1><button>Sign in</button>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    try {
      const page = await (await browser.newContext()).newPage()
      await page.goto(baseUrl)
      const snap = await captureSnapshot(page.locator('body'))
      expect(snap.text).toContain('[ref=')
      const buttonRef = [...snap.refs.entries()].find(
        ([, d]) => d.role === 'button' && d.name === 'Sign in',
      )
      expect(buttonRef).toBeDefined()
      const [, desc] = buttonRef as [string, { role: string; name?: string; nth: number }]
      // the descriptor must resolve back to the live element via a semantic locator
      const located = page.getByRole('button', { name: desc.name, exact: true }).nth(desc.nth)
      expect(await located.isVisible()).toBe(true)
    } finally {
      await browser.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 60_000)
})
