import {
  type Artifact,
  type ArtifactStoreOptions,
  ArtifactStore as BaseArtifactStore,
} from '@sackville-mcp/artifacts'

/**
 * The browser pillar's artifact metadata. Alias of the shared `Artifact` (the
 * store was extracted into `@sackville-mcp/artifacts` per ADR 0010); retained so the
 * pillar's existing `BrowserArtifact` imports keep resolving.
 */
export type BrowserArtifact = Artifact

/**
 * On-disk artifact store for browser runs — the shared `@sackville-mcp/artifacts`
 * store with the browser handle prefix (`sackville://browser/run/<id>/<kind>`)
 * baked in, so every browser call site constructs it with just a base dir.
 */
export class ArtifactStore extends BaseArtifactStore {
  constructor(baseDir: string, opts?: ArtifactStoreOptions) {
    super(baseDir, 'browser/run', opts)
  }
}
