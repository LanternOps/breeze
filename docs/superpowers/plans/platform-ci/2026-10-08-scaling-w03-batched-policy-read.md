---
tracking_issue: LanternOps/breeze#8139
wave_issue: LanternOps/breeze#8142
---

# Heartbeat Statement Cut, Part B (W03 / W1a-2): Batched Policy Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the steady-state agent heartbeat from 26 DB statements over 3 transactions to 14 over 2, by reading every heartbeat feature's policy assignments in one statement inside one org-scoped (RLS-guarded) post-commit context, with every agent-visible config field unchanged.

**Architecture:** A new `DevicePolicySet` holds every candidate assignment for the device (a superset of what any resolver reads), each with its effective feature links and the 1:1 settings rows, loaded in ONE statement. Each resolver keeps its own applicability and ranking rules in TypeScript and takes the set as an optional `opts.policySet`; without it, it reads exactly as today. The heartbeat's two post-commit system contexts (OneDrive, shared policy) become ONE `withDbAccessContext` using the same org-scoped context as the org block (`currentPartnerId` set, `accessiblePartnerIds: []`), so RLS — not the batched query's filters — is the tenant boundary. OneDrive is split into a DB phase (inside the context) and a DB-free Graph phase (after commit).

**Tech Stack:** Hono, Drizzle ORM on postgres.js, PostgreSQL with forced RLS (`breeze_app`), Redis, Vitest (unit + `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md` — row W1a ("W1a-2: one batched policy-assignment read for all feature types instead of one per resolver; fold the OneDrive context into the policy context; cache monitoring's 'no policy applies' with invalidation"; acceptance "W1a-2: ≤16 statements, ≤2 tx … The budget suite asserts each number") and the "Heartbeat statement trace" table. Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md` (row W03, issue #8142, feature #8139, P1 for v0.123.0). Predecessor: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-w1a1-heartbeat-hierarchy-passthrough.md` (merged as PR #8222).

## Global Constraints

- Steady-state heartbeat: **≤16 statements and ≤2 transactions** (spec W1a-2 acceptance). This plan lands at **14 / 2** on the budget suite's steady and warm beats.
- **No beat shape may gain a transaction.** A per-org cache miss, a OneDrive device and a monitoring device all stay at 2.
- **Tenancy (CLAUDE.md "Partner-Wide First" step 3):** the post-commit policy context is `withDbAccessContext` with `{ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId }` — the org block's own `dbContext`. Partner-wide rows are read only through the SELECT-only `*_partner_wide_select` branches keyed on `breeze_current_partner_id()`. **No** `withSystemDbAccessContext`, `runOutsideDbContext` or `withDevicePartnerPolicyVisibility` on any path this plan touches.
- **#1105:** never hold two pooled connections at once, and never hold one across an HTTP call. Graph calls run only after the policy context has committed, and the Graph phase issues **zero** DB statements.
- **Resolver parity:** called without `policySet`, every resolver issues the same statements as today (plus the deterministic `ORDER BY` below). Called with it, it returns exactly what its own reads return — proven per resolver against real Postgres, in system scope and in the org-scoped context.
- **Deterministic tie-break (a stated behaviour change):** today the per-feature queries have no `ORDER BY`, so two assignments equal on every ranking key (level, priority, and createdAt where used) win in whatever order the plan returns them. Both the set and every legacy per-feature query now order candidates by `config_policy_assignments.created_at ASC, id ASC` before the (stable) TypeScript sort, so the earliest assignment wins a tie. Nothing else about ranking changes.
- **`hotPathCache.ts` contract** (read its header): keys carry the full tenant scope; failures never cached; values read-only; a fill is stored only after the loading context commits. This plan adds one narrowly-scoped rule: an **org-scoped** load may fill a per-org cache only when the caller names the exact `{ orgId, partnerId }` the context was built for and the context matches it.
- **Migrations:** exactly one, additive, SELECT-only (Task 1). Name it to sort after the newest committed migration at the time you commit (`ls apps/api/migrations | sort | tail -1`); `2026-12-18-100000-…` sorts after `2026-12-17-100300-…`, the newest at plan time. Idempotent (`DROP POLICY IF EXISTS` then `CREATE`). It writes no rows, so no `breeze.scope` elevation. No table, no column: the cascade, merge and export registration lists do not apply.
- **Test placement:** unit tests next to their source (`foo.ts` → `foo.test.ts`); real-Postgres suites under `apps/api/src/__tests__/integration/`.
- **Vitest invocation:** unit `cd apps/api && npx vitest run <file>`; integration `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>`. Never put `--` before `--run` with `pnpm --filter`. Filters are substring matches — check the reported file count.
- **Integration stack:** `pnpm test-stack up` from the worktree root before the first integration run; `pnpm test-stack down` at the end (Task 9). The RLS coverage contract runs with `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
- **Branch / PR:** `feature/8139-scaling/wave-8142`; PR body includes `Closes #8142`. Rigor is **high** (tenancy): one full independent review round before merge.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A cross-tenant assignment reaching a device.** An assignment row whose policy belongs to another org, or to another partner's partner-wide policy, that targets this device (`level='device'`, `target_id = device.id`) or this device's partner. Expected: never in the device's config, AND invisible to a raw, unfiltered read in the heartbeat's org-scoped context (RLS alone hides it). Tests: Task 2 (raw read), Task 3–6 parity world (forged rows), Task 9 (full heartbeat).
2. **A partner-wide policy silently disappearing under org scope.** Every feature (helper, event log, hardware monitoring, check interval, monitors, PAM, patch source, warranty, time sync) resolved from a partner-wide (`org_id NULL`) policy must give the same answer in the org-scoped context as in system scope. The one table that lacked the branch (`config_policy_hardware_monitoring_settings`) is the reason for Task 1. Tests: Task 1, and the three-way parity (system legacy = org legacy = org policy set) in Tasks 3–5.
3. **Equal-ranked assignments.** Two org-level policies with priority 0 for the same feature. Expected: the earliest-created assignment wins, on both paths, deterministically. Tests: Task 2 (unit, candidate order), Task 3 (real Postgres, helper and PAM ties).
4. **The device is no longer visible to its own org's context mid-beat** (moved or deleted between the org transaction's commit and the policy context), **or the org's partner differs from the authenticated partner.** Expected: no policy config is delivered that beat (no default/revert answers are generated and nothing is cached); helper and PAM read `false` for that one beat, exactly as when the policy context fails today. Test: Task 8 (unit).
5. **A OneDrive device whose Graph membership cache entry expires between the DB phase and the Graph phase.** Expected: the Graph phase uses the result captured in the DB phase, and on a miss uses the connection row loaded in the DB phase; it issues no DB statement. Tests: Task 6 (unit: captured hit survives a cache clear; `getToken` with a supplied connection never touches `db`).

---

## Design decision (advisor quorum: Fable + Codex `gpt-6-astra` xhigh, read-only, 2026-10-08)

### Position put to Codex

One wide statement (assignments ⋈ active policies, LEFT JOIN the effective-links view for the nine heartbeat feature types, LEFT JOIN the five 1:1 settings tables) with superset ownership/target filters and no role/OS filter; per-resolver TypeScript selection mirroring each resolver's SQL exactly; monitoring short-circuits with zero statements when no candidate carries a `monitors` link; OneDrive split into DB and HTTP phases; the single remaining post-commit context converted to org scope, with an hwmon partner-wide branch migration and an org-scoped fill rule for the per-org caches; omit all policy config if the device is invisible.

### Codex's position (verdict: agree-with-changes)

| # | Codex finding | Verified? | Resolution in this plan |
|---|---|---|---|
| 1 | No other table in the context lacks a partner-wide branch; hwmon is the only gap. The patch-timezone blocker named in `heartbeat.ts` is stale (W01 removed it). | Verified by both: live `pg_policy` query (table below) and source. | Task 1 adds the branch. Task 8 rewrites the stale comments. |
| 2 | The legacy hwmon path still widens `accessible_partner_ids` via `withDevicePartnerPolicyVisibility`; under org scope that fires (+2 statements, a partner-axis widening on the agent path). Remove it from the heartbeat's paths too. | Verified (`helpers.ts:2160`, `timeSync/settings.ts:126`). | Task 1 removes the widening from `resolveHardwareMonitoring` and `resolveDeviceTimeSyncSettings`; both tables now carry the SELECT-only branch. |
| 3 | Tie parity is impossible as drafted (`ORDER BY a.id` vs unordered legacy SQL). Define one deterministic tie-break in BOTH paths and say it is a behaviour change. | Verified (no `ORDER BY` in helper/event_log/hwmon/pam/warranty/onedrive/check-interval queries). | Adopted: `ORDER BY created_at, id` on the set and on every legacy per-feature query (Global Constraints; Tasks 2–6). Owner decision O1. |
| 4 | Settings rows must be presence sentinels (legacy inner-joins them); group by assignment, never dedupe by link id (the view reuses the parent's link id). Patch's full return type can't come from a two-column projection — use a separate heartbeat projection. | Verified (view definition; `featureConfigResolver.ts:576`). | Adopted: every settings sub-object is keyed on its `id`; grouping is by assignment id; `patchExclusiveWindowsUpdateFromPolicySet` is a heartbeat-only projection. A missing-settings fixture is in the parity world. |
| 5 | "Omit all policy config" does not preserve helper/PAM: the server sends `false`, and the agent reads an absent helper bool / PAM pointer as disabled (`agent/internal/heartbeat/heartbeat.go:311, :5382`). Distinguish hierarchy-missing / hierarchy-error / policy-set-error, and keep a loaded hierarchy when only the batch fails. | Verified (`heartbeat.ts:2522-2523`). | Partly adopted. The three outcomes are distinct (Task 8): **missing** → skip every resolver (no defaults, nothing cached); **hierarchy error** → today's W01 fallback (every resolver reads its own); **set error** → keep the hierarchy, resolvers read their own with it. For **missing**, helper and PAM still read `false` for that one beat — the same thing that happens today when the shared context fails (pinned by an existing test). A server-only wave cannot do better; an agent "unknown = retain" protocol is owner decision O3. |
| 6 | The org-scoped fill rule must not be a global relaxation of `DeferredCacheFills`; validate the hierarchy's org/partner against the authenticated context **before** any cache hit or load, and bind fills to that partner. | Inferred race (org re-parented after auth) — plausible, not reproduced. | Adopted: `through()` takes an explicit `{ orgId, partnerId }` fill scope; without it behaviour is unchanged. The heartbeat checks `hierarchy.orgId === agent.orgId` and `hierarchy.org.partnerId === agent.partnerId` before any per-org cache peek, and treats a mismatch like "missing" (Task 8). |
| 7 | OneDrive completion must be genuinely DB-free: `getToken` reads `m365_connections` before its token cache, and a membership entry can expire between phases. Capture per-UPN hits and the connection row in the DB phase. Moving OneDrive into the shared transaction changes failure isolation. | Verified (`m365DirectGraph.ts:105`, `onedriveGraph.ts:230`). | Adopted (Task 6). OneDrive's DB phase runs before monitoring's secondary reads and inside its own savepoint whenever the set holds a OneDrive link, so a monitoring SQL error cannot drop it and its own error cannot drop anything else. |
| 8 | Device-keyed Redis caches (helper, event log, hwmon, monitoring, PAM) are not bound to the org, so after an org move a stale entry can serve the old org's config for ≤120 s regardless of RLS. Existing risk, not introduced here. | Verified (`helperSettings.ts:195`, `helpers.ts:2701`; time sync already checks `cached.orgId`). | **Disagreement on scope.** Codex would bind cache keys to the org before claiming whole-beat isolation. This plan claims RLS isolation for the **DB reads** only, runs the set/hierarchy identity guards before every Redis short-circuit, and leaves cache-key binding to a follow-up (owner decision O2). Reason: the fix touches `helperAuth` and `/helper/config` consumers of the helper cache and is independent of the statement cut. |
| 9 | 14 statements is an estimate, not throughput; the security-invoker view and EXISTS-based RLS may repeat work. Measure plans as `breeze_app` on a configured device; if costly, fall back to assignments+links then ONE bulk settings query (+1 statement). | Not measured yet. | Adopted as a gate: Task 9 records `EXPLAIN (ANALYZE, BUFFERS)` of the set statement as `breeze_app` on the configured-device fixture in the PR. Fallback shape documented there. |
| 10 | Agree: no `none_applies` cache in W03; the monitoring short-circuit is exact given per-resolver filtering. RLS ownership ≠ device applicability: same-partner partner-wide assignments targeting siblings stay RLS-visible, so only other-org/other-partner rows get raw-read invisibility assertions. | Verified. | Adopted (Task 5; Task 2 test design). |

### Chosen design (final)

1. **Query shape — one statement** (`loadDevicePolicySet`, Task 2): assignments ⋈ `configuration_policies` (active) LEFT JOIN `config_policy_effective_feature_links` (`feature_type IN` the nine heartbeat types) LEFT JOIN the 1:1 settings tables for `event_log`, `hardware_monitoring`, `patch`, `time_sync`, `onedrive_helper` (each `ON settings.feature_link_id = link.id AND link.feature_type = '<type>'`). `WHERE` ownership `(org_id = $org OR (org_id IS NULL AND partner_id = $partner))` AND targets device/site/org/groups/partner using the RAW partner — the superset of every resolver. No role/OS predicate. `ORDER BY a.created_at, a.id, link.feature_type`. Grouped by assignment in TypeScript.
2. **Scope — org, RLS-guarded.** The heartbeat's two post-commit system contexts become one `withDbAccessContext(dbContext, …)`. RLS limits every row to the device's own org plus its own partner's partner-wide rows; the TypeScript selectors only decide intra-tenant applicability (which of the tenant's assignments target this device).
3. **Resolvers** keep their rules in TypeScript (`ApplicabilityRule` per resolver; Tasks 3–6) and share one pure ranking function between the legacy and set paths.
4. **Monitoring "no policy applies"** is not cached. The set makes it cost **0 statements** whenever no applicable candidate carries a `monitors` link (the trace's 8-statement case); a device with monitors links runs today's raw secondary reads. See "Monitoring none_applies: decision" below.

### Monitoring none_applies: decision

Not cached in W03. The spec's concern was "a device without a monitoring policy pays 8 statements on every beat even when warm". After this wave that device pays **0**: both monitoring resolvers return from the in-memory set when no applicable candidate (after each resolver's own rules) carries an effective `monitors` link — exact, because the view has a `monitors` row for policy P iff P or P's parent has one. A cache would only help devices that DO have monitors links but resolve to nothing, and it would need invalidation on assignment, policy, link, attachment, group-membership, device-role/OS, site and org-move writes, across instances (W1b) — the generation-stamped config cache the spec already names as the later lever. Deferred there.

## Verified findings that shape this plan

**Measured steady-state beat at `origin/main` `ab5d6ff93e`** (`DUMP_8053=1`, budget suite, this worktree's test stack):

| Tx | Statements | Content |
|---|---|---|
| Org block | 8 | begin, prologue, core device read, `UPDATE devices`, savepoint, command claim, `agent_versions`, commit |
| OneDrive system ctx | 5 | begin, prologue, hierarchy load, OneDrive assignment read, commit |
| Shared policy system ctx | 13 | begin, prologue, savepoint (helper Redis miss), helper, event_log, hwmon, check-interval, monitors, pam, patch, warranty, time_sync, commit |
| **Total** | **26 / 3 tx** | warm re-beat 20 / 3 (helper Redis hit; event_log/hwmon/pam Redis hits; check-interval, monitors, patch, warranty, OneDrive still read) |

**RLS partner-wide SELECT branch, live `pg_policy` on the test DB:**

| Table | Branch | Used by |
|---|---|---|
| `configuration_policies`, `config_policy_assignments`, `config_policy_feature_links` | yes | every resolver, the set, the effective view |
| `config_policy_event_log_settings`, `…_patch_settings`, `…_time_sync_settings`, `…_monitoring_settings`, `config_policy_monitors` | yes | event_log, patch, time_sync, check-interval, monitors |
| `monitor_definitions`, `automation_policies` | yes | monitor-derived watches, policy probe |
| `config_policy_hardware_monitoring_settings` | **no** | hwmon — **Task 1** |
| `config_policy_onedrive_settings`, `…_onedrive_libraries` | no, by design (org-only; a trigger rejects partner-owned settings) | OneDrive |
| `organizations`, `devices`, `sites`, `device_group_memberships`, `pam_org_config`, `onedrive_device_state`, `m365_connections` | org-scoped; visible for the device's own org | hierarchy, helper legacy flag, PAM fallback, OneDrive |

**Per-resolver rules the TypeScript selectors must mirror** (all verified in source):

| Resolver | Ownership partner | Partner-level target | Role/OS | Tie-break keys today | Settings presence |
|---|---|---|---|---|---|
| helper (`helperSettings.ts`) | raw | raw | none | level, priority | inline (null → no policy) |
| event_log (`helpers.ts`) | raw | raw | SQL + `matchesRoleOsFilter` | level, priority | inner join |
| hwmon (`helpers.ts`) | raw | raw | SQL + TS | level, priority | inner join |
| check-interval (`helpers.ts`) | raw; no org → `device_missing` | raw | SQL + TS | level, priority | raw links of policy + parent |
| monitors (`monitorResolver.ts`) | raw; no org → `device_missing` | dropped for `quick_support` / `unassigned_pool` | SQL only | level, priority, createdAt | raw links of policy + parent |
| pam (`helpers.ts`) | raw | raw | none | level, priority | inline (null → org fallback) |
| patch (`featureConfigResolver.ts`) | null for `unassigned_pool` | null for `unassigned_pool` | SQL only | level, priority, createdAt | inner join |
| warranty (`warrantyPolicyResolution.ts`) | raw | raw | none | level, priority **DESC** | inline |
| time_sync (`timeSync/settings.ts`) | raw | raw | SQL + TS | level, priority, createdAt | inner join |
| onedrive (`helpers.ts`) | **org-only** | raw | none | level, priority | inner join |

Verified on this worktree's test stack (scratch test, not committed): Drizzle returns a left-joined nested select object (`eventLog: { id: ev.id, … }`) as `null` when the joined row is absent, and `db.execute(sql\`EXPLAIN (ANALYZE, BUFFERS) ${query}\`)` embeds a select builder with its parameters. `present()` in Task 2 is kept as a belt-and-braces guard.

`sqlRoleOsMatch` (Task 2) mirrors `(filter IS NULL OR $v = ANY(filter))` exactly; `matchesRoleOsFilter` additionally rejects an empty-string role/OS. Resolvers that apply both keep applying both.

### Expected statement counts per task (budget suite)

| After task | Steady | Warm | Tx | Change |
|---|---|---|---|---|
| baseline (measured) | 26 | 20 | 3 | — |
| 1–7 | 26 | 20 | 3 | 0 (resolvers accept the set; heartbeat not wired; legacy queries gain only an `ORDER BY`) |
| 8 wire-up | 14 | 14 | 2 | steady: −3 OneDrive tx, −10 per-feature reads +1 set read, +1 hierarchy/set savepoint, −1 helper savepoint (helper resolves from the set). Warm: −3, −5 reads +1, +1 |
| 9 ratchet | 14 | 14 | 2 | pinned; plus new pinned budgets for "per-org caches all miss" and "configured device" (measured, Task 9) |

## Not in this wave

- A `none_applies` monitoring cache, and the generation-stamped whole-config cache (later wave; see decision above).
- Binding device-keyed Redis policy caches to the org (owner decision O2; follow-up issue).
- An agent protocol for "unknown — keep your current helper/PAM state" (owner decision O3).
- Removing `withDevicePartnerPolicyVisibility` from `services/configurationPolicy.ts` (non-heartbeat UI path).
- Moving the core device read, command claim or `agent_versions` (the org block is untouched: 8 statements).

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/migrations/2026-12-18-100000-hardware-monitoring-settings-partner-wide-select.sql` | Create | SELECT-only partner-wide branch for hwmon settings |
| `apps/api/src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts` | Create | Branch grants own-partner reads, no writes, no foreign partner |
| `apps/api/src/services/devicePolicySet.ts` (+ `.test.ts`) | Create | Types, one-statement loader, grouping, guard, applicability selectors |
| `apps/api/src/__tests__/integration/policySetFixtures.ts` | Create | Shared real-Postgres fixture world (not a test file) |
| `apps/api/src/__tests__/integration/devicePolicySet.integration.test.ts` | Create | Loader superset + RLS-alone forge proof |
| `apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts` | Create (Task 3), extend (Tasks 4–6) | Three-way parity per resolver, ties, forges, parked orgs |
| `apps/api/src/services/helperSettings.ts` | Modify | Set path; `helperSettingsFromRows`; `ORDER BY` |
| `apps/api/src/services/warrantyPolicyResolution.ts` | Modify | Set path; `warrantyInlineFromRows`; `ORDER BY` |
| `apps/api/src/services/featureConfigResolver.ts` | Modify | `patchExclusiveWindowsUpdateFromPolicySet`; `ORDER BY` tail |
| `apps/api/src/services/timeSync/settings.ts` (+ `.test.ts`) | Modify | Set path; `timeSyncFromRows`; drop widening; `ORDER BY` |
| `apps/api/src/services/timeSync/configUpdate.ts` | Modify | `opts` type widened to `DevicePolicySetOpts` |
| `apps/api/src/services/monitors/monitorResolver.ts` | Modify | Set path + short-circuit; `monitorsFromAssignments`; `ORDER BY` |
| `apps/api/src/routes/agents/helpers.ts` | Modify | Set paths for event_log, hwmon (drop widening), check-interval, pam, patch source, OneDrive plan/finish; `ORDER BY`s |
| `apps/api/src/services/m365DirectGraph.ts` (+ `.test.ts`) | Modify | `loadLegacyDirectConnection`; `getToken(orgId, { connection })` |
| `apps/api/src/services/onedriveGraph.ts` (+ `.test.ts`) | Modify | `peekUserGroupMembershipCached`; connection pass-through |
| `apps/api/src/services/hotPathCache.ts` (+ `.test.ts`) | Modify | Explicit org fill scope on `DeferredCacheFills.through` |
| `apps/api/src/routes/agents/heartbeat.ts` | Modify | One org-scoped post-commit context; set wiring; OneDrive phases |
| `apps/api/src/routes/agents/heartbeat.test.ts` | Modify | Mocks and order assertions for the single context |
| `apps/api/src/routes/agents/helpers.partnerWidePolicies.test.ts` | Modify | onedriveGraph mock gains `peekUserGroupMembershipCached` |
| `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` | Modify | Buckets, guards, ratchet, new budgets |

---
### Task 1: Partner-wide read branch for hardware-monitoring settings; drop the two widenings

**Files:**
- Create: `apps/api/migrations/2026-12-18-100000-hardware-monitoring-settings-partner-wide-select.sql`
- Create: `apps/api/src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts`
- Modify: `apps/api/src/routes/agents/helpers.ts` (`resolveHardwareMonitoring`, ~2104-2200; import at :68)
- Modify: `apps/api/src/services/timeSync/settings.ts` (`resolveDeviceTimeSyncSettings`, ~126)
- Test: `apps/api/src/services/timeSync/settings.test.ts`

**Interfaces:**
- Consumes: `public.breeze_current_partner_id()` (2026-06-13), the template `config_policy_time_sync_settings_partner_wide_select` (2026-11-10-120000).
- Produces: RLS policy `config_policy_hardware_monitoring_settings_partner_wide_select` (FOR SELECT). `resolveHardwareMonitoring` and `resolveDeviceTimeSyncSettings` read in the caller's own context with no GUC widening.

- [ ] **Step 1: Write the failing RLS test**

```ts
// apps/api/src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts
/**
 * #8142 (scaling W03) — config_policy_hardware_monitoring_settings had no
 * partner-wide SELECT branch, so an org-scoped context (the agent heartbeat
 * after W03) could not read a partner-wide hardware-monitoring policy's
 * settings without widening breeze.accessible_partner_ids. Same three
 * properties as configPolicyPartnerWideSelect.integration.test.ts: own-partner
 * reads, no writes, no foreign partner, nothing on a NULL partner GUC.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyFeatureLinks,
  configPolicyHardwareMonitoringSettings,
  configurationPolicies,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const orgCtx = (orgId: string, currentPartnerId: string | null): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId,
});

async function seedPartnerWideHwmon(partnerId: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: null, partnerId, name: `hwmon pw ${randomUUID()}`, status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'hardware_monitoring',
    }).returning();
    const [settings] = await db.insert(configPolicyHardwareMonitoringSettings).values({
      featureLinkId: link!.id, enabled: true, pollIntervalMinutes: 7, diskHealthIntervalMinutes: 60,
    }).returning();
    return settings!.id;
  });
}

describe('config_policy_hardware_monitoring_settings partner-wide SELECT branch (#8142)', () => {
  runDb('an org session of the owning partner reads its partner-wide row and never a foreign partner\'s', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const foreign = (await createPartner())!;
    const own = await seedPartnerWideHwmon(partner.id);
    const other = await seedPartnerWideHwmon(foreign.id);

    const seen = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.select({ id: configPolicyHardwareMonitoringSettings.id })
        .from(configPolicyHardwareMonitoringSettings)
        .where(inArray(configPolicyHardwareMonitoringSettings.id, [own, other])));
    expect(seen.map((r) => r.id)).toEqual([own]);

    const agentNoPartner = await withDbAccessContext(orgCtx(org.id, null), () =>
      db.select({ id: configPolicyHardwareMonitoringSettings.id })
        .from(configPolicyHardwareMonitoringSettings)
        .where(inArray(configPolicyHardwareMonitoringSettings.id, [own, other])));
    expect(agentNoPartner).toEqual([]);
  });

  runDb('the branch grants no write: an UPDATE from the org session touches zero rows', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const own = await seedPartnerWideHwmon(partner.id);

    const updated = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.update(configPolicyHardwareMonitoringSettings)
        .set({ pollIntervalMinutes: 30 })
        .where(eq(configPolicyHardwareMonitoringSettings.id, own))
        .returning({ id: configPolicyHardwareMonitoringSettings.id }));
    expect(updated).toEqual([]);
    const [after] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ poll: configPolicyHardwareMonitoringSettings.pollIntervalMinutes })
        .from(configPolicyHardwareMonitoringSettings)
        .where(eq(configPolicyHardwareMonitoringSettings.id, own)));
    expect(after?.poll).toBe(7);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test-stack up` (worktree root, once), then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts`
Expected: FAIL in the first test — `expected [] to deeply equal [ '<own id>' ]` (no branch yet). The second test passes already (it is the write guard).

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-12-18-100000-hardware-monitoring-settings-partner-wide-select.sql
--
-- Partner-wide READ branch for config_policy_hardware_monitoring_settings
-- (#8142, horizontal-scaling W03 / W1a-2).
--
-- Every other per-feature settings table on the configuration-policy chain got
-- a SELECT-only own-partner branch in 2026-10-05-110000 (wave 1 of #4673) or in
-- its own creating migration (time_sync, 2026-11-10-120000). This table was
-- created by 2026-10-30-110100 without one, so an ORG-scoped context could not
-- read a partner-wide (org_id NULL) hardware-monitoring policy's settings, and
-- resolveHardwareMonitoring compensated by widening
-- breeze.accessible_partner_ids in place. W03 moves the agent heartbeat's
-- policy reads to the org-scoped context, so the branch is what makes
-- partner-wide hardware monitoring reach agents.
--
-- Same shape as config_policy_time_sync_settings_partner_wide_select: a
-- SEPARATE permissive FOR SELECT policy (never an edit to the per-command
-- breeze_parent_* policies), so UPDATE/DELETE targeting is unchanged.
-- Idempotent. Writes no rows, so no breeze.scope elevation is needed.
DROP POLICY IF EXISTS config_policy_hardware_monitoring_settings_partner_wide_select
  ON public.config_policy_hardware_monitoring_settings;
CREATE POLICY config_policy_hardware_monitoring_settings_partner_wide_select
  ON public.config_policy_hardware_monitoring_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = (
        SELECT fl.config_policy_id FROM public.config_policy_feature_links fl
        WHERE fl.id = config_policy_hardware_monitoring_settings.feature_link_id
      )
      AND cp.org_id IS NULL
      AND cp.partner_id = public.breeze_current_partner_id()
    )
  );
```

Before committing, confirm it still sorts last: `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -2` must print this file last. If a newer one landed, rename to sort after it.

- [ ] **Step 4: Run the RLS test to verify it passes**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts`
Expected: PASS (2 tests). The integration global setup applies the new migration.

- [ ] **Step 5: Write the failing unit test for the time-sync widening removal**

Append to `apps/api/src/services/timeSync/settings.test.ts` (it already mocks `../configPolicyOwnership` with a `withDevicePartnerPolicyVisibility` pass-through at :24; reuse its existing device/select arrangement helpers in the file's first `describe`):

```ts
  it('reads in the caller\'s own context: no accessible_partner_ids widening (#8142)', async () => {
    const ownership = await import('../configPolicyOwnership');
    await resolveDeviceTimeSyncSettings(DEVICE_ID, { hierarchy: HIERARCHY_WITH_PARTNER });
    expect(vi.mocked(ownership.withDevicePartnerPolicyVisibility)).not.toHaveBeenCalled();
  });
```

If the file has no `HIERARCHY_WITH_PARTNER` constant yet, add it next to its other fixtures:

```ts
const HIERARCHY_WITH_PARTNER = {
  deviceId: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, deviceRole: 'workstation', osType: 'windows',
  org: { partnerId: '00000000-0000-4000-8000-0000000000aa', type: 'customer' },
  site: null, groupIds: [],
} as const;
```

(`DEVICE_ID`, `ORG_ID`, `SITE_ID` are the file's existing ids; if they are named differently, use those names.)

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/timeSync/settings.test.ts`
Expected: FAIL — `expected "spy" to not be called at least once`.

- [ ] **Step 7: Remove the two widenings**

In `apps/api/src/services/timeSync/settings.ts`, replace

```ts
  const rows = await withDevicePartnerPolicyVisibility(
    db,
    org?.partnerId ?? null,
    (executor) =>
      executor
        .select({
```

with

```ts
  // #8142: read in the caller's own context. config_policy_time_sync_settings
  // carries the SELECT-only partner-wide branch, so a context with
  // currentPartnerId (the agent heartbeat, every user context) sees its own
  // partner's partner-wide rows without widening accessible_partner_ids.
  const rows = await db
        .select({
```

and remove the matching closing `),\n  );` of the wrapper (the statement now ends at the `.where(...)` call with `;`). Drop `withDevicePartnerPolicyVisibility` from the `../configPolicyOwnership` import.

In `apps/api/src/routes/agents/helpers.ts` `resolveHardwareMonitoring`, replace

```ts
  const rows = await withDevicePartnerPolicyVisibility(db, org?.partnerId ?? null, async (executor) =>
    executor
      .select({
```

with

```ts
  // #8142: config_policy_hardware_monitoring_settings now carries the
  // SELECT-only partner-wide branch (2026-12-18-100000), so this reads in the
  // caller's own context — no breeze.accessible_partner_ids widening.
  const rows = await db
      .select({
```

and remove the wrapper's closing `)` after `.where(...)`. Update the function's doc comment: delete the paragraph beginning "Uses `withDevicePartnerPolicyVisibility` to temporarily widen visibility" and replace it with one line: `Reads in the caller's own context; partner-wide rows are granted by the *_partner_wide_select branches.` Remove `withDevicePartnerPolicyVisibility` from the import at :68 (keep `policyOwnershipCondition`).

- [ ] **Step 8: Run unit + RLS suites**

Run: `cd apps/api && npx vitest run src/services/timeSync/settings.test.ts src/routes/agents/helpers.partnerWidePolicies.test.ts` — Expected: PASS.
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts src/__tests__/integration/configPolicyPartnerWideSelect.integration.test.ts src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts` — Expected: PASS.
Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` — Expected: PASS (the new policy is an additional permissive SELECT policy, the same shape time_sync already passes with).

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-12-18-100000-hardware-monitoring-settings-partner-wide-select.sql \
  apps/api/src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts \
  apps/api/src/routes/agents/helpers.ts apps/api/src/services/timeSync/settings.ts apps/api/src/services/timeSync/settings.test.ts
git commit -m "feat(rls): partner-wide read branch for hardware-monitoring settings; drop GUC widening (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `DevicePolicySet` — one-statement loader, grouping, guard and selectors

**Files:**
- Create: `apps/api/src/services/devicePolicySet.ts`
- Create: `apps/api/src/services/devicePolicySet.test.ts`
- Create: `apps/api/src/__tests__/integration/policySetFixtures.ts`
- Create: `apps/api/src/__tests__/integration/devicePolicySet.integration.test.ts`

**Interfaces:**
- Consumes: `DeviceHierarchy`, `DeviceHierarchyOpts` (`services/deviceHierarchy.ts`); `DbExecutor` (`services/monitors/monitorCompiler.ts`); `isQuickSupportOrgType` (`services/quickSupportOrg.ts`); `isUnassignedPoolOrgType` (`services/unassignedPool/orgType.ts`).
- Produces (later tasks rely on these exact names):
  - `POLICY_SET_FEATURE_TYPES`, `type PolicySetFeatureType`
  - `interface PolicySetLink { id; featureType; featurePolicyId; inlineSettings: unknown; eventLog: EventLogSettingsRow | null; hardwareMonitoring: HardwareMonitoringSettingsRow | null; patch: PatchSourceSettingsRow | null; timeSync: TimeSyncSettingsRow | null; onedrive: OnedriveSettingsRow | null }`
  - `interface PolicyCandidate { assignmentId; level; targetId; priority: number; roleFilter: string[] | null; osFilter: string[] | null; assignmentCreatedAt: Date; policyId; policyName: string; policyOrgId: string | null; policyPartnerId: string | null; parentPolicyId: string | null; links: Partial<Record<PolicySetFeatureType, PolicySetLink>> }`
  - `interface DevicePolicySet { deviceId: string; hierarchy: DeviceHierarchy; candidates: readonly PolicyCandidate[] }`
  - `loadDevicePolicySet(hierarchy: DeviceHierarchy, executor?: DbExecutor): Promise<DevicePolicySet>`; `policySetQuery(hierarchy, executor?)` (the unexecuted statement, for the Task 9 perf probe)
  - `groupPolicySetRows(hierarchy, rows: readonly PolicySetRow[]): DevicePolicySet` (exported for tests)
  - `interface DevicePolicySetOpts extends DeviceHierarchyOpts { policySet?: DevicePolicySet }`
  - `class DevicePolicySetMismatchError`; `policySetFor(deviceId, opts): DevicePolicySet | undefined`; `withPolicySet(set: DevicePolicySet | null, hierarchy: DeviceHierarchy | null): DevicePolicySetOpts | undefined`
  - `interface ApplicabilityRule { ownership: 'orgOrPartner' | 'orgOrPartnerUnlessUnassignedPool' | 'orgOnly'; partnerTarget: 'partner' | 'partnerUnlessUnassignedPool' | 'partnerUnlessQuickSupportOrUnassignedPool'; roleOs: 'none' | 'sql' }`
  - `sqlRoleOsMatch(c, device): boolean`; `applicableCandidates(set, rule): PolicyCandidate[]`; `candidatesWithLink(set, featureType, rule): Array<{ candidate: PolicyCandidate; link: PolicySetLink }>`
  - Fixture module exports (Task 2 creates, Tasks 3–6 and 9 use): `SYSTEM_CTX`, `sys`, `orgCtxFor`, `inOrg`, `seedDevice`, `seedPolicy`, `seedParityWorld`, `dropDeviceRedisCaches`, `type ParityWorld`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// apps/api/src/services/devicePolicySet.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  applicableCandidates,
  candidatesWithLink,
  DevicePolicySetMismatchError,
  groupPolicySetRows,
  policySetFor,
  sqlRoleOsMatch,
  withPolicySet,
  type PolicySetRow,
} from './devicePolicySet';
import type { DeviceHierarchy } from './deviceHierarchy';

const DEVICE = 'dev-1';
const ORG = 'org-1';
const PARTNER = 'partner-1';
const hierarchy = (over: Partial<DeviceHierarchy> = {}): DeviceHierarchy => ({
  deviceId: DEVICE, orgId: ORG, siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
  org: { partnerId: PARTNER, type: 'customer' }, site: null, groupIds: ['g-1'], ...over,
});

let seq = 0;
function row(over: Partial<PolicySetRow> = {}): PolicySetRow {
  seq += 1;
  return {
    assignmentId: `a-${seq}`, level: 'organization', targetId: ORG, priority: 0,
    roleFilter: null, osFilter: null, assignmentCreatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    policyId: `p-${seq}`, policyName: `policy ${seq}`, policyOrgId: ORG, policyPartnerId: null, parentPolicyId: null,
    linkId: null, featureType: null, featurePolicyId: null, inlineSettings: null,
    eventLog: null, hardwareMonitoring: null, patch: null, timeSync: null, onedrive: null,
    ...over,
  };
}

describe('groupPolicySetRows', () => {
  it('groups link rows by assignment, keeps the SQL order, and keeps link-less assignments', () => {
    const a = row({ assignmentId: 'a-x', linkId: 'l-1', featureType: 'helper', inlineSettings: { enabled: true } });
    const a2 = { ...a, linkId: 'l-2', featureType: 'pam' as const, inlineSettings: { uacInterceptionEnabled: true } };
    const b = row({ assignmentId: 'a-y' });
    const set = groupPolicySetRows(hierarchy(), [a, a2, b]);
    expect(set.candidates.map((c) => c.assignmentId)).toEqual(['a-x', 'a-y']);
    expect(Object.keys(set.candidates[0]!.links).sort()).toEqual(['helper', 'pam']);
    expect(set.candidates[1]!.links).toEqual({});
  });

  it('keeps the same link id under two assignments (the view reuses a parent link id for every child)', () => {
    const shared = { linkId: 'parent-link', featureType: 'time_sync' as const };
    const set = groupPolicySetRows(hierarchy(), [row({ assignmentId: 'child-1', ...shared }), row({ assignmentId: 'child-2', ...shared })]);
    expect(set.candidates.map((c) => c.links.time_sync?.id)).toEqual(['parent-link', 'parent-link']);
  });

  it('a link whose settings row is absent carries null settings (a presence sentinel, never defaults)', () => {
    const set = groupPolicySetRows(hierarchy(), [row({ linkId: 'l-ev', featureType: 'event_log', eventLog: null })]);
    expect(set.candidates[0]!.links.event_log?.eventLog).toBeNull();
  });

  it('refuses two effective links of one type for one assignment', () => {
    const r = row({ assignmentId: 'dup', linkId: 'l-a', featureType: 'pam' });
    expect(() => groupPolicySetRows(hierarchy(), [r, { ...r, linkId: 'l-b' }])).toThrow(/two effective pam links/);
  });
});

describe('applicableCandidates', () => {
  const build = (h: DeviceHierarchy, rows: PolicySetRow[]) => groupPolicySetRows(h, rows);
  const partnerWideAtPartner = () => row({ level: 'partner', targetId: PARTNER, policyOrgId: null, policyPartnerId: PARTNER });

  it('raw partner: admits a partner-wide policy assigned at partner level', () => {
    const set = build(hierarchy(), [partnerWideAtPartner()]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(1);
  });

  it('orgOnly ownership drops a partner-wide policy even when it targets the org', () => {
    const set = build(hierarchy(), [row({ policyOrgId: null, policyPartnerId: PARTNER })]);
    expect(applicableCandidates(set, { ownership: 'orgOnly', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(0);
  });

  it('unassigned_pool: patch rule drops partner ownership and partner target; raw rule keeps them', () => {
    const set = build(hierarchy({ org: { partnerId: PARTNER, type: 'unassigned_pool' } }), [partnerWideAtPartner()]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartnerUnlessUnassignedPool', partnerTarget: 'partnerUnlessUnassignedPool', roleOs: 'sql' })).toHaveLength(0);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(1);
  });

  it('quick_support: monitors rule drops the partner-level target but keeps partner-wide ownership at org level', () => {
    const h = hierarchy({ org: { partnerId: PARTNER, type: 'quick_support' } });
    const set = build(h, [partnerWideAtPartner(), row({ level: 'organization', targetId: ORG, policyOrgId: null, policyPartnerId: PARTNER })]);
    const kept = applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partnerUnlessQuickSupportOrUnassignedPool', roleOs: 'sql' });
    expect(kept.map((c) => c.level)).toEqual(['organization']);
  });

  it('targets: a sibling device, a foreign group and a foreign site never match', () => {
    const set = build(hierarchy(), [
      row({ level: 'device', targetId: 'dev-2' }),
      row({ level: 'device_group', targetId: 'g-other' }),
      row({ level: 'site', targetId: 'site-other' }),
      row({ level: 'device_group', targetId: 'g-1' }),
    ]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' }).map((c) => c.targetId)).toEqual(['g-1']);
  });

  it('no org row: ownership is org-only and no partner target applies', () => {
    const set = build(hierarchy({ org: null }), [partnerWideAtPartner(), row()]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(1);
  });
});

describe('sqlRoleOsMatch', () => {
  it('mirrors (filter IS NULL OR $v = ANY(filter)), including the empty-string role SQL admits', () => {
    expect(sqlRoleOsMatch({ roleFilter: null, osFilter: null }, { deviceRole: 'x', osType: 'y' })).toBe(true);
    expect(sqlRoleOsMatch({ roleFilter: [], osFilter: null }, { deviceRole: 'x', osType: 'y' })).toBe(false);
    expect(sqlRoleOsMatch({ roleFilter: ['printer'], osFilter: null }, { deviceRole: 'workstation', osType: 'y' })).toBe(false);
    expect(sqlRoleOsMatch({ roleFilter: [''], osFilter: null }, { deviceRole: '', osType: 'y' })).toBe(true);
    expect(sqlRoleOsMatch({ roleFilter: null, osFilter: ['linux'] }, { deviceRole: 'x', osType: 'windows' })).toBe(false);
  });
});

describe('candidatesWithLink', () => {
  it('returns applicable candidates that carry an effective link of the type, in candidate order', () => {
    const set = groupPolicySetRows(hierarchy(), [
      row({ assignmentId: 'first', linkId: 'l1', featureType: 'pam' }),
      row({ assignmentId: 'nolink' }),
      row({ assignmentId: 'second', linkId: 'l2', featureType: 'pam' }),
    ]);
    expect(candidatesWithLink(set, 'pam', { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })
      .map(({ candidate }) => candidate.assignmentId)).toEqual(['first', 'second']);
  });
});

describe('policySetFor / withPolicySet', () => {
  it('returns the set for its own device and refuses another device\'s set', () => {
    const set = groupPolicySetRows(hierarchy(), []);
    expect(policySetFor(DEVICE, withPolicySet(set, null))).toBe(set);
    expect(() => policySetFor('dev-2', withPolicySet(set, null))).toThrow(DevicePolicySetMismatchError);
  });

  it('refuses a set paired with a different hierarchy object', () => {
    const set = groupPolicySetRows(hierarchy(), []);
    expect(() => policySetFor(DEVICE, { hierarchy: hierarchy(), policySet: set })).toThrow(DevicePolicySetMismatchError);
  });

  it('withPolicySet(null, h) passes the hierarchy alone; (null, null) passes nothing', () => {
    const h = hierarchy();
    expect(withPolicySet(null, h)).toEqual({ hierarchy: h });
    expect(withPolicySet(null, null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/devicePolicySet.test.ts`
Expected: FAIL — `Failed to resolve import "./devicePolicySet"`.

- [ ] **Step 3: Write the module**

```ts
// apps/api/src/services/devicePolicySet.ts
/**
 * A device's candidate configuration-policy assignments for every feature the
 * agent heartbeat delivers, read in ONE statement (#8142, scaling W03 / W1a-2).
 *
 * Before this, each of ten heartbeat resolvers ran its own assignment query
 * (ten statements per beat). The set is a SUPERSET of every one of them:
 * ownership = the device's org OR its partner's partner-wide policies (raw
 * partner), targets = device / site / org / its groups / its partner (raw),
 * NO role/OS predicate. Each resolver then applies ITS OWN rules in TypeScript
 * (`applicableCandidates` with its `ApplicabilityRule`, plus whatever filtering
 * and ranking it already did) and must produce exactly what its own SQL did —
 * the parity suite proves that per resolver against real Postgres.
 *
 * Tenancy: the heartbeat loads this inside an ORG-scoped context
 * (accessibleOrgIds [deviceOrg], currentPartnerId = the device's partner), so
 * RLS — not the WHERE clause below — bounds every row to the device's own org
 * plus its own partner's partner-wide rows (the SELECT-only
 * *_partner_wide_select branches). The selectors only decide which of the
 * tenant's own assignments target THIS device. A set is for ONE device:
 * `policySetFor` throws when a resolver for device A is handed B's set.
 *
 * Settings: the five 1:1 settings tables are LEFT JOINed per feature type; a
 * null sub-object means "no settings row", which every inner-joining resolver
 * treats as "this candidate does not exist" — never as defaults.
 *
 * Order: created_at, id. Ranking ties that today's SQL left to plan order are
 * therefore won by the earliest assignment (the legacy queries got the same
 * ORDER BY in the same wave, so both paths agree).
 */
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyEventLogSettings,
  configPolicyHardwareMonitoringSettings,
  configPolicyOnedriveSettings,
  configPolicyPatchSettings,
  configPolicyTimeSyncSettings,
  configurationPolicies,
} from '../db/schema';
import type { DeviceHierarchy, DeviceHierarchyOpts } from './deviceHierarchy';
import type { DbExecutor } from './monitors/monitorCompiler';
import { isQuickSupportOrgType } from './quickSupportOrg';
import { isUnassignedPoolOrgType } from './unassignedPool/orgType';

export const POLICY_SET_FEATURE_TYPES = [
  'event_log', 'hardware_monitoring', 'helper', 'monitors', 'onedrive_helper',
  'pam', 'patch', 'time_sync', 'warranty',
] as const;
export type PolicySetFeatureType = (typeof POLICY_SET_FEATURE_TYPES)[number];
export type PolicyAssignmentLevel = (typeof configPolicyAssignments.$inferSelect)['level'];

export type EventLogSettingsRow = Pick<typeof configPolicyEventLogSettings.$inferSelect,
  'id' | 'retentionDays' | 'maxEventsPerCycle' | 'collectCategories' | 'minimumLevel' | 'collectionIntervalMinutes' | 'rateLimitPerHour'>;
export type HardwareMonitoringSettingsRow = Pick<typeof configPolicyHardwareMonitoringSettings.$inferSelect,
  'id' | 'enabled' | 'pollIntervalMinutes' | 'diskHealthIntervalMinutes'>;
export type PatchSourceSettingsRow = Pick<typeof configPolicyPatchSettings.$inferSelect, 'id' | 'exclusiveWindowsUpdate'>;
export type TimeSyncSettingsRow = Pick<typeof configPolicyTimeSyncSettings.$inferSelect,
  'id' | 'enforceNtp' | 'ntpServers' | 'pollIntervalMinutes' | 'timezoneExpected' | 'pinnedTimezone' | 'timezoneAutoFix'>;
export type OnedriveSettingsRow = Pick<typeof configPolicyOnedriveSettings.$inferSelect,
  'id' | 'silentAccountConfig' | 'filesOnDemand' | 'kfmSilentOptIn' | 'kfmFolders' | 'kfmBlockOptOut' | 'tenantAssociationId' | 'restartOnChange'>;

export interface PolicySetLink {
  /** The UNDERLYING link id (a parent's id for an inherited link). */
  readonly id: string;
  readonly featureType: PolicySetFeatureType;
  readonly featurePolicyId: string | null;
  readonly inlineSettings: unknown;
  readonly eventLog: EventLogSettingsRow | null;
  readonly hardwareMonitoring: HardwareMonitoringSettingsRow | null;
  readonly patch: PatchSourceSettingsRow | null;
  readonly timeSync: TimeSyncSettingsRow | null;
  readonly onedrive: OnedriveSettingsRow | null;
}

export interface PolicyCandidate {
  readonly assignmentId: string;
  readonly level: PolicyAssignmentLevel;
  readonly targetId: string;
  readonly priority: number;
  readonly roleFilter: string[] | null;
  readonly osFilter: string[] | null;
  readonly assignmentCreatedAt: Date;
  /** The ASSIGNED policy (never the parent a link was inherited from). */
  readonly policyId: string;
  readonly policyName: string;
  readonly policyOrgId: string | null;
  readonly policyPartnerId: string | null;
  readonly parentPolicyId: string | null;
  readonly links: Readonly<Partial<Record<PolicySetFeatureType, PolicySetLink>>>;
}

export interface DevicePolicySet {
  readonly deviceId: string;
  readonly hierarchy: DeviceHierarchy;
  readonly candidates: readonly PolicyCandidate[];
}

/** One row of the set statement (exported for tests). */
export interface PolicySetRow {
  assignmentId: string;
  level: PolicyAssignmentLevel;
  targetId: string;
  priority: number;
  roleFilter: string[] | null;
  osFilter: string[] | null;
  assignmentCreatedAt: Date;
  policyId: string;
  policyName: string;
  policyOrgId: string | null;
  policyPartnerId: string | null;
  parentPolicyId: string | null;
  linkId: string | null;
  featureType: PolicySetFeatureType | null;
  featurePolicyId: string | null;
  inlineSettings: unknown;
  eventLog: EventLogSettingsRow | null;
  hardwareMonitoring: HardwareMonitoringSettingsRow | null;
  patch: PatchSourceSettingsRow | null;
  timeSync: TimeSyncSettingsRow | null;
  onedrive: OnedriveSettingsRow | null;
}

/** A left-joined nested object is present only when its primary key is. */
function present<T extends { id: string | null }>(value: T | null): (T & { id: string }) | null {
  return value && value.id !== null ? (value as T & { id: string }) : null;
}

export async function loadDevicePolicySet(hierarchy: DeviceHierarchy, executor: DbExecutor = db): Promise<DevicePolicySet> {
  const rows = await policySetQuery(hierarchy, executor);
  return groupPolicySetRows(hierarchy, rows.map((r) => ({
    ...r,
    featureType: r.featureType as PolicySetFeatureType | null,
    eventLog: present(r.eventLog),
    hardwareMonitoring: present(r.hardwareMonitoring),
    patch: present(r.patch),
    timeSync: present(r.timeSync),
    onedrive: present(r.onedrive),
  })));
}

/** The set statement, unexecuted — exported so the Task 9 perf probe can EXPLAIN exactly it. */
export function policySetQuery(hierarchy: DeviceHierarchy, executor: DbExecutor = db) {
  const partnerId = hierarchy.org?.partnerId ?? null;
  const ownership: SQL = partnerId
    ? sql`(${configurationPolicies.orgId} = ${hierarchy.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${partnerId}))`
    : sql`${configurationPolicies.orgId} = ${hierarchy.orgId}`;
  const targets: SQL[] = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, hierarchy.deviceId))!,
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, hierarchy.siteId))!,
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, hierarchy.orgId))!,
  ];
  if (hierarchy.groupIds.length > 0) {
    targets.push(and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, [...hierarchy.groupIds]))!);
  }
  if (partnerId) {
    targets.push(and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, partnerId))!);
  }

  const link = configPolicyEffectiveFeatureLinks;
  const ev = configPolicyEventLogSettings;
  const hw = configPolicyHardwareMonitoringSettings;
  const pt = configPolicyPatchSettings;
  const ts = configPolicyTimeSyncSettings;
  const od = configPolicyOnedriveSettings;

  return executor
    .select({
      assignmentId: configPolicyAssignments.id,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      priority: configPolicyAssignments.priority,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
      policyOrgId: configurationPolicies.orgId,
      policyPartnerId: configurationPolicies.partnerId,
      parentPolicyId: configurationPolicies.parentPolicyId,
      linkId: link.id,
      featureType: link.featureType,
      featurePolicyId: link.featurePolicyId,
      inlineSettings: link.inlineSettings,
      eventLog: {
        id: ev.id, retentionDays: ev.retentionDays, maxEventsPerCycle: ev.maxEventsPerCycle,
        collectCategories: ev.collectCategories, minimumLevel: ev.minimumLevel,
        collectionIntervalMinutes: ev.collectionIntervalMinutes, rateLimitPerHour: ev.rateLimitPerHour,
      },
      hardwareMonitoring: {
        id: hw.id, enabled: hw.enabled, pollIntervalMinutes: hw.pollIntervalMinutes, diskHealthIntervalMinutes: hw.diskHealthIntervalMinutes,
      },
      patch: { id: pt.id, exclusiveWindowsUpdate: pt.exclusiveWindowsUpdate },
      timeSync: {
        id: ts.id, enforceNtp: ts.enforceNtp, ntpServers: ts.ntpServers, pollIntervalMinutes: ts.pollIntervalMinutes,
        timezoneExpected: ts.timezoneExpected, pinnedTimezone: ts.pinnedTimezone, timezoneAutoFix: ts.timezoneAutoFix,
      },
      onedrive: {
        id: od.id, silentAccountConfig: od.silentAccountConfig, filesOnDemand: od.filesOnDemand,
        kfmSilentOptIn: od.kfmSilentOptIn, kfmFolders: od.kfmFolders, kfmBlockOptOut: od.kfmBlockOptOut,
        tenantAssociationId: od.tenantAssociationId, restartOnChange: od.restartOnChange,
      },
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active'),
    ))
    .leftJoin(link, and(
      eq(link.configPolicyId, configurationPolicies.id),
      inArray(link.featureType, [...POLICY_SET_FEATURE_TYPES]),
    ))
    .leftJoin(ev, and(eq(ev.featureLinkId, link.id), eq(link.featureType, 'event_log')))
    .leftJoin(hw, and(eq(hw.featureLinkId, link.id), eq(link.featureType, 'hardware_monitoring')))
    .leftJoin(pt, and(eq(pt.featureLinkId, link.id), eq(link.featureType, 'patch')))
    .leftJoin(ts, and(eq(ts.featureLinkId, link.id), eq(link.featureType, 'time_sync')))
    .leftJoin(od, and(eq(od.featureLinkId, link.id), eq(link.featureType, 'onedrive_helper')))
    .where(and(ownership, or(...targets)))
    .orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id), asc(link.featureType));
}

export function groupPolicySetRows(hierarchy: DeviceHierarchy, rows: readonly PolicySetRow[]): DevicePolicySet {
  const byAssignment = new Map<string, { row: PolicySetRow; links: Partial<Record<PolicySetFeatureType, PolicySetLink>> }>();
  for (const row of rows) {
    let entry = byAssignment.get(row.assignmentId);
    if (!entry) {
      entry = { row, links: {} };
      byAssignment.set(row.assignmentId, entry);
    }
    if (row.linkId === null || row.featureType === null) continue;
    if (entry.links[row.featureType]) {
      // Not reachable: (config_policy_id, feature_type) is unique and the view
      // only inherits a type the child lacks. Throwing takes the heartbeat's
      // set-error path (resolvers read their own), never a silent pick.
      throw new Error(`device policy set: two effective ${row.featureType} links for assignment ${row.assignmentId}`);
    }
    entry.links[row.featureType] = Object.freeze({
      id: row.linkId,
      featureType: row.featureType,
      featurePolicyId: row.featurePolicyId,
      inlineSettings: row.inlineSettings,
      eventLog: row.eventLog,
      hardwareMonitoring: row.hardwareMonitoring,
      patch: row.patch,
      timeSync: row.timeSync,
      onedrive: row.onedrive,
    });
  }
  const candidates = [...byAssignment.values()].map(({ row, links }) => Object.freeze({
    assignmentId: row.assignmentId,
    level: row.level,
    targetId: row.targetId,
    priority: row.priority,
    roleFilter: row.roleFilter,
    osFilter: row.osFilter,
    assignmentCreatedAt: row.assignmentCreatedAt,
    policyId: row.policyId,
    policyName: row.policyName,
    policyOrgId: row.policyOrgId,
    policyPartnerId: row.policyPartnerId,
    parentPolicyId: row.parentPolicyId,
    links: Object.freeze(links),
  }));
  return Object.freeze({ deviceId: hierarchy.deviceId, hierarchy, candidates: Object.freeze(candidates) });
}

// ---------------------------------------------------------------- guard

export interface DevicePolicySetOpts extends DeviceHierarchyOpts {
  policySet?: DevicePolicySet;
}

export class DevicePolicySetMismatchError extends Error {
  constructor(readonly setDeviceId: string, readonly resolverDeviceId: string) {
    super(`device policy set for ${setDeviceId} was passed to a resolver for ${resolverDeviceId}`);
    this.name = 'DevicePolicySetMismatchError';
  }
}

/** The caller's set for `deviceId`, or undefined to make the resolver read its own. */
export function policySetFor(deviceId: string, opts: DevicePolicySetOpts | undefined): DevicePolicySet | undefined {
  const set = opts?.policySet;
  if (!set) return undefined;
  if (set.deviceId !== deviceId || set.hierarchy.deviceId !== deviceId) {
    throw new DevicePolicySetMismatchError(set.deviceId, deviceId);
  }
  if (opts?.hierarchy && opts.hierarchy !== set.hierarchy) {
    throw new DevicePolicySetMismatchError(set.deviceId, deviceId);
  }
  return set;
}

export function withPolicySet(set: DevicePolicySet | null, hierarchy: DeviceHierarchy | null): DevicePolicySetOpts | undefined {
  if (set) return { hierarchy: set.hierarchy, policySet: set };
  return hierarchy ? { hierarchy } : undefined;
}

// ------------------------------------------------------------ selectors

export interface ApplicabilityRule {
  /** Whose partner-wide policies the resolver admits. */
  ownership: 'orgOrPartner' | 'orgOrPartnerUnlessUnassignedPool' | 'orgOnly';
  /** Whether a `level='partner'` assignment targets this device. */
  partnerTarget: 'partner' | 'partnerUnlessUnassignedPool' | 'partnerUnlessQuickSupportOrUnassignedPool';
  /** 'sql' = the resolver's buildRoleOsFilterConditions predicate. */
  roleOs: 'none' | 'sql';
}

/** Exactly `(filter IS NULL OR $v = ANY(filter))` for role and OS. */
export function sqlRoleOsMatch(
  c: { roleFilter: string[] | null; osFilter: string[] | null },
  device: { deviceRole: string | null; osType: string | null },
): boolean {
  const roleOk = c.roleFilter === null || (device.deviceRole !== null && c.roleFilter.includes(device.deviceRole));
  const osOk = c.osFilter === null || (device.osType !== null && c.osFilter.includes(device.osType));
  return roleOk && osOk;
}

export function applicableCandidates(set: DevicePolicySet, rule: ApplicabilityRule): PolicyCandidate[] {
  const h = set.hierarchy;
  const rawPartner = h.org?.partnerId ?? null;
  const orgType = h.org?.type;
  const ownerPartner = rule.ownership === 'orgOnly'
    ? null
    : rule.ownership === 'orgOrPartnerUnlessUnassignedPool' && isUnassignedPoolOrgType(orgType) ? null : rawPartner;
  const targetPartner = rule.partnerTarget === 'partner'
    ? rawPartner
    : rule.partnerTarget === 'partnerUnlessUnassignedPool'
      ? (isUnassignedPoolOrgType(orgType) ? null : rawPartner)
      : (isQuickSupportOrgType(orgType) || isUnassignedPoolOrgType(orgType) ? null : rawPartner);

  return set.candidates.filter((c) => {
    const owned = c.policyOrgId === h.orgId
      || (ownerPartner !== null && c.policyOrgId === null && c.policyPartnerId === ownerPartner);
    if (!owned) return false;
    const targeted =
      (c.level === 'device' && c.targetId === h.deviceId)
      || (c.level === 'site' && c.targetId === h.siteId)
      || (c.level === 'organization' && c.targetId === h.orgId)
      || (c.level === 'device_group' && h.groupIds.includes(c.targetId))
      || (c.level === 'partner' && targetPartner !== null && c.targetId === targetPartner);
    if (!targeted) return false;
    return rule.roleOs === 'none' || sqlRoleOsMatch(c, h);
  });
}

export function candidatesWithLink(
  set: DevicePolicySet,
  featureType: PolicySetFeatureType,
  rule: ApplicabilityRule,
): Array<{ candidate: PolicyCandidate; link: PolicySetLink }> {
  return applicableCandidates(set, rule).flatMap((candidate) => {
    const link = candidate.links[featureType];
    return link ? [{ candidate, link }] : [];
  });
}
```

- [ ] **Step 4: Run the unit tests to verify they pass; typecheck**

Run: `cd apps/api && npx vitest run src/services/devicePolicySet.test.ts` — Expected: PASS (15 tests).
Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"` — Expected: `tsc exit 0` (check the exit code, never pipe tsc through `tail`). If Drizzle types `featureType` as the full enum union, the `as PolicySetFeatureType | null` cast in `loadDevicePolicySet` is the one sanctioned narrowing (the `IN` predicate guarantees it).

- [ ] **Step 5: Write the shared fixture module**

```ts
// apps/api/src/__tests__/integration/policySetFixtures.ts
/**
 * Real-Postgres fixture world for the W03 policy-set suites (#8142). Not a
 * test file. Every helper seeds in SYSTEM scope; the suites then read in
 * system scope (legacy) and in the heartbeat's org-scoped context.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configPolicyHardwareMonitoringSettings,
  configPolicyMonitoringSettings,
  configPolicyMonitors,
  configPolicyOnedriveLibraries,
  configPolicyOnedriveSettings,
  configPolicyPatchSettings,
  configPolicyTimeSyncSettings,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  monitorDefinitions,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestRedis } from './setup';

export const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
export const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

/** Exactly the heartbeat's org-scoped dbContext (heartbeat.ts `dbContext`). */
export function orgCtxFor(orgId: string, partnerId: string | null): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null,
    currentPartnerId: partnerId,
  };
}
export const inOrg = <T>(orgId: string, partnerId: string | null, fn: () => Promise<T>) =>
  withDbAccessContext(orgCtxFor(orgId, partnerId), fn);

export type Level = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

export async function seedDevice(orgId: string, siteId: string, label: string, osType = 'windows'): Promise<string> {
  return sys(async () => {
    const unique = randomUUID().slice(0, 8);
    await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [device] = await db.insert(devices).values({
      orgId, siteId, agentId: `ps-${label}-${unique}`, hostname: `ps-${label}-${unique}`,
      osType, osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    } as never).returning();
    return device!.id;
  });
}

export type SeedLink =
  | { featureType: 'helper' | 'pam' | 'warranty'; inlineSettings: Record<string, unknown> }
  | { featureType: 'event_log'; maxEventsPerCycle?: number; withoutSettings?: true }
  | { featureType: 'hardware_monitoring'; pollIntervalMinutes: number }
  | { featureType: 'patch'; exclusiveWindowsUpdate: boolean }
  | { featureType: 'time_sync'; ntpServers: string[] }
  | { featureType: 'monitors'; serviceName?: string; checkIntervalSeconds?: number; inheritance?: 'cumulative' | 'replace' }
  | { featureType: 'onedrive_helper'; orgId: string; filesOnDemand: boolean; libraryName: string };

export interface SeedAssignment {
  level: Level;
  targetId: string;
  priority?: number;
  roleFilter?: string[];
  osFilter?: string[];
  createdAt?: Date;
}

export async function seedPolicy(input: {
  owner: { orgId: string | null; partnerId: string | null };
  name?: string;
  status?: 'active' | 'inactive';
  parentPolicyId?: string;
  links?: SeedLink[];
  assignments?: SeedAssignment[];
}): Promise<string> {
  return sys(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: input.owner.orgId, partnerId: input.owner.partnerId,
      name: input.name ?? `ps ${randomUUID()}`, status: input.status ?? 'active',
      ...(input.parentPolicyId ? { parentPolicyId: input.parentPolicyId } : {}),
    } as never).returning();
    for (const l of input.links ?? []) {
      const inline = l.featureType === 'helper' || l.featureType === 'pam' || l.featureType === 'warranty'
        ? l.inlineSettings
        : l.featureType === 'monitors' && l.inheritance ? { inheritance: l.inheritance } : undefined;
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: l.featureType as never,
        ...(inline ? { inlineSettings: inline } : {}),
      }).returning();
      const linkId = link!.id;
      if (l.featureType === 'event_log' && !l.withoutSettings) {
        await db.insert(configPolicyEventLogSettings).values({ featureLinkId: linkId, retentionDays: 30, maxEventsPerCycle: l.maxEventsPerCycle ?? 100 });
      }
      if (l.featureType === 'hardware_monitoring') {
        await db.insert(configPolicyHardwareMonitoringSettings).values({ featureLinkId: linkId, enabled: true, pollIntervalMinutes: l.pollIntervalMinutes, diskHealthIntervalMinutes: 60 });
      }
      if (l.featureType === 'patch') {
        await db.insert(configPolicyPatchSettings).values({ featureLinkId: linkId, exclusiveWindowsUpdate: l.exclusiveWindowsUpdate } as never);
      }
      if (l.featureType === 'time_sync') {
        await db.insert(configPolicyTimeSyncSettings).values({ featureLinkId: linkId, enforceNtp: true, ntpServers: l.ntpServers, pollIntervalMinutes: 30 } as never);
      }
      if (l.featureType === 'monitors') {
        if (l.serviceName) {
          const [monitor] = await db.insert(monitorDefinitions).values({
            orgId: input.owner.orgId, partnerId: input.owner.partnerId, name: `ps-mon-${randomUUID()}`, kind: 'service',
            condition: { serviceName: l.serviceName, consecutiveFailures: 2 }, severity: 'high',
          } as never).returning({ id: monitorDefinitions.id });
          await db.insert(configPolicyMonitors).values({ featureLinkId: linkId, monitorId: monitor!.id, enabled: true });
        }
        if (l.checkIntervalSeconds !== undefined) {
          await db.insert(configPolicyMonitoringSettings).values({ featureLinkId: linkId, checkIntervalSeconds: l.checkIntervalSeconds });
        }
      }
      if (l.featureType === 'onedrive_helper') {
        const [settings] = await db.insert(configPolicyOnedriveSettings).values({
          featureLinkId: linkId, orgId: l.orgId, filesOnDemand: l.filesOnDemand,
        } as never).returning();
        await db.insert(configPolicyOnedriveLibraries).values({
          settingsId: settings!.id, orgId: l.orgId, libraryId: `lib-${randomUUID()}`, displayName: l.libraryName,
          targetingMode: 'everyone', sortOrder: 0, enabled: true,
        } as never);
      }
    }
    for (const a of input.assignments ?? []) {
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy!.id, level: a.level, targetId: a.targetId, priority: a.priority ?? 0,
        ...(a.roleFilter ? { roleFilter: a.roleFilter } : {}),
        ...(a.osFilter ? { osFilter: a.osFilter } : {}),
        ...(a.createdAt ? { createdAt: a.createdAt } : {}),
      });
    }
    return policy!.id;
  });
}

export async function dropDeviceRedisCaches(deviceId: string): Promise<void> {
  const redis = getTestRedis();
  const keys = await redis.keys(`*${deviceId}*`);
  if (keys.length > 0) await redis.del(...keys);
}

export interface ParityWorld {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  siblingId: string;
  groupIds: [string, string];
  otherOrgId: string;
  foreignPartnerId: string;
  foreignOrgId: string;
  forgedPolicyIds: string[];
}

/**
 * Every heartbeat feature resolves to a NON-default answer for `deviceId`, and
 * each answer is decided by a rule the selectors must mirror:
 *  - helper: org policy at group g2 beats a partner-wide policy at partner level;
 *  - warranty: two group-level policies, the HIGHER priority number wins;
 *  - event_log: partner-wide at partner level (role-filtered to workstation)
 *    wins; an org site-level policy filtered to printer is excluded; a
 *    device-level link with NO settings row is excluded (presence sentinel);
 *  - hardware_monitoring: partner-wide at partner level (Task 1's RLS branch);
 *  - pam: partner-wide at partner level;
 *  - patch: partner-wide at partner level (true) beats nothing — an org policy
 *    filtered to linux is excluded;
 *  - time_sync: an org child policy assigned at DEVICE level inherits its
 *    time_sync link from an INACTIVE partner-wide parent (view inheritance;
 *    parent status ignored), beating a partner-wide partner-level policy;
 *  - monitors / check interval: partner-wide at partner level (attachment +
 *    120 s) plus an org site-level REPLACE link with no attachments and no
 *    interval (empty replace link);
 *  - onedrive: org policy at site level.
 * Negatives that must never reach `deviceId`: a sibling's device-level helper;
 * forged rows — another org's policy (same partner) and another partner's
 * org policy, each assigned at level 'device' to `deviceId`, and another
 * partner's partner-wide policy assigned at level 'partner' to OUR partner.
 */
export async function seedParityWorld(): Promise<ParityWorld> {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const otherOrg = (await createOrganization({ partnerId: partner.id }))!;
  const foreignPartner = (await createPartner())!;
  const foreignOrg = (await createOrganization({ partnerId: foreignPartner.id }))!;
  const deviceId = await seedDevice(org.id, site.id, 'agent');
  const siblingId = await seedDevice(org.id, site.id, 'sibling');
  const groupIds = await sys(async () => {
    const ids: string[] = [];
    for (const name of ['g1', 'g2']) {
      const [group] = await db.insert(deviceGroups).values({ orgId: org.id, name: `ps ${name} ${randomUUID().slice(0, 8)}` }).returning();
      await db.insert(deviceGroupMemberships).values({ deviceId, groupId: group!.id, orgId: org.id });
      ids.push(group!.id);
    }
    return ids as [string, string];
  });
  const P = { orgId: null, partnerId: partner.id };
  const O = { orgId: org.id, partnerId: null };

  await seedPolicy({ owner: O, links: [{ featureType: 'helper', inlineSettings: { enabled: true, showTrayIcon: false } }],
    assignments: [{ level: 'device_group', targetId: groupIds[1] }] });
  await seedPolicy({ owner: P, links: [{ featureType: 'helper', inlineSettings: { enabled: false } }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://sibling.example' } }],
    assignments: [{ level: 'device', targetId: siblingId }] });

  await seedPolicy({ owner: O, links: [{ featureType: 'warranty', inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 } }],
    assignments: [{ level: 'device_group', targetId: groupIds[0], priority: 1 }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'warranty', inlineSettings: { enabled: true, warnDays: 45, criticalDays: 10 } }],
    assignments: [{ level: 'device_group', targetId: groupIds[0], priority: 5 }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'event_log', maxEventsPerCycle: 321 }],
    assignments: [{ level: 'partner', targetId: partner.id, roleFilter: ['workstation'] }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'event_log', maxEventsPerCycle: 555 }],
    assignments: [{ level: 'site', targetId: site.id, roleFilter: ['printer'] }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'event_log', withoutSettings: true }],
    assignments: [{ level: 'device', targetId: deviceId }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'hardware_monitoring', pollIntervalMinutes: 7 }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: P, links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
    assignments: [{ level: 'partner', targetId: partner.id }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'patch', exclusiveWindowsUpdate: true }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'patch', exclusiveWindowsUpdate: false }],
    assignments: [{ level: 'organization', targetId: org.id, osFilter: ['linux'] }] });

  const timeParent = await seedPolicy({ owner: P, status: 'inactive', links: [{ featureType: 'time_sync', ntpServers: ['time.parent.example'] }] });
  await seedPolicy({ owner: O, parentPolicyId: timeParent, assignments: [{ level: 'device', targetId: deviceId }] });
  await seedPolicy({ owner: P, links: [{ featureType: 'time_sync', ntpServers: ['time.partner.example'] }],
    assignments: [{ level: 'partner', targetId: partner.id }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'monitors', serviceName: 'ParityService', checkIntervalSeconds: 120 }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'monitors', inheritance: 'replace' }],
    assignments: [{ level: 'site', targetId: site.id }] });

  await seedPolicy({ owner: O, links: [{ featureType: 'onedrive_helper', orgId: org.id, filesOnDemand: false, libraryName: 'Parity Docs' }],
    assignments: [{ level: 'site', targetId: site.id }] });

  // Forged rows (cross-tenant). Inserted in system scope; RLS must hide every
  // one of them from the device's org-scoped context.
  const forgedPolicyIds = [
    await seedPolicy({ owner: { orgId: otherOrg.id, partnerId: null }, links: [{ featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://cross-org.example' } }],
      assignments: [{ level: 'device', targetId: deviceId }] }),
    await seedPolicy({ owner: { orgId: foreignOrg.id, partnerId: null }, links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: false } }],
      assignments: [{ level: 'device', targetId: deviceId, priority: -10 }] }),
    await seedPolicy({ owner: { orgId: null, partnerId: foreignPartner.id }, links: [{ featureType: 'event_log', maxEventsPerCycle: 999 }],
      assignments: [{ level: 'partner', targetId: partner.id, priority: -10 }] }),
  ];

  return {
    partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId, siblingId, groupIds,
    otherOrgId: otherOrg.id, foreignPartnerId: foreignPartner.id, foreignOrgId: foreignOrg.id, forgedPolicyIds,
  };
}
```

If `createOrganization` / `seedDevice` reject a column above (e.g. `deviceRole` enum value), match the W01 suite's `seedDevice` (`deviceHierarchyResolverParity.integration.test.ts:111`), which this copies. The `as never` casts are on insert values only, where Drizzle's column-default typing is stricter than the DB.

- [ ] **Step 6: Write the failing integration test (loader + RLS-alone)**

```ts
// apps/api/src/__tests__/integration/devicePolicySet.integration.test.ts
/**
 * #8142 — the policy-set statement against real Postgres: it is a superset of
 * the per-resolver reads, and in the heartbeat's org-scoped context RLS by
 * itself hides every cross-tenant row (other org, other partner), whatever the
 * WHERE clause says. Same-partner partner-wide rows targeting SIBLINGS stay
 * RLS-visible by design; their exclusion is the selectors' job (parity suite).
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { configPolicyAssignments, configurationPolicies } from '../../db/schema';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { loadDevicePolicySet } from '../../services/devicePolicySet';
import { inOrg, seedParityWorld, sys, type ParityWorld } from './policySetFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);
let w: ParityWorld;

describe('loadDevicePolicySet (#8142) — real PostgreSQL', () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    w = await seedParityWorld();
  });

  runDb('org-scoped load returns the same candidates as a system-scoped load, and none of the forged rows', async () => {
    const asOrg = await inOrg(w.orgId, w.partnerId, async () => {
      const h = await loadDeviceHierarchy(w.deviceId);
      return loadDevicePolicySet(h!);
    });
    const asSystem = await sys(async () => {
      const h = await loadDeviceHierarchy(w.deviceId);
      return loadDevicePolicySet(h!);
    });
    const ids = (s: typeof asOrg) => s.candidates.map((c) => c.policyId);
    expect(ids(asOrg)).toEqual(ids(asSystem));
    for (const forged of w.forgedPolicyIds) expect(ids(asOrg)).not.toContain(forged);
    // The parity world's applicable rows are all present.
    const types = new Set(asOrg.candidates.flatMap((c) => Object.keys(c.links)));
    for (const t of ['helper', 'warranty', 'event_log', 'hardware_monitoring', 'pam', 'patch', 'time_sync', 'monitors', 'onedrive_helper']) {
      expect(types.has(t), t).toBe(true);
    }
  });

  runDb('candidates are ordered by assignment created_at, then id', async () => {
    const set = await inOrg(w.orgId, w.partnerId, async () => loadDevicePolicySet((await loadDeviceHierarchy(w.deviceId))!));
    const keys = set.candidates.map((c) => [c.assignmentCreatedAt.getTime(), c.assignmentId] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(keys).toEqual(sorted);
  });

  runDb('the inherited time_sync link of an INACTIVE partner-wide parent reaches the org child, with its settings', async () => {
    const set = await inOrg(w.orgId, w.partnerId, async () => loadDevicePolicySet((await loadDeviceHierarchy(w.deviceId))!));
    const child = set.candidates.find((c) => c.level === 'device' && c.links.time_sync);
    expect(child?.links.time_sync?.timeSync?.ntpServers).toEqual(['time.parent.example']);
  });

  runDb('a link without its settings row carries null settings', async () => {
    const set = await inOrg(w.orgId, w.partnerId, async () => loadDevicePolicySet((await loadDeviceHierarchy(w.deviceId))!));
    const bare = set.candidates.find((c) => c.level === 'device' && c.links.event_log);
    expect(bare?.links.event_log?.eventLog).toBeNull();
  });

  runDb('RLS ALONE hides cross-tenant assignments: an unfiltered read in the org context never sees them', async () => {
    const unfiltered = () => db
      .select({ policyId: configurationPolicies.id })
      .from(configPolicyAssignments)
      .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
      .where(inArray(configurationPolicies.id, w.forgedPolicyIds));
    // Control: the rows exist.
    expect((await sys(unfiltered)).length).toBe(w.forgedPolicyIds.length);
    // The heartbeat's context: none of them.
    expect(await inOrg(w.orgId, w.partnerId, unfiltered)).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/devicePolicySet.integration.test.ts`
Expected: PASS (5 tests). If the RLS-alone test FAILS (forged rows visible in the org context), stop: that is a tenant-isolation finding, not a test bug — report it before continuing.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/devicePolicySet.ts apps/api/src/services/devicePolicySet.test.ts \
  apps/api/src/__tests__/integration/policySetFixtures.ts apps/api/src/__tests__/integration/devicePolicySet.integration.test.ts
git commit -m "feat(api): DevicePolicySet — one-statement candidate read for heartbeat policy resolvers (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Inline-link resolvers (helper, PAM, warranty) take the set; deterministic order; parity suite

**Files:**
- Modify: `apps/api/src/services/helperSettings.ts` (`resolveDeviceHelperSettings` :84-178, `HelperConfigUpdateOptions` :206, `buildHelperConfigUpdate` :212)
- Modify: `apps/api/src/routes/agents/helpers.ts` (`PamConfigUpdateOptions` ~3184, `resolveDevicePamSettings` ~3189-3269, `buildPamConfigUpdate` ~3279; `buildWarrantyConfigUpdate` ~3366)
- Modify: `apps/api/src/services/warrantyPolicyResolution.ts` (`resolveEffectiveWarrantyInlineSettings` :54-163)
- Create: `apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts`

**Interfaces:**
- Consumes (Task 2): `policySetFor`, `candidatesWithLink`, `type ApplicabilityRule`, `type DevicePolicySetOpts`, `loadDevicePolicySet`, `withPolicySet`, `DevicePolicySetMismatchError`; fixtures `seedParityWorld`, `sys`, `inOrg`, `seedPolicy`, `seedDevice`, `dropDeviceRedisCaches`.
- Produces: `helperSettingsFromRows(rows): HelperSettings | null` (exported, helperSettings.ts); `HelperConfigUpdateOptions extends DevicePolicySetOpts`; `PamConfigUpdateOptions extends DevicePolicySetOpts`; `resolveEffectiveWarrantyInlineSettings(deviceId, opts?: DevicePolicySetOpts)`; `buildWarrantyConfigUpdate(deviceId, opts?: DevicePolicySetOpts)`. The parity file's `threeWay`, `RESOLVERS` table and `loadSetFor` helper (Tasks 4–6 append to `RESOLVERS`).

- [ ] **Step 1: Write the failing parity suite**

```ts
// apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts
/**
 * #8142 (scaling W03) — every heartbeat policy resolver returns the SAME answer
 * three ways against real PostgreSQL:
 *   1. its own reads in SYSTEM scope (the pre-W03 heartbeat),
 *   2. its own reads in the heartbeat's ORG-scoped context (the W03 fallback
 *      path; proves the *_partner_wide_select branches carry every feature),
 *   3. the one-statement DevicePolicySet loaded in that org-scoped context.
 * Every resolver resolves to a NON-default answer (see seedParityWorld), so
 * parity cannot pass on two defaults. Discriminating controls: an EMPTY set
 * changes the answer (the set is really used), another device's set is
 * refused, forged cross-tenant rows never appear, and equal-ranked
 * assignments resolve to the earliest on every path.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDeviceHierarchy, type DeviceHierarchy } from '../../services/deviceHierarchy';
import {
  DevicePolicySetMismatchError,
  loadDevicePolicySet,
  withPolicySet,
  type DevicePolicySet,
  type DevicePolicySetOpts,
} from '../../services/devicePolicySet';
import { buildHelperConfigUpdate, resolveDeviceHelperSettings } from '../../services/helperSettings';
import { resolveEffectiveWarrantyInlineSettings } from '../../services/warrantyPolicyResolution';
import { buildPamConfigUpdate, buildWarrantyConfigUpdate } from '../../routes/agents/helpers';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  dropDeviceRedisCaches,
  inOrg,
  seedDevice,
  seedParityWorld,
  seedPolicy,
  sys,
  type ParityWorld,
} from './policySetFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);
let w: ParityWorld;

type Resolver = (deviceId: string, opts?: DevicePolicySetOpts) => Promise<unknown>;

async function loadSetFor(deviceId: string, orgId: string, partnerId: string): Promise<{ hierarchy: DeviceHierarchy; set: DevicePolicySet }> {
  return inOrg(orgId, partnerId, async () => {
    const hierarchy = await loadDeviceHierarchy(deviceId);
    expect(hierarchy).not.toBeNull();
    return { hierarchy: hierarchy!, set: await loadDevicePolicySet(hierarchy!) };
  });
}

async function threeWay(
  ctx: { deviceId: string; orgId: string; partnerId: string },
  name: string,
  resolve: Resolver,
): Promise<unknown> {
  await dropDeviceRedisCaches(ctx.deviceId);
  const legacySystem = await sys(() => resolve(ctx.deviceId));
  await dropDeviceRedisCaches(ctx.deviceId);
  const legacyOrg = await inOrg(ctx.orgId, ctx.partnerId, () => resolve(ctx.deviceId));
  await dropDeviceRedisCaches(ctx.deviceId);
  const viaSet = await inOrg(ctx.orgId, ctx.partnerId, async () => {
    const hierarchy = await loadDeviceHierarchy(ctx.deviceId);
    return resolve(ctx.deviceId, withPolicySet(await loadDevicePolicySet(hierarchy!), hierarchy));
  });
  expect(legacyOrg, `${name}: own reads in the org-scoped context`).toEqual(legacySystem);
  expect(viaSet, `${name}: policy set`).toEqual(legacySystem);
  return legacySystem;
}

/** name → [resolver, non-trivial expectation on the answer, answer with an EMPTY set]. */
const RESOLVERS: Array<[string, Resolver, (answer: any) => void, (emptyAnswer: any) => void]> = [
  ['resolveDeviceHelperSettings', (id, o) => resolveDeviceHelperSettings(id, o),
    (a) => expect(a).toMatchObject({ enabled: true, showTrayIcon: false }),
    (e) => expect(e).toBeNull()],
  ['buildHelperConfigUpdate', (id, o) => buildHelperConfigUpdate(id, w.orgId, o),
    (a) => expect(a).toMatchObject({ enabled: true, showTrayIcon: false }),
    (e) => expect(e).toMatchObject({ enabled: false, showTrayIcon: true })],
  ['buildPamConfigUpdate', (id, o) => buildPamConfigUpdate(id, o),
    (a) => expect(a).toEqual({ uacInterceptionEnabled: true }),
    (e) => expect(e).toEqual({ uacInterceptionEnabled: false })],
  ['resolveEffectiveWarrantyInlineSettings', (id, o) => resolveEffectiveWarrantyInlineSettings(id, o),
    (a) => expect(a).toMatchObject({ enabled: true, warnDays: 45 }),
    (e) => expect(e).toBeUndefined()],
  ['buildWarrantyConfigUpdate', (id, o) => buildWarrantyConfigUpdate(id, o),
    (a) => expect(a).toEqual({ hpCmslEnabled: expect.any(Boolean) }),
    () => {}],
];

describe('heartbeat policy resolvers: three-way parity with the policy set (#8142) — real PostgreSQL', () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    w = await seedParityWorld();
  });

  for (const [name, resolve, nonTrivial, emptyAnswer] of RESOLVERS) {
    runDb(`${name}: same answer three ways`, async () => {
      nonTrivial(await threeWay({ deviceId: w.deviceId, orgId: w.orgId, partnerId: w.partnerId }, name, resolve));
    });

    runDb(`${name}: an EMPTY set changes the answer (the set is really used)`, async () => {
      const { hierarchy, set } = await loadSetFor(w.deviceId, w.orgId, w.partnerId);
      const empty: DevicePolicySet = Object.freeze({ ...set, candidates: Object.freeze([]) });
      await dropDeviceRedisCaches(w.deviceId);
      emptyAnswer(await inOrg(w.orgId, w.partnerId, () => resolve(w.deviceId, { hierarchy, policySet: empty })));
    });

    runDb(`${name}: refuses another device's set`, async () => {
      const sibling = await loadSetFor(w.siblingId, w.orgId, w.partnerId);
      await dropDeviceRedisCaches(w.deviceId);
      // The set alone (no hierarchy), so the SET guard — not the W01 hierarchy guard — is what refuses.
      await expect(inOrg(w.orgId, w.partnerId, () => resolve(w.deviceId, { policySet: sibling.set })))
        .rejects.toBeInstanceOf(DevicePolicySetMismatchError);
    });
  }

  runDb('forged cross-tenant helper rows never reach the device (portalUrl stays unset)', async () => {
    const answer = await threeWay({ deviceId: w.deviceId, orgId: w.orgId, partnerId: w.partnerId },
      'resolveDeviceHelperSettings', (id, o) => resolveDeviceHelperSettings(id, o));
    expect(answer).not.toMatchObject({ portalUrl: expect.anything() });
  });
});

describe('equal-ranked assignments resolve to the EARLIEST assignment on every path (#8142)', () => {
  async function tieWorld(firstWins: boolean) {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'tie');
    const early = new Date(Date.UTC(2026, 0, 1));
    const late = new Date(Date.UTC(2026, 0, 2));
    await seedPolicy({ owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } },
        { featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://true.example' } }],
      assignments: [{ level: 'organization', targetId: org.id, priority: 0, createdAt: firstWins ? early : late }] });
    await seedPolicy({ owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: false } },
        { featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://false.example' } }],
      assignments: [{ level: 'organization', targetId: org.id, priority: 0, createdAt: firstWins ? late : early }] });
    return { deviceId, orgId: org.id, partnerId: partner.id };
  }

  for (const firstWins of [true, false]) {
    runDb(`pam + helper tie (${firstWins ? 'true' : 'false'} policy assigned first)`, async () => {
      const t = await tieWorld(firstWins);
      expect(await threeWay(t, 'pam tie', (id, o) => buildPamConfigUpdate(id, o)))
        .toEqual({ uacInterceptionEnabled: firstWins });
      expect(await threeWay(t, 'helper tie', (id, o) => resolveDeviceHelperSettings(id, o)))
        .toMatchObject({ portalUrl: firstWins ? 'https://true.example' : 'https://false.example' });
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts`
Expected: FAIL — every "EMPTY set changes the answer" test (the resolvers ignore `policySet` and still return the real answer), every "refuses another device's set" test (no guard: `promise resolved … instead of rejecting`), and at least one tie case (no `ORDER BY`: plan order decides). The three-way tests may already pass; they are not the discriminator.

- [ ] **Step 3: Helper — shared ranking, set path, deterministic order**

In `apps/api/src/services/helperSettings.ts`:

1. Imports: add `asc` to the drizzle import; add
   `import { candidatesWithLink, policySetFor, type ApplicabilityRule, type DevicePolicySetOpts } from './devicePolicySet';`
2. Above `resolveDeviceHelperSettings`, add:

```ts
/** #8142: helper's own rules, as the policy set must apply them (raw partner, no role/OS filter). */
const HELPER_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' };

interface HelperRankRow { level: string; assignmentPriority: number; inlineSettings: unknown }

/**
 * Ranking + mapping shared by the read path and the policy-set path (#8142).
 * Level DESC, then assignment priority ASC; input order (created_at, id) breaks
 * any remaining tie. A null winner inline payload means "no policy decides".
 */
export function helperSettingsFromRows(rows: readonly HelperRankRow[]): HelperSettings | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });
  const winner = sorted[0];
  if (!winner?.inlineSettings) return null;

  const s = winner.inlineSettings as Record<string, unknown>;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : HELPER_DEFAULTS.enabled,
    showTrayIcon: typeof s.showTrayIcon === 'boolean' ? s.showTrayIcon : HELPER_DEFAULTS.showTrayIcon,
    showOpenPortal: typeof s.showOpenPortal === 'boolean' ? s.showOpenPortal : HELPER_DEFAULTS.showOpenPortal,
    showDeviceInfo: typeof s.showDeviceInfo === 'boolean' ? s.showDeviceInfo : HELPER_DEFAULTS.showDeviceInfo,
    showRequestSupport: typeof s.showRequestSupport === 'boolean' ? s.showRequestSupport : HELPER_DEFAULTS.showRequestSupport,
    portalUrl: typeof s.portalUrl === 'string' && s.portalUrl ? s.portalUrl : undefined,
    lifecycleMode: s.lifecycleMode === 'auto' || s.lifecycleMode === 'always-on' || s.lifecycleMode === 'on-demand'
      ? s.lifecycleMode
      : undefined,
  };
}
```

3. Change the signature to `export async function resolveDeviceHelperSettings(deviceId: string, opts?: DevicePolicySetOpts)` and, directly after `const passed = hierarchyFor(deviceId, opts);`, insert:

```ts
  // #8142: the heartbeat passes the beat's one-statement policy set.
  const set = policySetFor(deviceId, opts);
  if (set) {
    return helperSettingsFromRows(candidatesWithLink(set, 'helper', HELPER_APPLICABILITY).map(({ candidate, link }) => ({
      level: candidate.level,
      assignmentPriority: candidate.priority,
      inlineSettings: link.inlineSettings,
    })));
  }
```

4. On the legacy query, after `.where(and(...))`, add `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))`. Replace everything from `if (rows.length === 0) return null;` to the end of the function with `return helperSettingsFromRows(rows);`.
5. `export interface HelperConfigUpdateOptions extends DevicePolicySetOpts {` (was `DeviceHierarchyOpts`). In `buildHelperConfigUpdate`, directly after `hierarchyFor(deviceId, opts);` add `policySetFor(deviceId, opts);` with the comment `// Validate before any cache short-circuit: a foreign set is a bug even on a hit.`

- [ ] **Step 4: PAM — shared ranking, set path, deterministic order**

In `apps/api/src/routes/agents/helpers.ts`:

1. Add `asc` to the drizzle import (:2). Add
   `import { candidatesWithLink, policySetFor, type ApplicabilityRule, type DevicePolicySetOpts } from '../../services/devicePolicySet';`
2. Replace `export interface PamConfigUpdateOptions extends DeviceHierarchyOpts {` with `export interface PamConfigUpdateOptions extends DevicePolicySetOpts {`.
3. Above `resolveDevicePamSettings`, add:

```ts
/** #8142: PAM's own rules (raw partner, no role/OS filter). */
const PAM_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' };

/** Level DESC, then assignment priority ASC. Shared by every level/priority resolver in this file. */
function compareLevelThenPriority(a: { level: string; assignmentPriority: number }, b: { level: string; assignmentPriority: number }): number {
  const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
  if (levelDiff !== 0) return levelDiff;
  return a.assignmentPriority - b.assignmentPriority;
}

/** The winning PAM policy's settings, or null when no policy decides (the caller applies the org fallback). */
function pamSettingsFromRows(rows: ReadonlyArray<{ level: string; assignmentPriority: number; inlineSettings: unknown }>): PamSettings | null {
  if (rows.length === 0) return null;
  const winner = [...rows].sort(compareLevelThenPriority)[0];
  if (!winner?.inlineSettings) return null;
  return parsePamSettings(winner.inlineSettings);
}
```

4. In `resolveDevicePamSettings`, after `const passed = hierarchyFor(deviceId, opts);` insert:

```ts
  const set = policySetFor(deviceId, opts);
  if (set) {
    const orgFallbackFromSet = opts?.loadOrgPamFallback ?? resolveOrgPamFallback;
    return pamSettingsFromRows(candidatesWithLink(set, 'pam', PAM_APPLICABILITY).map(({ candidate, link }) => ({
      level: candidate.level, assignmentPriority: candidate.priority, inlineSettings: link.inlineSettings,
    }))) ?? orgFallbackFromSet(set.hierarchy.orgId);
  }
```

5. Add `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))` after the legacy query's `.where(...)`, and replace everything from `if (rows.length === 0) return orgFallback(device.orgId);` to the end of the function with `return pamSettingsFromRows(rows) ?? orgFallback(device.orgId);`.
6. In `buildPamConfigUpdate`, after `hierarchyFor(deviceId, opts);` add `policySetFor(deviceId, opts);`.
7. `buildWarrantyConfigUpdate(deviceId: string, opts?: DevicePolicySetOpts)` — signature only.

- [ ] **Step 5: Warranty — shared ranking, set path, deterministic order**

In `apps/api/src/services/warrantyPolicyResolution.ts`: add `asc` to the drizzle import and
`import { candidatesWithLink, policySetFor, type ApplicabilityRule, type DevicePolicySetOpts } from './devicePolicySet';`. Then:

```ts
/** #8142: warranty's own rules (raw partner, no role/OS filter). */
const WARRANTY_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' };

/**
 * Warranty's ranking — NOT the shared one: level DESC, then the HIGHER
 * priority number wins. Input order (created_at, id) breaks a remaining tie.
 */
export function warrantyInlineFromRows(rows: ReadonlyArray<{ inlineSettings: unknown; level: string; priority: number }>): unknown | undefined {
  if (rows.length === 0) return undefined;
  const sorted = [...rows].sort((a, b) => {
    const la = LEVEL_PRIORITY[a.level] ?? 0;
    const lb = LEVEL_PRIORITY[b.level] ?? 0;
    if (la !== lb) return lb - la;
    return b.priority - a.priority;
  });
  return sorted[0]!.inlineSettings;
}
```

Change the signature to `resolveEffectiveWarrantyInlineSettings(deviceId: string, opts?: DevicePolicySetOpts)`. After `const passed = hierarchyFor(deviceId, opts);` insert:

```ts
  const set = policySetFor(deviceId, opts);
  if (set) {
    if (!set.hierarchy.org) {
      // Same invariant break, same report as the read path below.
      console.error(
        `[warranty] org ${set.hierarchy.orgId} for device ${deviceId} did not resolve; partner-wide warranty policies cannot apply to this evaluation`
      );
      captureException(new Error(`warranty: organizations row missing for device org ${set.hierarchy.orgId}`));
    }
    return warrantyInlineFromRows(candidatesWithLink(set, 'warranty', WARRANTY_APPLICABILITY).map(({ candidate, link }) => ({
      inlineSettings: link.inlineSettings, level: candidate.level, priority: candidate.priority,
    })));
  }
```

On the legacy query add `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))` after `.where(...)`, and replace its tail (`if (rows.length === 0) return undefined;` … `return rows[0]!.inlineSettings;`) with `return warrantyInlineFromRows(rows);`.

- [ ] **Step 6: Run the parity suite and the touched unit suites**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts` — Expected: PASS (18 tests: 5 resolvers × 3, the forge test, and the 2 tie cases).
Run: `cd apps/api && npx vitest run src/services/helperSettings.test.ts src/services/warrantyPolicyResolution.test.ts src/routes/agents/helpers.partnerWidePolicies.test.ts` — Expected: PASS. If a mocked select chain in these unit suites has no `.orderBy`, add `orderBy: vi.fn(() => <the same terminal the chain's where() returned>)` to that chain builder rather than weakening the assertion.
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts` — Expected: PASS (W01 parity unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/helperSettings.ts apps/api/src/services/warrantyPolicyResolution.ts \
  apps/api/src/routes/agents/helpers.ts apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts \
  apps/api/src/services/helperSettings.test.ts apps/api/src/services/warrantyPolicyResolution.test.ts apps/api/src/routes/agents/helpers.partnerWidePolicies.test.ts
git commit -m "feat(api): helper, PAM and warranty resolve from the policy set; deterministic tie order (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Settings-table resolvers (event log, hardware monitoring, time sync, patch source)

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (`resolveDeviceEventLogSettings` ~1928-2028, `getDeviceEventLogSettings`, `buildEventLogConfigUpdate`; `resolveHardwareMonitoring` ~2104-2200 and its wrappers; `buildTimeSyncConfigUpdate`; `buildPatchSourceConfigUpdate` ~3333)
- Modify: `apps/api/src/services/timeSync/settings.ts` (`resolveDeviceTimeSyncSettings`, `getDeviceTimeSyncSettings`)
- Modify: `apps/api/src/services/timeSync/configUpdate.ts` (`buildResolvedTimeSyncConfigUpdate` signature)
- Modify: `apps/api/src/services/featureConfigResolver.ts` (new `patchExclusiveWindowsUpdateFromPolicySet`; `resolvePatchConfigPolicyForDevice` `.orderBy` tail)
- Test: `apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts` (append to `RESOLVERS`)

**Interfaces:**
- Consumes: Task 2 selectors; Task 3 `compareLevelThenPriority` (helpers.ts, module-private).
- Produces: `patchExclusiveWindowsUpdateFromPolicySet(set: DevicePolicySet): boolean` (featureConfigResolver.ts). All builders here accept `opts?: DevicePolicySetOpts`.

- [ ] **Step 1: Append the failing parity entries**

Add these imports to the parity file:

```ts
import { resolveDeviceTimeSyncSettings } from '../../services/timeSync/settings';
import { buildResolvedTimeSyncConfigUpdate } from '../../services/timeSync/configUpdate';
import {
  buildEventLogConfigUpdate,
  buildHardwareMonitoringConfigUpdate,
  buildPatchSourceConfigUpdate,
  buildTimeSyncConfigUpdate,
} from '../../routes/agents/helpers';
```

(merge `buildPamConfigUpdate, buildWarrantyConfigUpdate` into the same helpers import) and append to `RESOLVERS`:

```ts
  ['buildEventLogConfigUpdate', (id, o) => buildEventLogConfigUpdate(id, o),
    // 321 = partner-wide partner-level winner; 555 (printer) and the bare device-level link are excluded; 999 is forged.
    (a) => expect(a).toMatchObject({ max_events_per_cycle: 321 }),
    (e) => expect(e).toMatchObject({ max_events_per_cycle: 100 })],
  ['buildHardwareMonitoringConfigUpdate', (id, o) => buildHardwareMonitoringConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ enabled: true, poll_interval_minutes: 7 }),
    (e) => expect(e).not.toMatchObject({ poll_interval_minutes: 7 })],
  ['resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o),
    // Device-level child inherits the INACTIVE partner-wide parent's link.
    (a) => expect(a).toMatchObject({ settings: { ntpServers: ['time.parent.example'] } }),
    (e) => expect(e).toMatchObject({ policy: null })],
  ['buildResolvedTimeSyncConfigUpdate', (id, o) => buildResolvedTimeSyncConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ ntp_servers: ['time.parent.example'] }),
    (e) => expect(e).not.toMatchObject({ ntp_servers: ['time.parent.example'] })],
  ['buildTimeSyncConfigUpdate', (id, o) => buildTimeSyncConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ ntp_servers: ['time.parent.example'] }),
    (e) => expect(e).not.toMatchObject({ ntp_servers: ['time.parent.example'] })],
  ['buildPatchSourceConfigUpdate', (id, o) => buildPatchSourceConfigUpdate(id, o),
    (a) => expect(a).toEqual({ exclusiveWindowsUpdate: true }),
    (e) => expect(e).toEqual({ exclusiveWindowsUpdate: false })],
```

and add one parked-org block at the end of the file:

```ts
describe('parked orgs keep their partner-drop rules on the set path (#8142)', () => {
  for (const orgType of ['unassigned_pool', 'quick_support'] as const) {
    runDb(`${orgType}: patch source and time sync agree three ways`, async () => {
      const world = await seedParityWorld();
      const parked = (await createOrganization({ partnerId: world.partnerId, type: orgType }))!;
      const parkedSite = (await createSite({ orgId: parked.id }))!;
      const deviceId = await seedDevice(parked.id, parkedSite.id, orgType);
      const ctx = { deviceId, orgId: parked.id, partnerId: world.partnerId };
      const patch = await threeWay(ctx, 'buildPatchSourceConfigUpdate', (id, o) => buildPatchSourceConfigUpdate(id, o));
      // Patch drops the partner for unassigned_pool only.
      expect(patch).toEqual({ exclusiveWindowsUpdate: orgType !== 'unassigned_pool' });
      await threeWay(ctx, 'resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o));
    });
  }
});
```

- [ ] **Step 2: Run to verify the new entries fail**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts`
Expected: FAIL on the six new "EMPTY set" and "refuses another device's set" tests; Task 3's tests still PASS.

- [ ] **Step 3: Event log**

In `helpers.ts`, above `resolveDeviceEventLogSettings`:

```ts
/** #8142: event_log's own rules (raw partner; SQL role/OS here, matchesRoleOsFilter in the ranking). */
const EVENT_LOG_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'sql' };

type EventLogRankRow = {
  level: string; assignmentPriority: number; roleFilter: string[] | null; osFilter: string[] | null;
  retentionDays: number; maxEventsPerCycle: number; collectCategories: string[]; minimumLevel: string;
  collectionIntervalMinutes: number; rateLimitPerHour: number;
};

function eventLogSettingsFromRows(rows: EventLogRankRow[], device: { deviceRole: string; osType: string }): EventLogSettings {
  const eligibleRows = rows.filter((r) => matchesRoleOsFilter(r, device));
  if (eligibleRows.length === 0) return EVENT_LOG_DEFAULTS;
  eligibleRows.sort(compareLevelThenPriority);
  const winner = eligibleRows[0];
  if (!winner) return EVENT_LOG_DEFAULTS;
  return {
    retentionDays: winner.retentionDays,
    maxEventsPerCycle: winner.maxEventsPerCycle,
    collectCategories: winner.collectCategories as EventLogCategory[],
    minimumLevel: winner.minimumLevel as EventLogLevel,
    collectionIntervalMinutes: winner.collectionIntervalMinutes,
    rateLimitPerHour: winner.rateLimitPerHour,
  };
}
```

Change `resolveDeviceEventLogSettings(deviceId: string, opts?: DevicePolicySetOpts)`; after `const passed = hierarchyFor(deviceId, opts);` insert:

```ts
  const set = policySetFor(deviceId, opts);
  if (set) {
    return eventLogSettingsFromRows(candidatesWithLink(set, 'event_log', EVENT_LOG_APPLICABILITY).flatMap(({ candidate, link }) =>
      link.eventLog
        ? [{
          level: candidate.level, assignmentPriority: candidate.priority,
          roleFilter: candidate.roleFilter, osFilter: candidate.osFilter,
          retentionDays: link.eventLog.retentionDays, maxEventsPerCycle: link.eventLog.maxEventsPerCycle,
          collectCategories: link.eventLog.collectCategories, minimumLevel: link.eventLog.minimumLevel,
          collectionIntervalMinutes: link.eventLog.collectionIntervalMinutes, rateLimitPerHour: link.eventLog.rateLimitPerHour,
        }]
        : []), set.hierarchy);
  }
```

Add `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))` after the legacy query's `.where(...)`, and replace everything from `// Filter by deviceRole and osType using canonical predicate` to the end of the function with `return eventLogSettingsFromRows(rows, device);`. Change `getDeviceEventLogSettings` and `buildEventLogConfigUpdate` to take `opts?: DevicePolicySetOpts`, and in `getDeviceEventLogSettings` add `policySetFor(deviceId, opts);` right after its `hierarchyFor(deviceId, opts);`.

- [ ] **Step 4: Hardware monitoring**

Above `resolveHardwareMonitoring`:

```ts
const HARDWARE_MONITORING_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'sql' };

type HardwareMonitoringRankRow = {
  policyName: string; level: string; assignmentPriority: number; roleFilter: string[] | null; osFilter: string[] | null;
  enabled: boolean; pollIntervalMinutes: number; diskHealthIntervalMinutes: number;
};

function hardwareMonitoringFromRows(
  rows: HardwareMonitoringRankRow[],
  device: { deviceRole: string; osType: string },
): { settings: HardwareMonitoringInlineSettings; policy: HardwareMonitoringPolicyView } {
  const eligible = rows.filter((r) => matchesRoleOsFilter(r, device));
  eligible.sort(compareLevelThenPriority);
  const winner = eligible[0];
  if (!winner) {
    return { settings: { ...HARDWARE_MONITORING_DEFAULTS }, policy: { enabled: HARDWARE_MONITORING_DEFAULTS.enabled, source: 'default' } };
  }
  return {
    settings: hardwareMonitoringInlineSettingsSchema.parse(winner),
    policy: { enabled: winner.enabled, source: 'policy', policyName: winner.policyName },
  };
}
```

Change `resolveHardwareMonitoring(deviceId: string, opts?: DevicePolicySetOpts)`; after `const passed = hierarchyFor(deviceId, opts);` insert:

```ts
  const set = policySetFor(deviceId, opts);
  if (set) {
    return hardwareMonitoringFromRows(candidatesWithLink(set, 'hardware_monitoring', HARDWARE_MONITORING_APPLICABILITY).flatMap(({ candidate, link }) =>
      link.hardwareMonitoring
        ? [{
          policyName: candidate.policyName, level: candidate.level, assignmentPriority: candidate.priority,
          roleFilter: candidate.roleFilter, osFilter: candidate.osFilter,
          enabled: link.hardwareMonitoring.enabled,
          pollIntervalMinutes: link.hardwareMonitoring.pollIntervalMinutes,
          diskHealthIntervalMinutes: link.hardwareMonitoring.diskHealthIntervalMinutes,
        }]
        : []), set.hierarchy);
  }
```

On the legacy query (now `await db.select(...)` after Task 1) add the `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))` and replace everything from `const eligible = rows.filter(` to the end of the function with `return hardwareMonitoringFromRows(rows, device);`. `resolveDeviceHardwareMonitoringSettings`, `getDeviceHardwareMonitoringSettings` and `buildHardwareMonitoringConfigUpdate` take `opts?: DevicePolicySetOpts`; add `policySetFor(deviceId, opts);` after `getDeviceHardwareMonitoringSettings`'s `hierarchyFor(deviceId, opts);`. `buildTimeSyncConfigUpdate(deviceId: string, opts?: DevicePolicySetOpts)` — signature only.

- [ ] **Step 5: Time sync**

In `apps/api/src/services/timeSync/settings.ts` add `asc` to the drizzle import and
`import { candidatesWithLink, policySetFor, type ApplicabilityRule, type DevicePolicySetOpts } from '../devicePolicySet';`. Add:

```ts
const TIME_SYNC_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'sql' };

type TimeSyncRankRow = {
  policyId: string; policyName: string | null; level: string; assignmentPriority: number; assignmentCreatedAt: Date;
  roleFilter: string[] | null; osFilter: string[] | null;
  enforceNtp: boolean; ntpServers: string[]; pollIntervalMinutes: number;
  timezoneExpected: 'site' | 'pinned'; pinnedTimezone: string | null; timezoneAutoFix: boolean;
};

function timeSyncFromRows(orgId: string, rows: TimeSyncRankRow[], device: { deviceRole: string; osType: string }): ResolvedTimeSyncSettings {
  const eligible = rows.filter((row) => matchesRoleOsFilter(row, device));
  eligible.sort(
    (a, b) =>
      (levelPriority[b.level] ?? 0) - (levelPriority[a.level] ?? 0) ||
      a.assignmentPriority - b.assignmentPriority ||
      a.assignmentCreatedAt.getTime() - b.assignmentCreatedAt.getTime(),
  );
  const winner = eligible[0];
  if (!winner) return { orgId, settings: timeSyncInlineSettingsSchema.parse({}), policy: null };
  const settings = timeSyncInlineSettingsSchema.parse({
    enforceNtp: winner.enforceNtp,
    ntpServers: winner.ntpServers,
    pollIntervalMinutes: winner.pollIntervalMinutes,
    timezone: { expected: winner.timezoneExpected, pinnedTimezone: winner.pinnedTimezone, autoFix: winner.timezoneAutoFix },
  });
  return {
    orgId,
    settings,
    policy: { policyId: winner.policyId, policyName: winner.policyName, expected: settings.timezone.expected, pinnedTimezone: settings.timezone.pinnedTimezone },
  };
}
```

`resolveDeviceTimeSyncSettings(deviceId: string, opts?: DevicePolicySetOpts)`: after `const passed = hierarchyFor(deviceId, opts);` insert

```ts
  const set = policySetFor(deviceId, opts);
  if (set) {
    return timeSyncFromRows(set.hierarchy.orgId, candidatesWithLink(set, 'time_sync', TIME_SYNC_APPLICABILITY).flatMap(({ candidate, link }) =>
      link.timeSync
        ? [{
          policyId: candidate.policyId, policyName: candidate.policyName, level: candidate.level,
          assignmentPriority: candidate.priority, assignmentCreatedAt: candidate.assignmentCreatedAt,
          roleFilter: candidate.roleFilter, osFilter: candidate.osFilter,
          enforceNtp: link.timeSync.enforceNtp, ntpServers: link.timeSync.ntpServers,
          pollIntervalMinutes: link.timeSync.pollIntervalMinutes, timezoneExpected: link.timeSync.timezoneExpected,
          pinnedTimezone: link.timeSync.pinnedTimezone, timezoneAutoFix: link.timeSync.timezoneAutoFix,
        }]
        : []), set.hierarchy);
  }
```

On the legacy query add `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))` and replace everything from `const eligible = rows.filter(` to the end with `return timeSyncFromRows(device.orgId, rows, device);`. `getDeviceTimeSyncSettings(deviceId, opts?: DevicePolicySetOpts)` gains `policySetFor(deviceId, opts);` after its `hierarchyFor`. In `services/timeSync/configUpdate.ts`, change `opts?: DeviceHierarchyOpts` to `opts?: DevicePolicySetOpts` (import the type from `../devicePolicySet`).

- [ ] **Step 6: Patch source**

In `apps/api/src/services/featureConfigResolver.ts` add
`import { candidatesWithLink, type ApplicabilityRule, type DevicePolicySet } from './devicePolicySet';` and, after `resolvePatchConfigPolicyForDevice`:

```ts
/** #8142: patch's own rules — the device's partner is dropped (ownership AND target) for an unassigned_pool org. */
const PATCH_APPLICABILITY: ApplicabilityRule = {
  ownership: 'orgOrPartnerUnlessUnassignedPool', partnerTarget: 'partnerUnlessUnassignedPool', roleOs: 'sql',
};

/**
 * The heartbeat's patch_source flag from a loaded policy set: the
 * `settings.exclusiveWindowsUpdate` of the same winner
 * resolvePatchConfigPolicyForDevice picks (sortByHierarchy over candidates
 * with a patch settings row), false when none applies. A projection, not a
 * substitute for the full resolver: it carries only the one column the
 * heartbeat delivers.
 */
export function patchExclusiveWindowsUpdateFromPolicySet(set: DevicePolicySet): boolean {
  const rows = candidatesWithLink(set, 'patch', PATCH_APPLICABILITY).flatMap(({ candidate, link }) =>
    link.patch
      ? [{
        assignmentLevel: candidate.level, assignmentPriority: candidate.priority,
        assignmentCreatedAt: candidate.assignmentCreatedAt, exclusiveWindowsUpdate: link.patch.exclusiveWindowsUpdate,
      }]
      : []);
  if (rows.length === 0) return false;
  return sortByHierarchy(rows)[0]!.exclusiveWindowsUpdate;
}
```

In `resolvePatchConfigPolicyForDevice`'s query, extend the existing `.orderBy(level, priority, createdAt)` with `, configPolicyAssignments.id` so its pre-sort ends on the same `(created_at, id)` tail. In `helpers.ts`:

```ts
export async function buildPatchSourceConfigUpdate(deviceId: string, opts?: DevicePolicySetOpts): Promise<PatchSourceSettings> {
  hierarchyFor(deviceId, opts);
  const set = policySetFor(deviceId, opts);
  if (set) return { exclusiveWindowsUpdate: patchExclusiveWindowsUpdateFromPolicySet(set) };
  const patch = await resolvePatchConfigPolicyForDevice(deviceId, opts);
  return { exclusiveWindowsUpdate: patch?.settings.exclusiveWindowsUpdate ?? false };
}
```

and add `patchExclusiveWindowsUpdateFromPolicySet` to the `../../services/featureConfigResolver` import (:60-64).

- [ ] **Step 7: Run tests and typecheck**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts src/services/timeSync` — Expected: PASS.
Run: `cd apps/api && npx vitest run src/services/timeSync src/services/featureConfigResolver src/routes/agents/helpers` — Expected: PASS (add `orderBy` to any mocked chain that now needs it, as in Task 3 Step 6).
Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"` — Expected: `tsc exit 0`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/services/timeSync apps/api/src/services/featureConfigResolver.ts \
  apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts
git commit -m "feat(api): event log, hardware monitoring, time sync and patch source resolve from the policy set (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Monitoring resolvers (check interval, monitors) take the set; zero-statement "no monitors link"

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (`resolveMonitorDerivedWatches` ~2420, `resolveDeviceMonitoringSettings` ~2508, `resolvePolicyCheckInterval` ~2560-2684, `buildMonitoringConfigUpdate` ~2686)
- Modify: `apps/api/src/services/monitors/monitorResolver.ts` (`resolveMonitorsForDevice` :180-345)
- Test: `apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 `applicableCandidates`, `policySetFor`, `type ApplicabilityRule`, `type DevicePolicySetOpts`; Task 3 `compareLevelThenPriority`.
- Produces: `resolveMonitorsForDevice(deviceId, executor?, opts?: DevicePolicySetOpts)`; `buildMonitoringConfigUpdate(deviceId, opts?: DevicePolicySetOpts)`. The short-circuit rule: no applicable candidate with an effective `monitors` link ⇒ `no_policy` / `resolved []` with **no** statement.

- [ ] **Step 1: Append the failing parity entries**

Add `import { db } from '../../db';`, `import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';` and `buildMonitoringConfigUpdate` to the helpers import, then append to `RESOLVERS`:

```ts
  ['resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o),
    // Partner-wide cumulative attachment survives the closer EMPTY replace link at site level.
    (a) => {
      expect(a.kind).toBe('resolved');
      expect(a.monitors).toHaveLength(1);
      expect(a.monitors[0]).toMatchObject({ enabled: true, sourceLevel: 'partner' });
    },
    (e) => expect(e).toEqual({ kind: 'resolved', monitors: [] })],
  ['buildMonitoringConfigUpdate', (id, o) => buildMonitoringConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ check_interval_seconds: 120, watches: [expect.objectContaining({ name: 'ParityService' })] }),
    (e) => expect(e).toEqual({ check_interval_seconds: 60, watches: [] })],
```

and add this block (the no-monitors-link device; its answer must be `none_applies` on every path):

```ts
describe('monitoring with no monitors link resolves to the explicit clear on every path (#8142)', () => {
  runDb('a device whose only policy is PAM: watches [] three ways; quick_support drops the partner target', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'pam-only');
    await seedPolicy({ owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
      assignments: [{ level: 'organization', targetId: org.id }] });
    const ctx = { deviceId, orgId: org.id, partnerId: partner.id };
    expect(await threeWay(ctx, 'buildMonitoringConfigUpdate', (id, o) => buildMonitoringConfigUpdate(id, o)))
      .toEqual({ check_interval_seconds: 60, watches: [] });
    expect(await threeWay(ctx, 'resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o)))
      .toEqual({ kind: 'resolved', monitors: [] });

    const world = await seedParityWorld();
    const qs = (await createOrganization({ partnerId: world.partnerId, type: 'quick_support' }))!;
    const qsSite = (await createSite({ orgId: qs.id }))!;
    const qsDevice = await seedDevice(qs.id, qsSite.id, 'qs');
    expect(await threeWay({ deviceId: qsDevice, orgId: qs.id, partnerId: world.partnerId }, 'monitors (quick_support)',
      (id, o) => resolveMonitorsForDevice(id, db, o))).toEqual({ kind: 'resolved', monitors: [] });
  });
});
```

- [ ] **Step 2: Run to verify the new entries fail**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts -t monitor`
Expected: FAIL on the two new "EMPTY set" and "refuses another device's set" tests.

- [ ] **Step 3: Check interval — extract the raw-link phase; set path with short-circuit**

In `helpers.ts`, above `resolvePolicyCheckInterval`:

```ts
/** #8142: check-interval's own rules (raw partner; SQL role/OS, then matchesRoleOsFilter). */
const CHECK_INTERVAL_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'sql' };

type CheckIntervalAssignment = { policyId: string; parentPolicyId: string | null; level: string; assignmentPriority: number };

/**
 * Field-level interval inheritance (unchanged): read the RAW `monitors` links of
 * each assigned policy and its immediate parent, in the caller's context.
 */
async function checkIntervalFromAssignments(assignments: CheckIntervalAssignment[]): Promise<PolicyCheckIntervalResult> {
  if (assignments.length === 0) return { kind: 'no_policy' };
  const policyIds = [...new Set(assignments.flatMap((r) =>
    r.parentPolicyId ? [r.policyId, r.parentPolicyId] : [r.policyId]
  ))];
  const settingsRows = await db
    .select({
      policyId: configPolicyFeatureLinks.configPolicyId,
      checkIntervalSeconds: configPolicyMonitoringSettings.checkIntervalSeconds,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      inArray(configPolicyFeatureLinks.configPolicyId, policyIds),
      eq(configPolicyFeatureLinks.featureType, 'monitors'),
    ));
  const intervals = new Map(settingsRows.map((r) => [r.policyId, r.checkIntervalSeconds]));
  const eligibleRows = assignments.flatMap((r) => {
    const checkIntervalSeconds = intervals.get(r.policyId)
      ?? (r.parentPolicyId ? intervals.get(r.parentPolicyId) : undefined);
    return checkIntervalSeconds === undefined ? [] : [{ ...r, checkIntervalSeconds }];
  });
  if (eligibleRows.length === 0) return { kind: 'no_policy' };
  eligibleRows.sort(compareLevelThenPriority);
  const winner = eligibleRows[0];
  if (!winner) return { kind: 'no_policy' };
  return { kind: 'resolved', settings: { check_interval_seconds: winner.checkIntervalSeconds } };
}
```

Change `resolvePolicyCheckInterval(deviceId: string, opts?: DevicePolicySetOpts)`. After `const passed = hierarchyFor(deviceId, opts);` insert:

```ts
  const set = policySetFor(deviceId, opts);
  if (set) {
    if (!set.hierarchy.org) return { kind: 'device_missing' };
    const applicable = applicableCandidates(set, CHECK_INTERVAL_APPLICABILITY)
      .filter((c) => matchesRoleOsFilter(c, set.hierarchy));
    // #8142 — exact, statement-free "no interval": the effective view carries a
    // `monitors` row for policy P iff P or P's parent has a raw `monitors` link,
    // and the raw read below can only return rows for such links.
    if (!applicable.some((c) => c.links.monitors)) return { kind: 'no_policy' };
    return checkIntervalFromAssignments(applicable.map((c) => ({
      policyId: c.policyId, parentPolicyId: c.parentPolicyId, level: c.level, assignmentPriority: c.priority,
    })));
  }
```

On the legacy assignments query add `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))` and replace everything from `if (assignments.length === 0) return { kind: 'no_policy' };` to the end of the function with `return checkIntervalFromAssignments(assignments);`. Change `resolveMonitorDerivedWatches(deviceId: string, opts?: DevicePolicySetOpts)`, `resolveDeviceMonitoringSettings(deviceId: string, opts?: DevicePolicySetOpts)` and `buildMonitoringConfigUpdate(deviceId: string, opts?: DevicePolicySetOpts)` (signatures only); in `buildMonitoringConfigUpdate` add `policySetFor(deviceId, opts);` after `hierarchyFor(deviceId, opts);`. Add `applicableCandidates` to the `devicePolicySet` import. Leave the "Only a `resolved` result is cached" comment and behaviour as they are, and append one line to it: `#8142: a device with no monitors link now answers none_applies with zero statements from the beat's policy set, so this stays uncached (see the W03 plan's decision).`

- [ ] **Step 4: Monitors — extract the attachment phase; set path with short-circuit**

In `services/monitors/monitorResolver.ts` add `asc` to the drizzle import and
`import { applicableCandidates, policySetFor, type ApplicabilityRule, type DevicePolicySetOpts } from '../devicePolicySet';`. Add above `resolveMonitorsForDevice`:

```ts
/** #8142: monitors' own rules — raw partner for ownership, NO partner-level target for quick_support / unassigned_pool, SQL role/OS only. */
const MONITOR_APPLICABILITY: ApplicabilityRule = {
  ownership: 'orgOrPartner', partnerTarget: 'partnerUnlessQuickSupportOrUnassignedPool', roleOs: 'sql',
};
```

Add this function and remove the identical tail (from `if (assignments.length === 0) return { kind: 'resolved', monitors: [] };` to the final `return { kind: 'resolved', monitors };`) from `resolveMonitorsForDevice`:

```ts
/** Cumulative/replace attachment resolution over the RAW links of each assigned policy and its parent (unchanged). */
async function monitorsFromAssignments(assignments: AssignmentRow[], executor: DbExecutor): Promise<MonitorResolution> {
  if (assignments.length === 0) return { kind: 'resolved', monitors: [] };

  const policyIds = new Set<string>();
  for (const a of assignments) {
    policyIds.add(a.policyId);
    if (a.parentPolicyId) policyIds.add(a.parentPolicyId);
  }

  const attachmentRows = await executor
    .select({
      configPolicyId: configPolicyFeatureLinks.configPolicyId,
      monitorId: configPolicyMonitors.monitorId,
      enabled: configPolicyMonitors.enabled,
      overrides: configPolicyMonitors.overrides,
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configPolicyMonitors, eq(configPolicyMonitors.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      inArray(configPolicyFeatureLinks.configPolicyId, [...policyIds]),
      eq(configPolicyFeatureLinks.featureType, 'monitors'),
    ));

  const byPolicy = new Map<string, AttachmentRow[]>();
  const inheritanceByPolicy = new Map<string, MonitorsInheritance>();
  for (const row of attachmentRows) {
    const list = byPolicy.get(row.configPolicyId) ?? [];
    list.push({ configPolicyId: row.configPolicyId, monitorId: row.monitorId, enabled: row.enabled, overrides: row.overrides ?? null });
    byPolicy.set(row.configPolicyId, list);
    if (!inheritanceByPolicy.has(row.configPolicyId)) {
      const parsed = monitorsInheritanceSchema.safeParse((row.inlineSettings as { inheritance?: unknown } | null)?.inheritance);
      inheritanceByPolicy.set(row.configPolicyId, parsed.success ? parsed.data : 'cumulative');
    }
  }

  const replaceLinks = await executor
    .select({ configPolicyId: configPolicyFeatureLinks.configPolicyId })
    .from(configPolicyFeatureLinks)
    .where(and(
      inArray(configPolicyFeatureLinks.configPolicyId, [...policyIds]),
      eq(configPolicyFeatureLinks.featureType, 'monitors'),
      sql`${configPolicyFeatureLinks.inlineSettings} ->> 'inheritance' = 'replace'`,
    ));
  for (const r of replaceLinks) inheritanceByPolicy.set(r.configPolicyId, 'replace');

  const candidates = new Map<string, MonitorCandidate[]>();
  for (const candidate of selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy })) {
    const list = candidates.get(candidate.monitorId) ?? [];
    list.push(candidate);
    candidates.set(candidate.monitorId, list);
  }

  const monitors = [...candidates.values()].map((list) => {
    const winner = pickWinner(list);
    return {
      monitorId: winner.monitorId,
      enabled: winner.enabled,
      overrides: winner.overrides,
      sourcePolicyId: winner.sourcePolicyId,
      sourceLevel: winner.sourceLevel,
      inheritedFromParent: winner.inheritedFromParent,
    };
  });
  return { kind: 'resolved', monitors };
}
```

This is the former tail of `resolveMonitorsForDevice`, moved unchanged; delete it there.

and end `resolveMonitorsForDevice` with `return monitorsFromAssignments(assignments, executor);`. Change its signature to `opts?: DevicePolicySetOpts`, and after `const passed = hierarchyFor(deviceId, opts);` insert:

```ts
  const set = policySetFor(deviceId, opts);
  if (set) {
    if (!set.hierarchy.org) return { kind: 'device_missing' };
    const applicable = applicableCandidates(set, MONITOR_APPLICABILITY);
    // Exact, statement-free: no effective monitors link ⇒ no attachment rows.
    if (!applicable.some((c) => c.links.monitors)) return { kind: 'resolved', monitors: [] };
    return monitorsFromAssignments(applicable.map((c) => ({
      policyId: c.policyId, parentPolicyId: c.parentPolicyId, level: c.level, priority: c.priority, createdAt: c.assignmentCreatedAt,
    })), executor);
  }
```

On the legacy assignments query add `.orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id))` after `.where(...)`.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts` — Expected: PASS.
Run: `cd apps/api && npx vitest run src/services/monitors src/routes/agents/helpers` — Expected: PASS (mocked chains that now hit `.orderBy` get one, as in Task 3).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/services/monitors/monitorResolver.ts \
  apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts
git commit -m "feat(api): monitoring resolvers use the policy set; no monitors link costs zero statements (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: OneDrive — set path, DB phase / DB-free Graph phase

**Files:**
- Modify: `apps/api/src/services/m365DirectGraph.ts` (`getToken` :105) + `m365DirectGraph.test.ts`
- Modify: `apps/api/src/services/onedriveGraph.ts` (`resolveUserGroupMembership` :118, `resolveUserGroupMembershipCached` :226) + `onedriveGraph.test.ts`
- Modify: `apps/api/src/routes/agents/helpers.ts` (`resolveDeviceOnedriveSettings` ~3396-3622, `buildOnedriveHelperConfigUpdate` ~3625)
- Modify: `apps/api/src/routes/agents/helpers.partnerWidePolicies.test.ts` (mocks + a new describe)
- Test: `apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts` (append)

**Interfaces:**
- Produces:
  - m365DirectGraph: `type LegacyDirectConnection`; `loadLegacyDirectConnection(orgId): Promise<LegacyDirectConnection | null>`; `interface GetTokenOptions { connection?: LegacyDirectConnection | null }`; `getToken(orgId, opts?: GetTokenOptions)`.
  - onedriveGraph: `type GroupMembershipResult`; `peekUserGroupMembershipCached(orgId, upn): GroupMembershipResult | null`; `resolveUserGroupMembership(orgId, upn, opts?: GetTokenOptions)`; `resolveUserGroupMembershipCached(orgId, upn, opts?: GetTokenOptions)`.
  - helpers: `interface OnedriveConfigPlan`; `loadOnedriveHelperConfigPlan(deviceId, opts?: DevicePolicySetOpts): Promise<OnedriveConfigPlan | null>` (DB only); `finishOnedriveHelperConfig(plan): Promise<OnedriveConfigUpdate>` (no DB); `buildOnedriveHelperConfigUpdate` = plan + finish (unchanged contract for every other caller).

- [ ] **Step 1: Failing unit test — `getToken` with a supplied connection never touches the DB**

Append to `apps/api/src/services/m365DirectGraph.test.ts`:

```ts
describe('getToken with a supplied connection (#8142)', () => {
  it('uses the supplied row and issues no DB read', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockClear();
    const result = await getToken('org-1', { connection: { ...mockRow, orgId: 'org-1' } as never });
    expect(result).toEqual({ token: 'TOKEN-123' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('supplied null means "no connection", still without a DB read', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockClear();
    expect(await getToken('org-1', { connection: null })).toMatchObject({ kind: 'error', code: 'no_connection' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses a supplied row that belongs to another org', async () => {
    expect(await getToken('org-1', { connection: { ...mockRow, orgId: 'org-2' } as never }))
      .toMatchObject({ kind: 'error', code: 'no_connection' });
  });
});
```

And to `apps/api/src/services/onedriveGraph.test.ts` (inside the `resolveUserGroupMembershipCached` describe; add `peekUserGroupMembershipCached` to the import list):

```ts
  it('peek returns null on a miss and the cached result on a hit, without I/O (#8142)', async () => {
    expect(peekUserGroupMembershipCached('org-1', 'u@contoso.com')).toBeNull();
    (graphFetch as any).mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-1' }] } });
    const a = await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
    expect(peekUserGroupMembershipCached('org-1', 'U@contoso.com')).toEqual(a);
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });

  it('passes a supplied connection through to getToken (#8142)', async () => {
    (graphFetch as any).mockResolvedValueOnce({ kind: 'ok', data: { value: [] } });
    const connection = { orgId: 'org-1' } as never;
    await resolveUserGroupMembershipCached('org-1', 'v@contoso.com', { connection });
    expect(getToken).toHaveBeenCalledWith('org-1', { connection });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/m365DirectGraph.test.ts src/services/onedriveGraph.test.ts`
Expected: FAIL — `db.select` called / `peekUserGroupMembershipCached is not a function` / `getToken` called with one argument.

- [ ] **Step 3: Implement the Graph-side seams**

`apps/api/src/services/m365DirectGraph.ts` — replace the head of `getToken` (the select through the `!row.clientSecret` check) with:

```ts
export type LegacyDirectConnection = typeof m365Connections.$inferSelect;

/** The org's active legacy-direct connection, or null. The only DB read on the token path. */
export async function loadLegacyDirectConnection(orgId: string): Promise<LegacyDirectConnection | null> {
  const [row] = await db
    .select()
    .from(m365Connections)
    .where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, 'legacy-direct'),
      eq(m365Connections.status, 'active'),
    ))
    .limit(1);
  return row ?? null;
}

export interface GetTokenOptions {
  /**
   * #8142: the connection row the caller already loaded (null = the org has
   * none). When present, getToken issues NO DB statement: the agent heartbeat
   * resolves Graph memberships after its DB context has committed (#1105).
   */
  connection?: LegacyDirectConnection | null;
}

export async function getToken(orgId: string, opts?: GetTokenOptions): Promise<{ token: string } | DirectInvokeError> {
  const supplied = opts?.connection !== undefined;
  const row = supplied ? opts!.connection! : await loadLegacyDirectConnection(orgId);
  if (!row || (supplied && row.orgId !== orgId)) {
    return { kind: 'error', code: 'no_connection', message: 'No legacy Microsoft 365 connection for this organization.' };
  }
  if (!row.clientSecret) {
    return { kind: 'error', code: 'connection_key_error', message: 'Legacy Microsoft 365 connection has no stored client secret.' };
  }
```

(the rest of `getToken` — token cache, decrypt, tenant check, acquisition — is unchanged).

`apps/api/src/services/onedriveGraph.ts`:

```ts
import { getToken, graphFetch, type DirectInvokeResult, type GetTokenOptions } from './m365DirectGraph';

export type GroupMembershipResult = DirectInvokeResult<{ groupIds: string[] }>;

const membershipKey = (orgId: string, upn: string) => `${orgId}:${upn.toLowerCase()}`;

/** #8142: the live cached membership for (org, upn), or null on a miss. No I/O. */
export function peekUserGroupMembershipCached(orgId: string, upn: string): GroupMembershipResult | null {
  const hit = groupMembershipCache.get(membershipKey(orgId, upn));
  return hit && Date.now() - hit.at < hit.ttlMs ? hit.result : null;
}
```

Change `resolveUserGroupMembership(orgId, upn, opts?: GetTokenOptions)` to call `getToken(orgId, opts)`. Rewrite `resolveUserGroupMembershipCached`:

```ts
export async function resolveUserGroupMembershipCached(
  orgId: string,
  upn: string,
  opts?: GetTokenOptions,
): Promise<GroupMembershipResult> {
  const cached = peekUserGroupMembershipCached(orgId, upn);
  if (cached) return cached;
  const key = membershipKey(orgId, upn);
  const result = await resolveUserGroupMembership(orgId, upn, opts);
  if (result.kind === 'ok') {
    setGroupMembershipCacheEntry(key, { at: Date.now(), ttlMs: GROUP_MEMBERSHIP_CACHE_TTL_MS, result });
  } else if (GROUP_MEMBERSHIP_NEGATIVE_CACHEABLE_CODES.has(result.code)) {
    setGroupMembershipCacheEntry(key, { at: Date.now(), ttlMs: GROUP_MEMBERSHIP_NEGATIVE_TTL_MS, result });
  }
  return result;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365DirectGraph.test.ts src/services/onedriveGraph.test.ts` — Expected: PASS.

- [ ] **Step 5: Failing tests for the plan/finish split**

In `apps/api/src/routes/agents/helpers.partnerWidePolicies.test.ts`:

1. Replace `vi.mock('../../services/onedriveGraph', () => ({ resolveUserGroupMembershipCached: vi.fn() }));` with

```ts
vi.mock('../../services/onedriveGraph', () => ({
  resolveUserGroupMembershipCached: vi.fn(),
  peekUserGroupMembershipCached: vi.fn(() => null),
}));
const loadConnectionMock = vi.hoisted(() => vi.fn(async () => null as unknown));
// Fully mocked (no importOriginal): the real module pulls in secretCrypto / c2cM365.
vi.mock('../../services/m365DirectGraph', () => ({ loadLegacyDirectConnection: loadConnectionMock }));
```

2. Add `finishOnedriveHelperConfig, loadOnedriveHelperConfigPlan, type OnedriveConfigPlan` to the `./helpers` import, and `import { peekUserGroupMembershipCached, resolveUserGroupMembershipCached } from '../../services/onedriveGraph';`.
3. Append:

```ts
describe('OneDrive: DB phase captures, Graph phase never reads the DB (#8142)', () => {
  const graphLib = {
    id: 'lib-row-1', settingsId: 'set-1', orgId: ORG_ID, libraryId: 'lib-1', displayName: 'Docs', siteUrl: null,
    siteId: null, webId: null, listId: null, targetingMode: 'graph_group', groupId: 'G-1', groupName: null,
    hiveScope: 'hkcu', sortOrder: 0, enabled: true,
  };
  const base = {
    silentAccountConfig: true, filesOnDemand: true, kfmSilentOptIn: false, kfmFolders: [],
    kfmBlockOptOut: false, tenantAssociationId: null, restartOnChange: false,
  };
  const connection = { orgId: ORG_ID, clientId: 'c-1' };

  beforeEach(() => {
    vi.mocked(resolveUserGroupMembershipCached).mockReset();
    vi.mocked(peekUserGroupMembershipCached).mockReset().mockReturnValue(null);
    loadConnectionMock.mockReset().mockResolvedValue(null);
  });

  it('DB phase: captures hits, and loads the connection only because one UPN missed', async () => {
    dbMock._resetQueue([
      deviceRow, orgWithPartner, [],
      [{ level: 'organization', assignmentPriority: 1, settingsId: 'set-1', ...base }],
      [graphLib],
      [{ signedInUpns: ['a@contoso.com', 'b@contoso.com'] }],
    ]);
    const hit = { kind: 'ok' as const, data: { groupIds: ['g-1'] } };
    vi.mocked(peekUserGroupMembershipCached).mockImplementation((_org, upn) => (upn === 'a@contoso.com' ? hit : null));
    loadConnectionMock.mockResolvedValueOnce(connection);

    const plan = await loadOnedriveHelperConfigPlan(DEVICE_ID);

    expect(plan?.upnLookups).toEqual([{ upn: 'a@contoso.com', cached: hit }, { upn: 'b@contoso.com', cached: null }]);
    expect(plan?.connection).toEqual(connection);
    expect(loadConnectionMock).toHaveBeenCalledWith(ORG_ID);
    expect(resolveUserGroupMembershipCached).not.toHaveBeenCalled();
  });

  it('DB phase: every UPN a hit → no connection read', async () => {
    dbMock._resetQueue([
      deviceRow, orgWithPartner, [],
      [{ level: 'organization', assignmentPriority: 1, settingsId: 'set-1', ...base }],
      [graphLib],
      [{ signedInUpns: ['a@contoso.com'] }],
    ]);
    vi.mocked(peekUserGroupMembershipCached).mockReturnValue({ kind: 'ok', data: { groupIds: ['g-1'] } });
    const plan = await loadOnedriveHelperConfigPlan(DEVICE_ID);
    expect(plan?.connection).toBeNull();
    expect(loadConnectionMock).not.toHaveBeenCalled();
  });

  it('Graph phase: a captured hit is used even if the cache has since expired; a miss uses the preloaded connection; zero DB', async () => {
    const plan: OnedriveConfigPlan = {
      deviceId: DEVICE_ID, orgId: ORG_ID, base, libs: [graphLib as never],
      upnLookups: [
        { upn: 'a@contoso.com', cached: { kind: 'ok', data: { groupIds: ['g-1'] } } },
        { upn: 'b@contoso.com', cached: null },
      ],
      connection: connection as never,
    };
    vi.mocked(resolveUserGroupMembershipCached).mockResolvedValueOnce({ kind: 'ok', data: { groupIds: ['{G-1}'] } });
    dbMock.select.mockClear();

    const out = await finishOnedriveHelperConfig(plan);

    expect(out.libraries[0]!.allowedUpns).toEqual(['a@contoso.com', 'b@contoso.com']);
    expect(resolveUserGroupMembershipCached).toHaveBeenCalledTimes(1);
    expect(resolveUserGroupMembershipCached).toHaveBeenCalledWith(ORG_ID, 'b@contoso.com', { connection });
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(loadConnectionMock).not.toHaveBeenCalled();
  });
});
```

Append to the parity file's `RESOLVERS` (import `buildOnedriveHelperConfigUpdate` from helpers):

```ts
  ['buildOnedriveHelperConfigUpdate', (id, o) => buildOnedriveHelperConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ base: { filesOnDemand: false }, libraries: [expect.objectContaining({ displayName: 'Parity Docs', allowedUpns: [] })] }),
    (e) => expect(e).toBeNull()],
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/agents/helpers.partnerWidePolicies.test.ts`
Expected: FAIL — `loadOnedriveHelperConfigPlan is not a function`.

- [ ] **Step 7: Split the OneDrive resolver**

In `helpers.ts`, add imports: `import { loadLegacyDirectConnection, type LegacyDirectConnection } from '../../services/m365DirectGraph';` and extend the onedriveGraph import to `import { peekUserGroupMembershipCached, resolveUserGroupMembershipCached, type GroupMembershipResult } from '../../services/onedriveGraph';`. Replace `resolveDeviceOnedriveSettings` and `buildOnedriveHelperConfigUpdate` with:

```ts
/** #8142: OneDrive's own rules — ORG-ONLY ownership (ORG_SCOPED_ONLY_FEATURE_TYPES), raw partner target, no role/OS. */
const ONEDRIVE_APPLICABILITY: ApplicabilityRule = { ownership: 'orgOnly', partnerTarget: 'partner', roleOs: 'none' };

type OnedriveLibraryRow = typeof configPolicyOnedriveLibraries.$inferSelect;
type OnedriveWinnerRow = {
  level: string; assignmentPriority: number; settingsId: string;
  silentAccountConfig: boolean; filesOnDemand: boolean; kfmSilentOptIn: boolean; kfmFolders: unknown;
  kfmBlockOptOut: boolean; tenantAssociationId: string | null; restartOnChange: boolean;
};

export interface OnedriveUpnLookup {
  readonly upn: string;
  /** The membership-cache result captured in the DB phase; null = a miss the Graph phase resolves. */
  readonly cached: GroupMembershipResult | null;
}

/**
 * Everything the OneDrive build needs from the database (#8142). Built inside
 * the heartbeat's policy context; `finishOnedriveHelperConfig` turns it into the
 * wire payload AFTER that context commits, with no DB access (#1105: no pooled
 * connection is ever held across a Graph call).
 */
export interface OnedriveConfigPlan {
  readonly deviceId: string;
  readonly orgId: string;
  readonly base: OnedriveConfigUpdate['base'];
  readonly libs: OnedriveLibraryRow[];
  /** One per deduplicated reported UPN, in report order; empty when nothing needs Graph tagging. */
  readonly upnLookups: readonly OnedriveUpnLookup[];
  /** Loaded iff some lookup missed: the org's active legacy-direct connection, or null. */
  readonly connection: LegacyDirectConnection | null;
}

function onedriveWinnerFromRows(rows: OnedriveWinnerRow[]): OnedriveWinnerRow | null {
  return [...rows].sort(compareLevelThenPriority)[0] ?? null;
}

async function selectOnedriveWinner(deviceId: string, opts?: DevicePolicySetOpts): Promise<{ orgId: string; winner: OnedriveWinnerRow } | null> {
  const passed = hierarchyFor(deviceId, opts);
  const set = policySetFor(deviceId, opts);
  if (set) {
    const winner = onedriveWinnerFromRows(candidatesWithLink(set, 'onedrive_helper', ONEDRIVE_APPLICABILITY).flatMap(({ candidate, link }) =>
      link.onedrive
        ? [{
          level: candidate.level, assignmentPriority: candidate.priority, settingsId: link.onedrive.id,
          silentAccountConfig: link.onedrive.silentAccountConfig, filesOnDemand: link.onedrive.filesOnDemand,
          kfmSilentOptIn: link.onedrive.kfmSilentOptIn, kfmFolders: link.onedrive.kfmFolders,
          kfmBlockOptOut: link.onedrive.kfmBlockOptOut, tenantAssociationId: link.onedrive.tenantAssociationId,
          restartOnChange: link.onedrive.restartOnChange,
        }]
        : []));
    return winner ? { orgId: set.hierarchy.orgId, winner } : null;
  }
  // ---- read path: the former resolveDeviceOnedriveSettings steps 1–6, plus ORDER BY.
  const [device] = passed
    ? [{ orgId: passed.orgId, siteId: passed.siteId }]
    : await db
      .select({ orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
  if (!device) return null;

  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId }] : [])
    : await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);

  const groupIds = passed
    ? [...passed.groupIds]
    : (await db
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId))).map((r) => r.groupId);

  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // DELIBERATELY org-only, unlike the sibling resolvers fixed for #2930.
  // `onedrive_helper` is the sole member of ORG_SCOPED_ONLY_FEATURE_TYPES
  // (packages/shared/src/constants/configFeatureTypes.ts): its settings carry
  // per-tenant M365 library mappings that a partner-wide policy has no owning
  // org to anchor to, and featureLinks.ts rejects the link with a 400 at write
  // time. A partner-owned row therefore cannot exist here — adding the
  // dual-axis predicate would be dead code that implies support we don't have.
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      settingsId: configPolicyOnedriveSettings.id,
      silentAccountConfig: configPolicyOnedriveSettings.silentAccountConfig,
      filesOnDemand: configPolicyOnedriveSettings.filesOnDemand,
      kfmSilentOptIn: configPolicyOnedriveSettings.kfmSilentOptIn,
      kfmFolders: configPolicyOnedriveSettings.kfmFolders,
      kfmBlockOptOut: configPolicyOnedriveSettings.kfmBlockOptOut,
      tenantAssociationId: configPolicyOnedriveSettings.tenantAssociationId,
      restartOnChange: configPolicyOnedriveSettings.restartOnChange,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyEffectiveFeatureLinks, and(
      eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyEffectiveFeatureLinks.featureType, 'onedrive_helper'),
    ))
    .innerJoin(configPolicyOnedriveSettings, eq(configPolicyOnedriveSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ))
    .orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id));

  const winner = onedriveWinnerFromRows(rows);
  return winner ? { orgId: device.orgId, winner } : null;
}
```

Then:

```ts
/** DB phase (#8142). Issues only DB reads; never calls Graph. */
export async function loadOnedriveHelperConfigPlan(deviceId: string, opts?: DevicePolicySetOpts): Promise<OnedriveConfigPlan | null> {
  const selected = await selectOnedriveWinner(deviceId, opts);
  if (!selected) return null;
  const { orgId, winner } = selected;

  // 7. Load enabled libraries for the winning settings row, in sort order
  const libs = await db
    .select()
    .from(configPolicyOnedriveLibraries)
    .where(and(
      eq(configPolicyOnedriveLibraries.settingsId, winner.settingsId),
      eq(configPolicyOnedriveLibraries.enabled, true),
    ))
    .orderBy(configPolicyOnedriveLibraries.sortOrder);

  const [state] = libs.length > 0
    ? await db.select().from(onedriveDeviceState).where(eq(onedriveDeviceState.deviceId, deviceId)).limit(1)
    : [];

  // Phase 4 (unchanged): graph_group libraries are tagged with the reported
  // UPNs whose transitive Entra membership includes the rule's groupId. Fail
  // closed: no UPNs / no groupId / Graph error → no tag → never mounted.
  const graphRules = libs.filter((l) => l.targetingMode === 'graph_group' && l.groupId);
  // A corrupt/non-array signedInUpns degrades to no tagging (zod validates
  // ingest, so a non-array means an out-of-band write — worth a log).
  const rawUpns = state?.signedInUpns;
  if (rawUpns != null && !Array.isArray(rawUpns)) {
    console.warn(`[agents] graph_group tagging: signed_in_upns is not an array for device ${deviceId}; treating as empty`);
  }
  const reportedUpns = (Array.isArray(rawUpns) ? rawUpns : []).filter(
    (u): u is string => typeof u === 'string' && u.length > 0
  );
  // Case-insensitive dedupe keeping the first casing (defense-in-depth: each
  // duplicate would cost a Graph resolution and a duplicate allowedUpns entry).
  const seenUpns = new Set<string>();
  const upns = reportedUpns.filter((u) => {
    const key = u.toLowerCase();
    if (seenUpns.has(key)) return false;
    seenUpns.add(key);
    return true;
  });

  const tagging = graphRules.length > 0 && upns.length > 0;
  const upnLookups: OnedriveUpnLookup[] = tagging
    ? upns.map((upn) => ({ upn, cached: peekUserGroupMembershipCached(orgId, upn) }))
    : [];
  const connection = upnLookups.some((l) => l.cached === null) ? await loadLegacyDirectConnection(orgId) : null;

  return {
    deviceId,
    orgId,
    base: {
      silentAccountConfig: winner.silentAccountConfig,
      filesOnDemand: winner.filesOnDemand,
      kfmSilentOptIn: winner.kfmSilentOptIn,
      kfmFolders: (winner.kfmFolders as string[]) ?? [],
      kfmBlockOptOut: winner.kfmBlockOptOut,
      tenantAssociationId: winner.tenantAssociationId,
      restartOnChange: winner.restartOnChange,
    },
    libs,
    upnLookups,
    connection,
  };
}

/** Graph phase (#8142). No DB access: captured hits are reused, misses use the preloaded connection. */
export async function finishOnedriveHelperConfig(plan: OnedriveConfigPlan): Promise<OnedriveConfigUpdate> {
  const normalizeGuid = (g: string) => g.replace(/^\{|\}$/g, '').toLowerCase();
  const graphRules = plan.libs.filter((l) => l.targetingMode === 'graph_group' && l.groupId);
  const allowedByLib = new Map<string, string[]>();
  if (graphRules.length > 0 && plan.upnLookups.length > 0) {
    const taggingDeadline = Date.now() + 15_000;
    const TAGGING_CONCURRENCY = 4;
    const memberships = new Array<Set<string> | null>(plan.upnLookups.length).fill(null);
    let nextIndex = 0;
    let budgetExhausted = false;

    const worker = async () => {
      for (;;) {
        const i = nextIndex++;
        if (i >= plan.upnLookups.length) return;
        if (Date.now() > taggingDeadline) {
          budgetExhausted = true;
          return;
        }
        const lookup = plan.upnLookups[i]!;
        const res = lookup.cached
          ?? await resolveUserGroupMembershipCached(plan.orgId, lookup.upn, { connection: plan.connection });
        if (res.kind !== 'ok') {
          // Deliberately no UPN in the log line — it's end-user PII.
          console.warn(`[agents] graph_group tagging: membership lookup failed for device ${plan.deviceId}: ${res.code}`);
          continue;
        }
        memberships[i] = new Set(res.data.groupIds.map(normalizeGuid));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(TAGGING_CONCURRENCY, plan.upnLookups.length) }, () => worker()),
    );
    if (budgetExhausted) {
      console.warn(`[agents] graph_group tagging: time budget exhausted for device ${plan.deviceId}; remaining UPNs untagged this cycle`);
    }
    for (let i = 0; i < plan.upnLookups.length; i++) {
      const groupIds = memberships[i];
      if (!groupIds) continue;
      for (const rule of graphRules) {
        if (rule.groupId && groupIds.has(normalizeGuid(rule.groupId))) {
          const arr = allowedByLib.get(rule.id) ?? [];
          arr.push(plan.upnLookups[i]!.upn);
          allowedByLib.set(rule.id, arr);
        }
      }
    }
  }

  return {
    base: plan.base,
    libraries: plan.libs.map((l) => ({
      libraryId: l.libraryId,
      displayName: l.displayName,
      siteUrl: l.siteUrl,
      targetingMode: l.targetingMode,
      groupId: l.groupId,
      groupName: l.groupName,
      hiveScope: l.hiveScope,
      allowedUpns: allowedByLib.get(l.id) ?? [],
    })),
  };
}

/** Both phases back to back, for every non-heartbeat caller (unchanged contract). */
export async function buildOnedriveHelperConfigUpdate(deviceId: string, opts?: DevicePolicySetOpts): Promise<OnedriveConfigUpdate | null> {
  const plan = await loadOnedriveHelperConfigPlan(deviceId, opts);
  return plan ? finishOnedriveHelperConfig(plan) : null;
}
```

Carry the former function's explanatory comments (aggregate deadline, worker pool, GUID normalisation, original-order application) into `finishOnedriveHelperConfig` at the matching lines.

- [ ] **Step 8: Run all OneDrive suites**

Run: `cd apps/api && npx vitest run src/routes/agents/helpers.partnerWidePolicies.test.ts src/services/onedriveGraph.test.ts src/services/m365DirectGraph.test.ts` — Expected: PASS.
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts src/__tests__/integration/onedrive-helper-write-path.integration.test.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts` — Expected: PASS. (The delivery suite mocks `resolveUserGroupMembershipCached` and spreads the real module, so `peekUserGroupMembershipCached` reads the real, empty cache: every UPN is a miss and reaches the mock, as before.)
Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"` — Expected: `tsc exit 0`.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/m365DirectGraph.ts apps/api/src/services/m365DirectGraph.test.ts \
  apps/api/src/services/onedriveGraph.ts apps/api/src/services/onedriveGraph.test.ts \
  apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/helpers.partnerWidePolicies.test.ts \
  apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts
git commit -m "feat(api): OneDrive config splits into a DB phase and a DB-free Graph phase; resolves from the policy set (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `DeferredCacheFills` — explicit org fill scope

**Files:**
- Modify: `apps/api/src/services/hotPathCache.ts` (`DeferredCacheFills`, :159-194; header contract :35-41)
- Test: `apps/api/src/services/hotPathCache.test.ts`

**Interfaces:**
- Produces: `interface DeferredFillScope { orgId: string; partnerId: string }`; `DeferredCacheFills.through(cache, key, load, fillScope?: DeferredFillScope)`; exported pure `fillScopeIsCacheable(ctx: DbAccessContext | undefined, fillScope?: DeferredFillScope): boolean`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/services/hotPathCache.test.ts`, extend the hoisted `dbState` with `ctx: undefined as Record<string, unknown> | undefined` and change the mock's `getCurrentDbAccessContext` to `() => dbState.ctx ?? (dbState.scope ? { scope: dbState.scope } : undefined)`; reset `dbState.ctx = undefined` in the existing `beforeEach`. Import `fillScopeIsCacheable`. Append:

```ts
describe('DeferredCacheFills — explicit org fill scope (#8142)', () => {
  const ORG = 'org-1';
  const PARTNER = 'partner-1';
  const orgCtx = (over: Record<string, unknown> = {}) => ({
    scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG], accessiblePartnerIds: [], currentPartnerId: PARTNER, ...over,
  });

  beforeEach(() => {
    dbState.inContext = false;
    dbState.scope = undefined;
    dbState.ctx = undefined;
  });

  it('fillScopeIsCacheable: system always; org only with an exact org + partner match', () => {
    expect(fillScopeIsCacheable({ scope: 'system' } as never)).toBe(true);
    expect(fillScopeIsCacheable(orgCtx() as never)).toBe(false);
    expect(fillScopeIsCacheable(orgCtx() as never, { orgId: ORG, partnerId: PARTNER })).toBe(true);
    expect(fillScopeIsCacheable(orgCtx() as never, { orgId: 'org-2', partnerId: PARTNER })).toBe(false);
    expect(fillScopeIsCacheable(orgCtx({ currentPartnerId: 'partner-2' }) as never, { orgId: ORG, partnerId: PARTNER })).toBe(false);
    expect(fillScopeIsCacheable(orgCtx({ currentPartnerId: null }) as never, { orgId: ORG, partnerId: PARTNER })).toBe(false);
    expect(fillScopeIsCacheable(orgCtx({ accessibleOrgIds: [ORG, 'org-2'] }) as never, { orgId: ORG, partnerId: PARTNER })).toBe(false);
    expect(fillScopeIsCacheable({ ...orgCtx(), scope: 'partner' } as never, { orgId: ORG, partnerId: PARTNER })).toBe(false);
    expect(fillScopeIsCacheable(undefined, { orgId: ORG, partnerId: PARTNER })).toBe(false);
  });

  it('an org-scoped load with a matching fill scope is stored after flush', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.ctx = orgCtx();
    dbState.inContext = true;
    await fills.through(cache, ORG, async () => ({ v: 'loaded' }), { orgId: ORG, partnerId: PARTNER });
    dbState.inContext = false;
    dbState.ctx = undefined;
    fills.flush();
    expect(cache.peek(ORG)).toEqual({ v: 'loaded' });
  });

  it('an org-scoped load WITHOUT a fill scope is returned but never stored (unchanged rule)', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.ctx = orgCtx();
    dbState.inContext = true;
    expect(await fills.through(cache, ORG, async () => ({ v: 'loaded' }))).toEqual({ v: 'loaded' });
    dbState.inContext = false;
    dbState.ctx = undefined;
    fills.flush();
    expect(cache.peek(ORG)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/hotPathCache.test.ts`
Expected: FAIL — `fillScopeIsCacheable is not a function` (and the matching-scope test stores nothing).

- [ ] **Step 3: Implement**

In `hotPathCache.ts`, change the db import to `import { getCurrentDbAccessContext, hasDbAccessContext, runAfterDbContextExit, type DbAccessContext } from '../db';`. Replace the `DeferredCacheFills` doc comment's last paragraph and the class with:

```ts
/** The exact org-scoped context a per-org value may be cached from (#8142). */
export interface DeferredFillScope {
  orgId: string;
  /** The org's own partner, read under RLS in the same context. */
  partnerId: string;
}

/**
 * Whether a load under `ctx` may be stored for everyone in the org.
 * - system scope: yes (#8053 W1a-1).
 * - org scope: only when the caller names the scope it built the context for
 *   AND the context is exactly that — this org alone, and this org's partner as
 *   the partner-wide read axis. Then RLS shows the loader every row any device
 *   of the org would see (own org + own partner's partner-wide rows), so the
 *   value is not narrowed. Anything else (another org, a second org, a missing
 *   or different partner, partner scope) is returned but never stored.
 */
export function fillScopeIsCacheable(ctx: DbAccessContext | undefined, fillScope?: DeferredFillScope): boolean {
  if (!ctx) return false;
  if (ctx.scope === 'system') return true;
  if (!fillScope || ctx.scope !== 'organization') return false;
  return ctx.orgId === fillScope.orgId
    && Array.isArray(ctx.accessibleOrgIds)
    && ctx.accessibleOrgIds.length === 1
    && ctx.accessibleOrgIds[0] === fillScope.orgId
    && (ctx.currentPartnerId ?? null) === fillScope.partnerId;
}

export class DeferredCacheFills {
  private readonly pending: Array<() => void> = [];

  async through<K, V>(cache: HotPathTtlCache<K, V>, key: K, load: () => Promise<V>, fillScope?: DeferredFillScope): Promise<V> {
    const hit = cache.peek(key);
    if (hit !== undefined) return hit;
    const cacheable = fillScopeIsCacheable(getCurrentDbAccessContext(), fillScope);
    const ticket = cache.ticket();
    const value = await load();
    if (cacheable) this.pending.push(() => cache.fillIfCurrent(key, value, ticket));
    return value;
  }

  flush(): void {
    // Each fill is independent: one throwing must not drop the rest.
    for (const fill of this.pending.splice(0)) {
      try {
        fill();
      } catch (err) {
        console.error('[hotPathCache] deferred cache fill failed; skipping it:', err);
      }
    }
  }
}
```

In the file header's "Only top-level reads are cached — with one exception" bullet, replace "A load under any narrower scope is returned but never stored." with: "A load under an org scope is stored only when the caller passes the exact `{ orgId, partnerId }` fill scope the context was built for (#8142, `fillScopeIsCacheable`); any other narrower scope is returned but never stored."

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/hotPathCache.test.ts` — Expected: PASS (existing tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/hotPathCache.ts apps/api/src/services/hotPathCache.test.ts
git commit -m "feat(api): DeferredCacheFills stores org-scoped loads only for an exact org+partner fill scope (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Heartbeat — one org-scoped post-commit policy context

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (imports :8-64; `dbContext` comment :545-576; the post-commit block from `// Policy probe config and helper settings are resolved in the shared policy` (:2190) through `} = policyConfigs;` (:2474))
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`

**Interfaces:**
- Consumes: `loadDeviceHierarchy`, `type DeviceHierarchy` (W01); `loadDevicePolicySet`, `withPolicySet`, `type DevicePolicySet` (Task 2); every builder's `DevicePolicySetOpts` (Tasks 3–6); `loadOnedriveHelperConfigPlan`, `finishOnedriveHelperConfig`, `type OnedriveConfigPlan` (Task 6); `DeferredCacheFills.through(…, fillScope)` (Task 7).
- Produces: steady and warm beats at 2 transactions; no `withSystemDbAccessContext` after the org block.

- [ ] **Step 1: Update the unit-test harness and write the failing tests**

In `apps/api/src/routes/agents/heartbeat.test.ts`:

1. Replace the `withDbAccessContext` entry of the `vi.mock('../../db', …)` factory with a `vi.fn` seam (declare the two consts next to `withSystemDbAccessContextMock`, :38):

```ts
// #8142 — the post-commit policy context is now the SECOND org-scoped context
// of a beat; a vi.fn so a test can fail exactly that call.
const orgDbAccessContextPassthrough = async (ctx: unknown, fn: () => Promise<unknown>) => {
  orgDbContexts.push(ctx as Record<string, unknown>);
  callOrder.push('dbContext:opened');
  const result = await fn();
  callOrder.push('dbContext:released');
  return result;
};
const withDbAccessContextMock = vi.fn(orgDbAccessContextPassthrough);
```

and in the factory: `withDbAccessContext: (...args: unknown[]) => withDbAccessContextMock(...(args as [unknown, () => Promise<unknown>])),` (keep the existing explanatory comment above it).

2. Replace the `vi.mock('../../services/deviceHierarchy', …)` block with:

```ts
// #8053 W1a-1 / #8142 — the hierarchy is loaded first in the post-commit policy
// context. By default it is the authenticated device's own (org-1 / partner-1),
// so every builder runs; tests override it to exercise the skip paths.
const TEST_HIERARCHY = {
  deviceId: 'device-1', orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
  org: { partnerId: 'partner-1', type: 'customer' }, site: null, groupIds: [] as string[],
};
vi.mock('../../services/deviceHierarchy', () => ({
  loadDeviceHierarchy: vi.fn(async (deviceId: string) => ({ ...TEST_HIERARCHY, deviceId })),
  withHierarchy: (h: unknown) => (h ? { hierarchy: h } : undefined),
}));
vi.mock('../../services/devicePolicySet', () => ({
  loadDevicePolicySet: vi.fn(async () => null),
  withPolicySet: (set: { hierarchy: unknown } | null, h: unknown) =>
    (set ? { hierarchy: set.hierarchy, policySet: set } : h ? { hierarchy: h } : undefined),
}));
```

(`TEST_HIERARCHY` must be declared with `vi.hoisted(() => ({ … }))` if the linter/hoisting complains that the factory references it before initialisation; the factory only reads it at call time.)

3. In the `vi.mock('./helpers', …)` factory add:

```ts
  // #8142 — OneDrive is split: a DB phase inside the policy context, a Graph
  // phase after it commits. Null plan = no onedrive policy for the device.
  loadOnedriveHelperConfigPlan: vi.fn(async () => null),
  finishOnedriveHelperConfig: vi.fn(async () => null),
```

4. Replace the two OneDrive delivery tests (:3812 and :3842) with:

```ts
  it('delivers onedrive_helper_settings: plan inside the policy context, Graph phase after it commits (#8142)', async () => {
    const helpers = await import('./helpers');
    const settings = {
      base: {
        silentAccountConfig: true, filesOnDemand: true, kfmSilentOptIn: false,
        kfmFolders: [], kfmBlockOptOut: false, tenantAssociationId: null, restartOnChange: true,
      },
      libraries: [{
        libraryId: 'lib-1', displayName: 'Docs', siteUrl: null, targetingMode: 'graph_group',
        groupId: 'g-1', groupName: null, hiveScope: 'hkcu', allowedUpns: ['u@contoso.com'],
      }],
    };
    const plan = { deviceId: 'device-1', orgId: 'org-1' };
    callOrder.length = 0;
    vi.mocked(helpers.loadOnedriveHelperConfigPlan).mockImplementationOnce(async () => {
      callOrder.push('onedrive:plan');
      return plan as never;
    });
    vi.mocked(helpers.finishOnedriveHelperConfig).mockImplementationOnce(async () => {
      callOrder.push('onedrive:finish');
      return settings as never;
    });
    vi.mocked(helpers.buildPatchSourceConfigUpdate).mockResolvedValueOnce({ exclusiveWindowsUpdate: true });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const configUpdate = ((await resp.json()) as Record<string, any>).configUpdate as Record<string, unknown>;
    expect(configUpdate.onedrive_helper_settings).toEqual(settings);
    expect(configUpdate.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
    expect(helpers.finishOnedriveHelperConfig).toHaveBeenCalledWith(plan);
    // #1105: the plan is built inside the policy context; Graph runs only after it is released.
    const policyOpened = callOrder.lastIndexOf('dbContext:opened');
    const policyReleased = callOrder.lastIndexOf('dbContext:released');
    expect(callOrder.indexOf('onedrive:plan')).toBeGreaterThan(policyOpened);
    expect(callOrder.indexOf('onedrive:plan')).toBeLessThan(policyReleased);
    expect(callOrder.indexOf('onedrive:finish')).toBeGreaterThan(policyReleased);
  });

  it('omits onedrive_helper_settings when the DB phase throws — other config intact', async () => {
    const helpers = await import('./helpers');
    vi.mocked(helpers.loadOnedriveHelperConfigPlan).mockRejectedValueOnce(new Error('libraries read failed'));
    vi.mocked(helpers.buildPatchSourceConfigUpdate).mockResolvedValueOnce({ exclusiveWindowsUpdate: true });
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(minimalHeartbeatBody),
    });
    expect(resp.status).toBe(200);
    const configUpdate = ((await resp.json()) as Record<string, any>).configUpdate as Record<string, unknown>;
    expect(configUpdate.onedrive_helper_settings).toBeUndefined();
    expect(configUpdate.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
    expect(helpers.finishOnedriveHelperConfig).not.toHaveBeenCalled();
  });

  it('omits onedrive_helper_settings when the Graph phase throws — other config intact', async () => {
    const helpers = await import('./helpers');
    vi.mocked(helpers.loadOnedriveHelperConfigPlan).mockResolvedValueOnce({ deviceId: 'device-1' } as never);
    vi.mocked(helpers.finishOnedriveHelperConfig).mockRejectedValueOnce(new Error('graph down'));
    vi.mocked(helpers.buildPatchSourceConfigUpdate).mockResolvedValueOnce({ exclusiveWindowsUpdate: true });
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(minimalHeartbeatBody),
    });
    expect(resp.status).toBe(200);
    const configUpdate = ((await resp.json()) as Record<string, any>).configUpdate as Record<string, unknown>;
    expect(configUpdate.onedrive_helper_settings).toBeUndefined();
    expect(configUpdate.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
  });
```

5. In "delivers time settings after releasing org scope inside the shared system context" (:3926) rename to "…inside the post-commit policy context" and replace its two `systemCtx` assertions with:

```ts
      expect(callOrder).toContain('dbContext:released');
      expect(callOrder.lastIndexOf('dbContext:opened')).toBeGreaterThan(callOrder.lastIndexOf('dbContext:released'));
```

6. Replace "returns 200 and omits all four policy config keys when the shared policy-config system context itself fails" (:4081) — same comment, updated to say the context is now the SECOND `withDbAccessContext` call — with:

```ts
  it('returns 200 and omits all policy config keys when the post-commit policy context itself fails to open', async () => {
    const { captureException } = await import('../../services/sentry');
    withDbAccessContextMock
      .mockImplementationOnce(orgDbAccessContextPassthrough) // the org block
      .mockImplementationOnce(async () => {
        throw new Error('policy context failed to open');
      }); // the post-commit policy context — the one under test

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.event_log_settings).toBeUndefined();
    expect(configUpdate?.monitoring_settings).toBeUndefined();
    expect(configUpdate?.patch_source_settings).toBeUndefined();
    expect(configUpdate?.onedrive_helper_settings).toBeUndefined();
    expect(body.uacInterceptionEnabled).toBe(false);
    expect(body.helperEnabled).toBe(false);
    expect(vi.mocked(captureException)).toHaveBeenCalled();
  });
```

7. Replace the `#8053 — shared post-commit policy context` describe's first test (:4146) and last test (:4196) with:

```ts
  it('opens two system contexts and ONE org-scoped policy context per beat, carrying the agent partner (#8142)', async () => {
    const helpers = await import('./helpers');
    vi.mocked(helpers.buildHelperConfigUpdate).mockImplementationOnce(async () => {
      callOrder.push('helper:resolved');
      return { enabled: true } as never;
    });
    vi.mocked(helpers.buildPolicyProbeConfigUpdate).mockImplementationOnce(async () => {
      callOrder.push('policyProbe:resolved');
      return null;
    });
    vi.mocked(helpers.buildEventLogConfigUpdate).mockImplementationOnce(async () => {
      callOrder.push('eventLog:resolved');
      return undefined as never;
    });
    vi.mocked(helpers.loadOnedriveHelperConfigPlan).mockImplementationOnce(async () => {
      callOrder.push('onedrive:plan');
      return null;
    });
    vi.mocked(helpers.buildMonitoringConfigUpdate).mockImplementationOnce(async () => {
      callOrder.push('monitoring:resolved');
      return null;
    });

    const body = await beat();

    expect(body.helperEnabled).toBe(true);
    // update policy + topology flags only; no OneDrive or policy SYSTEM context any more.
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(2);
    expect(orgDbContexts).toHaveLength(2);
    expect(orgDbContexts[1]).toMatchObject({
      scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'], accessiblePartnerIds: [], currentPartnerId: 'partner-1',
    });
    const policyOpened = callOrder.lastIndexOf('dbContext:opened');
    const order = ['helper:resolved', 'policyProbe:resolved', 'eventLog:resolved', 'onedrive:plan', 'monitoring:resolved']
      .map((e) => callOrder.indexOf(e));
    expect(order.every((i) => i > policyOpened)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[order.length - 1]).toBeLessThan(callOrder.lastIndexOf('dbContext:released'));
  });

  it('with a policy set, helper and the per-feature builders get it, and only the hierarchy/set savepoint opens (#8142)', async () => {
    const helpers = await import('./helpers');
    const { loadDevicePolicySet } = await import('../../services/devicePolicySet');
    const set = { deviceId: 'device-1', hierarchy: { ...TEST_HIERARCHY }, candidates: [] };
    vi.mocked(loadDevicePolicySet).mockResolvedValueOnce(set as never);
    vi.mocked(helpers.buildPolicyProbeConfigUpdate).mockResolvedValueOnce(null);
    const { orgPolicyProbeCache } = await import('../../services/agentOrgSettingsCache');
    orgPolicyProbeCache.invalidate();
    callOrder.length = 0;

    await beat();

    for (const builder of [
      helpers.buildEventLogConfigUpdate, helpers.buildHardwareMonitoringConfigUpdate,
      helpers.buildMonitoringConfigUpdate, helpers.buildPamConfigUpdate,
      helpers.buildPatchSourceConfigUpdate, helpers.buildWarrantyConfigUpdate, helpers.buildTimeSyncConfigUpdate,
    ]) {
      expect(vi.mocked(builder)).toHaveBeenCalledWith('device-1', expect.objectContaining({ policySet: set, hierarchy: set.hierarchy }));
    }
    expect(vi.mocked(helpers.buildHelperConfigUpdate))
      .toHaveBeenCalledWith('device-1', 'org-1', expect.objectContaining({ policySet: set }));
    // No onedrive link in the set → no OneDrive DB phase at all.
    expect(helpers.loadOnedriveHelperConfigPlan).not.toHaveBeenCalled();
    // hierarchy/set savepoint + the probe's cache-miss savepoint; the helper resolves in memory.
    expect(callOrder.filter((e) => e === 'savepoint')).toHaveLength(2);
  });

  it('values read before a COMMIT failure are still delivered (read-only transaction) (#8142)', async () => {
    const helpers = await import('./helpers');
    vi.mocked(helpers.buildHelperConfigUpdate).mockResolvedValueOnce({ enabled: true } as never);
    vi.mocked(helpers.buildPamConfigUpdate).mockResolvedValueOnce({ uacInterceptionEnabled: true });
    vi.mocked(helpers.buildPatchSourceConfigUpdate).mockResolvedValueOnce({ exclusiveWindowsUpdate: true });
    withDbAccessContextMock
      .mockImplementationOnce(orgDbAccessContextPassthrough) // org block
      .mockImplementationOnce(async (_ctx: unknown, fn: () => Promise<unknown>) => {
        await fn();
        throw new Error('current transaction is aborted');
      });

    const body = await beat();

    // Every value was read successfully before a later statement aborted the
    // read-only transaction; delivering them is correct. (W01 kept only the
    // helper and probe; #8142 keeps every result, written as it is produced.)
    expect(body.helperEnabled).toBe(true);
    expect(body.uacInterceptionEnabled).toBe(true);
    expect((body.configUpdate as Record<string, unknown>).patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
  });
```

8. Replace the `#8053 W1a-1 hierarchy pass-through` describe's second test (:880, "drops a hierarchy whose org is not the beat's org") with three tests, and change the first test's builder list to use `helpers.loadOnedriveHelperConfigPlan` in place of `helpers.buildOnedriveHelperConfigUpdate`:

```ts
    for (const [label, override] of [
      ['moved to another org', { orgId: 'org-2' }],
      ['org re-parented to another partner', { org: { partnerId: 'partner-2', type: 'customer' } }],
    ] as const) {
      it(`device ${label} mid-beat: no policy builder runs, nothing is cached, Sentry is told (#8142)`, async () => {
        const { loadDeviceHierarchy } = await import('../../services/deviceHierarchy');
        const helpers = await import('./helpers');
        const { captureException } = await import('../../services/sentry');
        vi.mocked(loadDeviceHierarchy).mockResolvedValueOnce({ ...hierarchy, ...override } as never);
        arrangeBeat();

        const res = await beat();
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        for (const builder of [
          helpers.buildEventLogConfigUpdate, helpers.buildMonitoringConfigUpdate, helpers.buildPamConfigUpdate,
          helpers.buildPatchSourceConfigUpdate, helpers.buildWarrantyConfigUpdate, helpers.buildTimeSyncConfigUpdate,
          helpers.buildHelperConfigUpdate, helpers.buildPolicyProbeConfigUpdate, helpers.loadOnedriveHelperConfigPlan,
        ]) {
          expect(vi.mocked(builder)).not.toHaveBeenCalled();
        }
        expect(body.helperEnabled).toBe(false);
        expect(body.uacInterceptionEnabled).toBe(false);
        expect(vi.mocked(captureException)).toHaveBeenCalledWith(expect.objectContaining({
          message: expect.stringContaining('not visible to its own org'),
        }));
      });
    }

    it('a policy-set load failure keeps the hierarchy: builders get it without a set (#8142)', async () => {
      const { loadDeviceHierarchy } = await import('../../services/deviceHierarchy');
      const { loadDevicePolicySet } = await import('../../services/devicePolicySet');
      const helpers = await import('./helpers');
      vi.mocked(loadDeviceHierarchy).mockResolvedValueOnce(hierarchy as never);
      vi.mocked(loadDevicePolicySet).mockRejectedValueOnce(new Error('set read failed'));
      arrangeBeat();

      expect((await beat()).status).toBe(200);
      expect(vi.mocked(helpers.buildEventLogConfigUpdate)).toHaveBeenCalledWith('device-1', { hierarchy });
      expect(vi.mocked(helpers.buildPolicyProbeConfigUpdate)).toHaveBeenCalledWith('org-1', { partnerId: 'partner-1' });
    });
```

9. In the parked-beat test (:7641) add `expect(helpers.loadOnedriveHelperConfigPlan).not.toHaveBeenCalled();` next to the `buildOnedriveHelperConfigUpdate` assertion.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts`
Expected: FAIL — the new tests (two system contexts expected, 4 found; OneDrive plan/finish never called; no skip on a moved device). Pre-existing tests unrelated to the policy context still pass.

- [ ] **Step 3: Rewrite the post-commit block in `heartbeat.ts`**

Imports: in the `./helpers` import replace `buildOnedriveHelperConfigUpdate,` with `loadOnedriveHelperConfigPlan,\n  finishOnedriveHelperConfig,` and add `type OnedriveConfigPlan,`; add
`import { loadDevicePolicySet, withPolicySet, type DevicePolicySet } from '../../services/devicePolicySet';`. Keep `loadDeviceHierarchy` and `type DeviceHierarchy`; drop `withHierarchy` from the deviceHierarchy import if nothing else uses it (`grep -n withHierarchy apps/api/src/routes/agents/heartbeat.ts`).

In the `dbContext` comment (:545-576), replace the paragraphs from `// Scope note, so nobody over-reads this:` through `// Track it separately; do not do it by analogy with W03.` with:

```ts
    // #8142 (scaling W03 / W1a-2): this field is LOAD-BEARING on this route
    // too. The post-commit policy context further down REUSES this context —
    // it used to be two hoisted system contexts — so every partner-wide policy
    // the beat delivers (helper, event log, hardware monitoring, monitoring,
    // PAM, patch source, warranty, time sync, the policy probe) is read
    // through the SELECT-only *_partner_wide_select branches keyed on
    // breeze.current_partner_id. Drop it and those policies silently stop
    // reaching agents, with no error. The patch-source partner-axis timezone
    // read that used to block this was removed in W01 (#8222).
```

Replace the block from `  // Policy probe config and helper settings are resolved in the shared policy` through `  } = policyConfigs;` with:

```ts
  // Policy probe config and helper settings are resolved in the policy context
  // below, but declared here because the merge below reads them. (Initialised
  // via `as` so TypeScript does not narrow them to `null`: it cannot see the
  // assignments made inside that callback.)
  let policyProbeConfig = null as PolicyProbeConfigUpdate | null;
  let helperSettings = null as HelperSettings | null;

  // #8142 (scaling W03 / W1a-2) — ONE post-commit context for every
  // policy-derived field, ORG-SCOPED: the org block's own `dbContext`
  // (accessibleOrgIds [org], accessiblePartnerIds [], currentPartnerId =
  // the agent's partner). It replaces the OneDrive and shared-policy SYSTEM
  // contexts, so RLS — not any WHERE clause — is the tenant boundary for every
  // read here: rows of other orgs and of other partners are invisible, and a
  // partner-wide policy is visible only through the SELECT-only
  // *_partner_wide_select branches. Opened only after the org transaction has
  // been released; it holds the only pooled connection (#1105), and nothing
  // here makes an HTTP call (OneDrive's Graph phase runs after it commits).
  //
  // 1. Hierarchy + policy set, in ONE savepoint. The hierarchy (W01) is read
  //    by `scoped.deviceId`, the device the agent authenticated as. The set is
  //    every candidate assignment for every heartbeat feature, in ONE statement
  //    (devicePolicySet.ts); each resolver applies its own rules to it.
  //    Outcomes:
  //    - MISSING: the device is not visible to its own org's context, or its
  //      org/partner is not the authenticated one (moved, deleted or
  //      re-parented after the org transaction committed). Skip EVERY policy
  //      builder: generating answers here would send defaults/reverts and cache
  //      them. Helper and PAM read false for this one beat, as they do whenever
  //      this context fails (the agent reads an absent value as off).
  //    - hierarchy ERROR: every resolver reads its own (W01's fallback).
  //    - set ERROR: the hierarchy is kept (it was read before the failure);
  //      resolvers read their own assignments with it.
  // 2. Every result is written to an outer variable as soon as it is produced.
  //    The transaction is read-only, so a value read before a later statement
  //    aborted it is still right; a failed COMMIT only skips the per-org cache
  //    fills. (Before #8142 only helper and probe survived a COMMIT failure.)
  // 3. Order: with the set, everything up to OneDrive is pure TypeScript except
  //    the per-org cache misses (each in its own savepoint). OneDrive's DB phase
  //    (own savepoint, only when the set holds a OneDrive link) runs before
  //    monitoring's secondary reads, which run last: a monitoring SQL error can
  //    then only lose monitoring, whose failure answer (omit) is safe.
  type PolicyConfigUpdates = {
    eventLogSettings: Record<string, unknown> | null;
    monitoringSettings: Record<string, unknown> | null;
    pamSettings: { uacInterceptionEnabled: boolean } | null;
    patchSourceSettings: { exclusiveWindowsUpdate: boolean } | null;
    warrantySettings: { hpCmslEnabled: boolean } | null;
    hardwareMonitoringSettings: Awaited<ReturnType<typeof buildHardwareMonitoringConfigUpdate>> | null;
    timeSyncSettings: Awaited<ReturnType<typeof buildTimeSyncConfigUpdate>> | null;
  };
  const policyConfigs: PolicyConfigUpdates = {
    eventLogSettings: null,
    monitoringSettings: null,
    pamSettings: null,
    patchSourceSettings: null,
    warrantySettings: null,
    hardwareMonitoringSettings: null,
    timeSyncSettings: null,
  };
  let onedrivePlan = null as OnedriveConfigPlan | null;
  // #8053 W1a-1 per-org caches; under this org-scoped context a miss is stored
  // only for the exact org + partner the context was built for (#8142).
  const orgCacheFills = new DeferredCacheFills();
  try {
    await withDbAccessContext(dbContext, async () => {
      let beatHierarchy = null as DeviceHierarchy | null;
      let beatPolicySet = null as DevicePolicySet | null;
      let hierarchyOutcome = 'error' as 'loaded' | 'missing' | 'error';
      try {
        await withDbTransaction(async () => {
          const loaded = await loadDeviceHierarchy(scoped.deviceId);
          if (
            !loaded
            || loaded.orgId !== scoped.deviceOrgId
            || loaded.orgId !== agent.orgId
            || (loaded.org?.partnerId ?? null) !== agent.partnerId
          ) {
            hierarchyOutcome = 'missing';
            return;
          }
          beatHierarchy = loaded;
          hierarchyOutcome = 'loaded';
          beatPolicySet = await loadDevicePolicySet(loaded);
        });
      } catch (err) {
        console.error(`[agents] failed to load the device hierarchy or policy set for ${agentId}; resolvers read their own:`, err);
        captureException(err);
      }
      if (hierarchyOutcome === 'missing') {
        console.warn(`[agents] device ${scoped.deviceId} is not visible to its own org context (moved, deleted or re-parented mid-beat); omitting policy config this heartbeat`);
        captureException(new Error('heartbeat policy context: device hierarchy not visible to its own org'));
        return;
      }

      const policyOpts = withPolicySet(beatPolicySet, beatHierarchy);
      const fillScope = beatHierarchy?.org
        ? { orgId: beatHierarchy.orgId, partnerId: beatHierarchy.org.partnerId }
        : undefined;
      const probePartnerOpts = beatHierarchy?.org ? { partnerId: beatHierarchy.org.partnerId } : undefined;

      // Helper. Redis first (no statement on a hit). With the set the helper
      // resolves in memory and only the legacy org flag can read (its own
      // savepoint, on a per-org cache miss). Without it, the whole helper read
      // keeps its own savepoint, as before: a null helper delivers
      // helperEnabled:false, so its SQL error must not abort the context.
      try {
        const cachedHelper = await readCachedHelperSettings(scoped.deviceId);
        if (cachedHelper) {
          helperSettings = cachedHelper;
        } else {
          const helperOpts = {
            ...policyOpts,
            skipCacheRead: true,
            loadOrgHelperSettings: (orgId: string) =>
              orgCacheFills.through(orgHelperSettingsCache, orgId, () => withDbTransaction(() => getOrgHelperSettings(orgId)), fillScope),
          };
          helperSettings = beatPolicySet
            ? await buildHelperConfigUpdate(scoped.deviceId, scoped.deviceOrgId, helperOpts)
            : await withDbTransaction(() => buildHelperConfigUpdate(scoped.deviceId, scoped.deviceOrgId, helperOpts));
        }
      } catch (err) {
        console.error(`[agents] failed to read helper settings for ${agentId}:`, err);
        captureException(err);
      }

      // Policy probe (per-org cache; savepoint only on a miss). automation_policies
      // carries its own partner-wide SELECT branch, so partner-wide compliance
      // policies (#2129) are visible in this org-scoped context.
      try {
        const cachedProbe = orgPolicyProbeCache.peek(scoped.deviceOrgId);
        policyProbeConfig = cachedProbe !== undefined
          ? cachedProbe
          : await withDbTransaction(() =>
            orgCacheFills.through(orgPolicyProbeCache, scoped.deviceOrgId, () =>
              buildPolicyProbeConfigUpdate(scoped.deviceOrgId, probePartnerOpts), fillScope),
          );
      } catch (err) {
        console.error(`[agents] failed to build policy probe config update for ${agentId}:`, err);
        captureException(err);
      }

      // Sentry on every feature: losing a policy silently is exactly #2930.
      try {
        policyConfigs.eventLogSettings = await buildEventLogConfigUpdate(scoped.deviceId, policyOpts);
      } catch (err) {
        console.error(`[agents] failed to build event log config update for ${agentId}:`, err);
        captureException(err);
      }

      try {
        policyConfigs.hardwareMonitoringSettings = await buildHardwareMonitoringConfigUpdate(scoped.deviceId, policyOpts);
      } catch (err) {
        console.error(`[agents] failed to build hardware monitoring config update for ${agentId}:`, err);
        captureException(err);
      }

      try {
        policyConfigs.pamSettings = await buildPamConfigUpdate(scoped.deviceId, {
          ...policyOpts,
          loadOrgPamFallback: (orgId) =>
            orgCacheFills.through(orgPamFallbackCache, orgId, () => withDbTransaction(() => resolveOrgPamFallback(orgId)), fillScope),
        });
      } catch (err) {
        // Opt-in default: a resolver failure sends uacInterceptionEnabled:false.
        // For an org that ENFORCES PAM this momentarily drops elevation gating
        // until the next successful heartbeat. Not cached; self-heals.
        console.error(
          `[agents] failed to build pam config update for ${agentId} — sending uacInterceptionEnabled:false this heartbeat:`,
          err,
        );
        captureException(err);
      }

      // #1872 sole-patch-source enforcement: a resolver error omits the block
      // (never a revert); a successful resolve with no policy returns false.
      try {
        policyConfigs.patchSourceSettings = await buildPatchSourceConfigUpdate(scoped.deviceId, policyOpts);
      } catch (err) {
        console.error(`[agents] failed to build patch_source config update for ${agentId}:`, err);
        captureException(err);
      }

      // #5511 W02 HP CMSL: same shape as patch_source — an error only omits.
      try {
        policyConfigs.warrantySettings = await buildWarrantyConfigUpdate(scoped.deviceId, policyOpts);
      } catch (err) {
        console.error(`[agents] failed to build warranty config update for ${agentId}:`, err);
        captureException(err);
      }

      // Time sync (index §F.2): an error only omits time_sync_settings.
      try {
        policyConfigs.timeSyncSettings = await buildTimeSyncConfigUpdate(scoped.deviceId, policyOpts);
      } catch (err) {
        console.error(`[agents] failed to build time sync config update for ${agentId}:`, err);
        captureException(err);
      }

      // OneDrive DB phase (#1105: no Graph call here). Its own savepoint, and
      // skipped outright when the set shows no OneDrive settings link at all.
      // The onedrive_device_state upsert happened in the org block, so
      // ingest-before-delivery ordering is preserved.
      try {
        const mayHaveOnedrive = !beatPolicySet
          || beatPolicySet.candidates.some((c) => c.links.onedrive_helper?.onedrive);
        if (mayHaveOnedrive) {
          onedrivePlan = await withDbTransaction(() => loadOnedriveHelperConfigPlan(scoped.deviceId, policyOpts));
        }
      } catch (err) {
        console.error(`[agents] failed to load onedrive_helper config for ${agentId}:`, err);
        captureException(err);
      }

      // Monitoring last. null = unresolved → omit (agent keeps its watches);
      // "no policy applies" arrives as { watches: [] } and must be sent (#2949).
      // With the set, a device with no monitors link costs no statement.
      try {
        policyConfigs.monitoringSettings = await buildMonitoringConfigUpdate(scoped.deviceId, policyOpts) as Record<string, unknown> | null;
      } catch (err) {
        console.error(`[agents] failed to build monitoring config update for ${agentId}:`, err);
        captureException(err);
      }
    });
    // Stored only now that the context has committed (fillIfCurrent refuses to
    // run inside one); a failed commit throws past this line.
    orgCacheFills.flush();
  } catch (err) {
    // Context setup or COMMIT failure. Values already written above are kept
    // (see 2.); anything not yet produced keeps its "no update this cycle"
    // null. By now the org transaction has committed and the claimed commands
    // are marked delivered, so this must never 500 the heartbeat.
    console.error(`[agents] policy config context failed for ${agentId}; delivering what was read before the failure:`, err);
    captureException(err);
  }

  // OneDrive Graph phase: after the policy context is released, with no DB
  // access (the plan carries every row it needs) — #1105.
  let onedriveSettings: OnedriveConfigUpdate | null = null;
  if (onedrivePlan) {
    try {
      onedriveSettings = await finishOnedriveHelperConfig(onedrivePlan);
    } catch (err) {
      console.error(`[agents] failed to build onedrive_helper config update for ${agentId}:`, err);
      captureException(err);
    }
  }
  const onedriveConfigUpdate = onedriveSettings
    ? { onedrive_helper_settings: onedriveSettings }
    : null;

  const {
    eventLogSettings,
    monitoringSettings,
    pamSettings,
    patchSourceSettings,
    warrantySettings,
    hardwareMonitoringSettings,
    timeSyncSettings,
  } = policyConfigs;
```

Everything after (the `policyConfigUpdate` assembly and the response) is unchanged.

- [ ] **Step 4: Run the unit suite to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts`
Expected: PASS. For any remaining failure in an order-coupled assertion that still reads `systemCtx:*` for the policy or OneDrive context, apply exactly this mapping and nothing looser: the policy context is the SECOND `dbContext:opened`/`dbContext:released` pair (`callOrder.lastIndexOf('dbContext:opened')`), and there is no OneDrive context; `withSystemDbAccessContextMock` is called twice per normal beat (update policy, topology flags). A test whose agent context uses an org or partner other than `org-1` / `partner-1` gets `vi.mocked(loadDeviceHierarchy).mockResolvedValueOnce({ ...TEST_HIERARCHY, orgId: <its org>, org: { partnerId: <its partner>, type: 'customer' } })`.

- [ ] **Step 5: Typecheck, then run the heartbeat-adjacent suites**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"` — Expected: `tsc exit 0`.
Run: `cd apps/api && npx vitest run src/routes/agents` — Expected: PASS.
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
Expected: FAIL only on the numeric budget assertions (now lower: transactions 2, not 3) — Task 9 ratchets them. Behaviour guards (sibling helper isolation, role written this beat, helper-savepoint fault) must PASS; if the "real SQL error in the helper reader stays inside its savepoint" test fails, the fallback-path helper savepoint is missing — fix the code, not the test.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(api): heartbeat resolves all policy config in one org-scoped context from one batched read (#8142)

Replaces the OneDrive and shared-policy system contexts with the org block's own
RLS context (currentPartnerId set, no partner-axis access). OneDrive's Graph
phase runs after commit with no DB access.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Budget suite — buckets, guards, ratchet, new budgets, perf probe

**Files:**
- Modify: `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`

**Interfaces:**
- Consumes: `seedPolicy` (Task 2 fixtures); `loadDeviceHierarchy`; `policySetQuery` (Task 2).
- Produces: pinned budgets — steady 14 / 2, warm 14 / 2, cold (measured), per-org-cache-miss (measured), legacy payload 16 / 2, configured device (measured).

- [ ] **Step 1: Add the buckets and the new tests; ratchet the existing assertions**

1. Header comment: replace its last paragraph ("Ratcheted after #8053 W1a-1 …") with:

```ts
 * Ratcheted after #8053 W1a-1 (steady 26 / 3 tx, warm 20 / 3, cold 57 / 8) and
 * again after #8142 W03 (steady 14 / 2 tx, warm 14 / 2): one org-scoped
 * post-commit context instead of the OneDrive + shared system contexts, and
 * one policy-set read instead of ten per-feature assignment reads.
```

2. Add to `BUCKET_MATCHERS`, **before** `peripheralCapabilityWrites` (order matters: the first match wins):

```ts
  // #8142: the one-statement policy set, and anything that still reads
  // assignments per feature (must be 0 on every beat shape with a set).
  policySetLoad: (s: string) =>
    s.includes('from "config_policy_assignments"') && s.includes('left join "config_policy_effective_feature_links"'),
  perFeatureAssignmentRead: (s: string) =>
    s.includes('"config_policy_assignments"') && !s.includes('left join "config_policy_effective_feature_links"'),
  // Monitoring's raw-link secondaries (intervals, attachments, replace links) and definitions.
  monitoringSecondary: (s: string) =>
    s.includes('from "config_policy_feature_links"') || s.includes('from "monitor_definitions"'),
  onedriveRead: (s: string) =>
    s.includes('from "config_policy_onedrive_libraries"') || s.includes('from "onedrive_device_state"') || s.includes('from "m365_connections"'),
```

3. Imports: add `import { sql } from 'drizzle-orm';` (merge into the existing drizzle import), `import { withDbAccessContext } from '../../db';` (merge), `import { createOrganization, createPartner } from './db-utils';` (merge), `import { loadDeviceHierarchy } from '../../services/deviceHierarchy';`, `import { policySetQuery } from '../../services/devicePolicySet';`, `import { seedPolicy, type SeedLink } from './policySetFixtures';`.

4. In the steady-state test, replace the block from `// #8053 W1a-1 ratchet.` through `expect(warm.savepoints).toBe(1);` with:

```ts
    // #8142 W03 ratchet. Measured after the batched policy read:
    //   steady 14 statements / 2 tx (was 26 / 3), warm 14 / 2 (was 20 / 3),
    //   cold <COLD_STATEMENTS> / <COLD_TX> (was 57 / 8).
    // Pinned at the measured value, not "plus one": a new statement reds this.
    expect(steady.transactions).toBe(2);
    expect(steady.statements).toBeLessThanOrEqual(14);
    expect(warm.transactions).toBe(2);
    expect(warm.statements).toBeLessThanOrEqual(14);
    expect(cold.transactions).toBeLessThanOrEqual(COLD_TX);
    expect(cold.statements).toBeLessThanOrEqual(COLD_STATEMENTS);
    expect(cold.buckets.hierarchyLoad).toBe(1);
    expect(cold.buckets.deviceLookup).toBe(0);
    expect(cold.buckets.topologyNegotiation).toBe(0);
    expect(cold.buckets.agentVersions).toBe(1);

    // W1a-1 levers stay pulled.
    expect(steady.buckets.hierarchyLoad).toBe(1);
    expect(steady.buckets.deviceLookup).toBe(0);
    expect(steady.buckets.orgPartnerLookup).toBe(0);
    expect(steady.buckets.groupLookup).toBe(0);
    expect(steady.buckets.siteLookup).toBe(0);
    expect(steady.buckets.topologyNegotiation).toBe(0);
    expect(warm.buckets.topologyNegotiation).toBe(0);
    expect(steady.buckets.automationPolicies).toBe(0);
    expect(steady.buckets.orgHelperSettings).toBe(0);
    expect(steady.buckets.pamOrgConfig).toBe(0);
    expect(steady.buckets.agentVersions).toBe(1);
    expect(warm.buckets.agentVersions).toBe(1);

    // #8142 levers: one policy-set read, no per-feature assignment reads, and a
    // device with no monitors / OneDrive link pays nothing for either.
    for (const beat of [steady, warm]) {
      expect(beat.buckets.policySetLoad).toBe(1);
      expect(beat.buckets.perFeatureAssignmentRead).toBe(0);
      expect(beat.buckets.monitoringSecondary).toBe(0);
      expect(beat.buckets.onedriveRead).toBe(0);
      // The claim's savepoint + the hierarchy/set savepoint. The helper resolves
      // from the set in memory (no savepoint), the probe is a cache hit.
      expect(beat.savepoints).toBe(2);
    }
```

and add above the `describe` (with the values replaced in Step 3):

```ts
// #8142 — measured once in Task 9 Step 3 and pinned.
const COLD_TX = 7;
const COLD_STATEMENTS = 47;
const CACHES_MISS_STATEMENTS = 20;
const CONFIGURED_STEADY_STATEMENTS = 21;
```

5. In the "per-org caches … all miss" test: change `expect(missed.transactions).toBe(3);` to `toBe(2)` and `expect(missed.statements).toBeLessThanOrEqual(30);` to `toBeLessThanOrEqual(CACHES_MISS_STATEMENTS)`; rename it to "…still costs 2 transactions; each miss loads in its own savepoint inside the policy context". In the legacy-payload test change `toBeLessThanOrEqual(3)` to `toBe(2)` and `toBeLessThanOrEqual(28)` to `toBeLessThanOrEqual(16)`.

6. Append these tests inside `describe('agent hot-path DB budget (#8053) — real PostgreSQL', …)`:

```ts
  const CONFIGURED_LINKS = (orgId: string): SeedLink[] => [
    { featureType: 'helper', inlineSettings: { enabled: true } },
    { featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } },
    { featureType: 'warranty', inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 } },
    { featureType: 'event_log', maxEventsPerCycle: 250 },
    { featureType: 'hardware_monitoring', pollIntervalMinutes: 15 },
    { featureType: 'patch', exclusiveWindowsUpdate: true },
    { featureType: 'time_sync', ntpServers: ['time.budget.example'] },
    { featureType: 'monitors', serviceName: 'BudgetService', checkIntervalSeconds: 90 },
    { featureType: 'onedrive_helper', orgId, filesOnDemand: true, libraryName: 'Budget Docs' },
  ];

  runDb('POST /agents/:id/heartbeat: a device configured for EVERY feature stays at 2 transactions (#8142)', async () => {
    const org = await seedOrg('configured');
    const device = await enrollDevice(org, 'configured');
    const sibling = await enrollDevice(org, 'configured-sibling');
    await seedPolicy({ owner: { orgId: org.orgId, partnerId: null }, links: CONFIGURED_LINKS(org.orgId),
      assignments: [{ level: 'organization', targetId: org.orgId }] });
    expect((await heartbeat(device)).status).toBe(200);
    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);

    let body: Record<string, any> = {};
    const steady = await measure(async () => {
      const res = await heartbeat(device);
      body = await res.clone().json() as Record<string, any>;
      return res;
    });
    console.log('[#8142 budget] configured steady:', JSON.stringify(steady));

    // Non-vacuous: every feature really resolved from the policy.
    expect(body.helperEnabled).toBe(true);
    expect(body.uacInterceptionEnabled).toBe(true);
    expect(body.configUpdate.event_log_settings.max_events_per_cycle).toBe(250);
    expect(body.configUpdate.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
    expect(body.configUpdate.monitoring_settings).toMatchObject({ check_interval_seconds: 90, watches: [expect.objectContaining({ name: 'BudgetService' })] });
    expect(body.configUpdate.onedrive_helper_settings.libraries).toHaveLength(1);

    expect(steady.transactions).toBe(2);
    expect(steady.buckets.policySetLoad).toBe(1);
    expect(steady.buckets.perFeatureAssignmentRead).toBe(0);
    expect(steady.statements).toBeLessThanOrEqual(CONFIGURED_STEADY_STATEMENTS);
  });

  runDb('a device whose only policy is PAM pays no monitoring statement and still gets the explicit clear (#8142)', async () => {
    const org = await seedOrg('pamonly');
    const device = await enrollDevice(org, 'pamonly');
    const sibling = await enrollDevice(org, 'pamonly-sibling');
    await seedPolicy({ owner: { orgId: org.orgId, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
      assignments: [{ level: 'organization', targetId: org.orgId }] });
    expect((await heartbeat(device)).status).toBe(200);
    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);

    let body: Record<string, any> = {};
    const steady = await measure(async () => {
      const res = await heartbeat(device);
      body = await res.clone().json() as Record<string, any>;
      return res;
    });
    expect(body.uacInterceptionEnabled).toBe(true);
    expect(body.configUpdate.monitoring_settings).toEqual({ check_interval_seconds: 60, watches: [] });
    expect(steady.buckets.monitoringSecondary).toBe(0);
    expect(steady.transactions).toBe(2);
    expect(steady.statements).toBeLessThanOrEqual(14);
  });

  runDb('cross-tenant assignments forged onto this device never reach its heartbeat (#8142)', async () => {
    const org = await seedOrg('forge');
    const device = await enrollDevice(org, 'forge-target');
    const sameParterOtherOrg = (await createOrganization({ partnerId: org.partnerId }))!;
    const foreignPartner = (await createPartner())!;
    await seedPolicy({ owner: { orgId: sameParterOtherOrg.id, partnerId: null },
      links: [{ featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://forged.example' } }],
      assignments: [{ level: 'device', targetId: device.deviceId }] });
    await seedPolicy({ owner: { orgId: null, partnerId: foreignPartner.id },
      links: [{ featureType: 'event_log', maxEventsPerCycle: 999 }],
      assignments: [{ level: 'partner', targetId: org.partnerId, priority: -10 }] });

    const res = await heartbeat(device);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.helperEnabled).toBe(false);
    expect(body.helperSettings?.portalUrl).toBeUndefined();
    expect(body.configUpdate.event_log_settings.max_events_per_cycle).toBe(100);
  });

  it.runIf(!!process.env.DATABASE_URL && !!process.env.EXPLAIN_8142)(
    'perf probe: EXPLAIN (ANALYZE, BUFFERS) of the policy-set statement as breeze_app, configured device (#8142)',
    async () => {
      const org = await seedOrg('explain');
      const device = await enrollDevice(org, 'explain');
      await seedPolicy({ owner: { orgId: org.orgId, partnerId: null }, links: CONFIGURED_LINKS(org.orgId),
        assignments: [{ level: 'organization', targetId: org.orgId }] });
      const plan = await withDbAccessContext({
        scope: 'organization', orgId: org.orgId, accessibleOrgIds: [org.orgId], accessiblePartnerIds: [],
        userId: null, currentPartnerId: org.partnerId,
      }, async () => {
        const hierarchy = await loadDeviceHierarchy(device.deviceId);
        return db.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${policySetQuery(hierarchy!)}`);
      });
      console.log((plan as unknown as Array<Record<string, string>>).map((r) => r['QUERY PLAN']).join('\n'));
    },
  );
```

- [ ] **Step 2: Run, read the measured numbers**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts --reporter=verbose --silent=false 2>&1 | grep -E "budget\]|✓|×|FAIL"`
Expected: the steady/warm assertions (14 / 2) PASS. The four pinned constants may FAIL if the measured values are higher than the estimates; read them from the `[#8053 budget] heartbeat cold:`, `per-org caches all miss:` and `[#8142 budget] configured steady:` lines. If steady or warm is above 14, or any beat shape shows 3 transactions, stop and find the extra statement with `DUMP_8053=1` — do not raise those two numbers (they are the spec target).

- [ ] **Step 3: Pin the measured values**

Set `COLD_TX`, `COLD_STATEMENTS`, `CACHES_MISS_STATEMENTS` and `CONFIGURED_STEADY_STATEMENTS` to the measured values (lower or equal is a PASS; pin exactly the measured number), and update the `<COLD_STATEMENTS> / <COLD_TX>` text in the ratchet comment to the same numbers. Expected neighbourhood: cold ≈47 / 7, caches-miss ≈20 (14 + three savepoint+read pairs), configured ≈21 (14 + monitoring's 4 secondary reads + OneDrive savepoint, libraries, device state). A value far above that is a regression to find, not to pin.

Run the suite again: Expected: PASS.

- [ ] **Step 4: Perf probe (Codex quorum item 9)**

Run: `cd apps/api && EXPLAIN_8142=1 npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts -t "perf probe" --silent=false`
Expected: a plan printed (embedding the Drizzle builder in `sql\`EXPLAIN … ${…}\`` carries its parameters — verified on the test stack). Paste it, with `Execution Time` and `Buffers`, into the PR body under "Policy-set statement plan (breeze_app, configured device)". Run the same probe on `origin/main` against the ten per-feature statements it replaces (their text is in the `DUMP_8053` output) and put the summed execution time next to it. If the set statement is slower than that sum, say so in the PR and propose the fallback shape (assignments + effective links in one statement, then ONE bulk settings statement: +1 statement, configured devices only) for the review round to decide.

- [ ] **Step 5: Full verification before the PR**

Run, from the worktree root unless noted:
- `cd apps/api && npx vitest run` (full API unit suite — required **Test API** job; the org-merge and cascade contracts only red in the full run). Expected: PASS.
- `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts src/__tests__/integration/devicePolicySet.integration.test.ts src/__tests__/integration/hardwareMonitoringPartnerWideSelect.integration.test.ts src/__tests__/integration/deviceHierarchyResolverParity.integration.test.ts src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts src/__tests__/integration/configPolicyPartnerWideSelect.integration.test.ts src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts src/__tests__/integration/onedrive-helper-write-path.integration.test.ts` — Expected: PASS (check the reported file count is 9).
- `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` — Expected: PASS.
- `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"` — Expected: `tsc exit 0`.
- `bash scripts/check-migration-naming.sh --against-ref origin/main` — Expected: OK (rename the migration if a newer one landed).

- [ ] **Step 6: Commit and tear down**

```bash
git add apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
git commit -m "test(api): ratchet heartbeat budget to 14 statements / 2 tx; configured-device and forge budgets (#8142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
pnpm test-stack down
```

PR (`feature/8139-scaling/wave-8142` → `main`): body includes `Closes #8142`, the measured before/after table (steady 26/3 → 14/2, warm 20/3 → 14/2, cold, caches-miss, configured), the perf-probe plan, the owner decisions below with their resolution, and the deterministic tie-break called out as a behaviour change. One independent review round (tenancy + agent-config parity) before enqueueing with `gh pr merge <N>`.

---

## Owner decisions

| # | Question | Recommendation |
|---|---|---|
| O1 | **Accept the deterministic tie-break?** Two assignments equal on level and priority (and createdAt where used) now resolve to the earliest-created assignment, on every resolver and every caller, instead of whatever row order the plan returned. A device whose config was decided by such a tie could flip once at deploy. | **Accept.** Today's answer is already unstable (plan-dependent, can change after VACUUM or an index change); parity cannot be proven without it. Optional: before release, run a read-only count of device/feature pairs with a live tie on the US and EU databases and list them in the release notes. |
| O2 | **Bind device-keyed Redis policy caches (helper, event log, hwmon, monitoring, PAM) to the org?** After an org move a stale entry can serve the old org's config for up to 120 s regardless of RLS (Codex finding 8; pre-existing, not introduced here). | **Follow-up issue, not this wave.** Key or validate by org like time sync already does (`cached.orgId === device.orgId`). It touches `helperAuth` and `/helper/config` and is independent of the statement cut. |
| O3 | **Agent protocol for "config unknown this beat".** When the policy context fails or the device is invisible mid-beat, the server must send `helperEnabled:false` and `uacInterceptionEnabled:false` (the agent reads absent as off), so the helper and PAM gating switch off for one beat. | **Follow-up (agent-shipped, high rigor):** an explicit "retain" signal for helper and PAM. W03 keeps today's behaviour and only reaches it on the same rare paths it does today. |

## Self-review

**1. Spec coverage.**
- "One batched policy-assignment read for all feature types instead of one per resolver" → Tasks 2–6 (set + every resolver), Task 8 (wired). Feature list verified against the trace: helper, event_log, hardware_monitoring, check-interval and monitors (both `monitors`), pam, patch, warranty, time_sync, onedrive_helper — ten reads, all replaced (Task 9 asserts `perFeatureAssignmentRead` = 0).
- "Fold the OneDrive context into the policy context" → Task 6 (split) + Task 8 (one context; Graph after commit).
- "Cache monitoring's 'no policy applies' with invalidation" → decided against, with the measured replacement (0 statements) and reasons (Design decision; Task 5; Task 9 PAM-only budget).
- "≤16 statements, ≤2 tx … the budget suite asserts each number" → Task 9 (14 / 2 steady and warm; every other beat shape pinned at 2 tx).
- Brief's tenancy requirement (RLS as the guard; real-Postgres cross-tenant forge) → Tasks 1, 2 (RLS-alone read), 3–6 (forged rows in the parity world), 9 (full heartbeat). Quorum → Design decision.

**2. Placeholder scan.** The four budget constants in Task 9 are estimates pinned to measured values in Step 3 by an explicit procedure; no other TBDs. Code moves (Task 5 `monitorsFromAssignments`, Task 6 OneDrive read path, Task 8 post-commit block) are written out in full with exact start/end anchors for the code they replace.

**3. Type consistency.** `DevicePolicySetOpts`, `policySetFor`, `withPolicySet(set, hierarchy)`, `candidatesWithLink(set, type, rule)`, `applicableCandidates(set, rule)`, `ApplicabilityRule` field values, `PolicySetLink.{eventLog,hardwareMonitoring,patch,timeSync,onedrive}`, `PolicyCandidate.{priority,assignmentCreatedAt,policyName,parentPolicyId,links}`, `OnedriveConfigPlan.{upnLookups,connection,libs,base}`, `DeferredFillScope.{orgId,partnerId}` and `policySetQuery` are used with the same names in every task.

**4. Review Focus.** Each line has its test: (1) Task 2 RLS-alone + Task 3 forge + Task 9 forge; (2) three-way parity in Tasks 3–5 + Task 1; (3) Task 3 tie block + Task 2 order test; (4) Task 8 moved/re-parented tests; (5) Task 6 Graph-phase unit tests.
