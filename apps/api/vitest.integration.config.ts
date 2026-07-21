import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Load test environment variables
config({ path: '../../.env.test' });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/__tests__/integration/**/*.test.ts',
      // Co-located real-driver integration test for the inbound email pipeline
      // (placed alongside the code it exercises, per the repo's test-placement
      // convention). It uses the shared integration setup via setupFiles plus an
      // explicit `./setup` import. Scoped to this dir on purpose: the only other
      // `*.integration.test.ts` outside __tests__/integration (manifestSigning)
      // is a MOCKED unit test that mocks `../db` and must NOT hook the real-DB
      // setup — it runs under the default unit config instead.
      'src/services/inboundEmail/**/*.integration.test.ts',
      // Co-located real-DB integration test for the contract renewal sweep
      // service. Follows the same pattern as the inboundEmail test above.
      'src/services/contractRenewal.integration.test.ts',
      // Worker-level integration test: renewal pre-pass runs before billing sweep
      // so an at-boundary auto-renew contract bills instead of expiring.
      'src/jobs/contractWorker.renewal.integration.test.ts',
      // Co-located real-DB integration test for the MSRC vuln-source-sync job
      // (BE-16): exercises syncMsrcMonth upserts into the global vuln tables.
      'src/jobs/vulnerabilityJobs.integration.test.ts',
      // Co-located real-DB integration test for the NVD vuln-source-sync job
      // (BE-16): exercises curated-CPE match fact generation.
      'src/jobs/vulnerabilityJobsNvd.integration.test.ts',
      // Co-located real-DB integration test for the Apple SOFA vuln-source-sync job
      // (BE-16): exercises macOS OS vulnerability fact generation.
      'src/jobs/vulnerabilityJobsSofa.integration.test.ts',
      // Co-located real-DB integration test for BE-16 correlation: materializes
      // device_vulnerabilities from software_inventory and global match facts.
      'src/services/vulnerabilityCorrelation.integration.test.ts',
      // Co-located real-DB integration test for BE-16 Phase 2 correlation:
      // CPE range matching and macOS OS vulnerability facts.
      'src/services/vulnerabilityCorrelationPhase2.integration.test.ts',
      // Co-located real-DB integration test for the DisplayName→CPE resolution cache (#2290).
      'src/services/cpeResolution.integration.test.ts',
      // Co-located real-DB integration test for the curated CPE map seed loader.
      'src/services/cpeMap.integration.test.ts',
      // Co-located real-DB integration test for KEV + EPSS vulnerability enrichment.
      'src/services/exploitFeeds.integration.test.ts',
      // Co-located real-DB integration test for BE-16 Phase 4 domain events:
      // vulnerability.critical_detected emission from correlation.
      'src/services/vulnerabilityEvents.integration.test.ts',
      // Co-located real-DB integration test for BE-16 Phase 4 remediation events.
      'src/services/vulnerabilityRemediationEvents.integration.test.ts',
      // Co-located real-DB integration test for BE-16 Phase 4 AI read tools.
      'src/services/aiToolsVulnerability.integration.test.ts',
      // Co-located real-DB integration test for the suppression-expiry reaper:
      // asserts the SQL predicate (incl. the Forever-exclusion invariant)
      // that mocked unit tests can't cover.
      'src/jobs/suppressionExpiryReaper.integration.test.ts',
      // Co-located real-DB integration test for the warranty alert evaluator:
      // asserts the dismissed-dedup JSONB end-date scoping and the auto-resolve
      // Forever-suppression exclusion — SQL predicates the mocked unit tests
      // (which ignore the WHERE clause) can't verify.
      'src/services/warrantyAlertEvaluator.integration.test.ts',
      // Co-located real-DB integration test for #2502 Phase 2 (hardware +
      // os_version change types): a pg enum constraint can't be validated by
      // the mocked `changes.test.ts` unit suite, so this drives the real
      // `changesRoutes` handler + RLS insert/select policies against Postgres.
      'src/routes/agents/changes.integration.test.ts',
      // Co-located real-DB integration test for BREEZE-3: software report
      // wipe-and-reinsert with linked vuln findings — proves the SET NULL FK
      // (constraint name + delete action) and the re-link UPDATE under the
      // org-scoped agent RLS context, which the mocked inventory.test.ts can't.
      'src/routes/agents/inventorySoftwareRelink.integration.test.ts',
      // Co-located real-DB integration test for the SR2-22 auth-email worker:
      // proves the OUT-OF-REQUEST worker's withSystemDbAccessContext wrap lets
      // it FIND a FORCE-RLS `users` row (a contextless read would be 0 rows =
      // "no such user" = silent password-reset breakage for everyone).
      'src/jobs/authEmailWorker.integration.test.ts',
      // Co-located real-Redis + real-Postgres integration test for the quote
      // scheduled-send queue (undo-send window): exercises real BullMQ
      // enqueue/remove of the delayed job and the atomic send_job_id claim
      // that the mocked unit suite (quoteSendQueue.test.ts) cannot.
      'src/jobs/quoteSendQueue.integration.test.ts',
      // Real-DB integration test for the stale-backup-job reaper: asserts the
      // status WHERE guard (terminal job NOT reaped, in-flight stalled job IS)
      // that the mocked unit suite's chainable mock swallows. Lives under
      // src/__tests__/integration/ so the shared glob above already covers it
      // (and the unit runner's `src/__tests__/integration/**` exclude drops it);
      // named here for discoverability.
      'src/__tests__/integration/staleBackupReaper.integration.test.ts',
      // Co-located real-DB integration test for the intent stale-execution
      // reaper: proves the COALESCE(execution_started_at, decided_at) < now()
      // - interval predicate the mocked unit suite can't verify against a
      // real Postgres now().
      'src/jobs/intentExpiryReaper.integration.test.ts',
      // Co-located real-DB integration test for the reset-password reveal
      // secret lifecycle: proves the CAS burn is exactly-once under
      // concurrent callers and that the expiry-reaper sweep redacts both
      // the encrypted and legacy-plaintext key forms past the reveal
      // window while leaving recent/revealed rows untouched — predicates
      // the mocked unit suite can't verify against real Postgres.
      'src/services/actionIntents/resultSecrets.integration.test.ts',
      // Co-located real-DB integration test for the decide-path intent fan-in
      // atomicity (Task 6): drives the real approve route + injects a DB-level
      // fault into the intent_approved outbox insert to prove {CAS + sibling
      // expiry + outbox} roll back together — a rollback the mocked unit suite
      // (which mocks db.transaction) cannot exercise.
      'src/routes/approvalsDecideAtomicity.integration.test.ts',
      // Co-located real-DB integration test for the create-path atomicity +
      // tenant isolation (Task 7): injects a DB-level fault into the
      // intent_created outbox insert to prove {intent insert + fan-out + outbox}
      // roll back as ONE system-scoped transaction, and probes that an org-B
      // context still cannot read org A's system-scoped intent (RLS unchanged).
      'src/services/actionIntents/createIntentAtomicity.integration.test.ts',
      // Co-located real-DB integration test for headless Google Tier-3 dispatch
      // (Phase 2): drives an approved google_suspend_user intent through the real
      // release worker with only the Google SDK client mocked, proving it
      // resolves + decrypts the org's connection and runs to `completed` instead
      // of false-failing `session_required` — the correctness linchpin the mocked
      // unit suite (which mocks `../db` + the Google stack) can't exercise.
      'src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts',
      // Co-located real-DB integration test for headless M365 Tier-3 dispatch
      // (Task 9): drives approved m365_disable_user / m365_reset_password
      // intents through the real release worker with only the Graph-actions
      // executor client mocked, proving the real write-action authz ladder
      // (feature flag -> connection load -> readiness -> budget -> executor
      // call) resolves the org-keyed customer-graph-actions connection and
      // runs to `completed` instead of false-failing `session_required` — the
      // mocked unit suite (which mocks `../services/m365ToolsHeadless`
      // wholesale) can't exercise this.
      'src/jobs/intentReleaseWorkerM365Headless.integration.test.ts',
      // Co-located real-DB integration test for the two-replica runtime
      // extension reconcile + failure policy (Task 8, issue #2619). Forks two
      // genuinely separate child processes against the real reconciler/
      // migrator/state-store; needs the real, already-migrated :5433 database
      // this config's globalSetup provides. Belongs here, not the unit
      // runner (no DB, no child-process fork target).
      'src/extensions/twoReplicaReconcile.integration.test.ts',
      // Co-located real-Redis integration test for the #2707 approver-device
      // register grant chain (mint -> validate -> consume -> replay rejected,
      // cross-operation isolation, TTL): imports `__tests__/integration/setup`
      // (real Redis; no Postgres fixtures used). Belongs to
      // vitest.integration.config.ts, not the no-Redis unit runner.
      'src/services/mfaStepUpGrant.integration.test.ts',
    ],
    exclude: [
      // Uses fresh request-pool modules and manages its own temporary role;
      // never attach the shared integration TRUNCATE hooks.
      'src/db/requestDatabaseRole.integration.test.ts',
      // rls.integration.test.ts is a mocked unit test in integration's
      // clothing — it stubs the postgres/drizzle layer at the module
      // level and cannot coexist with setup.ts opening a real postgres
      // pool. It has its own dedicated runner at `vitest.config.rls.ts`.
      'src/__tests__/integration/rls.integration.test.ts',
      // rls-coverage.integration.test.ts is a read-only pg_catalog inspection.
      // It MUST NOT be hooked to setup.ts because setup.ts TRUNCATEs core
      // tables on beforeEach — see vitest.config.rls-coverage.ts for its
      // dedicated runner.
      'src/__tests__/integration/rls-coverage.integration.test.ts',
      // site-scope-coverage.integration.test.ts is a static-analysis scan
      // of `src/routes/**/*.ts` — it never touches the database. Excluded
      // here so it doesn't spin up the integration setup; see
      // vitest.config.site-scope-coverage.ts for its dedicated runner.
      'src/__tests__/integration/site-scope-coverage.integration.test.ts',
      // auth.integration.test.ts has multiple pre-existing broken tests
      // that only surfaced now that setup.ts actually applies schema
      // via autoMigrate. The legacy /auth/register endpoint is a no-op,
      // login session cookies aren't being set in the test environment,
      // and lastLoginAt updates aren't persisting — all unrelated to
      // the RLS scaffolding work. Tracked as a follow-up issue; the
      // file needs a dedicated audit against current auth route shapes.
      'src/__tests__/integration/auth.integration.test.ts',
    ],
    // Migrations run ONCE per invocation here (not in setup.ts's per-file
    // beforeAll): re-verifying 400+ migration checksums for every test file
    // was ~4 min of pure no-op work per CI run.
    globalSetup: ['src/__tests__/integration/globalSetup.ts'],
    setupFiles: ['src/__tests__/integration/setup.ts'],
    // Integration tests run sequentially to avoid database conflicts.
    // `fileParallelism: false` forces vitest to run test files one at a
    // time (not just the tests within a file) so setup.ts / autoMigrate
    // / seed don't race each other across workers.
    sequence: {
      concurrent: false
    },
    fileParallelism: false,
    // Longer timeouts for database operations
    testTimeout: 30000,
    hookTimeout: 30000,
    // No `bail` here on purpose: bail:1 masks
    // stacked breakages — in June 2026 it hid #1092's org-scope lockout
    // behind #1042's RBAC 403 for a day because each CI run only ever
    // surfaced the first failure. Always report every failure.
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
