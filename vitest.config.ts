import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Run internal packages from source — no build step in the test loop.
      '@sackville-mcp/artifacts': fileURLToPath(
        new URL('./packages/artifacts/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/assert': fileURLToPath(
        new URL('./packages/assert/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/coverage': fileURLToPath(
        new URL('./packages/coverage/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/deps': fileURLToPath(
        new URL('./packages/deps/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/diff': fileURLToPath(
        new URL('./packages/diff/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/embed': fileURLToPath(
        new URL('./packages/embed/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/flake': fileURLToPath(
        new URL('./packages/flake/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/mutate': fileURLToPath(
        new URL('./packages/mutate/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/lsp': fileURLToPath(new URL('./packages/lsp/src/index.ts', import.meta.url)),
      '@sackville-mcp/api': fileURLToPath(new URL('./packages/api/src/index.ts', import.meta.url)),
      '@sackville-mcp/browser': fileURLToPath(
        new URL('./packages/browser/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/safety': fileURLToPath(
        new URL('./packages/safety/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/spawn': fileURLToPath(
        new URL('./packages/spawn/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/severity': fileURLToPath(
        new URL('./packages/severity/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/verdict': fileURLToPath(
        new URL('./packages/verdict/src/index.ts', import.meta.url),
      ),
      '@sackville-mcp/verify': fileURLToPath(
        new URL('./packages/verify/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'test/**/*.test.ts'],
    // better-sqlite3 / sqlite-vec are native CJS modules; let Node load them
    // directly instead of having Vite try to transform them.
    server: {
      deps: {
        external: ['better-sqlite3', 'sqlite-vec'],
      },
    },
  },
})
