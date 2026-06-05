#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildAggregateServer } from './aggregate.js'
import { isMainModule } from './is-main.js'

// The AGGREGATE Sackville MCP server (`sackville-mcp`, repointed per ADR 0019): one
// stdio process exposing every ENABLED pillar. Pillars are loaded by dynamic import,
// so a deployment that doesn't enable a heavy pillar never loads its engine. Select
// with SACKVILLE_TOOLSETS (unset ⇒ the curated read-heavy default); each pillar reads
// its own SACKVILLE_<PILLAR>_* gate. The narrow single-pillar bins (sackville-docs-mcp,
// sackville-api-mcp, …) remain available for minimal deployments.
if (isMainModule(import.meta.url)) {
  const { server, shutdown, enabled, disabled } = await buildAggregateServer()
  process.stderr.write(
    `sackville-mcp: enabled [${enabled.join(', ')}]` +
      (disabled.length ? `; disabled [${disabled.map((d) => d.pillar).join(', ')}]` : '') +
      '\n',
  )
  // Single SIGINT/SIGTERM teardown of every enabled pillar's owned resources
  // (SSRF proxies, LSP/browser managers, sqlite handles).
  let closing = false
  const onSignal = async () => {
    if (closing) return
    closing = true
    await shutdown()
    process.exit(0)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  await server.connect(new StdioServerTransport())
}
