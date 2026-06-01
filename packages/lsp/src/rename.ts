/**
 * The gated LSP rename engine (ADR 0011 write-mode addendum, Slice F). The first WRITE surface
 * of the pillar. It mirrors `LspQueryEngine` but layers a SECOND operator gate — `allowWrite` —
 * on top of the read gate (`allowRun` + `allowedRoots`): rename is **dry-run by default**
 * (compute + preview, ZERO disk writes) and applies to disk only when `allowWrite` is set AND
 * every safety condition holds.
 *
 * v1 scope (single-file): apply only when the WorkspaceEdit touches exactly the queried file
 * (the file the per-`(server,uri)` lock covers). Multi-file edits are previewable but refused on
 * apply until the multi-URI lock primitive lands (Slice F′). Resource operations
 * (Create/Rename/DeleteFile) are surfaced in the preview and refused on apply.
 *
 * The adversarial corrections baked in here: oldText is sliced with absolute offsets (never
 * reconstructed from line:col); apply is hash-drift-guarded then stage-then-commit (the injected
 * writer); out-of-root edits never have their bytes read/surfaced; the post-write `didChange`
 * doc-sync runs inside the held lock; secrets are redacted in every surfaced hunk.
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
        if (r.status !== 'ok') return base(r, r.result, { applied: false })

        const apply = await this.maybeApply(
          r.result,
          input,
          queriedAbs,
          queriedUri,
          text,
          r.encoding,
          client,
        )
        return base(r, r.result, apply, apply.refused)
      },
    )

    return this.shape(input, run, queriedAbs, queriedUri, text)
  }

  /** Decide + execute the single-file apply, inside the held lock. Pure-preview unless allowWrite. */
  private async maybeApply(
    edit: NormalizedWorkspaceEdit,
    input: LspRenameInput,
    queriedAbs: string,
    queriedUri: string,
    text: string,
    encoding: PositionEncoding,
    client: { applyEdited: (uri: string, newText: string) => void },
  ): Promise<ApplyOutcome> {
    if (!this.allowWrite) return { applied: false }
    if (edit.resourceOps.length > 0) {
      return { applied: false, refused: 'resource operations are not applied in v1 (refused)' }
    }
    if (edit.files.length === 0) return { applied: false }
    if (edit.files.length > 1) {
      return {
        applied: false,
        refused: 'multi-file apply requires the multi-URI lock (staged); previewed only',
      }
    }
    const only = edit.files[0] as { uri: string; edits: NormalizedFileEdit[] }
    let absOnly: string
    try {
      absOnly = confineEditedUri(input.projectRoot, only.uri)
    } catch {
      return {
        applied: false,
        refused: 'the edited file is outside the project root; previewed only',
      }
    }
    if (absOnly !== queriedAbs) {
      return {
        applied: false,
        refused: 'multi-file apply requires the multi-URI lock (staged); previewed only',
      }
    }
    // Hash-drift guard: the TextEdit offsets are valid ONLY against the text they were computed
    // from. Re-read disk and hard-refuse on any drift, regardless of version.
    const current = this.readFile(queriedAbs)
    if (current === undefined || sha256(current) !== sha256(text)) {
      return {
        applied: false,
        refused: 'the file changed on disk since the rename was computed; re-query and retry',
      }
    }
    const newText = applyTextEdits(text, only.edits, encoding)
    this.writer.commit([{ absPath: queriedAbs, newText }])
    client.applyEdited(queriedUri, newText) // resync the server buffer (under the lock)
    return {
      applied: true,
      digests: [
        {
          file: relative(input.projectRoot, queriedAbs),
          before: sha256(text),
          after: sha256(newText),
        },
      ],
    }
  }

  private shape(
    input: LspRenameInput,
    run: RunOutcome,
    queriedAbs: string,
    queriedUri: string,
    queriedText: string,
  ): LspRenameResult {
    const { edit, encoding, serverInfo } = run
    const totalEditCount = edit.files.reduce((n, f) => n + f.edits.length, 0)
    const edits = edit.files.map((f) =>
      this.previewFile(f, input.projectRoot, queriedAbs, queriedUri, queriedText, encoding),
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
    queriedAbs: string,
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
