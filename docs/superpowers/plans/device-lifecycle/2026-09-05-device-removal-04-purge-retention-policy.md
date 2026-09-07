---
tracking_issue: LanternOps/breeze#5023
---
# Device Removal 04 — "Purge removed devices after N days" Retention Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP can set, per partner or per org, "permanently delete removed devices N days after removal", and a daily job does it through the same hardened purge path as the button. This is #2787 item 4, the thing the original reporter actually wanted.

**Architecture:** Pattern B inline config-policy feature `device_lifecycle` with `{ purgeRemovedAfterDays: number | null }` (null/absent = never), resolved at org level exactly like event-log retention (`getOrgEventLogRetentionDays`, `routes/agents/helpers.ts:1948` — org assignment beats partner assignment, ownership via `policyOwnershipCondition`). Needs one new column `devices.decommissioned_at` (set on Remove, cleared on Restore, backfilled from `updated_at` for existing removed rows) because nothing today records when a device was removed. A daily BullMQ job (`removedDevicePurge`) walks orgs, resolves the policy, selects `status='decommissioned' AND decommissioned_at < now() - N days`, and calls `purgeRemovedDevice` per device in its own system-context transaction, skipping `UNINSTALL_PENDING` (those come back next day). Audit one `device.permanent_delete` row per device with `actorType: 'system'`, `details: { retentionPolicy: true, purgeRemovedAfterDays }`.

**Tech Stack:** Hono, Drizzle, BullMQ, Vitest (API); React config-policy feature tab (web); shared zod validators.

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-05-device-removal-completion-design.md` (out-of-scope item now in scope) + the `configuration-policy` skill's Pattern B recipe. Precedents to mirror: `event_log` (resolution + retention job `jobs/eventLogRetention.ts`), `pam` (pure-JSONB inline feature, no normalized table — `configurationPolicy.ts` switch arms at ~800/908/1151/1216, `pamInlineSettingsSchema` in `packages/shared`, `PamTab.tsx`, `policyBaselineDefaults.ts`).

## Global Constraints

- **Rigor: high** (data deletion by a background job). TDD every task; one integration test proving the job purges only eligible devices in the right org and skips `UNINSTALL_PENDING`.
- **Fail closed:** no policy → never purge. Policy resolution error for an org → skip that org and log (mirror `eventLogRetention.ts:96-104`). `purgeRemovedAfterDays` validated 1..3650 in the shared validator; job re-clamps via `resolveRetentionDays`.
- **Migration** `apps/api/migrations/2026-10-11-160000-device-lifecycle-feature-and-decommissioned-at.sql` (must sort after `2026-10-11-150000-ai-partner-wide-select.sql`; verify with `ls apps/api/migrations | tail -1` and `scripts/check-migration-naming.sh` before committing). Contents, all idempotent: `ALTER TYPE "config_feature_type" ADD VALUE IF NOT EXISTS 'device_lifecycle';` then `ALTER TABLE devices ADD COLUMN IF NOT EXISTS decommissioned_at timestamptz;` then a backfill `UPDATE devices SET decommissioned_at = updated_at WHERE status = 'decommissioned' AND decommissioned_at IS NULL` wrapped in the `DO $$ ... GET DIAGNOSTICS ... RAISE WARNING 'backfilled % removed devices' ... $$` pattern, then `CREATE INDEX IF NOT EXISTS devices_decommissioned_at_idx ON devices (org_id, decommissioned_at) WHERE status = 'decommissioned';`. **The backfill UPDATE must be preceded by `SET LOCAL breeze.scope = 'system'` inside the DO block** (memory: backfills without breeze.scope are silent 0-row no-ops on managed Postgres; CI superuser masks it).
- **New column on an org-cascade table ⇒ export policy.** `devices` is in `CORE_ORG_CASCADE_DELETE_ORDER`; add `decommissioned_at` to its entry in `services/tenantExportPolicyRegistry.ts` as `included`. `tenant-export-policy.integration.test.ts` fails otherwise. No new table ⇒ no RLS/cascade registration.
- No `drizzle-kit generate`. Run `pnpm db:check-drift` after the schema edit.
- Config-policy registries that MUST all gain `device_lifecycle` (each has a parity test): `configFeatureTypeEnum` (schema), `ConfigFeatureType` (service), `CONFIG_FEATURE_TYPES` (`packages/shared/src/constants/configFeatureTypes.ts`), `addFeatureLinkSchema.featureType` (shared validators), `policyBaselineDefaults.ts` (NOT_ENFORCED entry: "Removed devices are kept until deleted manually"), `aiToolsConfigPolicy.ts` shape list, web `FEATURE_META` + `ConfigPolicyDetailPage` tab switch. Run `policyBaselineDefaults.test.ts` and web `featureTypeParity.test.ts`.
- Locale keys → all 8 locales; `localeParity` + `keyUsage`.
- Commit per task; never `pnpm --filter x test -- --run`; API tsc with `NODE_OPTIONS=--max-old-space-size=8192`.

---

### Task 1: Schema + migration + export policy — `devices.decommissioned_at`, enum value

**Files:** `apps/api/src/db/schema/devices.ts` (add `decommissionedAt: timestamp('decommissioned_at', { withTimezone: true })`), `apps/api/src/db/schema/configurationPolicies.ts` (enum), the migration above, `services/tenantExportPolicyRegistry.ts`, `apps/api/src/db/autoMigrate.test.ts` (must stay green).

- [ ] Write the failing tests first: (a) in `apps/api/src/services/tenantExportPolicyRegistry.test.ts` (or the closest unit-level registry test) assert `decommissioned_at` is classified for `devices`; (b) a migration-content test in `autoMigrate.test.ts` style asserting the new file contains `ADD VALUE IF NOT EXISTS 'device_lifecycle'`, `ADD COLUMN IF NOT EXISTS decommissioned_at`, `breeze.scope`, and `GET DIAGNOSTICS`. Run — red.
- [ ] Implement schema, migration, registry entry. `pnpm db:check-drift` clean. `scripts/check-migration-naming.sh` clean. Run tests — green. Commit `feat(db): devices.decommissioned_at + device_lifecycle config feature type (#2787)`.

### Task 2: Set / clear `decommissioned_at`

**Files:** `apps/api/src/routes/devices/core.ts` DELETE `/:id` (`.set({ status: 'decommissioned', decommissionedAt: new Date(), updatedAt })`), `apps/api/src/services/deviceLifecycle.ts` `restoreRemovedDevice` (`.set({ status: 'offline', decommissionedAt: null, updatedAt })`).
- [ ] Failing tests: `core.decommission.test.ts` asserts the update payload includes `decommissionedAt` (a Date); `deviceLifecycle.test.ts` asserts restore's set includes `decommissionedAt: null`. Red → implement → green. Commit `feat(api): stamp decommissioned_at on Remove, clear on Restore (#2787)`.

### Task 3: Shared validator + config-policy registries + resolution helper

**Files:** `packages/shared/src/validators/index.ts` (`deviceLifecycleInlineSettingsSchema = z.object({ purgeRemovedAfterDays: z.number().int().min(1).max(3650).nullable().optional() }).strict()`; add `'device_lifecycle'` to `addFeatureLinkSchema.featureType`), `packages/shared/src/constants/configFeatureTypes.ts`, `apps/api/src/services/configurationPolicy.ts` (`ConfigFeatureType` union + the three pure-JSONB switch arms + the service-level `parse` backstop next to `pam`'s), `apps/api/src/services/policyBaselineDefaults.ts`, `apps/api/src/services/aiToolsConfigPolicy.ts` (shape line: `- device_lifecycle: inlineSettings {purgeRemovedAfterDays: number|null} — permanently delete removed devices N days after removal (1..3650); null/absent = keep forever. Purge is irreversible.`), new `apps/api/src/services/deviceLifecyclePolicy.ts` exporting `getOrgPurgeRemovedAfterDays(orgId): Promise<number | null>` — copy `getOrgEventLogRetentionDays` but read `configPolicyFeatureLinks.inlineSettings->>'purgeRemovedAfterDays'` (no normalized table), same ownership + level precedence, return `null` when no row or the value is null.
- [ ] Failing tests: shared validator test (accepts 30, rejects 0 / 4000 / non-int / unknown key); `policyBaselineDefaults.test.ts` parity; `deviceLifecyclePolicy.test.ts` on compiled SQL (feature_type = 'device_lifecycle', active-only, ownership condition, org-beats-partner ordering, null when absent). Red → implement → green. Commit `feat(config-policy): device_lifecycle inline feature + org-level resolver (#2787)`.

### Task 4: Retention job `jobs/removedDevicePurge.ts`

**Files:** create `apps/api/src/jobs/removedDevicePurge.ts` + `.test.ts`; `apps/api/src/jobs/scheduleRegistry.ts` (add `'removed-device-purge'` at an unused minute, e.g. `'17 8 * * *'` — check collisions the way the file documents); `apps/api/src/services/workerRegistry.ts` (placement: run the closure-contract test and use what it demands; `deviceLifecycle` imports nothing from `agentWs`, so `global` is expected).

Shape (copy `eventLogRetention.ts` structure: lazy Queue/Worker, `attachWorkerObservability`, `recordRetentionRun`, `jobSchedule`, per-org loop under `runOutsideDbContext(() => withSystemDbAccessContext(...))`):
```ts
export const REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN = parsePositiveIntEnv(LOG_PREFIX, 'REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN', 200);
export async function runRemovedDevicePurgeOnce(now = new Date()): Promise<{ orgsChecked: number; orgsWithPolicy: number; purged: number; skippedUninstallPending: number; failed: number }>
```
Per org: `days = await getOrgPurgeRemovedAfterDays(orgId)`; if null → continue. Select up to MAX ids: `status='decommissioned' AND decommissioned_at IS NOT NULL AND decommissioned_at < now - days`. For each id: `db.transaction(tx => purgeRemovedDevice(tx, id))`; on `DeviceLifecycleError` code `UNINSTALL_PENDING`/`NOT_REMOVED`/`NOT_FOUND` → count skip, continue; on other error → log + captureException + count failed, continue (never abort the run). After each success: `createAuditLog({ orgId, actorType: 'system', actorId: 'removed-device-purge', action: 'device.permanent_delete', resourceType: 'device', resourceId, resourceName: hostname, details: { retentionPolicy: true, purgeRemovedAfterDays: days, decommissionedAt }, result: 'success' })`; invalidate the org device-count cache once per org that purged ≥1. `warnOnRetentionBacklog`-style log when the per-org cap was hit.
- [ ] Failing unit tests (mock db + `deviceLifecyclePolicy` + `deviceLifecycle` + `auditService`): no policy → no select, no purge; policy 30d → purges only ids returned; `UNINSTALL_PENDING` counted as skip and loop continues; unexpected error counted as failed and loop continues; audit row per purged device carries `retentionPolicy: true`; cap respected. Red → implement → green. Commit `feat(jobs): daily purge of removed devices past the org's device_lifecycle retention (#2787)`.

### Task 5: Integration test

**File:** `apps/api/src/__tests__/integration/removedDevicePurge.integration.test.ts` (fixtures as in `deviceLifecycle.integration.test.ts`; needs `pnpm test-stack up`).
- [ ] Cases: (1) org A has a partner-level policy `purgeRemovedAfterDays: 7`, org B under a different partner has none → a device removed 10 days ago in A is purged, a 3-day-old one in A survives, a 10-day-old one in B survives. (2) org-level policy `30` overrides the partner's `7` for that org. (3) a 10-day-old device with a pending `device_remove` uninstall is skipped and still exists. (4) the backfill statement from the migration, replayed against a row with `decommissioned_at NULL`, sets it. Run against the stack — green. Commit `test(api): removedDevicePurge integration — eligibility, precedence, uninstall-pending skip (#2787)`.

### Task 6: Web feature tab

**Files:** `apps/web/src/components/configurationPolicies/featureTabs/DeviceLifecycleTab.tsx` + `.test.tsx` (copy `PamTab.tsx`: `FeatureTabShell` + `useFeatureLink`; one number input "Permanently delete removed devices after" with a "days" suffix and an "Off (keep until deleted manually)" toggle that stores `null`; a destructive-tone note "Purge is irreversible and destroys history. Devices with an agent uninstall still queued are skipped until it completes."), `featureTabs/types.ts` (`FEATURE_META.device_lifecycle`), `ConfigPolicyDetailPage.tsx` (icon + `renderFeatureTab` case), locales (8).
- [ ] Failing tests: tab test (renders inherited value read-only when only `parentLink`; saving 30 calls `save` with `{ featureType: 'device_lifecycle', inlineSettings: { purgeRemovedAfterDays: 30 } }`; Off saves `null`; rejects 0 client-side); `featureTypeParity.test.ts` green. Red → implement → green. Commit `feat(web): Device lifecycle config-policy tab — purge removed devices after N days (#2787)`.

### Task 7: PR
- [ ] `git fetch && git merge origin/main`; run: API `src/routes/devices src/services/configurationPolicy* src/services/deviceLifecycle* src/services/policyBaselineDefaults.test.ts src/jobs/removedDevicePurge.test.ts src/db/autoMigrate.test.ts`, integration (`removedDevicePurge`, `deviceLifecycle`, `tenant-export-policy`), shared `packages/shared` validators, web `src/components/configurationPolicies src/lib/i18n`; tsc both; lint; `pnpm db:check-drift`; `pnpm test-stack down`.
- [ ] PR `feat: purge removed devices after N days — device_lifecycle config-policy feature + daily job (#2787 item 4)`. Body: design (why config-policy inline, why the new column, fail-closed rules), test counts, deviations. `Refs #2787 #5023`. Stop at the PR.
