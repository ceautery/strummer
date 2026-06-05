import { defineConfig } from 'tsdown'

// `@sackville/verify` is the run-driving orchestration layer (ADR 0013 Addendum,
// milestone 5c). It TYPE-imports the pillar result interfaces and RUNTIME-imports
// only the pure `@sackville/verdict` — never an engine runtime. Keep all
// `@sackville/*` external: the emitted `.mjs` then references only `@sackville/verdict`
// (which itself has zero imports) + `node:crypto`, so the orchestrator drags in NO
// spawn-capable code (no `better-sqlite3`/`playwright-core`/`defaultVitestRunner`).
// That is the load-bearing "imports zero spawn-capable code" invariant (§ gate (e)).
export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  external: [/^@sackville\//],
})
