---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
parent_plan: ./2026-08-24-s0-track-e-pam-actuation.md
design_spec: ../specs/2026-08-27-s0-track-e-pam-dispatch-wire-contract-design.md
---

# Track E PAM Dispatch Wire-Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the API dispatch worker store the exact frozen PAM v2 apply and cleanup payloads that the unchanged strict Go agent decoder accepts.

**Architecture:** A pure TypeScript builder maps one locked, ownership-verified PAM actuation snapshot into a discriminated exact apply or cleanup command. One cross-language golden fixture pins both shapes, while the existing worker transaction continues to own capability gating, command insertion, primary-agent targeting, and exact-generation command binding.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Vitest, Go `encoding/json`, Go race tests, BullMQ worker lifecycle.

## Global Constraints

- Treat the parent plan's `PamApplyV2` and `PamCleanupV2` shapes as frozen.
- Keep the Go agent decoder strict; do not add aliases, optional compatibility fields, or unknown-field tolerance.
- `requestId` is the exact owning `elevation_requests.id`; never add `requestRevision` to the agent wire or ledger.
- Supply `deviceId` and `orgId` from the same locked and ownership-verified actuation snapshot used to bind `current_command_id`.
- Apply `maxRemainingLifetimeMs` is exactly positive `expiresAt - serverTime` in integer milliseconds; it never extends the authoritative expiry.
- Cleanup contains only its six frozen keys and no apply-only null fields.
- Preserve the existing system-context transaction, generation lock, capability gate, duplicate/stale behavior, command ownership, and result transaction.
- No schema, migration, alternate dispatch/result path, Task 6 `received` transport, entitlement disposition, or Task 8 work.
- No production deployment, `/opt/breeze` change, hosted-admission change, customer-device mutation, or evidence claim beyond the named gates.
- Strict RED/GREEN: observe the current server mismatch before changing production code, then make the minimum server repair.
- Do not dispatch another Task 6 or Task 7 independent boundary reviewer; their single reviews are already consumed.

---

### Task 1: Pin the exact cross-language v2 command contract

**Files:**
- Create: `packages/shared/src/fixtures/pam-lifetime-v2-command-contract.json`
- Create: `apps/api/src/jobs/pamActuationCommandPayload.test.ts`
- Create: `apps/api/src/jobs/pamActuationCommandPayload.ts`
- Modify: `agent/internal/heartbeat/handlers_actuate_test.go`

**Interfaces:**
- Produces `PamApplyV2Payload` and `PamCleanupV2Payload` with the exact frozen keys.
- Produces `PamDispatchSnapshot`, containing only locked server fields needed by the wire.
- Produces `buildPamActuationCommand(snapshot, serverTime): PamCommandBuildResult`.
- Produces one JSON fixture consumed by both TypeScript and Go tests.

- [x] **Step 1: Add the canonical fixture**

Create `packages/shared/src/fixtures/pam-lifetime-v2-command-contract.json`:

```json
{
  "apply": {
    "protocolVersion": 2,
    "actuationId": "30000000-0000-4000-8000-000000000001",
    "generation": 4,
    "requestId": "30000000-0000-4000-8000-000000000004",
    "deviceId": "30000000-0000-4000-8000-000000000003",
    "orgId": "30000000-0000-4000-8000-000000000002",
    "targetPath": "C:\\Program Files\\Fixture\\fixture.exe",
    "targetHash": null,
    "subjectUsername": "CORP\\operator",
    "expiresAt": "2026-08-27T12:01:00.000Z",
    "serverTime": "2026-08-27T12:00:00.000Z",
    "maxRemainingLifetimeMs": 60000
  },
  "cleanup": {
    "protocolVersion": 2,
    "actuationId": "30000000-0000-4000-8000-000000000001",
    "generation": 5,
    "requestId": "30000000-0000-4000-8000-000000000004",
    "deviceId": "30000000-0000-4000-8000-000000000003",
    "orgId": "30000000-0000-4000-8000-000000000002"
  }
}
```

- [x] **Step 2: Write the TypeScript builder RED tests**

Create `pamActuationCommandPayload.test.ts`. Import the fixture and the not-yet-created builder. Pin exact equality, lifetime arithmetic, cleanup omission, and invalid lifetime behavior:

```ts
import canonical from '../../../../packages/shared/src/fixtures/pam-lifetime-v2-command-contract.json';
import { buildPamActuationCommand, type PamDispatchSnapshot } from './pamActuationCommandPayload';

const base: PamDispatchSnapshot = {
  actuationId: canonical.apply.actuationId,
  generation: canonical.apply.generation,
  requestId: canonical.apply.requestId,
  deviceId: canonical.apply.deviceId,
  orgId: canonical.apply.orgId,
  desiredState: 'active',
  targetPath: canonical.apply.targetPath,
  targetHash: null,
  subjectUsername: canonical.apply.subjectUsername,
  expiresAt: new Date(canonical.apply.expiresAt),
};

it('builds the exact frozen apply v2 payload', () => {
  expect(buildPamActuationCommand(base, new Date(canonical.apply.serverTime)))
    .toEqual({ kind: 'command', commandType: 'pam_apply_v2', payload: canonical.apply });
});

it('builds cleanup with no apply-only keys', () => {
  const result = buildPamActuationCommand({
    ...base,
    generation: canonical.cleanup.generation,
    desiredState: 'cleanup',
  }, new Date(canonical.apply.serverTime));
  expect(result).toEqual({ kind: 'command', commandType: 'pam_cleanup_v2', payload: canonical.cleanup });
  expect(Object.keys(result.kind === 'command' ? result.payload : {}).sort())
    .toEqual(['actuationId', 'deviceId', 'generation', 'orgId', 'protocolVersion', 'requestId']);
});

it.each([
  ['missing', null],
  ['elapsed', new Date(canonical.apply.serverTime)],
  ['invalid', new Date(Number.NaN)],
] as const)('blocks a %s apply expiry', (_name, expiresAt) => {
  expect(buildPamActuationCommand({ ...base, expiresAt }, new Date(canonical.apply.serverTime)))
    .toEqual({ kind: 'blocked', failureCode: 'expired_before_dispatch' });
});
```

Also assert the apply payload contains neither `elevationRequestId`,
`requestRevision`, `targetExecutablePath`, nor `targetExecutableHash`, and that
`Date.parse(serverTime) + maxRemainingLifetimeMs === Date.parse(expiresAt)`.

- [x] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/pamActuationCommandPayload.test.ts
```

Expected: FAIL because `pamActuationCommandPayload.ts` and its exports do not
exist.

- [x] **Step 4: Implement the pure exact-shape builder**

Create `pamActuationCommandPayload.ts` with exact interfaces and no index
signature:

```ts
export type PamApplyV2Payload = {
  protocolVersion: 2;
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
  targetPath: string;
  targetHash: string | null;
  subjectUsername: string;
  expiresAt: string;
  serverTime: string;
  maxRemainingLifetimeMs: number;
};

export type PamCleanupV2Payload = {
  protocolVersion: 2;
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
};

export type PamDispatchSnapshot = {
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
  desiredState: 'active' | 'cleanup';
  targetPath: string;
  targetHash: string | null;
  subjectUsername: string;
  expiresAt: Date | null;
};

export type PamCommandBuildResult =
  | { kind: 'command'; commandType: 'pam_apply_v2'; payload: PamApplyV2Payload }
  | { kind: 'command'; commandType: 'pam_cleanup_v2'; payload: PamCleanupV2Payload }
  | { kind: 'blocked'; failureCode: 'expired_before_dispatch' };
```

For cleanup, return the six-key object immediately. For apply, require valid
`serverTime` and `expiresAt`, calculate `remainingMs`, require
`Number.isSafeInteger(remainingMs) && remainingMs > 0`, and return the exact
apply literal with ISO timestamps. Do not spread the snapshot into the payload.

- [x] **Step 5: Run the builder GREEN gate**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/pamActuationCommandPayload.test.ts
```

Expected: PASS with exact fixture equality and invalid lifetime cases.

- [x] **Step 6: Pin the unchanged strict Go decoder to the same fixture**

In `handlers_actuate_test.go`, add a table test that reads:

```go
fixturePath := filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "pam-lifetime-v2-command-contract.json")
```

Unmarshal the `apply` and `cleanup` objects first into `map[string]any`, call
`decodePamLifetimePayload` with `pamlifetime.ApplyCommand` and
`pamlifetime.CleanupCommand`, and assert every decoded field including the
60,000-millisecond bound. Assert adding one unknown key returns an error. Do not
modify `decodePamLifetimePayload` or either production Go command structure.

```bash
cd agent && go test -count=1 ./internal/heartbeat -run 'TestPamLifetimeV2CanonicalDispatchFixture|TestPamLifetimeV2Handlers'
```

Expected: PASS; the existing strict decoder already represents the frozen
contract.

- [x] **Step 7: Commit the contract unit**

```bash
git add packages/shared/src/fixtures/pam-lifetime-v2-command-contract.json apps/api/src/jobs/pamActuationCommandPayload.ts apps/api/src/jobs/pamActuationCommandPayload.test.ts agent/internal/heartbeat/handlers_actuate_test.go
git commit -m "fix(pam): define exact v2 dispatch payload"
```

### Task 2: Integrate exact payloads into the atomic dispatch worker

**Files:**
- Modify: `apps/api/src/jobs/pamActuationWorker.ts`
- Modify: `apps/api/src/jobs/pamActuationWorker.test.ts`
- Create: `apps/api/src/__tests__/integration/pamActuationDispatchWire.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/pamActuationLifecycle.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/pamActuationResults.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/pamReconciliationBinding.integration.test.ts`

**Interfaces:**
- Consumes `buildPamActuationCommand(snapshot, serverTime)` from Task 1.
- Preserves `processPamActuationEvent(input): Promise<PamActuationDispatchResult>`.
- Stores one exact `pam_apply_v2` or `pam_cleanup_v2` primary-agent command and binds its ID in the existing transaction.

- [x] **Step 1: Write the real-PostgreSQL worker RED proof**

Create `pamActuationDispatchWire.integration.test.ts` using the existing
integration `setup`, `createPartner`, and `createOrganization` helpers. Seed:

```text
organization + site
Windows device with pam_lifetime_protocol_version = 2
approved elevation request with future expires_at
generation-1 active pam_actuation with the same org/device/request
```

Call `processPamActuationEvent({ actuationId, generation: 1 })`, query the
inserted `device_commands` row and bound actuation, and assert:

```ts
expect(command.type).toBe('pam_apply_v2');
expect(command.targetRole).toBe('agent');
expect(command.deviceId).toBe(fixture.deviceId);
expect(command.payload).toEqual({
  protocolVersion: 2,
  actuationId: fixture.actuationId,
  generation: 1,
  requestId: fixture.requestId,
  deviceId: fixture.deviceId,
  orgId: fixture.orgId,
  targetPath: fixture.targetPath,
  targetHash: fixture.targetHash,
  subjectUsername: fixture.subjectUsername,
  expiresAt: fixture.expiresAt.toISOString(),
  serverTime: expect.any(String),
  maxRemainingLifetimeMs: expect.any(Number),
});
expect(Date.parse(command.payload.serverTime)
  + command.payload.maxRemainingLifetimeMs).toBe(Date.parse(command.payload.expiresAt));
expect(bound.currentCommandId).toBe(command.id);
```

Assert the payload has no old aliases. Then rotate the same row to generation 2
cleanup with `current_command_id = NULL`, dispatch it, and assert the cleanup
payload equals exactly:

```ts
{
  protocolVersion: 2,
  actuationId: fixture.actuationId,
  generation: 2,
  requestId: fixture.requestId,
  deviceId: fixture.deviceId,
  orgId: fixture.orgId,
}
```

Add cases proving duplicate delivery inserts no second command and an elapsed
active expiry inserts no command and records `expired_before_dispatch`.

- [x] **Step 2: Run the integration test and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationDispatchWire.integration.test.ts
```

Expected: FAIL because the stored apply payload uses old aliases, lacks required
identity/lifetime fields, and cleanup includes apply-only data.

- [x] **Step 3: Wire the builder into `processPamActuationEvent`**

In `PamDispatchRow`, remove `request_revision`; it is not a wire field. Also
remove `a.request_revision` from the locked SELECT. Keep the request join and
exact org equality check. After capability validation, capture one
`const serverTime = new Date()` and call:

```ts
const built = buildPamActuationCommand({
  actuationId: actuation.id,
  generation: actuation.generation,
  requestId: actuation.elevation_request_id,
  deviceId: actuation.device_id,
  orgId: actuation.org_id,
  desiredState: actuation.desired_state,
  targetPath: actuation.target_executable_path,
  targetHash: actuation.target_executable_hash,
  subjectUsername: actuation.subject_username,
  expiresAt: actuation.expires_at,
}, serverTime);
```

If `built.kind === 'blocked'`, retain the existing exact-generation failed
update with its failure code and return `blocked`. Otherwise insert
`built.commandType` and `built.payload`. Include `target_role = 'agent'`
explicitly in the insert while preserving `created_by = NULL`, pending status,
same transaction, and exact-generation `current_command_id IS NULL` update.

Remove the worker's inline `Date.now()` expiry check. The builder is the single
expiry authority, and its blocked result reuses that check's existing
exact-generation `expired_before_dispatch` failed-update SQL. Do not retain two
expiry checks or two clocks.

Delete the old shared payload literal and do not modify queue publication,
heartbeat delivery, WebSocket delivery, or result services.

- [x] **Step 4: Strengthen focused worker regressions**

In `pamActuationWorker.test.ts`, use `vi.useFakeTimers()` and
`vi.setSystemTime('2026-08-27T12:00:00.000Z')`. Assert the active insert's
serialized SQL parameters contain the exact apply fixture keys and values and
exclude all four old aliases. Assert the cleanup insert contains no
`targetPath`, `targetHash`, `subjectUsername`, `expiresAt`, `serverTime`, or
`maxRemainingLifetimeMs`.

Add explicit cases for:

```text
request/org/device identity mismatch -> identity_mismatch, no INSERT command
capability 0/missing                 -> pam_protocol_v2_unsupported, no INSERT command
stale generation                     -> stale, one SELECT only
already-bound generation             -> duplicate, one SELECT only
expired active lifetime              -> expired_before_dispatch, no INSERT command
```

- [x] **Step 5: Run focused GREEN gates**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/pamActuationCommandPayload.test.ts src/jobs/pamActuationWorker.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationDispatchWire.integration.test.ts
```

Expected: all exact-shape, failure-path, duplicate, and atomic-binding tests
pass.

- [x] **Step 6: Run adjacent real-PostgreSQL ownership regressions**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationDispatchWire.integration.test.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts src/__tests__/integration/pamActuationResults.integration.test.ts src/__tests__/integration/pamReconciliationBinding.integration.test.ts
```

Expected: every named file executes and passes; exact command ownership,
append-only evidence, reconciliation binding, and result classification remain
unchanged.

- [x] **Step 7: Commit the worker repair**

```bash
git add apps/api/src/jobs/pamActuationWorker.ts apps/api/src/jobs/pamActuationWorker.test.ts apps/api/src/__tests__/integration/pamActuationDispatchWire.integration.test.ts
git commit -m "fix(api): emit strict PAM v2 commands"
```

### Task 3: Run closure gates and synchronize exact evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md`
- Modify: `docs/superpowers/plans/2026-08-27-s0-track-e-pam-dispatch-wire-contract.md`
- External record: issue #4060
- External record: PR #4105

**Interfaces:**
- Produces exact-head local, cross-language, and core-CI evidence.
- Closes only the dispatch wire-contract repair; Task 6 transport, entitlement disposition, and Task 8 remain open.

- [x] **Step 1: Run the complete API and cross-language gate**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/pamActuationCommandPayload.test.ts src/jobs/pamActuationWorker.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationDispatchWire.integration.test.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts src/__tests__/integration/pamActuationResults.integration.test.ts src/__tests__/integration/pamReconciliationBinding.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd agent && go test -count=1 -race ./internal/agentapp ./internal/heartbeat ./internal/pamlifetime
GOOS=windows GOARCH=amd64 go test -c ./internal/agentapp -o /tmp/breeze-agentapp.test.exe
```

Expected: all tests and the Windows cross-compile pass. This is still not native
Windows execution evidence.

- [x] **Step 2: Run repository governance gates**

From the repository root:

```bash
pnpm --filter @breeze/api db:check-drift
bash scripts/check-migration-naming.sh
git diff --check
git status --short
```

Expected: no drift, migration naming passes, no whitespace errors, and only
planned files are dirty. If drift needs repository test environment variables,
load `.env.test` without printing values and rerun the same command. Confirm no
migration, Go production file, ledger field, alternate route, or Task 8 file was
added.

- [x] **Step 3: Push and run exact-head core CI**

Push the exact implementation candidate and dispatch `.github/workflows/ci.yml`
on the branch:

```bash
candidate_sha=$(git rev-parse HEAD)
git push origin fix/s0-pam-actuation-lifecycle
test "$(git rev-parse origin/fix/s0-pam-actuation-lifecycle)" = "$candidate_sha"
gh workflow run ci.yml --repo LanternOps/breeze --ref fix/s0-pam-actuation-lifecycle
run_id=$(gh run list --repo LanternOps/breeze --workflow ci.yml \
  --branch fix/s0-pam-actuation-lifecycle --event workflow_dispatch --limit 20 \
  --json databaseId,headSha --jq ".[] | select(.headSha == \"$candidate_sha\") | .databaseId" | head -1)
test -n "$run_id"
gh run view "$run_id" --repo LanternOps/breeze \
  --json headSha,status,conclusion,url,jobs \
  --jq '{headSha,status,conclusion,url,jobs:[.jobs[]|{name,conclusion}]}'
```

Verify `headSha` is exactly `candidate_sha`. After completion, rerun the final
`gh run view` command and record every job conclusion independently from the
three checks attached to stacked PR #4105.

Expected: the integration shards, Go gates, and aggregate succeed; only the
expected Main Red Alert may skip. Any other failure remains a blocker and must
be diagnosed before checking closure boxes.

Closure evidence (2026-08-27): exact implementation candidate
`40a4366902f8fe2c88c1752577a1918152d192fd` passed manual core run
[`33136440945`](https://github.com/LanternOps/breeze/actions/runs/33136440945)
with 41 successful jobs, only the expected skipped Main Red Alert, and no
failures. All three checks attached to stacked PR #4105 passed at the same SHA.
Fresh local evidence was 12 focused API tests, 21 real-PostgreSQL tests, 75 RLS
checks, API typecheck, Go race for agentapp/heartbeat/pamlifetime, Windows amd64
agentapp cross-compile, migration drift/naming, and diff checks.

- [x] **Step 4: Record closure without expanding scope**

Only after every local gate and exact-head core CI pass:

- check this addendum and the parent Task 7B steps;
- update issue #4060 and PR #4105 with the exact implementation SHA, current
  branch/docs SHA if different, attached-check counts, core-run URL and every
  job conclusion;
- state that the unchanged strict decoder accepts the exact stored apply and
  cleanup payloads; and
- keep Task 6 `received` transport, entitlement disposition, Task 8, native
  Windows, deployment, hosted reachability, customer mutation, canary, and
  rollout unchecked and unclaimed.

- [x] **Step 5: Commit documentation evidence**

```bash
git add docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md docs/superpowers/plans/2026-08-27-s0-track-e-pam-dispatch-wire-contract.md
git commit -m "docs(pam): record dispatch wire closure"
git push origin fix/s0-pam-actuation-lifecycle
```

## Completion Non-Claims

- No native Windows execution or physical PAM enforcement is proven.
- No production deployment, hosted reachability, customer mutation, canary, or rollout is performed.
- No Task 6 independent `received` production transport is added.
- No entitlement-removal owner or Product disposition is supplied.
- No Task 8 failure-matrix or exact-candidate Windows work is started.
- No agent decoder relaxation, ledger expansion, command-ID bypass, migration, alternate result transaction, or supplemental WebSocket path is added.
