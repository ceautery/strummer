import { describe, expect, it } from 'vitest'
import { Redactor } from './redact.js'

describe('Redactor', () => {
  it('scrubs a registered value, its base64, and its url-encoding from text', () => {
    const r = new Redactor()
    r.register('TOKEN', 'p@ss w0rd')
    const b64 = Buffer.from('p@ss w0rd', 'utf8').toString('base64')
    const url = encodeURIComponent('p@ss w0rd')
    const text = `raw=p@ss w0rd b64=${b64} url=${url}`
    const out = r.redact(text)
    expect(out).not.toContain('p@ss w0rd')
    expect(out).not.toContain(b64)
    expect(out).not.toContain(url)
    expect(out).toContain('[redacted:TOKEN]')
  })

  it('ignores empty values and redacts header maps', () => {
    const r = new Redactor()
    r.register('EMPTY', '')
    r.register('KEY', 'sekret')
    const headers = r.redactHeaders({ authorization: 'Bearer sekret', accept: 'application/json' })
    expect(headers.authorization).toBe('Bearer [redacted:KEY]')
    expect(headers.accept).toBe('application/json')
  })

  it('surfaces the registered (name, raw-value) pairs so a downstream redactor can re-register', () => {
    // 5f: the api runner's local redactor learns {{secret:NAME}} values during prepare;
    // verify's union redactor must learn them to scrub a SYNTHESIZED HAR. In-process only.
    const r = new Redactor()
    r.register('API_TOKEN', 'tok-xyz')
    r.register('EMPTY', '') // ignored (no value registered)
    expect(r.registeredSecrets()).toEqual([{ name: 'API_TOKEN', value: 'tok-xyz' }])
  })
})
