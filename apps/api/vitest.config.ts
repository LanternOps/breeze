import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
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
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [
      'src/__tests__/integration/**',
      // Real-PostgreSQL exact request-pool role checks have a dedicated runner.
      'src/db/requestDatabaseRole.integration.test.ts',
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
      // Device change ingest real-DB test (#2502 Phase 2): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate in its
      // beforeAll), so the unit runner's no-DB environment fails the suite on
      // connect. Belongs to vitest.integration.config.ts.
      'src/routes/agents/changes.integration.test.ts',
      // Software-report re-link real-DB test (BREEZE-3): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate), so the
      // no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts.
      'src/routes/agents/inventorySoftwareRelink.integration.test.ts',
      // Auth-email worker real-DB test (SR2-22): imports `__tests__/integration/setup`
      // (real postgres pool + autoMigrate + real Redis) and lives in src/jobs/ — outside
      // the `src/__tests__/integration/**` glob above — so the no-DB unit runner would
      // fail it on connect. Belongs to vitest.integration.config.ts (already in its include).
      'src/jobs/authEmailWorker.integration.test.ts',
      // Quote scheduled-send queue real-DB + real-Redis test: imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate + real
      // Redis) and lives in src/jobs/ outside the `src/__tests__/integration/**`
      // glob, so the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (registered in its include list).
      'src/jobs/quoteSendQueue.integration.test.ts',
      // Intent stale-execution reaper real-DB test: imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/jobs/ outside the `src/__tests__/integration/**` glob,
      // so the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (registered in its include list).
      'src/jobs/intentExpiryReaper.integration.test.ts',
      // Decide-path intent fan-in atomicity real-DB test (Task 6): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/routes/ outside the `src/__tests__/integration/**` glob,
      // so the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (registered in its include list).
      'src/routes/approvalsDecideAtomicity.integration.test.ts',
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
