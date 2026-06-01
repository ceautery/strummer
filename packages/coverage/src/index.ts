export { type DiffFile, parseUnifiedDiff } from './diff.js'
export {
  type DiffCoverageFile,
  type DiffCoverageReport,
  type UncoveredInDiffOptions,
  uncoveredInDiff,
} from './report.js'
export {
  CoverageGateError,
  defaultVitestRunner,
  type RunScopedConfig,
  runScoped,
  type ScopedRunInput,
  type ScopedRunResult,
  type TestRunner,
} from './run.js'
export {
  type ClassifiedLine,
  type FileCoverage,
  type IstanbulPosition,
  type IstanbulRange,
  type LineState,
  type UncoveredNewLines,
  uncoveredNewLines,
} from './uncovered.js'
