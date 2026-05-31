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
})
