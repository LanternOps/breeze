# Task 10 report — C2C and scheduled-verification authority

## Status

- Status: complete
- Commit: recorded below after the bounded commit is created
- Scope: all five C2C producers, the direct C2C processor boundary, current C2C owner-lineage authorization, and scheduled backup-verification authority/lineage.
- Excluded: Task 11 real-PostgreSQL cross-tenant mutation proof and production deployment.

## Outcome

- Request sync, AI sync, request restore, AI restore, and scheduled sync now persist an explicit operation kind plus the complete Task 7 authorization subject. Only scheduled sync constructs `c2c-sync-scheduler`; request and AI work preserve their actual live principals.
- Active-sync deduplication now matches only pending/running `sync` rows whose authorization state remains pending/authorized. Existing work is returned observationally and is never rebound.
- Queue envelopes remain subject-free. The exported `processC2cQueuedJob` seam accepts the durable-ID/resource-reference envelope and optional focused dependencies for Task 11.
- The C2C processor reloads the durable job and live subject, requires queue/stored kind equality, then re-resolves the config, source connection, optional storage config, every unique restore item, and optional target connection by exact current organization/config ownership before a claim/finalization.
- Known denial is persisted without a running claim. Unknown legacy work remains quarantined. Dependency failures throw and leave work pending/retriable. Already denied/not-required work cannot be revived by replay.
- Authorized sync records authorization with its exact pending-to-running subject CAS and then enters the existing not-implemented failure stub. Authorized restore transitions directly from pending to failed with `c2c_restore_not_implemented`, records the unique item count, and never enters running.
- Scheduled verification now uses a dedicated `runScheduledBackupVerification` wrapper whose system reason is fixed internally to `backup-verification-scheduler`; it accepts no principal or reason argument. A manual caller-controlled `source` never selects system authority.
- Both scheduled recovery loops pass the backup job ID rather than the provider-facing snapshot string. For production UUID identities, the wrapper strictly reloads the current job by `(id, org, device)`, resolves the internal snapshot by `backup_snapshots.job_id`, authorizes target-device and source-snapshot lineage, and verifies the authorized snapshot still resolves to the requested device before provider config or command dispatch.
- Verification persistence remains after successful command creation only; denial creates neither a verification nor a device command.

## RED evidence

Strict RED was observed before production changes:

```text
src/services/c2cQueuedAuthorization.test.ts
FAIL: Cannot find module './c2cQueuedAuthorization'

src/services/c2cJobCreation.test.ts
FAIL: captureRecoveryAuthorizationSubject was never called

src/routes/c2c/jobs.test.ts
FAIL: request AuthContext was absent from sync creation

src/routes/c2c/items.test.ts
FAIL: restore subject was not captured

src/services/aiToolsC2C.test.ts
2 failed: AI sync omitted AuthContext; AI restore omitted durable subject/kind

src/jobs/c2cBackupWorker.test.ts
FAIL: processC2cQueuedJob was not exported

src/routes/backup/verificationService.test.ts
2 failed: runScheduledBackupVerification did not exist

src/routes/backup/verificationScheduled.test.ts
2 failed: scheduled paths still called the manual runner

src/services/c2cQueuedAuthorization.test.ts replay correction
2 failed: denied/not-required work was revived on replay
```

The first scheduler-test attempt exposed an incomplete schema mock before reaching production behavior. The fixture was corrected, then the intended two wrapper-call failures were observed.

## GREEN evidence

Final corrected targeted suite:

```text
pnpm --filter @breeze/api exec vitest run \
  src/jobs/c2cEnqueue.test.ts \
  src/jobs/c2cBackupWorker.test.ts \
  src/services/c2cJobCreation.test.ts \
  src/services/c2cQueuedAuthorization.test.ts \
  src/routes/c2c/items.test.ts \
  src/routes/c2c/jobs.test.ts \
  src/services/aiToolsC2C.test.ts \
  src/routes/backup/verificationScheduled.test.ts \
  src/routes/backup/verificationService.test.ts \
  src/services/recoveryAuthorizationSubject.test.ts \
  src/services/resilienceSiteAuthorization.test.ts

Test Files  11 passed (11)
Tests       126 passed (126)
```

Static gates:

```text
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
# exit 0

pnpm --filter @breeze/api exec eslint <Task 10 TypeScript files>
# exit 0

git diff --check
# exit 0
```

Vitest emitted only the repository's existing Vite native-loader warning.

## Task 11 boundary

Task 11 remains responsible for real-PostgreSQL two-partner/two-org/two-site mutation evidence and literal zero provider/command/follow-on queue effects. Task 10 supplies the direct C2C dependency seam and strict scheduled production-UUID resolution needed by that integration proof.

No reviewer agent was dispatched, per the repository's single branch-level review rule.
