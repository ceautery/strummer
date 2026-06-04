export {
  type AuditDependencyInput,
  auditDependency,
  type BehindBy,
  type DependencyAudit,
  type FreshnessVerdict,
} from './audit.js'
export { changedDependencies } from './changed.js'
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
  comparatorFor,
  dependencyNames,
  matchName,
  OSV_ECOSYSTEMS,
  type OsvEcosystem,
} from './ecosystem.js'
export { gemComparator } from './gem.js'
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
export {
  normalizePypiName,
  type PyPiJson,
  type PyPiReleaseFile,
  pypiJsonToPackument,
  pythonManifestNames,
} from './pypi.js'
export {
  CHANGELOG_FILENAMES,
  gemRepoUrl,
  githubOwnerRepo,
  npmRepoUrl,
  pypiRepoUrl,
  type RubyGemMetadata,
} from './repo.js'
export { type RubyGemsVersion, rubygemsToPackument, rubyManifestNames } from './rubygems.js'
export { loadOsvSnapshot, type OsvSnapshot } from './snapshot.js'
