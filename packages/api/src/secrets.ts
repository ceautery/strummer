import type { SecretStore } from './model.js'

/** In-memory store (tests / explicit injection). */
export class StaticSecretStore implements SecretStore {
  constructor(private readonly values: Record<string, string> = {}) {}
  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.values[name])
  }
}

/** Reads `STRUMMER_SECRET_<NAME>` — the zero-dependency default (Linux/CI). */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.env[`STRUMMER_SECRET_${name}`])
  }
}

/** OS keychain via @napi-rs/keyring (macOS/Windows/Linux-desktop). The native
 * module is loaded lazily through a non-literal specifier so importing this file
 * never loads it; Secret Service can throw at runtime in headless containers, so
 * failures resolve to undefined. */
export class KeyringSecretStore implements SecretStore {
  constructor(private readonly service = 'strummer') {}
  async get(name: string): Promise<string | undefined> {
    try {
      const moduleId: string = '@napi-rs/keyring'
      const { Entry } = await import(moduleId)
      const value = new Entry(this.service, name).getPassword()
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }
}

/** Try each store in order, first hit wins. */
export class ChainedSecretStore implements SecretStore {
  constructor(private readonly stores: SecretStore[]) {}
  async get(name: string): Promise<string | undefined> {
    for (const store of this.stores) {
      const value = await store.get(name)
      if (value !== undefined) return value
    }
    return undefined
  }
}

/** Default store: keyring (opt-in) chained ahead of env, else env only. */
export function resolveSecretStore(opts: { keyring?: boolean } = {}): SecretStore {
  return opts.keyring
    ? new ChainedSecretStore([new KeyringSecretStore(), new EnvSecretStore()])
    : new EnvSecretStore()
}

/**
 * Tracks resolved secret values and scrubs them (and common encodings) from any
 * text returned to the agent. Replacement is exact-substring, so no value ever
 * leaks through logs, bodies, headers, or error text.
 */
export class Redactor {
  private readonly entries: { name: string; encodings: string[] }[] = []

  register(name: string, value: string): void {
    if (!value) return
    const encodings = [
      value,
      Buffer.from(value, 'utf8').toString('base64'),
      encodeURIComponent(value),
    ].filter((e) => e.length > 0)
    this.entries.push({ name, encodings: [...new Set(encodings)] })
  }

  redact(text: string): string {
    let out = text
    for (const { name, encodings } of this.entries) {
      for (const encoding of encodings) {
        out = out.split(encoding).join(`[redacted:${name}]`)
      }
    }
    return out
  }

  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) out[key] = this.redact(value)
    return out
  }
}
