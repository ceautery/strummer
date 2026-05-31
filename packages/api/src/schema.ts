/**
 * JSON Schema validation (draft 2020-12) via ajv. Shared by the `schema`
 * assertion source and the OpenAPI 3.1 contract validator — OpenAPI 3.1's
 * Schema Object *is* JSON Schema 2020-12, so one validator serves both.
 */
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

// ajv-formats ships CJS with `module.exports = fn` *and* `exports.default = fn`;
// under NodeNext the default import surfaces as the namespace, whose `.default`
// is the callable plugin.
const addFormats = addFormatsModule.default

/** A single schema violation, located by JSON Pointer into the instance. */
export interface SchemaError {
  /** JSON Pointer to the offending value ('' = document root). */
  instancePath: string
  message: string
}

export interface SchemaValidation {
  valid: boolean
  errors: SchemaError[]
}

// One shared instance. `strict: false` tolerates the vendor extensions (x-*)
// and assorted keywords that show up in real-world specs; `allErrors` reports
// every violation rather than bailing on the first.
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

function toError(e: ErrorObject): SchemaError {
  const where = e.instancePath || '(root)'
  const detail = e.message ?? 'is invalid'
  // Surface the failing property name for `required` errors (ajv puts it in params).
  const extra =
    e.keyword === 'required' && typeof e.params?.missingProperty === 'string'
      ? `: '${e.params.missingProperty}'`
      : ''
  return { instancePath: e.instancePath, message: `${where} ${detail}${extra}` }
}

/** Validate `data` against a JSON Schema. Never throws on data; an invalid
 * *schema* surfaces as a single error rather than propagating. */
export function validateSchema(schema: unknown, data: unknown): SchemaValidation {
  let validate: ReturnType<typeof ajv.compile>
  try {
    validate = ajv.compile(schema as object)
  } catch (err) {
    return {
      valid: false,
      errors: [{ instancePath: '', message: `invalid schema: ${(err as Error).message}` }],
    }
  }
  const valid = validate(data) as boolean
  return { valid, errors: valid ? [] : (validate.errors ?? []).map(toError) }
}
