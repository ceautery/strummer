import { defineConfig } from 'vitest/config'

export default defineConfig({
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
