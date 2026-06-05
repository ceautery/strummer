import type { SecretStore } from './model.js'

// The redaction boundary is shared across pillars; it lives in @sackville/safety.
// Re-exported here so existing `import { Redactor } from './secrets.js'` sites
// (runner, prepare, script, …) keep working unchanged.
export { Redactor } from '@sackville/safety'

/** In-memory store (tests / explicit injection). */
export class StaticSecretStore implements SecretStore {
  constructor(private readonly values: Record<string, string> = {}) {}
  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.values[name])
  }
}

/**
 * Reads `<prefix><NAME>` from the environment — the zero-dependency default
 * (Linux/CI). The default prefix is `SACKVILLE_SECRET_`; the aggregate server
 * overrides it to `SACKVILLE_API_SECRET_` so the api pillar's secrets live in its
 * own namespace and can't be read via a bare, shared name (ADR 0019).
 */
export class EnvSecretStore implements SecretStore {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly prefix = 'SACKVILLE_SECRET_',
  ) {}
  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.env[`${this.prefix}${name}`])
  }
}

/** OS keychain via @napi-rs/keyring (macOS/Windows/Linux-desktop). The native
 * module is loaded lazily through a non-literal specifier so importing this file
 * never loads it; Secret Service can throw at runtime in headless containers, so
 * failures resolve to undefined. */
export class KeyringSecretStore implements SecretStore {
  constructor(private readonly service = 'sackville') {}
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

/**
 * Default store: keyring (opt-in) chained ahead of env, else env only.
 * `env`/`envPrefix` override the environment source + variable prefix the
 * `EnvSecretStore` reads (the aggregate server passes `SACKVILLE_API_SECRET_`).
 */
export function resolveSecretStore(
  opts: { keyring?: boolean; env?: Record<string, string | undefined>; envPrefix?: string } = {},
): SecretStore {
  const envStore = new EnvSecretStore(opts.env, opts.envPrefix)
  return opts.keyring ? new ChainedSecretStore([new KeyringSecretStore(), envStore]) : envStore
}
