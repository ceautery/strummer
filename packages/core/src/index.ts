export { type OpenOptions, openDb, readMeta } from './db.js'
export { getDoc } from './doc.js'
export {
  type DetectedVersion,
  type DetectOptions,
  detectInstalledVersion,
  type Ecosystem,
  type VersionSource,
} from './project.js'
export {
  EXPECTED_EMBED_DIM,
  EXPECTED_EMBED_MODEL,
  EXPECTED_SCHEMA_VERSION,
} from './schema.js'
export { searchDocs } from './search.js'
export type { DocFragment, SchemaMeta, SearchOptions, SearchResult } from './types.js'
export { listVersions, resolveVersion, type VersionResolution } from './version.js'
