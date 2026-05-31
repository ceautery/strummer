// Contract constants. These MUST equal the values in schema/strummer.schema.json
// (guarded by schema.test.ts). Both languages assert them before operating on an
// index file, which is what makes the file-as-contract safe.
export const EXPECTED_SCHEMA_VERSION = 1
export const EXPECTED_EMBED_DIM = 384
export const EXPECTED_EMBED_MODEL = 'bge-small-en-v1.5'
