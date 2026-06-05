import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Robust "is this module the process entry point?" check that SURVIVES SYMLINK
 * invocation.
 *
 * npm/npx install a package's bins as SYMLINKS in `node_modules/.bin`. When such a
 * bin runs, Node realpaths the entry for `import.meta.url` (→ the real `dist/bin.mjs`)
 * but leaves `process.argv[1]` as the symlink path. So the naive guard
 * `import.meta.url === pathToFileURL(process.argv[1]).href` is FALSE under `npx`/`.bin`,
 * and the server-start block silently never runs (the bin appears to do nothing).
 *
 * Comparing the REALPATHS of both sides closes that gap: a symlinked `argv[1]` and the
 * realpath'd module URL resolve to the same file, while an importing test (whose
 * `argv[1]` is the test runner) still does not match — so importing a bin module never
 * starts its server.
 */
export function isMainModule(metaUrl: string): boolean {
  const arg = process.argv[1]
  if (arg === undefined) return false
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}
