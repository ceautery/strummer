import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Run internal packages from source — no build step in the test loop.
      '@strummer/artifacts': fileURLToPath(
        new URL('./packages/artifacts/src/index.ts', import.meta.url),
      ),
      '@strummer/assert': fileURLToPath(new URL('./packages/assert/src/index.ts', import.meta.url)),
      '@strummer/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@strummer/coverage': fileURLToPath(
        new URL('./packages/coverage/src/index.ts', import.meta.url),
      ),
      '@strummer/deps': fileURLToPath(new URL('./packages/deps/src/index.ts', import.meta.url)),
      '@strummer/embed': fileURLToPath(new URL('./packages/embed/src/index.ts', import.meta.url)),
      '@strummer/flake': fileURLToPath(new URL('./packages/flake/src/index.ts', import.meta.url)),
      '@strummer/api': fileURLToPath(new URL('./packages/api/src/index.ts', import.meta.url)),
      '@strummer/browser': fileURLToPath(
        new URL('./packages/browser/src/index.ts', import.meta.url),
      ),
      '@strummer/safety': fileURLToPath(new URL('./packages/safety/src/index.ts', import.meta.url)),
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
