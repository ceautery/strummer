import { defineConfig } from 'tsdown'

// `@strummer/verdict` type-imports the pillar result interfaces. Keep those
// workspace packages EXTERNAL in both the JS and the dts: the emitted code uses
// only `import type`, so nothing is bundled and no pillar runtime is ever pulled
// in (the gate-independence posture, ADR 0013 §2). The published `.d.ts` keeps
// `import type { … } from '@strummer/api'` references, which resolve in any
// consumer (mcp/cli) that already depends on the pillars.
export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  external: [/^@strummer\//],
})
