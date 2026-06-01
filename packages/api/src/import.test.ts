import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCollection } from './collection.js'
import { importToCollection, parseImport } from './import.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'strummer-import-'))
}

describe('import → .bru → loadCollection (round-trip)', () => {
  it('imports a Postman v2.1 collection (raw json + urlencoded + graphql + folders)', () => {
    const postman = JSON.stringify({
      info: { name: 'PM', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' },
      item: [
        {
          name: 'health',
          request: { method: 'GET', url: { raw: '{{baseUrl}}/health' }, header: [] },
        },
        {
          name: 'Folder',
          item: [
            {
              name: 'create',
              request: {
                method: 'POST',
                url: '{{baseUrl}}/things',
                header: [{ key: 'Authorization', value: 'Bearer {{secret:TOK}}' }],
                body: {
                  mode: 'raw',
                  raw: '{"name":"widget"}',
                  options: { raw: { language: 'json' } },
                },
              },
            },
            {
              name: 'form',
              request: {
                method: 'POST',
                url: '{{baseUrl}}/form',
                body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] },
              },
            },
          ],
        },
      ],
    })
    const dir = tmp()
    expect(importToCollection('postman', postman, dir, { name: 'PM' })).toBe(3)

    const coll = loadCollection(dir)
    expect([...coll.requests.values()].map((e) => e.request.name).sort()).toEqual([
      'create',
      'form',
      'health',
    ])
    const create = coll.requests.get('create')?.request
    expect(create?.method).toBe('POST')
    expect(create?.url).toBe('{{baseUrl}}/things')
    expect(create?.body).toEqual({ type: 'json', content: '{"name":"widget"}' })
    expect(create?.headers).toContainEqual({
      name: 'Authorization',
      value: 'Bearer {{secret:TOK}}',
    })
    expect(coll.requests.get('form')?.request.body).toEqual({
      type: 'form-urlencoded',
      params: [{ name: 'a', value: '1' }],
    })
  })

  it('imports an Insomnia v4 export', () => {
    const insomnia = JSON.stringify({
      _type: 'export',
      __export_format: 4,
      resources: [
        { _type: 'workspace', name: 'W' },
        {
          _type: 'request',
          name: 'get-user',
          method: 'GET',
          url: 'https://api.test/users/1',
          headers: [{ name: 'Accept', value: 'application/json' }],
        },
        {
          _type: 'request',
          name: 'make-user',
          method: 'POST',
          url: 'https://api.test/users',
          body: { mimeType: 'application/json', text: '{"n":1}' },
        },
      ],
    })
    const dir = tmp()
    expect(importToCollection('insomnia', insomnia, dir)).toBe(2)
    const coll = loadCollection(dir)
    expect(coll.requests.get('make-user')?.request.body).toEqual({
      type: 'json',
      content: '{"n":1}',
    })
    expect(coll.requests.get('get-user')?.request.headers).toContainEqual({
      name: 'Accept',
      value: 'application/json',
    })
  })

  it('imports an OpenAPI 3.x spec (operation per request + server environment)', () => {
    const openapi = `
openapi: 3.1.0
info: { title: T, version: '1' }
servers:
  - url: https://api.test/v1
paths:
  /users:
    get:
      operationId: listUsers
    post:
      operationId: createUser
      requestBody:
        content:
          application/json:
            example: { name: Ada }
`
    const dir = tmp()
    expect(importToCollection('openapi', openapi, dir)).toBe(2)
    const coll = loadCollection(dir)
    const create = coll.requests.get('createUser')?.request
    expect(create?.method).toBe('POST')
    expect(create?.url).toBe('{{baseUrl}}/users')
    expect(create?.body?.type).toBe('json')
    expect(JSON.parse(create?.body?.content ?? '{}')).toEqual({ name: 'Ada' })
    // The server URL became an environment variable.
    expect(coll.environments.get('Imported')).toEqual({ baseUrl: 'https://api.test/v1' })
  })

  it('imports a HAR log (one request per entry)', () => {
    const har = JSON.stringify({
      log: {
        version: '1.2',
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://api.test/a?x=1',
              headers: [{ name: 'Accept', value: '*/*' }],
            },
          },
          {
            request: {
              method: 'POST',
              url: 'https://api.test/b',
              headers: [],
              postData: { mimeType: 'application/json', text: '{"k":2}' },
            },
          },
        ],
      },
    })
    const dir = tmp()
    expect(importToCollection('har', har, dir)).toBe(2)
    const coll = loadCollection(dir)
    const names = [...coll.requests.values()].map((e) => e.request.name)
    expect(names.some((n) => n.includes('GET /a #1'))).toBe(true)
    const post = [...coll.requests.values()].find((e) => e.request.method === 'POST')?.request
    expect(post?.body).toEqual({ type: 'json', content: '{"k":2}' })
  })

  it('deduplicates colliding request-name filenames', () => {
    // Two Postman items share the name "dup" → distinct .bru files (dup, dup-2).
    const postman = JSON.stringify({
      info: { name: 'D' },
      item: [
        { name: 'dup', request: { method: 'GET', url: 'https://api.test/1' } },
        { name: 'dup', request: { method: 'GET', url: 'https://api.test/2' } },
      ],
    })
    const dir = tmp()
    expect(importToCollection('postman', postman, dir)).toBe(2)
    // Both survive on disk under distinct keys (filename stems).
    expect(loadCollection(dir).requests.size).toBe(2)
  })

  it('parseImport returns normalized requests without writing', () => {
    const r = parseImport('har', JSON.stringify({ log: { entries: [] } }))
    expect(r.requests).toEqual([])
  })
})
