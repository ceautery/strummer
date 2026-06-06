import { describe, expect, it } from 'vitest'
import { browserSecretsFromEnv, buildCaptureRuntime } from './runtime.js'

// The shared browser-capture runtime builder (extracted so the browser CLI, the
// verify CLI's `--flow` path, and the browser MCP server stop drifting — the drift
// is what let `verify run --flow` ship without secret/unsafe wiring). No real
// browser is launched here: BrowserManager launches lazily on createSession, and
// createSsrfProxy only binds a local port (closed by shutdown), as proxy.test.ts does.

describe('browserSecretsFromEnv', () => {
  it('parses SACKVILLE_BROWSER_SECRET_* into resolve + redact + names', () => {
    const { redact, resolveSecret, secretNames } = browserSecretsFromEnv({
      SACKVILLE_BROWSER_SECRET_PASSWORD: 'hunter2',
      SACKVILLE_BROWSER_SECRET_TOKEN: 'abc123',
      UNRELATED: 'x',
    })
    expect(resolveSecret('PASSWORD')).toBe('hunter2')
    expect(resolveSecret('TOKEN')).toBe('abc123')
    expect(resolveSecret('NOPE')).toBeUndefined()
    expect([...secretNames].sort()).toEqual(['PASSWORD', 'TOKEN'])
    expect(redact('logged in as hunter2 with abc123')).not.toContain('hunter2')
  })

  it('ignores empty values and non-secret keys', () => {
    const { secretNames } = browserSecretsFromEnv({
      SACKVILLE_BROWSER_SECRET_EMPTY: '',
      FOO: 'bar',
    })
    expect(secretNames).toEqual([])
  })
})

describe('buildCaptureRuntime', () => {
  it('builds a CaptureRuntime and shuts down cleanly (no browser launch)', async () => {
    const rt = await buildCaptureRuntime({
      allowedHosts: ['localhost'],
      allowUnsafe: true,
      harDir: '/tmp/sackville-runtime-test-har',
      resolveSecret: (n) => (n === 'A' ? 'v' : undefined),
      redact: (s) => s.replaceAll('secret', '[x]'),
    })
    try {
      expect(rt.gate).toBeDefined()
      expect(rt.manager).toBeDefined()
      expect(rt.config.harDir).toBe('/tmp/sackville-runtime-test-har')
      expect(rt.resolveSecret?.('A')).toBe('v')
      expect(rt.redact('a secret value')).toBe('a [x] value')
    } finally {
      await rt.shutdown()
    }
  })

  it('defaults redact to identity and harDir to undefined when omitted', async () => {
    const rt = await buildCaptureRuntime({ allowedHosts: [] })
    try {
      expect(rt.redact('abc')).toBe('abc')
      expect(rt.config.harDir).toBeUndefined()
      expect(rt.resolveSecret).toBeUndefined()
    } finally {
      await rt.shutdown()
    }
  })
})
