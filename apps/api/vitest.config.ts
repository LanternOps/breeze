import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@breeze/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // *.integration.test.ts files (wherever they live) connect to a real
    // Postgres via withDbAccessContext and only run under
    // vitest.integration.config.ts. Exclude them from the unit run so the
    // DB-less unit job (`vitest`, `test-api` in CI) doesn't try to execute
    // them against a non-existent pool.
    exclude: ['src/__tests__/integration/**', 'src/**/*.integration.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        'src/db/schema/**',
        'src/index.ts'
      ]
    }
  }
});
