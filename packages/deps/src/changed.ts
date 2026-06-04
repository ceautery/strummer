/**
 * Diff-scoping for the deps pillar: which dependency NAMES did a change touch?
 *
 * Pure and offline (the diff is the only input). It walks a unified diff once, selecting a
 * per-file *classifier* by basename, and unions the dependency names each classifier extracts.
 * Per ecosystem (ADR 0010 addendum):
 *   - **npm** — `package.json`: a `"name": …` entry line inside an open dependency block
 *     (`dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`); the block
 *     header guards against `version`/`engines.node`/`packageManager`/`scripts` whose values
 *     also *look* like versions.
 *   - **PyPI** — `pyproject.toml` (PEP 621 `dependencies`/`optional-dependencies` arrays +
 *     Poetry `[tool.poetry…dependencies]` tables), `requirements*.txt`, and TOML lockfiles
 *     (`uv.lock`/`poetry.lock`/`pylock.toml`: a `[[package]]` block whose name carries a change).
 *     Names are PEP 503-normalized so the manifest (`Flask_Login`) and lockfile (`flask-login`)
 *     dedupe to one.
 *   - **RubyGems** — `Gemfile` (`gem "name"`) + `Gemfile.lock` (a resolved top-level
 *     `    name (1.2.3)` spec row — concrete version, 4-space; transitive `(= …)` / `(>= …)`
 *     constraint rows and `DEPENDENCIES` rows carry an operator, so they never match).
 *
 * Two extraction models share one walk: *line-entry* (the changed `+`/`-` line itself carries
 * the name — npm/pyproject/requirements/Gemfile/Gemfile.lock) and *named-block* (a TOML
 * `[[package]]` block whose `name = …` may be an unchanged context line while a `version` line
 * changes — the lockfiles).
 *
 * Limitation (documented, shared with the npm walker): block/section state resets at each hunk
 * because a hunk's context is partial. A dependency whose enclosing block header (or, for a
 * lockfile, its `name` line) falls outside the diff context is missed; supply more context
 * (`git diff -U<n>`). This always UNDER-scopes (never invents a dependency), so a caller wanting
 * exhaustive coverage falls back to auditing the whole project when a manifest changed but
 * nothing was extracted. (Staged: `Pipfile.lock`/`Pipfile`; PEP 751 entries with an omitted
 * version fold to no-signal downstream.)
 */

import type { OsvEcosystem } from './ecosystem.js'
import { normalizePypiName } from './pypi.js'

type Marker = '+' | '-' | ' '

/** A per-file extractor: fed every diff line of one file, drains the names it found. */
interface Classifier {
  /** Hunk boundary — context is no longer continuous; reset block/section state. */
  reset(): void
  /** One diff body line of this file (`marker` is `' '` for an unchanged context line). */
  feed(marker: Marker, content: string): void
  /** Drain the accumulated names (also finalizes any pending block). */
  take(): string[]
}

/** Selects the classifier factory for a file path, or `undefined` if the file is irrelevant. */
type ProfileSelector = (path: string) => (() => Classifier) | undefined

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** Strip a leading `a/` or `b/` prefix and any trailing tab-timestamp (POSIX diff). */
function cleanPath(raw: string): string {
  const path = raw.split('\t')[0] ?? raw
  return path.replace(/^[ab]\//, '')
}

// ---------------------------------------------------------------------------------------------
// npm — `package.json` (behavior-preserving port of the original walker).
// ---------------------------------------------------------------------------------------------

/** Opens an npm dependency block: `"<block>": {`. Alternatives are distinct keys. */
const NPM_DEP_BLOCK =
  /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
/** A `"name": …` entry line (only meaningful inside an open dependency block). */
const DEP_ENTRY = /^\s*"([^"]+)"\s*:/

function npmClassifier(): Classifier {
  const names: string[] = []
  let inBlock = false
  return {
    reset() {
      inBlock = false
    },
    feed(marker, content) {
      if (!inBlock) {
        if (NPM_DEP_BLOCK.test(content)) inBlock = true
        return
      }
      // Dependency values are strings, so the first closing brace ends the block.
      if (content.trim().startsWith('}')) {
        inBlock = false
        return
      }
      if (marker !== ' ') {
        const m = DEP_ENTRY.exec(content)
        if (m?.[1]) names.push(m[1])
      }
    },
    take: () => names.splice(0),
  }
}

// ---------------------------------------------------------------------------------------------
// PyPI — pyproject.toml, requirements*.txt, TOML lockfiles.
// ---------------------------------------------------------------------------------------------

/** The PEP 508 distribution name at the head of a requirement (`flask[async]>=2` → `flask`). */
function pep508Name(requirement: string): string | undefined {
  return /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement.trim())?.[1]
}

/** Poetry dependency-table sections whose `key = …` lines are dependency names. */
function isPoetryDepsSection(section: string): boolean {
  return (
    section === 'tool.poetry.dependencies' ||
    section === 'tool.poetry.dev-dependencies' ||
    /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)
  )
}

/**
 * `pyproject.toml`: tracks the current `[section]` and whether we're inside a requirement-string
 * array (PEP 621 `dependencies` / any `[project.optional-dependencies]` extra), emitting names
 * only from CHANGED lines. Poetry tables emit each changed `key = …` (skipping `python`).
 */
function pyprojectClassifier(): Classifier {
  const names: string[] = []
  let section = ''
  let inReqArray = false // inside an array whose items are PEP 508 requirement strings
  let inIgnoredArray = false // inside some other array we must consume but not read

  const pushQuoted = (content: string) => {
    for (const m of content.matchAll(/["']([^"']+)["']/g)) {
      const n = pep508Name(m[1] ?? '')
      if (n) names.push(normalizePypiName(n))
    }
  }
  // A `]` outside any quote closes the array (`"coverage[toml]>=7"` is not a close).
  const closesArray = (content: string) =>
    content.replace(/(["'])(?:(?!\1).)*\1/g, '').includes(']')

  return {
    reset() {
      section = ''
      inReqArray = false
      inIgnoredArray = false
    },
    feed(marker, content) {
      const trimmed = content.trim()

      if (inReqArray || inIgnoredArray) {
        if (marker !== ' ' && inReqArray) pushQuoted(content)
        if (closesArray(trimmed)) {
          inReqArray = false
          inIgnoredArray = false
        }
        return
      }

      // A section header retargets the region (and can't sit inside an array).
      const header = /^\[([^[\]]+)\]$/.exec(trimmed)
      if (header) {
        section = header[1] ?? ''
        return
      }

      // `key = [ … ]` opens an array. Is it a requirement array we care about?
      const arrayOpen = /^([A-Za-z0-9_.-]+)\s*=\s*\[(.*)$/.exec(trimmed)
      if (arrayOpen) {
        const key = arrayOpen[1] ?? ''
        const rest = arrayOpen[2] ?? ''
        const wanted =
          (key === 'dependencies' && (section === '' || section === 'project')) ||
          section === 'project.optional-dependencies'
        if (closesArray(rest)) {
          // Inline single-line array — read it here, stay out of array state.
          if (wanted && marker !== ' ') pushQuoted(rest)
        } else if (wanted) {
          inReqArray = true
        } else {
          inIgnoredArray = true
        }
        return
      }

      // Poetry dependency tables: a changed `key = …` line is a dependency (python excluded).
      if (isPoetryDepsSection(section) && marker !== ' ') {
        const m = /^([A-Za-z0-9_.-]+)\s*=/.exec(trimmed)
        if (m?.[1] && m[1].toLowerCase() !== 'python') names.push(normalizePypiName(m[1]))
      }
    },
    take: () => names.splice(0),
  }
}

/** `requirements*.txt`: every changed non-option, non-URL line is a requirement. */
function requirementsClassifier(): Classifier {
  const names: string[] = []
  return {
    reset() {},
    feed(marker, content) {
      if (marker === ' ') return
      const line = (content.split('#')[0] ?? '').trim()
      if (!line || line.startsWith('-')) return // blanks + options (-r, -e, --hash)
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) return // a bare URL requirement
      const n = pep508Name(line)
      if (n) names.push(normalizePypiName(n))
    },
    take: () => names.splice(0),
  }
}

/**
 * A TOML lockfile (`uv.lock`/`poetry.lock`/`pylock.toml`): a `[[package]]` (or `[[packages]]`)
 * block carries `name = "…"`; emit the name when the block contains any changed line — the
 * `version` bump that changed it may itself be the only `+`/`-` line while `name` is context.
 */
function tomlLockClassifier(): Classifier {
  const names: string[] = []
  let blockName: string | undefined
  let touched = false

  const flush = () => {
    if (touched && blockName) names.push(normalizePypiName(blockName))
    blockName = undefined
    touched = false
  }

  return {
    reset() {
      flush()
    },
    feed(marker, content) {
      const trimmed = content.trim()
      if (/^\[\[(?:package|packages)\]\]$/.test(trimmed)) {
        flush()
        if (marker !== ' ') touched = true
        return
      }
      const nameLine = /^name\s*=\s*["']([^"']+)["']/.exec(trimmed)
      if (nameLine?.[1] && blockName === undefined) blockName = nameLine[1]
      if (marker !== ' ') touched = true
    },
    take() {
      flush()
      return names.splice(0)
    },
  }
}

const pypiProfile: ProfileSelector = (path) => {
  const base = basename(path)
  if (base === 'pyproject.toml') return pyprojectClassifier
  if (/^requirements.*\.txt$/.test(base)) return requirementsClassifier
  if (base === 'uv.lock' || base === 'poetry.lock' || base === 'pylock.toml') {
    return tomlLockClassifier
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// RubyGems — Gemfile, Gemfile.lock.
// ---------------------------------------------------------------------------------------------

/** A `gem "name"` declaration in a Gemfile. */
const GEMFILE_GEM = /^\s*gem\s+['"]([^'"]+)['"]/
/**
 * A resolved top-level spec row in a Gemfile.lock `specs:` list: exactly 4 leading spaces, a
 * concrete version `(1.2.3)`. Transitive deps are 6-space and `DEPENDENCIES`/constraint rows
 * carry an operator (`(= …)`, `(>= …)`, `(~> …)`), so a digit immediately after `(` excludes them.
 */
const GEMLOCK_SPEC = /^ {4}([A-Za-z0-9._-]+) \([0-9][^)]*\)$/

function gemfileClassifier(): Classifier {
  const names: string[] = []
  return {
    reset() {},
    feed(marker, content) {
      if (marker === ' ') return
      const m = GEMFILE_GEM.exec(content)
      if (m?.[1]) names.push(m[1])
    },
    take: () => names.splice(0),
  }
}

function gemlockClassifier(): Classifier {
  const names: string[] = []
  return {
    reset() {},
    feed(marker, content) {
      if (marker === ' ') return
      const m = GEMLOCK_SPEC.exec(content)
      if (m?.[1]) names.push(m[1])
    },
    take: () => names.splice(0),
  }
}

const rubygemsProfile: ProfileSelector = (path) => {
  const base = basename(path)
  if (base === 'Gemfile') return gemfileClassifier
  if (base === 'Gemfile.lock') return gemlockClassifier
  return undefined
}

// ---------------------------------------------------------------------------------------------

const npmProfile: ProfileSelector = (path) =>
  basename(path) === 'package.json' ? npmClassifier : undefined

const PROFILES: Record<OsvEcosystem, ProfileSelector> = {
  npm: npmProfile,
  PyPI: pypiProfile,
  RubyGems: rubygemsProfile,
}

/**
 * The dependency names whose declaration a unified diff changed, by ecosystem (npm/PyPI/
 * RubyGems). Result is deduped and sorted; PyPI names are PEP 503-normalized. Always
 * under-scopes (never invents a dependency) — see the module note.
 */
export function changedDependencies(diff: string, ecosystem: OsvEcosystem = 'npm'): string[] {
  const select = PROFILES[ecosystem]
  const names = new Set<string>()
  let classifier: Classifier | undefined

  const finalize = () => {
    if (classifier) for (const n of classifier.take()) names.add(n)
    classifier = undefined
  }

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.startsWith('diff --git')) {
      finalize()
      continue
    }
    if (line.startsWith('+++ ')) {
      finalize()
      const path = cleanPath(line.slice(4))
      const factory = path === '/dev/null' ? undefined : select(path)
      classifier = factory?.()
      continue
    }
    if (line.startsWith('--- ')) continue
    if (line.startsWith('@@ ')) {
      classifier?.reset()
      continue
    }
    if (!classifier) continue

    const marker = line[0]
    if (marker === '\\') continue // "\ No newline at end of file"
    const m: Marker = marker === '+' || marker === '-' ? marker : ' '
    classifier.feed(m, line.slice(1))
  }
  finalize()

  return [...names].sort()
}
