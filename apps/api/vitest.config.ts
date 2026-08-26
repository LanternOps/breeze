import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
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
      // Fleet posture report real-DB test (#3244): the mixed
      // never-scanned/stale/clean/detected fixture needs real Postgres (the
      // shared integration setup + system DB context), so the no-DB unit
      // runner must not pick it up. Belongs to vitest.integration.config.ts.
      'src/services/managementPostureReport.integration.test.ts',
      // Patch ingest status-transition real-DB test (#2725): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate), so
      // the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts.
      'src/routes/agents/patches.integration.test.ts',
      // Enrollment idempotency real-DB test (#2764): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/routes/agents/ — outside the `src/__tests__/integration/**`
      // glob above — so the no-DB unit runner would fail it on connect. Belongs
      // to vitest.integration.config.ts (already in its include list).
      'src/routes/agents/enrollmentCollision.integration.test.ts',
      // Software-report re-link real-DB test (BREEZE-3): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate), so the
      // no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts.
      'src/routes/agents/inventorySoftwareRelink.integration.test.ts',
      // Platform-admin bootstrap real-DB test (#2655): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate in its
      // beforeAll), so the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (already in its include).
      'src/services/platformAdminBootstrap.integration.test.ts',
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
      // Supervised plain-decide branch real-DB test (Task 6 fix round 1,
      // finding 4): imports `__tests__/integration/setup` (real postgres pool
      // + autoMigrate) and lives in src/routes/ outside the
      // `src/__tests__/integration/**` glob, so the no-DB unit runner would
      // fail it on connect. Belongs to vitest.integration.config.ts
      // (registered in its include list).
      'src/routes/approvalsDecideSupervised.integration.test.ts',
      // Partner-scoped report-suspicious real-DB test (#3234): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/routes/ outside the `src/__tests__/integration/**` glob,
      // so the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (registered in its include list).
      'src/routes/approvalsReportSuspiciousPartnerScope.integration.test.ts',
      // Create-path atomicity + tenant-isolation real-DB test (Task 7): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/services/actionIntents/ outside the
      // `src/__tests__/integration/**` glob, so the no-DB unit runner would fail
      // it on connect. Belongs to vitest.integration.config.ts (in its include).
      'src/services/actionIntents/createIntentAtomicity.integration.test.ts',
      // Headless Google Tier-3 dispatch real-DB test (Phase 2): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/jobs/ outside the `src/__tests__/integration/**` glob, so
      // the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (registered in its include list).
      'src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts',
      // Headless M365 Tier-3 dispatch real-DB test (Task 9): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/jobs/ outside the `src/__tests__/integration/**` glob, so
      // the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (registered in its include list).
      'src/jobs/intentReleaseWorkerM365Headless.integration.test.ts',
      // Two-replica runtime extension reconcile + failure policy (Task 8,
      // issue #2619): imports `__tests__/integration/setup` (real postgres
      // pool) and forks real child processes against `:5433`. Belongs to
      // vitest.integration.config.ts (already in its include).
      'src/extensions/twoReplicaReconcile.integration.test.ts',
      // Disabled built-in extension's table-existence probe against a real
      // server: imports `__tests__/integration/setup` (real postgres pool) and
      // provisions its own throwaway database. Belongs to
      // vitest.integration.config.ts (already in its include).
      'src/extensions/builtinTableProbe.integration.test.ts',
      // Reset-password reveal secret lifecycle (CAS burn + expiry-reaper
      // sweep): imports `__tests__/integration/setup` (real postgres pool
      // + autoMigrate) and lives in src/services/actionIntents/ outside the
      // `src/__tests__/integration/**` glob, so the no-DB unit runner would
      // fail it on connect. Belongs to vitest.integration.config.ts
      // (registered in its include list).
      'src/services/actionIntents/resultSecrets.integration.test.ts',
      // Real-Redis integration test for the #2707 approver-device register
      // grant chain: imports `__tests__/integration/setup` (real Redis via
      // ioredis), so the no-Redis unit runner would fail it on connect.
      // Belongs to vitest.integration.config.ts (registered in its include
      // list). NOT the same file as the co-located mocked unit suite
      // `mfaStepUpGrant.test.ts`, which stays on this runner.
      'src/services/mfaStepUpGrant.integration.test.ts',
      // Track D real-PostgreSQL suites. These import the shared integration
      // setup and are owned by vitest.integration.config.ts.
      'src/services/peripheralEffectivePolicy.integration.test.ts',
      'src/services/peripheralPolicyState.integration.test.ts',
      'src/services/agentRollback.integration.test.ts',
      'src/services/agentRollbackResult.integration.test.ts',
      // Enrollment-key cleanup sweep real-DB test (#2775 live-bootstrap-token
      // exemption): imports `__tests__/integration/setup` (real postgres pool
      // + autoMigrate) and lives in src/jobs/ outside the
      // `src/__tests__/integration/**` glob, so the no-DB unit runner would
      // fail it on connect. Belongs to vitest.integration.config.ts
      // (registered in its include list).
      'src/jobs/enrollmentKeyCleanup.integration.test.ts',
      // On-demand enrollment-key purge route real-DB test (#2832
      // live-bootstrap-token exemption): imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate) and
      // lives in src/routes/ outside the `src/__tests__/integration/**` glob,
      // so the no-DB unit runner would fail it on connect. Belongs to
      // vitest.integration.config.ts (registered in its include list).
      'src/routes/enrollmentKeysPurgeExpired.integration.test.ts',
      // Enrollment-key list-filter real-DB test (#3191 live-installer-token
      // carve-out on ?expired=): same story as the two above — imports
      // `__tests__/integration/setup` and lives outside the
      // `src/__tests__/integration/**` glob, so the no-DB unit runner would
      // fail it on connect. Belongs to vitest.integration.config.ts.
      'src/routes/enrollmentKeysExpiredFilter.integration.test.ts',
      // Real-DB suites owned by vitest.integration.config.ts (#3778).
      'src/services/invoiceService.issue.integration.test.ts',
      'src/services/invoicePdf.integration.test.ts',
      // Canary for issue #4046: asserts the process observes a non-UTC
      // offset. It must ONLY run under the pinned non-UTC pass
      // (vitest.config.tz.ts, TZ=America/Denver), where it belongs — it is
      // excluded here deliberately, not because it doesn't apply to the
      // unit runner: it WOULD fail on this (UTC) runner, since that is
      // exactly the point of the check.
      'src/__tests__/tzPinCanary.test.ts',
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
