/**
 * Diff-scoping for the deps pillar: which dependency NAMES did a change touch?
 *
 * Pure and offline (the diff is the only input) — it builds on `@strummer/diff`'s
 * `changedFiles` as the manifest gate, then walks the diff itself block-aware. A
 * `package.json` carries `version`/`packageManager`/`scripts`/`engines` whose values
 * also *look* like versions, so a naive "changed line that looks like a dependency"
 * heuristic false-positives on `version`/`engines.node`/`packageManager`. We therefore
 * track which dependency block (`dependencies`/`devDependencies`/`peerDependencies`/
 * `optionalDependencies`) is open and only count a changed `"name": …` line inside one.
 *
 * Limitation (documented, npm v1): the enclosing dependency-block header must appear
 * within the diff (a context or changed line) — block state resets at each hunk because
 * a hunk's context is partial. For a dependency buried deep in a very large block with
 * minimal context the header may be absent and that dep missed; supply more context
 * (`git diff -U<n>`) for those. This UNDER-scopes (never invents a dependency), so a
 * caller that wants exhaustive coverage falls back to auditing the whole project when a
 * manifest changed but nothing was extracted. PyPI/Gem lockfile diffs are staged.
 */

import { changedFiles } from '@strummer/diff'
import type { OsvEcosystem } from './ecosystem.js'

/** Opens an npm dependency block: `"<block>": {`. Alternatives are distinct keys. */
const NPM_DEP_BLOCK =
  /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
/** A `"name": …` entry line (only meaningful inside an open dependency block). */
const DEP_ENTRY = /^\s*"([^"]+)"\s*:/

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** Strip a leading `a/` or `b/` prefix and any trailing tab-timestamp (POSIX diff). */
function cleanPath(raw: string): string {
  const path = raw.split('\t')[0] ?? raw
  return path.replace(/^[ab]\//, '')
}

/**
 * The dependency names whose declaration a unified diff changed, by ecosystem.
 * npm (`package.json`) only for v1; other ecosystems return `[]` (staged). Result is
 * deduped and sorted; includes prod + dev + peer + optional dependency blocks.
 */
export function changedDependencies(diff: string, ecosystem: OsvEcosystem = 'npm'): string[] {
  if (ecosystem !== 'npm') return []
  // Nothing to scope unless a package.json changed (real use of the shared primitive).
  if (!changedFiles(diff).some((p) => basename(p) === 'package.json')) return []

  const names = new Set<string>()
  let inManifest = false
  let inDepBlock = false

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.startsWith('diff --git')) {
      inManifest = false
      inDepBlock = false
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = cleanPath(line.slice(4))
      inManifest = path !== '/dev/null' && basename(path) === 'package.json'
      inDepBlock = false
      continue
    }
    if (line.startsWith('--- ')) continue
    // A hunk boundary restarts block tracking — context across hunks is not continuous.
    if (line.startsWith('@@ ')) {
      inDepBlock = false
      continue
    }
    if (!inManifest) continue

    const marker = line[0]
    if (marker === '\\') continue // "\ No newline at end of file"
    const content = line.slice(1)

    if (!inDepBlock) {
      if (NPM_DEP_BLOCK.test(content)) inDepBlock = true
      continue
    }

    // Dependency values are strings, so the first closing brace ends the block.
    if (content.trim().startsWith('}')) {
      inDepBlock = false
      continue
    }

    if (marker === '+' || marker === '-') {
      const m = DEP_ENTRY.exec(content)
      if (m?.[1]) names.add(m[1])
    }
  }

  return [...names].sort()
}
