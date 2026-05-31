#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createApiServer } from './index.js'

// Operator-controlled safety, set at launch — never by the agent. Mutating
// requests stay dry-run unless BOTH are provided (see ADR 0004).
//   STRUMMER_ALLOW_UNSAFE=1
//   STRUMMER_ALLOWED_HOSTS=api.example.com,127.0.0.1
const allowUnsafe = ['1', 'true', 'yes'].includes(
  (process.env.STRUMMER_ALLOW_UNSAFE ?? '').toLowerCase(),
)
const allowedHosts = (process.env.STRUMMER_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

const server = createApiServer({ allowUnsafe, allowedHosts })
await server.connect(new StdioServerTransport())
