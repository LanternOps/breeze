import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@breeze/extension-api': path.resolve(__dirname, '../../packages/extension-api/src'),
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
      // BE-16 vulnerability management: co-located real-DB integration tests that
      // import `__tests__/integration/setup` (real postgres pool + autoMigrate in
      // its beforeAll). They belong to vitest.integration.config.ts; in the unit
      // runner (no DB) the setup connection fails the suite. Same rationale as the
      // inboundEmail exclusion above.
      'src/services/vulnerability*.integration.test.ts',
      'src/services/aiToolsVulnerability.integration.test.ts',
      'src/services/cpeMap.integration.test.ts',
      'src/services/cpeResolution.integration.test.ts',
      'src/services/exploitFeeds.integration.test.ts',
      'src/jobs/vulnerability*.integration.test.ts',
      // Warranty alert evaluator real-DB test: imports `__tests__/integration/setup`
      // (real postgres + autoMigrate). Belongs to vitest.integration.config.ts;
      // the no-DB unit runner would fail it on connect.
      'src/services/warrantyAlertEvaluator.integration.test.ts',
      // Suppression-expiry reaper real-DB test: imports `__tests__/integration/setup`
      // (real postgres pool + autoMigrate in its beforeAll), so the unit runner's
      // no-DB environment fails the suite on connect. Belongs to vitest.integration.config.ts.
      'src/jobs/suppressionExpiryReaper.integration.test.ts',
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
