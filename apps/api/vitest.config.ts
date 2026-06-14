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
    exclude: [
      'src/__tests__/integration/**',
      // Real-driver integration test for the inbound email pipeline. It needs the
      // integration setup (real postgres pool + autoMigrate seed) and is run by
      // vitest.integration.config.ts — not the unit runner, which has no DB.
      // (manifestSigning.integration.test.ts is intentionally NOT excluded: it is
      // a mocked unit test despite its name and belongs to this unit runner.)
      'src/services/inboundEmail/**/*.integration.test.ts',
    ],
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
