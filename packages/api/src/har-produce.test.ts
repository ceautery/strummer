import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadCollection } from './collection.js'
import { type HarArtifactSink, runRequestToHar, runSequenceToHar } from './har-produce.js'
import type { HarHopRecord } from './har-synth.js'
import type { Collection, RunResult } from './model.js'
import type { HarCapture, runRequestForHar } from './runner.js'
import { Redactor } from './secrets.js'

const COLLECTION = {
  dir: '/x',
  requests: new Map(),
  environments: new Map(),
} as unknown as Collection
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/sample')

function recordingSink(): { sink: HarArtifactSink; bytes: () => Buffer[] } {
  const puts: Buffer[] = []
  const sink: HarArtifactSink = {
    put: (id, kind, body) => {
      puts.push(Buffer.from(body))
      return `sackville://verify/${id}/${kind}`
    },
  }
  return { sink, bytes: () => puts }
}

function sentResult(): RunResult {
  return {
    request: { method: 'GET', url: 'https://api.test/x', headers: {} },
    sent: true,
    dryRun: false,
    response: {
      status: 200,
      latencyMs: 1,
      headers: {},
      assertions: [],
      scriptTests: [],
      captured: {},
      bodyHandle: 'h',
    },
  }
}

/** A canned runRequestForHar: returns the given sent-ness + capture, no network. */
function fakeRun(over: {
  sent: boolean
  reason?: string
  hops?: HarHopRecord[]
  secrets?: { name: string; value: string }[]
  truncated?: boolean
}): typeof runRequestForHar {
  return (async () => ({
    result: over.sent
      ? sentResult()
      : {
          request: { method: 'POST', url: 'https://api.test/x', headers: {} },
          sent: false,
          dryRun: true,
          reason: over.reason,
        },
    capture: {
      hops: over.hops ?? [],
      registeredSecrets: over.secrets ?? [],
      redirectTruncated: over.truncated ?? false,
    } satisfies HarCapture,
  })) as unknown as typeof runRequestForHar
}

const jsonHop = (status: number, body: string): HarHopRecord => ({
  method: 'GET',
  url: 'https://api.test/widgets',
  status,
  resContentType: 'application/json',
  resBody: body,
})

describe('runRequestToHar — produce a HAR from the runner + transport-completeness guards (5f slice 5)', () => {
  it('produces a stored HAR + verdict for a sent request', async () => {
    const { sink, bytes } = recordingSink()
    const out = await runRequestToHar(
      COLLECTION,
      'get-widgets',
      {},
      {
        store: sink,
        redactor: new Redactor(),
        contract: {},
        idFactory: () => 'fixed-id',
        runForHar: fakeRun({ sent: true, hops: [jsonHop(200, '[]')] }),
      },
    )
    expect(out.harHandle).toBe('sackville://verify/fixed-id/har')
    expect(out.summary).toMatchObject({
      entryCount: 1,
      byStatus: { '200': 1 },
      byMethod: { GET: 1 },
    })
    expect(out.verdict.entriesValidated).toBe(1)
    expect(bytes()).toHaveLength(1)
  })

  it('THROWS (⇒ inconclusive) when the request was withheld/dry-run — no HAR stored', async () => {
    const { sink, bytes } = recordingSink()
    await expect(
      runRequestToHar(
        COLLECTION,
        'create-thing',
        {},
        {
          store: sink,
          redactor: new Redactor(),
          contract: {},
          runForHar: fakeRun({ sent: false, reason: 'mutating method requires allowUnsafe' }),
        },
      ),
    ).rejects.toThrow(/not sent|withheld|mutating/i)
    expect(bytes()).toHaveLength(0)
  })

  it('THROWS on a truncated redirect chain (terminal 3xx), even when sent', async () => {
    const { sink } = recordingSink()
    await expect(
      runRequestToHar(
        COLLECTION,
        'follow-redirect',
        {},
        {
          store: sink,
          redactor: new Redactor(),
          contract: {},
          runForHar: fakeRun({ sent: true, hops: [jsonHop(302, '{}')], truncated: true }),
        },
      ),
    ).rejects.toThrow(/redirect|complete/i)
  })

  it('folds run-resolved secrets into the union redactor — no secret survives the stored HAR', async () => {
    const { sink, bytes } = recordingSink()
    const SECRET = 'run-tok-123'
    await runRequestToHar(
      COLLECTION,
      'graphql',
      {},
      {
        store: sink,
        redactor: new Redactor(), // empty — the run-registered secret is the ONLY source
        contract: {},
        runForHar: fakeRun({
          sent: true,
          secrets: [{ name: 'API_TOKEN', value: SECRET }],
          hops: [
            {
              method: 'POST',
              url: 'https://api.test/graphql',
              status: 200,
              reqContentType: 'application/json',
              reqBody: `{"query":"{ a }","t":"${SECRET}"}`,
              resContentType: 'application/json',
              resBody: `{"data":{"a":"${SECRET}"}}`,
            },
          ],
        }),
      },
    )
    for (const buf of bytes()) {
      for (const member of Object.values(unzipSync(new Uint8Array(buf)))) {
        expect(strFromU8(member)).not.toContain(SECRET)
      }
    }
  })
})

describe('runRequestToHar — end-to-end over the REAL runner (loopback, no fakes)', () => {
  let server: Server
  let baseUrl: string
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('drives get-health, synthesizes its HAR, and validates clean against a matching OpenAPI spec', async () => {
    const { sink } = recordingSink()
    const out = await runRequestToHar(
      loadCollection(FIXTURE),
      'get-health',
      { vars: { baseUrl } },
      {
        store: sink,
        redactor: new Redactor(),
        contract: {
          openapi: {
            openapi: '3.1.0',
            paths: {
              '/health': {
                get: {
                  responses: {
                    '200': { content: { 'application/json': { schema: { type: 'object' } } } },
                  },
                },
              },
            },
          },
        },
      },
    )
    expect(out.summary.entryCount).toBe(1)
    expect(out.verdict.clean).toBe(true)
    expect(out.verdict.exercisedOperations).toEqual(['GET /health'])
  })
})

describe('runSequenceToHar — multi-request produce + per-step guard (5f slice 5)', () => {
  it('THROWS when ANY step was not sent (step.result.sent, never step.sent)', async () => {
    const { sink, bytes } = recordingSink()
    const fakeSeq = (async () => ({
      result: {
        steps: [
          { name: 'a', result: sentResult() },
          {
            name: 'b',
            result: {
              request: { method: 'POST', url: 'https://api.test/x', headers: {} },
              sent: false,
              dryRun: true,
              reason: 'withheld',
            },
          },
        ],
        captured: {},
      },
      capture: {
        hops: [jsonHop(200, '[]')],
        registeredSecrets: [],
        redirectTruncated: false,
      } satisfies HarCapture,
    })) as unknown as typeof import('./sequence.js').runSequenceForHar
    await expect(
      runSequenceToHar(
        COLLECTION,
        ['a', 'b'],
        {},
        {
          store: sink,
          redactor: new Redactor(),
          contract: {},
          runSequenceForHar: fakeSeq,
        },
      ),
    ).rejects.toThrow(/not sent|withheld|step/i)
    expect(bytes()).toHaveLength(0)
  })
})
