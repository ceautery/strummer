#!/usr/bin/env node
import { QueryEmbedder } from '@strummer/embed'
import { run } from './index.js'

const code = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  embedder: new QueryEmbedder(),
  env: process.env,
})
process.exit(code)
