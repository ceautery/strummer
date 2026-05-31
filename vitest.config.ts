import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Run internal packages from source — no build step in the test loop.
      '@strummer/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // better-sqlite3 / sqlite-vec are native CJS modules; let Node load them
    // directly instead of having Vite try to transform them.
    server: {
      deps: {
        external: ['better-sqlite3', 'sqlite-vec'],
      },
    },
  },
})
