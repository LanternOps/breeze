import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` and `@breeze/shared` paths in apps/portal/tsconfig.json so
      // vitest can resolve app + workspace imports without a build step. Required for
      // any component test whose module graph reaches `@/lib/*` or `@breeze/shared`
      // (e.g. the ticket-intake renderer). Mirrors apps/web/vitest.config.ts.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@breeze/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url)
      )
    }
  },
  test: {
    globals: true,
    // Node by default (most portal suites are pure lib logic). Component test files
    // opt into jsdom per-file via a `// @vitest-environment jsdom` header comment.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true
  }
});
