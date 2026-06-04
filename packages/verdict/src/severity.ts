/**
 * The verdict severity scale now lives in the shared zero-dep `@strummer/severity`
 * leaf (extracted out of deps so the verdict scale and deps' `SeverityBucket` share
 * ONE source of truth for the four qualitative buckets — see that package for why
 * `none` and deps' `unknown` stay distinct). This module re-exports it so verdict's
 * internal `./severity.js` imports and its public surface are unchanged.
 */
export {
  atLeast,
  maxSeverity,
  QUALITATIVE_RANK,
  type QualitativeSeverity,
  SEVERITY_RANK,
  type Severity,
} from '@strummer/severity'
