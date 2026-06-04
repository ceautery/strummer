import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { harEntriesToFacts, validateCapturedTraffic } from './har-capture.js'

// A REAL Playwright-emitted HAR (.zip, content:'attach') captured offline against
// an in-process app — see the generator in the commit message. It holds: GET /
// (text/html), GET /styles.css (text/css), GET /api/v1/widgets (200 JSON, valid),
// GET /api/v1/widgets/1 (200 JSON whose `id` is a string — a schema violation).
const HAR = readFileSync(
  fileURLToPath(new URL('../test/fixtures/widgets-capture.har.zip', import.meta.url)),
)

// A tiny OpenAPI doc with a /api/v1 server base path. `/unused` is documented but
// never exercised by the capture; `/widgets/{id}` requires an integer `id`.
const SPEC = {
  openapi: '3.1.0',
  servers: [{ url: '/api/v1' }],
  paths: {
    '/widgets': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['widgets'],
                  properties: { widgets: { type: 'array' } },
                },
              },
            },
          },
        },
      },
    },
    '/widgets/{id}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'integer' }, name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/unused': { get: { responses: { '200': {} } } },
  },
}

describe('harEntriesToFacts — slice 2 (attach/zip body resolution)', () => {
  it('resolves the JSON API entry to method + pathname + parsed body', () => {
    const facts = harEntriesToFacts(HAR)
    const widgets = facts.find((f) => f.req.path === '/api/v1/widgets')
    expect(widgets).toBeDefined()
    expect(widgets?.req.method).toBe('GET')
    expect(widgets?.res.status).toBe(200)
    expect(widgets?.mimeType).toBe('application/json')
    // body is JSON-PARSED, not a raw string — the validator consumes a parsed body.
    expect(widgets?.res.body).toEqual({ widgets: [{ id: 1, name: 'alpha' }] })
    expect(widgets?.unresolvedBody).toBeUndefined()
  })

  it('reduces the URL to pathname + a separate origin (no host in the path)', () => {
    const facts = harEntriesToFacts(HAR)
    const widgets = facts.find((f) => f.req.path === '/api/v1/widgets')
    expect(widgets?.req.path).not.toContain('http')
    expect(widgets?.req.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('keeps non-API entries (html/css) but does not JSON-parse them', () => {
    const facts = harEntriesToFacts(HAR)
    expect(facts.some((f) => f.mimeType === 'text/html')).toBe(true)
    expect(facts.some((f) => f.mimeType === 'text/css')).toBe(true)
  })

  it('an attached body missing from the archive is a hard unresolvedBody, not an empty pass', () => {
    // Hand-author a minimal HAR zip whose entry references a _file that is absent.
    const har = {
      log: {
        entries: [
          {
            request: { method: 'GET', url: 'http://x/api/v1/widgets' },
            response: {
              status: 200,
              content: { mimeType: 'application/json', _file: 'gone.json' },
            },
          },
        ],
      },
    }
    // zip it with fflate the same way Playwright would name the .har entry
    const zip = Buffer.from(zipSync({ 'har.har': strToU8(JSON.stringify(har)) }))
    const facts = harEntriesToFacts(zip)
    expect(facts[0]?.unresolvedBody).toBeDefined()
    expect(facts[0]?.res.body).toBeUndefined()
  })
})

describe('validateCapturedTraffic — slices 3/4/5 (filter, base-path, drive + drift)', () => {
  it('validates only JSON API entries (html/css filtered out)', () => {
    const v = validateCapturedTraffic(HAR, SPEC)
    // Two JSON entries; html + css skipped.
    expect(v.entriesValidated).toBe(2)
  })

  it('reconciles the /api/v1 server base path so /api/v1/widgets matches /widgets', () => {
    const v = validateCapturedTraffic(HAR, SPEC)
    // /widgets is valid; no missing-operation for it.
    expect(v.exercisedOperations).toContain('GET /widgets')
    expect(v.exercisedOperations).toContain('GET /widgets/{id}')
  })

  it('surfaces a real response-schema drift on the violating body, and a first-failing headline', () => {
    const v = validateCapturedTraffic(HAR, SPEC)
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['response-schema']).toBeGreaterThanOrEqual(1)
    expect(v.firstFailing?.path).toBe('/widgets/{id}')
    expect(v.firstFailing?.kind).toBe('response-schema')
  })

  it('computes the exercised/unexercised drift walk over spec.paths × methods', () => {
    const v = validateCapturedTraffic(HAR, SPEC)
    expect(v.unexercisedOperations).toEqual(['GET /unused'])
  })

  it('routes every finding message through the operator Redactor', () => {
    const redact = vi.fn((s: string) => s.replace(/widgets/gi, '‹redacted›'))
    const v = validateCapturedTraffic(HAR, SPEC, { redact })
    expect(redact).toHaveBeenCalled()
    for (const r of v.results) {
      for (const f of r.findings) expect(f.message).not.toContain('widgets')
    }
  })

  it('an empty/zero-entry capture is never clean (absence is never a pass)', () => {
    const empty = Buffer.from(
      zipSync({ 'har.har': strToU8(JSON.stringify({ log: { entries: [] } })) }),
    )
    const v = validateCapturedTraffic(empty, SPEC)
    expect(v.entriesValidated).toBe(0)
    expect(v.clean).toBe(false)
  })
})
