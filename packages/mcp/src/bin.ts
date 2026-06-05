#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildAggregateServer } from './aggregate.js'

// The AGGREGATE Strummer MCP server (`strummer-mcp`, repointed per ADR 0019): one
// stdio process exposing every ENABLED pillar. Pillars are loaded by dynamic import,
// so a deployment that doesn't enable a heavy pillar never loads its engine. Select
// with STRUMMER_TOOLSETS (unset ⇒ the curated read-heavy default); each pillar reads
// its own STRUMMER_<PILLAR>_* gate. The narrow single-pillar bins (strummer-docs-mcp,
// strummer-api-mcp, …) remain available for minimal deployments.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, shutdown, enabled, disabled } = await buildAggregateServer()
  process.stderr.write(
    `strummer-mcp: enabled [${enabled.join(', ')}]` +
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
