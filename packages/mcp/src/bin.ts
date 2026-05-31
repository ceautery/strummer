#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDb } from '@strummer/core'
import { createStrummerServer } from './index.js'

const indexPath = process.env.STRUMMER_INDEX ?? process.argv[2]
if (!indexPath) {
  process.stderr.write('Usage: strummer-mcp <index.sqlite>  (or set STRUMMER_INDEX)\n')
  process.exit(1)
}

const db = openDb(indexPath)
const server = createStrummerServer(db)
await server.connect(new StdioServerTransport())
