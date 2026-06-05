#!/usr/bin/env node
// SLICE 10 (ADR 0019) — artifact-level lazy boundary, build-then-assert (NOT in `pnpm gate`).
//
// The aggregate `sackville-mcp` must keep every NATIVE/heavy dependency out of the code that
// runs at process start: a bare `npx -y sackville-mcp` (api+deps+verify) must not load
// playwright-core / better-sqlite3 / onnxruntime / transformers, and must not even require
// the heavy OPTIONAL-PEER packages to be installed. tsdown achieves this by emitting an
// `await import()` per pillar — so the heavy specifiers live ONLY in dynamically-loaded
// chunks, never in the static-import closure reachable from an entry.
//
// This script proves it on the emitted `.mjs`: starting from each entry, it follows ONLY
// static `import`/`export … from "./relative"` edges (NOT `import("…")`), and asserts no file
// in that closure statically imports a forbidden specifier. Run AFTER `pnpm -r build`.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'packages/mcp/dist')

// The native/heavy npm packages + the heavy WORKSPACE optional-peers. None may be reachable
// via a STATIC import from an aggregate entry (they belong in await-import chunks only).
const FORBIDDEN = [
  // native / heavy npm deps (transitively dragged in by the engines below)
  'playwright-core',
  'lighthouse',
  'chrome-launcher',
  'better-sqlite3',
  'onnxruntime-node',
  'sqlite-vec',
  'pixelmatch',
  'pngjs',
  '@huggingface/transformers',
  '@xenova/transformers',
  'fastembed',
  // heavy optional-peer workspace packages (their install pulls the native closure)
  '@sackville-mcp/browser',
  '@sackville-mcp/core',
  '@sackville-mcp/embed',
  '@sackville-mcp/flake',
]

// The entry whose STARTUP closure must stay native-free: `bin.mjs`, the AGGREGATE server
// (`npx -y sackville-mcp`). This is the install-isolation surface — a bare `npm i sackville-mcp`
// (api+deps+verify) must start without the heavy optional peers installed.
//
// DELIBERATELY NOT checked: `index.mjs` is the programmatic library BARREL that intentionally
// re-exports every pillar (so it statically pulls them — a programmatic consumer installs what
// it imports); and the per-pillar bins (`bin-browser.mjs` → playwright, etc.) legitimately
// static-import their own engine. Only the aggregate server bin must defer.
const ENTRIES = ['bin.mjs']

/** Static `import`/`export … from "X"` and side-effect `import "X"` specifiers in a chunk.
 * Deliberately does NOT match dynamic `import("X")` — that is the lazy boundary we rely on. */
function staticSpecifiers(source) {
  const specs = []
  // A dynamic import has `(` immediately after `import`, so `[^(\n]*?` before `from` excludes it.
  const fromRe = /^[ \t]*(?:import|export)\b[^(\n]*?\bfrom\s*["']([^"']+)["']/gm
  const sideRe = /^[ \t]*import\s*["']([^"']+)["']/gm
  for (const m of source.matchAll(fromRe)) specs.push(m[1])
  for (const m of source.matchAll(sideRe)) specs.push(m[1])
  return specs
}

const violations = []
const visited = new Set()

function walk(file, fromChain) {
  if (visited.has(file)) return
  visited.add(file)
  let source
  try {
    source = readFileSync(join(distDir, file), 'utf8')
  } catch {
    return // a bare/external target that isn't an emitted chunk — a leaf, not ours to walk
  }
  for (const spec of staticSpecifiers(source)) {
    if (FORBIDDEN.includes(spec)) {
      violations.push({ file, spec, chain: [...fromChain, file] })
    }
    if (spec.startsWith('./')) walk(spec.slice(2), [...fromChain, file])
    else if (spec.startsWith('../')) walk(spec, [...fromChain, file]) // shouldn't occur in a flat dist
  }
}

for (const entry of ENTRIES) walk(entry, [])

// Sanity 1: the closure must be non-trivial (parsing actually worked).
if (visited.size < 2) {
  console.error(`✘ lazy-boundary: static closure too small (${visited.size}) — parsing likely broke`)
  process.exit(2)
}

// Sanity 2: the forbidden specifiers must still appear SOMEWHERE in dist (a lazy chunk), else a
// build change could make this assertion pass vacuously (nothing heavy is bundled at all).
const distText = readdirSync(distDir)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => readFileSync(join(distDir, f), 'utf8'))
  .join('\n')
const presentSomewhere = FORBIDDEN.filter((s) => distText.includes(`"${s}"`) || distText.includes(`'${s}'`))
if (presentSomewhere.length === 0) {
  console.error('✘ lazy-boundary: no forbidden specifier appears anywhere in dist — refusing a')
  console.error('  vacuous pass (did the build emit chunks? did the heavy pillars get bundled?).')
  process.exit(2)
}

if (violations.length > 0) {
  console.error('✘ lazy-boundary VIOLATION — native/heavy specifier in the static startup closure:')
  for (const v of violations) {
    console.error(`  - ${v.spec} statically imported by ${v.file}`)
    console.error(`    via: ${v.chain.join(' → ')}`)
  }
  console.error('\nMove the import behind `await import()` so it loads only when that pillar is enabled.')
  process.exit(1)
}

console.log(
  `✓ lazy boundary holds: ${visited.size} chunks in the static startup closure, ` +
    `0 native/heavy specifiers (checked ${FORBIDDEN.length}, ${presentSomewhere.length} present in lazy chunks).`,
)
console.log(`  entries: ${ENTRIES.join(', ')}`)
