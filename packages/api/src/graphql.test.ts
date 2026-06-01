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
})
