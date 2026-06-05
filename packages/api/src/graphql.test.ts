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

  describe('directive-arg variable validation — regression lock (ADR 0018, slice 1)', () => {
    // The decisive ADR-0018 finding: graphql-js `getVariableValues` is USAGE-AGNOSTIC — it
    // coerces each variable against its DECLARED type off `operation.variableDefinitions`,
    // with no knowledge of where the variable is used. So the ADR-0015 variable loop already
    // validates the value of a variable feeding a DIRECTIVE arg, for free and exactly once.
    // This block locks that behavior so Feature A needs no new code for variable-fed args.
    const dirSdl = `
      directive @auth(level: Int!) on FIELD
      type Query { thing(id: Int!): Thing }
      type Thing { id: Int! }
    `

    it('validates a built-in @skip(if: $s) directive-arg variable (wrong type → invalid)', () => {
      const q = 'query Q($id: Int!, $s: Boolean!) { thing(id: $id) @skip(if: $s) { id } }'
      const r = validateGraphqlOperation(dirSdl, q, {
        variables: { id: 1, s: 'nope' }, // $s is a string, not a Boolean
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(false)
      const f = r.findings.find((x) => x.kind === 'graphql-variable-invalid')
      expect(f?.message).toContain('$s')
      expect(f?.message).toContain('Boolean!')
      expect(JSON.stringify(r.findings)).not.toContain('nope') // value never echoed
    })

    it('validates a CUSTOM directive-arg variable (wrong type → invalid)', () => {
      const q = 'query Q($lvl: Int!) { thing(id: 1) @auth(level: $lvl) { id } }'
      const r = validateGraphqlOperation(dirSdl, q, {
        variables: { lvl: 'high' }, // $lvl is a string, not an Int
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(false)
      const f = r.findings.find((x) => x.kind === 'graphql-variable-invalid')
      expect(f?.message).toContain('$lvl')
      expect(f?.message).toContain('Int!')
      expect(JSON.stringify(r.findings)).not.toContain('high')
    })

    it('a variable feeding BOTH a field arg AND a directive arg yields EXACTLY ONE finding', () => {
      // $v is used twice in the document, but the loop is over variableDEFINITIONS, so it is
      // coerced once → no double-report (the usage-agnostic guarantee).
      const q = 'query Q($v: Int!) { thing(id: $v) @auth(level: $v) { id } }'
      const r = validateGraphqlOperation(dirSdl, q, {
        variables: { v: 'bad' },
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(false)
      const invalids = r.findings.filter((x) => x.kind === 'graphql-variable-invalid')
      expect(invalids).toHaveLength(1)
      expect(invalids[0]?.message).toContain('$v')
    })

    it('passes a conformant directive-arg variable', () => {
      const q = 'query Q($s: Boolean!) { thing(id: 1) @skip(if: $s) { id } }'
      const r = validateGraphqlOperation(dirSdl, q, {
        variables: { s: true },
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
      expect(r.unverified).toBeUndefined()
    })
  })

  describe('custom-scalar directive-arg LITERAL → unverified (ADR 0018, slice 2 / D2)', () => {
    // A custom-scalar directive-arg LITERAL is validated by nothing (identity parseLiteral,
    // which we deliberately never patch), so it carries no signal and must fold to
    // `unverified` — never a finding (the literal may carry an inline secret), and never a
    // silent pass. Confined to DIRECTIVE-arg position; field-arg literals stay out of scope.
    const d2Sdl = `
      scalar DateTime
      directive @auth(token: DateTime) on FIELD
      directive @tags(values: [DateTime]) on FIELD
      input Filter { since: DateTime, name: String }
      directive @filter(by: Filter) on FIELD
      type Query { thing(id: Int!): Thing, events(at: DateTime!): Thing }
      type Thing { id: Int! }
    `

    it('a custom-scalar directive-arg scalar literal is UNVERIFIED, no finding, no value echo', () => {
      const r = validateGraphqlOperation(
        d2Sdl,
        '{ thing(id: 1) @auth(token: "sk-secret-123") { id } }',
      )
      expect(r.findings).toEqual([])
      expect(r.unverified).toBe(true)
      expect(r.directiveUnverified).toBe(true)
      expect(JSON.stringify(r)).not.toContain('sk-secret-123')
    })

    it('a custom-scalar directive-arg LIST literal is UNVERIFIED (transitive)', () => {
      const r = validateGraphqlOperation(d2Sdl, '{ thing(id: 1) @tags(values: ["a", "b"]) { id } }')
      expect(r.findings).toEqual([])
      expect(r.unverified).toBe(true)
      expect(r.directiveUnverified).toBe(true)
    })

    it('a directive-arg INPUT-OBJECT literal with a nested custom scalar is UNVERIFIED (transitive)', () => {
      const r = validateGraphqlOperation(
        d2Sdl,
        '{ thing(id: 1) @filter(by: { since: "2024-01-01", name: "x" }) { id } }',
      )
      expect(r.findings).toEqual([])
      expect(r.unverified).toBe(true)
      expect(r.directiveUnverified).toBe(true)
    })

    it('a FIELD-arg custom-scalar literal is UNCHANGED — directive-only confinement (S1 staged)', () => {
      const r = validateGraphqlOperation(d2Sdl, '{ events(at: "2024-01-01") { id } }')
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
      expect(r.unverified).toBeUndefined()
      expect(r.directiveUnverified).toBeUndefined()
    })

    it('a BUILT-IN-scalar directive-arg literal does NOT trigger D2', () => {
      const r = validateGraphqlOperation(d2Sdl, '{ thing(id: 1) @skip(if: true) { id } }')
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
      expect(r.unverified).toBeUndefined()
      expect(r.directiveUnverified).toBeUndefined()
    })

    it('does NOT run when the query has a drift error (queryClean gate)', () => {
      // Unknown field → validate() errors → D2 must not run (its walk would be unreliable).
      const r = validateGraphqlOperation(d2Sdl, '{ thing(id: 1) @auth(token: "x") { nope } }')
      expect(r.valid).toBe(false)
      expect(r.directiveUnverified).toBeUndefined()
    })
  })

  describe('custom-scalar variable coercers (ADR 0018, slice 3 / Feature B)', () => {
    const coercerSdl = `
      scalar DateTime
      scalar Email
      input Profile { joined: DateTime, name: String }
      input Contact { email: Email, joined: DateTime }
      type Query {
        events(at: DateTime!): Thing
        register(p: Profile!): Thing
        contact(c: Contact!): Thing
      }
      type Thing { id: Int! }
    `
    // Operator coercer: a DateTime must look like YYYY-… ; throws on definite invalidity.
    const coercers = {
      DateTime: (v: unknown) => {
        if (!/^\d{4}-/.test(String(v))) throw new Error('not a DateTime')
        return v
      },
    }
    const eventsQ = 'query Q($at: DateTime!) { events(at: $at) { id } }'

    it('a REGISTERED coercer validates a custom-scalar variable (invalid → finding, value-free)', () => {
      const r = validateGraphqlOperation(coercerSdl, eventsQ, {
        variables: { at: 'nope' },
        scalarCoercers: coercers,
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(false)
      const f = r.findings.find((x) => x.kind === 'graphql-variable-invalid')
      expect(f?.message).toContain('$at')
      expect(f?.message).toContain('DateTime')
      expect(JSON.stringify(r)).not.toContain('nope') // value never echoed
      expect(r.unverified).toBeUndefined() // it WAS checkable → not unverified
    })

    it('a REGISTERED coercer passes a valid custom-scalar variable cleanly', () => {
      const r = validateGraphqlOperation(coercerSdl, eventsQ, {
        variables: { at: '2024-01-01' },
        scalarCoercers: coercers,
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
      expect(r.unverified).toBeUndefined()
    })

    it('an UNREGISTERED custom scalar stays UNVERIFIED (C2 — unchanged ADR 0015)', () => {
      const r = validateGraphqlOperation(coercerSdl, eventsQ, {
        variables: { at: 'nope' }, // no scalarCoercers
        variablesAuthoritative: true,
      })
      expect(r.findings).toEqual([])
      expect(r.unverified).toBe(true)
    })

    it('an input object with ONE unregistered custom-scalar field stays UNVERIFIED (C3)', () => {
      // Contact.email is Email (unregistered) → the whole variable is unverifiable.
      const q = 'query Q($c: Contact!) { contact(c: $c) { id } }'
      const r = validateGraphqlOperation(coercerSdl, q, {
        variables: { c: { email: 'x', joined: '2024-01-01' } },
        scalarCoercers: coercers,
        variablesAuthoritative: true,
      })
      expect(r.findings).toEqual([])
      expect(r.unverified).toBe(true)
    })

    it('an input object whose custom-scalar fields are ALL registered is CHECKABLE (value-free)', () => {
      // Profile.joined is DateTime (registered), name is String (built-in) → checkable.
      const q = 'query Q($p: Profile!) { register(p: $p) { id } }'
      const r = validateGraphqlOperation(coercerSdl, q, {
        variables: { p: { joined: 'BADDATE', name: 'Ada' } },
        scalarCoercers: coercers,
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(false)
      const f = r.findings.find((x) => x.kind === 'graphql-variable-invalid')
      expect(f?.message).toContain('$p')
      expect(JSON.stringify(r)).not.toContain('BADDATE') // nested value never echoed
      expect(r.unverified).toBeUndefined()
    })
  })

  describe('coercer redaction + guards (ADR 0018, slice 4)', () => {
    const coercerSdl = `
      scalar DateTime
      input Profile { joined: DateTime, name: String }
      type Query { events(at: DateTime!): Thing }
      type Thing { id: Int! }
    `
    const eventsQ = 'query Q($at: DateTime!) { events(at: $at) { id } }'

    it('a coercer that THROWS a secret-bearing message never leaks it into a finding', () => {
      const secret = 'leak-me-9999'
      const r = validateGraphqlOperation(coercerSdl, eventsQ, {
        variables: { at: 'whatever' },
        scalarCoercers: {
          DateTime: (v) => {
            throw new Error(`bad value ${secret} for ${v}`)
          },
        },
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(false)
      expect(r.findings.find((x) => x.kind === 'graphql-variable-invalid')).toBeDefined()
      expect(JSON.stringify(r)).not.toContain(secret) // reconstructed message only
    })

    it('a coercer registered for a BUILT-IN scalar is IGNORED (no false-fire on a valid value)', () => {
      // A Boolean shadow that always throws would false-fire on a valid @skip(if:$s) variable
      // IF it were patched — the built-in guard refuses it, so $s:true stays clean.
      const q = 'query Q($s: Boolean!) { events(at: "2024-01-01") @skip(if: $s) { id } }'
      const r = validateGraphqlOperation(coercerSdl, q, {
        variables: { s: true },
        scalarCoercers: {
          Boolean: () => {
            throw new Error('shadow-fire')
          },
        },
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(true)
      expect(r.findings.filter((x) => x.kind === 'graphql-variable-invalid')).toEqual([])
    })

    it('a custom-scalar directive-arg LITERAL stays UNVERIFIED even with a coercer registered (BLOCKER-2)', () => {
      const litSdl = `
        scalar DateTime
        directive @auth(token: DateTime) on FIELD
        type Query { thing(id: Int!): Thing }
        type Thing { id: Int! }
      `
      const r = validateGraphqlOperation(
        litSdl,
        '{ thing(id: 1) @auth(token: "sk-secret") { id } }',
        {
          scalarCoercers: {
            DateTime: () => {
              throw new Error('should-never-run-on-a-literal')
            },
          },
        },
      )
      expect(r.findings).toEqual([]) // coercer never invoked on the literal (parseLiteral untouched)
      expect(r.unverified).toBe(true)
      expect(r.directiveUnverified).toBe(true)
      expect(JSON.stringify(r)).not.toContain('sk-secret')
    })

    it('an absent variable with an INVALID default literal stays SILENT (default not routed through the coercer)', () => {
      const q = 'query Q($at: DateTime! = "not-a-date") { events(at: $at) { id } }'
      const r = validateGraphqlOperation(coercerSdl, q, {
        variables: {},
        scalarCoercers: {
          DateTime: (v) => {
            if (!/^\d{4}-/.test(String(v))) throw new Error('bad')
            return v
          },
        },
        variablesAuthoritative: true,
      })
      expect(r.valid).toBe(true)
      expect(r.findings).toEqual([])
      expect(r.unverified).toBeUndefined()
    })

    it('freshness: a later call WITHOUT coercers sees the scalar back at identity (unverified)', () => {
      const c = {
        DateTime: (v: unknown) => {
          if (String(v) !== 'ok') throw new Error('bad')
          return v
        },
      }
      // Call 1: the coercer rejects an invalid value.
      const r1 = validateGraphqlOperation(coercerSdl, eventsQ, {
        variables: { at: 'bad' },
        scalarCoercers: c,
        variablesAuthoritative: true,
      })
      expect(r1.valid).toBe(false)
      // Call 2: NO coercers → DateTime is back to its identity parseValue → unverified, no finding.
      const r2 = validateGraphqlOperation(coercerSdl, eventsQ, {
        variables: { at: 'bad' },
        variablesAuthoritative: true,
      })
      expect(r2.findings).toEqual([])
      expect(r2.unverified).toBe(true)
    })
  })
})
