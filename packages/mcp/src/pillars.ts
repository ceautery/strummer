import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * A pillar's contribution to a (possibly SHARED) MCP server — the seam the
 * aggregate server composes (ADR 0019). Each bin exposes a `setup<Pillar>FromEnv`
 * that parses its OWN `SACKVILLE_<PILLAR>_*` env (unchanged from its standalone
 * bin) and returns this:
 *
 *  - `register(server)` registers the pillar's tools/resources onto the given
 *    server via its `register<X>Tools` seam (so multiple pillars share one server).
 *  - `shutdown()` tears down any long-lived resources the setup OWNS (an SSRF
 *    proxy, an LSP manager, a sqlite handle, sweep timers). Light/pure pillars
 *    omit it.
 *
 * The aggregate calls `register` for every enabled pillar and collects every
 * `shutdown` for a single SIGINT/SIGTERM teardown. The same setup powers each
 * standalone `build<X>ServerFromEnv`, so the two surfaces can never drift.
 */
export interface PillarSetup {
  register: (server: McpServer) => void
  shutdown?: () => Promise<void> | void
}
