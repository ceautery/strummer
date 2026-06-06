import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCapturedTraffic, validateOpenApiResponse } from '@sackville-mcp/api'
import { describe, expect, it } from 'vitest'

// Guard for the level-3 onboarding tutorial (ADR 0020 addendum 2): the api +
// browser + verify pillars. The sample app lives outside the pnpm workspace and
// the root Vitest scope, so it never runs in the gate — these checks keep the
// bundled files, the committed capture, the docset, and the tutorial's premise
// (a passing flow over an API that violates its OpenAPI contract) in sync.
//
// The bug is NOT a failing test or an uncovered line — it is a CONTRACT
// violation invisible to the running UI: `GET /account` returns `balance` as a
// string where openapi.json declares it an integer. We pin it two ways: against
// the response validator directly, and against the committed HAR via the same
// capture->contract bridge the tutorial uses.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', 'examples', 'tutorial', 'storefront')

const spec = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8'))
const harZip = readFileSync(join(root, 'storefront.har.zip'))

describe('tutorial(storefront): bundled files exist', () => {
  for (const rel of [
    'server.js',
    'account.js',
    'openapi.json',
    'storefront.har.zip',
    'flows/login.bru',
    'flows/login.sackville.yml',
    'api/bruno.json',
    'api/get-account.bru',
    'api/get-account.sackville.yml',
    'api/environments/Local.bru',
    'docs/storefront-core/index.json',
    'docs/storefront-core/db.json',
    'package.json',
    'reset.sh',
    'README.md',
  ]) {
    it(`has ${rel}`, () => {
      expect(existsSync(join(root, rel))).toBe(true)
    })
  }
})

describe('tutorial(storefront): the intentional contract bug is present', () => {
  // If this block fails because `account.js` was "fixed", the tutorial's whole
  // premise is gone. Update the README and this guard together — the bug is
  // intentional: `balance` is the string '10000' where the contract says integer.
  const account = readFileSync(join(root, 'account.js'), 'utf8')

  it('account.js still returns balance as a STRING (the defect to find)', () => {
    expect(account).toMatch(/balance:\s*'10000'/)
  })

  it('the buggy response violates the OpenAPI contract (response-schema drift)', () => {
    const result = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/account' },
      {
        status: 200,
        body: { id: 'acct-42', owner: 'Ada Lovelace', balance: '10000', currency: 'USD' },
      },
    )
    expect(result.valid).toBe(false)
    expect(result.findings.some((f) => f.kind === 'response-schema')).toBe(true)
  })

  it('only the type is wrong — the corrected (number) response validates clean', () => {
    const result = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/account' },
      {
        status: 200,
        body: { id: 'acct-42', owner: 'Ada Lovelace', balance: 10000, currency: 'USD' },
      },
    )
    expect(result.valid).toBe(true)
    expect(result.findings).toHaveLength(0)
  })
})

describe('tutorial(storefront): the committed capture proves the lie via the bridge', () => {
  // This is the headline the tutorial demonstrates with `api validate-capture`:
  // real captured traffic, checked against the contract, is NOT clean even though
  // the browser flow that produced it passed.
  const verdict = validateCapturedTraffic(harZip, { openapi: spec })

  it('validated at least the /account JSON entry', () => {
    expect(verdict.entriesValidated).toBeGreaterThanOrEqual(1)
  })

  it('is not clean, with a response-schema finding (absence is never a pass)', () => {
    expect(verdict.clean).toBe(false)
    expect(verdict.findingsByKind['response-schema'] ?? 0).toBeGreaterThanOrEqual(1)
  })
})

describe('tutorial(storefront): the docset is internally consistent', () => {
  const index = JSON.parse(readFileSync(join(root, 'docs/storefront-core/index.json'), 'utf8')) as {
    entries: { name: string; path: string; type: string }[]
  }
  const db = JSON.parse(readFileSync(join(root, 'docs/storefront-core/db.json'), 'utf8')) as Record<
    string,
    string
  >

  it('every index entry path has a db.json page', () => {
    for (const entry of index.entries) {
      expect(db[entry.path], `missing db page for ${entry.path}`).toBeDefined()
    }
  })

  it('documents that balance is an integer number of cents', () => {
    const page = db['api/account'] ?? ''
    expect(page.toLowerCase()).toContain('balance')
    expect(page.toLowerCase()).toMatch(/integer|number/)
  })
})

describe('tutorial(storefront): the README documents the commands it relies on', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const snippet of [
    'sackville-ingest build',
    '--index docs/storefront-core/index.json',
    'sackville-cli search',
    'api run',
    '--openapi',
    'api validate-capture',
    'verify run',
    'claude mcp add sackville',
  ]) {
    it(`mentions \`${snippet}\``, () => {
      expect(readme).toContain(snippet)
    })
  }
})
