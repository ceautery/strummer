import { defineConfig } from 'tsdown'

// `@sackville-mcp/verify` is the run-driving orchestration layer (ADR 0013 Addendum,
// milestone 5c). It TYPE-imports the pillar result interfaces and RUNTIME-imports
// only the pure `@sackville-mcp/verdict` — never an engine runtime. Keep all
// `@sackville-mcp/*` external: the emitted `.mjs` then references only `@sackville-mcp/verdict`
// (which itself has zero imports) + `node:crypto`, so the orchestrator drags in NO
// spawn-capable code (no `better-sqlite3`/`playwright-core`/`defaultVitestRunner`).
// That is the load-bearing "imports zero spawn-capable code" invariant (§ gate (e)).
export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  // `deps.neverBundle` (tsdown >=0.22; the base option applies to both the JS bundle
  // and the dts, so no separate `deps.dts.neverBundle` override is needed). Replaces
  // the deprecated top-level `external`.
  deps: { neverBundle: [/^@sackville-mcp\//] },
})
