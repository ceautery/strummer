/**
 * The gated LSP rename engine (ADR 0011 write-mode addendum, Slices F + F′). The first WRITE
 * surface of the pillar. It mirrors `LspQueryEngine` but layers a SECOND operator gate —
 * `allowWrite` — on top of the read gate (`allowRun` + `allowedRoots`): rename is **dry-run by
 * default** (compute + preview, ZERO disk writes) and applies to disk only when `allowWrite` is
 * set AND every safety condition holds.
 *
 * Apply is a separate phase from compute (it may need more locks than the compute phase held).
 * Single- AND multi-file edits apply, the latter under the manager's multi-URI lock (sorted,
 * deadlock-free) held across the whole stage→commit→`didChange` window. Every touched file is
 * confined to the root group (realpath, all-or-nothing) BEFORE any I/O. Resource operations
 * (CreateFile/RenameFile/DeleteFile) APPLY in `documentChanges` order interleaved with text edits;
 * the replay runs over a per-file `Fate` VFS keyed by ORIGINAL uri, so content flows through a
 * rename (an edit to a renamed file's new path composes onto the carried content) and net-no-op
 * batches (create-then-delete) drop out. `ignoreIfExists`/`ignoreIfNotExists` are conditional
 * no-ops. `overwrite` (Create/Rename truncate-and-replace of an EXISTING regular file) APPLIES only
 * behind the separate operator `allowDestructiveResourceOps` gate, auditing the clobbered bytes and
 * surfacing `overwritten[]`; a symlink/directory target, recursive/directory delete, `overwrite` on
 * a delete, and genuinely ambiguous batches (a rename cycle, two renames into one target, editing a
 * renamed-away path, deleting a path that is also a rename/create target) all stay refused. A
 * mid-commit fault is terminal (`partial`).
 *
 * The adversarial corrections baked in here: oldText is sliced with absolute offsets (never
 * reconstructed from line:col); apply is staleness-guarded (the queried file vs its compute hash;
 * each on-disk edit site vs the old identifier — a not-yet-on-disk rename target is skipped, so an
 * import fix-up in a moved file never trips it) then stage-then-commit (the injected writer);
 * out-of-root edits never have their bytes read/surfaced; the post-commit `didChange`/`didFileRename`
 * doc-sync runs inside the held lock(s) and carries the bytes that ACTUALLY landed (pristine on a
 * partial commit, never the projected edit); secrets are redacted in every surfaced hunk.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyTextEdits, isPlausibleRenameName } from './apply.js'
import type { NavResult, ServerInfo } from './client.js'
import { assertAllowed, confineEditedUriToRoots, confineFile, LspGateError } from './confine.js'
import {
  fromLspPosition,
  lspPositionToOffset,
  type PositionEncoding,
  toLspPosition,
} from './encoding.js'
import type { LanguageServerManager } from './manager.js'
import type {
  LspRange,
  NormalizedFileEdit,
  NormalizedResourceOp,
  NormalizedWorkspaceEdit,
  QueryStatus,
} from './normalize.js'
import type { HumanRange } from './query.js'

/** Reads a file's text, or `undefined` if it cannot be read. */
export type FileReader = (absolutePath: string) => string | undefined

const defaultReadFile: FileReader = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Lists candidate source files (absolute paths) under the allowlisted root group to scan for the
 * partial-rename completeness guard — same-language source only (`extension`, e.g. `.py`). Injected
 * so the gate never walks a real tree; `truncated` ⇒ a cap was hit and the scan is not exhaustive.
 */
export type ProjectFileLister = (
  roots: string[],
  opts: { extension: string },
) => { files: string[]; truncated: boolean }

// Directories never worth scanning for source references (deps, VCS, caches, build output).
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.env',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  'target',
  '.idea',
  '.vscode',
])
const MAX_SCAN_FILES = 5000

/** Default lister: a bounded, symlink-safe recursive walk collecting `extension` files, skipping
 * dependency/VCS/cache/build dirs and any dotdir. Stops (`truncated`) at {@link MAX_SCAN_FILES}.
 * The partial-rename guard is OFF until a lister is wired (like `redact`, the surfaces wire this). */
export const defaultListFiles: ProjectFileLister = (roots, { extension }) => {
  const files: string[] = []
  const seenDirs = new Set<string>()
  let truncated = false
  const walk = (dir: string): void => {
    if (truncated) return
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    if (seenDirs.has(real)) return // symlink-loop guard
    seenDirs.add(real)
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (truncated) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(full)
      } else if (e.isFile() && extname(e.name) === extension) {
        if (files.length >= MAX_SCAN_FILES) {
          truncated = true
          return
        }
        files.push(full)
      }
    }
  }
  for (const r of roots) walk(r)
  return { files, truncated }
}

const realpathOrSelf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const ID_CHAR = /[\p{L}\p{N}_$]/u

/** The identifier token (code-point aware) spanning a 1-based human `line`/`column` in `text`. */
function identifierAt(text: string, line: number, column: number): string {
  const lines = text.split(/\r\n|\r|\n/)
  const ln = lines[line - 1]
  if (ln === undefined) return ''
  const cps = [...ln]
  let i = column - 1
  // The position may sit just past the token's end; step back onto it.
  if (
    (i < 0 || i >= cps.length || !ID_CHAR.test(cps[i] as string)) &&
    i > 0 &&
    ID_CHAR.test(cps[i - 1] as string)
  ) {
    i -= 1
  }
  if (i < 0 || i >= cps.length || !ID_CHAR.test(cps[i] as string)) return ''
  let s = i
  let e = i + 1
  while (s > 0 && ID_CHAR.test(cps[s - 1] as string)) s -= 1
  while (e < cps.length && ID_CHAR.test(cps[e] as string)) e += 1
  return cps.slice(s, e).join('')
}

/** A whole-word matcher for `name` (not flanked by identifier chars). `name` is regex-escaped. */
function wholeWordRegex(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${esc}(?![\\p{L}\\p{N}_$])`, 'u')
}

/** How exhaustively the partial-rename guard could verify the edit covers every textual use. */
export type RenameCompleteness = 'complete' | 'suspect' | 'unknown'
const MAX_SUSPECTS = 50

/**
 * One physical filesystem action in an apply commit. A `write` creates-or-overwrites a file's
 * content (the fold of a CreateFile + its edits, or an edit to a pre-existing file); `rename`/
 * `delete` are the resource-op file moves/removals (`RenameFile`/`DeleteFile`).
 */
export type PhysicalOp =
  | { kind: 'write'; absPath: string; newText: string }
  | { kind: 'rename'; fromAbs: string; toAbs: string }
  | { kind: 'delete'; absPath: string }

/**
 * The projected fate of one file during the apply replay, keyed by its ORIGINAL uri. A `live` file
 * ends at `finalUri` (≠ origin ⇒ it was renamed) with the given projected `content`; a `deleted`
 * file ends removed. Content flows through a rename inside this record, so an edit to a renamed
 * file's new path composes onto the carried content without a copy.
 */
type Fate = { kind: 'live'; finalUri: string; content: string } | { kind: 'deleted' }

export interface CommitResult {
  /** The ops that completed, in order. */
  completed: PhysicalOp[]
  /** True ⇒ an op faulted mid-execute; `completed` is the TERMINAL landed set (rename/delete are
   * irreversible — there is no rollback; reconcile via VCS). */
  partial: boolean
  error?: string
}

/**
 * The write seam (injected; tests substitute a fake so the gate never touches disk). The default
 * **stages every `write` to a sibling temp (+ fsync) first** (no target touched until all temps
 * exist — the strength the pure-text rename relies on), then executes every op IN ORDER: a `write`
 * commits via atomic rename of its temp, a `rename`/`delete` runs the fs primitive. Resource ops
 * are irreversible and cannot be staged, so a fault during the execute phase is terminal —
 * `partial: true` names exactly what landed.
 */
export interface RenameWriter {
  commit(ops: PhysicalOp[]): CommitResult
}

let tempCounter = 0

export const defaultRenameWriter: RenameWriter = {
  commit(ops) {
    // Phase A — stage every `write` to a sibling temp (+fsync); mkdir -p a CreateFile's new dir.
    const temps = new Map<string, string>()
    try {
      for (const op of ops) {
        if (op.kind !== 'write') continue
        mkdirSync(dirname(op.absPath), { recursive: true })
        tempCounter += 1
        const tmp = `${op.absPath}.sackville-rename-${process.pid}-${tempCounter}`
        writeFileSync(tmp, op.newText, 'utf8')
        const fd = openSync(tmp, 'r+')
        fsyncSync(fd)
        closeSync(fd)
        temps.set(op.absPath, tmp)
      }
    } catch (err) {
      for (const tmp of temps.values()) {
        try {
          unlinkSync(tmp)
        } catch {
          // best-effort cleanup; nothing was committed yet so no target is corrupt.
        }
      }
      throw err
    }
    // Phase B — execute in order. A fault here is terminal (rename/delete are irreversible).
    const completed: PhysicalOp[] = []
    try {
      for (const op of ops) {
        if (op.kind === 'write') renameSync(temps.get(op.absPath) as string, op.absPath)
        else if (op.kind === 'rename') renameSync(op.fromAbs, op.toAbs)
        else unlinkSync(op.absPath)
        completed.push(op)
      }
    } catch (err) {
      for (const [abs, tmp] of temps) {
        if (!completed.some((c) => c.kind === 'write' && c.absPath === abs)) {
          try {
            unlinkSync(tmp)
          } catch {
            // best-effort: an uncommitted temp.
          }
        }
      }
      return { completed, partial: true, error: (err as Error).message }
    }
    return { completed, partial: false }
  },
}

function isRegularFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

/**
 * A symlink-AWARE regular-file check for an OVERWRITE target. Refuses a symlink (no clobber THROUGH a
 * link — the digest would read the link target's bytes while `renameSync`/atomic-write replaces the
 * link itself, a silent audit lie + the real file survives) and refuses a directory. `lstatSync` does
 * NOT follow the link, so a symlink ⇒ `isFile()` is false ⇒ refused. Used only on an overwrite target.
 */
function isOverwritableRegularFile(abs: string): boolean {
  try {
    return lstatSync(abs).isFile()
  } catch {
    return false
  }
}

/** True if a path exists on disk (any kind), WITHOUT following a symlink. Used to detect an overwrite
 * destination that `liveOccupied` (content-read-based) misses — notably a DIRECTORY, whose content
 * read returns undefined so it would otherwise look unoccupied. */
function existsLstat(abs: string): boolean {
  try {
    lstatSync(abs)
    return true
  } catch {
    return false
  }
}

export interface LspRenameEngineOptions {
  manager: LanguageServerManager
  /** OPERATOR opt-in to run navigation (which requires a live indexing daemon). Deny-by-default. */
  allowRun: boolean
  /** OPERATOR allowlist of project roots. Load-bearing even with allowRun. */
  allowedRoots: string[]
  /** OPERATOR opt-in to WRITE the edit to disk. Distinct from allowRun; off ⇒ dry-run preview. */
  allowWrite: boolean
  /**
   * OPERATOR opt-in to APPLY a rename whose completeness verdict is `suspect` — i.e. the old
   * identifier also appears in same-language files the server's edit does NOT touch (the hallmark
   * of an open-files-scoped server like pyright, whose cross-file rename can be silently partial).
   * Deny-by-default: a suspect rename is REFUSED for write unless this is set. Never an agent input.
   */
  allowPartialRename?: boolean
  /**
   * OPERATOR opt-in to APPLY a DESTRUCTIVE resource op — `overwrite: true` on a CreateFile
   * (truncate-and-replace an existing file) or a RenameFile (clobber an existing REGULAR-FILE
   * target). Deny-by-default; refused for write unless set. Recursive/dir delete + symlink/dir
   * targets STAY refused even with this gate. Meaningless without `allowWrite` (the engine
   * re-checks both before any destructive op); never an agent input.
   */
  allowDestructiveResourceOps?: boolean
  readFile?: FileReader
  /** Lists same-language source files to scan for the partial-rename guard. UNSET ⇒ the guard is
   * inactive (no scan); the bin/CLI/MCP wire `defaultListFiles` to turn it on (cf. `redact`). */
  listFiles?: ProjectFileLister
  writer?: RenameWriter
  /** Secret redaction over every surfaced hunk (default identity; the bin wires @sackville-mcp/safety). */
  redact?: (text: string) => string
}

export interface LspRenameInput {
  language: string
  projectRoot: string
  /** The file to rename in, relative to projectRoot (or absolute within it). */
  file: string
  /** 1-based human line of the symbol to rename. */
  line: number
  /** 1-based human column (code points) of the symbol to rename. */
  column: number
  /** The new identifier. Validated by isPlausibleRenameName before reaching the server. */
  newName: string
  /**
   * Additional allowlisted roots bound as workspace folders on the SAME server (multi-root). A
   * cross-root rename may edit files in any of these; each must be in `allowedRoots`, and edited
   * files confine to the GROUP (`projectRoot` ∪ `workspaceRoots`), not just the primary root.
   */
  workspaceRoots?: string[]
  /** Optional toolchain provenance to echo. */
  toolchain?: { name: string; version: string | null }
}

export interface RenamePreviewEdit {
  range: HumanRange
  oldText: string
  newText: string
  needsConfirmation?: boolean
  annotationLabel?: string
}

export interface RenamePreviewFile {
  uri: string
  /** Project-relative path (never absolute). `(out of project root)` for an out-of-root edit. */
  file: string
  editCount: number
  /** True ⇒ the edit targets a file outside the allowlisted root; its bytes are NOT surfaced. */
  outOfRoot?: boolean
  /** The per-edit hunks (omitted for an out-of-root or unreadable file). */
  hunks?: RenamePreviewEdit[]
}

export interface RenameDigest {
  file: string
  before: string
  after: string
}

export interface LspRenameResult {
  status: QueryStatus
  kind: 'rename'
  applied: boolean
  /** A structured reason the rename was not applied (not renameable, multi-file, resource ops, drift). */
  refused?: string
  newName: string
  fileCount: number
  totalEditCount: number
  edits: RenamePreviewFile[]
  resourceOps?: NormalizedResourceOp[]
  /** Per-file pre/post SHA-256 digests — the apply audit (only when applied). */
  digests?: RenameDigest[]
  /** Project-relative paths whose prior content a DESTRUCTIVE overwrite clobbered (gated; landed
   * only) — so a destructive clobber is always explicit in the envelope, not inferred from a digest. */
  overwritten?: string[]
  /** True ⇒ an irreversible resource op faulted mid-commit; `digests` names what landed (no
   * rollback — reconcile via VCS). */
  partial?: boolean
  partialError?: string
  /**
   * The partial-rename guard verdict (omitted when the rename was not `ok`). `complete` — every
   * same-language file mentioning the old name is in the edit; `suspect` — some are NOT (the edit
   * may be partial, e.g. an open-files-scoped server); `unknown` — the scan was truncated.
   */
  completeness?: RenameCompleteness
  /** Project-relative same-language files that mention the old identifier but are absent from the
   * edit (capped). Populated when `completeness === 'suspect'`. */
  suspectedMissedFiles?: string[]
  serverInfo?: ServerInfo
  toolchain?: { name: string; version: string | null }
  encoding: PositionEncoding
  versionWarning?: string
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

interface ApplyOutcome {
  applied: boolean
  refused?: string
  digests?: RenameDigest[]
  /** Project-relative paths whose prior content a DESTRUCTIVE overwrite clobbered (landed only). */
  overwritten?: string[]
  partial?: boolean
  partialError?: string
}

interface RunOutcome {
  status: QueryStatus
  edit: NormalizedWorkspaceEdit
  encoding: PositionEncoding
  serverInfo?: ServerInfo
  refused?: string
  apply: ApplyOutcome
}

export class LspRenameEngine {
  private readonly manager: LanguageServerManager
  private readonly allowRun: boolean
  private readonly allowedRoots: string[]
  private readonly allowWrite: boolean
  private readonly allowPartialRename: boolean
  private readonly allowDestructiveResourceOps: boolean
  private readonly readFile: FileReader
  /** When unset the partial-rename guard is inactive (the bin/CLI/MCP wire `defaultListFiles`). */
  private readonly listFiles?: ProjectFileLister
  private readonly writer: RenameWriter
  private readonly redact: (text: string) => string

  constructor(options: LspRenameEngineOptions) {
    this.manager = options.manager
    this.allowRun = options.allowRun
    this.allowedRoots = options.allowedRoots
    this.allowWrite = options.allowWrite
    this.allowPartialRename = options.allowPartialRename ?? false
    this.allowDestructiveResourceOps = options.allowDestructiveResourceOps ?? false
    this.readFile = options.readFile ?? defaultReadFile
    this.listFiles = options.listFiles
    this.writer = options.writer ?? defaultRenameWriter
    this.redact = options.redact ?? ((t) => t)
  }

  async rename(input: LspRenameInput): Promise<LspRenameResult> {
    assertAllowed(this.allowRun, this.allowedRoots, input.projectRoot)
    // Every additional workspace root must also be allowlisted (refused before any spawn).
    for (const root of input.workspaceRoots ?? []) {
      assertAllowed(this.allowRun, this.allowedRoots, root)
    }
    const queriedAbs = confineFile(input.projectRoot, input.file)
    const text = this.readFile(queriedAbs)
    if (text === undefined) {
      throw new LspGateError(`cannot read file ${input.file} in ${input.projectRoot}`)
    }
    if (!isPlausibleRenameName(input.newName)) {
      throw new LspGateError(`invalid rename target ${JSON.stringify(input.newName)}`)
    }
    const queriedUri = pathToFileURL(queriedAbs).toString()

    const run = await this.manager.run<RunOutcome>(
      {
        language: input.language,
        projectRoot: input.projectRoot,
        uri: queriedUri,
        text,
        ...(input.workspaceRoots ? { workspaceRoots: input.workspaceRoots } : {}),
      },
      async (client): Promise<RunOutcome> => {
        const pos = toLspPosition(text, input.line, input.column, client.encoding)
        const empty: NormalizedWorkspaceEdit = { files: [], resourceOps: [], operations: [] }

        if (client.supportsPrepareRename) {
          const prep = await client.prepareRename(queriedUri, pos)
          if (prep.status === 'not_ready') {
            return base(prep, empty, { applied: false })
          }
          if (prep.status === 'no_result') {
            return base(prep, empty, { applied: false }, 'rename is not valid at this position')
          }
        }

        const r = await client.rename(queriedUri, pos, input.newName)
        return base(r, r.result, { applied: false })
      },
    )

    // Partial-rename guard: scan the allowlisted root group for same-language files that mention
    // the old identifier but are NOT in the server's edit. An open-files-scoped server (pyright)
    // can return a too-narrow edit that, applied verbatim, would silently break the untouched uses.
    const guard =
      run.status === 'ok' && this.listFiles
        ? this.assessCompleteness(run.edit, input, queriedAbs, text)
        : undefined
    // A DESTRUCTIVE batch (any overwrite) raises the bar: an `unknown` (truncated, hence
    // unverifiable) completeness verdict is treated as blocking too — an irreversible clobber must
    // not ride on a scan we could not finish. A `suspect` verdict always blocks (any batch).
    const destructiveBatch =
      run.status === 'ok' &&
      run.edit.operations.some((o) => o.type !== 'edit' && o.options?.overwrite === true)
    const blockedByGuard =
      (guard?.completeness === 'suspect' ||
        (destructiveBatch && guard?.completeness === 'unknown')) &&
      !this.allowPartialRename

    // Apply is a SEPARATE phase (it may need more locks than the compute phase held — the
    // multi-URI lock). The queried file stays open from compute (open-once), so its post-write
    // didChange still fires. Dry-run by default: only when allowWrite + ok do we touch disk — and
    // a suspect verdict refuses the WRITE (deny-by-default) unless the operator set allowPartialRename.
    const apply =
      run.status === 'ok' && this.allowWrite && !blockedByGuard
        ? await this.applyEdit(run.edit, input, queriedUri, text, run.encoding)
        : { applied: false }
    const guardRefusal = !(this.allowWrite && blockedByGuard)
      ? undefined
      : guard?.completeness === 'suspect'
        ? `rename may be INCOMPLETE: the symbol ${JSON.stringify(
            guard?.oldName ?? '',
          )} also appears in ${guard?.suspectFiles.length} same-language file(s) not in this edit (e.g. ${guard?.suspectFiles
            .slice(0, 3)
            .join(
              ', ',
            )}). The language server may scope rename to open files; nothing was written. Re-run with allowPartialRename to apply anyway.`
        : `rename completeness could not be verified: the same-language scan for ${JSON.stringify(
            guard?.oldName ?? '',
          )} was TRUNCATED, and this batch contains a DESTRUCTIVE overwrite — an unverifiable scan is treated as blocking; nothing was written. Re-run with allowPartialRename to apply anyway.`

    return this.shape(
      input,
      { ...run, apply, refused: guardRefusal ?? apply.refused ?? run.refused },
      queriedUri,
      text,
      guard,
    )
  }

  /**
   * Decide + execute the apply, consuming the ordered `operations` (text edits interleaved with
   * CreateFile/RenameFile/DeleteFile). Confine EVERY touched URI (edit + create + rename old&new +
   * delete) to the root group all-or-nothing BEFORE any I/O; refuse the v1 cuts early (non-default
   * resource-op options; editing a file also renamed in the same batch). Then, under the multi-URI
   * lock over ALL touched URIs, replay the ops over a virtual content map (no writes) with the
   * staleness guards, build a physical plan, stage-then-commit it, and resync any open buffer
   * (`didChange` for an edited file, `didClose`+`didOpen` migration for a renamed/deleted one).
   */
  private async applyEdit(
    edit: NormalizedWorkspaceEdit,
    input: LspRenameInput,
    queriedUri: string,
    text: string,
    encoding: PositionEncoding,
  ): Promise<ApplyOutcome> {
    const ops = edit.operations
    if (ops.length === 0) return { applied: false }
    const group = [input.projectRoot, ...(input.workspaceRoots ?? [])]
    const abs = new Map<string, string>()
    const rel = (uri: string) => relative(input.projectRoot, abs.get(uri) as string)

    // (a) Confine EVERY touched URI to the group, all-or-nothing, BEFORE any I/O.
    for (const op of ops) {
      const uris = op.type === 'rename' ? [op.oldUri, op.newUri] : [op.uri]
      for (const u of uris) {
        if (abs.has(u)) continue
        try {
          abs.set(u, confineEditedUriToRoots(group, u))
        } catch {
          return {
            applied: false,
            refused: 'an edited file is outside the project root; previewed only',
          }
        }
      }
    }

    // (b) Refuse the DESTRUCTIVE / malformed resource-op options EARLY (before any I/O), per op
    // type so the invariants are STRUCTURAL, not message-dependent: `recursive` is ALWAYS refused
    // (no rm -rf from a server payload); `overwrite` on create/rename is gated; `overwrite` on a
    // delete is malformed. The gate is SELF-ENFORCING — it re-requires `allowWrite` even though the
    // bin throws without it (mirrors assertAllowed re-checking allowRun). The other v1 cuts
    // (edit-of-a-renamed-file, ordering, cycles) are enforced inline in the replay below.
    const destructiveAllowed = this.allowWrite && this.allowDestructiveResourceOps
    for (const op of ops) {
      if (op.type === 'edit') continue
      if (op.type === 'delete' && op.options?.recursive === true) {
        return {
          applied: false,
          refused: 'recursive/directory delete is unsupported (refused — not enabled by any gate)',
        }
      }
      if (op.type === 'delete' && op.options?.overwrite === true) {
        return {
          applied: false,
          refused: 'overwrite is not a valid option on a delete (malformed; refused)',
        }
      }
      if (
        (op.type === 'create' || op.type === 'rename') &&
        op.options?.overwrite === true &&
        !destructiveAllowed
      ) {
        return {
          applied: false,
          refused:
            'resource-op overwrite requires the operator destructive-resource-ops gate (allowDestructiveResourceOps + allowWrite); previewed only',
        }
      }
    }

    return this.manager.runWithUris(
      {
        language: input.language,
        projectRoot: input.projectRoot,
        uris: [...abs.keys()],
        ...(input.workspaceRoots ? { workspaceRoots: input.workspaceRoots } : {}),
      },
      async (client): Promise<ApplyOutcome> => {
        const refuse = (msg: string): ApplyOutcome => ({ applied: false, refused: msg })
        // PHASE 1 (no writes): replay ops over a VFS keyed by the file's ORIGINAL uri. Content flows
        // THROUGH a rename inside one record (rename(A→B) carries A's content to finalUri B; a later
        // edit(B) resolves to A and edits the carried content) — so edit composed with rename/delete
        // works without copies, in documentChanges order.
        const vfs = new Map<string, Fate>()
        const created = new Set<string>() // born in-batch (keyed by origin)
        const order: string[] = [] // first-touch order — drives the physical-plan emission
        const ordered = new Set<string>() // O(1) membership companion to `order`
        const aliasMap = new Map<string, string>() // a rename target uri -> its origin uri
        const diskBefore = new Map<string, string>() // origin -> pre-batch disk content ('' if absent)
        const renamedOld = new Set<string>() // oldUris consumed by a rename (E-OLD + cycle guards)
        // A create-overwrite on a PRE-EXISTING on-disk file. Kept SEPARATE from `created` because it
        // is a real inode: a following delete must still emit a physical delete (blocker), so the
        // TIER-2 delete + collision guards keep keying on `created`, while the "no prior on-disk
        // identifier / always-write" checks treat it like a created file.
        const overwroteExisting = new Set<string>()
        // Destructive clobbers, keyed by the FINAL absolute path -> project-relative path, surfaced as
        // `overwritten` once we know which physical op actually landed (post-commit).
        const overwrites = new Map<string, string>()
        // An overwrite-RENAME's destroyed destination, keyed by newUri -> prior disk bytes; drives the
        // `(overwritten)` audit row attached to the rename PhysicalOp (no `order`/`diskBefore` entry).
        const clobbered = new Map<string, string>()
        const diskCache = new Map<string, string | undefined>()
        const readDisk = (u: string): string | undefined => {
          if (!diskCache.has(u)) diskCache.set(u, this.readFile(abs.get(u) as string))
          return diskCache.get(u)
        }
        const resolveOrig = (u: string): string => aliasMap.get(u) ?? u
        const touch = (o: string): void => {
          if (!ordered.has(o)) {
            ordered.add(o)
            order.push(o)
          }
          if (!diskBefore.has(o)) diskBefore.set(o, readDisk(o) ?? '')
        }
        // Current projected content of `u` (undefined ⇒ absent: deleted, or never created/on-disk).
        const contentOf = (u: string): string | undefined => {
          const f = vfs.get(resolveOrig(u))
          if (f) return f.kind === 'live' ? f.content : undefined
          return readDisk(u)
        }
        // Does `u` name a LIVE file (on disk / created / edited-in-place) — NOT a pending rename target?
        const liveOccupied = (u: string): boolean => {
          const f = vfs.get(resolveOrig(u))
          return f ? f.kind === 'live' : readDisk(u) !== undefined
        }
        let expectedOld: string | undefined

        for (const op of ops) {
          if (op.type === 'create') {
            if (resolveOrig(op.uri) !== op.uri) {
              return refuse(`cannot create ${rel(op.uri)}: conflicts with another operation`)
            }
            if (liveOccupied(op.uri)) {
              if (op.options?.overwrite === true) {
                // overwrite WINS over ignoreIfExists (LSP CreateFileOptions). The gate is already
                // verified by the early-refusal loop. Refuse a symlink/directory target; clobber a
                // regular file only. `touch` snapshots the prior disk bytes so the digest audits the
                // destroyed content; `overwroteExisting` (NOT `created`) keeps a following delete real.
                const a = abs.get(op.uri) as string
                if (!isOverwritableRegularFile(a)) {
                  return refuse(
                    `cannot overwrite ${rel(op.uri)}: not a regular file on disk (symlink/directory — refused)`,
                  )
                }
                if (op.uri === queriedUri && sha256(readDisk(op.uri) ?? '') !== sha256(text)) {
                  return refuse(
                    'the file changed on disk since the rename was computed; re-query and retry',
                  )
                }
                touch(op.uri)
                vfs.set(op.uri, { kind: 'live', finalUri: op.uri, content: '' })
                overwroteExisting.add(op.uri)
                overwrites.set(a, rel(op.uri))
                continue
              }
              if (op.options?.ignoreIfExists === true) continue // safe no-op: leave the file as-is
              return refuse(`cannot create ${rel(op.uri)}: it already exists`)
            }
            touch(op.uri)
            vfs.set(op.uri, { kind: 'live', finalUri: op.uri, content: '' })
            created.add(op.uri)
          } else if (op.type === 'delete') {
            const base = contentOf(op.uri)
            if (base === undefined) {
              if (op.options?.ignoreIfNotExists === true) continue // safe no-op: nothing to delete
              return refuse(`cannot delete ${rel(op.uri)}: it does not exist`)
            }
            const o = resolveOrig(op.uri)
            if (!created.has(o) && !isRegularFile(abs.get(o) as string)) {
              return refuse(
                `cannot delete ${rel(op.uri)}: not a regular file (recursive/directory delete unsupported in v1)`,
              )
            }
            touch(o)
            vfs.set(o, { kind: 'deleted' })
          } else if (op.type === 'rename') {
            const src = contentOf(op.oldUri)
            if (src === undefined)
              return refuse(`cannot rename ${rel(op.oldUri)}: it does not exist`)
            const o = resolveOrig(op.oldUri)
            if (renamedOld.has(op.newUri) || resolveOrig(op.newUri) === o) {
              return refuse(
                `cannot rename ${rel(op.oldUri)} onto a same-batch source (rename cycle in this edit)`,
              )
            }
            if (resolveOrig(op.newUri) !== op.newUri) {
              return refuse(
                `cannot rename to ${rel(op.newUri)}: it is already a target in this edit`,
              )
            }
            const newAbs = abs.get(op.newUri) as string
            // An overwrite clobbers an EXISTING destination — detect it via liveOccupied (regular file
            // / through-symlink) OR a raw lstat (catches a DIRECTORY, which reads as unoccupied).
            if (
              op.options?.overwrite === true &&
              (liveOccupied(op.newUri) || existsLstat(newAbs))
            ) {
              // gate verified by the early-refusal loop. Clobber an EXISTING on-disk regular file only
              // — refuse a target created/edited IN this same batch (structural two-into-one), a
              // symlink/directory (no clobber-through-link audit lie), and a drifted open file.
              if (vfs.get(op.newUri)?.kind === 'live') {
                return refuse(
                  `cannot overwrite ${rel(op.newUri)}: it is created or edited in this same edit (refused)`,
                )
              }
              if (!isOverwritableRegularFile(newAbs)) {
                return refuse(
                  `cannot overwrite ${rel(op.newUri)}: not a regular file on disk (symlink/directory — refused)`,
                )
              }
              if (op.newUri === queriedUri && sha256(readDisk(op.newUri) ?? '') !== sha256(text)) {
                return refuse(
                  'the file changed on disk since the rename was computed; re-query and retry',
                )
              }
              // capture the destroyed bytes WITHOUT touching `order` (no phantom origin entry); the
              // clobber digest row + `overwritten` are emitted post-plan / post-commit.
              clobbered.set(op.newUri, readDisk(op.newUri) ?? '')
              overwrites.set(newAbs, rel(op.newUri))
              // fall through to normal rename bookkeeping.
            } else if (liveOccupied(op.newUri)) {
              if (op.options?.ignoreIfExists === true) continue // safe no-op: skip; old stays
              return refuse(`cannot rename to ${rel(op.newUri)}: it already exists`)
            }
            touch(o)
            vfs.set(o, { kind: 'live', finalUri: op.newUri, content: src })
            aliasMap.set(op.newUri, o)
            renamedOld.add(op.oldUri)
          } else {
            // edit. An edit naming a uri that was itself renamed earlier is ambiguous (edit-the-moved
            // file vs write-a-shim into the freed slot) — refuse rather than silently guess.
            if (renamedOld.has(op.uri)) {
              return refuse(
                `cannot edit ${rel(op.uri)}: it was renamed in this edit; address the new path`,
              )
            }
            const base = contentOf(op.uri)
            if (base === undefined) return refuse(`cannot read edited file ${rel(op.uri)}`)
            if (op.uri === queriedUri && sha256(base) !== sha256(text)) {
              return refuse(
                'the file changed on disk since the rename was computed; re-query and retry',
              )
            }
            if (op.uri === queriedUri && op.edits[0]) {
              expectedOld = sliceByOffsets(base, op.edits[0].range, encoding)
            }
            const o = resolveOrig(op.uri)
            const f = vfs.get(o)
            const finalUri = f?.kind === 'live' ? f.finalUri : op.uri
            touch(o)
            vfs.set(o, {
              kind: 'live',
              finalUri,
              content: applyTextEdits(base, op.edits, encoding),
            })
          }
        }

        // Old-identifier staleness guard. Reads each edited file's CURRENT on-disk slice; a rename
        // TARGET (not yet on disk) reads `undefined` and is skipped, so an import fix-up in a moved
        // file never trips it. Created files have no on-disk old identifier to match.
        if (expectedOld !== undefined) {
          for (const op of ops) {
            // A created OR overwrite-created file is intentionally truncate-and-replaced, so its
            // on-disk old identifier is irrelevant — documented skip (no stale-symbol false positive).
            if (op.type !== 'edit') continue
            const oo = resolveOrig(op.uri)
            if (created.has(oo) || overwroteExisting.has(oo)) continue
            const cur = readDisk(op.uri)
            if (cur === undefined) continue
            for (const e of op.edits) {
              if (sliceByOffsets(cur, e.range, encoding) !== expectedOld) {
                return refuse(
                  'an edit site no longer matches the renamed symbol; re-query and retry',
                )
              }
            }
          }
        }

        // Collision guard (data-loss): a path being DELETED must not also be a live rename/create
        // target in the same batch (else its physical delete would unlink the just-moved file).
        const liveFinalAbs = new Set<string>()
        for (const o of order) {
          const f = vfs.get(o)
          if (f?.kind === 'live') liveFinalAbs.add(abs.get(f.finalUri) as string)
        }
        for (const o of order) {
          const f = vfs.get(o)
          if (f?.kind !== 'deleted' || created.has(o)) continue
          if (liveFinalAbs.has(abs.get(o) as string)) {
            return refuse(
              `cannot delete ${rel(o)}: its path is a rename or create target in this edit`,
            )
          }
        }

        // Build the physical plan + audit digests. `digestForPhysical` maps every physical op to its
        // digest row (an edited-AND-renamed pair is TWO ops → ONE shared row, so a partial commit
        // that lands either half still surfaces the row). `before` is ALWAYS the pre-batch disk
        // snapshot, so a delete-then-create revive reports the file's real prior content.
        const physical: PhysicalOp[] = []
        const digests: RenameDigest[] = []
        const digestForPhysical: number[] = []
        // Extra digest rows carried by a physical op (e.g. an overwrite-rename's destroyed-target
        // `(overwritten)` row attached to the rename) — ONE reconstruction rule for a partial commit.
        const extraRowsForPhysical: number[][] = []
        const push = (p: PhysicalOp, d: number, extra: number[] = []): void => {
          physical.push(p)
          digestForPhysical.push(d)
          extraRowsForPhysical.push(extra)
        }
        // Build the `(overwritten)` clobber row for a rename whose destination is being clobbered,
        // returning its digest index (to attach to the rename op) or `[]` when nothing was clobbered.
        const clobberRow = (finalUri: string): number[] => {
          if (!clobbered.has(finalUri)) return []
          return [
            digests.push({
              file: `${rel(finalUri)} (overwritten)`,
              before: sha256(clobbered.get(finalUri) as string),
              after: '',
            }) - 1,
          ]
        }
        // TIER 1 — writes & renames, in first-touch order.
        for (const o of order) {
          const f = vfs.get(o)
          if (f?.kind !== 'live') continue
          const moved = f.finalUri !== o
          const before = sha256(diskBefore.get(o) ?? '')
          // A created OR overwrite-created file always emits its write (an intentional truncate-and-
          // replace), even when the new bytes happen to equal the prior on-disk bytes.
          const contentChanged =
            created.has(o) || overwroteExisting.has(o) || sha256(f.content) !== before
          if (!moved) {
            if (contentChanged) {
              const d = digests.push({ file: rel(o), before, after: sha256(f.content) }) - 1
              push({ kind: 'write', absPath: abs.get(o) as string, newText: f.content }, d)
            }
          } else if (created.has(o)) {
            // created then renamed pre-write: no inode to move — one write at the final path.
            const d = digests.push({ file: rel(f.finalUri), before, after: sha256(f.content) }) - 1
            push({ kind: 'write', absPath: abs.get(f.finalUri) as string, newText: f.content }, d)
          } else if (contentChanged) {
            // edited AND renamed: ONE digest row, TWO physical ops (rename THEN write) sharing it.
            const d =
              digests.push({
                file: `${rel(o)} → ${rel(f.finalUri)}`,
                before,
                after: sha256(f.content),
              }) - 1
            // the destroyed-target row (if any) is attached to the RENAME op — the op that clobbers.
            push(
              {
                kind: 'rename',
                fromAbs: abs.get(o) as string,
                toAbs: abs.get(f.finalUri) as string,
              },
              d,
              clobberRow(f.finalUri),
            )
            push({ kind: 'write', absPath: abs.get(f.finalUri) as string, newText: f.content }, d)
          } else {
            // pure rename (content unchanged).
            const d =
              digests.push({ file: `${rel(o)} → ${rel(f.finalUri)}`, before, after: before }) - 1
            push(
              {
                kind: 'rename',
                fromAbs: abs.get(o) as string,
                toAbs: abs.get(f.finalUri) as string,
              },
              d,
              clobberRow(f.finalUri),
            )
          }
        }
        // TIER 2 — deletes, in first-touch order, after every write/rename.
        for (const o of order) {
          const f = vfs.get(o)
          if (f?.kind !== 'deleted' || created.has(o)) continue
          const d =
            digests.push({
              file: `${rel(o)} (deleted)`,
              before: sha256(diskBefore.get(o) ?? ''),
              after: '',
            }) - 1
          push({ kind: 'delete', absPath: abs.get(o) as string }, d)
        }
        if (physical.length === 0) return { applied: false }

        // PHASE 2: stage-then-commit, then resync the server's open buffer for what ACTUALLY landed
        // (a partial commit must never push projected bytes the disk does not hold).
        const res = this.writer.commit(physical)
        const landed = new Set(res.completed)
        const landedWrite = (a: string) =>
          res.completed.some((p) => p.kind === 'write' && p.absPath === a)
        const landedRename = (a: string) =>
          res.completed.some((p) => p.kind === 'rename' && p.toAbs === a)
        const landedDelete = (a: string) =>
          res.completed.some((p) => p.kind === 'delete' && p.absPath === a)

        for (const o of order) {
          const f = vfs.get(o)
          if (f?.kind !== 'live') continue
          const moved = f.finalUri !== o
          const toAbs = abs.get(f.finalUri) as string
          if (created.has(o)) {
            if (landedWrite(toAbs)) {
              // A created file that is ALSO the open (queried) file — only reachable via a
              // delete→create→rename revive — must migrate the open buffer, not no-op applyEdited.
              if (o === queriedUri && moved) client.didFileRename(o, f.finalUri, f.content)
              else client.applyEdited(f.finalUri, f.content)
            }
          } else if (moved) {
            // Migrate the open buffer ONLY if the physical rename actually landed. (The paired write
            // executes AFTER the rename, so a landed write always implies a landed rename; we never
            // tell the server a file moved when its origin still holds the bytes on disk.)
            if (landedRename(toAbs)) {
              // An overwrite-rename clobbered the destination — close any open buffer for the OLD
              // destination first (didFileRename blindly re-opens newUri; a stale dest buffer would
              // otherwise linger). No-op if the destination was never open.
              if (clobbered.has(f.finalUri)) client.didFileDelete(f.finalUri)
              // bytes now at finalUri = the edited content IFF the paired write landed; else pristine.
              const wl = landedWrite(toAbs)
              client.didFileRename(o, f.finalUri, wl ? f.content : (diskBefore.get(o) ?? ''))
            }
          } else if (landedWrite(abs.get(o) as string)) {
            client.applyEdited(o, f.content)
          }
        }
        for (const o of order) {
          const f = vfs.get(o)
          if (f?.kind !== 'deleted' || created.has(o)) continue
          if (landedDelete(abs.get(o) as string)) client.didFileDelete(o)
        }

        const outDigests = res.partial
          ? [
              ...new Set(
                physical.flatMap((p, i) =>
                  landed.has(p)
                    ? [digestForPhysical[i] as number, ...(extraRowsForPhysical[i] as number[])]
                    : [],
                ),
              ),
            ].map((i) => digests[i] as RenameDigest)
          : digests
        // A destructive clobber is surfaced ONLY when the physical op that destroyed the prior bytes
        // actually landed (a write at the path, or a rename onto it) — never on a previewed-but-aborted
        // or partial-non-landed op.
        const overwritten = [...overwrites]
          .filter(([a]) => landedWrite(a) || landedRename(a))
          .map(([, r]) => r)
        return {
          applied: true,
          digests: outDigests,
          ...(overwritten.length ? { overwritten } : {}),
          ...(res.partial ? { partial: true, partialError: res.error } : {}),
        }
      },
    )
  }

  /**
   * The partial-rename completeness guard. Extracts the old identifier at the queried position,
   * then scans the allowlisted root group for same-language files that mention it as a whole word
   * but are NOT covered by the server's edit (text edits + resource-op endpoints). Any such file is
   * a SUSPECT — the edit is likely partial (an open-files-scoped server). `unknown` ⇒ the scan was
   * truncated (cap hit). Server-agnostic: a whole-project-rename server covers every use ⇒ `complete`.
   */
  private assessCompleteness(
    edit: NormalizedWorkspaceEdit,
    input: LspRenameInput,
    queriedAbs: string,
    queriedText: string,
  ): { completeness: RenameCompleteness; suspectFiles: string[]; oldName: string } {
    const lister = this.listFiles
    const oldName = identifierAt(queriedText, input.line, input.column)
    const group = [input.projectRoot, ...(input.workspaceRoots ?? [])]
    if (!lister || !oldName) return { completeness: 'complete', suspectFiles: [], oldName }
    const covered = new Set<string>()
    const cover = (uri: string): void => {
      try {
        covered.add(confineEditedUriToRoots(group, uri))
      } catch {
        // out of the root group — not scannable, not a "missed" in-project file
      }
    }
    for (const f of edit.files) cover(f.uri)
    for (const op of edit.operations) {
      if (op.type === 'rename') {
        cover(op.oldUri)
        cover(op.newUri)
      } else cover(op.uri)
    }
    const { files, truncated } = lister(group, { extension: extname(queriedAbs) })
    const re = wholeWordRegex(oldName)
    const suspectsAbs: string[] = []
    for (const f of files) {
      const real = realpathOrSelf(f)
      if (covered.has(real)) continue
      const t = this.readFile(real)
      if (t === undefined) continue
      if (re.test(t)) {
        suspectsAbs.push(real)
        if (suspectsAbs.length >= MAX_SUSPECTS) break
      }
    }
    const completeness: RenameCompleteness = suspectsAbs.length
      ? 'suspect'
      : truncated
        ? 'unknown'
        : 'complete'
    return {
      completeness,
      suspectFiles: suspectsAbs.map((p) => relative(input.projectRoot, p)),
      oldName,
    }
  }

  private shape(
    input: LspRenameInput,
    run: RunOutcome,
    queriedUri: string,
    queriedText: string,
    guard?: { completeness: RenameCompleteness; suspectFiles: string[] },
  ): LspRenameResult {
    const { edit, encoding, serverInfo } = run
    const totalEditCount = edit.files.reduce((n, f) => n + f.edits.length, 0)
    const group = [input.projectRoot, ...(input.workspaceRoots ?? [])]
    const edits = edit.files.map((f) =>
      this.previewFile(f, group, queriedUri, queriedText, encoding),
    )
    const versionWarning =
      serverInfo === undefined
        ? 'the language server did not report its version (serverInfo); the rename cannot be attributed to a specific server version'
        : undefined
    // Resource-op paths are surfaced PROJECT-RELATIVE (never an absolute URI — no home-dir/secret
    // leakage); a URI outside every allowlisted root shows `(out of project root)`, never its path.
    const relUri = (uri: string): string => {
      try {
        return relative(input.projectRoot, confineEditedUriToRoots(group, uri))
      } catch {
        return '(out of project root)'
      }
    }
    const resourceOps = edit.resourceOps.map((op) => ({ kind: op.kind, uris: op.uris.map(relUri) }))
    return {
      status: run.status,
      kind: 'rename',
      applied: run.apply.applied,
      ...(run.refused ? { refused: run.refused } : {}),
      newName: input.newName,
      fileCount: edit.files.length,
      totalEditCount,
      edits,
      ...(resourceOps.length > 0 ? { resourceOps } : {}),
      ...(run.apply.digests ? { digests: run.apply.digests } : {}),
      ...(run.apply.overwritten ? { overwritten: run.apply.overwritten } : {}),
      ...(run.apply.partial ? { partial: true } : {}),
      ...(run.apply.partialError ? { partialError: run.apply.partialError } : {}),
      ...(serverInfo ? { serverInfo } : {}),
      ...(input.toolchain ? { toolchain: input.toolchain } : {}),
      ...(guard ? { completeness: guard.completeness } : {}),
      ...(guard && guard.suspectFiles.length > 0
        ? { suspectedMissedFiles: guard.suspectFiles }
        : {}),
      encoding,
      ...(versionWarning ? { versionWarning } : {}),
    }
  }

  private previewFile(
    f: { uri: string; edits: NormalizedFileEdit[] },
    group: string[],
    queriedUri: string,
    queriedText: string,
    encoding: PositionEncoding,
  ): RenamePreviewFile {
    let abs: string | undefined
    try {
      // Confine to the GROUP — a cross-root edit in an allowlisted workspace folder is in-root.
      abs = confineEditedUriToRoots(group, f.uri)
    } catch {
      // Out of every root: surface path + count ONLY, never read/surface its bytes (disclosure guard).
      return {
        uri: f.uri,
        file: '(out of project root)',
        editCount: f.edits.length,
        outOfRoot: true,
      }
    }
    const text = f.uri === queriedUri ? queriedText : this.readFile(abs)
    const out: RenamePreviewFile = {
      uri: f.uri,
      file: relative(group[0] ?? '', abs),
      editCount: f.edits.length,
    }
    if (text !== undefined) out.hunks = f.edits.map((e) => this.hunk(text, e, encoding))
    return out
  }

  private hunk(text: string, e: NormalizedFileEdit, encoding: PositionEncoding): RenamePreviewEdit {
    const start = fromLspPosition(text, e.range.start, encoding)
    const end = fromLspPosition(text, e.range.end, encoding)
    const range: HumanRange = { start, end }
    const out: RenamePreviewEdit = {
      range,
      oldText: this.redact(sliceByOffsets(text, e.range, encoding)),
      newText: this.redact(e.newText),
    }
    if (e.needsConfirmation) out.needsConfirmation = true
    if (e.annotationLabel !== undefined) out.annotationLabel = this.redact(e.annotationLabel)
    return out
  }
}

/** The OLD text of an edit, sliced by absolute offsets — NEVER reconstructed from line:col. */
function sliceByOffsets(text: string, range: LspRange, encoding: PositionEncoding): string {
  // lspPositionToOffset is CRLF/BOM/non-BMP faithful; reusing it keeps oldText byte-accurate.
  return text.slice(
    lspPositionToOffset(text, range.start, encoding),
    lspPositionToOffset(text, range.end, encoding),
  )
}

function base(
  nav: NavResult<unknown>,
  edit: NormalizedWorkspaceEdit,
  apply: ApplyOutcome,
  refused?: string,
): RunOutcome {
  return {
    status: nav.status,
    edit,
    encoding: nav.encoding,
    ...(nav.serverInfo ? { serverInfo: nav.serverInfo } : {}),
    ...(refused ? { refused } : {}),
    apply,
  }
}
