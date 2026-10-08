# Heartbeat Statement Cut, Part A (W1a-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the steady-state agent heartbeat (`POST /agents/:id/heartbeat`) from 69 DB statements to 26, and the warm re-beat from 47 to 20, while staying at 3 transactions and leaving every agent-visible response field unchanged.

**Architecture:** Load the device's policy hierarchy (device, org, site, group memberships) once per beat, in one statement, and pass it as an explicit optional parameter to every post-commit policy resolver. Resolvers called without it keep today's exact reads. Skip topology negotiation when materialization is off, using a pure function that returns the same config and receipt. Cache three per-org reads in the existing `HotPathTtlCache`; the cache fills from inside the shared system context and only after that context commits. Batch the three `agent_versions` reads into one. Ratchet the budget suite to the new numbers.

**Tech Stack:** Hono, Drizzle ORM on postgres.js, PostgreSQL with forced RLS, Redis, Vitest (unit and integration configs).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md`, wave W1a (row "W1a — Land #8053..."). Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md` (row W01). Issue: #8053 (this is PR A; W1a-2 is PR B).

## Global Constraints

- Steady-state heartbeat: **≤3 transactions** (spec W1a acceptance "≤3 tx per heartbeat"). This plan must not add a transaction on any beat shape, including single-device orgs whose per-org caches always miss.
- Steady-state target from the program index: **≤30 statements**. This plan lands at 26.
- **#1105:** never hold two pooled connections at once. No new `withSystemDbAccessContext` or `withDbAccessContext` may open while another context is held. The hierarchy read goes inside an existing post-commit system context.
- **Explicit parameters, not AsyncLocalStorage**, for the hierarchy.
- **Resolver parity:** every resolver called *without* a hierarchy issues the same statements in the same order as today. Every resolver called *with* the hierarchy returns the same value it would have computed itself.
- **Hierarchy provenance:** the hierarchy is loaded by `scoped.deviceId`, which is the authenticated agent's own device row (read in the org-scoped context by `agent.deviceId`). It is never shared between devices. A resolver throws `DeviceHierarchyMismatchError` if it gets a hierarchy for a different device.
- **`services/hotPathCache.ts` contract** (read its header first): keys carry the full tenant scope; no secrets; failures never cached; values read-only. This plan adds one exception: a *deferred fill*. It is allowed only for values loaded in a **system-scoped** context, and it is stored only after that context has committed.
- **#3499 lockstep:** the batched `agent_versions` read keeps the five predicates and the `ORDER BY created_at DESC` tiebreak of `resolvePinnedUpgradeTarget`. No caching of `agent_versions` (the offered version must match the bytes served).
- **No schema change, no migration, no new table.** The RLS and cascade registration lists in CLAUDE.md do not apply.
- **Test placement:** unit tests sit next to their source file (`foo.ts` → `foo.test.ts`). Real-Postgres suites live under `apps/api/src/__tests__/integration/` (existing convention for that config).
- **Vitest invocation:** `cd apps/api && npx vitest run <file>` for unit tests. For integration tests use `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>`. Never put `--` before `--run` with `pnpm --filter`. A path filter is a substring match, so check the reported file count.
- **Integration stack:** `pnpm test-stack up` from the worktree root before the first integration run. `pnpm test-stack down` when finished (Task 9 ends with it). Nothing tears it down for you.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A sibling device's hierarchy or policy leaks into another device's beat.** Expected: device A never receives a policy assigned only to device B in the same org, and a resolver given B's hierarchy for A rejects with `DeviceHierarchyMismatchError`. Tests: Task 2 (unit, mismatch guard), Task 3 and Task 4 (each resolver rejects a foreign hierarchy), Task 5 (integration: sibling's device-level helper policy).
2. **The beat itself changes the device's role** (the agent reports a new `deviceRole` and the beat writes it). Expected: role-filtered policies resolve against the *new* role, as they do today, because today's resolvers read after the org transaction commits. Test: Task 5 (integration: org-level event-log policy filtered to `printer`), plus a mutation check.
3. **A deferred cache fill under a narrower RLS scope, or racing an invalidation.** Expected: a value loaded under an org-scoped context is never cached; a value whose load began before an `invalidate()` is never stored. Test: Task 7 (`hotPathCache.test.ts`).
4. **An ephemeral (Quick Support), token-suspended or tokenless device beating with materialization off.** Expected: the identical `producer_unavailable` path (no `networkContext` key, `collection_unavailable` receipt, same log and Sentry capture). Tests: Task 6 (unit parity and real-Postgres parity).
5. **A pinned agent version with no build, several `is_latest` rows, or a row of the other edition.** Expected: the batched read returns exactly what three single reads return. Test: Task 8 (real-Postgres parity matrix).

---

## Verified findings that shape this plan

The brief's estimates were checked against the code at `origin/main` (rebased into this branch). Where the plan departs from the brief, this says why.

| Lever | Brief | Verified | Effect on plan |
|---|---|---|---|
| Hierarchy source | Build from the core device row (`heartbeat.ts:648`) plus the agent-auth context | `AgentAuthContext` carries `partnerId` and `isPreAssignment` only, **not** `organizationType` (`middleware/agentAuth.ts:32-113`; the type is read at `:655` but only `isPreAssignment` is kept). The core row is read **before** this beat's own `UPDATE devices` (`heartbeat.ts:1341`), which can change `deviceRole` (`:1089`). Today the resolvers run after commit and see the new role. The core read also runs in **org** scope, while the resolvers' own reads run in **system** scope. | Load the hierarchy in **one** statement (device, org partner and type, site, group ids as `jsonb_agg`) as the first statement of the existing post-commit OneDrive system context. Same scope and same timing as today's resolver reads; post-update role for free. Net −32 statements (33 reads removed, 1 added). |
| Site timezone | Join `sites` into the core read | The site is a policy-hierarchy fact. The hierarchy statement selects `sites.id, name, timezone` already. | The site rides in the hierarchy. The core read is untouched, so no change for `heartbeat.test.ts`'s select-mock sequence. −1. |
| Per-resolver differences | Partner nulling, execution-safe groups, column sets | `featureConfigResolver.loadDeviceHierarchy` nulls the partner for `unassigned_pool` orgs (`:133`). `monitorResolver` keeps the raw partner for ownership, but drops the partner-level **target** for `quick_support` and `unassigned_pool` (`:226`), and also maps a missing org to `device_missing` (`:204`). `resolvePolicyCheckInterval` does the same (`helpers.ts:~2567`). **No heartbeat resolver applies execution-safe group filtering.** All ten use raw memberships. | `DeviceHierarchy` carries the **raw** facts (`org: {partnerId, type} | null`, raw `groupIds`). Each resolver keeps its own rule inline, fed from the hierarchy instead of its own reads. |
| Per-org caches | `getOrLoad` on three reads | `HotPathTtlCache.getOrLoad` **bypasses the cache inside any DB context** (`hotPathCache.ts:81`). All three reads run inside the shared post-commit system context, so plain `getOrLoad` would never hit. Hoisting them into their own top-level context would add a transaction on every miss, and a single-device org misses every beat (60 s TTL, 60 s beat), which breaks "≤3 tx". | Add `peek` / `ticket` / `fillIfCurrent` to `HotPathTtlCache`, plus a `DeferredCacheFills` collector. It loads in the caller's **system** context and stores after commit. A miss costs exactly what it costs today; a hit costs nothing. |
| `pam_org_config` invalidation | From its write routes | No route writes `uac_interception_enabled`. `PUT /pam/config` (`routes/pam.ts:1659`) writes only `default_unmatched_verdict`, and an insert leaves `uac_interception_enabled` NULL, which resolves to `PAM_DEFAULTS` exactly like "no row". The column is set only by migration `2026-07-01` grandfathering. | No route invalidation is wired: it would be dead code. The 60 s TTL is the only bound. The cache's doc comment names the invalidation call for a future writer. |
| `automation_policies` writers | Write routes | The only production write that changes the probe input is `POST /policies/:id/deactivate` (`routes/policyManagement/actions.ts:78`). No create route exists (no `insert(automationPolicies)` outside tests). `policyEvaluationService.ts:1707` updates only `last_evaluated_at`. | Invalidate from the deactivate route only. |
| Helper Redis check before the savepoint | Saves the empty savepoint | On the **steady** beat the device's Redis entries are dropped, so the helper misses and still needs its savepoint (saves 0). The warm beat saves 1. The probe's savepoint goes away on both beats once the probe is cached. | As specified. Savings: steady −0 (helper) and −1 (probe savepoint); warm −1 and −1. |
| Topology skip | −3 | Confirmed: `savepoint s1`, `savepoint s2`, and the `activeDevice` select (`collectionAuthority.ts:19`). `activeDevice` **throws `producer_unavailable`** for ephemeral, token-suspended or tokenless devices even when materialization is off, and the heartbeat turns that into `collection_unavailable` plus a Sentry capture (`heartbeat.ts:2027-2040`). The `FOR KEY SHARE NOWAIT` lock cannot fail here in practice: the same transaction already holds a stronger row lock from its own `UPDATE devices` when that update matched. | The skip path re-checks the same three predicates against the core row, which already holds them (`select()` returns the full row), and **throws the same error**, so the heartbeat's existing catch produces identical output. When materialization is on, drop the inner savepoint (−1). |
| `agent_versions` | 3 → 1 | Confirmed. All three calls share one guard (`normalizedArch && acceptsServedEdition`). | −2. |
| Command-claim savepoint | Drop if safe | **Not taken.** See "Levers not taken". | 0. |
| Bonus (not in brief) | — | `buildPatchSourceConfigUpdate` needs only `exclusiveWindowsUpdate`, but goes through `resolvePatchConfigDetailsForDevice`, which also runs `resolveDeviceTimezone`: a device/org/site join plus a partner-axis `partners` read (`featureConfigResolver.ts:440-505, 520-525`). | Call `resolvePatchConfigPolicyForDevice` directly. The output is identical. It saves 2 statements on any beat whose device **has** a patch policy (not visible in the trace, whose fixture has none). It also removes the partner-axis read that `heartbeat.ts:560-580` names as the blocker for converting the hoisted contexts to org scope (follow-up, not this wave). |

### Expected statement counts per task (measured by the budget suite)

| After task | Steady | Warm (re-beat) | Change |
|---|---|---|---|
| baseline (trace) | 69 | 47 | — |
| 1 payload fix | 67 | 45 | −2 (peripheral-v2 cancel/state UPDATEs were a test-payload artefact) |
| 2–4 | 67 | 45 | 0 (heartbeat not yet wired) |
| 5 hierarchy pass-through | 35 | 28 | −32 / −17 |
| 6 topology skip | 32 | 25 | −3 / −3 |
| 7 per-org caches + savepoint skip | 28 | 22 | −4 / −3 |
| 8 batched `agent_versions` | 26 | 20 | −2 / −2 |
| 9 ratchet | 26 | 20 | pinned |

Transactions stay at 3 (steady and warm) and 8 (cold) throughout. With the legacy (no `securityCapabilities`) payload, the final numbers are 28 / 22.

### Levers not taken

- **Command-claim savepoint** (`services/commandDispatch.ts:315`, `db.transaction` around the whole claim). All five callers run inside a DB context and none catches the claim's error: the heartbeat at `:1680` and the watchdog branch at `:779` (org transaction), the drain at `:465`, `routes/agents/commands.ts:238`, and `routes/agents/heartbeatParked.ts:141` (system contexts). So the savepoint changes no outcome today. It is still kept, for three reasons. (1) `partitionClaimable(tx: Tx, …)` is typed against the real transaction handle the savepoint yields (`commandClaimEligibility.ts:20,374`), and it opens its own nested savepoints on it (`:518`). Passing the `db` proxy would be a type cast, not a guarantee. (2) `services/commandDispatch.test.ts` uses `db.transaction` as the seam for the claim's `tx` in at least 10 tests (`:156, :208, :226, …`). (3) It is the at-most-once delivery path. The push path's sibling (`claimPendingCommandForDelivery`, `:50-80`) relies on exactly this kind of savepoint to survive a lost lock race. A future caller that catches claim errors would silently lose that bound. One statement per beat is not worth the risk. Revisit in W1a-2 only if the budget needs it.

## Not in this wave (W1a-2 or later)

- One batched policy-assignment read for all feature types (W1a-2; high rigor, advisor quorum on the query shape).
- Folding the OneDrive context into the shared policy context (W1a-2). After this plan, the OneDrive context costs 4 statements: BEGIN, prologue, the policy read, COMMIT. The hierarchy read moves into it at this wave and moves with it later.
- Caching the monitoring `none_applies` answer (`helpers.ts:~2686`, deliberately uncached today).
- A generation-stamped config cache.
- Cluster-wide (Redis pub/sub) invalidation of the per-org caches (W1b). Until then other instances keep a stale entry for up to one TTL.
- Converting the hoisted post-commit system contexts to org scope. The patch-source change in Task 4 removes the stated blocker, but the conversion is its own reviewable change.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/services/deviceHierarchy.ts` | Create | `DeviceHierarchy` type, one-statement `loadDeviceHierarchy`, `hierarchyFor` guard, `withHierarchy` helper |
| `apps/api/src/services/deviceHierarchy.test.ts` | Create | Unit: guard semantics |
| `apps/api/src/__tests__/integration/deviceHierarchy.integration.test.ts` | Create | Loader against real Postgres |
| `apps/api/src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts` | Create (Task 3), extend (Task 4) | Per-resolver parity, mismatch rejection, negative controls |
| `apps/api/src/services/helperSettings.ts` | Modify | Hierarchy option; `readCachedHelperSettings`; injectable legacy-org loader |
| `apps/api/src/services/featureConfigResolver.ts` | Modify | Hierarchy option on `resolvePatchConfigPolicyForDevice` |
| `apps/api/src/services/monitors/monitorResolver.ts` | Modify | Hierarchy option on `resolveMonitorsForDevice` |
| `apps/api/src/services/warrantyPolicyResolution.ts` | Modify | Hierarchy option |
| `apps/api/src/services/timeSync/settings.ts`, `timeSync/configUpdate.ts` | Modify | Hierarchy option; site from hierarchy |
| `apps/api/src/routes/agents/helpers.ts` | Modify | Hierarchy option on event-log, hardware, monitoring, PAM, OneDrive, patch-source, warranty, time-sync builders; probe `partnerId`; PAM fallback loader; batched upgrade targets |
| `apps/api/src/routes/agents/heartbeat.ts` | Modify | Hierarchy load + pass-through; topology skip; cache wiring; batched upgrade targets |
| `apps/api/src/services/topology/heartbeat.ts` (+ `.test.ts`) | Modify | Drop inner savepoint; `topologyHeartbeatWithoutMaterialization` |
| `apps/api/src/__tests__/integration/topologyHeartbeatMaterializationOff.integration.test.ts` | Create | Real-Postgres parity for the skip |
| `apps/api/src/services/hotPathCache.ts` (+ `.test.ts`) | Modify | `peek`, `ticket`, `fillIfCurrent`, `DeferredCacheFills` |
| `apps/api/src/services/agentOrgSettingsCache.ts` | Modify | Three new per-org caches and invalidators |
| `apps/api/src/routes/policyManagement/actions.ts` (+ `.test.ts`) | Modify | Invalidate the probe cache on deactivate |
| `apps/api/src/routes/agents/mtls.ts` (+ `.test.ts`) | Modify | Invalidate the helper legacy cache on PATCH |
| `apps/api/src/__tests__/integration/agentVersionsBatchParity.integration.test.ts` | Create | Batch vs single parity |
| `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` | Modify every task | Payload fix, bucket counts, behaviour guards, ratchet |
| `apps/api/src/routes/agents/heartbeat.test.ts`, `routes/agents/networkContext.test.ts` | Modify | Mock surface for new imports |

---

### Task 1: Budget suite measures a real agent payload and counts statements per bucket

**Files:**
- Modify: `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` (whole file; `Measurement`/`summarize` ~`:98-115`, `heartbeat()` ~`:204-210`, steady test ~`:237-270`)

**Interfaces:**
- Produces: `type Bucket`, `classifyStatement(sql: string): Bucket | null`, `Measurement.buckets: Record<Bucket, number>`, `CURRENT_AGENT_HEARTBEAT`, `LEGACY_AGENT_HEARTBEAT`, `heartbeat(device, body?)`. Every later task asserts on `measured.buckets.<name>`.

- [ ] **Step 1: Add the bucket classifier and a failing assertion (payload still legacy)**

Replace `interface Measurement` and `summarize` with:

```ts
// Statement buckets (#8053 W1a-1). Each later lever asserts on its own bucket,
// so a regression names itself instead of showing up as "statements 31 > 26".
// Matched on the whitespace-collapsed, lower-cased SQL postgres.js sends.
const BUCKET_MATCHERS = {
  begin: (s: string) => s === 'begin' || s.startsWith('begin '),
  prologue: (s: string) => s.startsWith("select set_config('breeze.scope'"),
  savepoint: (s: string) => s.startsWith('savepoint'),
  // A resolver's own `select … from devices where id = $1` — NOT the core read
  // (which selects every column, agent_token_hash included).
  deviceLookup: (s: string) =>
    /^select .* from "devices" where "devices"\."id" = \$1/.test(s) && !s.includes('"agent_token_hash"'),
  orgPartnerLookup: (s: string) => /^select "partner_id"(, "type")? from "organizations" where/.test(s),
  groupLookup: (s: string) => s.startsWith('select "group_id" from "device_group_memberships"'),
  hierarchyLoad: (s: string) => s.includes('from "devices" left join "organizations"') && s.includes('jsonb_agg'),
  siteLookup: (s: string) => s.includes('from "devices" inner join "sites"'),
  agentVersions: (s: string) => s.includes('from "agent_versions"'),
  topologyNegotiation: (s: string) => s.includes('from devices where id=$1::uuid and not is_ephemeral'),
  orgHelperSettings: (s: string) => s.startsWith('select "settings" from "organizations"'),
  pamOrgConfig: (s: string) => s.includes('from "pam_org_config"'),
  automationPolicies: (s: string) => s.includes('from "automation_policies"'),
  peripheralCapabilityWrites: (s: string) =>
    s.startsWith('update "device_commands"') || s.startsWith('update "peripheral_policy_device_states"'),
} as const;

type Bucket = keyof typeof BUCKET_MATCHERS;
const BUCKETS = Object.keys(BUCKET_MATCHERS) as Bucket[];

function normalizeStatement(sql: string): string {
  return sql.trim().toLowerCase().replace(/\s+/g, ' ');
}

function classifyStatement(sql: string): Bucket | null {
  const s = normalizeStatement(sql);
  return BUCKETS.find((bucket) => BUCKET_MATCHERS[bucket](s)) ?? null;
}

interface Measurement {
  status: number;
  transactions: number;
  savepoints: number;
  statements: number;
  buckets: Record<Bucket, number>;
}

function summarize(status: number, statements: string[]): Measurement {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const statement of statements) {
    const bucket = classifyStatement(statement);
    if (bucket) buckets[bucket] += 1;
  }
  return {
    status,
    transactions: buckets.begin,
    savepoints: buckets.savepoint,
    statements: statements.length,
    buckets,
  };
}
```

In the steady test, after the existing `console.log`, add:

```ts
    // A current agent declares peripheralPolicyProtocolVersion 2, so the claim
    // never runs the v2 cancel/state UPDATEs that a legacy payload triggers.
    expect(steady.buckets.peripheralCapabilityWrites).toBe(0);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
```
Expected: 1 file. The steady test FAILS with `expected 2 to be 0`, because the payload is still the legacy one. The other three tests pass.

- [ ] **Step 3: Send what current agents send, and keep a legacy case**

Replace `heartbeat()` with:

```ts
// What a current agent declares on every beat: compiledSecurityCapabilities()
// in agent/internal/heartbeat/heartbeat.go (~:7991) plus the runtime PAM
// lifetime version and reconciliation status it sets at ~:4751-4753.
const CURRENT_AGENT_HEARTBEAT = {
  status: 'ok',
  agentVersion: '1.0.0-test',
  metricsAvailable: false,
  securityCapabilities: {
    outboundNetworkPolicyVersion: 1,
    scriptSecretEnvVersion: 1,
    peripheralPolicyProtocolVersion: 2,
    rollbackProtocolVersion: 1,
    revocationLeaseProtocolVersion: 1,
    desktopFenceProtocolVersion: 1,
    desktopWsFenceProtocolVersion: 1,
    consentPromptProtocolVersion: 2,
    pamLifetimeProtocolVersion: 2,
    pamReconciliation: { unresolvedCount: 0, quarantinedCount: 0, awaitingAcknowledgementCount: 0 },
  },
};

// A pre-capability agent (no securityCapabilities). The claim then cancels any
// pending peripheral_policy_sync_v2 rows and marks their states rejected: two
// UPDATEs per beat that a current agent never pays.
const LEGACY_AGENT_HEARTBEAT = { status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false };

function heartbeat(device: EnrolledDevice, body: Record<string, unknown> = CURRENT_AGENT_HEARTBEAT): Promise<Response> {
  return Promise.resolve(agentApp(device).request(`/agents/${device.agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
```

Change the steady test's `console.log` to print the buckets as well:

```ts
    console.log(
      '[#8053 budget] heartbeat cold:', JSON.stringify(cold),
      'warm:', JSON.stringify(warm),
      'steady:', JSON.stringify(steady),
    );
```
(`JSON.stringify(measurement)` now includes `buckets`; no other change is needed.)

Add a new test after the steady test:

```ts
  runDb('POST /agents/:id/heartbeat: a legacy (no securityCapabilities) beat pays the two peripheral-v2 UPDATEs on top', async () => {
    const org = await seedOrg('legacy');
    const device = await enrollDevice(org, 'legacy');
    const sibling = await enrollDevice(org, 'legacy-sibling');
    await heartbeat(device, LEGACY_AGENT_HEARTBEAT);
    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling, LEGACY_AGENT_HEARTBEAT)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);
    const steady = await measure(() => heartbeat(device, LEGACY_AGENT_HEARTBEAT));
    console.log('[#8053 budget] legacy steady:', JSON.stringify(steady));

    expect(steady.status).toBe(200);
    expect(steady.transactions).toBeLessThanOrEqual(3);
    expect(steady.buckets.peripheralCapabilityWrites).toBe(2);
    expect(steady.statements).toBeLessThanOrEqual(70);
  });
```

- [ ] **Step 4: Run and check the numbers**

Run the same command as Step 2.
Expected: 5 tests PASS. The printed steady line shows `statements: 67`, `transactions: 3`, `savepoints: 5` and `buckets` `{ deviceLookup: 11, orgPartnerLookup: 11, groupLookup: 10, siteLookup: 1, agentVersions: 3, topologyNegotiation: 1, orgHelperSettings: 1, pamOrgConfig: 1, automationPolicies: 1, peripheralCapabilityWrites: 0, … }`. The legacy steady line shows 69. If any bucket differs from these, fix the matcher **before** moving on. Later tasks assert on these buckets.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
git commit -m "test(api): heartbeat budget measures a current agent payload, per-bucket counts (#8053)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `DeviceHierarchy` — one-statement loader and cross-device guard

**Files:**
- Create: `apps/api/src/services/deviceHierarchy.ts`
- Create: `apps/api/src/services/deviceHierarchy.test.ts`
- Create: `apps/api/src/__tests__/integration/deviceHierarchy.integration.test.ts`

**Interfaces:**
- Consumes: `db`, schema `devices`, `organizations`, `sites`, `deviceGroupMemberships`; type `DbExecutor` from `services/monitors/monitorCompiler`.
- Produces:
  - `interface DeviceHierarchy { readonly deviceId: string; readonly orgId: string; readonly siteId: string; readonly deviceRole: string; readonly osType: string; readonly org: { readonly partnerId: string; readonly type: string } | null; readonly site: { readonly id: string; readonly name: string; readonly timezone: string } | null; readonly groupIds: readonly string[] }`
  - `interface DeviceHierarchyOpts { hierarchy?: DeviceHierarchy }`
  - `class DeviceHierarchyMismatchError extends Error`
  - `hierarchyFor(deviceId: string, opts: DeviceHierarchyOpts | undefined): DeviceHierarchy | undefined` (throws on mismatch)
  - `withHierarchy(hierarchy: DeviceHierarchy | null): DeviceHierarchyOpts | undefined`
  - `loadDeviceHierarchy(deviceId: string, executor?: DbExecutor): Promise<DeviceHierarchy | null>`

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/services/deviceHierarchy.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { DeviceHierarchyMismatchError, hierarchyFor, withHierarchy, type DeviceHierarchy } from './deviceHierarchy';

const hierarchy: DeviceHierarchy = {
  deviceId: 'device-a',
  orgId: 'org-1',
  siteId: 'site-1',
  deviceRole: 'workstation',
  osType: 'windows',
  org: { partnerId: 'partner-1', type: 'customer' },
  site: { id: 'site-1', name: 'HQ', timezone: 'UTC' },
  groupIds: ['g-1'],
};

describe('hierarchyFor (#8053 W1a-1)', () => {
  it('returns undefined when the caller passed no hierarchy (the resolver loads its own)', () => {
    expect(hierarchyFor('device-a', undefined)).toBeUndefined();
    expect(hierarchyFor('device-a', {})).toBeUndefined();
  });

  it('returns the same object for the device it describes', () => {
    expect(hierarchyFor('device-a', { hierarchy })).toBe(hierarchy);
  });

  it('refuses a hierarchy that describes a different device', () => {
    expect(() => hierarchyFor('device-b', { hierarchy })).toThrow(DeviceHierarchyMismatchError);
    expect(() => hierarchyFor('device-b', { hierarchy })).toThrow(/device-a.*device-b/);
  });
});

describe('withHierarchy', () => {
  it('maps null to undefined so a resolver call reads exactly as before', () => {
    expect(withHierarchy(null)).toBeUndefined();
    expect(withHierarchy(hierarchy)).toEqual({ hierarchy });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/deviceHierarchy.test.ts`
Expected: FAIL. `Failed to resolve import "./deviceHierarchy"`.

- [ ] **Step 3: Implement the module**

`apps/api/src/services/deviceHierarchy.ts`:

```ts
/**
 * A device's policy hierarchy — the facts every config-policy resolver keys on
 * (#8053 W1a-1): the device row, its organization's partner and type, its site,
 * and its device-group memberships.
 *
 * The heartbeat used to make each of its ten post-commit resolvers re-read
 * these (three statements each, 33 per beat). It now loads them ONCE with
 * `loadDeviceHierarchy` and passes the value explicitly; every resolver takes
 * it as an OPTIONAL `opts.hierarchy` and, without it, keeps its own reads
 * unchanged.
 *
 * The value is RAW on purpose. Resolvers disagree on how to use it, and each
 * keeps its own rule:
 *   - featureConfigResolver drops the partner for an `unassigned_pool` org;
 *   - monitorResolver keeps the raw partner for ownership but drops the
 *     partner-level TARGET for `quick_support` and `unassigned_pool` orgs, and
 *     (like resolvePolicyCheckInterval) treats a missing org as
 *     "device missing";
 *   - every other resolver uses the raw partner.
 * No heartbeat resolver filters groups for execution safety, so `groupIds` is
 * every membership row, unfiltered.
 *
 * Tenancy: a hierarchy is for ONE device. `hierarchyFor` throws when a resolver
 * for device A is handed device B's hierarchy, so a wiring mistake fails the
 * feature for that beat instead of configuring A with B's policies.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroupMemberships, devices, organizations, sites } from '../db/schema';
import type { DbExecutor } from './monitors/monitorCompiler';

export interface DeviceHierarchy {
  readonly deviceId: string;
  readonly orgId: string;
  readonly siteId: string;
  readonly deviceRole: string;
  readonly osType: string;
  /** The device's organizations row; null when it did not resolve in the loading context. */
  readonly org: { readonly partnerId: string; readonly type: string } | null;
  /** The device's sites row; null when it did not resolve in the loading context. */
  readonly site: { readonly id: string; readonly name: string; readonly timezone: string } | null;
  /** Every device_group_memberships.group_id for the device. Unfiltered. */
  readonly groupIds: readonly string[];
}

export interface DeviceHierarchyOpts {
  hierarchy?: DeviceHierarchy;
}

export class DeviceHierarchyMismatchError extends Error {
  constructor(readonly hierarchyDeviceId: string, readonly resolverDeviceId: string) {
    super(`device hierarchy for ${hierarchyDeviceId} was passed to a resolver for ${resolverDeviceId}`);
    this.name = 'DeviceHierarchyMismatchError';
  }
}

/** The caller's hierarchy for `deviceId`, or undefined to make the resolver load its own. */
export function hierarchyFor(deviceId: string, opts: DeviceHierarchyOpts | undefined): DeviceHierarchy | undefined {
  const hierarchy = opts?.hierarchy;
  if (!hierarchy) return undefined;
  if (hierarchy.deviceId !== deviceId) throw new DeviceHierarchyMismatchError(hierarchy.deviceId, deviceId);
  return hierarchy;
}

export function withHierarchy(hierarchy: DeviceHierarchy | null): DeviceHierarchyOpts | undefined {
  return hierarchy ? { hierarchy } : undefined;
}

function parseGroupIds(raw: unknown): string[] {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * One statement: the device, LEFT JOINed to its org and site, with its group
 * ids aggregated in a correlated subquery. LEFT joins keep the device row when
 * the org or site is not visible in the caller's context (the resolvers' own
 * reads then see "no org" / "no site", and so do they here). RLS applies to
 * every table in the statement exactly as it does to the three separate reads.
 */
export async function loadDeviceHierarchy(deviceId: string, executor: DbExecutor = db): Promise<DeviceHierarchy | null> {
  const [row] = await executor
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      deviceRole: devices.deviceRole,
      osType: devices.osType,
      orgPartnerId: organizations.partnerId,
      orgType: organizations.type,
      siteRowId: sites.id,
      siteName: sites.name,
      siteTimezone: sites.timezone,
      groupIds: sql<unknown>`coalesce((
        select jsonb_agg(${deviceGroupMemberships.groupId})
        from ${deviceGroupMemberships}
        where ${deviceGroupMemberships.deviceId} = ${devices.id}
      ), '[]'::jsonb)`,
    })
    .from(devices)
    .leftJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!row) return null;

  return Object.freeze({
    deviceId: row.deviceId,
    orgId: row.orgId,
    siteId: row.siteId,
    deviceRole: row.deviceRole,
    osType: row.osType,
    org: row.orgPartnerId !== null && row.orgType !== null
      ? Object.freeze({ partnerId: row.orgPartnerId, type: row.orgType })
      : null,
    site: row.siteRowId !== null && row.siteName !== null && row.siteTimezone !== null
      ? Object.freeze({ id: row.siteRowId, name: row.siteName, timezone: row.siteTimezone })
      : null,
    groupIds: Object.freeze(parseGroupIds(row.groupIds)),
  });
}
```

- [ ] **Step 4: Run the unit test**

Run: `cd apps/api && npx vitest run src/services/deviceHierarchy.test.ts`
Expected: 1 file, 5 tests PASS.

- [ ] **Step 5: Write the real-Postgres loader test**

`apps/api/src/__tests__/integration/deviceHierarchy.integration.test.ts`:

```ts
/**
 * loadDeviceHierarchy (#8053 W1a-1) against real PostgreSQL: the one
 * statement returns what the resolvers' three separate reads returned, in
 * system scope (where the heartbeat runs it) and in the device's own org scope.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId: partnerId,
  };
}

async function seed(groupCount: number) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const unique = randomUUID().slice(0, 8);
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `dh-agent-${unique}`, hostname: `dh-${unique}`,
      osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    }).returning();
    const groupIds: string[] = [];
    for (let i = 0; i < groupCount; i += 1) {
      const [group] = await db.insert(deviceGroups).values({ orgId: org.id, name: `dh group ${i} ${unique}` }).returning();
      await db.insert(deviceGroupMemberships).values({ deviceId: device!.id, groupId: group!.id, orgId: org.id });
      groupIds.push(group!.id);
    }
    return { partner, org, site, device: device!, groupIds };
  });
}

describe('loadDeviceHierarchy (#8053 W1a-1) — real PostgreSQL', () => {
  runDb('returns the device, its org partner and type, its site and every group id in one statement', async () => {
    const f = await seed(2);
    const hierarchy = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(f.device.id));
    expect(hierarchy).toMatchObject({
      deviceId: f.device.id,
      orgId: f.org.id,
      siteId: f.site.id,
      deviceRole: 'workstation',
      osType: 'windows',
      org: { partnerId: f.partner.id, type: 'customer' },
      site: { id: f.site.id, name: f.site.name, timezone: f.site.timezone },
    });
    expect([...hierarchy!.groupIds].sort()).toEqual([...f.groupIds].sort());
    expect(Object.isFrozen(hierarchy)).toBe(true);
  });

  runDb('reads the same hierarchy in the device\'s own org scope as in system scope', async () => {
    const f = await seed(2);
    const system = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(f.device.id));
    const scoped = await withDbAccessContext(orgCtx(f.org.id, f.partner.id), () => loadDeviceHierarchy(f.device.id));
    expect({ ...scoped, groupIds: [...scoped!.groupIds].sort() }).toEqual({ ...system, groupIds: [...system!.groupIds].sort() });
  });

  runDb('a device with no memberships has an empty groupIds list, not null', async () => {
    const f = await seed(0);
    const hierarchy = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(f.device.id));
    expect(hierarchy!.groupIds).toEqual([]);
  });

  runDb('an unknown device id is null', async () => {
    const hierarchy = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(randomUUID()));
    expect(hierarchy).toBeNull();
  });

  runDb('another org\'s context cannot see the device (RLS still applies)', async () => {
    const f = await seed(1);
    const other = await seed(0);
    const hierarchy = await withDbAccessContext(orgCtx(other.org.id, other.partner.id), () => loadDeviceHierarchy(f.device.id));
    expect(hierarchy).toBeNull();
  });
});
```

- [ ] **Step 6: Run it**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceHierarchy.integration.test.ts`
Expected: 1 file, 5 tests PASS. If `groupIds` comes back as a string, `parseGroupIds` already handles it. If it comes back as anything else, stop: the jsonb parsing assumption is wrong.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/deviceHierarchy.ts apps/api/src/services/deviceHierarchy.test.ts apps/api/src/__tests__/integration/deviceHierarchy.integration.test.ts
git commit -m "feat(api): one-statement device policy hierarchy with a cross-device guard (#8053)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Service-layer resolvers accept a passed hierarchy

**Files:**
- Modify: `apps/api/src/services/helperSettings.ts:82-104` (`resolveDeviceHelperSettings`)
- Modify: `apps/api/src/services/featureConfigResolver.ts:94-135` (imports + adapter), `:537-545` (`resolvePatchConfigPolicyForDevice`)
- Modify: `apps/api/src/services/monitors/monitorResolver.ts:179-210` (`resolveMonitorsForDevice`)
- Modify: `apps/api/src/services/warrantyPolicyResolution.ts:52-91`
- Modify: `apps/api/src/services/timeSync/settings.ts:56-79, 211-242`; `apps/api/src/services/timeSync/configUpdate.ts:49-60`
- Create: `apps/api/src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts`

**Interfaces:**
- Consumes (Task 2): `DeviceHierarchy`, `DeviceHierarchyOpts`, `hierarchyFor`, `loadDeviceHierarchy`, `DeviceHierarchyMismatchError`.
- Produces (all new parameters optional; omitted means today's reads):
  - `resolveDeviceHelperSettings(deviceId: string, opts?: DeviceHierarchyOpts): Promise<HelperSettings | null>`
  - `resolvePatchConfigPolicyForDevice(deviceId: string, opts?: DeviceHierarchyOpts)`
  - `resolveMonitorsForDevice(deviceId: string, executor?: DbExecutor, opts?: DeviceHierarchyOpts): Promise<MonitorResolution>`
  - `resolveEffectiveWarrantyInlineSettings(deviceId: string, opts?: DeviceHierarchyOpts): Promise<unknown | undefined>`
  - `resolveDeviceTimeSyncSettings(deviceId: string, opts?: DeviceHierarchyOpts)`, `getDeviceTimeSyncSettings(deviceId: string, opts?: DeviceHierarchyOpts)`, `buildResolvedTimeSyncConfigUpdate(deviceId: string, opts?: DeviceHierarchyOpts)`

**The rule for every resolver below:** replace only the device/org/group (and, for time sync, site) reads with a ternary. The non-hierarchy branch is today's statement, byte for byte, so existing unit tests that mock those `db.select` chains in order still pass.

- [ ] **Step 1: Write the failing parity suite**

`apps/api/src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts`:

```ts
/**
 * #8053 W1a-1 — every policy resolver returns the SAME answer with the
 * heartbeat's passed hierarchy as with its own reads, against real PostgreSQL
 * with real policies at the device_group, organization and partner levels
 * (org-owned and partner-wide). Resolvers run in SYSTEM scope with the
 * hierarchy loaded in SYSTEM scope, which is exactly the heartbeat's shape.
 *
 * Two discriminating checks make the parity assertion mean something: a
 * hierarchy with the WRONG groups or NO org must change the answer for a
 * resolver whose winning policy depends on it, and a hierarchy for ANOTHER
 * device must be refused. Both fail before the resolver honours `opts`, because
 * JavaScript silently ignores an extra argument.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  automationPolicies,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
} from '../../db/schema';
import {
  DeviceHierarchyMismatchError,
  loadDeviceHierarchy,
  type DeviceHierarchy,
  type DeviceHierarchyOpts,
} from '../../services/deviceHierarchy';
import { resolveDeviceHelperSettings } from '../../services/helperSettings';
import { resolvePatchConfigPolicyForDevice } from '../../services/featureConfigResolver';
import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';
import { resolveEffectiveWarrantyInlineSettings } from '../../services/warrantyPolicyResolution';
import { resolveDeviceTimeSyncSettings } from '../../services/timeSync/settings';
import { buildResolvedTimeSyncConfigUpdate } from '../../services/timeSync/configUpdate';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestRedis } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

type Level = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  groupIds: string[];
}

let f: Fixture;

async function seedPolicy(input: {
  owner: { orgId: string | null; partnerId: string | null };
  featureType: string;
  inlineSettings?: Record<string, unknown>;
  eventLog?: { maxEventsPerCycle: number };
  level: Level;
  targetId: string;
  roleFilter?: string[];
}): Promise<string> {
  return sys(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: input.owner.orgId, partnerId: input.owner.partnerId,
      name: `parity ${input.featureType} ${randomUUID()}`, status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: input.featureType as never,
      ...(input.inlineSettings ? { inlineSettings: input.inlineSettings } : {}),
    }).returning();
    if (input.eventLog) {
      await db.insert(configPolicyEventLogSettings).values({
        featureLinkId: link!.id, retentionDays: 30, maxEventsPerCycle: input.eventLog.maxEventsPerCycle,
      });
    }
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: input.level, targetId: input.targetId, priority: 0,
      ...(input.roleFilter ? { roleFilter: input.roleFilter } : {}),
    });
    return policy!.id;
  });
}

async function seedFixture(): Promise<Fixture> {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const fixture = await sys(async () => {
    const unique = randomUUID().slice(0, 8);
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `par-agent-${unique}`, hostname: `par-${unique}`,
      osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    }).returning();
    const groupIds: string[] = [];
    for (const name of ['g1', 'g2']) {
      const [group] = await db.insert(deviceGroups).values({ orgId: org.id, name: `parity ${name} ${unique}` }).returning();
      await db.insert(deviceGroupMemberships).values({ deviceId: device!.id, groupId: group!.id, orgId: org.id });
      groupIds.push(group!.id);
    }
    return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device!.id, groupIds };
  });

  // helper: org-owned, assigned to group g2 (wins only through groupIds).
  await seedPolicy({ owner: { orgId: org.id, partnerId: null }, featureType: 'helper',
    inlineSettings: { enabled: true, showTrayIcon: false }, level: 'device_group', targetId: fixture.groupIds[1]! });
  // warranty: org-owned, assigned to group g1.
  await seedPolicy({ owner: { orgId: org.id, partnerId: null }, featureType: 'warranty',
    inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 }, level: 'device_group', targetId: fixture.groupIds[0]! });
  // event_log: PARTNER-WIDE, assigned at partner level, role-filtered to this device's role.
  await seedPolicy({ owner: { orgId: null, partnerId: partner.id }, featureType: 'event_log',
    eventLog: { maxEventsPerCycle: 321 }, level: 'partner', targetId: partner.id, roleFilter: ['workstation'] });
  // pam: PARTNER-WIDE, assigned at partner level.
  await seedPolicy({ owner: { orgId: null, partnerId: partner.id }, featureType: 'pam',
    inlineSettings: { uacInterceptionEnabled: true }, level: 'partner', targetId: partner.id });
  // policy probe: a partner-wide automation policy with one registry probe.
  await sys(async () => {
    await db.insert(automationPolicies).values({
      orgId: null, partnerId: partner.id, name: `parity probe ${randomUUID()}`, enabled: true, targets: {},
      rules: [{ type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\BreezeParity', registryValueName: 'Value' }],
    });
  });
  return fixture;
}

async function dropDeviceRedisCaches(deviceId: string): Promise<void> {
  const redis = getTestRedis();
  const keys = await redis.keys(`*${deviceId}*`);
  if (keys.length > 0) await redis.del(...keys);
}

async function loadHierarchy(): Promise<DeviceHierarchy> {
  const hierarchy = await sys(() => loadDeviceHierarchy(f.deviceId));
  expect(hierarchy).not.toBeNull();
  return hierarchy!;
}

function foreignHierarchy(h: DeviceHierarchy): DeviceHierarchy {
  return { ...h, deviceId: randomUUID() };
}

type Resolver = (deviceId: string, opts?: DeviceHierarchyOpts) => Promise<unknown>;

async function expectParity(name: string, resolve: Resolver): Promise<void> {
  await dropDeviceRedisCaches(f.deviceId);
  const own = await sys(() => resolve(f.deviceId));
  const hierarchy = await loadHierarchy();
  await dropDeviceRedisCaches(f.deviceId);
  const passed = await sys(() => resolve(f.deviceId, { hierarchy }));
  expect(passed, `${name}: passed hierarchy must not change the answer`).toEqual(own);
}

async function expectForeignRefused(name: string, resolve: Resolver): Promise<void> {
  const hierarchy = await loadHierarchy();
  await dropDeviceRedisCaches(f.deviceId);
  await expect(sys(() => resolve(f.deviceId, { hierarchy: foreignHierarchy(hierarchy) })), name)
    .rejects.toBeInstanceOf(DeviceHierarchyMismatchError);
}

const SERVICE_RESOLVERS: Array<[string, Resolver]> = [
  ['resolveDeviceHelperSettings', (id, o) => resolveDeviceHelperSettings(id, o)],
  ['resolvePatchConfigPolicyForDevice', (id, o) => resolvePatchConfigPolicyForDevice(id, o)],
  ['resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o)],
  ['resolveEffectiveWarrantyInlineSettings', (id, o) => resolveEffectiveWarrantyInlineSettings(id, o)],
  ['resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o)],
  ['buildResolvedTimeSyncConfigUpdate', (id, o) => buildResolvedTimeSyncConfigUpdate(id, o)],
];

describe('policy resolvers: passed hierarchy parity (#8053 W1a-1) — real PostgreSQL', () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    f = await seedFixture();
  });

  for (const [name, resolve] of SERVICE_RESOLVERS) {
    runDb(`${name}: same answer with the passed hierarchy`, () => expectParity(name, resolve));
    runDb(`${name}: refuses another device's hierarchy`, () => expectForeignRefused(name, resolve));
  }

  runDb('negative control: wrong groups change the helper and warranty answers (the hierarchy is really used)', async () => {
    const hierarchy = await loadHierarchy();
    const noGroups: DeviceHierarchy = { ...hierarchy, groupIds: [] };
    const helperOwn = await sys(() => resolveDeviceHelperSettings(f.deviceId));
    const helperNoGroups = await sys(() => resolveDeviceHelperSettings(f.deviceId, { hierarchy: noGroups }));
    expect(helperOwn).toMatchObject({ enabled: true, showTrayIcon: false });
    expect(helperNoGroups).toBeNull();

    const warrantyOwn = await sys(() => resolveEffectiveWarrantyInlineSettings(f.deviceId));
    const warrantyNoGroups = await sys(() => resolveEffectiveWarrantyInlineSettings(f.deviceId, { hierarchy: noGroups }));
    expect(warrantyOwn).toMatchObject({ enabled: true });
    expect(warrantyNoGroups).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts`
Expected: the 6 `refuses another device's hierarchy` tests FAIL (`promise resolved … instead of rejecting`), and the negative control FAILS (`expected { enabled: true, … } to be null`). The 6 parity tests pass vacuously, because the second argument is ignored. Also expect `tsc` errors on the extra arguments; that is fine at this step.

- [ ] **Step 3: Implement `resolveDeviceHelperSettings`**

In `apps/api/src/services/helperSettings.ts`, add `import { hierarchyFor, type DeviceHierarchyOpts } from './deviceHierarchy';` and replace the head of `resolveDeviceHelperSettings` (steps 1–3, `:82-104`) with:

```ts
export async function resolveDeviceHelperSettings(deviceId: string, opts?: DeviceHierarchyOpts): Promise<HelperSettings | null> {
  // #8053 W1a-1: the heartbeat passes the hierarchy it already loaded; every
  // other caller gets the three reads below, unchanged.
  const passed = hierarchyFor(deviceId, opts);

  // 1. Load device
  const [device] = passed
    ? [{ orgId: passed.orgId, siteId: passed.siteId }]
    : await db
      .select({ orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

  if (!device) return null;

  // 2. Load org (for partnerId)
  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId }] : [])
    : await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);

  // 3. Load device group memberships
  const groupIds = passed
    ? [...passed.groupIds]
    : (await db
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId))).map((r) => r.groupId);
```
Leave the rest of the function (steps 4–6) unchanged.

- [ ] **Step 4: Implement `resolvePatchConfigPolicyForDevice`**

In `apps/api/src/services/featureConfigResolver.ts`, add to the imports:

```ts
import { hierarchyFor, type DeviceHierarchy as PassedDeviceHierarchy, type DeviceHierarchyOpts } from './deviceHierarchy';
```

Directly below the private `loadDeviceHierarchy` (after `:135`), add:

```ts
/**
 * The same value loadDeviceHierarchy above builds, from a hierarchy the caller
 * already loaded (#8053 W1a-1). Same parked-device rule: an `unassigned_pool`
 * org gets no partner-level assignment.
 */
function fromPassedHierarchy(h: PassedDeviceHierarchy): DeviceHierarchy {
  return {
    deviceId: h.deviceId,
    orgId: h.orgId,
    siteId: h.siteId,
    partnerId: isUnassignedPoolOrgType(h.org?.type) ? null : h.org?.partnerId ?? null,
    groupIds: [...h.groupIds],
    deviceRole: h.deviceRole,
    osType: h.osType,
  };
}
```

Change `resolvePatchConfigPolicyForDevice` (`:537-545`):

```ts
export async function resolvePatchConfigPolicyForDevice(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<Omit<ResolvedPatchConfigDetails, 'resolvedTimezone'> | null> {
  const passed = hierarchyFor(deviceId, opts);
  const hierarchy = passed ? fromPassedHierarchy(passed) : await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;
```
The rest is unchanged. The other nine callers of the private `loadDeviceHierarchy` are not touched.

- [ ] **Step 5: Implement `resolveMonitorsForDevice`**

In `apps/api/src/services/monitors/monitorResolver.ts`, add `import { hierarchyFor, type DeviceHierarchyOpts } from '../deviceHierarchy';` and replace the head of `resolveMonitorsForDevice` (`:179-210`):

```ts
export async function resolveMonitorsForDevice(
  deviceId: string,
  executor: DbExecutor = db,
  opts?: DeviceHierarchyOpts,
): Promise<MonitorResolution> {
  // #8053 W1a-1: the heartbeat passes its hierarchy; other callers read below.
  const passed = hierarchyFor(deviceId, opts);
  const [device] = passed
    ? [{ id: passed.deviceId, orgId: passed.orgId, siteId: passed.siteId, deviceRole: passed.deviceRole, osType: passed.osType }]
    : await executor
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        deviceRole: devices.deviceRole,
        osType: devices.osType,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
  if (!device) return { kind: 'device_missing' };

  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId, type: passed.org.type }] : [])
    : await executor
      .select({ partnerId: organizations.partnerId, type: organizations.type })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);
  // Without the org row the partner-level assignments and partner-wide
  // monitors below silently drop out, so a partial answer would pass for
  // "resolved". Report it as unresolvable, like a vanished device (#2949).
  if (!org) return { kind: 'device_missing' };

  const groupIds = passed
    ? [...passed.groupIds]
    : (await executor
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId))).map((r) => r.groupId);
```
Delete the old `const groupRows = …; const groupIds = …` lines. The rest is unchanged (the partner-target rule at `:226` still reads `org.type`).

- [ ] **Step 6: Implement `resolveEffectiveWarrantyInlineSettings`**

In `apps/api/src/services/warrantyPolicyResolution.ts`, add `import { hierarchyFor, type DeviceHierarchyOpts } from './deviceHierarchy';`, change the signature to `(deviceId: string, opts?: DeviceHierarchyOpts)`, and replace the three reads:

```ts
  const passed = hierarchyFor(deviceId, opts);
  const [device] = passed
    ? [{ orgId: passed.orgId, siteId: passed.siteId }]
    : await db
      .select({ orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

  if (!device) return undefined;

  // The device org's partner. Needed twice below: a `level='partner'` assignment
  // targets `partners.id`, and a partner-wide policy carries `org_id NULL`.
  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId }] : [])
    : await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);
```
Keep the `if (!org) { console.error(…); captureException(…); }` block unchanged. Then:

```ts
  const groupIds = passed
    ? [...passed.groupIds]
    : (await db
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId))).map((r) => r.groupId);
```

- [ ] **Step 7: Implement time sync**

In `apps/api/src/services/timeSync/settings.ts`, add `import { hierarchyFor, type DeviceHierarchyOpts } from '../deviceHierarchy';`.

`resolveDeviceTimeSyncSettings(deviceId: string, opts?: DeviceHierarchyOpts)`. Replace the three reads (`:60-79`):

```ts
  const passed = hierarchyFor(deviceId, opts);
  const [device] = passed
    ? [{ orgId: passed.orgId, siteId: passed.siteId, deviceRole: passed.deviceRole, osType: passed.osType }]
    : await db
      .select({
        orgId: devices.orgId,
        siteId: devices.siteId,
        deviceRole: devices.deviceRole,
        osType: devices.osType,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
  if (!device) throw new Error('Time sync device not visible');
  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId }] : [])
    : await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);
  const groups = passed
    ? passed.groupIds.map((groupId) => ({ groupId }))
    : await db
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId));
```

`getDeviceTimeSyncSettings(deviceId: string, opts?: DeviceHierarchyOpts)`. Replace its device read and its resolver call:

```ts
  const passed = hierarchyFor(deviceId, opts);
  const [device] = passed
    ? [{ orgId: passed.orgId }]
    : await db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
  if (!device) throw new Error('Time sync device not visible');
  // … Redis read unchanged …
  const resolved = await resolveDeviceTimeSyncSettings(deviceId, opts);
```

In `apps/api/src/services/timeSync/configUpdate.ts`, add `import { hierarchyFor, type DeviceHierarchyOpts } from '../deviceHierarchy';`:

```ts
export async function buildResolvedTimeSyncConfigUpdate(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<TimeSyncConfigUpdate> {
  const passed = hierarchyFor(deviceId, opts);
  const resolved = await getDeviceTimeSyncSettings(deviceId, opts);
  // #8053 W1a-1: the site rides in the passed hierarchy; null there means the
  // same as this inner join finding no row.
  const [site] = passed
    ? (passed.site ? [{ id: passed.site.id, name: passed.site.name, timezone: passed.site.timezone }] : [])
    : await db
      .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
      .from(devices)
      .innerJoin(sites, eq(devices.siteId, sites.id))
      .where(eq(devices.id, deviceId))
      .limit(1);
```
The rest is unchanged.

- [ ] **Step 8: Run the parity suite and the resolvers' unit tests**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts
cd apps/api && npx vitest run src/services/helperSettings src/services/featureConfigResolver src/services/monitors/monitorResolver src/services/warrantyPolicyResolution src/services/timeSync
```
Expected: the integration file passes all 13 tests. The unit run passes, and the reported file count includes every `*.test.ts` under those paths (check it is non-zero for each prefix). Then run `cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`. Expect `exit=0`. Do not pipe `tsc` into `tail` (that hides an OOM).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/helperSettings.ts apps/api/src/services/featureConfigResolver.ts apps/api/src/services/monitors/monitorResolver.ts apps/api/src/services/warrantyPolicyResolution.ts apps/api/src/services/timeSync/settings.ts apps/api/src/services/timeSync/configUpdate.ts apps/api/src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts
git commit -m "feat(api): service policy resolvers accept a passed device hierarchy (#8053)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Agent-route builders accept a passed hierarchy; patch source skips the timezone read

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` — `buildPolicyProbeConfigUpdate` `:425-445`; `resolveDeviceEventLogSettings` `:1919-1946`, `getDeviceEventLogSettings` `:2025`, `buildEventLogConfigUpdate` `:2061`; `resolveHardwareMonitoring` `:2092-2116`, `resolveDeviceHardwareMonitoringSettings` `:2180`, `getDeviceHardwareMonitoringSettings` `:2194`, `buildHardwareMonitoringConfigUpdate` `:2224`; `buildTimeSyncConfigUpdate` `:2243`; `resolveMonitorDerivedWatches` `:2394`, `resolveDeviceMonitoringSettings` `:2488`, `resolvePolicyCheckInterval` `:2544-2575`, `buildMonitoringConfigUpdate` `:2666`; `resolveDevicePamSettings` `:3084-3105`, `buildPamConfigUpdate` `:3167`; `buildPatchSourceConfigUpdate` `:3216`; `buildWarrantyConfigUpdate` `:3248`; `resolveDeviceOnedriveSettings` `:3279-3301`, `buildOnedriveHelperConfigUpdate` `:3502`; the `featureConfigResolver` import `:60-64`
- Modify: `apps/api/src/services/helperSettings.ts` — `buildHelperConfigUpdate` signature (pass-through only; the cache refactor is Task 7)
- Modify: `apps/api/src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 and Task 3 signatures.
- Produces (each `opts` optional):
  - `buildEventLogConfigUpdate(deviceId, opts?: DeviceHierarchyOpts)`; `getDeviceEventLogSettings(deviceId, opts?)`
  - `buildHardwareMonitoringConfigUpdate(deviceId, opts?)`; `getDeviceHardwareMonitoringSettings(deviceId, opts?)`; `resolveDeviceHardwareMonitoringSettings(deviceId, opts?)`
  - `buildMonitoringConfigUpdate(deviceId, opts?)`
  - `buildPamConfigUpdate(deviceId, opts?: DeviceHierarchyOpts)` (Task 7 widens this to `PamConfigUpdateOptions`)
  - `buildPatchSourceConfigUpdate(deviceId, opts?)`; `buildWarrantyConfigUpdate(deviceId, opts?)`; `buildTimeSyncConfigUpdate(deviceId, opts?)`; `buildOnedriveHelperConfigUpdate(deviceId, opts?)`
  - `buildHelperConfigUpdate(deviceId: string, orgId: string, opts?: DeviceHierarchyOpts)`
  - `buildPolicyProbeConfigUpdate(orgId: string | null | undefined, opts?: { partnerId?: string | null }): Promise<PolicyProbeConfigUpdate | null>`

- [ ] **Step 1: Extend the parity suite (failing)**

Add these imports to `deviceHierarchyResolverParity.integration.test.ts`:

```ts
import {
  buildEventLogConfigUpdate,
  buildHardwareMonitoringConfigUpdate,
  buildHelperConfigUpdate,
  buildMonitoringConfigUpdate,
  buildOnedriveHelperConfigUpdate,
  buildPamConfigUpdate,
  buildPatchSourceConfigUpdate,
  buildPolicyProbeConfigUpdate,
  buildTimeSyncConfigUpdate,
  buildWarrantyConfigUpdate,
} from '../../routes/agents/helpers';
```

Add below `SERVICE_RESOLVERS`:

```ts
const ROUTE_BUILDERS: Array<[string, Resolver]> = [
  ['buildEventLogConfigUpdate', (id, o) => buildEventLogConfigUpdate(id, o)],
  ['buildHardwareMonitoringConfigUpdate', (id, o) => buildHardwareMonitoringConfigUpdate(id, o)],
  ['buildMonitoringConfigUpdate', (id, o) => buildMonitoringConfigUpdate(id, o)],
  ['buildPamConfigUpdate', (id, o) => buildPamConfigUpdate(id, o)],
  ['buildPatchSourceConfigUpdate', (id, o) => buildPatchSourceConfigUpdate(id, o)],
  ['buildWarrantyConfigUpdate', (id, o) => buildWarrantyConfigUpdate(id, o)],
  ['buildTimeSyncConfigUpdate', (id, o) => buildTimeSyncConfigUpdate(id, o)],
  ['buildOnedriveHelperConfigUpdate', (id, o) => buildOnedriveHelperConfigUpdate(id, o)],
  ['buildHelperConfigUpdate', (id, o) => buildHelperConfigUpdate(id, f.orgId, o)],
];
```

Inside the `describe`, after the service-resolver loop:

```ts
  for (const [name, resolve] of ROUTE_BUILDERS) {
    runDb(`${name}: same answer with the passed hierarchy`, () => expectParity(name, resolve));
    runDb(`${name}: refuses another device's hierarchy`, () => expectForeignRefused(name, resolve));
  }

  runDb('negative control: a hierarchy with no org drops the partner-wide event_log and pam policies', async () => {
    const hierarchy = await loadHierarchy();
    const noOrg: DeviceHierarchy = { ...hierarchy, org: null };
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildEventLogConfigUpdate(f.deviceId))).toMatchObject({ max_events_per_cycle: 321 });
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildEventLogConfigUpdate(f.deviceId, { hierarchy: noOrg }))).toMatchObject({ max_events_per_cycle: 100 });
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildPamConfigUpdate(f.deviceId))).toEqual({ uacInterceptionEnabled: true });
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildPamConfigUpdate(f.deviceId, { hierarchy: noOrg }))).toEqual({ uacInterceptionEnabled: false });
  });

  runDb('negative control: the role in the hierarchy decides a role-filtered policy', async () => {
    const hierarchy = await loadHierarchy();
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildEventLogConfigUpdate(f.deviceId, { hierarchy: { ...hierarchy, deviceRole: 'printer' } })))
      .toMatchObject({ max_events_per_cycle: 100 });
  });

  runDb('policy probe: the passed partner id gives the same probe list as the org read', async () => {
    const own = await sys(() => buildPolicyProbeConfigUpdate(f.orgId));
    const passed = await sys(() => buildPolicyProbeConfigUpdate(f.orgId, { partnerId: f.partnerId }));
    expect(own?.policy_registry_state_probes).toEqual([{ registry_path: 'HKLM\\SOFTWARE\\BreezeParity', value_name: 'Value' }]);
    expect(passed).toEqual(own);
    // Discriminates: with partnerId null the partner-wide probe disappears.
    const orgOnly = await sys(() => buildPolicyProbeConfigUpdate(f.orgId, { partnerId: null }));
    expect(orgOnly?.policy_registry_state_probes).toEqual([]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts`
Expected: the 9 new `refuses another device's hierarchy` tests, both new negative controls, and the `partnerId: null` assertion in the probe test FAIL. The parity tests pass vacuously.

- [ ] **Step 3: Implement the builders in `routes/agents/helpers.ts`**

Add the imports:

```ts
import { hierarchyFor, type DeviceHierarchyOpts } from '../../services/deviceHierarchy';
```
Add `resolvePatchConfigPolicyForDevice` to the existing `../../services/featureConfigResolver` import (`:60-64`).

**Policy probe** (`:425-445`):

```ts
export async function buildPolicyProbeConfigUpdate(
  orgId: string | null | undefined,
  // #8053 W1a-1: the heartbeat passes the org's partner from the hierarchy it
  // loaded. `undefined` = read it here, as before; `null` = no partner.
  opts?: { partnerId?: string | null },
): Promise<PolicyProbeConfigUpdate | null> {
  if (!orgId) {
    return null;
  }

  // Dual-ownership (#2129): the device's probe list must also cover
  // partner-wide compliance policies (org_id NULL) owned by this org's
  // partner — the evaluation worker fans those out to this device, so the
  // agent has to collect their registry/config state too.
  const partnerId = opts?.partnerId !== undefined
    ? opts.partnerId
    : (await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1))[0]?.partnerId ?? null;

  const ownershipCondition = partnerId
    ? or(
        eq(automationPolicies.orgId, orgId),
        and(isNull(automationPolicies.orgId), eq(automationPolicies.partnerId, partnerId))
      )
    : eq(automationPolicies.orgId, orgId);
```
The rest is unchanged.

**Event log.** `resolveDeviceEventLogSettings(deviceId: string, opts?: DeviceHierarchyOpts)`; replace steps 1–3 (`:1920-1946`):

```ts
  const passed = hierarchyFor(deviceId, opts);
  // 1. Load device
  const [device] = passed
    ? [{ orgId: passed.orgId, siteId: passed.siteId, deviceRole: passed.deviceRole, osType: passed.osType }]
    : await db
      .select({
        orgId: devices.orgId,
        siteId: devices.siteId,
        deviceRole: devices.deviceRole,
        osType: devices.osType,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

  if (!device) return EVENT_LOG_DEFAULTS;

  // 2. Load org (for partnerId)
  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId }] : [])
    : await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);

  // 3. Load device group memberships
  const groupIds = passed
    ? [...passed.groupIds]
    : (await db
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId))).map((r) => r.groupId);
```
`getDeviceEventLogSettings(deviceId: string, opts?: DeviceHierarchyOpts)` calls `resolveDeviceEventLogSettings(deviceId, opts)`. `buildEventLogConfigUpdate(deviceId: string, opts?: DeviceHierarchyOpts)` calls `getDeviceEventLogSettings(deviceId, opts)`.

**Hardware monitoring.** `resolveHardwareMonitoring(deviceId: string, opts?: DeviceHierarchyOpts)`; replace its three reads (`:2095-2116`) with exactly the event-log ternaries above, but return `fallback` for a missing device. The `withDevicePartnerPolicyVisibility(db, org?.partnerId ?? null, …)` call stays. Its caller contract ("partnerId read from a row the caller resolved under its own RLS context") still holds: the heartbeat's hierarchy reads `organizations.partner_id` in the heartbeat's own context, and in system scope the helper is a no-op. Then thread `opts` through: `resolveDeviceHardwareMonitoringSettings(deviceId, opts?)` → `resolveHardwareMonitoring(deviceId, opts)`; `getDeviceHardwareMonitoringSettings(deviceId, opts?)` → `resolveDeviceHardwareMonitoringSettings(deviceId, opts)`; `buildHardwareMonitoringConfigUpdate(deviceId, opts?)` → `getDeviceHardwareMonitoringSettings(deviceId, opts)`. `resolveDeviceHardwareMonitoringPolicy` is unchanged.

**Time sync wrapper:**

```ts
export async function buildTimeSyncConfigUpdate(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<TimeSyncConfigUpdate> {
  return buildResolvedTimeSyncConfigUpdate(deviceId, opts);
}
```

**Monitoring.** `resolvePolicyCheckInterval(deviceId: string, opts?: DeviceHierarchyOpts)`; replace its reads (`:2545-2575`) with:

```ts
  const passed = hierarchyFor(deviceId, opts);
  // 1. Load device
  const [device] = passed
    ? [{ orgId: passed.orgId, siteId: passed.siteId, deviceRole: passed.deviceRole, osType: passed.osType }]
    : await db
      .select({
        orgId: devices.orgId,
        siteId: devices.siteId,
        deviceRole: devices.deviceRole,
        osType: devices.osType,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

  if (!device) return { kind: 'device_missing' };

  // 2. Load org (for partnerId)
  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId }] : [])
    : await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);
  // An org miss (deleted mid-race) would drop the partner-level target and
  // the partner-wide ownership branch below, so a device whose only policy
  // is partner-wide would resolve as `no_policy` and be sent the #2949 clear.
  // The hierarchy is unknown this cycle — same answer as a device miss.
  if (!org) return { kind: 'device_missing' };

  // 3. Load device group memberships
  const groupIds = passed
    ? [...passed.groupIds]
    : (await db
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId))).map((r) => r.groupId);
```
Then thread `opts`: `resolveMonitorDerivedWatches(deviceId, opts?)` calls `resolveMonitorsForDevice(deviceId, db, opts)`; `resolveDeviceMonitoringSettings(deviceId, opts?)` calls `resolvePolicyCheckInterval(deviceId, opts)` and `resolveMonitorDerivedWatches(deviceId, opts)`; `buildMonitoringConfigUpdate(deviceId: string, opts?: DeviceHierarchyOpts)` calls `resolveDeviceMonitoringSettings(deviceId, opts)`.

**PAM.** `resolveDevicePamSettings(deviceId: string, opts?: DeviceHierarchyOpts)`; replace steps 1–3 (`:3085-3105`) with the helper-settings ternaries from Task 3 Step 3 (device `{orgId, siteId}`, org `{partnerId}`, `groupIds`), returning `PAM_DEFAULTS` for a missing device. `buildPamConfigUpdate(deviceId: string, opts?: DeviceHierarchyOpts)` calls `resolveDevicePamSettings(deviceId, opts)`.

**OneDrive.** `resolveDeviceOnedriveSettings(deviceId: string, opts?: DeviceHierarchyOpts)`; replace steps 1–3 (`:3280-3301`) with the helper-settings ternaries, returning `null` for a missing device. `buildOnedriveHelperConfigUpdate(deviceId: string, opts?: DeviceHierarchyOpts)` returns `resolveDeviceOnedriveSettings(deviceId, opts)`.

**Patch source** (`:3216`):

```ts
/**
 * … (keep the existing doc) …
 *
 * #8053 W1a-1: reads only WHICH patch link won. The details variant also
 * resolves the device timezone (a device/org/site join plus a partner-axis
 * `partners` read) that this flag never used.
 */
export async function buildPatchSourceConfigUpdate(deviceId: string, opts?: DeviceHierarchyOpts): Promise<PatchSourceSettings> {
  const patch = await resolvePatchConfigPolicyForDevice(deviceId, opts);
  return { exclusiveWindowsUpdate: patch?.settings.exclusiveWindowsUpdate ?? false };
}
```
If `resolvePatchConfigForDevice` is no longer imported anywhere in this file, remove it from the import.

**Warranty** (`:3248`):

```ts
export async function buildWarrantyConfigUpdate(deviceId: string, opts?: DeviceHierarchyOpts): Promise<WarrantySettings> {
  const inlineSettings = await resolveEffectiveWarrantyInlineSettings(deviceId, opts);
  return { hpCmslEnabled: warrantyHpCmslCollectionEffective(inlineSettings) };
}
```

**Helper** (`services/helperSettings.ts`). Make `buildHelperConfigUpdate(deviceId: string, orgId: string, opts?: DeviceHierarchyOpts)` and change its resolver call to `resolveDeviceHelperSettings(deviceId, opts)`. Nothing else changes in this task.

- [ ] **Step 4: Add a unit test pinning the patch-source read**

Append to `apps/api/src/routes/agents/helpers.agentUpdatePolicy.test.ts`, or to whichever `helpers*.test.ts` already mocks `../../services/featureConfigResolver`. Run `grep -l "featureConfigResolver" apps/api/src/routes/agents/helpers*.test.ts` to find it. If none mocks it, create `apps/api/src/routes/agents/helpers.patchSource.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';

const resolver = vi.hoisted(() => ({
  resolvePatchConfigPolicyForDevice: vi.fn(),
  resolvePatchConfigForDevice: vi.fn(),
}));
vi.mock('../../services/featureConfigResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/featureConfigResolver')>()),
  ...resolver,
}));

import { buildPatchSourceConfigUpdate } from './helpers';

describe('buildPatchSourceConfigUpdate (#8053 W1a-1)', () => {
  it('reads only the winning patch link, never the timezone-resolving details path', async () => {
    resolver.resolvePatchConfigPolicyForDevice.mockResolvedValue({ settings: { exclusiveWindowsUpdate: true } });
    await expect(buildPatchSourceConfigUpdate('device-1')).resolves.toEqual({ exclusiveWindowsUpdate: true });
    expect(resolver.resolvePatchConfigPolicyForDevice).toHaveBeenCalledWith('device-1', undefined);
    expect(resolver.resolvePatchConfigForDevice).not.toHaveBeenCalled();
  });

  it('no patch policy resolves to false (the agent reverts enforcement)', async () => {
    resolver.resolvePatchConfigPolicyForDevice.mockResolvedValue(null);
    await expect(buildPatchSourceConfigUpdate('device-1')).resolves.toEqual({ exclusiveWindowsUpdate: false });
  });
});
```
If importing `./helpers` drags in modules that need `../../db`, copy the `vi.mock('../../db', …)` block from `helpers.agentUpdatePolicy.test.ts` into the new file.

- [ ] **Step 5: Run everything that touches these builders**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts src/__tests__/integration/configPolicyPartnerLevelAssignments.integration.test.ts src/__tests__/integration/configPolicyPartnerWideSelect.integration.test.ts
cd apps/api && npx vitest run src/routes/agents/helpers src/routes/agents/heartbeat.test.ts src/routes/agents/elevationRequests src/middleware/helperAuth
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "exit=$?"
```
Expected: all pass, and the parity file reports 34 tests. The unit run must report a non-zero file count for each prefix. `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/services/helperSettings.ts apps/api/src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts apps/api/src/routes/agents/helpers.patchSource.test.ts
git commit -m "feat(api): heartbeat config builders accept a passed hierarchy; patch source skips timezone (#8053)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Heartbeat loads the hierarchy once and passes it to every resolver

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` — imports `:1-83`; OneDrive block `:2175-2195`; shared policy context `:2266-2380`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts` — new `vi.mock` near `:286`; new tests inside the describe that declares `pendingDevice` (`~:503`)
- Modify: `apps/api/src/routes/agents/networkContext.test.ts` — only if it fails (see Step 6)
- Modify: `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`

**Interfaces:**
- Consumes: `loadDeviceHierarchy`, `withHierarchy`, `type DeviceHierarchy` (Task 2); every `opts` parameter from Tasks 3–4.
- Produces: in `heartbeat.ts`, a local `beatHierarchy: DeviceHierarchy | null`. Task 7 reuses it.

- [ ] **Step 1: Write the failing budget assertions and behaviour guards**

In the budget suite's steady test, after the Task 1 assertion, add:

```ts
    // #8053 W1a-1 lever 1: one hierarchy read replaces 33 per-resolver reads.
    expect(steady.buckets.hierarchyLoad).toBe(1);
    expect(steady.buckets.deviceLookup).toBe(0);
    expect(steady.buckets.orgPartnerLookup).toBe(0);
    expect(steady.buckets.groupLookup).toBe(0);
    expect(steady.buckets.siteLookup).toBe(0);
    expect(warm.buckets.hierarchyLoad).toBe(1);
    expect(warm.buckets.deviceLookup).toBe(0);
```

Add imports and a policy seeder to the budget suite:

```ts
import {
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  enrollmentKeys,
} from '../../db/schema';

async function seedOrgPolicy(input: {
  orgId: string;
  featureType: 'helper' | 'event_log';
  inlineSettings?: Record<string, unknown>;
  maxEventsPerCycle?: number;
  level: 'device' | 'organization';
  targetId: string;
  roleFilter?: string[];
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: input.orgId, partnerId: null, name: `hotpath ${input.featureType} ${randomUUID()}`, status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: input.featureType,
      ...(input.inlineSettings ? { inlineSettings: input.inlineSettings } : {}),
    }).returning();
    if (input.maxEventsPerCycle !== undefined) {
      await db.insert(configPolicyEventLogSettings).values({
        featureLinkId: link!.id, retentionDays: 30, maxEventsPerCycle: input.maxEventsPerCycle,
      });
    }
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: input.level, targetId: input.targetId, priority: 0,
      ...(input.roleFilter ? { roleFilter: input.roleFilter } : {}),
    });
  });
}
```
(Replace the existing single-name `enrollmentKeys` import with this combined one.)

Add a new `describe` at the end of the file:

```ts
describe('heartbeat hierarchy pass-through (#8053 W1a-1) — behaviour guards, real PostgreSQL', () => {
  // These pass BEFORE and AFTER the change: they pin today's behaviour so the
  // pass-through cannot alter what an agent receives.

  runDb('a sibling\'s device-level helper policy never reaches another device in the same org', async () => {
    const org = await seedOrg('isolation');
    const device = await enrollDevice(org, 'plain');
    const sibling = await enrollDevice(org, 'helper-on');
    await seedOrgPolicy({
      orgId: org.orgId, featureType: 'helper', inlineSettings: { enabled: true },
      level: 'device', targetId: sibling.deviceId,
    });

    const siblingBody = await (await heartbeat(sibling)).json() as { helperEnabled: boolean };
    const deviceBody = await (await heartbeat(device)).json() as { helperEnabled: boolean };
    expect(siblingBody.helperEnabled).toBe(true);
    expect(deviceBody.helperEnabled).toBe(false);
  });

  runDb('a role this very beat writes is the role the policy resolvers see', async () => {
    const org = await seedOrg('role');
    const device = await enrollDevice(org, 'role');
    await seedOrgPolicy({
      orgId: org.orgId, featureType: 'event_log', maxEventsPerCycle: 777,
      level: 'organization', targetId: org.orgId, roleFilter: ['printer'],
    });

    const res = await heartbeat(device, { ...CURRENT_AGENT_HEARTBEAT, deviceRole: 'printer' });
    expect(res.status).toBe(200);
    const body = await res.json() as { configUpdate: { event_log_settings?: { max_events_per_cycle: number } } };
    expect(body.configUpdate.event_log_settings?.max_events_per_cycle).toBe(777);
  });
});
```

- [ ] **Step 2: Run and confirm which tests fail**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
Expected: the steady test FAILS at `expected 0 to be 1` (`hierarchyLoad`). Both new behaviour guards PASS on today's code. If either guard fails now, stop: the fixture is wrong (for example, enrollment already set `deviceRole` to `printer`, or the org-level legacy helper flag is on). Fix the fixture before changing the heartbeat.

- [ ] **Step 3: Wire the hierarchy into the heartbeat**

In `apps/api/src/routes/agents/heartbeat.ts`, add:

```ts
import { loadDeviceHierarchy, withHierarchy, type DeviceHierarchy } from '../../services/deviceHierarchy';
```

Replace the OneDrive block (`:2175-2195`, from `let onedriveSettings` through `captureException(err); }`) with:

```ts
  // #8053 W1a-1 — the device's policy hierarchy (device, org partner + type,
  // site, group ids), read ONCE for the whole beat and passed explicitly to
  // every post-commit resolver below. Before this, each of them re-read it:
  // 33 statements per beat.
  //
  // It is read HERE, as the first statement of the OneDrive system context,
  // rather than taken from the core device row or the agent context, because:
  //   - the agent context carries no organization type (featureConfigResolver
  //     and monitorResolver both need it);
  //   - the core row predates this beat's own `UPDATE devices`, which can
  //     change deviceRole — and role-filtered policies must see the new role,
  //     as they always have (these resolvers ran after commit);
  //   - the resolvers' own reads ran in SYSTEM scope; this does too, so RLS
  //     visibility is identical.
  // It is keyed on `scoped.deviceId` — the device the agent authenticated as,
  // read in the org context by agent.deviceId — and every resolver re-checks
  // that id (hierarchyFor throws on a mismatch).
  //
  // A failure here, or a device whose org changed since the org transaction,
  // leaves `beatHierarchy` null: every resolver then loads its own, exactly
  // as before this change.
  let beatHierarchy = null as DeviceHierarchy | null;
  let onedriveSettings: OnedriveConfigUpdate | null = null;
  try {
    onedriveSettings = await withSystemDbAccessContext(async () => {
      const loaded = await loadDeviceHierarchy(scoped.deviceId);
      beatHierarchy = loaded && loaded.orgId === scoped.deviceOrgId ? loaded : null;
      return buildOnedriveHelperConfigUpdate(scoped.deviceId, withHierarchy(beatHierarchy));
    });
  } catch (err) {
    console.error(`[agents] failed to load the device hierarchy or build onedrive_helper config update for ${agentId}:`, err);
    captureException(err);
  }
  const hierarchyOpts = withHierarchy(beatHierarchy);
```
Keep the existing `const onedriveConfigUpdate = …` line after it.

Inside the shared policy context (`:2268-2380`), change only the resolver calls:

```ts
        helperSettings = await withDbTransaction(() =>
          buildHelperConfigUpdate(scoped.deviceId, scoped.deviceOrgId, hierarchyOpts),
        );
```
```ts
        policyProbeConfig = await withDbTransaction(() =>
          buildPolicyProbeConfigUpdate(
            scoped.deviceOrgId,
            beatHierarchy?.org ? { partnerId: beatHierarchy.org.partnerId } : undefined,
          ),
        );
```
```ts
        eventLogSettings = await buildEventLogConfigUpdate(scoped.deviceId, hierarchyOpts);
        hardwareMonitoringSettings = await buildHardwareMonitoringConfigUpdate(scoped.deviceId, hierarchyOpts);
        monitoringSettings = await buildMonitoringConfigUpdate(scoped.deviceId, hierarchyOpts) as Record<string, unknown> | null;
        pamSettings = await buildPamConfigUpdate(scoped.deviceId, hierarchyOpts);
        patchSourceSettings = await buildPatchSourceConfigUpdate(scoped.deviceId, hierarchyOpts);
        warrantySettings = await buildWarrantyConfigUpdate(scoped.deviceId, hierarchyOpts);
        timeSyncSettings = await buildTimeSyncConfigUpdate(scoped.deviceId, hierarchyOpts);
```
(Each sits in its existing `try` block; only the argument list changes.) TypeScript may narrow `beatHierarchy` to `null` after the callback. The `as DeviceHierarchy | null` initializer prevents that, the same idiom the file already uses for `policyProbeConfig`.

- [ ] **Step 4: Keep `heartbeat.test.ts` isolated and add the wiring tests**

Near the other `vi.mock` calls (`~:286`), add:

```ts
// #8053 W1a-1 — the hierarchy is loaded in the OneDrive system context. Null by
// default: every mocked resolver then gets `undefined` opts, exactly as before.
vi.mock('../../services/deviceHierarchy', () => ({
  loadDeviceHierarchy: vi.fn(async () => null),
  withHierarchy: (h: unknown) => (h ? { hierarchy: h } : undefined),
}));
```

Inside the describe that declares `pendingDevice`, add:

```ts
  describe('#8053 W1a-1 hierarchy pass-through', () => {
    const hierarchy = {
      deviceId: 'device-1', orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'linux',
      org: { partnerId: 'partner-1', type: 'customer' },
      site: { id: 'site-1', name: 'HQ', timezone: 'UTC' },
      groupIds: ['group-1'],
    };

    function arrangeBeat() {
      selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));
      selectMock.mockReturnValue(selectChainResolving([]));
      updateMock.mockReturnValue({ set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })) });
      insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    }

    async function beat() {
      return buildApp().request('/agents/device-1/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(minimalHeartbeatBody),
      });
    }

    it('loads the hierarchy for the authenticated device and hands it to every resolver', async () => {
      const { loadDeviceHierarchy } = await import('../../services/deviceHierarchy');
      const helpers = await import('./helpers');
      vi.mocked(loadDeviceHierarchy).mockResolvedValueOnce(hierarchy as never);
      arrangeBeat();

      expect((await beat()).status).toBe(200);
      expect(loadDeviceHierarchy).toHaveBeenCalledWith('device-1');
      for (const builder of [
        helpers.buildEventLogConfigUpdate, helpers.buildHardwareMonitoringConfigUpdate,
        helpers.buildMonitoringConfigUpdate, helpers.buildPamConfigUpdate,
        helpers.buildPatchSourceConfigUpdate, helpers.buildWarrantyConfigUpdate,
        helpers.buildTimeSyncConfigUpdate, helpers.buildOnedriveHelperConfigUpdate,
      ]) {
        expect(vi.mocked(builder)).toHaveBeenCalledWith('device-1', expect.objectContaining({ hierarchy }));
      }
      expect(vi.mocked(helpers.buildHelperConfigUpdate))
        .toHaveBeenCalledWith('device-1', 'org-1', expect.objectContaining({ hierarchy }));
      expect(vi.mocked(helpers.buildPolicyProbeConfigUpdate)).toHaveBeenCalledWith('org-1', { partnerId: 'partner-1' });
    });

    it('drops a hierarchy whose org is not the beat\'s org (device moved mid-beat): resolvers load their own', async () => {
      const { loadDeviceHierarchy } = await import('../../services/deviceHierarchy');
      const helpers = await import('./helpers');
      vi.mocked(loadDeviceHierarchy).mockResolvedValueOnce({ ...hierarchy, orgId: 'org-2' } as never);
      arrangeBeat();

      expect((await beat()).status).toBe(200);
      expect(vi.mocked(helpers.buildEventLogConfigUpdate)).toHaveBeenCalledWith('device-1', undefined);
      expect(vi.mocked(helpers.buildPolicyProbeConfigUpdate)).toHaveBeenCalledWith('org-1', undefined);
    });
  });
```

- [ ] **Step 5: Run the budget suite and the mutation check**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
Expected: all tests PASS. The steady line prints `statements: 35`; the warm line prints `statements: 28`.

Mutation check for Review Focus 2 (do not commit it). In `loadDeviceHierarchy`, temporarily replace `deviceRole: row.deviceRole,` with `deviceRole: 'unknown',` and rerun the suite. Expected: `a role this very beat writes …` FAILS with `expected 100 to be 777`. Revert, rerun, all green.

- [ ] **Step 6: Run the heartbeat unit suites**

```bash
cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts src/routes/agents/networkContext.test.ts src/routes/agents.test.ts src/routes/agents/heartbeatParked
```
Expected: all PASS. `networkContext.test.ts` and `agents.test.ts` mount the real heartbeat with a mocked `db`. If either fails because `loadDeviceHierarchy` consumed a select-mock value it did not expect, add the same `vi.mock('../../services/deviceHierarchy', …)` block (adjust the relative path) to that file. Do not change production code to satisfy a mock.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts apps/api/src/routes/agents/networkContext.test.ts apps/api/src/routes/agents.test.ts
git commit -m "perf(api): heartbeat reads the device hierarchy once for all policy resolvers (#8053)

Steady beat 67 -> 35 statements, 3 transactions.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Skip topology negotiation when materialization is off

**Files:**
- Modify: `apps/api/src/services/topology/heartbeat.ts` (whole file, 38 lines)
- Modify: `apps/api/src/services/topology/heartbeat.test.ts`
- Create: `apps/api/src/__tests__/integration/topologyHeartbeatMaterializationOff.integration.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts:1` (import), `:2021-2041` (topology call)
- Modify: `apps/api/src/routes/agents/networkContext.test.ts:120-122` (mock surface)
- Modify: budget suite

**Interfaces:**
- Produces: `type TopologyProducerRow = { isEphemeral: boolean; agentTokenSuspendedAt: Date | null; agentTokenHash: string | null }`; `topologyHeartbeatWithoutMaterialization(device: TopologyProducerRow, input: { networkContextV1?: unknown; networkContextReset?: unknown }): { config: { acceptedNetworkContextVersions: number[] }; receipt: TopologyIngestReceipt | undefined }`. It throws `Error('producer_unavailable')` on the same three conditions as `activeDevice()` (`collectionAuthority.ts:19-25`).

- [ ] **Step 1: Write the failing unit parity test**

Append to `apps/api/src/services/topology/heartbeat.test.ts`. Change its import to `import { topologyHeartbeat, topologyHeartbeatWithoutMaterialization } from './heartbeat';` and add:

```ts
// #8053 W1a-1 — with materialization off, negotiateTopologyContext returns
// exactly `{ acceptedNetworkContextVersions: [] }` (collectionAuthority.ts
// `if (!flags.materialization) return …`). The skip path must hand the agent
// the same config and the same receipt for every input, without the DB.
describe('topologyHeartbeatWithoutMaterialization parity', () => {
  const liveRow = { isEphemeral: false, agentTokenSuspendedAt: null, agentTokenHash: 'a'.repeat(64) };
  const disabledConfig = { acceptedNetworkContextVersions: [] as number[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.negotiate.mockResolvedValue(disabledConfig);
  });

  it.each([
    ['no report', {}, null],
    ['an unparseable report with a sequence', { networkContextV1: { sequence: '42', junk: true } }, { accepted: false, reason: 'invalid_report' }],
    ['an unsupported version', { networkContextV1: { version: 2 } }, { accepted: false, reason: 'unsupported_major_version' }],
    ['a parseable report', { networkContextV1: { sequence: '9' } }, { accepted: true, report: { sequence: '9' } }],
    ['a malformed sequence', { networkContextV1: { sequence: -1 } }, { accepted: false, reason: 'invalid_report' }],
  ] as const)('matches the negotiated path for %s', async (_name, input, parsed) => {
    if (parsed) mocks.parse.mockReturnValue(parsed);
    const negotiated = await topologyHeartbeat(device, input);
    const skipped = topologyHeartbeatWithoutMaterialization(liveRow, input);
    expect(skipped).toEqual(negotiated);
    expect(JSON.stringify(skipped.config)).toBe('{"acceptedNetworkContextVersions":[]}');
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it.each([
    ['ephemeral (Quick Support)', { ...liveRow, isEphemeral: true }],
    ['token suspended', { ...liveRow, agentTokenSuspendedAt: new Date() }],
    ['no agent token', { ...liveRow, agentTokenHash: null }],
  ])('throws producer_unavailable for a %s device, as negotiation does', (_name, row) => {
    expect(() => topologyHeartbeatWithoutMaterialization(row, {})).toThrow('producer_unavailable');
  });

  it('the negotiated path no longer opens its own savepoint (the caller\'s isolates it)', async () => {
    const transaction = vi.fn((run: () => unknown) => run());
    const { db } = await import('../../db');
    (db as unknown as { transaction: unknown }).transaction = transaction;
    await topologyHeartbeat(device, {});
    expect(transaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/topology/heartbeat.test.ts`
Expected: FAIL. `topologyHeartbeatWithoutMaterialization is not a function`, and the savepoint test fails with `expected "spy" to not be called`.

- [ ] **Step 3: Implement**

Replace `apps/api/src/services/topology/heartbeat.ts` with:

```ts
import { parseNetworkContextReport } from '@breeze/shared';
import { assertInTransaction } from '../../db';
import { negotiateTopologyContext } from './collectionAuthority';
import { ingestTopologyNetworkContext } from './collectionIngest';
import type { TopologyIngestReceipt } from './collectionTypes';

type Input={networkContextV1?:unknown;networkContextReset?:unknown};
type NegotiatedConfig=Awaited<ReturnType<typeof negotiateTopologyContext>>;
const EXPECTED_INGEST_REJECTIONS=new Set(['producer_epoch_changed','producer_scope_changed','producer_unavailable','content_digest_mismatch','section_digest_mismatch','materialization_disabled']);

/** Report-local savepoints keep malformed topology data from breaking legacy
 * heartbeat delivery. Authority always comes from the authenticated device.
 * The CALLER isolates this call in its own savepoint (heartbeat.ts); a second,
 * inner one around negotiation bought nothing — a negotiation error aborts the
 * whole call either way (#8053 W1a-1). Ingest keeps its own. */
export async function topologyHeartbeat(device:{id:string;orgId:string;siteId:string},input:Input){
  assertInTransaction('topologyHeartbeat');
  const reset=input.networkContextReset;
  const previousEpoch=reset&&typeof reset==='object'&&'previousEpoch' in reset&&typeof reset.previousEpoch==='string'&&reset.previousEpoch.length<=255?reset.previousEpoch:undefined;
  const config=await negotiateTopologyContext(device.id,previousEpoch?{previousEpoch}:undefined);
  let receipt:TopologyIngestReceipt|undefined;
  if(input.networkContextV1!==undefined){
    const parsed=parseNetworkContextReport(input.networkContextV1);
    if(!parsed.accepted)receipt={accepted:false,reason:parsed.reason,sourceReceipts:[]};
    else if(!config.producerEpoch)receipt={accepted:false,reason:'materialization_disabled',sourceReceipts:[]};
    else try{
      receipt=await ingestTopologyNetworkContext({scope:{orgId:device.orgId,siteId:device.siteId},producerId:device.id,producerKind:'agent',producerEpoch:config.producerEpoch,
        configurationRevision:config.configurationRevision!,sourceIdentity:config.sourceIdentity!},parsed.report);
    }catch(error){
      const reason=error instanceof Error?error.message:'';
      if(!EXPECTED_INGEST_REJECTIONS.has(reason))throw error;
      receipt={producerEpoch:config.producerEpoch,accepted:false,reason,sourceReceipts:[]};
    }
  }
  return {config,receipt:nameReceipt(receipt,input,config)};
}

/** The device-row facts negotiateTopologyContext's activeDevice() refuses on. */
export type TopologyProducerRow={isEphemeral:boolean;agentTokenSuspendedAt:Date|null;agentTokenHash:string|null};

/** #8053 W1a-1 — what topologyHeartbeat returns when the org's materialization
 * flag is off, without the DB: negotiation then answers `{acceptedNetworkContextVersions:[]}`
 * and ingests nothing. The one DB-dependent outcome on that path — the
 * activeDevice() refusal — is re-derived from the caller's device row and
 * thrown with the same message, so the caller's catch behaves identically. */
export function topologyHeartbeatWithoutMaterialization(device:TopologyProducerRow,input:Input){
  if(device.isEphemeral||device.agentTokenSuspendedAt!==null||!device.agentTokenHash)throw new Error('producer_unavailable');
  const config:NegotiatedConfig={acceptedNetworkContextVersions:[]};
  let receipt:TopologyIngestReceipt|undefined;
  if(input.networkContextV1!==undefined){
    const parsed=parseNetworkContextReport(input.networkContextV1);
    receipt=parsed.accepted?{accepted:false,reason:'materialization_disabled',sourceReceipts:[]}:{accepted:false,reason:parsed.reason,sourceReceipts:[]};
  }
  return {config,receipt:nameReceipt(receipt,input,config)};
}

// The agent discards a rejected capture only when the rejection names it;
// an unnamed rejection leaves it resending the same bytes every heartbeat.
function nameReceipt(receipt:TopologyIngestReceipt|undefined,input:Input,config:NegotiatedConfig){
  if(receipt){
    const claimed=input.networkContextV1&&typeof input.networkContextV1==='object'&&'sequence' in input.networkContextV1?input.networkContextV1.sequence:undefined;
    if(typeof claimed==='string'&&/^(0|[1-9]\d{0,19})$/.test(claimed))receipt.reportSequence=claimed;
    if(config.producerEpoch)receipt.producerEpoch??=config.producerEpoch;
  }
  return receipt;
}
```
If `tsc` rejects the `NegotiatedConfig` annotation on the literal, annotate it as `{acceptedNetworkContextVersions:number[];producerEpoch?:undefined}` and widen `nameReceipt`'s parameter to `{producerEpoch?:string}`. The emitted JSON must stay `{"acceptedNetworkContextVersions":[]}`, which the unit test pins.

In `apps/api/src/routes/agents/heartbeat.ts`, change the import on line 1 to `import { topologyHeartbeat, topologyHeartbeatWithoutMaterialization } from '../../services/topology/heartbeat';` and replace the body of the `try` at `:2025-2034`:

```ts
    try {
      const resolvedFlags = topologyFlags;
      // #8053 W1a-1 — with materialization off, negotiation can only answer
      // "not accepted" and ingest nothing; computing that needs no DB and no
      // savepoint. Its one refusal (an ephemeral, suspended or tokenless
      // device) is re-derived from `device` and thrown the same way, so the
      // catch below — collection_unavailable + Sentry — is unchanged.
      const topology = resolvedFlags.materialization
        ? await withResolvedTopologyFlags(
          { orgId: agent.orgId, flags: resolvedFlags },
          () => db.transaction(() => topologyHeartbeat(device, data)),
        )
        : topologyHeartbeatWithoutMaterialization(device, data);
      mergedConfigUpdate.networkContext = topology.config;
      networkContextReceipt = topology.receipt;
    } catch (error) {
```

In `apps/api/src/routes/agents/networkContext.test.ts`, extend the mock:

```ts
vi.mock('../../services/topology/heartbeat', () => ({
  topologyHeartbeat: topologyHeartbeatMock,
  topologyHeartbeatWithoutMaterialization: vi.fn(),
}));
```

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/api && npx vitest run src/services/topology/heartbeat.test.ts src/routes/agents/networkContext.test.ts src/routes/agents/heartbeat.test.ts`
Expected: all PASS.

- [ ] **Step 5: Write the real-Postgres parity test**

`apps/api/src/__tests__/integration/topologyHeartbeatMaterializationOff.integration.test.ts`:

```ts
/**
 * #8053 W1a-1 — the heartbeat's materialization-off skip returns exactly what
 * the real negotiation returns with materialization off, against real
 * PostgreSQL, including the ephemeral / suspended refusal.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withDbTransaction, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { withResolvedTopologyFlags, resolveTopologyFlags } from '../../services/topology/flags';
import { topologyHeartbeat, topologyHeartbeatWithoutMaterialization } from '../../services/topology/heartbeat';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const OFF = resolveTopologyFlags({});

async function seedDevice(over: Partial<{ isEphemeral: boolean; agentTokenSuspendedAt: Date | null; agentTokenHash: string | null }>) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const unique = randomUUID().slice(0, 8);
    const [row] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `topo-off-${unique}`, hostname: `topo-off-${unique}`,
      osType: 'linux', osVersion: '22.04', architecture: 'amd64', agentVersion: '0.0.0-test', status: 'online',
      agentTokenHash: 'b'.repeat(64), ...over,
    }).returning();
    return row!;
  });
}

async function negotiated(device: typeof devices.$inferSelect, input: Record<string, unknown>) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    withResolvedTopologyFlags({ orgId: device.orgId, flags: OFF }, () =>
      withDbTransaction(() => topologyHeartbeat(device, input))));
}

describe('topology heartbeat with materialization off (#8053 W1a-1) — real PostgreSQL', () => {
  for (const [name, input] of [
    ['no report', {}],
    ['an unsupported report version', { networkContextV1: { version: 99, sequence: '5' } }],
    ['an invalid report', { networkContextV1: { version: 1, sequence: '6', junk: true } }],
  ] as const) {
    runDb(`a live device: same config and receipt for ${name}`, async () => {
      const device = await seedDevice({});
      const [fresh] = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(devices).where(eq(devices.id, device.id)));
      expect(topologyHeartbeatWithoutMaterialization(fresh!, input)).toEqual(await negotiated(fresh!, input));
    });
  }

  for (const [name, over] of [
    ['an ephemeral (Quick Support) device', { isEphemeral: true }],
    ['a token-suspended device', { agentTokenSuspendedAt: new Date() }],
    ['a tokenless device', { agentTokenHash: null }],
  ] as const) {
    runDb(`${name}: both paths refuse with producer_unavailable`, async () => {
      const device = await seedDevice(over);
      await expect(negotiated(device, {})).rejects.toThrow('producer_unavailable');
      expect(() => topologyHeartbeatWithoutMaterialization(device, {})).toThrow('producer_unavailable');
    });
  }
});
```

- [ ] **Step 6: Add the budget assertions, then run both integration files**

In the budget suite's steady test, add:

```ts
    // Lever 2: materialization is off for this org, so no negotiation runs.
    expect(steady.buckets.topologyNegotiation).toBe(0);
    expect(warm.buckets.topologyNegotiation).toBe(0);
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/topologyHeartbeatMaterializationOff.integration.test.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts src/__tests__/integration/topologyBaselinePublication.integration.test.ts src/__tests__/integration/topologyFleetAcceptance.integration.test.ts
```
Expected: all PASS. Budget steady prints `statements: 32`, `savepoints: 3`; warm prints 25. The two existing topology suites prove the savepoint removal did not break the materialization-on path.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/topology/heartbeat.ts apps/api/src/services/topology/heartbeat.test.ts apps/api/src/__tests__/integration/topologyHeartbeatMaterializationOff.integration.test.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/networkContext.test.ts apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
git commit -m "perf(api): heartbeat skips topology negotiation when materialization is off (#8053)

Steady beat 35 -> 32 statements; identical networkContext config and receipt.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Per-org caches filled from the shared system context; no empty savepoints

**Files:**
- Modify: `apps/api/src/services/hotPathCache.ts` (contract doc `:7-46`; class `:56-127`)
- Modify: `apps/api/src/services/hotPathCache.test.ts` (db mock `:8-16`; new tests)
- Modify: `apps/api/src/services/agentOrgSettingsCache.ts`
- Modify: `apps/api/src/services/helperSettings.ts` (`buildHelperConfigUpdate` `:184-217`)
- Modify: `apps/api/src/routes/agents/helpers.ts` (`resolveOrgPamFallback` `:3072`, `resolveDevicePamSettings`, `buildPamConfigUpdate` `:3167`, re-export `:3059`)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (shared policy context `:2266-2300`)
- Modify: `apps/api/src/routes/policyManagement/actions.ts:77-90` (+ `actions.test.ts`)
- Modify: `apps/api/src/routes/agents/mtls.ts:1781-1788` (+ `mtls.test.ts`)
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts` (db mock `:40-78`, helpers mock `:180-228`, file-level `beforeEach`)
- Modify: budget suite (helper fault mock `:68-80`; assertions)

**Interfaces:**
- Produces in `hotPathCache.ts`: `HotPathTtlCache.peek(key): V | undefined`; `.ticket(): number`; `.fillIfCurrent(key, value, ticket): void` (throws inside a DB context); `class DeferredCacheFills { through<K, V>(cache: HotPathTtlCache<K, V>, key: K, load: () => Promise<V>): Promise<V>; flush(): void }`.
- Produces in `agentOrgSettingsCache.ts`: `orgPolicyProbeCache: HotPathTtlCache<string, PolicyProbeConfigUpdate | null>`, `orgHelperSettingsCache: HotPathTtlCache<string, { enabled: boolean }>`, `orgPamFallbackCache: HotPathTtlCache<string, PamSettings>`, `invalidateOrgPolicyProbeCache(orgId?: string): void`, `invalidateOrgHelperSettingsCache(orgId: string): void`; `invalidateAgentOrgSettingsCaches` also clears `orgHelperSettingsCache`.
- Produces in `helperSettings.ts`: `readCachedHelperSettings(deviceId): Promise<HelperSettings | null>`; `interface HelperConfigUpdateOptions extends DeviceHierarchyOpts { skipCacheRead?: boolean; loadOrgHelperSettings?: (orgId: string) => Promise<{ enabled: boolean }> }`; `buildHelperConfigUpdate(deviceId, orgId, opts?: HelperConfigUpdateOptions)`.
- Produces in `helpers.ts`: `export async function resolveOrgPamFallback(orgId: string): Promise<PamSettings>`; `interface PamConfigUpdateOptions extends DeviceHierarchyOpts { loadOrgPamFallback?: (orgId: string) => Promise<PamSettings> }`; `buildPamConfigUpdate(deviceId, opts?: PamConfigUpdateOptions)`; re-export of `readCachedHelperSettings`.
- V must not include `undefined`: `peek` uses `undefined` to mean a miss.

- [ ] **Step 1: Write the failing cache unit tests**

In `apps/api/src/services/hotPathCache.test.ts`, extend the hoisted state and mock:

```ts
const dbState = vi.hoisted(() => ({
  inContext: false,
  deferred: [] as Array<() => unknown>,
  scope: undefined as 'system' | 'organization' | 'partner' | undefined,
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => dbState.inContext,
  getCurrentDbAccessContext: () => (dbState.scope ? { scope: dbState.scope } : undefined),
  runAfterDbContextExit: (_label: string, work: () => unknown) => {
    if (dbState.inContext) dbState.deferred.push(work);
    else work();
  },
}));

import { DeferredCacheFills, HotPathTtlCache, __resetHotPathCachesForTests } from './hotPathCache';
```
Reset `dbState.scope = undefined;` in the existing `beforeEach`. Add:

```ts
describe('HotPathTtlCache deferred fills (#8053 W1a-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    dbState.inContext = false;
    dbState.scope = undefined;
  });
  afterEach(() => vi.useRealTimers());

  it('peek never loads and honours the TTL', async () => {
    const cache = makeCache({ ttlMs: 1_000 });
    expect(cache.peek('a')).toBeUndefined();
    await cache.getOrLoad('a', async () => ({ v: '1' }));
    expect(cache.peek('a')).toEqual({ v: '1' });
    vi.setSystemTime(T0 + 1_001);
    expect(cache.peek('a')).toBeUndefined();
  });

  it('fillIfCurrent stores only when no invalidate() ran since the ticket', () => {
    const cache = makeCache();
    const ticket = cache.ticket();
    cache.fillIfCurrent('a', { v: '1' }, ticket);
    expect(cache.peek('a')).toEqual({ v: '1' });

    const stale = cache.ticket();
    cache.invalidate('b');
    cache.fillIfCurrent('a', { v: '2' }, stale);
    expect(cache.peek('a')).toEqual({ v: '1' });
  });

  it('fillIfCurrent refuses to run inside a DB context (the load has not committed)', () => {
    const cache = makeCache();
    dbState.inContext = true;
    expect(() => cache.fillIfCurrent('a', { v: '1' }, cache.ticket())).toThrow(/inside a DB context/);
  });

  it('through: a hit never loads; a miss in a SYSTEM context loads now and stores only on flush', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.inContext = true;
    dbState.scope = 'system';
    const load = vi.fn(async () => ({ v: 'loaded' }));

    await expect(fills.through(cache, 'org-1', load)).resolves.toEqual({ v: 'loaded' });
    expect(cache.peek('org-1')).toBeUndefined();

    dbState.inContext = false;
    fills.flush();
    expect(cache.peek('org-1')).toEqual({ v: 'loaded' });

    dbState.inContext = true;
    await fills.through(cache, 'org-1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('through under an ORG-scoped context loads but never caches (a narrower RLS answer)', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.inContext = true;
    dbState.scope = 'organization';
    await fills.through(cache, 'org-1', async () => ({ v: 'partial' }));
    dbState.inContext = false;
    fills.flush();
    expect(cache.peek('org-1')).toBeUndefined();
  });

  it('through: a failed load queues nothing; an invalidate before flush wins', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.inContext = true;
    dbState.scope = 'system';
    await expect(fills.through(cache, 'org-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await fills.through(cache, 'org-2', async () => ({ v: 'pre-commit' }));
    cache.invalidate('org-2');
    dbState.inContext = false;
    fills.flush();
    expect(cache.peek('org-1')).toBeUndefined();
    expect(cache.peek('org-2')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/hotPathCache.test.ts`
Expected: FAIL. `cache.peek is not a function`, and `DeferredCacheFills` is not exported.

- [ ] **Step 3: Implement the cache primitives**

In `apps/api/src/services/hotPathCache.ts`, change the import to `import { getCurrentDbAccessContext, hasDbAccessContext, runAfterDbContextExit } from '../db';`. In the contract comment, replace the "Only top-level reads are cached" bullet with:

```ts
 * - **Only top-level reads are cached — with one exception.** Inside an ambient
 *   DB context `getOrLoad` bypasses the cache entirely (the loader would join
 *   the caller's transaction: its RLS scope and its uncommitted writes). The
 *   exception is `DeferredCacheFills` (#8053 W1a-1): a hot path that already
 *   runs inside a SYSTEM-scoped context with no writes of its own can load a
 *   per-org value there, and the value is stored only after that context has
 *   committed, through `fillIfCurrent`, which keeps the invalidation-race rule
 *   below. A load under any narrower scope is returned but never stored.
```

Add to `class HotPathTtlCache` (after `invalidateAroundCommit`):

```ts
  /** The cached value, or undefined on a miss. Never loads and never touches the DB. */
  peek(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt > Date.now()) return hit.value;
    this.entries.delete(key);
    return undefined;
  }

  /** Generation stamp for a load the caller runs itself; pass it to fillIfCurrent. */
  ticket(): number {
    return this.generation;
  }

  /**
   * Store a value the caller loaded itself, iff no invalidate() ran since
   * `ticket`. Must be called OUTSIDE any DB context: the load's transaction
   * has to have committed, or a rolled-back read could be cached.
   */
  fillIfCurrent(key: K, value: V, ticket: number): void {
    if (hasDbAccessContext()) {
      throw new Error(`HotPathTtlCache ${this.name}: fillIfCurrent called inside a DB context`);
    }
    if (ticket !== this.generation) return;
    this.set(key, value);
  }
```

Add after the class:

```ts
/**
 * Read-through for a hot path that runs INSIDE a system-scoped context
 * (#8053 W1a-1: the heartbeat's shared post-commit policy context). A hit
 * returns at once with no load. A miss loads in the caller's transaction, as
 * the code did before it was cached, and queues the fill. The caller calls
 * `flush()` once, after that context has committed. A miss under a non-system
 * scope still loads and returns, but is never stored: an RLS-narrowed answer
 * must not be served to the rest of the org.
 *
 * Caller contract: the context must have made no writes the loaded rows could
 * observe, and the value must be a function of `key` alone.
 */
export class DeferredCacheFills {
  private readonly pending: Array<() => void> = [];

  async through<K, V>(cache: HotPathTtlCache<K, V>, key: K, load: () => Promise<V>): Promise<V> {
    const hit = cache.peek(key);
    if (hit !== undefined) return hit;
    const cacheable = getCurrentDbAccessContext()?.scope === 'system';
    const ticket = cache.ticket();
    const value = await load();
    if (cacheable) this.pending.push(() => cache.fillIfCurrent(key, value, ticket));
    return value;
  }

  flush(): void {
    for (const fill of this.pending.splice(0)) fill();
  }
}
```

Run: `cd apps/api && npx vitest run src/services/hotPathCache.test.ts`
Expected: all PASS.

- [ ] **Step 4: Add the three caches**

Append to `apps/api/src/services/agentOrgSettingsCache.ts`:

```ts
import type { PolicyProbeConfigUpdate } from '../routes/agents/schemas';
import type { PamSettings } from '../routes/agents/pamSettings';

/**
 * #8053 W1a-1 — three per-org reads the heartbeat's shared policy context made
 * on every beat. Filled through `DeferredCacheFills` from inside that SYSTEM
 * context (so a miss costs what the read cost before, and no extra
 * transaction), served for AGENT_ORG_SETTINGS_CACHE_TTL_MS. Keyed by org id,
 * the full scope of each value. Nothing here is secret.
 *
 * Staleness on OTHER API instances is up to one TTL (60 s) — process-local
 * invalidation only until W1b. On the writing instance:
 *   - policy probe (automation_policies rules, org-owned + the partner's
 *     partner-wide): POST /policies/:id/deactivate invalidates — the only
 *     production write that changes it. Partner-wide → every org.
 *   - helper legacy flag (organizations.settings.helper.enabled):
 *     PATCH /agents/org/:orgId/settings/helper, plus the org/partner settings
 *     routes via invalidateAgentOrgSettingsCaches. It already sits behind the
 *     120 s per-device Redis helper cache.
 *   - PAM org fallback (pam_org_config.uac_interception_enabled): NO route
 *     writes it today (PUT /pam/config writes default_unmatched_verdict only;
 *     the column is set by migration 2026-07-01). TTL only. A future writer
 *     must call `orgPamFallbackCache.invalidateAroundCommit(orgId)`.
 */
export const orgPolicyProbeCache = new HotPathTtlCache<string, PolicyProbeConfigUpdate | null>({
  name: 'org-policy-probe',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

export const orgHelperSettingsCache = new HotPathTtlCache<string, { enabled: boolean }>({
  name: 'org-helper-legacy-settings',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

export const orgPamFallbackCache = new HotPathTtlCache<string, PamSettings>({
  name: 'org-pam-fallback',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

/** Without an org id (a partner-wide policy changed) every org is dropped. */
export function invalidateOrgPolicyProbeCache(orgId?: string): void {
  orgPolicyProbeCache.invalidateAroundCommit(orgId);
}

export function invalidateOrgHelperSettingsCache(orgId: string): void {
  orgHelperSettingsCache.invalidateAroundCommit(orgId);
}
```
In the existing `invalidateAgentOrgSettingsCaches`, add `orgHelperSettingsCache.invalidateAroundCommit(orgId);`. Move the two new `import type` lines to the top of the file with the existing imports.

- [ ] **Step 5: Injectable loaders in the helper and PAM resolvers**

In `apps/api/src/services/helperSettings.ts`, replace `buildHelperConfigUpdate` (`:184-217`) with:

```ts
export interface HelperConfigUpdateOptions extends DeviceHierarchyOpts {
  /** The caller already read the Redis entry this beat (and missed). */
  skipCacheRead?: boolean;
  /** Source of the legacy organizations.settings.helper flag; defaults to getOrgHelperSettings. */
  loadOrgHelperSettings?: (orgId: string) => Promise<{ enabled: boolean }>;
}

function helperCacheKey(deviceId: string): string {
  return `helper:settings:device:${deviceId}`;
}

/** The device's cached helper settings, or null on a miss or a Redis error. */
export async function readCachedHelperSettings(deviceId: string): Promise<HelperSettings | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const cached = await redis.get(helperCacheKey(deviceId));
    return cached ? JSON.parse(cached) as HelperSettings : null;
  } catch (cacheErr) {
    console.warn(`[helper] Redis cache read failed for device ${deviceId}:`, cacheErr);
    return null;
  }
}

export async function buildHelperConfigUpdate(
  deviceId: string,
  orgId: string,
  opts?: HelperConfigUpdateOptions,
): Promise<HelperSettings> {
  if (!opts?.skipCacheRead) {
    const cached = await readCachedHelperSettings(deviceId);
    if (cached) return cached;
  }

  // Try config policy resolution first
  let settings = await resolveDeviceHelperSettings(deviceId, opts);

  // Legacy org-level fallback applies ONLY when no policy matched at all. An
  // explicit enabled:false policy must win over organizations.settings.helper
  // (previously `!settings.enabled` fell through, and the fallback also
  // discarded the four resolved UI fields).
  //
  // A failed read (policy resolution above, or the org flag here) throws and
  // is never cached: it must not turn into a cached enabled:false, which
  // helperAuth would serve as helper_disabled and the heartbeat would deliver
  // as an uninstall. Only Redis errors are soft.
  if (settings === null) {
    const loadOrg = opts?.loadOrgHelperSettings ?? getOrgHelperSettings;
    const orgEnabled = (await loadOrg(orgId)).enabled;
    settings = { ...HELPER_DEFAULTS, enabled: orgEnabled };
  }

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(helperCacheKey(deviceId), JSON.stringify(settings), 'EX', HELPER_CACHE_TTL_SECONDS);
    } catch (cacheErr) {
      console.warn(`[helper] Redis cache write failed for device ${deviceId}:`, cacheErr);
    }
  }

  return settings;
}
```

In `apps/api/src/routes/agents/helpers.ts`:
- Change `async function resolveOrgPamFallback` to `export async function resolveOrgPamFallback`.
- Add `readCachedHelperSettings` to the re-export at `:3059`.
- Add, above `resolveDevicePamSettings`:

```ts
export interface PamConfigUpdateOptions extends DeviceHierarchyOpts {
  /** Source of the org grandfather flag; defaults to resolveOrgPamFallback. */
  loadOrgPamFallback?: (orgId: string) => Promise<PamSettings>;
}
```
- Change `resolveDevicePamSettings(deviceId: string, opts?: PamConfigUpdateOptions)`. Add `const orgFallback = opts?.loadOrgPamFallback ?? resolveOrgPamFallback;` after the device check, and replace both `return resolveOrgPamFallback(device.orgId);` with `return orgFallback(device.orgId);`.
- Change `buildPamConfigUpdate(deviceId: string, opts?: PamConfigUpdateOptions)` to pass `opts` through.

- [ ] **Step 6: Wire the caches into the heartbeat**

In `apps/api/src/routes/agents/heartbeat.ts`, add the imports:

```ts
import { DeferredCacheFills } from '../../services/hotPathCache';
import { orgHelperSettingsCache, orgPamFallbackCache, orgPolicyProbeCache } from '../../services/agentOrgSettingsCache';
```
Add `getOrgHelperSettings`, `readCachedHelperSettings` and `resolveOrgPamFallback` to the existing `./helpers` import.

Just before `policyConfigs = await withSystemDbAccessContext(…)`, add:

```ts
  // #8053 W1a-1 — per-org reads served from 60 s process caches. A miss loads
  // inside the shared system context below, as before; the fills are stored
  // only after that context commits (orgCacheFills.flush()).
  const orgCacheFills = new DeferredCacheFills();
  const probePartnerOpts = beatHierarchy?.org ? { partnerId: beatHierarchy.org.partnerId } : undefined;
```

Replace the helper and probe `try` blocks inside the context:

```ts
      // The Redis read runs BEFORE the savepoint, so a hit costs no SAVEPOINT
      // statement. A miss resolves inside its own savepoint, as before (a SQL
      // error there must not abort the shared transaction — see above).
      try {
        const cachedHelper = await readCachedHelperSettings(scoped.deviceId);
        helperSettings = cachedHelper ?? await withDbTransaction(() =>
          buildHelperConfigUpdate(scoped.deviceId, scoped.deviceOrgId, {
            ...hierarchyOpts,
            skipCacheRead: true,
            loadOrgHelperSettings: (orgId) =>
              orgCacheFills.through(orgHelperSettingsCache, orgId, () => getOrgHelperSettings(orgId)),
          }),
        );
      } catch (err) {
        console.error(`[agents] failed to read helper settings for ${agentId}:`, err);
        captureException(err);
      }

      try {
        const cachedProbe = orgPolicyProbeCache.peek(scoped.deviceOrgId);
        policyProbeConfig = cachedProbe !== undefined
          ? cachedProbe
          : await withDbTransaction(() =>
            orgCacheFills.through(orgPolicyProbeCache, scoped.deviceOrgId, () =>
              buildPolicyProbeConfigUpdate(scoped.deviceOrgId, probePartnerOpts)),
          );
      } catch (err) {
        console.error(`[agents] failed to build policy probe config update for ${agentId}:`, err);
        captureException(err);
      }
```
Replace the PAM call:

```ts
        pamSettings = await buildPamConfigUpdate(scoped.deviceId, {
          ...hierarchyOpts,
          loadOrgPamFallback: (orgId) =>
            orgCacheFills.through(orgPamFallbackCache, orgId, () => resolveOrgPamFallback(orgId)),
        });
```
Directly after `policyConfigs = await withSystemDbAccessContext(…);` (still inside the outer `try`, so a failed commit never flushes), add:

```ts
    orgCacheFills.flush();
```

- [ ] **Step 7: Invalidate from the write routes**

`apps/api/src/routes/policyManagement/actions.ts`. Add `import { invalidateOrgPolicyProbeCache } from '../../services/agentOrgSettingsCache';`. After the `if (updated && owner) scheduleComplianceAlertReconcile(…)` line, add:

```ts
    // Every agent of this org (every org, for a partner-wide policy) gets this
    // policy's probes from a 60 s per-org heartbeat cache (#8053).
    if (updated) invalidateOrgPolicyProbeCache(policy.orgId ?? undefined);
```

`apps/api/src/routes/agents/mtls.ts`. Add `import { invalidateOrgHelperSettingsCache } from '../../services/agentOrgSettingsCache';`. After the `await db.update(organizations)…where(eq(organizations.id, orgId));` in the helper PATCH, add:

```ts
    // The legacy flag is served to the org's heartbeats from a 60 s cache (#8053).
    invalidateOrgHelperSettingsCache(orgId);
```

Route tests. In `apps/api/src/routes/policyManagement/actions.test.ts`, add:

```ts
const invalidateProbeMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/agentOrgSettingsCache', () => ({
  invalidateOrgPolicyProbeCache: invalidateProbeMock,
}));
```
and inside the `closes the policy alerts` describe:

```ts
  it('drops the org\'s heartbeat probe cache (#8053)', async () => {
    await buildApp({}).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });
    expect(invalidateProbeMock).toHaveBeenCalledWith(ORG_ID);
  });

  it('drops every org\'s probe cache for a partner-wide policy', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([policyRow({ orgId: null, partnerId: 'partner-1' })]) as never);
    await buildApp({ scope: 'system' }).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });
    expect(invalidateProbeMock).toHaveBeenCalledWith(undefined);
  });

  it('drops nothing when the deactivation is refused', async () => {
    mfaOkMock.mockReturnValue(false);
    await buildApp({}).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });
    expect(invalidateProbeMock).not.toHaveBeenCalled();
  });
```

In `apps/api/src/routes/agents/mtls.test.ts`, add near the other mocks:

```ts
const invalidateHelperCacheMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/agentOrgSettingsCache', () => ({
  invalidateOrgHelperSettingsCache: invalidateHelperCacheMock,
}));
```
and a describe after `organization settings writers serialize…`:

```ts
describe('PATCH /org/:orgId/settings/helper drops the heartbeat cache (#8053)', () => {
  beforeEach(() => { vi.clearAllMocks(); mfaGate.deny = false; });
  it('invalidates the org\'s legacy helper flag after the write', async () => {
    dbSelectMock.mockReturnValueOnce({ from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: ORG_ID, settings: {} }]) }),
    }) });
    dbUpdateMock.mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
    const response = await buildApp().request(`/agents/org/${ORG_ID}/settings/helper`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect(invalidateHelperCacheMock).toHaveBeenCalledWith(ORG_ID);
  });
});
```

- [ ] **Step 8: Keep the mocked heartbeat suites deterministic**

In `apps/api/src/routes/agents/heartbeat.test.ts`:
- Add to the `../../db` mock object: `hasDbAccessContext: () => false,`, `getCurrentDbAccessContext: () => ({ scope: 'system' }),` and `runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },`.
- Add to the `./helpers` mock object: `readCachedHelperSettings: vi.fn(async () => null),`, `getOrgHelperSettings: vi.fn(async () => ({ enabled: false })),` and `resolveOrgPamFallback: vi.fn(async () => ({ uacInterceptionEnabled: false })),`.
- Add a file-level hook right after the mocks: `import { __resetHotPathCachesForTests } from '../../services/hotPathCacheRegistry';` and `beforeEach(() => { __resetHotPathCachesForTests(); });`. Otherwise a probe value cached by one test is served to the next for the same `org-1`.

In the budget suite, update the helper fault mock to forward every argument:

```ts
vi.mock('../../services/helperSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/helperSettings')>();
  return {
    ...actual,
    buildHelperConfigUpdate: async (...args: Parameters<typeof actual.buildHelperConfigUpdate>) => {
      if (helperFault.enabled) {
        const { db: faultDb } = await import('../../db');
        const { sql: faultSql } = await import('drizzle-orm');
        await faultDb.execute(faultSql`SELECT 1 / 0`); // division_by_zero
      }
      return actual.buildHelperConfigUpdate(...args);
    },
  };
});
```
The heartbeat imports `buildHelperConfigUpdate` through `./helpers`, which re-exports it from this module, so the mock still applies.

Add to the steady test:

```ts
    // Lever 3: the sibling's beat warmed the org's probe, helper-legacy and PAM
    // caches, so this beat reads none of them.
    expect(steady.buckets.automationPolicies).toBe(0);
    expect(steady.buckets.orgHelperSettings).toBe(0);
    expect(steady.buckets.pamOrgConfig).toBe(0);
    // Lever 6: the claim's savepoint + the helper miss's; no probe savepoint.
    expect(steady.savepoints).toBe(2);
    // Warm: helper is a Redis hit (no savepoint), probe a process-cache hit.
    expect(warm.savepoints).toBe(1);
```

- [ ] **Step 9: Run everything touched**

```bash
cd apps/api && npx vitest run src/services/hotPathCache.test.ts src/routes/policyManagement/actions.test.ts src/routes/agents/mtls.test.ts src/routes/agents/heartbeat.test.ts src/routes/agents/networkContext.test.ts src/routes/agents.test.ts src/routes/orgs.test.ts src/routes/organizations.test.ts src/middleware/helperAuth src/services/helperSettings src/routes/agents/elevationRequests src/routes/agents/helpers
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "exit=$?"
```
Expected: all PASS, and every unit prefix reports at least one file. The savepoint test still sees `rollback to`. Budget steady prints 28, warm 22. `exit=0`. If `networkContext.test.ts` or `agents.test.ts` fails with `No "getCurrentDbAccessContext" export is defined on the "../../db" mock`, add `getCurrentDbAccessContext: () => ({ scope: 'system' })` to that file's db mock (the precedent is already there for `hasDbAccessContext`).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/hotPathCache.ts apps/api/src/services/hotPathCache.test.ts apps/api/src/services/agentOrgSettingsCache.ts apps/api/src/services/helperSettings.ts apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/policyManagement/actions.ts apps/api/src/routes/policyManagement/actions.test.ts apps/api/src/routes/agents/mtls.ts apps/api/src/routes/agents/mtls.test.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/routes/agents/networkContext.test.ts apps/api/src/routes/agents.test.ts apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
git commit -m "perf(api): per-org heartbeat caches filled after commit; no empty savepoints (#8053)

Steady beat 32 -> 28, warm 25 -> 22. Probe, legacy helper flag and PAM org
fallback served for 60 s per org; a miss costs what it did, never a new tx.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: One `agent_versions` read for agent, helper and watchdog

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts:2895-2975` (extract the missing-pin warning; add the batch)
- Modify: `apps/api/src/routes/agents/heartbeat.ts:1788-1900` (the three upgrade blocks)
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts` (helpers mock)
- Create: `apps/api/src/__tests__/integration/agentVersionsBatchParity.integration.test.ts`
- Modify: budget suite

**Interfaces:**
- Produces: `interface PinnedUpgradeRequest { component: string; pin: string | null }`; `resolvePinnedUpgradeTargets(args: { platform: string; architecture: string; requests: readonly PinnedUpgradeRequest[]; agentId?: string }): Promise<Map<string, string | null>>`. `resolvePinnedUpgradeTarget` is unchanged for its other callers (aiToolsAgentMgmt, edition auto-migration, the watchdog-role branch).

- [ ] **Step 1: Write the failing real-Postgres parity test**

`apps/api/src/__tests__/integration/agentVersionsBatchParity.integration.test.ts`:

```ts
/**
 * #8053 W1a-1 — the heartbeat's single agent_versions read returns exactly
 * what three resolvePinnedUpgradeTarget calls return (#3499 lockstep: same
 * predicates, same created_at DESC tiebreak), against real PostgreSQL.
 */
import './setup';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { agentVersions } from '../../db/schema';
import { getBinaryEdition } from '../../services/binaryEdition';
import { resolvePinnedUpgradeTarget, resolvePinnedUpgradeTargets } from '../../routes/agents/helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function row(platform: string, component: string, version: string, opts: { isLatest?: boolean; edition?: string; createdAt?: Date } = {}) {
  await withSystemDbAccessContext(() => db.insert(agentVersions).values({
    platform, architecture: 'amd64', component, version,
    downloadUrl: `https://example.invalid/${component}/${version}`, checksum: 'c'.repeat(64),
    isLatest: opts.isLatest ?? false, edition: opts.edition ?? getBinaryEdition(),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }));
}

const otherEdition = () => (getBinaryEdition() === 'hosted' ? 'self-host' : 'hosted');

describe('resolvePinnedUpgradeTargets (#8053 W1a-1) — real PostgreSQL', () => {
  const cases: Array<[string, Array<{ component: string; pin: string | null }>, (platform: string) => Promise<void>]> = [
    ['no rows at all', [{ component: 'agent', pin: null }, { component: 'helper', pin: null }, { component: 'watchdog', pin: null }], async () => {}],
    ['latest per component, newest created_at wins among duplicate is_latest rows', [
      { component: 'agent', pin: null }, { component: 'helper', pin: null }, { component: 'watchdog', pin: null },
    ], async (p) => {
      await row(p, 'agent', '1.0.0', { isLatest: true, createdAt: new Date('2026-01-01T00:00:00Z') });
      await row(p, 'agent', '1.1.0', { isLatest: true, createdAt: new Date('2026-02-01T00:00:00Z') });
      await row(p, 'helper', '2.0.0', { isLatest: true });
      await row(p, 'watchdog', '3.0.0', { isLatest: false });
    }],
    ['a pin that exists (not latest) and a pin with no build', [
      { component: 'agent', pin: '1.0.0' }, { component: 'helper', pin: null }, { component: 'watchdog', pin: '9.9.9' },
    ], async (p) => {
      await row(p, 'agent', '1.0.0');
      await row(p, 'agent', '1.1.0', { isLatest: true });
      await row(p, 'helper', '2.0.0', { isLatest: true });
      await row(p, 'watchdog', '3.0.0', { isLatest: true });
    }],
    ['rows of the other edition never count', [
      { component: 'agent', pin: null }, { component: 'watchdog', pin: '3.1.0' },
    ], async (p) => {
      await row(p, 'agent', '1.2.0', { isLatest: true, edition: otherEdition() });
      await row(p, 'watchdog', '3.1.0', { edition: otherEdition() });
    }],
  ];

  for (const [name, requests, arrange] of cases) {
    runDb(`matches three single reads: ${name}`, async () => {
      const platform = `par-${randomBytes(4).toString('hex')}`;
      await arrange(platform);
      const batch = await withSystemDbAccessContext(() =>
        resolvePinnedUpgradeTargets({ platform, architecture: 'amd64', requests, agentId: 'parity' }));
      for (const request of requests) {
        const single = await withSystemDbAccessContext(() =>
          resolvePinnedUpgradeTarget({ ...request, platform, architecture: 'amd64', agentId: 'parity' }));
        expect(batch.get(request.component), `${request.component} pin=${request.pin}`).toBe(single);
      }
    });
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentVersionsBatchParity.integration.test.ts`
Expected: FAIL. `resolvePinnedUpgradeTargets is not a function`.

- [ ] **Step 3: Implement the batch**

In `apps/api/src/routes/agents/helpers.ts`, extract the fail-closed block from `resolvePinnedUpgradeTarget` into a function placed above it:

```ts
/** Fail-closed pin miss: withheld, logged every time, captured once per key (#2124). */
function warnMissingPinnedBuild(component: string, platform: string, architecture: string, pin: string, agentId?: string): void {
  console.warn(
    `[agents] update withheld for ${agentId ?? 'device'}: pinned ${component} version ` +
      `"${pin}" has no registered ${getBinaryEdition()}-edition build for ` +
      `${platform}/${architecture} (fail closed; a build registered under the other ` +
      `edition does not count — #4072)`,
  );
  const key = `${component}:${platform}:${architecture}:${pin}`;
  if (!warnedMissingPinBuilds.has(key)) {
    warnedMissingPinBuilds.add(key);
    captureException(
      new Error(
        `Agent update withheld (#2124): pinned ${component} version "${pin}" has no ` +
          `registered ${getBinaryEdition()}-edition build for ${platform}/${architecture}; ` +
          `fleet freeze until a build is published under this edition or the pin is corrected.`,
      ),
    );
  }
}
```
Replace the inline block in `resolvePinnedUpgradeTarget` with `warnMissingPinnedBuild(component, platform, architecture, pin, agentId); return null;`. Below `resolvePinnedUpgradeTarget`, add:

```ts
export interface PinnedUpgradeRequest {
  component: string;
  pin: string | null;
}

/**
 * `resolvePinnedUpgradeTarget` for several components of ONE device in one
 * statement (#8053 W1a-1: the heartbeat's agent, helper and watchdog offers).
 *
 * LOCKSTEP (#3499): the same five predicates as the single resolver and as
 * services/promotedAgentVersion.ts — platform, architecture, component,
 * edition, and is_latest (or the exact pinned version) — and the same
 * `created_at DESC` tiebreak: the first matching row in that order is what
 * `LIMIT 1` would have returned. Not cached: the offered version must be the
 * one whose bytes are served. Parity with three single calls is pinned by
 * agentVersionsBatchParity.integration.test.ts.
 */
export async function resolvePinnedUpgradeTargets(args: {
  platform: string;
  architecture: string;
  requests: readonly PinnedUpgradeRequest[];
  agentId?: string;
}): Promise<Map<string, string | null>> {
  const { platform, architecture, requests, agentId } = args;
  const result = new Map<string, string | null>();
  if (requests.length === 0) return result;

  const components = [...new Set(requests.map((r) => r.component))];
  const pinned = requests.filter((r): r is PinnedUpgradeRequest & { pin: string } => r.pin !== null);
  const rows = await db
    .select({ component: agentVersions.component, version: agentVersions.version, isLatest: agentVersions.isLatest })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.platform, platform),
        eq(agentVersions.architecture, architecture),
        inArray(agentVersions.component, components),
        eq(agentVersions.edition, getBinaryEdition()),
        or(
          eq(agentVersions.isLatest, true),
          ...pinned.map((r) => and(eq(agentVersions.component, r.component), eq(agentVersions.version, r.pin))),
        ),
      ),
    )
    .orderBy(desc(agentVersions.createdAt));

  for (const request of requests) {
    if (request.pin === null) {
      result.set(request.component, rows.find((r) => r.component === request.component && r.isLatest)?.version ?? null);
      continue;
    }
    const hit = rows.find((r) => r.component === request.component && r.version === request.pin);
    if (hit) {
      result.set(request.component, hit.version);
      continue;
    }
    warnMissingPinnedBuild(request.component, platform, architecture, request.pin, agentId);
    result.set(request.component, null);
  }
  return result;
}
```
Also add a LOCKSTEP line to the comment in `services/promotedAgentVersion.ts` (`:26-35`): `resolvePinnedUpgradeTargets` (routes/agents/helpers.ts), the heartbeat's batched form of the same read.

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentVersionsBatchParity.integration.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 4: Use the batch in the heartbeat**

In `apps/api/src/routes/agents/heartbeat.ts`, add `resolvePinnedUpgradeTargets` to the `./helpers` import. Directly after the `warnedEditionRecoveryWithheldDevices.delete(device.id);` line (before the `!acceptsServedEdition` withhold block), add:

```ts
  // #8053 W1a-1 — the agent, helper and watchdog offers below share one guard,
  // so their three agent_versions reads are one statement. A failure leaves
  // every target null: no offer this beat, the same outcome each per-block
  // catch gave (the first failed read aborted the transaction for the rest).
  let upgradeTargets: Map<string, string | null> | null = null;
  if (normalizedArch && acceptsServedEdition) {
    try {
      upgradeTargets = await resolvePinnedUpgradeTargets({
        platform: device.osType,
        architecture: normalizedArch,
        agentId,
        requests: [
          { component: 'agent', pin: versionPins.agent },
          { component: 'helper', pin: null },
          { component: 'watchdog', pin: versionPins.watchdog },
        ],
      });
    } catch (err) {
      console.error(`[agents] failed to resolve upgrade targets for ${agentId}:`, err);
    }
  }
```
In the three blocks, replace only the `await resolvePinnedUpgradeTarget({...})` expressions:
- agent block (`~:1794`): `const targetVersion = upgradeTargets?.get('agent') ?? null;`
- helper block (`~:1836`): `const latestHelperVersion = upgradeTargets?.get('helper') ?? null;`
- watchdog block (`~:1866`): `const targetWatchdog = upgradeTargets?.get('watchdog') ?? null;`

Keep each block's `if (normalizedArch && acceptsServedEdition)` and its `try/catch` as they are. The edition-migration `resolveTarget` closure (`~:1767`) keeps calling `resolvePinnedUpgradeTarget` lazily; do not touch it.

In `apps/api/src/routes/agents/heartbeat.test.ts`, add to the `./helpers` mock. It delegates to the mocked single, in the heartbeat's order, so every existing per-call expectation and `mockResolvedValueOnce` sequence still applies:

```ts
  // #8053 W1a-1 — the heartbeat's batched read, modelled as the three single
  // calls it replaces (agent, helper, watchdog — the order the blocks ran).
  resolvePinnedUpgradeTargets: async (args: {
    platform: string; architecture: string; agentId?: string;
    requests: Array<{ component: string; pin: string | null }>;
  }) => {
    const helpers = await import('./helpers');
    const out = new Map<string, string | null>();
    for (const r of args.requests) {
      out.set(r.component, await helpers.resolvePinnedUpgradeTarget({
        component: r.component, platform: args.platform, architecture: args.architecture, pin: r.pin, agentId: args.agentId,
      }));
    }
    return out;
  },
```

- [ ] **Step 5: Budget assertion and full run**

Add to the steady test: `expect(steady.buckets.agentVersions).toBe(1); expect(warm.buckets.agentVersions).toBe(1);`.

```bash
cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts src/routes/agents/helpers.agentUpdatePolicy.test.ts src/routes/agents/networkContext.test.ts src/routes/agents.test.ts src/services/aiToolsAgentMgmt
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts src/__tests__/integration/agentVersionsBatchParity.integration.test.ts src/__tests__/integration/helperBootstrapOffer.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "exit=$?"
```
Expected: all PASS. Budget steady prints 26, warm 20. `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/services/promotedAgentVersion.ts apps/api/src/__tests__/integration/agentVersionsBatchParity.integration.test.ts apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
git commit -m "perf(api): one agent_versions read for the heartbeat's three upgrade offers (#8053)

Steady beat 28 -> 26. Same predicates and tiebreak (#3499), no cache.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Ratchet the budget to the new numbers

**Files:**
- Modify: `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` (header comment `:1-30`; steady and legacy tests)

**Interfaces:**
- Consumes: every bucket name from Task 1.

- [ ] **Step 1: Tighten the assertions (they fail until the numbers are right)**

Replace the steady test's statement assertion and its comment block with:

```ts
    // #8053 W1a-1 ratchet. Measured after PR A (hierarchy pass-through,
    // topology skip, per-org caches, batched agent_versions):
    //   steady 26 statements / 3 tx (was 69), warm 20 / 3 (was 47),
    //   cold 57 / 8 (was 96 / 8).
    // Pinned at the measured value, not "plus one": any new statement on the
    // beat reds this. If a change legitimately adds one, raise the number in
    // the same PR, name the bucket, and say why.
    expect(steady.transactions).toBe(3);
    expect(steady.statements).toBeLessThanOrEqual(26);
    expect(warm.transactions).toBe(3);
    expect(warm.statements).toBeLessThanOrEqual(20);
    expect(cold.transactions).toBeLessThanOrEqual(8);
    expect(cold.statements).toBeLessThanOrEqual(57);
```
In the legacy test, replace `expect(steady.statements).toBeLessThanOrEqual(70);` with `expect(steady.statements).toBeLessThanOrEqual(28);`. Update the file header paragraph to say the remaining bulk is the 9 per-feature policy reads plus the OneDrive context (W1a-2).

- [ ] **Step 2: Run and read the printed numbers**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
Expected: PASS, with printed steady 26/3, warm 20/3, legacy 28/3.

`cold` (57) is derived, not measured: the trace has no cold statement list. The derivation is 96 − 2 (payload) − 32 (hierarchy) − 3 (topology) − 2 (versions). If the printed cold count is 55–59 **and** its buckets show `hierarchyLoad: 1, deviceLookup: 0, orgPartnerLookup: 0, groupLookup: 0, topologyNegotiation: 0, agentVersions: 1`, set the cold bound to the printed value. If it falls outside that range, or any listed bucket differs, stop and find the statement. Do not widen the bound to make it pass. Steady and warm must match exactly. A mismatch there means a lever regressed, and the buckets name it.

- [ ] **Step 3: Run the full API unit suite and the integration suites this wave touched**

```bash
cd apps/api && npx vitest run
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts src/__tests__/integration/deviceHierarchy.integration.test.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts src/__tests__/integration/topologyHeartbeatMaterializationOff.integration.test.ts src/__tests__/integration/agentVersionsBatchParity.integration.test.ts src/__tests__/integration/configPolicyPartnerLevelAssignments.integration.test.ts src/__tests__/integration/configPolicyPartnerWideSelect.integration.test.ts src/__tests__/integration/helperBootstrapOffer.integration.test.ts src/__tests__/integration/topologyBaselinePublication.integration.test.ts src/__tests__/integration/builtInMonitors.integration.test.ts
```
Expected: the full unit suite passes (the merge engine and other full-suite-only checks run here). Every listed integration file passes. No migration or RLS change was made, so the RLS contract suites are not required. CI's Integration Tests job runs everything anyway.

- [ ] **Step 4: Commit and tear down**

```bash
git add apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
git commit -m "test(api): ratchet the heartbeat budget to 26 steady / 20 warm statements (#8053)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
pnpm test-stack down
```

---

## Self-review

1. **Spec and brief coverage.** Brief item 1 → Tasks 2–5. Item 2 → Task 6 (parity verified first, in Steps 1 and 5). Item 3 → Task 7. Item 4 → Task 8. Item 5 → folded into the hierarchy read (Tasks 2, 3 and 5; the deviation and its reason are in Findings). Item 6 → Task 7 Step 6. Item 7 → assessed and not taken (Levers not taken). Item 8 → Task 1. Item 9 → Task 9. Spec W1a acceptance "≤3 tx per heartbeat" → pinned in Task 9 (`toBe(3)`). The "unifi poll ≤1 tx" half of W1a shipped in #8128 and is untouched; its existing test still runs.
2. **Placeholder scan.** No TBD/TODO. The only value not known in advance (cold count) has an explicit decision rule with a range and bucket checks, not a blank.
3. **Type consistency.** `DeviceHierarchy`, `DeviceHierarchyOpts`, `hierarchyFor`, `withHierarchy` and `loadDeviceHierarchy` (Task 2) are used with the same names and shapes in Tasks 3–7. `HelperConfigUpdateOptions` and `PamConfigUpdateOptions` extend `DeviceHierarchyOpts`, so Task 5's `hierarchyOpts` spreads into them in Task 7. `resolvePinnedUpgradeTargets` returns `Map<string, string | null>` in Task 8's implementation, its heartbeat call and its test mock. `topologyHeartbeatWithoutMaterialization` has the same name in Task 6's module, test, heartbeat import and `networkContext.test.ts` mock.
4. **Review Focus.** Each of the five lines has a named test: (1) Task 2 unit, the Task 3/4 `refuses another device's hierarchy` tests, and the Task 5 sibling test; (2) the Task 5 role test plus its mutation check; (3) the Task 7 `hotPathCache.test.ts` deferred-fill tests; (4) the Task 6 unit and integration refusal tests; (5) the Task 8 parity matrix.
