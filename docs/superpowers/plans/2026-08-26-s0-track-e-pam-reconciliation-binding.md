---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
parent_plan: ./2026-08-24-s0-track-e-pam-actuation.md
design_spec: ../specs/2026-08-26-s0-track-e-pam-reconciliation-binding-design.md
---

# Track E Task 7 Step 3 PAM Reconciliation Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry structured startup `Manager.Reconcile` evidence through the existing exact-command PAM result transaction without changing the durable PAM ledger or weakening agent, device, organization, actuation, generation, role, or command ownership.

**Architecture:** An authenticated REST resolver performs one read-only, owned-scope batch query and returns the exact current PAM command only for fully verified same-generation candidates. The agent assigns deterministic UUIDv5 observation IDs, durably hands bound observations to a non-expiring PAM namespace in the existing result outbox, and submits them through the existing REST command-result route, which acknowledges the frozen result transaction's classification. Startup admission opens only after each local observation is durably queued or authoritatively classified duplicate/stale; unresolved and quarantined evidence stays fail-closed.

**Tech Stack:** TypeScript, Hono, Zod, Drizzle/raw PostgreSQL SQL, Vitest, Go, `github.com/google/uuid`, durable JSON files, existing authenticated agent HTTP transport.

## Global Constraints

- Implement only Track E Task 7 Step 3. Do not begin Task 8.
- Do not add `commandId` to the PAM ledger, create another result writer, change the frozen `recordPamActuationResult` ownership checks, or add a WebSocket supplemental path.
- The resolver is unavailable during tenant/device drain, requires the primary `agent` role, and returns opaque `unresolved` for missing, foreign, future, commandless, wrong-role, wrong-type, or contradictory candidates.
- Use exact limits: 100 candidates per resolver request, 32 KiB resolver `Content-Length`, and one shared per-device reconciliation budget of 120 accepted attempts per 60 seconds for resolver calls plus supplemental terminal REST results.
- The exact deterministic identity is UUIDv5 with `uuid.NameSpaceURL` and UTF-8 name `https://breezermm.com/protocol/pam-reconciliation-observation/v1/` plus compact JSON for `[lowercaseCanonicalActuationUUID, generation, state, bootId]`.
- PAM reconciliation outbox entries never expire and are never removed by the ordinary 20-entry/48-hour backup-result policy. Corrupt or unreadable PAM entries block admission and remain on disk.
- An enqueue is successful only after a mode-0600 temporary file is written, synced, closed, and atomically renamed into the PAM namespace. A failed enqueue leaves the observation staged and admission closed.
- Only an acknowledged `applied`, `duplicate`, or `stale` removes a pending entry. A missing/malformed acknowledgement is transport failure. `rejected` must re-resolve before any quarantine decision.
- Preserve WebSocket terminal/orphan behavior byte-for-byte except for accepting the widened handler return type and ignoring its value.
- The pre-existing `pamActuationWorker` dispatch wire-contract defect is out of scope and remains a separately tracked end-to-end evidence blocker.
- No production deployment, `/opt/breeze` modification, hosted-admission change, or customer-device mutation.

---

### Task 1: Add the owned-scope reconciliation binding resolver

**Files:**
- Create: `apps/api/src/services/pamReconciliationBinding.ts`
- Create: `apps/api/src/services/pamReconciliationBinding.test.ts`
- Create: `apps/api/src/services/pamReconciliationRateLimit.ts`
- Create: `apps/api/src/routes/agents/pamReconciliation.ts`
- Create: `apps/api/src/routes/agents/pamReconciliation.test.ts`
- Modify: `apps/api/src/routes/agents/index.ts`
- Test: `apps/api/src/middleware/agentAuth.test.ts`
- Create: `apps/api/src/__tests__/integration/pamReconciliationBinding.integration.test.ts`

**Interfaces:**

```ts
export type PamReconciliationCandidate = {
  observationId: string;
  actuationId: string;
  generation: number;
};

export type PamReconciliationBindingDisposition =
  | { status: 'bound'; observationId: string; commandId: string }
  | { status: 'duplicate'; observationId: string }
  | { status: 'stale'; observationId: string }
  | { status: 'unresolved'; observationId: string };

export async function resolvePamReconciliationBindings(input: {
  agentId: string;
  deviceId: string;
  orgId: string;
  candidates: readonly PamReconciliationCandidate[];
}): Promise<PamReconciliationBindingDisposition[]>;

export async function consumePamReconciliationRateLimit(
  deviceId: string,
): Promise<RateLimitResult>;
```

- [x] **Step 1: Write resolver service RED tests**

Add unit tests that feed a deterministic row seam and prove this precedence for each request-order-preserving candidate:

```text
owned actuation scope absent                    -> unresolved, no result lookup
owned actuation + candidate generation lower   -> stale
owned actuation + candidate generation higher  -> unresolved
same generation + exact observation exists     -> duplicate
same generation + null current command         -> unresolved
same generation + wrong device/role/type        -> unresolved
same generation + exact active/apply binding    -> bound(commandId)
same generation + exact cleanup/cleanup binding -> bound(commandId)
```

Assert no result or command identifier is exposed for a foreign organization/device/agent.

- [x] **Step 2: Run the resolver service test and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/pamReconciliationBinding.test.ts
```

Expected: FAIL because the service and types do not exist.

- [x] **Step 3: Implement the single-read resolver**

Use one parameterized SQL statement with `jsonb_to_recordset`, carrying an ordinal so output order is stable. Join candidates to `pam_actuations` only through `devices` constrained by all of `agent_id`, `device_id`, and `org_id`; compute lower-generation `stale` before the observation join; inspect `pam_actuation_results` only for owned same-generation rows; and return `bound` only when the exact `current_command_id` joins a same-device `device_commands` row whose `target_role='agent'` and type matches desired state.

Do not lock rows and do not mutate state. Convert every missing join or contradictory value to `unresolved`.

- [x] **Step 4: Write route RED tests**

Define the strict request schema:

```ts
const pamReconciliationBindingRequestSchema = z.object({
  protocolVersion: z.literal(1),
  candidates: z.array(z.object({
    observationId: z.string().uuid(),
    actuationId: z.string().uuid(),
    generation: z.number().int().positive(),
  }).strict()).min(1).max(100),
}).strict().superRefine(rejectDuplicateObservationOrActuationGenerationKeys);
```

Test primary-agent success, watchdog refusal, malformed version/UUID/generation, duplicate keys, 101 candidates, `Content-Length > 32768`, per-device rate exhaustion, and a tenant/device drain 403. Assert the rate key derives only from authenticated `deviceId`.

- [x] **Step 5: Run the route tests and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/pamReconciliation.test.ts src/middleware/agentAuth.test.ts
```

Expected: FAIL because the route is absent.

- [x] **Step 6: Implement and mount the route**

Create `POST /:id/pam/reconciliation-bindings`, apply `requireAgentRole`, and check the 32 KiB `Content-Length` before Zod parsing. Put the exact `pam:reconciliation:device:<authenticated-device-id>` 120/60-second budget in `pamReconciliationRateLimit.ts`; this route and Task 2's terminal-result seam must both call that one exported function. Return:

```ts
{
  protocolVersion: 1,
  dispositions: await resolvePamReconciliationBindings(...),
}
```

Mount `pamReconciliationRoutes` after `commandsRoutes` in `routes/agents/index.ts`. Do not add `pam` to either drain allowlist; add a drain-path test that pins the resulting 403. Leave the route on the fallback audit surface and pin its authenticated route coverage in the route test.

- [x] **Step 7: Write and run the two-tenant real-Postgres gate**

Create two orgs, devices, agents, PAM actuations, commands, and observations. Prove exact `bound`, `duplicate`, `stale`, the cleanup generation-bump/null-command window as `unresolved`, watchdog/wrong-role/wrong-type refusal, and foreign actuation guesses returning `unresolved` with no writes.

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamReconciliationBinding.integration.test.ts
```

Expected: PASS with the file executed, not skipped.

- [x] **Step 8: Commit the resolver checkpoint**

```bash
git add apps/api/src/services/pamReconciliationBinding.ts apps/api/src/services/pamReconciliationBinding.test.ts apps/api/src/services/pamReconciliationRateLimit.ts apps/api/src/routes/agents/pamReconciliation.ts apps/api/src/routes/agents/pamReconciliation.test.ts apps/api/src/routes/agents/index.ts apps/api/src/middleware/agentAuth.test.ts apps/api/src/__tests__/integration/pamReconciliationBinding.integration.test.ts
git commit -m "fix(api): resolve PAM reconciliation command ownership"
```

### Task 2: Return acknowledged PAM classifications over REST only

**Files:**
- Modify: `apps/api/src/services/commandResultHandlers.ts`
- Modify: `apps/api/src/services/commandResultHandlers.test.ts`
- Modify: `apps/api/src/routes/agents/commands.ts`
- Modify: `apps/api/src/routes/agents/commands.test.ts`
- Test: `apps/api/src/routes/agentWs.test.ts`
- Test: `apps/api/src/__tests__/integration/pamActuationResults.integration.test.ts`

**Interfaces:**

```ts
export type CommandResultHandlerOutcome =
  | { kind: 'pam'; classification: PamActuationResultClassification }
  | void;

export type PamResultAcknowledgement = {
  protocolVersion: 1;
  classification: PamActuationResultClassification;
};
```

- [x] **Step 1: Write handler/REST acknowledgement RED tests**

Assert the PAM handler returns the exact `recordPamActuationResult` classification. For a nonterminal PAM command, assert the existing command-row update occurs once and the REST response is the acknowledgement. For an already-terminal PAM command, assert a valid structured result reaches the shared handler, returns the acknowledgement, and changes none of `status`, `result`, `payload`, `completed_at`, or other command columns. Assert malformed terminal PAM and all non-PAM terminal results preserve the existing `{ success: true }` short circuit.

- [x] **Step 2: Run focused API tests and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/commandResultHandlers.test.ts src/routes/agents/commands.test.ts
```

Expected: FAIL because handlers return `void` and terminal rows short-circuit before PAM dispatch.

- [x] **Step 3: Widen the handler result without changing non-PAM handlers**

Change `CommandResultHandler` to `Promise<CommandResultHandlerOutcome>`. Return `{ kind: 'pam', classification }` only from `handlePamActuationV2Result`; every existing handler continues returning `void`. The WebSocket caller awaits and discards the outcome.

- [x] **Step 4: Add the narrow terminal-PAM REST seam**

After command/device/role/drain authorization and before `commandAcceptsAgentResult` short-circuits, parse only `data.result` with `pamAgentResultV2Schema` for `pam_apply_v2`/`pam_cleanup_v2`. If the row is terminal and parsing succeeds, consume the same authenticated per-device 120/60 reconciliation budget, invoke the shared handler, and return:

```ts
return c.json({ protocolVersion: 1, classification: outcome.classification });
```

Do not execute the normal command-row compare-and-set on this branch. On the nonterminal registry branch, retain the handler outcome and return the same acknowledgement for PAM; return `{ success: true }` for every non-PAM command. A thrown handler produces no acknowledgement, so the agent retains its outbox entry.

- [x] **Step 5: Pin WebSocket non-behavior**

Add tests proving terminal PAM WebSocket results still enter the existing orphan handling, never invoke supplemental dispatch, and nonterminal PAM invokes the handler exactly once. Do not modify WebSocket routing logic beyond any TypeScript change required to ignore the handler outcome.

```bash
pnpm --filter @breeze/api exec vitest run src/services/commandResultHandlers.test.ts src/routes/agents/commands.test.ts src/routes/agentWs.test.ts
```

Expected: PASS.

- [x] **Step 6: Extend and run the real-Postgres result gate**

Add nonterminal and terminal REST cases for `applied`, retry `duplicate`, ownership-rotation `rejected`, and lower-generation `stale`; assert identical append-only PAM effects and no terminal command-row rewrite.

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationResults.integration.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit the acknowledgement checkpoint**

```bash
git add apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.test.ts apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/commands.test.ts apps/api/src/routes/agentWs.test.ts apps/api/src/__tests__/integration/pamActuationResults.integration.test.ts
git commit -m "fix(api): acknowledge PAM reconciliation results"
```

### Task 3: Add deterministic startup identity and the durable PAM outbox namespace

**Files:**
- Create: `agent/internal/pamlifetime/reconciliation_identity.go`
- Create: `agent/internal/pamlifetime/reconciliation_identity_test.go`
- Create: `agent/internal/heartbeat/pam_reconciliation_outbox.go`
- Create: `agent/internal/heartbeat/pam_reconciliation_outbox_test.go`
- Modify: `agent/internal/heartbeat/backup_result_outbox.go`
- Test: `agent/internal/heartbeat/backup_result_outbox_test.go`

**Interfaces:**

```go
func ReconciliationObservationID(result Result) (string, error)

type pamReconciliationOutboxEntry struct {
    CommandID   string             `json:"commandId"`
    Observation pamlifetime.Result `json:"observation"`
    EnqueuedAt  time.Time          `json:"enqueuedAt"`
    State       string             `json:"state"` // pending | quarantined
    Reason      string             `json:"reason,omitempty"`
}
```

- [x] **Step 1: Write deterministic-identity RED tests**

Use fixed inputs to prove byte-for-byte stable UUIDv5 output, lowercase actuation canonicalization, JSON escaping in `bootId`, different IDs for generation/state/native boot changes, and the same ID for repeated `windows-boot-unavailable` failure evidence. Pin this exact golden vector so an encoding change cannot silently fork identity across releases:

```text
actuationId = A0000000-0000-4000-8000-000000000001
generation  = 7
state       = failed
bootId      = windows-boot-42
UUIDv5      = cf09e252-8185-580e-816b-e8708805f663
```

- [x] **Step 2: Run the identity test and verify RED**

```bash
cd agent && go test ./internal/pamlifetime -run TestReconciliationObservationID -count=1
```

Expected: FAIL because the function does not exist.

- [x] **Step 3: Implement exact UUIDv5 identity**

Validate/canonicalize `ActuationID` with `uuid.Parse`, encode `[]any{strings.ToLower(parsed.String()), result.Generation, string(result.State), result.Evidence.BootID}` using `encoding/json`, prefix the exact design URL, and call `uuid.NewSHA1(uuid.NameSpaceURL, nameBytes)`. Return an error for zero generation, empty state, or empty boot ID.

- [x] **Step 4: Write durable outbox RED tests**

Test confirmed enqueue, same command/observation coalescing, different boot identity creating a second entry, pending and quarantine persistence across reconstruction, atomic rebind to a different command, pending-to-quarantine move, removal only by exact key, ordinary backup cap/age eviction leaving PAM files untouched, write/sync/rename failures returning errors, and corrupt/unreadable PAM files remaining blocking instead of being deleted.

- [x] **Step 5: Run outbox tests and verify RED**

```bash
cd agent && go test ./internal/heartbeat -run 'TestPamReconciliationOutbox|TestBackupResultOutbox' -count=1
```

Expected: FAIL because the PAM namespace and error-returning methods do not exist.

- [x] **Step 6: Implement the separate namespace under the existing outbox root**

Use `<ordinary-outbox>/pam-reconciliation/pending` and `/quarantine`. Use filenames `<command-uuid>.<observation-uuid>.json`; both IDs must be canonical UUIDs. Never scan these subdirectories from ordinary `loadAllLocked`. For a new immutable entry, create a same-directory temporary file, chmod 0600, encode, `Sync`, close, then rename to a previously nonexistent final name. Rebind writes the new file before removing the old file. Quarantine moves to its distinct nonexistent destination. Do not hold the mutex during network calls.

- [x] **Step 7: Run GREEN and race tests**

```bash
cd agent && go test -race ./internal/pamlifetime ./internal/heartbeat -run 'TestReconciliationObservationID|TestPamReconciliationOutbox|TestBackupResultOutbox' -count=1
```

Expected: PASS, with ordinary outbox behavior unchanged.

- [x] **Step 8: Commit the durable-agent checkpoint**

```bash
git add agent/internal/pamlifetime/reconciliation_identity.go agent/internal/pamlifetime/reconciliation_identity_test.go agent/internal/heartbeat/pam_reconciliation_outbox.go agent/internal/heartbeat/pam_reconciliation_outbox_test.go agent/internal/heartbeat/backup_result_outbox.go agent/internal/heartbeat/backup_result_outbox_test.go
git commit -m "fix(agent): persist PAM startup observations"
```

### Task 4: Implement binding, acknowledged submission, and rejected re-resolution

**Files:**
- Create: `agent/internal/heartbeat/pam_reconciliation.go`
- Create: `agent/internal/heartbeat/pam_reconciliation_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/handlers_actuate_test.go`

**Interfaces:**

```go
type pamBindingCandidate struct {
    ObservationID string `json:"observationId"`
    ActuationID   string `json:"actuationId"`
    Generation    uint64 `json:"generation"`
}

type pamBindingDisposition struct {
    Status        string `json:"status"`
    ObservationID string `json:"observationId"`
    CommandID     string `json:"commandId,omitempty"`
}

type pamResultAcknowledgement struct {
    ProtocolVersion int    `json:"protocolVersion"`
    Classification  string `json:"classification"`
}
```

- [x] **Step 1: Write transport RED tests**

With `httptest.Server`, prove resolver request path/auth/body, 100-candidate chunking, response correlation by observation ID, primary-agent URL, missing route/non-200/malformed response/missing disposition as errors, and exact REST result acknowledgement parsing. Assert redirects are refused by the existing HTTP client policy.

- [x] **Step 2: Run transport tests and verify RED**

```bash
cd agent && go test ./internal/heartbeat -run 'TestPamReconciliationTransport' -count=1
```

Expected: FAIL because the transport is absent.

- [x] **Step 3: Implement REST-only transport methods**

Use `httputil.Do` with bounded contexts, `h.serverURL()`, `h.authHeader()`, and `h.httpClient()`. Resolver path is `/api/v1/agents/<agentId>/pam/reconciliation-bindings`; result path remains `/api/v1/agents/<agentId>/commands/<commandId>/result`. Wrap each `pamlifetime.Result` as `tools.NewSuccessResult(result, 0)` with `Result` explicitly set. Accept only protocol version 1 and the four exact classification strings.

- [x] **Step 4: Write controller RED tests**

Prove the complete state table:

```text
resolver bound + enqueue success   -> staged removed, pending durable
resolver bound + enqueue failure   -> staged retained, admission closed
resolver duplicate/stale           -> staged disposed
resolver unresolved/failure        -> staged retained, admission closed
ack applied/duplicate/stale         -> pending removed
ack rejected + re-resolve stale/dup -> pending removed
ack rejected + unresolved           -> pending retained
ack rejected + different bound      -> atomically rebound and retried
ack rejected + same bound           -> quarantined, admission closed
startup quarantine stale/duplicate  -> removed and may self-clear
startup quarantine same bound       -> remains quarantined
```

Also prove only one retry loop runs, concurrent command admission cannot overtake the barrier, and awaiting acknowledgement does not keep admission closed after confirmed durable handoff.

- [x] **Step 5: Run controller tests and verify RED**

```bash
cd agent && go test -race ./internal/heartbeat -run 'TestPamReconciliationController|TestPamCommandAdmission' -count=1
```

Expected: FAIL because local reconciliation currently sets `pamReconciled` true without server binding.

- [x] **Step 6: Implement the startup barrier and retry loop**

In `ReconcilePAMLifetime`, set both readiness flags false, run the manager, replace every returned observation ID with `ReconciliationObservationID`, stage the results, load existing pending/quarantine entries, and perform one bounded resolve/drain pass. Set `pamReconciled=true` only when the local manager is available, no staged/unresolved item remains, and no quarantine remains; pending acknowledged-delivery entries are a completed durable handoff.

Start a single retry goroutine at the top of `Heartbeat.Start`; retry immediately once and then on bounded exponential backoff capped at the heartbeat interval, waking on new work and stopping on `stopChan`. Every transition to unresolved/quarantine sets `pamReconciled=false`; clearing the last blocker recomputes readiness. Do not submit reconciliation entries over `wsClient` or `backupResultOutbox.Flush`.

- [x] **Step 7: Run GREEN and race tests**

```bash
cd agent && go test -race ./internal/heartbeat ./internal/pamlifetime -run 'TestPamReconciliation|TestPamCommandAdmission|TestReconciliationObservationID' -count=1
```

Expected: PASS.

- [x] **Step 8: Commit the transport/barrier checkpoint**

```bash
git add agent/internal/heartbeat/pam_reconciliation.go agent/internal/heartbeat/pam_reconciliation_test.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/handlers_actuate_test.go
git commit -m "fix(agent): bind PAM startup evidence"
```

### Task 5: Surface blocked-state telemetry and publish the manual recovery runbook

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`
- Modify: `agent/internal/heartbeat/pam_reconciliation.go`
- Modify: `agent/internal/heartbeat/pam_reconciliation_test.go`
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/schemas.test.ts`
- Modify: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`
- Create: `docs/runbooks/pam-reconciliation-ledger-reset.md`
- Create: `docs/runbooks/pam-reconciliation-rollout.md`

**Interfaces:**

```go
type PamReconciliationStatus struct {
    UnresolvedCount              int    `json:"unresolvedCount"`
    QuarantinedCount             int    `json:"quarantinedCount"`
    AwaitingAcknowledgementCount int    `json:"awaitingAcknowledgementCount"`
    BlockingReason               string `json:"blockingReason,omitempty"`
}
```

- [x] **Step 1: Write telemetry RED tests**

Assert heartbeat JSON reports exact counts/reason under `securityCapabilities.pamReconciliation`, capability stays zero for unresolved/quarantine/enqueue failure, awaiting acknowledgement is visible while capability may be 2, malformed optional server input collapses independently without rejecting the heartbeat, and state transitions emit one structured local log per changed signature rather than every retry.

- [x] **Step 2: Run telemetry tests and verify RED**

```bash
cd agent && go test ./internal/heartbeat -run 'TestPamReconciliationStatus|TestSecurityCapabilitiesControlProtocolJSON' -count=1
pnpm --filter @breeze/api exec vitest run src/routes/agents/schemas.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agents/heartbeat.test.ts
```

Expected: FAIL because the status object is absent.

- [x] **Step 3: Implement tolerant status telemetry**

Populate the optional object from staged, pending, and quarantine snapshots. Choose `blockingReason` from the stable enum `resolver_unavailable`, `binding_unresolved`, `enqueue_failed`, `acknowledgement_unavailable`, `quarantined`, or `outbox_unreadable`, in that priority order. Extend the API heartbeat schema with nonnegative integer counts and a bounded 64-character reason enum; do not add device columns or a migration. Diagnostic logs are shipped by the existing log shipper and include the counts, reason, outbox path, actuation ID, generation, and observation ID but never evidence payload or credentials.

- [x] **Step 4: Write the exact manual reset runbook**

The runbook must require an incident/change reference, server-first version verification, the server actuation already in current desired `cleanup`, independent endpoint proof of zero Job members/no privileged token/disabled non-admin account, captured hashes and archived copies of the ledger plus PAM pending/quarantine directories, an explicit Breeze agent service stop, an atomic move to the incident archive, restart, resolver/heartbeat verification, and attachment of evidence to the incident. It must forbid reset for desired `active`, missing endpoint proof, foreign/customer scope ambiguity, or as a way to bypass a persistent same-command rejection. State that there is no remote administrative reset API and no production/customer execution is performed by this branch.

- [x] **Step 5: Write the server-first promote gate**

Create `docs/runbooks/pam-reconciliation-rollout.md` with this immutable order:

```text
1. Deploy and verify the API resolver plus PAM acknowledgement response.
2. Probe both surfaces using an authorized disposable fixture and record server SHA.
3. Promote the agent candidate only after steps 1-2 pass.
4. Stop promotion if unresolved/quarantined counts rise, acknowledgements disappear,
   the resolver is missing, or any ownership/isolation test fails.
```

State that an older server response, 404 route, or HTTP 200 without a valid acknowledgement is transport failure and intentionally pins PAM capability to zero for devices with ledger evidence. Do not include deployment credentials, hosted addresses, or a claim that this branch performed the rollout.

- [x] **Step 6: Run GREEN**

```bash
cd agent && go test ./internal/heartbeat -run 'TestPamReconciliationStatus|TestSecurityCapabilitiesControlProtocolJSON' -count=1
pnpm --filter @breeze/api exec vitest run src/routes/agents/schemas.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agents/heartbeat.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit telemetry and documentation**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go agent/internal/heartbeat/pam_reconciliation.go agent/internal/heartbeat/pam_reconciliation_test.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/schemas.test.ts apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts apps/api/src/routes/agents/heartbeat.test.ts docs/runbooks/pam-reconciliation-ledger-reset.md docs/runbooks/pam-reconciliation-rollout.md
git commit -m "docs(pam): expose reconciliation recovery state"
```

### Task 6: Run Task 7 Step 3 gates and close only the implemented checkbox

**Files:**
- Modify: `docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md`
- Modify: `docs/superpowers/plans/2026-08-26-s0-track-e-pam-reconciliation-binding.md`

- [x] **Step 1: Run focused API and real-Postgres gates**

```bash
pnpm --filter @breeze/api exec vitest run src/services/pamReconciliationBinding.test.ts src/routes/agents/pamReconciliation.test.ts src/services/commandResultHandlers.test.ts src/routes/agents/commands.test.ts src/routes/agentWs.test.ts src/routes/agents/schemas.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agents/heartbeat.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamReconciliationBinding.integration.test.ts src/__tests__/integration/pamActuationResults.integration.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: all named files execute and pass; typecheck passes.

- [x] **Step 2: Run the full Task 7 agent race gate**

```bash
cd agent && go test -count=1 -race ./internal/agentapp ./internal/pamlifetime ./internal/heartbeat/...
```

Expected: PASS.

- [x] **Step 3: Run the Windows amd64 compile gate**

```bash
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/agentapp -o /tmp/breeze-agentapp.test.exe
```

Expected: compile succeeds. This is not native Windows execution evidence.

- [x] **Step 4: Verify governance and scope**

```bash
git diff --check
bash scripts/check-migration-naming.sh
git status --short
```

Confirm no migration, ledger field, WebSocket supplemental route, Task 8 file, production deployment, hosted mutation, or customer mutation was added. Confirm the pre-existing dispatch wire mismatch and Task 6 `received` transport gap remain explicit non-claims.

- [x] **Step 5: Check only Task 7 Step 3 and commit**

Check the parent plan's Task 7 Step 3 only after every gate above passes. Keep Task 8, entitlement disposition, native Windows evidence, deployment, hosted reachability, and rollout boxes unchecked.

```bash
git add docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md docs/superpowers/plans/2026-08-26-s0-track-e-pam-reconciliation-binding.md
git commit -m "docs(pam): record reconciliation transport gates"
```

## Completion Non-Claims

- This plan does not fix or validate the pre-existing worker/agent PAM command wire mismatch.
- It does not provide the internally ordered Task 6 `received` observation with an independent production transport.
- It does not provide native signed-Windows execution, physical enforcement, deployment, hosted reachability, canary, customer-device, or rollout evidence.
- It does not close entitlement-removal ownership or start Task 8.
