/**
 * PyPI registry adaptation (ADR 0012). Two pure pieces the PyPI audit path needs:
 *
 *   - {@link normalizePypiName}: PEP 503 name normalization (lowercase, runs of `-_.` → `-`).
 *     OSV stores PyPI advisory package names in this normalized form, so the queried name must
 *     be normalized before matching. (It is identical to `@strummer/core`'s internal `canonPy`,
 *     which already normalizes for version *detection* — repeated here so the OSV-matching name
 *     is normalized without a core dependency.)
 *   - {@link pypiJsonToPackument}: map the PyPI JSON API (`/pypi/<project>/json`) response into
 *     the internal {@link Packument} shape the freshness core consumes. PyPI has no npm-style
 *     per-version deprecation, so `deprecated` is simply absent (no false signal).
 *
 * The actual HTTP fetch is injected at the bin layer (SSRF-pinned, network-gated); this module
 * is pure so it stays offline/deterministic in the gate.
 */

import type { Packument, PackumentVersion } from './deprecation.js'

/** Normalize a PyPI project name per PEP 503. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** One file record under a release in the PyPI JSON API (only `yanked` is read). */
export interface PyPiReleaseFile {
  yanked?: boolean
}

/** The subset of the PyPI JSON API response we read. */
export interface PyPiJson {
  info?: {
    name?: string
    version?: string
    /** Free-form label→URL map (`Source`/`Repository`/`Homepage`…); mined for the source repo. */
    project_urls?: Record<string, string>
  }
  /** version string → its uploaded files (empty when a version has no upload). */
  releases?: Record<string, PyPiReleaseFile[]>
}

/** The PEP 508 distribution name at the head of a requirement (`flask[async]>=2` → `flask`). */
function pep508Name(requirement: string): string | undefined {
  return /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement.trim())?.[1]
}

function namesFromPyproject(toml: string, includeDev: boolean): string[] {
  const names: string[] = []
  const quoted = (block: string) => {
    for (const m of block.matchAll(/["']([^"']+)["']/g)) {
      const n = pep508Name(m[1] ?? '')
      if (n) names.push(n)
    }
  }
  // PEP 621 [project].dependencies = ["flask>=2", …]
  const deps = /(?:^|\n)dependencies\s*=\s*\[([\s\S]*?)\]/.exec(toml)?.[1]
  if (deps) quoted(deps)
  if (includeDev) {
    // PEP 621 [project.optional-dependencies] — a table of arrays.
    const opt = /\[project\.optional-dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1]
    if (opt) quoted(opt)
  }
  // Poetry: main deps always; group deps (dev/test/…) only when includeDev. Skip `python`.
  const poetryLines = (block: string) => {
    for (const raw of block.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*=/.exec(raw)
      if (m?.[1] && m[1].toLowerCase() !== 'python') names.push(m[1])
    }
  }
  const main = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1]
  if (main) poetryLines(main)
  if (includeDev) {
    for (const m of toml.matchAll(
      /\[tool\.poetry\.group\.[A-Za-z0-9_-]+\.dependencies\]([\s\S]*?)(?:\n\[|$)/g,
    )) {
      poetryLines(m[1] ?? '')
    }
  }
  return names
}

function namesFromRequirements(txt: string): string[] {
  const names: string[] = []
  for (const raw of txt.split(/\r?\n/)) {
    const line = (raw.split('#')[0] ?? '').trim()
    if (!line || line.startsWith('-')) continue // blanks + options (-r, -e, --hash)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue // a bare URL requirement
    const n = pep508Name(line)
    if (n) names.push(n)
  }
  return names
}

/**
 * Enumerate the declared top-level dependency NAMES of a Python project (the PyPI analogue of
 * reading npm `package.json` deps), PEP 503-normalized + deduped + sorted. Prefers `pyproject.toml`
 * (PEP 621 `[project]` + Poetry `[tool.poetry]`); falls back to `requirements.txt` when pyproject
 * declares none. `includeDev` adds PEP 621 optional-dependencies + Poetry group deps. Pure.
 */
export function pythonManifestNames(
  sources: { pyproject?: string; requirements?: string },
  opts: { includeDev?: boolean } = {},
): string[] {
  const includeDev = opts.includeDev ?? true
  let raw: string[] = []
  if (sources.pyproject) raw = namesFromPyproject(sources.pyproject, includeDev)
  if (raw.length === 0 && sources.requirements) raw = namesFromRequirements(sources.requirements)
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of raw) {
    const norm = normalizePypiName(n)
    if (!seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  return out.sort()
}

/**
 * Map a PyPI JSON API response into a {@link Packument}. A release is kept only when it has at
 * least one non-yanked file (a fully-yanked or upload-less version is not installable, so it
 * must not become `latest` or an upgrade candidate). `dist-tags.latest` is PyPI's own
 * `info.version`; freshness still re-derives the newest stable with the PEP 440 comparator.
 */
export function pypiJsonToPackument(json: PyPiJson): Packument {
  const versions: Record<string, PackumentVersion> = {}
  for (const [version, files] of Object.entries(json.releases ?? {})) {
    if (!files.some((f) => !f.yanked)) continue
    versions[version] = { version }
  }
  const packument: Packument = { name: json.info?.name ?? '', versions }
  const latest = json.info?.version
  if (latest !== undefined) packument['dist-tags'] = { latest }
  return packument
}
