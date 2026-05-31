import { describe, expect, it } from 'vitest'
import { runScript } from './script.js'

describe('runScript (QuickJS sandbox)', () => {
  it('reads and writes variables via bru', async () => {
    const r = await runScript('bru.setVar("b", bru.getVar("a") + 1)', { vars: { a: 1 } })
    expect(r.vars.b).toBe(2)
    expect(r.error).toBeUndefined()
  })

  it('records passing and failing tests', async () => {
    const r = await runScript(
      'test("ok", () => expect(1).toBe(1)); test("no", () => expect(1).toBe(2))',
      { vars: {} },
    )
    expect(r.tests).toEqual([
      { name: 'ok', pass: true },
      { name: 'no', pass: false, error: expect.stringContaining('to be') },
    ])
  })

  it('exposes the response to post-response scripts', async () => {
    const r = await runScript('test("status", () => expect(res.status).toBe(201))', {
      vars: {},
      res: { status: 201, headers: {}, body: '', json: null },
    })
    expect(r.tests[0]?.pass).toBe(true)
  })

  it('captures a top-level thrown error', async () => {
    const r = await runScript('throw new Error("boom")', { vars: {} })
    expect(r.error).toContain('boom')
  })

  it('captures console.log output', async () => {
    const r = await runScript('console.log("hello", 42)', { vars: {} })
    expect(r.logs).toContain('hello 42')
  })
})
