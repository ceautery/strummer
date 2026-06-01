/**
 * The gated LSP rename engine (ADR 0011 write-mode addendum, Slices F + F′). The first WRITE
 * surface of the pillar. It mirrors `LspQueryEngine` but layers a SECOND operator gate —
 * `allowWrite` — on top of the read gate (`allowRun` + `allowedRoots`): rename is **dry-run by
 * default** (compute + preview, ZERO disk writes) and applies to disk only when `allowWrite` is
 * set AND every safety condition holds.
 *
 * Apply is a separate phase from compute (it may need more locks than the compute phase held).
 * Single- AND multi-file edits apply, the latter under the manager's multi-URI lock (sorted,
 * deadlock-free) held across the whole stage→commit→`didChange` window. Every edited file is
 * confined to the root (realpath, all-or-nothing) BEFORE any I/O; resource operations
 * (Create/Rename/DeleteFile) are surfaced in the preview and refused on apply.
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
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyTextEdits, isPlausibleRenameName } from './apply.js'
import type { NavResult, ServerInfo } from './client.js'
import { assertAllowed, confineEditedUri, confineFile, LspGateError } from './confine.js'
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

/** One file to write during an apply commit. */
export interface FileWrite {
  absPath: string
  newText: string
}

/**
 * The write seam (injected; tests substitute a fake so the gate never touches disk). The default
 * is **stage-then-commit-all**: write every target to a sibling temp file (+ fsync), and only
 * once ALL temps are written, atomically rename each into place. The temp-stage phase fails
 * before any target file is touched; the rename burst is the only (documented) inconsistency
 * window. Returns the files actually committed.
 */
export interface RenameWriter {
  commit(writes: FileWrite[]): { written: string[] }
}

let tempCounter = 0

export const defaultRenameWriter: RenameWriter = {
  commit(writes) {
    const staged: Array<{ tmp: string; target: string }> = []
    try {
      for (const w of writes) {
        tempCounter += 1
        const tmp = `${w.absPath}.strummer-rename-${process.pid}-${tempCounter}`
        writeFileSync(tmp, w.newText, 'utf8')
        const fd = openSync(tmp, 'r+')
        fsyncSync(fd)
        closeSync(fd)
        staged.push({ tmp, target: w.absPath })
      }
    } catch (err) {
      for (const s of staged) {
        try {
          unlinkSync(s.tmp)
        } catch {
          // best-effort cleanup; nothing was renamed yet so no target is corrupt.
        }
      }
      throw err
    }
    const written: string[] = []
    for (const s of staged) {
      renameSync(s.tmp, s.target)
      written.push(s.target)
    }
    return { written }
  },
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
      { language: input.language, projectRoot: input.projectRoot, uri: queriedUri, text },
      async (client): Promise<RunOutcome> => {
        const pos = toLspPosition(text, input.line, input.column, client.encoding)
        const empty: NormalizedWorkspaceEdit = { files: [], resourceOps: [] }

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
   * Decide + execute the apply (single- OR multi-file). Confine EVERY edited URI all-or-nothing
   * BEFORE any I/O; then, under the multi-URI lock, read each target, hard-refuse on drift (the
   * queried file vs its compute text; every edit site vs the old identifier), build new content
   * via the pure apply core, stage-then-commit all, and `didChange`-resync any open file.
   */
  private async applyEdit(
    edit: NormalizedWorkspaceEdit,
    input: LspRenameInput,
    queriedUri: string,
    text: string,
    encoding: PositionEncoding,
  ): Promise<ApplyOutcome> {
    if (edit.resourceOps.length > 0) {
      return { applied: false, refused: 'resource operations are not applied in v1 (refused)' }
    }
    if (edit.files.length === 0) return { applied: false }

    // Confine-all before any I/O — one out-of-root URI refuses the WHOLE batch.
    const targets: Array<{ uri: string; abs: string; edits: NormalizedFileEdit[] }> = []
    for (const f of edit.files) {
      let abs: string
      try {
        abs = confineEditedUri(input.projectRoot, f.uri)
      } catch {
        return {
          applied: false,
          refused: 'an edited file is outside the project root; previewed only',
        }
      }
      targets.push({ uri: f.uri, abs, edits: f.edits })
    }

    return this.manager.runWithUris(
      { language: input.language, projectRoot: input.projectRoot, uris: targets.map((t) => t.uri) },
      async (client): Promise<ApplyOutcome> => {
        // Phase 1 (no writes): read every target, enforce the staleness guards, build new content.
        const plan: Array<{ abs: string; uri: string; before: string; after: string }> = []
        let expectedOld: string | undefined
        for (const t of targets) {
          const current = this.readFile(t.abs)
          if (current === undefined) {
            return {
              applied: false,
              refused: `cannot read edited file ${relative(input.projectRoot, t.abs)}`,
            }
          }
          if (t.uri === queriedUri && sha256(current) !== sha256(text)) {
            return {
              applied: false,
              refused: 'the file changed on disk since the rename was computed; re-query and retry',
            }
          }
          if (t.uri === queriedUri && t.edits[0]) {
            expectedOld = sliceByOffsets(current, t.edits[0].range, encoding)
          }
          plan.push({
            abs: t.abs,
            uri: t.uri,
            before: current,
            after: applyTextEdits(current, t.edits, encoding),
          })
        }
        // Every edit site must currently hold the SAME old identifier the rename targeted — a
        // strong, conservative staleness guard for the non-queried files (no compute baseline).
        if (expectedOld !== undefined) {
          for (const t of targets) {
            const cur = plan.find((p) => p.uri === t.uri)?.before as string
            for (const e of t.edits) {
              if (sliceByOffsets(cur, e.range, encoding) !== expectedOld) {
                return {
                  applied: false,
                  refused: 'an edit site no longer matches the renamed symbol; re-query and retry',
                }
              }
            }
          }
        }

        // Phase 2: stage-then-commit all, then resync open buffers.
        this.writer.commit(plan.map((p) => ({ absPath: p.abs, newText: p.after })))
        for (const p of plan) client.applyEdited(p.uri, p.after) // no-op for a non-open file
        return {
          applied: true,
          digests: plan.map((p) => ({
            file: relative(input.projectRoot, p.abs),
            before: sha256(p.before),
            after: sha256(p.after),
          })),
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
    const edits = edit.files.map((f) =>
      this.previewFile(f, input.projectRoot, queriedUri, queriedText, encoding),
    )
    const versionWarning =
      serverInfo === undefined
        ? 'the language server did not report its version (serverInfo); the rename cannot be attributed to a specific server version'
        : undefined
    return {
      status: run.status,
      kind: 'rename',
      applied: run.apply.applied,
      ...(run.refused ? { refused: run.refused } : {}),
      newName: input.newName,
      fileCount: edit.files.length,
      totalEditCount,
      edits,
      ...(edit.resourceOps.length > 0 ? { resourceOps: edit.resourceOps } : {}),
      ...(run.apply.digests ? { digests: run.apply.digests } : {}),
      ...(serverInfo ? { serverInfo } : {}),
      ...(input.toolchain ? { toolchain: input.toolchain } : {}),
      encoding,
      ...(versionWarning ? { versionWarning } : {}),
    }
  }

  private previewFile(
    f: { uri: string; edits: NormalizedFileEdit[] },
    projectRoot: string,
    queriedUri: string,
    queriedText: string,
    encoding: PositionEncoding,
  ): RenamePreviewFile {
    let abs: string | undefined
    try {
      abs = confineEditedUri(projectRoot, f.uri)
    } catch {
      // Out of root: surface path + count ONLY, never read/surface its bytes (disclosure guard).
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
      file: relative(projectRoot, abs),
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
