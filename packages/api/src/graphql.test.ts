import { describe, expect, it } from 'vitest'
import { validateGraphqlOperation } from './graphql.js'

const sdl = `
  type Query { user(id: ID!): User }
  type User { id: ID!, name: String! }
`

describe('validateGraphqlOperation', () => {
  it('passes a query that conforms to the schema', () => {
    const r = validateGraphqlOperation(sdl, '{ user(id: "1") { id name } }')
    expect(r.valid).toBe(true)
    expect(r.findings).toEqual([])
  })

  it('flags a query that references a field absent from the schema (drift)', () => {
    const r = validateGraphqlOperation(sdl, '{ user(id: "1") { id email } }')
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('graphql-validation')
    expect(JSON.stringify(r.findings)).toContain('email')
  })

  it('flags a syntactically invalid query', () => {
    const r = validateGraphqlOperation(sdl, '{ user(id: "1" { id }')
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('graphql-syntax')
  })

  it('flags a malformed schema SDL', () => {
    const r = validateGraphqlOperation('type Query {', '{ x }')
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('graphql-validation')
  })

  it('flags GraphQL errors returned in the response payload', () => {
    const r = validateGraphqlOperation(sdl, '{ user(id: "1") { id name } }', {
      json: { data: null, errors: [{ message: 'User not found' }] },
    })
    expect(r.valid).toBe(false)
    const errFinding = r.findings.find((f) => f.kind === 'graphql-errors')
    expect(errFinding?.message).toContain('User not found')
  })

  it('flags a mutation against a schema with no Mutation root type (drift)', () => {
    const r = validateGraphqlOperation(sdl, 'mutation { user(id: "1") { id } }')
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('graphql-validation')
    expect(JSON.stringify(r.findings).toLowerCase()).toContain('mutation')
  })

  it('flags a subscription against a schema with no Subscription root type', () => {
    const r = validateGraphqlOperation(sdl, 'subscription { user(id: "1") { id } }')
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('graphql-validation')
  })

  it('passes a conformant query whose response carries data and no errors', () => {
    const r = validateGraphqlOperation(sdl, '{ user(id: "1") { id name } }', {
      json: { data: { user: { id: '1', name: 'Ada' } } },
    })
    expect(r.valid).toBe(true)
    expect(r.findings).toEqual([])
  })

  describe('operationName scoping (multi-operation documents)', () => {
    // Two named operations; the schema has a Query but NO Mutation root type.
    const doc = `
      query A { user(id: "1") { id } }
      mutation B { user(id: "1") { id } }
    `

    it('scopes the root-type drift check to the named operation', () => {
      // A is a query and the schema has Query → no drift when scoped to A,
      // even though sibling mutation B would otherwise flag.
      expect(validateGraphqlOperation(sdl, doc, { operationName: 'A' }).valid).toBe(true)
    })

    it('still flags the named operation when IT is the drifting one', () => {
      const r = validateGraphqlOperation(sdl, doc, { operationName: 'B' })
      expect(r.valid).toBe(false)
      expect(r.findings.some((f) => /mutation/i.test(f.message))).toBe(true)
    })

    it('flags an operationName that is absent from the document', () => {
      const r = validateGraphqlOperation(sdl, doc, { operationName: 'Missing' })
      expect(r.valid).toBe(false)
      expect(r.findings.some((f) => /no operation named/i.test(f.message))).toBe(true)
    })

    it('without operationName, checks every operation (B drifts → invalid)', () => {
      expect(validateGraphqlOperation(sdl, doc).valid).toBe(false)
    })
  })

  describe('request-variable validation (ADR 0015)', () => {
    const varSdl = `
      scalar DateTime
      type Query {
        thing(id: Int!): Thing
        search(q: String): Thing
        events(at: DateTime!): Thing
      }
      type Thing { id: Int! }
    `
    const thingQ = 'query Q($id: Int!) { thing(id: $id) { id } }'

    it('does NOT run variable validation when no `variables` opt is given (back-compat)', () => {
      // A query with a required variable, validated WITHOUT variables: query-vs-SDL only.
      const r = validateGraphqlOperation(varSdl, thingQ)
      expect(r.valid).toBe(true)
      expect(r.unverified).toBeUndefined()
      expect(r.findings).toEqual([])
    })

    it('passes conformant variables', () => {
      const r = validateGraphqlOperation(varSdl, thingQ, { variables: { id: 5 } })
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
      expect(r.unverified).toBeUndefined()
    })

    it('flags a missing required variable only when AUTHORITATIVE', () => {
      const auth = validateGraphqlOperation(varSdl, thingQ, {
        variables: {},
        variablesAuthoritative: true,
      })
      expect(auth.valid).toBe(false)
      expect(auth.findings.map((f) => f.kind)).toContain('graphql-variable-missing')
      expect(JSON.stringify(auth.findings)).toContain('$id')
    })

    it('a missing required variable is UNVERIFIED (not a finding) when non-authoritative', () => {
      const r = validateGraphqlOperation(varSdl, thingQ, { variables: {} })
      expect(r.findings).toEqual([])
      expect(r.unverified).toBe(true)
    })

    it('a non-null variable WITH a default that is omitted is NOT missing (default-aware)', () => {
      const q = 'query Q($id: Int! = 7) { thing(id: $id) { id } }'
      const r = validateGraphqlOperation(varSdl, q, { variables: {}, variablesAuthoritative: true })
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
      expect(r.unverified).toBeUndefined()
    })

    it('flags a present variable whose value is the wrong type (authority irrelevant)', () => {
      const r = validateGraphqlOperation(varSdl, thingQ, { variables: { id: 'hello' } })
      expect(r.valid).toBe(false)
      const f = r.findings.find((x) => x.kind === 'graphql-variable-invalid')
      expect(f).toBeDefined()
      // Reconstructed from name + declared type — NEVER the offending value.
      expect(f?.message).toContain('$id')
      expect(f?.message).toContain('Int!')
      expect(JSON.stringify(r.findings)).not.toContain('hello')
    })

    it('flags an explicit null against a non-null type (distinct from a type mismatch)', () => {
      const r = validateGraphqlOperation(varSdl, thingQ, { variables: { id: null } })
      expect(r.valid).toBe(false)
      const f = r.findings.find((x) => x.kind === 'graphql-variable-invalid')
      expect(f?.message.toLowerCase()).toContain('null')
    })

    it('NEVER echoes a secret-bearing variable value into a finding', () => {
      const secret = 'super-secret-token-xyz'
      const r = validateGraphqlOperation(varSdl, thingQ, { variables: { id: secret } })
      expect(r.valid).toBe(false)
      expect(JSON.stringify(r.findings)).not.toContain(secret)
    })

    it('treats a custom-scalar-typed variable as UNVERIFIED (cannot validate via SDL), never a pass', () => {
      const q = 'query Q($at: DateTime!) { events(at: $at) { id } }'
      // A garbage value the SDL identity-scalar would happily green-light.
      const r = validateGraphqlOperation(varSdl, q, { variables: { at: { garbage: true } } })
      expect(r.findings).toEqual([])
      expect(r.unverified).toBe(true)
    })

    it('warns on an undocumented variable the operation does not declare', () => {
      const r = validateGraphqlOperation(varSdl, thingQ, { variables: { id: 1, bogus: 2 } })
      expect(r.valid).toBe(true) // a warning never fails
      const f = r.findings.find((x) => x.kind === 'graphql-undocumented-variable')
      expect(f?.severity).toBe('warning')
      expect(f?.message).toContain('bogus')
    })

    it('UNVERIFIED for a multi-operation document with no operationName (ambiguous target)', () => {
      const doc = `query A($id: Int!) { thing(id: $id) { id } }
        query B($q: String) { search(q: $q) { id } }`
      const r = validateGraphqlOperation(varSdl, doc, { variables: { id: 1 } })
      expect(r.unverified).toBe(true)
      // No spurious missing/invalid findings attributed to the wrong operation.
      expect(r.findings.filter((f) => f.kind.startsWith('graphql-variable'))).toEqual([])
    })

    it('validates the named operation’s variables in a multi-operation document', () => {
      const doc = `query A($id: Int!) { thing(id: $id) { id } }
        query B($q: String) { search(q: $q) { id } }`
      const r = validateGraphqlOperation(varSdl, doc, {
        variables: { id: 1 },
        operationName: 'A',
      })
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
    })

    it('UNVERIFIED when `variables` is present but not a JSON object (array)', () => {
      const r = validateGraphqlOperation(varSdl, thingQ, { variables: [1, 2] })
      expect(r.unverified).toBe(true)
      expect(r.findings.filter((f) => f.kind.startsWith('graphql-variable'))).toEqual([])
    })
  })
})
