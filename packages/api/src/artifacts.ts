export interface Artifact {
  contentType: string
  body: string
}

/**
 * In-memory store for response bodies, addressed by a `sackville://run/<id>/body`
 * handle. Agents/CLIs fetch bodies by handle so large payloads are never inlined
 * into tool results. (A persistent backend can replace this later.)
 */
export class ArtifactStore {
  private artifacts = new Map<string, Artifact>()

  put(runId: string, body: string, contentType: string): string {
    const handle = `sackville://run/${runId}/body`
    this.artifacts.set(handle, { body, contentType })
    return handle
  }

  get(handle: string): Artifact | undefined {
    return this.artifacts.get(handle)
  }
}
