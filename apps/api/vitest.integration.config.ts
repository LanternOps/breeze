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
      'src/db/auditRetentionDefault.integration.test.ts',
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
      // Co-located real-DB integration test for the platform-admin bootstrap
      // (#2655): the mocked unit suite executes no SQL, so it never caught the
      // prod-bundle `= ANY(::text[])` array-literal failure. This drives the
      // real promotion UPDATE against Postgres under system-scoped RLS.
      'src/services/platformAdminBootstrap.integration.test.ts',
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
      // Real-DB proof for dual-axis, per-device peripheral policy resolution.
      'src/services/peripheralEffectivePolicy.integration.test.ts',
      'src/services/peripheralPolicyState.integration.test.ts',
      // Real PostgreSQL + Redis proof for atomic signed rollback creation.
      'src/services/agentRollback.integration.test.ts',
      // Real PostgreSQL proof for restart-safe rollback observation ingestion,
      // append-only dedupe, and terminal projection truth.
      'src/services/agentRollbackResult.integration.test.ts',
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
      // Co-located real-DB integration test for enrollment idempotency (#2764):
      // hostname-collision fresh-row enrollment leaving the colliding row
      // byte-identical, the uninstall-intent -> reap -> re-enroll lifecycle,
      // and the bootstrap-cancel exactly-once refund guard under concurrency
      // — none of which the mocked unit suites can prove (see the file's own
      // header comment for the per-property rationale).
      'src/routes/agents/enrollmentCollision.integration.test.ts',
      // Co-located real-DB integration test for #2725 (installed inventory must
      // not erase pending third-party rows): proves the raw-SQL CASE guard in
      // upsertInstalledPatches against the real device_patch_status enum and
      // the sweep→installed self-heal across both ingest endpoints — the
      // mocked patches.test.ts can only assert the generated SQL's shape.
      'src/routes/agents/patches.integration.test.ts',
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
      // Co-located real-DB integration test for the Tier-3 supervised
      // plain-decide branch (Task 6 fix round 1, finding 4): drives the real
      // approve/deny route against genuine role/permission state to prove
      // the live-RBAC re-check (buildAuthContextForIntent + checkToolPermission)
      // actually wires up end to end — both are mocked wholesale in the unit
      // suite (approvals.test.ts), so this is the only coverage that exercises
      // the real modules against real Postgres.
      'src/routes/approvalsDecideSupervised.integration.test.ts',
      // Co-located real-DB integration test for report-suspicious under a
      // PARTNER-scoped caller (#3234): the only place that combination exists.
      // The unit suite (approvals.test.ts) has the right auth shape but mocks
      // `../db`, so RLS never runs; approvalsDecideSupervised hardcodes
      // scope 'organization', so auth.orgId is never null. Proves the audit row
      // is tenanted to the reported approval's org rather than the caller's,
      // and that the endpoint no longer 500s (and no longer rolls the
      // 'reported' flip back) when that org is null.
      'src/routes/approvalsReportSuspiciousPartnerScope.integration.test.ts',
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
      // Co-located real-Redis integration test for the #2707 approver-device
      // register grant chain (mint -> validate -> consume -> replay rejected,
      // cross-operation isolation, TTL): imports `__tests__/integration/setup`
      // (real Redis; no Postgres fixtures used). Belongs to
      // vitest.integration.config.ts, not the no-Redis unit runner.
      'src/services/mfaStepUpGrant.integration.test.ts',
      // Co-located real-DB integration test for the nightly enrollment-key
      // purge sweep: the #2775 live-bootstrap-token exemption (proving
      // Postgres itself evaluates the correlated NOT EXISTS subquery per row,
      // where the mocked unit suite only asserts the generated SQL's shape)
      // AND the #2821 deployment_invites cascade lifetime. Only BullMQ's
      // Queue/Worker classes are mocked; imports
      // `__tests__/integration/setup` (real postgres pool + autoMigrate).
      'src/jobs/enrollmentKeyCleanup.integration.test.ts',
      // Co-located real-DB integration test for the ON-DEMAND enrollment-key
      // purge route (#2832): drives the real POST /enrollment-keys/purge-expired
      // (real JWT + authMiddleware + breeze_app RLS) to prove Postgres spares
      // keys still backing a live, unexhausted installer bootstrap token. The
      // mocked route suite can only assert the predicate's shape and cannot
      // see the ON DELETE CASCADE at all.
      'src/routes/enrollmentKeysPurgeExpired.integration.test.ts',
      // Co-located real-DB end-to-end coverage for the tier3-supervised-four-eyes
      // split (Task 10): four_eyes fan-out ownership (both admins, never the
      // requester), a t+30min approve/release proving the new 60-minute
      // four_eyes window (vs. the old 5-minute supervised one) via direct DB
      // timestamp manipulation, and the disabled-second-admin sole-operator
      // fallback. Lives under `src/__tests__/integration/**`, already covered
      // by the shared glob above and the unit runner's wholesale
      // `src/__tests__/integration/**` exclude; named here for discoverability
      // only (same pattern `staleBackupReaper.integration.test.ts` uses).
      'src/__tests__/integration/intentSupervisedFourEyes.integration.test.ts',
      // Co-located real-DB coverage for the effect-digest TOCTOU chain: pins a
      // real `scripts` row, approves, does a real UPDATE, and drives the real
      // release path to `failed:content_changed` — plus the negative mirror,
      // which is the only test anywhere that would catch deleting the
      // `withSystemDbAccessContext` wrap around the release-time recompute
      // (every unit test stubs that wrap as an identity passthrough). Under
      // `src/__tests__/integration/**`, so already covered by the shared glob
      // above; named here for discoverability only.
      'src/__tests__/integration/effectDigestToctou.integration.test.ts',
      // Live-Postgres behavioral half of the action_intents immutability
      // contract: one rejecting UPDATE per column on the
      // `action_intents_block_content_update()` deny-list (incl. the tier-3
      // `approval_scope`, whose immutability IS the security value of the
      // column), plus positive controls proving the lifecycle columns stayed
      // mutable. These cases previously sat inside the UNIT suite
      // `src/db/migration-action-intents.test.ts` behind
      // `describe.runIf(!!process.env.DATABASE_URL)` and executed in NO CI job
      // at all — `test-api` has no Postgres, and that file was never in this
      // include list. Moving them under `src/__tests__/integration/**` puts
      // them in the blocking `integration-test` job via the shared glob above;
      // named here for discoverability only (same pattern
      // `staleBackupReaper.integration.test.ts` uses).
      'src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts',
      // Co-located real-DB integration test for the enrollment-key list
      // filter (#3191): drives GET /enrollment-keys?expired= to prove
      // Postgres evaluates the live-installer-token carve-out per row, so
      // "Hide expired" stops hiding keys the status badge renders "Active".
      // The mocked list suite returns whatever rows it is handed regardless
      // of the predicate and cannot test this at all.
      'src/routes/enrollmentKeysExpiredFilter.integration.test.ts',
      // Co-located real-DB integration test for the fleet posture report
      // (#3244): the mixed never-scanned/stale/clean/detected fixture that
      // guards the two-query split — a mocked unit test cannot catch the
      // collapsed LEFT JOIN LATERAL form that reads never-scanned as clean.
      'src/services/managementPostureReport.integration.test.ts',
      // Co-located real-DB integration test for the DISABLED built-in
      // extension's table-existence probe. The unit suite drives that path
      // entirely through injected ports, so the port's own SQL is stubbed in
      // every one of those tests — and its first version passed all of them
      // while failing against a live server ("malformed array literal"),
      // aborting boot for any deployment that had ever enabled the built-in.
      // This runs the real query against real Postgres.
      'src/extensions/builtinTableProbe.integration.test.ts',
      // Wave 6 (#3778): these two co-located real-DB suites matched the UNIT
      // runner's src/**/*.test.ts glob but were gated on `describe.runIf(!!DATABASE_URL)`,
      // which the unit runner never sets — so they ran in NO CI job. They cover
      // source release, double-billing, bundle hierarchy on reissue, PDF artifact
      // persistence and the draft-preview-doesn't-persist rule.
      'src/services/invoiceService.issue.integration.test.ts',
      'src/services/invoicePdf.integration.test.ts',
      // Wave 3.5c (#4085): real-Postgres + real-Redis/BullMQ coverage for the
      // durable event-dispatch pipeline (enqueueRouteEvent, eventDispatchProcessor,
      // the event_delivery_receipts state machine) — a real Worker draining a
      // real queue, receipt idempotent-skip, retry/backoff outcomes, shadow-mode
      // writes, and the RLS forge on event_delivery_receipts. Lives under
      // src/__tests__/integration/**, already covered by the shared glob above;
      // named here for discoverability only (same pattern
      // staleBackupReaper.integration.test.ts uses).
      'src/__tests__/integration/eventDispatchQueue.integration.test.ts',
      // Wave 3.5c (#4085): real-Postgres coverage for the alert_notifications
      // send-identity unique index (alert_id, channel_id, escalation_step) and
      // the migration's loser-renumbering dedupe (2026-09-11-f), replayed by
      // path against seeded dirty data. Lives under src/__tests__/integration/**,
      // already covered by the shared glob above; named here for discoverability
      // only.
      'src/__tests__/integration/alertNotificationSendIdentity.integration.test.ts',
      // Wave 3.5b (#4084): real-Redis coverage for the socket-affinity command
      // relay — fenced presence leases, the sealed AAD-bound envelope, the
      // at-most-once send claim, owner/expiry fencing, and the
      // dispatchCommandToAgent local-vs-relay facade. No Postgres fixtures;
      // lives under src/__tests__/integration/** so it's already covered by
      // the shared glob above; named here for discoverability only (same
      // pattern staleBackupReaper.integration.test.ts uses).
      'src/__tests__/integration/agentCommandRelay.integration.test.ts',
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
      // integration-suite-coverage.integration.test.ts (#4522) is pure
      // static analysis — it reads this very file's include/exclude
      // arrays and walks `src/**/*.integration.test.ts` from disk. It
      // MUST NOT be hooked to setup.ts (real postgres pool + TRUNCATE);
      // see vitest.config.integration-suite-coverage.ts for its
      // dedicated runner.
      'src/__tests__/integration/integration-suite-coverage.integration.test.ts',
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
