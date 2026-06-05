/**
 * The operator-bound language→server registry (ADR 0011). Safety-critical: the agent supplies
 * only a `language` string and NEVER a binary, argv, or path. The operator binds the registry
 * out-of-band (`SACKVILLE_LSP_SERVERS`, JSON); a language absent from it is refused, never
 * spawned.
 *
 * The registry is **JSON with `command` and `args[]` structurally separate** — deliberately
 * NOT a `lang=cmd args;…` mini-DSL the engine would re-split, because real server commands
 * routinely contain spaces, `=`, and wrapper prefixes (`rustup run stable rust-analyzer`).
 * Splitting a string would corrupt those; an explicit array cannot.
 */

/** One operator-registered language server: the binary + argv, kept structurally separate. */
export interface ServerRegistryEntry {
  command: string
  args: string[]
  /** Passed verbatim as the LSP `initialize` `initializationOptions` (hardening flags, etc.). */
  initializationOptions?: unknown
  /** The `languageId` sent in `didOpen`; defaults to the registry key when omitted. */
  languageId?: string
}

/** The full registry, keyed by the agent-facing `language` string. */
export type ServerRegistry = Record<string, ServerRegistryEntry>

/** Thrown on a malformed operator registry or a request for an unbound language. */
export class LspRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspRegistryError'
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * Parse + validate the operator JSON registry. Fails loud on anything malformed — an
 * operator misconfiguration must be a clear error, never a silently-empty or
 * partially-parsed registry an agent then queries against.
 */
export function parseServerRegistry(json: string): ServerRegistry {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    throw new LspRegistryError(`registry is not valid JSON: ${(e as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LspRegistryError('registry must be a JSON object keyed by language')
  }
  const out: ServerRegistry = {}
  for (const [language, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new LspRegistryError(`registry entry for "${language}" must be an object`)
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.command !== 'string' || entry.command.length === 0) {
      throw new LspRegistryError(
        `registry entry for "${language}" needs a non-empty string command`,
      )
    }
    if (entry.args !== undefined && !isStringArray(entry.args)) {
      throw new LspRegistryError(
        `registry entry for "${language}" args must be an array of strings`,
      )
    }
    if (entry.languageId !== undefined && typeof entry.languageId !== 'string') {
      throw new LspRegistryError(`registry entry for "${language}" languageId must be a string`)
    }
    out[language] = {
      command: entry.command,
      args: (entry.args as string[] | undefined) ?? [],
      ...(entry.initializationOptions !== undefined
        ? { initializationOptions: entry.initializationOptions }
        : {}),
      ...(entry.languageId !== undefined ? { languageId: entry.languageId as string } : {}),
    }
  }
  if (Object.keys(out).length === 0) {
    throw new LspRegistryError('registry is empty — bind at least one language→server')
  }
  return out
}

/** Resolve a language to its registered server, or refuse it (never spawns an unbound server). */
export function resolveServer(registry: ServerRegistry, language: string): ServerRegistryEntry {
  const entry = registry[language]
  if (!entry) {
    const bound = Object.keys(registry).join(', ') || '(none)'
    throw new LspRegistryError(`no server bound for language "${language}" (bound: ${bound})`)
  }
  return entry
}
