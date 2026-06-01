export {
  type AuditDependencyInput,
  auditDependency,
  type BehindBy,
  type DependencyAudit,
  type FreshnessVerdict,
} from './audit.js'
export {
  type ChangelogEntry,
  type ChangelogSlice,
  type SliceOptions,
  sliceChangelog,
} from './changelog.js'
export { semverComparator, type VersionComparator } from './comparator.js'
export { cvssV3BaseScore } from './cvss.js'
export {
  auditDeprecation,
  type DeprecationScope,
  type DeprecationVerdict,
  type Packument,
  type PackumentVersion,
} from './deprecation.js'
export {
  matchVulnerabilities,
  type OsvAdvisory,
  type OsvAffected,
  type OsvEvent,
  type OsvRange,
  type OsvSeverity,
  type SeverityBucket,
  type VulnerabilityMatch,
} from './osv.js'
export { pep440Comparator } from './pep440.js'
export { loadOsvSnapshot, type OsvSnapshot } from './snapshot.js'
