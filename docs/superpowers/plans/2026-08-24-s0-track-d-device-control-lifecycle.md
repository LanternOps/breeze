---
tracking_issue: 4060
---

# S0 Track D Device Control Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the code gaps in RMM-QA-333 and RMM-QA-225 with deterministic, versioned peripheral-policy enforcement and a separately authorized, signed, restart-safe production rollback protocol.

**Architecture:** Resolve peripheral policy on the server into a per-device content-addressed desired state, clear legacy enforcement before v2 admission, and reconcile every direct policy/membership mutation through a device-keyed queue. Keep rollback separate from ordinary upgrades: authorize an exact stable N-to-N-1 transition with an operation/resource-bound single-use MFA grant, sign a directive plus release artifacts, execute it through a durable agent state machine, and ingest restart-safe phase observations until terminal acknowledgement.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL with FORCE RLS, BullMQ/Redis, Vitest, Go, Ed25519, atomic filesystem state, platform-specific updater primitives, cross-language golden fixtures.

## Finding map

| Finding | Verified current seam | Contract this plan closes |
|---|---|---|
| RMM-QA-333 | `apps/api/src/jobs/peripheralJobs.ts` sends the same ordered policy list to every device; `agent/internal/peripheral/evaluate.go` selects first class match without evaluating server target identity. | Each v2-capable device receives one deterministic effective set bound to identity/revision/digest, after an acknowledged legacy clear; every policy, site, org, group, and direct AI mutation invalidates exactly the affected devices. |
| RMM-QA-225 | Ordinary heartbeat upgrade paths reject downgrades; `dev_update` has no production trust chain; `updater.Rollback()` restores a local backup but is not an authorized fleet protocol. | Only Partner Admin and Org Admin can create a signed, exact-platform/architecture/edition stable N-to-N-1 directive with fresh resource-bound MFA; capable agents verify, execute, recover, and report every durable phase without weakening normal upgrade guards. |

## Global constraints and resolved controller decisions

- Preserve ordinary upgrade downgrade guards, `upgradeTo`, helper/watchdog upgrade fields, update pins, `dev_update`, and the existing local-backup `updater.Rollback()` behavior. Rollback uses only the new `agent_rollback_v1` command.
- `all_usb` is a fallback candidate only for `storage` and the generic `all_usb` enforcement class. It never umbrellas Bluetooth or Thunderbolt. Exact `storage` beats `all_usb`; Bluetooth and Thunderbolt have no umbrella candidate.
- Rollback v1 manages the main agent plus installed companions the agent already owns and can version/manage atomically: `helper`, Windows `user-helper`, `watchdog`, and `backup`. It excludes `viewer`. A required installed companion without an exact signed target artifact fails closed.
- N-to-N-1 means the greatest verified registered **stable** main-agent version strictly lower than the live version for the exact platform, architecture, and server edition. It never means subtracting a patch, GitHub chronology, a prerelease, or any arbitrary lower semver.
- Extend the existing single-use `mfaStepUpGrant` resource-bound primitive and `/auth/mfa/step-up`; do not create a second factor verifier and do not treat `requireMfa()` alone as fresh step-up.
- Add `agent_rollback:create`. Partner Admin receives it through `*:*`; Org Admin receives it explicitly. Technicians, site-restricted principals, API keys, service principals, and AI agents do not receive it.
- Peripheral policy remains dual-axis (`org_id XOR partner_id`). Partner policy resolution and partner fan-out run under `withSystemDbAccessContext`; org-scoped agent contexts must not be relied on to see partner rows.
- New tenant tables enable and force RLS in their creation migration and are registered in every applicable org/device cascade and tenant-export contract. Open JSON is `excludedOpen`. Append-only event ledgers use audit-admin retention deletion.
- Agent-result child inserts take `FOR KEY SHARE` on the device and do not update `devices` in the same transaction.
- Protocol capability values are non-sticky and trusted only from recognized integers on the same heartbeat that claims work. Missing, malformed, omitted, zero, or downgraded capability receives no new-protocol command.
- Direct AI writes and both group-router families are first-class mutation paths. Invalidation cannot live only in `services/groupMembership.ts`.
- Every irreversible rollback boundary is preceded by a durable phase write. Phase telemetry survives restart, is resent until acknowledged, and makes mixed-version silent success impossible.
- Reconciliation jobs use device-keyed coalescing and offset/jittered schedules, never epoch-aligned repeat intervals.
- Every behavior change follows strict RED/GREEN. Record named failing assertions before production edits and rerun the same command green.
- Merged code may move each finding only to **code-complete / fixed-unverified**. Real signed-artifact rollback and real Windows/macOS/Linux peripheral enforcement packets are required for verified closure.
- Production migration execution, deployment, hosted canaries, rollback directives, and customer-device mutation are not authorized by this plan.

## Shared protocol contracts

Task 1 adds tolerant heartbeat capability fields:

```ts
export function normalizePeripheralPolicyProtocolVersion(value: unknown): 0 | 2;
export function normalizeRollbackProtocolVersion(value: unknown): 0 | 1;
```

```go
type SecurityCapabilities struct {
	PeripheralPolicyProtocolVersion int `json:"peripheralPolicyProtocolVersion,omitempty"`
	RollbackProtocolVersion         int `json:"rollbackProtocolVersion,omitempty"`
}
```

Tasks 2-6 use this exact peripheral protocol:

```ts
export type PeripheralPolicyClass = 'storage' | 'all_usb' | 'bluetooth' | 'thunderbolt';
export type PeripheralPolicyAction = 'block' | 'read_only' | 'alert' | 'allow';

export type PeripheralPolicyV2 = {
  policyId: string;
  source: 'organization' | 'partner';
  effectiveClass: PeripheralPolicyClass;
  configuredClass: PeripheralPolicyClass;
  action: PeripheralPolicyAction;
  priority: number;
  exceptions: PeripheralExceptionRule[];
};

export type PeripheralPolicyEnvelopeV2 = {
  schemaVersion: 2;
  phase: 'clear_legacy' | 'enforce';
  identity: {
    deviceId: string;
    orgId: string;
    siteId: string;
    groupIds: string[];
  };
  revision: number;
  digest: string;
  generatedAt: string;
  reason: string;
  effectivePolicies: PeripheralPolicyV2[];
};

export type PeripheralPolicyResultV2 = {
  schemaVersion: 2;
  phase: 'clear_legacy' | 'enforce';
  revision: number;
  digest: string;
  outcome: 'applied' | 'rejected';
  reasonCode?:
    | 'wrong_identity'
    | 'lower_revision'
    | 'revision_digest_conflict'
    | 'malformed_digest'
    | 'invalid_payload'
    | 'detection_failed'
    | 'enforcement_failed'
    | 'persistence_failed';
};

export interface PeripheralDeviceIdentity {
  deviceId: string;
  orgId: string;
  partnerId: string;
  siteId: string;
  groupIds: string[];
}

export function policyTargetsDevice(policy: PeripheralPolicyCandidate, identity: PeripheralDeviceIdentity): boolean;
export function comparePeripheralCandidates(a: PeripheralPolicyCandidate, b: PeripheralPolicyCandidate): number;
export function resolveEffectivePeripheralPolicySet(input: {
  identity: PeripheralDeviceIdentity;
  policies: readonly PeripheralPolicyCandidate[];
}): PeripheralPolicyV2[];
export function canonicalPeripheralEnvelopeBytes(envelope: Omit<PeripheralPolicyEnvelopeV2, 'digest' | 'generatedAt' | 'reason'>): Uint8Array;
export function digestPeripheralEnvelope(envelope: Omit<PeripheralPolicyEnvelopeV2, 'digest' | 'generatedAt' | 'reason'>): `sha256:${string}`;
export async function reconcilePeripheralPolicyDevice(deviceId: string, reason: PeripheralReconcileReason): Promise<'coalesced' | 'queued' | 'incompatible'>;
export async function schedulePeripheralPolicyDevice(deviceId: string, reason: PeripheralReconcileReason): Promise<void>;
```

Canonical peripheral digest bytes are UTF-8 JSON of `{schemaVersion,phase,identity,revision,effectivePolicies}` using a dedicated recursive key sorter and no whitespace. `generatedAt`, `reason`, and `digest` are excluded. UUID/group arrays are ascending. TypeScript and Go consume the same golden values.

Peripheral resolution order is exact: target rank `device`, `group`, `site`, `organization`; owner rank `organization`, `partner`; exact class before `all_usb` fallback; priority ascending in `0..1000`; action rank `block`, `read_only`, `alert`, `allow`; policy UUID ascending. Retain one winner per effective class and sort output by effective class then policy UUID.

Tasks 8-14 use this rollback protocol:

```ts
export type RollbackComponent = 'agent' | 'helper' | 'user-helper' | 'watchdog' | 'backup';

export type RollbackArtifactV1 = {
  component: RollbackComponent;
  currentVersion: string;
  targetVersion: string;
  downloadUrl: string;
  sha256: string;
  size: number;
};

export type AgentRollbackDirectiveV1 = {
  schemaVersion: 1;
  rollbackId: string;
  deviceId: string;
  orgId: string;
  platform: 'windows' | 'macos' | 'linux';
  architecture: 'amd64' | 'arm64';
  currentVersion: string;
  targetVersion: string;
  componentVersions: Record<string, { current: string; target: string }>;
  releaseManifest: string;
  manifestSignature: string;
  manifestSigningKeyId: string;
  artifacts: RollbackArtifactV1[];
  reason: string;
  authorizedBy: string;
  approvedAt: string;
  expiresAt: string;
  directiveSigningKeyId: string;
  directiveSignature: string;
};

export type RollbackPhase =
  | 'received'
  | 'downloaded'
  | 'verified'
  | 'staged'
  | 'swapped'
  | 'restart_requested'
  | 'healthy'
  | 'failed'
  | 'recovered';

export type RollbackObservationV1 = {
  schemaVersion: 1;
  rollbackId: string;
  deviceId: string;
  phase: RollbackPhase;
  observationId: string;
  observedAt: string;
  currentVersion: string;
  componentVersions: Record<string, string>;
  errorCode?: string;
};

export type StepUpOperation = ExistingStepUpOperation | 'agent_rollback';
export interface StepUpGrantBinding {
  operation: StepUpOperation;
  userId: string;
  sessionId: string;
  authEpoch: number;
  resourceDigest: string;
}

export function rollbackResourceDigest(input: {
  deviceId: string;
  currentVersion: string;
  targetVersion: string;
  reason: string;
}): `sha256:${string}`;
export function canonicalRollbackDirectiveBytes(directive: Omit<AgentRollbackDirectiveV1, 'directiveSignature'>): Uint8Array;
export async function resolveImmediateStableRollbackTarget(input: {
  currentVersion: string;
  platform: AgentRollbackDirectiveV1['platform'];
  architecture: AgentRollbackDirectiveV1['architecture'];
  edition: string;
}): Promise<VerifiedRegisteredRelease>;
export async function createAgentRollbackDirective(input: CreateAgentRollbackInput): Promise<AgentRollbackDirectiveV1>;
```

Rollback directive canonical bytes are the LF-separated record below, with no CR/LF allowed in any field: domain `breeze-agent-rollback-directive-v1`; rollback ID; device ID; org ID; platform; architecture; current version; target version; SHA-256 of canonical component versions; SHA-256 of exact release-manifest bytes; manifest signature; manifest key ID; SHA-256 of canonical artifacts; SHA-256 of UTF-8 reason; authorizer ID; second-precision approved time; second-precision expiry; directive key ID. The API signs with the active deployment manifest-signing key; the agent verifies that named pinned key, then separately verifies the release manifest and every artifact.

---

### Task 1: Persist tolerant non-sticky protocol capabilities

**Findings:** RMM-QA-333 and RMM-QA-225 foundation.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`
- Modify: `apps/api/src/db/schema/devices.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Create: `apps/api/migrations/2026-09-10-agent-control-protocol-capabilities.sql`

**Interfaces:** Produces the two normalizers and `SecurityCapabilities` fields from the shared contracts. Tasks 4 and 11 consume only the normalized same-heartbeat values; they do not infer capability from agent version or stale device columns.

- [x] **Step 1: Write capability RED tests**

Add table-driven Go JSON cases for exact `peripheralPolicyProtocolVersion:2` and `rollbackProtocolVersion:1`, omission, and zero. Add API cases proving recognized integers persist, malformed/string/fractional/unknown integers normalize to zero without rejecting the heartbeat, omitted capability writes both columns to zero, and prior nonzero values are cleared by omission or downgrade.

- [x] **Step 2: Run RED and retain the failing assertions**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts
cd agent && go test -race ./internal/heartbeat
```

Expected: FAIL because the payload, schema, device columns, normalizers, and unconditional persistence do not yet exist.

- [x] **Step 3: Implement the minimal tolerant path**

Add the Go fields, optional tolerant Zod fields, pure normalizers, Drizzle columns, and unconditional heartbeat update. Parsing failure drops only the malformed optional capability; the heartbeat remains accepted. Do not admit either new command type in this task.

- [x] **Step 4: Run GREEN and static checks**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
cd agent && go test -race ./internal/heartbeat
```

- [x] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/db/schema/devices.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/migrations/2026-09-10-agent-control-protocol-capabilities.sql
git commit -m "fix(protocol): persist explicit device capabilities"
```

### Task 2: Add peripheral v2 schema and governance contracts

**Finding:** RMM-QA-333.

**Files:**
- Create: `apps/api/migrations/2026-08-24-peripheral-effective-policy-v2.sql`
- Modify: `apps/api/src/db/schema/peripheralControl.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/tenantCascade.test.ts`
- Modify: `apps/api/src/db/seed.test.ts`
- Create: `apps/api/src/__tests__/integration/peripheralPolicyV2Rls.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/peripheralPoliciesPartnerRls.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`

**Interfaces:** Adds `priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000)`, `peripheral_policy_device_states`, and append-only `peripheral_policy_delivery_events`. Task 4 owns their state transitions; Tasks 3 and 5 only call its service.

- [x] **Step 1: Write schema/governance RED tests**

Require `priority`, both new tables, org isolation with ENABLE/FORCE RLS, device/org cascade coverage, JSON evidence classified `excludedOpen`, and UPDATE/DELETE denial to `breeze_app` on delivery events while audit-admin plus retention GUC can delete. Assert device-state uniqueness by device and event uniqueness for idempotent result ingestion.

- [x] **Step 2: Run RED with real PostgreSQL**

```bash
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/peripheralPolicyV2Rls.integration.test.ts \
  src/__tests__/integration/peripheralPoliciesPartnerRls.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```

Expected: FAIL on missing columns/tables/policies/registrations.

- [x] **Step 3: Implement the additive migration and registries**

Create idempotent tables/indexes/FKs/checks/RLS/policies/append-only trigger and privileges. Register both tables in every applicable org cascade, device cascade, denormalized-org, and export policy list in correct FK order. Delivery event JSON is `excludedOpen`; the mutable desired envelope JSON is also `excludedOpen`.

- [x] **Step 4: Run GREEN, drift, and migration checks**

```bash
bash scripts/check-migration-naming.sh
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts src/services/tenantCascade.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/peripheralPolicyV2Rls.integration.test.ts \
  src/__tests__/integration/peripheralPoliciesPartnerRls.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```

- [x] **Step 5: Commit**

Stage only the migration, schema, registry, and named test changes and commit:

```bash
git commit -m "fix(db): persist peripheral policy delivery truth"
```

### Task 3: Resolve deterministic per-device peripheral policy and digest

**Finding:** RMM-QA-333.

**Files:**
- Create: `apps/api/src/services/peripheralEffectivePolicy.ts`
- Create: `apps/api/src/services/peripheralEffectivePolicy.test.ts`
- Create: `apps/api/src/services/peripheralEffectivePolicy.integration.test.ts`
- Create: `apps/api/src/testFixtures/peripheral-policy-v2-canonical.json`
- Modify: `apps/api/src/routes/peripheralControl.ts`
- Modify: `apps/api/src/routes/peripheralControl.test.ts`
- Modify: `apps/api/src/services/aiToolsPeripherals.ts`
- Modify: `apps/api/src/services/aiToolsPeripherals.siteScope.test.ts`

**Interfaces:** Produces `policyTargetsDevice`, `comparePeripheralCandidates`, `resolveEffectivePeripheralPolicySet`, `canonicalPeripheralEnvelopeBytes`, and `digestPeripheralEnvelope` exactly as declared above. Task 4 consumes them without reimplementing precedence.

- [x] **Step 1: Write resolver and API RED tests**

Use table cases for every precedence axis, creation/update order independence, partner versus org, overlapping groups, site/device targets, exact `storage` versus `all_usb`, proof that `all_usb` does not cover Bluetooth/Thunderbolt, priority/action/UUID ties, empty set, two-org isolation, and the golden digest. Route and direct AI validators reject priority outside safe integer `0..1000` and return priority on reads.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/peripheralEffectivePolicy.test.ts \
  src/routes/peripheralControl.test.ts \
  src/services/aiToolsPeripherals.siteScope.test.ts
```

- [x] **Step 3: Implement pure resolution plus system-context loading**

Load device/org/site/current UUID-sorted memberships and both ownership axes under a short system context. Apply the frozen target/owner/class/priority/action/UUID ordering. Use one recursive key sorter and no generic object spread for canonical bytes.

- [x] **Step 4: Run GREEN and real-Postgres integration**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/peripheralEffectivePolicy.test.ts \
  src/routes/peripheralControl.test.ts \
  src/services/aiToolsPeripherals.siteScope.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/services/peripheralEffectivePolicy.integration.test.ts
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/peripheralEffectivePolicy.ts apps/api/src/services/peripheralEffectivePolicy.test.ts apps/api/src/services/peripheralEffectivePolicy.integration.test.ts apps/api/src/testFixtures/peripheral-policy-v2-canonical.json apps/api/src/routes/peripheralControl.ts apps/api/src/routes/peripheralControl.test.ts apps/api/src/services/aiToolsPeripherals.ts apps/api/src/services/aiToolsPeripherals.siteScope.test.ts
git commit -m "fix(api): resolve effective peripheral policy"
```

### Task 4: Persist desired peripheral state and the legacy-clear handshake

**Finding:** RMM-QA-333.

**Files:**
- Create: `apps/api/src/services/peripheralPolicyState.ts`
- Create: `apps/api/src/services/peripheralPolicyState.test.ts`
- Create: `apps/api/src/services/peripheralPolicyState.integration.test.ts`
- Modify: `apps/api/src/services/commandQueue.ts`
- Modify: `apps/api/src/services/commandTimeouts.ts`
- Modify: `apps/api/src/services/commandResultHandlers.ts`
- Modify: `apps/api/src/services/commandResultHandlers.test.ts`
- Modify: `apps/api/src/services/commandDispatch.ts`
- Modify: `apps/api/src/services/commandDispatch.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`

**Interfaces:** Produces `reconcilePeripheralPolicyDevice()` and a shared `handlePeripheralPolicyResultV2(deviceId, commandId, result)` used by both HTTP and WebSocket result transports. Adds command type `PERIPHERAL_POLICY_SYNC_V2`. Task 5 schedules reconciliation; Task 6 implements the agent result contract.

- [x] **Step 1: Write state-machine RED tests**

Prove concurrent revision allocation is monotonic; equal digest coalesces; first v2 admission is an empty `clear_legacy`; no `enforce` command emits before exact applied clear revision/digest; empty desired set converges after clear; wrong device/revision/digest cannot change projection; applied/rejected evidence is append-only; HTTP and WebSocket paths call the same handler; stored-capable but same-heartbeat downgraded devices cannot claim v2 work.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/peripheralPolicyState.test.ts \
  src/services/commandResultHandlers.test.ts \
  src/services/commandDispatch.test.ts
```

- [x] **Step 3: Implement row-locked transitions and claim filtering**

In one short transaction, lock/allocate the per-device revision, coalesce identical desired digest, persist envelope/status, insert requested evidence, and create the command. Result insertion takes a device `FOR KEY SHARE` lock and never updates `devices` in the same transaction. An exact applied clear schedules the next enforce revision only after commit. Incompatible queued v2 commands are released/cancelled without delivery.

- [x] **Step 4: Run GREEN and transaction integration**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/peripheralPolicyState.test.ts \
  src/services/commandResultHandlers.test.ts \
  src/services/commandDispatch.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/services/peripheralPolicyState.integration.test.ts
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/peripheralPolicyState.ts apps/api/src/services/peripheralPolicyState.test.ts apps/api/src/services/peripheralPolicyState.integration.test.ts apps/api/src/services/commandQueue.ts apps/api/src/services/commandTimeouts.ts apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.test.ts apps/api/src/services/commandDispatch.ts apps/api/src/services/commandDispatch.test.ts apps/api/src/routes/agents/heartbeat.ts
git commit -m "fix(api): version peripheral policy delivery"
```

### Task 5: Invalidate every peripheral policy and membership mutation path

**Finding:** RMM-QA-333.

**Files:**
- Refactor: `apps/api/src/jobs/peripheralJobs.ts`
- Modify: `apps/api/src/jobs/peripheralJobs.test.ts`
- Modify: `apps/api/src/jobs/peripheralJobs.distribution.test.ts`
- Create: `apps/api/src/jobs/peripheralPolicyReconciliation.test.ts`
- Modify: `apps/api/src/routes/peripheralControl.ts`
- Modify: `apps/api/src/services/aiToolsPeripherals.ts`
- Modify: `apps/api/src/services/aiToolsPolicyPrereqs.ts`
- Modify: `apps/api/src/services/groupMembership.ts`
- Modify: `apps/api/src/routes/groups.ts`
- Modify: `apps/api/src/routes/devices/groups.ts`
- Modify: `apps/api/src/services/aiToolsFleet.ts`
- Modify: `apps/api/src/routes/groups.test.ts`
- Modify: `apps/api/src/routes/groups_preview_pin.test.ts`
- Modify: `apps/api/src/routes/groups_update_delete.test.ts`
- Modify: `apps/api/src/routes/devices/groups.test.ts`
- Modify: `apps/api/src/services/groupMembership.manualMembership.test.ts`
- Modify: `apps/api/src/services/groupMembership.materialization.test.ts`
- Modify: `apps/api/src/services/aiToolsFleet.test.ts`
- Modify: `apps/api/src/services/aiToolsPeripherals.siteScope.test.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/routes/devices/moveOrg.ts`
- Modify: existing device site/move tests.

**Interfaces:** Produces `schedulePeripheralPolicyDevice(deviceId, reason)` with one stable BullMQ job ID per device. Every direct policy, AI, group-router, dynamic membership, pin/unpin, site-move, and org-move path calls it after commit. No caller enqueues org-wide raw policy lists.

- [x] **Step 1: Write mutation-path coverage RED tests**

Require create/update/disable/hard-delete policy changes to enqueue old-union-new device IDs. Require manual group add/remove, pin/unpin, dynamic evaluation, group deletion in both routers, direct AI fleet membership writes, direct AI peripheral policy writes, same-org site move, and org move to enqueue exactly affected devices. Require partner policy fan-out across all non-Quick-Support orgs for that partner, zero unrelated state/queue writes, and stable device-keyed coalescing.

- [x] **Step 2: Run RED and retain the uncovered direct-path list**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/peripheralJobs.test.ts \
  src/jobs/peripheralJobs.distribution.test.ts \
  src/jobs/peripheralPolicyReconciliation.test.ts \
  src/routes/peripheralControl.test.ts \
  src/routes/groups.test.ts \
  src/routes/devices/groups.test.ts \
  src/services/groupMembership.manualMembership.test.ts \
  src/services/groupMembership.materialization.test.ts \
  src/services/aiToolsPeripherals.siteScope.test.ts \
  src/services/aiToolsFleet.test.ts
```

- [x] **Step 3: Replace org distribution with device reconciliation**

Capture old policy/membership device IDs before each write and current IDs after it; enqueue the union after commit. Centralize helpers while preserving explicit calls in both group routers and direct AI mutation paths that delete/write membership rows without `services/groupMembership.ts`. Reconciliation keyset-pages devices under short system contexts and schedules drift only, with jitter/offset.

- [ ] **Step 4: Run GREEN, partner integration, and performance evidence**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/peripheral*.test.ts src/routes/peripheralControl.test.ts src/routes/groups.test.ts src/routes/groups_preview_pin.test.ts src/routes/groups_update_delete.test.ts src/routes/devices/groups.test.ts src/services/groupMembership.manualMembership.test.ts src/services/groupMembership.materialization.test.ts src/services/aiToolsPeripherals.siteScope.test.ts src/services/aiToolsFleet.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/peripheralEffectivePolicy.integration.test.ts src/services/peripheralPolicyState.integration.test.ts
```

Run the approved local 10,000-device resolver/distribution benchmark and record latency, queue depth, DB pool headroom, early/middle/final devices, and zero unrelated writes. This is performance evidence only and authorizes no rollout.

- [x] **Step 5: Commit**

Stage only the named job/route/service/test changes and commit:

```bash
git commit -m "fix(api): reconcile peripheral policy per device"
```

### Task 6: Enforce peripheral v2 atomically on the agent

**Finding:** RMM-QA-333.

**Files:**
- Modify: `agent/internal/remote/tools/types.go`
- Modify: `agent/internal/heartbeat/handlers.go`
- Modify: `agent/internal/heartbeat/handlers_test.go`
- Create: `agent/internal/heartbeat/handlers_peripheral_v2.go`
- Create: `agent/internal/heartbeat/handlers_peripheral_v2_test.go`
- Modify: `agent/internal/peripheral/types.go`
- Create: `agent/internal/peripheral/v2.go`
- Create: `agent/internal/peripheral/v2_test.go`
- Modify: `agent/internal/peripheral/store.go`
- Modify: `agent/internal/peripheral/store_test.go`
- Create: `agent/internal/peripheral/testdata/peripheral-policy-v2-canonical.json`

**Interfaces:** Consumes `PeripheralPolicyEnvelopeV2`/`PeripheralPolicyResultV2` exactly and persists `peripheral_policy_v2_state.json` atomically with device/org/site, phase, revision, digest, and effective set. The handler does not call legacy `peripheral.Evaluate()`.

- [x] **Step 1: Write strict agent RED tests**

Test wrong device/org/site, malformed digest, lower revision, same-revision/different-digest, invalid policy, corrupted local state, concurrent duplicate commands, and restart. All fail before enforcement. Same revision/digest is idempotent applied; empty enforce clears; `clear_legacy` clears and verifies legacy enforcement plus legacy store before ack; detection/enforcement/save failure rejects and preserves last-known-good state. The Go golden digest equals TypeScript.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -race ./internal/peripheral ./internal/heartbeat
```

- [x] **Step 3: Implement strict validation, enforcement, and atomic persistence**

Compare envelope identity to `config.DeviceID`, `config.OrgID`, and `config.SiteID`; group IDs remain digest-bound server identity. Verify canonical digest before detection/actuation. Plan deterministic effective actions, verify enforcement, then atomically persist; never overwrite known-good disk state after a failed apply.

- [x] **Step 4: Run GREEN and platform unit tests**

```bash
cd agent && go test -race ./internal/peripheral ./internal/heartbeat
```

Run every platform-specific peripheral detector/enforcer unit package selected by the current build tags and record skipped hardware cases explicitly.

- [x] **Step 5: Commit**

```bash
git add agent/internal/remote/tools agent/internal/heartbeat agent/internal/peripheral
git commit -m "fix(agent): enforce versioned peripheral policy"
```

### Task 7: Produce the RMM-QA-333 exact-candidate packet

**Finding:** RMM-QA-333 evidence gate only.

**Candidate-only files in `/Users/toddhebebrand/breeze-rmm-qa`:**
- Create an ignored/local runner or tracked QA harness only when the controller authorizes a QA-repository change.
- Generate: `docs/qa/evidence/<UTC-date>-rmm-qa-333-<12-char-candidate-SHA>.md` after an exact-candidate run.
- Do not edit the authoritative QA ledger from the product implementation branch.

- [ ] **Step 1: Freeze the exact candidate and automated evidence manifest**

Require a clean product worktree, full candidate SHA, signed agent artifact digest, migration digest, TypeScript/Go golden fixture hashes, test commands, and CI shard log lines proving every guarded integration suite executed.

- [ ] **Step 2: Rehearse server truth with disposable data**

Use real PostgreSQL with two partners, two orgs, two sites, overlapping groups, four simulated v2 agents, one old-agent omission, legacy-clear handshake, policy/membership mutations, offline catch-up, entitlement disable, duplicate/reordered results, zero-side-effect foreign IDs, and 10,000-device performance measurements.

- [ ] **Step 3: Rehearse real peripheral clear/apply on supported hardware**

On signed candidate builds for Windows, macOS, and Linux, record actual storage, generic USB, Bluetooth, and Thunderbolt detection/enforcement where supported; exact-class/umbrella behavior; legacy clear; empty-set clear; restart persistence; failure recovery; and proof that unsupported enforcement reports rejection rather than success.

- [ ] **Step 4: Record candidate-only canary prerequisites without executing them**

Document the separately authorized 5/25/100 hosted canary gates, pause signals, and rollback criteria. Do not deploy, enroll, or mutate hosted/customer devices.

- [ ] **Step 5: Set the verdict honestly**

Until every real-system packet passes against the exact shipping artifact, record RMM-QA-333 as **code-complete / fixed-unverified**. A cross-build or unit test alone is not runtime enforcement evidence.

### Task 8: Add rollback permission and resource-bound fresh MFA

**Finding:** RMM-QA-225.

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts`
- Modify: `packages/shared/src/constants/permissions.test.ts`
- Modify: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/db/seed.test.ts`
- Create: `apps/api/migrations/2026-08-24-agent-rollback-protocol.sql`
- Modify: `apps/api/src/routes/permissionsCatalog.ts`
- Modify: `apps/api/src/routes/permissionsCatalog.test.ts`
- Modify: `apps/api/src/services/mfaStepUpGrant.ts`
- Modify: `apps/api/src/services/mfaStepUpGrant.test.ts`
- Modify: `apps/api/src/services/mfaStepUpGrant.integration.test.ts`
- Modify: `apps/api/src/routes/auth/schemas.ts`
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Modify: `apps/api/src/routes/auth.test.ts`

**Interfaces:** Adds `agent_rollback:create`, `StepUpOperation = ... | 'agent_rollback'`, `resourceDigest` to the single-use grant binding, and `rollbackResourceDigest()` over canonical `{deviceId,currentVersion,targetVersion,reason}`. Task 10 consumes the grant only after validation and immediately before transactional write.

- [x] **Step 1: Write permission/grant RED tests**

Assert Partner Admin wildcard and explicit Org Admin grant only. Deny technician, site-restricted actor, API key, service principal, and AI actor. Test wrong operation/resource/session/auth epoch, expiry, replay, parallel double-consume, and Redis error fail closed. `/auth/mfa/step-up` defaults existing clients to `add_factor` and mints `agent_rollback` only after proof of an existing factor.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/shared exec vitest run src/constants/permissions.test.ts
pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts src/services/mfaStepUpGrant.test.ts src/routes/auth.test.ts
```

- [x] **Step 3: Extend the existing grant and registries**

Add the permission to constants/catalog/seed/migration, grant it explicitly only to Org Admin, and preserve Partner Admin wildcard. Bind grant HMAC/storage/validation/consume to the resource digest. Do not add any alternate MFA verifier in the rollback route.

- [x] **Step 4: Run GREEN and Redis integration**

```bash
pnpm --filter @breeze/shared exec vitest run src/constants/permissions.test.ts
pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts src/services/mfaStepUpGrant.test.ts src/routes/auth.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/mfaStepUpGrant.integration.test.ts
```

- [x] **Step 5: Commit**

Stage only the named permission, MFA, migration, and tests and commit:

```bash
git commit -m "fix(authz): authorize signed agent rollback"
```

### Task 9: Add rollback projection, append-only phase ledger, and governance

**Finding:** RMM-QA-225.

**Files:**
- Create: `apps/api/src/db/schema/agentRollback.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Complete: `apps/api/migrations/2026-08-24-agent-rollback-protocol.sql`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/tenantCascade.test.ts`
- Create: `apps/api/src/__tests__/integration/agentRollbackRls.integration.test.ts`
- Modify established export/cascade/append-only integration suites.

**Interfaces:** Adds mutable `agent_rollback_directives` and append-only `agent_rollback_events`. Directive rows store tenant/device identity, bound versions/components, exact manifest/signatures/artifacts, reason/authorizer/times, command ID, status, latest phase/error. Events store immutable phase observations and idempotency identity.

- [x] **Step 1: Write governance RED tests**

Require cross-org reads/writes to fail, device/org deletion to clean both tables, application role mutation/deletion of events to fail, audit admin plus retention GUC to delete, and every JSON column to be `excludedOpen`. Assert one active rollback per device and event idempotency constraints.

- [x] **Step 2: Run RED with real PostgreSQL**

```bash
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/agentRollbackRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```

- [x] **Step 3: Implement additive schema and registrations**

Use idempotent DDL, explicit FKs/indexes/checks, ENABLE/FORCE RLS, append-only triggers/privileges, correct cascade ordering, and export policy classification. No production migration execution occurs here.

- [x] **Step 4: Run GREEN and migration drift checks**

```bash
bash scripts/check-migration-naming.sh
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts src/services/tenantCascade.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/agentRollbackRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/agentRollback.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-08-24-agent-rollback-protocol.sql apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantCascade.test.ts apps/api/src/__tests__/integration
git commit -m "fix(db): persist agent rollback lifecycle"
```

### Task 10: Sign only verified exact stable N-to-N-1 directives

**Finding:** RMM-QA-225.

**Files:**
- Create: `apps/api/src/services/agentRollback.ts`
- Create: `apps/api/src/services/agentRollback.test.ts`
- Create: `apps/api/src/services/agentRollback.integration.test.ts`
- Create: `apps/api/src/services/rollbackDirectiveSigning.ts`
- Create: `apps/api/src/services/rollbackDirectiveSigning.test.ts`
- Create: `apps/api/src/testFixtures/agent-rollback-directive-v1.json`
- Modify: `apps/api/src/services/manifestSigning.ts` only to expose `signBytesWithActiveKey(bytes): Promise<{ keyId: string; signature: string }>` if required
- Modify: `apps/api/src/routes/agentVersions.ts` only to extract/reuse trusted registered-release lookup; do not weaken public download checks
- Modify: `apps/api/src/services/commandQueue.ts`
- Modify: `apps/api/src/services/commandTimeouts.ts`

**Interfaces:** Produces the rollback signing, predecessor resolution, component builder, resource digest, and atomic creation functions declared above. Component set is agent plus installed owned companions; viewer is impossible in v1.

- [x] **Step 1: Write resolver/signing/atomicity RED tests**

Reject arbitrary older, equal, newer, prerelease, ambiguous current, platform/arch/edition mismatch, unsigned/missing manifest, unknown signing key, missing installed companion artifact, stale live version, absent capability, wrong step-up bind, and concurrent duplicate creation with zero directive/event/command rows. Golden signature verifies; every one-field tamper fails. Success writes directive, requested event, and `agent_rollback_v1` command atomically.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/rollbackDirectiveSigning.test.ts \
  src/services/agentRollback.test.ts
```

- [x] **Step 3: Implement fail-closed target resolution and creation**

Resolve the greatest lower verified registered stable release for exact platform/architecture/edition. Re-read and lock the device, capability, live version, and installed companion versions inside the transaction. Complete all target/signature checks first, consume the exact resource-bound grant immediately before write, then insert projection/event/command under the unique active-device constraint.

- [x] **Step 4: Run GREEN and real-Postgres concurrency tests**

```bash
pnpm --filter @breeze/api exec vitest run src/services/rollbackDirectiveSigning.test.ts src/services/agentRollback.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/agentRollback.integration.test.ts
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/agentRollback.ts apps/api/src/services/agentRollback.test.ts apps/api/src/services/agentRollback.integration.test.ts apps/api/src/services/rollbackDirectiveSigning.ts apps/api/src/services/rollbackDirectiveSigning.test.ts apps/api/src/testFixtures/agent-rollback-directive-v1.json apps/api/src/services/manifestSigning.ts apps/api/src/routes/agentVersions.ts apps/api/src/services/commandQueue.ts apps/api/src/services/commandTimeouts.ts
git commit -m "fix(api): sign exact agent rollback directives"
```

### Task 11: Mount the authorized rollback route and same-heartbeat gate

**Finding:** RMM-QA-225.

**Files:**
- Create: `apps/api/src/routes/agentRollback.ts`
- Create: `apps/api/src/routes/agentRollback.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts`
- Add/modify: mounted route-order test if `/:id` can collide
- Modify: `apps/api/src/services/commandDispatch.ts`
- Modify: `apps/api/src/services/commandDispatch.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`

**Interfaces:** Adds `POST /devices/:id/agent-rollback` with body `{targetVersion, reason, stepUpGrant}`. It requires `agent_rollback:create`, `requireMfa()`, tenant/device scope, and the exact single-use resource-bound grant. It calls Task 10's atomic service rather than assembling directives in the route.

- [x] **Step 1: Write actor and claim RED tests**

Prove Org Admin and Partner Admin succeed only in scope with permission, MFA claim, and fresh grant. Prove site-restricted technician, API key, service principal, AI agent, foreign tenant, missing MFA, stale grant, and wrong resource fail with zero directive/event/command writes. An omitted/zero/old capability receives no rollback; a device stored capable but reporting zero on this heartbeat receives no rollback.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agentRollback.test.ts src/services/commandDispatch.test.ts src/routes/agents/heartbeat.test.ts
```

- [x] **Step 3: Implement explicit auth order and current-heartbeat filtering**

Mount the literal nested route before conflicting parameter routes. Authenticate, resolve known device in tenant scope, authorize permission/site constraints, require MFA, validate request/target/resource binding, then call the atomic service. Claim filtering uses the normalized value from the current payload and never version inference.

- [x] **Step 4: Run GREEN and mount regression**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agentRollback.test.ts src/services/commandDispatch.test.ts src/routes/agents/heartbeat.test.ts src/routes/devices/index.test.ts
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/agentRollback.ts apps/api/src/routes/agentRollback.test.ts apps/api/src/routes/devices/index.ts apps/api/src/services/commandDispatch.ts apps/api/src/services/commandDispatch.test.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "fix(api): gate rollback on fresh device authority"
```

### Task 12: Build directive-bound verified updater primitives

**Finding:** RMM-QA-225.

**Files:**
- Modify: `agent/internal/updater/types.go`
- Modify: `agent/internal/updater/updater.go`
- Modify: `agent/internal/updater/updater_test.go`
- Modify: `agent/internal/updater/restart_windows.go`
- Modify: `agent/internal/updater/restart_unix.go`
- Modify: `agent/internal/updater/backup_swap.go`
- Modify: `agent/internal/updater/restart_windows_test.go`
- Modify: `agent/internal/updater/backup_swap_test.go`
- Modify: `agent/internal/updater/updater_unix_test.go`

**Interfaces:** Produces a narrow injected updater primitive that accepts directive-bound signed metadata, returns verified staged artifacts, atomically/journaledly swaps the complete owned component set, and recovers the prior complete set. It is not an authorization layer and never calls local `Rollback()` as proof of authority.

- [x] **Step 1: Write updater RED tests**

Reject wrong URL origin/policy, redirect abuse, size, checksum, manifest signature/key ID, component/platform/arch/edition/version, and directive/artifact mismatch. Multi-artifact staging failure changes no live binary. Every per-component swap interruption retains a recoverable journal; recovery yields either the complete old or complete target set. Existing normal update, downgrade guard, and local rollback tests stay green.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -race ./internal/updater
```

- [x] **Step 3: Implement narrow verified staging and journaled swap seams**

Reuse pinned-manifest verification and downloader network policy. Stage all artifacts before any live swap. Write/fsync the journal before each rename/swap and preserve enough old-component metadata to roll back a partially crossed boundary deterministically.

- [x] **Step 4: Run GREEN for Unix and Windows build tags**

```bash
cd agent && go test -race ./internal/updater
GOOS=windows GOARCH=amd64 go test -c -o /tmp/breeze-updater-windows.test ./internal/updater
GOOS=linux GOARCH=amd64 go test -c -o /tmp/breeze-updater-linux.test ./internal/updater
GOOS=darwin GOARCH=arm64 go test -c -o /tmp/breeze-updater-darwin.test ./internal/updater
```

Cross-compiles prove build compatibility only, not runtime rollback.

- [x] **Step 5: Commit**

```bash
git add agent/internal/updater
git commit -m "fix(agent): stage verified rollback artifacts"
```

### Task 13: Execute rollback through a durable restart-safe agent state machine

**Finding:** RMM-QA-225.

**Files:**
- Create: `agent/internal/rollback/types.go`
- Create: `agent/internal/rollback/canonical.go`
- Create: `agent/internal/rollback/store.go`
- Create: `agent/internal/rollback/executor.go`
- Create: `agent/internal/rollback/*_test.go`
- Create: `agent/internal/rollback/testdata/agent-rollback-directive-v1.json`
- Modify: agent command constants in `agent/internal/remote/tools`
- Create: `agent/internal/heartbeat/handlers_rollback.go`
- Create: `agent/internal/heartbeat/handlers_rollback_test.go`
- Modify: `agent/internal/heartbeat/handlers.go`
- Modify: `agent/internal/heartbeat/handlers_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`

**Interfaces:** Owns atomic rollback state and injected executor. Persists `received`, `downloaded`, `verified`, `staged`, `swapped`, `restart_requested`, `healthy`, `failed`, and `recovered`; persists before the next irreversible boundary; retains terminal replay tombstones; emits the latest `RollbackObservationV1` on every heartbeat until acknowledged.

- [x] **Step 1: Write strict validation/restart RED tests**

Table/property tests cover malformed, expired, replayed, wrong device/org/platform/arch/current version, unknown key, wrong directive signature, wrong manifest signature/digest, and same rollback ID with changed content; each fails before download/swap. Inject interruption at download, verify, stage, each component swap, restart, and health. Concurrent duplicates are idempotent under `-race`. Startup after swap reports healthy target or recovers the previous complete set, never mixed silent success.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -race ./internal/rollback ./internal/updater ./internal/heartbeat
```

- [x] **Step 3: Implement canonical verification, atomic state, startup reconciliation, and telemetry**

Verify identity/current version/expiry/directive signature/replay before download, then verify manifest and artifacts independently. Start reconciliation before normal update handling. Persist and fsync every phase before crossing its boundary. After restart, emit an immediate durable observation and continue resending it until the server acknowledges that observation ID.

- [x] **Step 4: Run GREEN, race tests, and cross-builds**

```bash
cd agent && go test -race ./internal/rollback ./internal/updater ./internal/heartbeat
GOOS=windows GOARCH=amd64 go build -o /tmp/breeze-agent-windows.exe ./cmd/agent
GOOS=linux GOARCH=amd64 go build -o /tmp/breeze-agent-linux ./cmd/agent
GOOS=darwin GOARCH=arm64 go build -o /tmp/breeze-agent-darwin ./cmd/agent
```

- [x] **Step 5: Commit**

```bash
git add agent/internal/rollback agent/internal/remote/tools agent/internal/heartbeat
git commit -m "fix(agent): execute restart-safe signed rollback"
```

### Task 14: Ingest durable rollback phases and terminal truth

**Finding:** RMM-QA-225.

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Create: `apps/api/src/services/agentRollbackResult.ts`
- Create: `apps/api/src/services/agentRollbackResult.test.ts`
- Create: `apps/api/src/services/agentRollbackResult.integration.test.ts`

**Interfaces:** Tolerantly accepts optional `rollbackObservation`; malformed optional observations are dropped without rejecting ordinary heartbeat. Produces `ingestRollbackObservation(deviceId, observation): Promise<{ acknowledgedObservationId: string | null }>` and returns the acknowledgement in heartbeat response so the agent can stop resending.

- [x] **Step 1: Write ingestion/CAS RED tests**

Prove old-agent omission is accepted; malformed optional observation is dropped; wrong device/rollback, invalid phase order, changed observation content, stale current/component versions, and forged terminal health are rejected durably without advancing projection. Duplicates are idempotent. Only `healthy` accompanied by target-version heartbeat completes. `failed` and `recovered` retain prior events. Simulated server restart between phase observations loses no terminal truth.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/agentRollbackResult.test.ts src/routes/agents/heartbeat.test.ts
```

- [x] **Step 3: Implement child-only ingestion and forward-only projection**

In a short transaction, acquire device `FOR KEY SHARE`, insert the append-only event with unique rollback/phase/observation identity, and compare-and-set the mutable projection forward. Do not update `devices` in this transaction. Derive terminal healthy only from the separately persisted live heartbeat target version and complete owned component set.

- [x] **Step 4: Run GREEN and real-Postgres restart/idempotency tests**

```bash
pnpm --filter @breeze/api exec vitest run src/services/agentRollbackResult.test.ts src/routes/agents/heartbeat.test.ts
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/agentRollbackResult.integration.test.ts
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/services/agentRollbackResult.ts apps/api/src/services/agentRollbackResult.test.ts apps/api/src/services/agentRollbackResult.integration.test.ts
git commit -m "fix(api): persist rollback phase telemetry"
```

### Task 15: Produce the RMM-QA-225 exact-candidate packet

**Finding:** RMM-QA-225 evidence gate only.

**Candidate-only files in `/Users/toddhebebrand/breeze-rmm-qa`:**
- Create an ignored/local runner or tracked QA harness only when the controller authorizes a QA-repository change.
- Generate: `docs/qa/evidence/<UTC-date>-rmm-qa-225-<12-char-candidate-SHA>.md` after an exact-candidate run.
- Do not edit the authoritative QA ledger from the product implementation branch.

- [ ] **Step 1: Freeze and attest the candidate**

Record clean full product SHA, exact signed agent/main-companion artifact digests, manifest bytes/signatures/key IDs, directive golden hashes, migration digest, role/step-up tests, CI shard execution lines, and exact platform/architecture/edition release-registry rows.

- [ ] **Step 2: Rehearse authorization and old-agent safety**

With disposable two-partner/two-org data, execute the complete actor matrix, wrong-resource/session/epoch/replay cases, Redis failure, foreign known IDs, capability omission/downgrade on the claiming heartbeat, concurrency collision, and zero-side-effect assertions.

- [ ] **Step 3: Rehearse signed stable N-to-N-1 on real supported platforms**

For Windows, macOS, and Linux candidate systems, verify exact signed predecessor selection and owned companion set. Interrupt at download, verify, stage, every component swap, restart, and health; prove recovery yields a coherent old set or coherent target set. Verify wrong/expired/replayed/tampered directives never download or swap and ordinary upgrade pins/guards remain unchanged.

- [ ] **Step 4: Verify restart-safe server truth**

Restart agent and API independently between each phase; verify observations resend until acknowledged, insert once, advance only forward, retain failure/recovery history, and complete only from a target-version healthy heartbeat. Record no lost phase and no mixed-version success.

- [ ] **Step 5: Set the verdict honestly**

Until exact signed artifacts pass real service restart/health/interruption tests on every supported platform, record RMM-QA-225 as **code-complete / fixed-unverified**. Do not queue a production directive or run a hosted canary.

### Task 16: Run the Track D completion gate and hand off evidence boundaries

**Findings:** RMM-QA-333 and RMM-QA-225.

**Files:**
- Modify no production file solely for this task.
- Update the implementation ledger/report under the existing ignored `.superpowers/sdd/` workspace.
- Update QA evidence/ledger only in `/Users/toddhebebrand/breeze-rmm-qa` and only with separate controller authorization.

**Dependencies:** Tasks 1-14 must be committed and clean. Tasks 7 and 15 may remain environment-pending; their missing packets explicitly preserve `fixed_unverified` rather than blocking the code completion gate.

- [x] **Step 1: Run focused API and governance verification**

```bash
pnpm --filter @breeze/shared exec vitest run src/constants/permissions.test.ts
pnpm --filter @breeze/api exec vitest run \
  src/routes/agents/heartbeat.test.ts \
  src/routes/peripheralControl.test.ts \
  src/routes/agentRollback.test.ts \
  src/services/peripheralEffectivePolicy.test.ts \
  src/services/peripheralPolicyState.test.ts \
  src/services/rollbackDirectiveSigning.test.ts \
  src/services/agentRollback.test.ts \
  src/services/agentRollbackResult.test.ts \
  src/services/mfaStepUpGrant.test.ts \
  src/services/commandResultHandlers.test.ts \
  src/services/commandDispatch.test.ts
bash scripts/check-migration-naming.sh
```

- [x] **Step 2: Run real-Postgres integration and prove execution**

```bash
set -a; source .env.test; set +a
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/services/peripheralEffectivePolicy.integration.test.ts \
  src/services/peripheralPolicyState.integration.test.ts \
  src/services/mfaStepUpGrant.integration.test.ts \
  src/services/agentRollback.integration.test.ts \
  src/services/agentRollbackResult.integration.test.ts \
  src/__tests__/integration/agentRollbackRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```

Retain the individual suite names and test counts. A green command with a skipped `runIf` suite is not evidence.

- [x] **Step 3: Run agent race and cross-build verification**

```bash
cd agent && go test -race ./internal/peripheral ./internal/rollback ./internal/updater ./internal/heartbeat
GOOS=windows GOARCH=amd64 go build -o /tmp/breeze-agent-windows.exe ./cmd/agent
GOOS=linux GOARCH=amd64 go build -o /tmp/breeze-agent-linux ./cmd/agent
GOOS=darwin GOARCH=arm64 go build -o /tmp/breeze-agent-darwin ./cmd/agent
```

- [x] **Step 4: Run static and broader regression gates**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @breeze/api lint
pnpm --filter @breeze/api test
cd agent && go test -race ./...
git diff --check
```

Record unrelated baseline failures exactly; do not weaken or delete a test to manufacture green.

- [x] **Step 5: Perform the program's one combined review and record verdicts**

The repository authorizes one independent review for the complete multi-track branch, not a Track D per-task review. Feed Track D's exact protocol contracts, migration/tenant isolation, concurrency, authorization, and shipped-agent behavior into that combined review. After targeted fixes/tests, record each finding as `fixed_unverified` until its exact-candidate packet passes. Do not claim deployment, hosted reachability closure, or customer rollout.

## Dependency order

1. Task 1 lands inert capability storage first.
2. Peripheral server schema/resolver (Tasks 2-3) precede desired state (Task 4), which precedes every invalidation path (Task 5). Task 6 consumes the frozen envelope/golden fixture from Task 3 and command/result shape from Task 4. Task 7 is evidence-only.
3. Rollback permission/schema (Tasks 8-9) precede signing/atomic creation (Task 10), which precedes route/claim admission (Task 11).
4. Updater primitives (Task 12) precede the durable rollback state machine (Task 13). Server ingestion (Task 14) consumes the frozen observation contract from Task 13. Task 15 is evidence-only.
5. Task 16 follows all code tasks and participates in the program's single combined whole-branch review. It does not dispatch another reviewer.

Safe parallelism after Task 1 is limited to branches with no shared files: Tasks 2-3, Tasks 8-10, and RED-only agent fixture work may be developed independently, but shared-worktree execution remains sequential. Tasks that touch heartbeat, command dispatch, migrations, schema exports, or the Git index must not run concurrently.

## Completion boundary

The code gate proves deterministic resolution, authorization, durable protocol state, old-agent exclusion, zero-side-effect failures, restart reconciliation, RLS/cascade/export correctness, and build compatibility. It does not prove physical peripheral enforcement or rollback across a real service restart. Those claims require the exact-candidate hardware packets in Tasks 7 and 15, followed by separately authorized rollout stages. This plan stops before deployment.
