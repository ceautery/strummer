/**
 * The shared paired-gate + path-confinement guards for the LSP engines (ADR 0011). Factored
 * out of `query.ts` so the read engine (`LspQueryEngine`) and the write engine
 * (`LspRenameEngine`, Slice F) share one implementation — with a `resolveSymlinks` mode that
 * the WRITE path always sets.
 *
 * The read path confines the single queried file lexically (lower stakes). The write path must
 * confine EVERY file a `WorkspaceEdit` would touch, and lexically is not enough: `resolve()`
 * does not canonicalize symlinks, so a symlink INSIDE the root pointing OUTSIDE it passes a
 * prefix check and a write would clobber the out-of-root target. The write path therefore
 * `realpath`-canonicalizes the root and each target's nearest existing ancestor and re-asserts
 * containment, and refuses any non-`file://` scheme. Confinement is pure path/metadata work —
 * it runs BEFORE any target file content is read.
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Thrown when the paired operator gate denies a query/edit (allowRun off, out-of-bounds, bad scheme). */
export class LspGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspGateError'
  }
}

/** The paired deny-by-default gate: `allowRun` + the operator root allowlist. */
export function assertAllowed(
  allowRun: boolean,
  allowedRoots: string[],
  projectRoot: string,
): void {
  if (!allowRun) {
    throw new LspGateError('LSP navigation is not enabled (the operator must set allowRun)')
  }
  const root = resolve(projectRoot)
  if (!allowedRoots.map((r) => resolve(r)).includes(root)) {
    throw new LspGateError(`project root ${projectRoot} is not in the operator allowlist`)
  }
}

/** Lexical containment: `child` must equal `root` or sit beneath it. */
function assertInside(root: string, child: string, message: string): void {
  if (child !== root && !child.startsWith(root + sep)) {
    throw new LspGateError(message)
  }
}

/** Canonicalize `abs` by realpath-ing its deepest existing ancestor and re-appending the tail. */
function realpathNearest(abs: string): string {
  let existing = abs
  const tail: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break // filesystem root
    tail.unshift(basename(existing))
    existing = parent
  }
  const real = realpathSync(existing)
  return tail.length > 0 ? resolve(real, ...tail) : real
}

/**
 * Confine a project-relative-or-absolute `file` to `projectRoot`, returning the absolute path.
 * Read path: lexical (default). Write path (`resolveSymlinks: true`): additionally
 * realpath-canonicalizes the root + the target's nearest existing ancestor and re-asserts
 * containment, closing the symlink-escape hole a lexical `resolve()` misses.
 */
export function confineFile(
  projectRoot: string,
  file: string,
  opts: { resolveSymlinks?: boolean } = {},
): string {
  const root = resolve(projectRoot)
  const abs = resolve(root, file)
  assertInside(root, abs, `file ${file} escapes the project root ${projectRoot}`)
  if (opts.resolveSymlinks) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      throw new LspGateError(`project root ${projectRoot} does not exist`)
    }
    assertInside(
      realRoot,
      realpathNearest(abs),
      `file ${file} escapes the project root ${projectRoot} after symlink resolution`,
    )
  }
  return abs
}

/**
 * Confine an edited document URI (from a server `WorkspaceEdit`) to `projectRoot` for WRITING.
 * Refuses any non-`file://` scheme (`jdt://`, in-memory, untitled) and realpath-hardens the
 * target. Returns the absolute filesystem path.
 */
export function confineEditedUri(projectRoot: string, uri: string): string {
  let abs: string
  try {
    abs = fileURLToPath(uri)
  } catch {
    throw new LspGateError(`edited document ${uri} is not a file:// URI (refused for write)`)
  }
  return confineFile(projectRoot, abs, { resolveSymlinks: true })
}

/**
 * Confine EVERY edited URI to the project root, all-or-nothing — one out-of-root / `..` /
 * symlink-escape / non-`file://` URI throws before any target file is read. Returns a map from
 * each URI to its confined absolute path.
 */
export function confineEditedUris(projectRoot: string, uris: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const uri of uris) out.set(uri, confineEditedUri(projectRoot, uri))
  return out
}
