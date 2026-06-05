import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { harEntriesToFacts } from './har-capture.js'
import {
  type HarHopRecord,
  redactHarZip,
  summarizeHar,
  synthesizeRedactedHarZip,
} from './har-synth.js'

const SECRET = 's3cr3t-value'
const redact = (v: string) => v.split(SECRET).join('[redacted:token]')

/** Build a HAR `.zip` Buffer: a `.har` member + named body members (mimeType drives
 * whether a body is a text-like attach entry). Mirrors Playwright `content:'attach'`. */
function makeHarZip(parts: {
  har: unknown
  members?: Record<string, { bytes: Uint8Array }>
}): Buffer {
  const files: Record<string, Uint8Array> = {
    'capture.har': strToU8(JSON.stringify(parts.har)),
  }
  for (const [name, m] of Object.entries(parts.members ?? {})) files[name] = m.bytes
  return Buffer.from(zipSync(files))
}

describe('redactHarZip — pure Buffer→Buffer blanket redaction (5f slice 1)', () => {
  it('redacts a registered secret in the .har JSON text body', () => {
    const zip = makeHarZip({
      har: {
        log: {
          entries: [
            {
              request: { method: 'GET', url: `https://api.test/x?token=${SECRET}` },
              response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
            },
          ],
        },
      },
    })
    const out = redactHarZip(zip, redact)
    const harText = strFromU8(unzipSync(new Uint8Array(out))['capture.har'] as Uint8Array)
    expect(harText).not.toContain(SECRET)
    expect(harText).toContain('[redacted:token]')
  })

  it('redacts a text-like attach body stored under a non-text content-addressed filename', () => {
    // The .har declares the attach body's mimeType; the filename has no text extension,
    // so a filename-only gate would pass it through unredacted (the 5e leak).
    const bodyName = '75f3a9c0deadbeef' // content-addressed, no extension
    const zip = makeHarZip({
      har: {
        log: {
          entries: [
            {
              request: { method: 'POST', url: 'https://api.test/graphql' },
              response: {
                status: 200,
                content: { mimeType: 'application/json', _file: bodyName },
              },
            },
          ],
        },
      },
      members: { [bodyName]: { bytes: strToU8(`{"data":{"k":"${SECRET}"}}`) } },
    })
    const out = redactHarZip(zip, redact)
    const body = strFromU8(unzipSync(new Uint8Array(out))[bodyName] as Uint8Array)
    expect(body).not.toContain(SECRET)
    expect(body).toContain('[redacted:token]')
  })

  it('passes a genuinely binary member through byte-for-byte', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const bin = 'a1b2c3'
    const zip = makeHarZip({
      har: { log: { entries: [{ request: { method: 'GET', url: 'https://api.test/img' } }] } },
      members: { [bin]: { bytes: png } },
    })
    const out = redactHarZip(zip, redact)
    expect(unzipSync(new Uint8Array(out))[bin]).toEqual(png)
  })

  it('is identity when no redactor changes the bytes', () => {
    const zip = makeHarZip({ har: { log: { entries: [] } } })
    const out = redactHarZip(zip, (v) => v)
    const harText = strFromU8(unzipSync(new Uint8Array(out))['capture.har'] as Uint8Array)
    expect(JSON.parse(harText)).toEqual({ log: { entries: [] } })
  })
})

describe('summarizeHar — compact tallies from the .har JSON (5f slice 1)', () => {
  it('tallies entryCount/byStatus/byMethod', () => {
    const har = {
      log: {
        entries: [
          { request: { method: 'GET' }, response: { status: 200 } },
          { request: { method: 'GET' }, response: { status: 404 } },
          { request: { method: 'POST' }, response: { status: 200 } },
        ],
      },
    }
    expect(summarizeHar(JSON.stringify(har))).toEqual({
      entryCount: 3,
      byStatus: { '200': 2, '404': 1 },
      byMethod: { GET: 2, POST: 1 },
    })
  })

  it('is tolerant of a malformed log', () => {
    expect(summarizeHar('not json')).toEqual({ entryCount: 0, byStatus: {}, byMethod: {} })
  })
})

describe('synthesizeRedactedHarZip — RunResult → consume-bridge-shaped HAR (5f slice 3)', () => {
  it('round-trips through harEntriesToFacts: GraphQL req.body parsed, status kept, secret redacted', () => {
    const records: HarHopRecord[] = [
      {
        method: 'POST',
        url: 'https://api.test/graphql',
        status: 200,
        reqContentType: 'application/json',
        reqBody: `{"query":"query Widgets { widgets { id name } }","token":"${SECRET}"}`,
        resContentType: 'application/json',
        resBody: `{"data":{"widgets":[]},"echo":"${SECRET}"}`,
      },
    ]
    const zip = synthesizeRedactedHarZip(records, redact)
    // No raw secret survives anywhere in the synthesized archive.
    for (const bytes of Object.values(unzipSync(new Uint8Array(zip)))) {
      expect(strFromU8(bytes)).not.toContain(SECRET)
    }
    // The shipped consume bridge reads it as one JSON entry with a parsed GraphQL body.
    const facts = harEntriesToFacts(zip)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.req.method).toBe('POST')
    expect(facts[0]?.req.path).toBe('/graphql')
    expect(facts[0]?.res.status).toBe(200)
    expect((facts[0]?.req.body as { query?: string })?.query).toContain('query Widgets')
  })

  it('omits postData for a record with no string request body (binary/multipart)', () => {
    const records: HarHopRecord[] = [
      {
        method: 'GET',
        url: 'https://api.test/widgets',
        status: 200,
        resContentType: 'application/json',
        resBody: '[]',
      },
    ]
    const zip = synthesizeRedactedHarZip(records, (v) => v)
    const facts = harEntriesToFacts(zip)
    expect(facts[0]?.req.body).toBeUndefined()
    expect(facts[0]?.res.body).toEqual([])
  })

  it('THROWS on a record with a non-numeric status (incomplete capture ⇒ inconclusive, never a status-0 finding)', () => {
    const bad = [
      { method: 'GET', url: 'https://api.test/x', status: undefined as unknown as number },
    ] satisfies HarHopRecord[]
    expect(() => synthesizeRedactedHarZip(bad, (v) => v)).toThrow(/status/i)
  })

  it('emits one entry per hop (no collapsed redirect chain)', () => {
    const records: HarHopRecord[] = [
      {
        method: 'GET',
        url: 'https://api.test/a',
        status: 302,
        resContentType: 'application/json',
        resBody: '{}',
      },
      {
        method: 'GET',
        url: 'https://api.test/b',
        status: 200,
        resContentType: 'application/json',
        resBody: '{"ok":true}',
      },
    ]
    const facts = harEntriesToFacts(synthesizeRedactedHarZip(records, (v) => v))
    expect(facts.map((f) => f.req.path)).toEqual(['/a', '/b'])
    expect(facts.map((f) => f.res.status)).toEqual([302, 200])
  })
})

// har-synth.ts is the leaf that creates the new `@sackville/browser → @sackville/api`
// dep edge (slice 2: browser's finalizeHar delegates here). It must import ONLY fflate,
// so that edge can never drag runner/undici/spawn-capable code into the browser pillar.
describe('har-synth.ts — pure leaf, fflate-only imports (5f slice 2 guard)', () => {
  it('imports nothing beyond fflate', () => {
    const src = readFileSync(fileURLToPath(new URL('./har-synth.ts', import.meta.url)), 'utf8')
    for (const line of src.split('\n')) {
      const m = line.match(/^\s*import\s+(?:type\s+)?.*?\s+from\s+['"]([^'"]+)['"]/)
      if (m) expect(m[1]).toBe('fflate')
    }
    // No CommonJS require / no dynamic import of anything but fflate (scan calls, not prose).
    expect(src).not.toMatch(/\brequire\s*\(/)
    for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) expect(m[1]).toBe('fflate')
  })
})
