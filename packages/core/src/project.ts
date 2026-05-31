import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Package ecosystems Strummer can detect an installed version in. */
export type Ecosystem = 'node' | 'python' | 'ruby'

/** Where a detected version came from (most authoritative first, per ecosystem). */
export type VersionSource =
  | 'node_modules'
  | 'package-lock.json'
  | 'package.json'
  | 'python:dist-info'
  | 'python:lock'
  | 'python:requirements'
  | 'python:pyproject'
  | 'ruby:Gemfile.lock'
  | 'ruby:Gemfile'
  | 'none'

export interface DetectedVersion {
  /** Concrete installed version, or a declared range/constraint, or null. */
  version: string | null
  source: VersionSource
}

export interface DetectOptions {
  /** Restrict detection to one ecosystem. Omit to auto-probe node → python → ruby. */
  ecosystem?: Ecosystem
}

const NONE: DetectedVersion = { version: null, source: 'none' }

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  const text = readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Detect the installed version of a package in a project directory.
 *
 * With an explicit `ecosystem`, runs only that detector. Otherwise auto-probes
 * node → python → ruby and returns the first hit. Each ecosystem prefers the
 * concrete installed version, then a lockfile, then the declared range — the
 * result feeds `resolveVersion`, which accepts concrete versions and ranges.
 */
export function detectInstalledVersion(
  projectDir: string,
  pkg: string,
  opts: DetectOptions = {},
): DetectedVersion {
  const detectors: Record<Ecosystem, (d: string, p: string) => DetectedVersion> = {
    node: detectNode,
    python: detectPython,
    ruby: detectRuby,
  }
  if (opts.ecosystem) return detectors[opts.ecosystem](projectDir, pkg)
  for (const eco of ['node', 'python', 'ruby'] as const) {
    const found = detectors[eco](projectDir, pkg)
    if (found.version !== null) return found
  }
  return NONE
}

// ── Node ────────────────────────────────────────────────────────────────────

function depRange(manifest: Record<string, unknown>, pkg: string): string | undefined {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = manifest[field] as Record<string, string> | undefined
    if (deps?.[pkg]) return deps[pkg]
  }
  return undefined
}

function detectNode(dir: string, pkg: string): DetectedVersion {
  const installed = readJson(join(dir, 'node_modules', pkg, 'package.json'))
  if (typeof installed?.version === 'string') {
    return { version: installed.version, source: 'node_modules' }
  }

  const lock = readJson(join(dir, 'package-lock.json'))
  if (lock) {
    const packages = lock.packages as Record<string, { version?: string }> | undefined
    const deps = lock.dependencies as Record<string, { version?: string }> | undefined
    const locked = packages?.[`node_modules/${pkg}`]?.version ?? deps?.[pkg]?.version
    if (locked) return { version: locked, source: 'package-lock.json' }
  }

  const manifest = readJson(join(dir, 'package.json'))
  if (manifest) {
    const range = depRange(manifest, pkg)
    if (range) return { version: range, source: 'package.json' }
  }

  return NONE
}

// ── Python ───────────────────────────────────────────────────────────────────

/** PEP 503 name normalization: lowercase, runs of `-_.` collapse to a single `-`. */
function canonPy(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** Candidate site-packages roots inside a project's virtualenv(s). */
function sitePackagesDirs(dir: string): string[] {
  const out: string[] = []
  for (const venv of ['.venv', 'venv', 'env']) {
    const lib = join(dir, venv, 'lib')
    for (const py of readdirSafe(lib)) {
      if (py.startsWith('python')) out.push(join(lib, py, 'site-packages'))
    }
    out.push(join(dir, venv, 'Lib', 'site-packages')) // Windows layout
  }
  return out
}

function pythonDistInfo(dir: string, want: string): string | undefined {
  for (const sp of sitePackagesDirs(dir)) {
    for (const entry of readdirSafe(sp)) {
      if (!entry.endsWith('.dist-info')) continue
      const meta = readText(join(sp, entry, 'METADATA'))
      if (!meta) continue
      const name = /^Name:\s*(.+)$/m.exec(meta)?.[1]?.trim()
      const version = /^Version:\s*(.+)$/m.exec(meta)?.[1]?.trim()
      if (name && version && canonPy(name) === want) return version
    }
  }
  return undefined
}

/** uv.lock / poetry.lock: `[[package]]` blocks with `name`/`version`. */
function tomlLockVersion(text: string, want: string): string | undefined {
  for (const block of text.split('[[package]]')) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1]
    if (!name || canonPy(name) !== want) continue
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1]
    if (version) return version
  }
  return undefined
}

/** Pipfile.lock (JSON): `default`/`develop` → `{ pkg: { version: "==x.y" } }`. */
function pipfileLockVersion(text: string, want: string): string | undefined {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  for (const section of ['default', 'develop']) {
    const deps = json[section] as Record<string, { version?: string }> | undefined
    if (!deps) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (canonPy(name) === want && typeof spec?.version === 'string') {
        return spec.version.replace(/^==/, '').trim()
      }
    }
  }
  return undefined
}

/** Parse a PEP 508 requirement spec into name + constraint (markers dropped). */
function pep508(spec: string): { name: string; constraint: string } | undefined {
  const m = /^([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(spec.trim())
  if (!m?.[1]) return undefined
  return { name: m[1], constraint: (m[2] ?? '').split(';')[0]?.trim() ?? '' }
}

function requirementsVersion(text: string, want: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = (raw.split('#')[0] ?? '').trim()
    if (!line || line.startsWith('-')) continue // skip blanks + options (-r, --hash, …)
    const parsed = pep508(line)
    if (!parsed || canonPy(parsed.name) !== want) continue
    if (parsed.constraint.startsWith('==')) return parsed.constraint.slice(2).trim()
    return parsed.constraint || '*'
  }
  return undefined
}

function pyprojectVersion(text: string, want: string): string | undefined {
  // PEP 621 [project] dependencies = ["pkg>=1", …]
  const arr = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1]
  if (arr) {
    for (const m of arr.matchAll(/["']([^"']+)["']/g)) {
      const parsed = m[1] ? pep508(m[1]) : undefined
      if (parsed && canonPy(parsed.name) === want) return parsed.constraint || '*'
    }
  }
  // Poetry [tool.poetry.dependencies] pkg = "^1.0"
  const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1]
  if (poetry) {
    for (const raw of poetry.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/.exec(raw)
      if (m?.[1] && canonPy(m[1]) === want) return m[2] ?? '*'
    }
  }
  return undefined
}

function detectPython(dir: string, pkg: string): DetectedVersion {
  const want = canonPy(pkg)

  const installed = pythonDistInfo(dir, want)
  if (installed) return { version: installed, source: 'python:dist-info' }

  for (const lock of ['uv.lock', 'poetry.lock']) {
    const text = readText(join(dir, lock))
    const version = text && tomlLockVersion(text, want)
    if (version) return { version, source: 'python:lock' }
  }
  const pipfile = readText(join(dir, 'Pipfile.lock'))
  const pipfileVersion = pipfile && pipfileLockVersion(pipfile, want)
  if (pipfileVersion) return { version: pipfileVersion, source: 'python:lock' }

  const req = readText(join(dir, 'requirements.txt'))
  const reqVersion = req && requirementsVersion(req, want)
  if (reqVersion) return { version: reqVersion, source: 'python:requirements' }

  const pyproject = readText(join(dir, 'pyproject.toml'))
  const pyprojectVer = pyproject && pyprojectVersion(pyproject, want)
  if (pyprojectVer) return { version: pyprojectVer, source: 'python:pyproject' }

  return NONE
}

// ── Ruby ──────────────────────────────────────────────────────────────────────

function detectRuby(dir: string, pkg: string): DetectedVersion {
  const want = pkg.toLowerCase()

  const lock = readText(join(dir, 'Gemfile.lock'))
  if (lock) {
    // Top-level resolved specs are indented exactly four spaces: `    name (x.y.z)`.
    for (const m of lock.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)/gm)) {
      if (m[1]?.toLowerCase() === want) return { version: m[2] ?? '', source: 'ruby:Gemfile.lock' }
    }
  }

  const gemfile = readText(join(dir, 'Gemfile'))
  if (gemfile) {
    const re = new RegExp(`gem\\s+['"]${escapeRe(pkg)}['"]\\s*(?:,\\s*['"]([^'"]+)['"])?`, 'i')
    const m = re.exec(gemfile)
    if (m) return { version: m[1] ?? '*', source: 'ruby:Gemfile' }
  }

  return NONE
}
