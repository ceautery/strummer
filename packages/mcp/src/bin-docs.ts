#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDb } from '@sackville-mcp/core'
import { QueryEmbedder } from '@sackville-mcp/embed'
import { createSackvilleServer } from './docs.js'
import { isMainModule } from './is-main.js'

// The DOCS-ONLY standalone server (`sackville-docs-mcp`). The aggregate server
// (`sackville-mcp`, ./bin.ts) composes docs alongside the other pillars; this bin
// is the narrow single-pillar deployment. Tail is import.meta-guarded so the module
// can be imported without side effects.
if (isMainModule(import.meta.url)) {
  const indexPath = process.env.SACKVILLE_INDEX ?? process.argv[2]
  if (!indexPath) {
    process.stderr.write('Usage: sackville-docs-mcp <index.sqlite>  (or set SACKVILLE_INDEX)\n')
    process.exit(1)
  }
  const db = openDb(indexPath)
  const server = createSackvilleServer(db, { embedder: new QueryEmbedder() })
  await server.connect(new StdioServerTransport())
}
