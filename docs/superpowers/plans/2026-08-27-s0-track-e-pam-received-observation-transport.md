# Track E Task 7C PAM `received` Observation Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use subagent-driven development and do not dispatch another Task 6 or Task 7 reviewer; each implementation's single independent boundary review has already been consumed.

**Goal:** Durably bind the Windows manager's internally ordered Task 6 `received` observation to the exact authenticated PAM command and persist it through the frozen acknowledged PAM result transaction without starting Task 8.

**Architecture:** The concrete Windows lifecycle manager exposes an invocation-scoped `ApplyWithReceivedObservation` method while the frozen `pamlifetime.Manager` interface stays unchanged. The heartbeat apply handler synchronously enqueues the callback's result with the command-envelope ID into the existing PAM outbox. The retry loop sends only `received` to a new primary-agent REST observation route; all other reconciliation results keep using `/result`. The route authorizes the exact command/device/type/role and calls `recordPamActuationResult` without mutating `device_commands`.

**Tech Stack:** Go, Windows lifecycle seams, Hono, TypeScript, Zod, Drizzle ORM, PostgreSQL, Vitest.

## Global Constraints

- Implement only [`2026-08-27-s0-track-e-pam-received-observation-transport-design.md`](../specs/2026-08-27-s0-track-e-pam-received-observation-transport-design.md).
- Execute in `/Users/toddhebebrand/breeze/.worktrees/s0-track-e-pam-actuation` on `fix/s0-pam-actuation-lifecycle`; preserve every dirty/user-owned file elsewhere.
- Use strict RED/GREEN for every behavior change: add the named assertion, run it and observe the expected failure, implement only that checkpoint, rerun the named tests, and commit.
- Keep `pamlifetime.Manager`, the strict apply/cleanup/result shapes, the PAM ledger, and `recordPamActuationResult` unchanged.
- Do not weaken agent/device/org/command/actuation/generation/desired-state/target-role ownership checks.
- Add no migration, table, alternate transaction, unauthenticated route, WebSocket supplemental path, decoder relaxation, command-ID bypass, or outbox migration.
- A durable enqueue failure after resume must prevent active verification, mark the generation unresolved, close owned process/Job handles, attempt deprovision, and return `received_observation_handoff_failed`; never claim `cleaned`.
- Durable observation transport readiness is a separate apply-only gate. `pamReconciled` represents only local manager/startup readiness and must not become false for any pending, blocked, quarantined, or unreadable durable observation state. The separate gate blocks apply and protocol advertisement for every blocked or quarantined observation kind, while cleanup and startup reconciliation remain callable. Ordinary acknowledged non-`received` pending entries retain their existing non-blocking behavior; pending `received` entries additionally block until acknowledged.
- The route is server-first, primary-agent-only, drain-blocked, streaming-body-limited to 32 KiB, strict-schema validated, and rate-limited by authenticated device ID.
- Do not start Task 8 or claim native Windows, signed artifact, physical enforcement, deployment, hosted, customer, canary, or rollout evidence.
- Do not dispatch an independent reviewer. Stop if execution would touch a boundary or file outside this plan.

## File Responsibility Map

- `apps/api/src/routes/agents/pamObservations.ts`: strict supplemental route, exact command authorization, frozen transaction call.
- `apps/api/src/routes/agents/pamObservations.test.ts`: route auth, drain, schema, size, rate, ownership, and acknowledgement tests.
- `apps/api/src/__tests__/integration/pamReceivedObservation.integration.test.ts`: real-PostgreSQL ownership, ordering, idempotency, immutable-command proof.
- `agent/internal/pamlifetime/manager.go`: invocation-scoped received handoff and fail-closed post-resume behavior.
- `agent/internal/pamlifetime/job_contract_test.go`: resume/handoff/verify ordering and cleanup-on-failure proof.
- `agent/internal/heartbeat/handlers_actuate.go`: narrow optional interface and synchronous exact-command enqueue.
- `agent/internal/heartbeat/pam_reconciliation.go`: state-based REST routing, acknowledgement handling, apply-only readiness, telemetry.
- `agent/internal/heartbeat/heartbeat.go`: separate apply gate and received-pending count.
- `apps/api/src/routes/agents/schemas.ts`: tolerant received-pending telemetry.
- `docs/runbooks/pam-reconciliation-rollout.md`: server-first promote gate.

---

### Task 1: Add the authenticated supplemental `received` route

**Files:**
- Create: `apps/api/src/routes/agents/pamObservations.ts`
- Create: `apps/api/src/routes/agents/pamObservations.test.ts`
- Modify: `apps/api/src/routes/agents/index.ts`
- Modify: `apps/api/src/middleware/bodyLimit.test.ts`
- Create: `apps/api/src/__tests__/integration/pamReceivedObservation.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts`
- Modify: `apps/api/src/routes/agents.test.ts`
- Test: `apps/api/src/routes/agents/commands.test.ts`
- Test: `apps/api/src/routes/agentWs.test.ts`

**Interfaces:**
- Consumes `pamAgentResultV2Schema`, `recordPamActuationResult`, `consumePamReconciliationRateLimit`, `deviceCommands`, `AgentAuthContext`, and `requireAgentRole`.
- Produces `POST /:id/commands/:commandId/pam-observations` with strict `{ protocolVersion: 1, observation: PamAgentResultV2 & { state: 'received' } }` input and `{ protocolVersion: 1, classification }` output.
- Produces no command write, alternate audit transaction, new persistence service, or WebSocket behavior.

- [x] **Step 1: Write route RED tests**

Create this exact fixture:

```ts
const received = {
  protocolVersion: 2,
  observationId: '10000000-0000-4000-8000-000000000001',
  actuationId: '20000000-0000-4000-8000-000000000001',
  generation: 3,
  state: 'received' as const,
  observedAt: '2026-08-27T12:00:00.000Z',
  evidence: {
    bootId: 'boot-1',
    pid: 4321,
    processCreationTime: '2026-08-27T11:59:59.000Z',
    jobName: 'Global\\Breeze.PAM.20000000-0000-4000-8000-000000000001.g3',
  },
};
const body = { protocolVersion: 1 as const, observation: received };
```

Assert: primary agent plus exact owned `pam_apply_v2`/`agent` command returns the frozen classification; watchdog and path/authenticated-agent mismatch return 403 before rate/query/service; any drain allowlist returns `403 drain_restricted`; non-UUID command returns 400; missing/foreign-device/wrong-type/wrong-role command returns opaque 404; wrong protocol, non-`received` state, or unknown outer/observation/evidence key returns 400; a streamed body over 32768 bytes with no oversized header returns 413 before validation; exhausted device budget returns 429 before command lookup. In `agents.test.ts`, mount the real `agentRoutes` and prove a request with no valid agent credential is 401 and a watchdog credential is 403; do not treat an injected context-only unit test as authentication proof.

Assert the exact service call:

```ts
expect(mocks.recordResult).toHaveBeenCalledWith({
  agentId: 'agent-primary',
  deviceId: DEVICE_ID,
  commandId: COMMAND_ID,
  result: received,
});
```

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/pamObservations.test.ts
```

Expected: FAIL because the module and route do not exist.

- [x] **Step 3: Implement and mount the route**

Use streaming body limiting:

```ts
const PAM_OBSERVATION_MAX_BODY_BYTES = 32 * 1024;
const pamReceivedObservationRequestSchema = z.object({
  protocolVersion: z.literal(1),
  observation: pamAgentResultV2Schema.extend({ state: z.literal('received') }),
}).strict();
const pamObservationParamSchema = z.object({
  id: z.string().min(1),
  commandId: z.string().uuid(),
}).strict();
```

Apply `requireAgentRole`, parameter validation, then this exact streaming body
gate before body validation:

```ts
bodyLimit({
  maxSize: PAM_OBSERVATION_MAX_BODY_BYTES,
  onError: bodyLimitOnError(
    'agent-pam-observation',
    PAM_OBSERVATION_MAX_BODY_BYTES,
    'Request body too large',
  ),
})
```

The handler order is:

```ts
if (!agent?.agentId || !agent.deviceId || agent.agentId !== agentId) {
  return c.json({ error: 'Forbidden' }, 403);
}
if (agent.claimTypeAllowlist) return c.json({ error: 'drain_restricted' }, 403);

const rate = await consumePamReconciliationRateLimit(agent.deviceId);
if (!rate.allowed) return c.json({
  error: 'Rate limit exceeded', resetAt: rate.resetAt.toISOString(),
}, 429);

const [command] = await runOutsideDbContext(() => db
  .select({ id: deviceCommands.id })
  .from(deviceCommands)
  .where(and(
    eq(deviceCommands.id, commandId),
    eq(deviceCommands.deviceId, agent.deviceId),
    eq(deviceCommands.type, 'pam_apply_v2'),
    eq(deviceCommands.targetRole, 'agent'),
  ))
  .limit(1));
if (!command) return c.json({ error: 'Command not found' }, 404);
const classification = await recordPamActuationResult({
  agentId: agent.agentId,
  deviceId: agent.deviceId,
  commandId,
  result: request.observation,
});
return c.json({ protocolVersion: 1 as const, classification });
```

Mount after `commandsRoutes`. Do not add the path to a drain allowlist or `FALLBACK_AUDIT_EXCLUDE_PATHS`.

- [x] **Step 4: Run route GREEN and unchanged-transport regressions**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/pamObservations.test.ts src/routes/agents.test.ts src/routes/agents/commands.test.ts src/routes/agentWs.test.ts src/middleware/bodyLimit.test.ts
```

Expected: all pass; ordinary `/result` and WebSocket behavior stays unchanged.

- [x] **Step 5: Write and run the real-PostgreSQL ownership RED/GREEN test**

Create two org/device/primary-agent/actuation/agent-targeted-command fixtures.
Make command A terminal before submission (`status='completed'`, non-null
`completed_at`, and a sentinel stored result) so the test proves the
supplemental route is independent of command terminalization.
Define the test helpers completely:

```ts
async function submitReceived(app: Hono, commandId: string, observation: typeof received) {
  const response = await app.request(`/agents/agent-primary/commands/${commandId}/pam-observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, observation }),
  });
  return {
    status: response.status,
    body: await response.json() as { protocolVersion?: number; classification?: string },
  };
}

async function readCommand(commandId: string) {
  return db.select().from(deviceCommands).where(eq(deviceCommands.id, commandId)).limit(1);
}

async function readPamResults(actuationId: string) {
  return db.select().from(pamActuationResults)
    .where(eq(pamActuationResults.actuationId, actuationId));
}
```

Submit received on A and assert:

```ts
const before = await readCommand(COMMAND_A);
expect((await submitReceived(appA, COMMAND_A, received))).toMatchObject({
  status: 200,
  body: { protocolVersion: 1, classification: 'applied' },
});
expect(await readCommand(COMMAND_A)).toEqual(before);
expect(await readPamResults(ACTUATION_A)).toMatchObject([
  { observationId: received.observationId, resultKind: 'received' },
]);
expect((await submitReceived(appA, COMMAND_A, received)).body.classification).toBe('duplicate');
expect((await submitReceived(appA, COMMAND_B, received)).status).toBe(404);
```

Snapshot org B's command, PAM-result, actuation, and elevation-audit rows before
the foreign request and compare each query byte-for-byte afterward; all counts
and values must be unchanged. Before verified evidence arrives, assert
`elevation_requests.session_started_at` is null and no `session_started` audit
exists. Submit `verified_active` through existing `/result` and prove both
observations persist with verified current truth. In a fresh fixture submit
verified first, then received, and prove `stale`, no new received row, and no
regression.

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamReceivedObservation.integration.test.ts
```

Expected RED before the route is wired; expected GREEN with exact command immutability and zero foreign side effects.

- [x] **Step 6: Register route-scan scope and commit**

Add the exact site-scope exemption with an agent-token/exact-device justification:

```ts
'routes/agents/pamObservations.ts:POST /:id/commands/:commandId/pam-observations',
```

Run and commit:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamReceivedObservation.integration.test.ts
pnpm --filter @breeze/api test:site-scope-coverage
git add apps/api/src/routes/agents/pamObservations.ts apps/api/src/routes/agents/pamObservations.test.ts apps/api/src/routes/agents/index.ts apps/api/src/routes/agents.test.ts apps/api/src/middleware/bodyLimit.test.ts apps/api/src/__tests__/integration/pamReceivedObservation.integration.test.ts apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts
git commit -m "fix(api): accept PAM received observations"
```

### Task 2: Add the invocation-scoped manager handoff

**Files:**
- Modify: `agent/internal/pamlifetime/manager.go`
- Modify: `agent/internal/pamlifetime/job_contract_test.go`
- Test unchanged: `agent/internal/pamlifetime/types.go`
- Test unchanged: `agent/internal/pamlifetime/manager_windows.go`

**Interfaces:**
- Produces `ApplyWithReceivedObservation(context.Context, ApplyCommand, func(Result) error) Result` only on `*lifecycleManager`.
- Preserves the four-method `Manager` interface byte-for-byte.
- Handoff occurs after resume and before verify only for a new process; duplicate apply never calls it.

- [x] **Step 1: Write ordering/failure RED tests**

Add:

```go
func TestApplyWithReceivedObservationOrdersResumeHandoffVerify(t *testing.T)
func TestApplyWithReceivedObservationFailureClosesOwnershipAndMarksUnresolved(t *testing.T)
func TestApplyWithReceivedObservationDuplicateDoesNotHandoff(t *testing.T)
```

Success order is `Resume`, `ClosePrimaryThread`, `Handoff(received with canonical UUID)`, `VerifyActive`, `Return(verified_active)`. Callback error must yield `received_observation_handoff_failed`, zero VerifyActive calls, exactly one Job/process close, one deprovision attempt, and `Available()==false`. Duplicate apply returns existing singular received and invokes callback zero times.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -count=1 ./internal/pamlifetime -run 'TestApplyWithReceivedObservation'
```

Expected: FAIL because the concrete method is absent.

- [x] **Step 3: Refactor through one private implementation**

```go
func (m *lifecycleManager) Apply(ctx context.Context, cmd ApplyCommand) Result {
  return m.apply(ctx, cmd, nil)
}
func (m *lifecycleManager) ApplyWithReceivedObservation(
  ctx context.Context, cmd ApplyCommand, handoff func(Result) error,
) Result {
  return m.apply(ctx, cmd, handoff)
}
```

Rename the current implementation declaration from
`func (m *lifecycleManager) Apply(ctx context.Context, cmd ApplyCommand) Result`
to `func (m *lifecycleManager) apply(ctx context.Context, cmd ApplyCommand, handoff func(Result) error) Result`.
Keep that body verbatim except for the received block in Step 4. Do not store
the callback on the manager or add it to the constructor.

- [x] **Step 4: Implement the post-resume barrier**

```go
received := m.result(cmd.ActuationID, cmd.Generation, ResultReceived, evidenceFromProcess(process.Identity, nil))
if handoff != nil {
  if err := handoff(received); err != nil {
    m.markUnresolved(cmd.ActuationID, cmd.Generation)
    return m.failed(cmd.ActuationID, cmd.Generation, bootID, "received_observation_handoff_failed")
  }
} else {
  m.emit(received)
}
```

Leave VerifyActive, verified emission, ownership transfer, and all pre-resume paths unchanged. Existing defers remain armed on callback failure.

- [x] **Step 5: Run GREEN/race/frozen-interface gates and commit**

```bash
cd agent && go test -count=1 ./internal/pamlifetime -run 'TestApplyWithReceivedObservation|TestApplyFailureClosesEachOwnedHandleExactlyOnce|TestHigherGenerationApplyCannotOverwriteLiveOwnership'
cd agent && go test -count=1 -race ./internal/pamlifetime
git diff -- agent/internal/pamlifetime/types.go agent/internal/pamlifetime/manager_windows.go
git add agent/internal/pamlifetime/manager.go agent/internal/pamlifetime/job_contract_test.go
git commit -m "fix(agent): hand off PAM received evidence"
```

Expected: tests pass and the frozen-file diff prints nothing.

### Task 3: Bind exact command ownership and acknowledged REST retry

**Files:**
- Modify: `agent/internal/heartbeat/handlers_actuate.go`
- Modify: `agent/internal/heartbeat/handlers_actuate_test.go`
- Modify: `agent/internal/heartbeat/pam_reconciliation.go`
- Modify: `agent/internal/heartbeat/pam_reconciliation_test.go`
- Modify: `agent/internal/heartbeat/pam_reconciliation_outbox_test.go`

**Interfaces:**
- Consumes Task 2 through a heartbeat-local narrow interface.
- Synchronously enqueues `outbox.Enqueue(cmd.ID, received)` before verification.
- Sends received to `/pam-observations`; verified/cleaned/failed keep the existing `/result` envelope.

- [x] **Step 1: Write handler and route-selection RED tests**

Add:

```go
func TestPamApplyV2RequiresReceivedObservationManager(t *testing.T)
func TestPamApplyV2EnqueuesExactEnvelopeCommandBeforeVerification(t *testing.T)
func TestPamApplyV2EnqueueFailureReturnsStableManagerFailure(t *testing.T)
func TestPamCleanupV2DoesNotRequireReceivedObservationManager(t *testing.T)
```

Use different UUIDs for command/request/actuation and assert only `cmd.ID` enters the outbox. Have the fake manager inspect the outbox before its callback returns. Unsupported narrow interface must call neither Apply method. Cleanup still calls frozen `Cleanup`.

With `httptest.Server`, assert exact routing/body:

```text
received        -> POST /api/v1/agents/agent-primary/commands/60000000-0000-4000-8000-000000000001/pam-observations
                  protocolVersion 1 plus the exact received fixture from Task 1
verified/cleaned/failed -> existing /result completed envelope
```

Prove `applied|duplicate|stale` dispose. For `rejected`, prove authoritative
`duplicate|stale` re-resolution disposes, newer-command `bound` rebinds and
retries, same-command `bound` quarantines, `unresolved` retains, and a later
startup re-resolution self-clears quarantine only on `duplicate|stale`.
Prove 404/non-200/malformed/lost/invalid acknowledgement retains the entry.
In `pam_reconciliation_outbox_test.go`, load a pre-change JSON entry containing
only the existing fields and prove Snapshot plus submission works without a
source/version migration.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -count=1 ./internal/heartbeat -run 'TestPamApplyV2.*Received|TestPamCleanupV2DoesNotRequire|TestPamReconciliation.*Route|TestPamReconciliation.*Acknowledgement'
```

Expected: FAIL because handler uses `Manager.Apply` and submission always uses `/result`.

- [x] **Step 3: Add the narrow interface and exact-command callback**

```go
type pamReceivedObservationManager interface {
  ApplyWithReceivedObservation(
    context.Context, pamlifetime.ApplyCommand, func(pamlifetime.Result) error,
  ) pamlifetime.Result
}
```

After existing identity/manager/reconciliation/verification/policy gates:

```go
manager, ok := h.pamLifetimeManager.(pamReceivedObservationManager)
if !ok {
  return tools.NewErrorResult(errors.New("PAM received observation transport unavailable"), time.Since(start).Milliseconds())
}
result := manager.ApplyWithReceivedObservation(ctx, payload, func(received pamlifetime.Result) error {
  if h.pamReconciliationOutbox == nil {
    return errors.New("PAM received observation outbox unavailable")
  }
  if err := h.pamReconciliationOutbox.Enqueue(cmd.ID, received); err != nil {
    return fmt.Errorf("enqueue PAM received observation: %w", err)
  }
  h.signalPamReconciliationWork()
  return nil
})
h.refreshPamLifetimeAvailability()
```

Do not call the resolver or network from the callback.

- [x] **Step 4: Branch the existing submitter only by result state**

```go
var requestURL string
var payload any
var err error
if result.State == pamlifetime.ResultReceived {
  routePath := fmt.Sprintf("/api/v1/agents/%s/commands/%s/pam-observations",
    url.PathEscape(h.config.AgentID), url.PathEscape(commandID))
  requestURL, err = h.pamTransportURL(routePath)
  if err != nil { return acknowledgement, err }
  payload = struct {
    ProtocolVersion int                `json:"protocolVersion"`
    Observation     pamlifetime.Result `json:"observation"`
  }{ProtocolVersion: pamReconciliationProtocolVersion, Observation: result}
} else {
  routePath := fmt.Sprintf("/api/v1/agents/%s/commands/%s/result",
    url.PathEscape(h.config.AgentID), url.PathEscape(commandID))
  requestURL, err = h.pamTransportURL(routePath)
  if err != nil { return acknowledgement, err }
  envelope := tools.NewSuccessResult(result, 0)
  envelope.Result = result
  payload = envelope
}
```

Keep the submitter seam, strict acknowledgement decoder, and re-resolution logic. Add a test proving startup `Reconcile` currently emits no received state and stays on `/result`.

- [x] **Step 5: Run GREEN/race gates and commit**

```bash
cd agent && go test -count=1 ./internal/heartbeat -run 'TestPamApplyV2|TestPamCleanupV2|TestPamReconciliation|TestPamOutbox'
cd agent && go test -count=1 -race ./internal/heartbeat ./internal/pamlifetime
git add agent/internal/heartbeat/handlers_actuate.go agent/internal/heartbeat/handlers_actuate_test.go agent/internal/heartbeat/pam_reconciliation.go agent/internal/heartbeat/pam_reconciliation_test.go agent/internal/heartbeat/pam_reconciliation_outbox_test.go
git commit -m "fix(agent): transport PAM received observations"
```

### Task 4: Separate apply readiness and expose transport telemetry

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`
- Modify: `agent/internal/heartbeat/handlers_actuate.go`
- Modify: `agent/internal/heartbeat/handlers_actuate_test.go`
- Modify: `agent/internal/heartbeat/pam_reconciliation.go`
- Modify: `agent/internal/heartbeat/pam_reconciliation_test.go`
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/schemas.test.ts`
- Modify: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`
- Modify: `docs/runbooks/pam-reconciliation-rollout.md`

**Interfaces:**
- Produces `pamReceivedObservationReady atomic.Bool`, used by apply admission and advertised protocol only.
- Adds optional `receivedObservationPendingCount` and reason `received_observation_transport`.
- Preserves `pamReconciled` as local manager/startup gate used by apply and cleanup.

- [x] **Step 1: Write readiness and telemetry RED tests**

Cover: clean local/outbox -> both flags true/protocol 2; pending received on startup -> reconciled true/received false/protocol 0; final ack -> received true/protocol 2; route failure/quarantine/unreadable -> received false/apply refused; cleanup invokes manager with reconciled true/received false; ordinary acknowledged non-received pending keeps existing non-blocking behavior; a non-received blocked or quarantined entry leaves `pamReconciled` true but sets received-transport readiness false, closes apply/protocol advertisement, and leaves cleanup callable; local reconciliation unresolved keeps reconciled false for both.

Assert exact telemetry:

```json
{
  "unresolvedCount": 0,
  "quarantinedCount": 1,
  "awaitingAcknowledgementCount": 2,
  "receivedObservationPendingCount": 1,
  "blockingReason": "received_observation_transport"
}
```

Malformed/negative/string count or unknown reason drops only `pamReconciliation`.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -count=1 ./internal/heartbeat -run 'TestPamReceivedObservationReadiness|TestPamCleanupV2.*Received|TestPamReconciliationStatus|TestSecurityCapabilitiesControlProtocolJSON'
pnpm --filter @breeze/api exec vitest run src/routes/agents/schemas.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts
```

Expected: FAIL because separate readiness/count/reason do not exist.

- [x] **Step 3: Implement the apply-only predicate**

Add the atomic beside `pamReconciled`; set it false in `SetStatePath`, before startup reconciliation, and after received enqueue. Recompute separately:

```go
localReady := !h.pamLocalReconcileRunning.Load() && managerAvailable &&
  stagedCount == 0 && identityFailures == 0
h.pamReconciled.Store(localReady)

snapshot, err := h.pamReconciliationOutbox.Snapshot()
if err != nil {
  h.pamReceivedObservationReady.Store(false)
  return
}
receivedPending := 0
for _, entry := range snapshot.Pending {
  if entry.Observation.State == pamlifetime.ResultReceived { receivedPending++ }
}
h.pamReceivedObservationReady.Store(
  localReady && blockedCount == 0 && receivedPending == 0 && len(snapshot.Quarantined) == 0,
)
```

Nil outbox sets received readiness to `localReady && blockedCount == 0`.
`pamReconciliationBlocked` and every quarantined outbox entry remain
apply-admission conditions through the separate predicate, regardless of
observation state. Neither may set `pamReconciled=false`: cleanup is a
privilege-reducing recovery path and must remain available for rejected
`received`, `verified_active`, `cleaned`, or `failed` evidence. An unreadable
outbox follows the same rule. Require both flags in apply and
`pamLifetimeProtocolVersion`; require only `pamReconciled` in cleanup. Pending
non-`received` observations that are neither blocked nor quarantined preserve
their existing non-blocking behavior.

- [x] **Step 4: Implement telemetry and safe logs**

Count only pending `received`. Select `received_observation_transport` when a received entry cannot obtain ack, a received entry is quarantined, or the outbox is unreadable. Preserve staged resolver/binding/enqueue reasons.

```go
ReceivedObservationPendingCount int `json:"receivedObservationPendingCount,omitempty"`
```

```ts
receivedObservationPendingCount: z.number().int().nonnegative().optional(),
blockingReason: z.enum([
  'resolver_unavailable', 'binding_unresolved', 'enqueue_failed',
  'acknowledgement_unavailable', 'quarantined', 'outbox_unreadable',
  'received_observation_transport',
]).refine((value) => value.length <= 64).optional(),
```

Logs remain limited to counts, reason, outbox path, actuation ID, generation, observation ID; never command ID, username, path, credential, token, or evidence.

- [x] **Step 5: Update the server-first runbook**

Add:

```text
1. Deploy and verify POST /api/v1/agents/:id/commands/:commandId/pam-observations.
2. Prove applied, duplicate, stale, and rejected acknowledgements on an authorized disposable fixture.
3. Verify primary-agent-only, drain-blocked, rate/body-limited, and route/audit-scan registration.
4. Promote an agent with the callback only after 1-3 pass.
5. Stop when receivedObservationPendingCount persists beyond one retry interval or reason is received_observation_transport.
```

Missing route/ack is transport failure; never delete evidence for outage recovery; only the reviewed ledger-reset procedure clears genuine invariant quarantine.

- [x] **Step 6: Run GREEN/race gates and commit**

```bash
cd agent && go test -count=1 ./internal/heartbeat -run 'TestPamReceivedObservationReadiness|TestPamCleanupV2|TestPamReconciliationStatus|TestSecurityCapabilitiesControlProtocolJSON'
cd agent && go test -count=1 -race ./internal/heartbeat ./internal/pamlifetime
pnpm --filter @breeze/api exec vitest run src/routes/agents/schemas.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agents/heartbeat.test.ts
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go agent/internal/heartbeat/handlers_actuate.go agent/internal/heartbeat/handlers_actuate_test.go agent/internal/heartbeat/pam_reconciliation.go agent/internal/heartbeat/pam_reconciliation_test.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/schemas.test.ts apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts docs/runbooks/pam-reconciliation-rollout.md
git commit -m "fix(pam): gate apply on received transport"
```

### Task 5: Run closure gates and synchronize exact evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md`
- Modify: `docs/superpowers/plans/2026-08-27-s0-track-e-pam-received-observation-transport.md`
- External record: issue #4060
- External record: PR #4105

**Interfaces:**
- Produces exact-head focused, real-PostgreSQL, race, Windows compile, governance, attached-check, and core-CI evidence.
- Closes only Task 6 received transport; Task 8 and entitlement disposition remain open.

- [x] **Step 1: Run complete local gates**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/pamObservations.test.ts src/routes/agents/pamReconciliation.test.ts src/routes/agents/commands.test.ts src/routes/agents.test.ts src/routes/agentWs.test.ts src/routes/agents/schemas.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agents/heartbeat.test.ts src/services/pamActuationResult.test.ts src/services/commandResultHandlers.test.ts src/middleware/bodyLimit.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamReceivedObservation.integration.test.ts src/__tests__/integration/pamActuationResults.integration.test.ts src/__tests__/integration/pamReconciliationBinding.integration.test.ts src/__tests__/integration/pamActuationDispatchWire.integration.test.ts
pnpm --filter @breeze/api test:site-scope-coverage
pnpm --filter @breeze/api test:rls-coverage
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd agent && go test -count=1 -race ./internal/agentapp ./internal/pamlifetime ./internal/heartbeat/...
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/agentapp -o /tmp/breeze-agentapp.test.exe
```

Expected: all named files execute/pass; ordinary REST/WS stays unchanged; Windows compile is not native execution.

- [x] **Step 2: Run governance/scope gates**

```bash
pnpm --filter @breeze/api db:check-drift
bash scripts/check-migration-naming.sh
git diff --check
git status --short
git diff --name-only 562f578e315dd0b7a533ff7e51002fd91971e2d7...HEAD | rg '(^apps/api/migrations/|pam-lifetime-ledger|state_machine|failureMatrix)' && exit 1 || true
```

Expected: no Task 7C drift/migration/whitespace/unplanned file, ledger expansion,
or Task 8 file. Track D is the overall stacked-PR base and necessarily shows
Track E's two already-approved migrations, so `562f578e...HEAD` is the exact
Task 7C scope boundary for this guard.

- [x] **Step 3: Push and dispatch exact-head core CI**

```bash
candidate_sha=$(git rev-parse HEAD)
git push origin fix/s0-pam-actuation-lifecycle
test "$(git rev-parse origin/fix/s0-pam-actuation-lifecycle)" = "$candidate_sha"
gh workflow run ci.yml --repo LanternOps/breeze --ref fix/s0-pam-actuation-lifecycle
run_id=$(gh run list --repo LanternOps/breeze --workflow ci.yml \
  --branch fix/s0-pam-actuation-lifecycle --event workflow_dispatch --limit 20 \
  --json databaseId,headSha --jq ".[] | select(.headSha == \"$candidate_sha\") | .databaseId" | head -1)
test -n "$run_id"
gh run watch "$run_id" --repo LanternOps/breeze --exit-status
gh run view "$run_id" --repo LanternOps/breeze --json headSha,status,conclusion,url,jobs \
  --jq '{headSha,status,conclusion,url,jobs:[.jobs[]|{name,conclusion}]}'
```

Verify exact SHA. Only expected Main Red Alert may skip. Record manual-run jobs separately from PR-attached checks.

- [x] **Step 4: Confirm remote/PR/attached checks before claims**

```bash
git fetch origin --prune
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/fix/s0-pam-actuation-lifecycle)"
gh pr view 4105 --repo LanternOps/breeze \
  --json state,isDraft,mergeStateStatus,headRefOid,baseRefName,url,statusCheckRollup \
  --jq '{state,isDraft,mergeStateStatus,headRefOid,baseRefName,url,checks:[.statusCheckRollup[]|{name,status,conclusion}]}'
```

- [x] **Step 5: Record closure without Task 8 and commit**

In the parent plan mark only Task 7C complete and record exact implementation SHA, executed test counts, race/compile results, manual run ID/jobs, and attached checks. Update `/tmp/s0-fleet-integrity-tracker.md`, issue #4060, and PR #4105 to the same exact state. Keep entitlement and Task 8 open; do not edit/push QA.

```bash
git add docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md docs/superpowers/plans/2026-08-27-s0-track-e-pam-received-observation-transport.md
git commit -m "docs(pam): record received transport evidence"
git push origin fix/s0-pam-actuation-lifecycle
```

Expected: Track E remains `fixed-unverified`; Task 8 stays unchecked/unstarted.

Execution closure (2026-08-28): exact implementation candidate
`efd34dfe3a523d3999e12ed1bc1437bc37c0ea9a` passed the complete local gates
and manual core run
[`33179007091`](https://github.com/LanternOps/breeze/actions/runs/33179007091)
with 41 successful jobs, only the expected skipped Main Red Alert, and no
failures. All three stacked-PR checks attached at that SHA passed. Task 8 and
the shipping entitlement disposition remain open; no endpoint deployment or
native signed-Windows evidence is claimed.
