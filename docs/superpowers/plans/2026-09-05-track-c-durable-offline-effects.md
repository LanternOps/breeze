---
tracking_issue: 4060
---
# Track C durable offline effects execution

Design authority: ../specs/2026-09-05-track-c-durable-offline-effects.md.
This extends the original no-migration Track C port. Existing PR #4007 remains draft
until the durable implementation and independent review pass.

1. [x] Independent design review resolves delivery, reconnect and ownership semantics.
2. [x] RED: add real-Postgres fixtures proving CAS commits a pending row; failure to
   persist it rolls back status; crash recovery finds it after device is offline.
3. [x] Create 000800 migration and typed schema; forced RLS, ownership guard, cascade,
   export and org-merge registrations; mutation controls for RLS/atomicity.
4. [x] Implement stable source admission and bounded expired-lease recovery using the
   existing offline worker. Prove stale-owner and retry scheduling guards on real DB.
5. [x] Add stable event ID/timestamp option with default-compatible tests and real Redis
   redelivery proof. State at-least-once physical delivery explicitly.
6. [x] RED: alert insert survives crash with its pending event; duplicate/retry after
   resolution creates no second alert; reconnect and ownership move suppress late
   alerts. Implement DB-only planning, guarded deterministic alert admission and
   durable postprocess/publication. No Redis writes inside rollback-capable admission.
7. [x] Test Redis cooldown expiry and duplicate flapping recording; ensure failed work
   remains pending beyond queue attempts and is not removed by terminal retention.
8. [x] Run focused offline/event/tenancy unit suites with maxWorkers2; real PostgreSQL/
   Redis fault-injection suite on this worktree's private test-stack (maxWorkers1).
9. [x] Run migration naming/immutability/drift, tenant-export/RLS/org-merge coverage,
   API typecheck/lint, integration-runner registration and diff checks. Coordinate
   broader/heavy suites with parent; collect every exit status.
10. [ ] Independent exact-diff review, fix findings, commit with hooks and hand off
    exact head plus evidence to parent for existing draft PR publication.
11. [x] Exact-candidate scale/headroom/readiness rehearsal is separately recorded;
    never infer closure or deployment from implementation or CI alone.

Target files: new schema/offlineTransitionEffects.ts, migration000800, new
services/offlineTransitionEffects.ts and services/offlineAlertEffects.ts (split by
cohesion), jobs/offlineDetector.ts, services/eventBus.ts, tenant registries, focused
colocated unit tests and real integration suites under the integration runner glob.

Core fault suite command:
`pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/offlineTransitionEffects.integration.test.ts --maxWorkers=1`

Record exact executed commands/results and mutation controls in parent handoff;
no push, merge, production mutation or issue comments from the worker.

## Local verification

- RED controls: stable event identity regression failed before publisher support;
  real CAS/pending-row test failed before the migration existed.
- Real PostgreSQL/Redis fault matrix: 26 passing tests across durable effects and
  the earlier offline queue/RLS recovery suite. Covers committed-child enqueue
  failure outside DB context as well as source enqueue failure, rollback, lease
  expiry, ambiguous publication, policy and legacy admission, reconnect, cooldown,
  adaptive resolution, flapping, malformed rule isolation, ownership, erasure and
  source-only scalar exports with payload/lease-capability omission. The existing
  export/erasure round-trip suite also passes all 3 tests.
- Org-merge registry: 14 passing checks; tenant-cascade registry: 5 passing checks.
  The new immutable-source trigger has an explicit blocking classification.
- Forced-RLS catalog: 100 passing checks. Integration-runner discovery: 5 passing
  checks. Migration ledger: all 675 files match; shipped migration immutability
  passes against release baseline v0.109.0. The new migration also reapplies twice
  without errors on the isolated migrated database.
- API lint and typecheck passed. Full API unit suite: 1,870 files passed, 3
  skipped; 34,695 tests passed, 21 skipped (540 seconds, maxWorkers2).
- Mutation controls: removing the final lease fence and ignoring durable cooldown
  each make their real-DB regression fail. Original source restored byte-for-byte;
  targeted green rerun recorded in the worker handoff.
- No exact-candidate scale or release-readiness claim is made.
