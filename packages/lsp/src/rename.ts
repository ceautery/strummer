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
 * (CreateFile/RenameFile/DeleteFile) APPLY in `documentChanges` order interleaved with text edits
 * (default semantics, single regular file; non-default options + dir/recursive delete + editing a
 * renamed file are the staged v1 cuts, refused); a mid-commit fault is terminal (`partial`).
 *
 * The adversarial corrections baked in here: oldText is sliced with absolute offsets (never
 * reconstructed from line:col); apply is staleness-guarded (the queried file vs its compute hash;
 * every edit site vs the old identifier) then stage-then-commit (the injected writer); out-of-root
 * edits never have their bytes read/surfaced; the post-write `didChange` doc-sync runs inside the
 * held lock(s); secrets are redacted in every surfaced hunk.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative } from 'node:path'
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
  ResourceOpOptions,
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
 * One physical filesystem action in an apply commit. A `write` creates-or-overwrites a file's
 * content (the fold of a CreateFile + its edits, or an edit to a pre-existing file); `rename`/
 * `delete` are the resource-op file moves/removals (`RenameFile`/`DeleteFile`).
 */
export type PhysicalOp =
  | { kind: 'write'; absPath: string; newText: string }
  | { kind: 'rename'; fromAbs: string; toAbs: string }
  | { kind: 'delete'; absPath: string }

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
        const tmp = `${op.absPath}.strummer-rename-${process.pid}-${tempCounter}`
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

/**
 * The DESTRUCTIVE resource-op options that stay refused in v1 (`overwrite` replaces an existing
 * file's content; `recursive` enables directory deletes). The CONDITIONAL options
 * `ignoreIfExists`/`ignoreIfNotExists` are NOT refused — they are honored as safe no-ops (never more
 * destructive than the default), handled inline in the per-op replay.
 */
function hasRefusedOptions(o?: ResourceOpOptions): boolean {
  return o !== undefined && (o.overwrite === true || o.recursive === true)
}

function isRegularFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
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
  readFile?: FileReader
  writer?: RenameWriter
  /** Secret redaction over every surfaced hunk (default identity; the bin wires @strummer/safety). */
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
  /** True ⇒ an irreversible resource op faulted mid-commit; `digests` names what landed (no
   * rollback — reconcile via VCS). */
  partial?: boolean
  partialError?: string
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
  private readonly readFile: FileReader
  private readonly writer: RenameWriter
  private readonly redact: (text: string) => string

  constructor(options: LspRenameEngineOptions) {
    this.manager = options.manager
    this.allowRun = options.allowRun
    this.allowedRoots = options.allowedRoots
    this.allowWrite = options.allowWrite
    this.readFile = options.readFile ?? defaultReadFile
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

    // Apply is a SEPARATE phase (it may need more locks than the compute phase held — the
    // multi-URI lock). The queried file stays open from compute (open-once), so its post-write
    // didChange still fires. Dry-run by default: only when allowWrite + ok do we touch disk.
    const apply =
      run.status === 'ok' && this.allowWrite
        ? await this.applyEdit(run.edit, input, queriedUri, text, run.encoding)
        : { applied: false }

    return this.shape(
      input,
      { ...run, apply, refused: apply.refused ?? run.refused },
      queriedUri,
      text,
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

    // (b) Refuse the staged v1 cuts EARLY (before any I/O).
    const renameEndpoints = new Set<string>()
    for (const op of ops) {
      if (op.type === 'rename') {
        renameEndpoints.add(op.oldUri)
        renameEndpoints.add(op.newUri)
      }
    }
    for (const op of ops) {
      if (op.type !== 'edit' && hasRefusedOptions(op.options)) {
        return {
          applied: false,
          refused: 'resource-op options (overwrite/recursive) are unsupported in v1 (refused)',
        }
      }
      if (op.type === 'edit' && renameEndpoints.has(op.uri)) {
        return {
          applied: false,
          refused:
            'editing a file that is also renamed in the same edit is unsupported in v1 (refused)',
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
        // PHASE 1 (no writes): replay ops over a virtual content map, enforce the staleness guards.
        const proj = new Map<string, string>() // uri -> projected final content
        const created = new Set<string>()
        const diskCache = new Map<string, string | undefined>()
        const readDisk = (u: string): string | undefined => {
          if (!diskCache.has(u)) diskCache.set(u, this.readFile(abs.get(u) as string))
          return diskCache.get(u)
        }
        const contentOf = (u: string): string | undefined =>
          proj.has(u) ? proj.get(u) : readDisk(u)
        const renamePairs: Array<{ oldUri: string; newUri: string; content: string }> = []
        const deletes: Array<{ uri: string; content: string }> = []
        let expectedOld: string | undefined

        for (const op of ops) {
          if (op.type === 'create') {
            if (readDisk(op.uri) !== undefined) {
              if (op.options?.ignoreIfExists === true) continue // safe no-op: leave the file as-is
              return { applied: false, refused: `cannot create ${rel(op.uri)}: it already exists` }
            }
            proj.set(op.uri, '')
            created.add(op.uri)
          } else if (op.type === 'delete') {
            const cur = readDisk(op.uri)
            if (cur === undefined) {
              if (op.options?.ignoreIfNotExists === true) continue // safe no-op: nothing to delete
              return { applied: false, refused: `cannot delete ${rel(op.uri)}: it does not exist` }
            }
            if (!isRegularFile(abs.get(op.uri) as string)) {
              return {
                applied: false,
                refused: `cannot delete ${rel(op.uri)}: not a regular file (recursive/directory delete unsupported in v1)`,
              }
            }
            deletes.push({ uri: op.uri, content: cur })
            proj.delete(op.uri)
          } else if (op.type === 'rename') {
            const cur = readDisk(op.oldUri)
            if (cur === undefined) {
              return {
                applied: false,
                refused: `cannot rename ${rel(op.oldUri)}: it does not exist`,
              }
            }
            if (readDisk(op.newUri) !== undefined) {
              if (op.options?.ignoreIfExists === true) continue // safe no-op: skip; old stays
              return {
                applied: false,
                refused: `cannot rename to ${rel(op.newUri)}: it already exists`,
              }
            }
            renamePairs.push({ oldUri: op.oldUri, newUri: op.newUri, content: cur })
          } else {
            const baseText = contentOf(op.uri)
            if (baseText === undefined) {
              return { applied: false, refused: `cannot read edited file ${rel(op.uri)}` }
            }
            if (op.uri === queriedUri && sha256(baseText) !== sha256(text)) {
              return {
                applied: false,
                refused:
                  'the file changed on disk since the rename was computed; re-query and retry',
              }
            }
            if (op.uri === queriedUri && op.edits[0]) {
              expectedOld = sliceByOffsets(baseText, op.edits[0].range, encoding)
            }
            proj.set(op.uri, applyTextEdits(baseText, op.edits, encoding))
          }
        }

        // Old-identifier staleness guard for PRE-EXISTING edited files (skip created files — they
        // have no on-disk old identifier to match).
        if (expectedOld !== undefined) {
          for (const op of ops) {
            if (op.type !== 'edit' || created.has(op.uri)) continue
            const cur = readDisk(op.uri)
            if (cur === undefined) continue
            for (const e of op.edits) {
              if (sliceByOffsets(cur, e.range, encoding) !== expectedOld) {
                return {
                  applied: false,
                  refused: 'an edit site no longer matches the renamed symbol; re-query and retry',
                }
              }
            }
          }
        }

        // Build the physical plan + the audit digests in lockstep (content writes, then renames,
        // then deletes — disjoint given the edit-on-renamed-file cut, so phase order is correct).
        const physical: PhysicalOp[] = []
        const digests: RenameDigest[] = []
        for (const [uri, after] of proj) {
          physical.push({ kind: 'write', absPath: abs.get(uri) as string, newText: after })
          digests.push({
            file: rel(uri),
            before: sha256(readDisk(uri) ?? ''),
            after: sha256(after),
          })
        }
        for (const r of renamePairs) {
          physical.push({
            kind: 'rename',
            fromAbs: abs.get(r.oldUri) as string,
            toAbs: abs.get(r.newUri) as string,
          })
          digests.push({
            file: `${rel(r.oldUri)} → ${rel(r.newUri)}`,
            before: sha256(r.content),
            after: sha256(r.content),
          })
        }
        for (const d of deletes) {
          physical.push({ kind: 'delete', absPath: abs.get(d.uri) as string })
          digests.push({ file: `${rel(d.uri)} (deleted)`, before: sha256(d.content), after: '' })
        }
        if (physical.length === 0) return { applied: false }

        // PHASE 2: stage-then-commit, then resync the server's open buffers for what landed.
        const res = this.writer.commit(physical)
        const landed = new Set(res.completed)
        const didWrite = (uri: string) =>
          res.completed.some((o) => o.kind === 'write' && o.absPath === abs.get(uri))
        for (const [uri, after] of proj) if (didWrite(uri)) client.applyEdited(uri, after)
        for (const r of renamePairs) {
          if (res.completed.some((o) => o.kind === 'rename' && o.toAbs === abs.get(r.newUri))) {
            client.didFileRename(r.oldUri, r.newUri, r.content)
          }
        }
        for (const d of deletes) {
          if (res.completed.some((o) => o.kind === 'delete' && o.absPath === abs.get(d.uri))) {
            client.didFileDelete(d.uri)
          }
        }

        const outDigests = res.partial
          ? digests.filter((_, i) => landed.has(physical[i] as PhysicalOp))
          : digests
        return {
          applied: true,
          digests: outDigests,
          ...(res.partial ? { partial: true, partialError: res.error } : {}),
        }
      },
    )
  }

  private shape(
    input: LspRenameInput,
    run: RunOutcome,
    queriedUri: string,
    queriedText: string,
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
      ...(run.apply.partial ? { partial: true } : {}),
      ...(run.apply.partialError ? { partialError: run.apply.partialError } : {}),
      ...(serverInfo ? { serverInfo } : {}),
      ...(input.toolchain ? { toolchain: input.toolchain } : {}),
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
