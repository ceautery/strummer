import { defineConfig } from 'tsdown'

// `@strummer/verdict` type-imports the pillar result interfaces and has exactly
// ONE runtime workspace import — the pure, zero-dep `@strummer/severity` leaf (the
// shared severity scale). Keep all `@strummer/*` EXTERNAL in both the JS and the
// dts: the pillar references are `import type` only (nothing bundled, no pillar
// runtime ever pulled in — the gate-independence posture, ADR 0013 §2), and
// `@strummer/severity` resolves as a normal workspace dependency in any consumer.
// So the emitted `.mjs` imports only that one pure leaf (it still drags in no heavy
// runtime — better-sqlite3/playwright-core stay out), and the published `.d.ts`
// keeps `import type { … } from '@strummer/api'` references, which resolve in any
// consumer (mcp/cli) that already depends on the pillars.
export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  external: [/^@strummer\//],
})
