---
tracking_issue: (set by feature-lifecycle after registration)
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05e Network Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Monitors the sole network-check authoring surface and provide behavior-preserving conversion: representable unmanaged rows are adopted through the W05c1 ledger once the required runtime capability is verified, the Network Monitor page becomes the **Network** page (Assets · Templates · Results) with no check authoring, and every other writer (REST, AI tool, device page) points at the monitor editor.

**Architecture:** Conversion *adopts* the existing `network_monitors` row rather than replacing it — the new definition's first compile stamps `managed_by_monitor_id` on the legacy row and updates it in place, so the row id, its `network_monitor_results` history, its asset binding, its TLS observation and the legacy check id in alert source context all survive (typed event `monitorId` is reserved for monitor-definition ids); only the alert rules are retired (`retired_at`) and the legacy worker's per-rule evaluation stops. The `network_check` condition is widened to carry everything the retired form could author (asset binding, per-type options, the `degraded` and `response_time_gt` verdicts, the legacy interval/timeout ranges) while refusing any legacy semantics that cannot be represented exactly, and the compiler emits the agent's own config key names (fixing the shipped `expectStatus`/`expectedStatus` mismatch). The `network_check` handler gains the legacy worker's *one alert device per check per org* rule, so a converted check attached to an org-wide policy raises one alert, on the same device it did before.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16, zod (`packages/shared`), BullMQ, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`), React + react-i18next (8 locales), Astro Starlight docs.

**Spec:** docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md (§Decisions C10, §End state "Navigation" and "Removed screens", §Non-goals "Network SNMP template authoring", §Conversion ledger, §Waves W05e row)

## Ordering assumptions (read first)

- **W05a–W05d have shipped.** This plan consumes, by exact name, W05c1's `apps/api/src/services/monitors/conversion/` module (`ConversionSourceTable` already lists `'network_monitors'`, `ConversionPreviewItem`, `PolicyConversionPreview`, `convertPartnerLegacy`, `revertConversion`, `retireSource`, the `monitor_conversions` / `monitor_conversion_outputs` tables with `role in ('primary','resource_cpu','resource_memory','response')`, and `GET /monitor-definitions/conversion/pending`). **Verify before Task 7:** `ls apps/api/src/services/monitors/conversion/ && grep -n "network_monitors" apps/api/src/services/monitors/conversion/*.ts`. Neither existed on `main @ b8dd148bd8` when this plan was written; use the exact producer paths in this plan; the W05c1 files are prerequisites, not existing baseline files.
- **W05c1 already widened `network_check.consecutiveFailures` to `1..100`** (brief: `service`/`process`/`network_check` max 20 → 100). Task 2 keeps that and widens two *other* ranges.
- **The spec's W05e row says "target = asset".** On `main` the `network_check` condition has no asset binding and `buildCompiledNetworkMonitor` (`apps/api/src/services/monitors/monitorCompiler.ts:219-245`) never writes `assetId`, so a compiled check today is always unbound (org-wide executor, org-level alert device). Task 2 adds `assetId` to the condition and the compiled row. This is a code fact the spec assumed was already true.
- **#6352 and #6353 must be merged before PR1**, in addition to W05d. Task 2 retains/verifies #6352's `expectedStatus` compiler fix; Task 3 retains/verifies #6353's extended scope: evaluate each managed check once per running org independently of its alert device's online status, using the legacy alert-device selection (linked asset device, preferred site, then most-recently-seen org device; offline devices eligible). #6353 also exports `export const NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION = true as const;` from `apps/api/src/services/alertConditions/handlers/networkCheck.ts`. Preserve its scheduler/evaluation path as well as the handler gate. Their local baseline is `monitorCompiler.ts:219-245`, `monitorCommands.ts:37-44`, `handlers_monitor.go:210`, and `monitorWorker.ts:294-345`.
- **All unmanaged `network_monitors` rows are org-owned.** Both legacy writers (`routes/monitors.ts:495-507`, `services/aiToolsMonitoring.ts` create) insert `orgId` only; a partner-wide row (`org_id NULL`) is always a compiled artefact (`routes/monitors.ts:80-92`). Conversion is therefore an **org-axis** operation: no partner-axis write, no `canManagePartnerWidePolicies` gate, and `monitor_conversions.org_id` is always set.
- **No "default policy" exists on config policies** (verified: no `is_default` column in `db/schema/configurationPolicies.ts`; onboarding at `modules/mcpInvites/tools/configureDefaults.ts:142` writes baseline `alert_rules`, not a policy). Task 7 mirrors `ruleConversionService.ts:130-140`: one generated policy **"Network checks — <org name>"** per org after the capability check passes, assigned at organization level, reused across conversion batches through the ledger.
- **D20 supersedes D14's offline refusal.** Verified on this checkout: `apps/api/src/jobs/alertWorker.ts:195-199` selects online devices; `apps/api/src/services/offlineAlertEffects.ts:14-18,31-44` handles only offline conditions; `handlers/networkCheck.ts` does not yet export the required capability. These baseline facts require the extended #6353 prerequisite above, not a per-check refusal. Task 7 mirrors C1 Task 9's capability pattern: an absent/false export blocks the entire network preview with `blockedBy: 'prerequisite_missing'`, empty items and no unconvertible entries; confirmation fails before writes and no network row is retire-swept. With the export present, representable checks are convertible. Task 9 proves that a failing check still raises exactly one monitor alert when the chosen alert device is offline, without mocking the capability.
- **Binding cross-wave contracts:** D2 ledger reads return `{ items: ConversionLedgerEntry[]; nextCursor: string | null }`, and `retireSource(...)` returns `{ conversionId }` including zero-output retirements. D3 requires `previewPartnerConversion(partnerId, auth)` then `convertPartnerLegacy(partnerId, previewHash, auth)`; network items participate in that full-scope hash only after the capability gate passes; missing prerequisites block partner conversion before any mutation. D4 `conversion/lifecycle.ts:isRevertAvailable` stays true for `network_monitors` while this wave retains its worker. D7 persists `null` for system actors. D8 preserves the fourth `DbExecutor` argument. D13/D15 use `movedAlertRefs` and shared `OPEN_ALERT_STATUSES`, preserving suppressed alerts and history on revert.
- **Three PRs, in order:** PR1 = Tasks 1–9 (API), PR2 = Tasks 10–12 (web), PR3 = Tasks 13–14 (tools, docs, verification). PR2 depends on PR1; PR3 depends on PR1 and PR2 being merged (they consume the 410s, the `managedByMonitorId` list field and the conversion routes). Do not stack them on each other's branches — a PR based on a sibling branch runs no CI (CLAUDE.md, tenancy section).

## Global Constraints

- **Migration filename `2026-10-24-110000-network-checks-as-monitors.sql`** (assigned by the common brief). Before pushing: `git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | grep -E '^apps/api/migrations/[0-9]{4}-[^/]+\.sql$' | sort | tail -1` plus `scripts/check-migration-naming.sh --against-ref origin/main` must sort **before** it (newest at planning time on `main`: `2026-10-21-110100-…`; W05b/c1/d use the assigned `2026-10-23-*` and `2026-10-24-100000-*` names). Rename with a later `HHMMSS` if anything newer landed. Never name it for today's real date.
- Migration is idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), has **no inner `BEGIN`/`COMMIT`**, and contains **no DML** — so no `set_config('breeze.scope','system',true)` is needed and none is added (`migrationRlsScope.test.ts` only requires the elevation before a write; if you add any `UPDATE`/`INSERT`/`DELETE`, put `SELECT set_config('breeze.scope', 'system', true);` first and report row counts with `GET DIAGNOSTICS … RAISE WARNING`).
- **No new tenant tables. New columns on registered tables:** `network_monitors.retired_at`/`retired_reason` must be classified `included` in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:401`) in the same PR; `monitor_conversions.network_source_snapshot` is `excludedOpen` (Task 6), and C1's `moved_alert_refs` stays `excludedOpen` — the export-policy row is the one registration that fires on a **column**. `network_monitor_alert_rules` has no `org_id` (it reaches its tenant through `network_monitors`, `rls-coverage.integration.test.ts:832`), so it needs no export-policy entry and no cascade entry. No `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_*` or `DUAL_AXIS_TENANT_TABLES` change; C1 already registers the common ledger tables.
- `partner-wide-write-coverage.test.ts` scans every file that mutates a dual-axis table. `network_monitors` is dual-axis, so the new conversion file needs an allowlist entry with a reason (Task 7 Step 3). `site-ceiling-write-coverage.test.ts` likewise; the conversion refuses site/exact-device-restricted callers outright in both preview and conversion services (Task 7), which is the reason recorded there.
- **Worker-created rows take the DEVICE's org; compiled rows take the DEFINITION's owner** (unchanged). Adoption only ever stamps `managed_by_monitor_id` on a row whose `org_id` equals the definition's `org_id` (Task 5).
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); catch pattern per CLAUDE.md. Every new i18n key needs **real translations in all 8 locales** (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`); the coverage test fails on a missing or English-echoed key. Removed components take their `longTail.*` blocks out of all 8 files.
- Hash for editor preselection and tab state: `/alerts/monitors/new#kind=network_check&assetId=<uuid>`. Merge these keys with W05a's `policy=<uuid>` rather than dropping the selected policy when tabs change. Query parameters remain only for API filters.
- Every task: **red test first**, then `cd apps/api && npx tsc --noEmit -p .` (or `pnpm --filter @breeze/api exec tsc --noEmit`), then the task's targeted tests, then commit. Use `cd apps/api && npx vitest run <path>`; never `pnpm --filter … test -- --run <path>`; never a trailing-slash path filter.
- `pnpm test` does **not** run the integration / export-policy suites. Tasks 1, 4, 6, 7 and 9 need `pnpm test-stack up` (private pg+redis for this worktree) and `pnpm test-stack down` afterwards — nothing reaps it for you.
- Do not commit from a subagent; the orchestrator commits. Each task's Step 5 gives the commit message the orchestrator uses.

## File Structure (what changes where)

| File | Change |
|---|---|
| `apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql` | **Create.** `retired_at`/`retired_reason` on `network_monitors` and `network_monitor_alert_rules`; partial pending index; asset owner FK/check; parent ledger source snapshot. |
| `apps/api/src/db/schema/monitors.ts` | Modify (lines 10-56, 80-88): retirement columns, composite asset/org FK and partner-asset CHECK. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Modify (line 401): classify `retired_at`, `retired_reason` as `included`; parent ledger `network_source_snapshot` as `excludedOpen`. |
| `packages/shared/src/validators/monitors.ts` | Modify (lines 173-189): widen `network_check` — `assetId`, per-type options, `degradedIsFailure`, `maxResponseMs`, legacy ranges; export `NetworkCheckMonitorCondition`. |
| `packages/shared/src/validators/monitors.test.ts` | Modify: new `network_check` cases. |
| `apps/api/src/services/monitors/kinds/networkCheck.ts` | Modify (whole file, 47 lines): condition type, `overridableKeys`, `toAlertCondition` carries the new verdict keys. |
| `apps/api/src/services/monitors/monitorCompiler.ts` | Modify (lines 213-245 `buildCompiledNetworkMonitor`; 286-312 `compileMonitorInTx`): agent config key names, `assetId`, adoption option. |
| `apps/api/src/services/monitors/monitorCompiler.w04.test.ts` | Modify (lines 175-236): config keys, `assetId`, adoption. |
| `apps/api/src/services/monitors/monitorService.ts` | Modify (lines 239-320): asset-owner validation on create/merged update; preserve four-argument executor-aware create and pass CompileOptions. |
| `apps/api/src/services/monitors/networkCheckAsset.ts`, `networkCheckAsset.test.ts`, `monitorService.test.ts` | Create guard/test; extend service regressions. |
| `apps/api/src/db/schema/discovery.ts` | Modify (143-215): unique asset `(id, org_id)` FK target. |
| `apps/api/src/db/schema/monitorConversions.ts` (W05c1) | Modify: `networkSourceSnapshot` nullable JSON, classified `excludedOpen`. |
| `apps/api/src/services/monitors/conversion/networkHistory.ts`, `networkHistory.test.ts` | Create: common-ledger retirement, source snapshots and `sourceState.name`, carry-over, reference-aware reversal. |
| `apps/api/src/services/monitors/conversion/convert.ts`, `convert.test.ts`, `loadSources.ts`, `lifecycle.ts` (W05c1) | Modify network cases, pending counts, full-scope preview/hash and lifecycle. |
| `apps/api/src/services/monitors/networkCheckAlertDevice.ts` | **Create.** `resolveNetworkCheckAlertDevice` — lifted from `jobs/monitorWorker.ts:294-345`. |
| `apps/api/src/services/monitors/networkCheckAlertDevice.test.ts` | **Create.** |
| `apps/api/src/jobs/monitorWorker.ts` | Modify (lines 294-345 delete local resolver; 393-411 rule query adds `retired_at IS NULL`; 415 uses shared resolver; 464-482 reserves event monitorId for definitions). |
| `apps/api/src/jobs/monitorWorker.test.ts` | Modify: schema mock gains `retiredAt`; resolver import. |
| `apps/api/src/services/alertConditions/types.ts` | Modify (lines 147-151): `NetworkCheckCondition` gains `degradedIsFailure?`, `maxResponseMs?`. |
| `apps/api/src/services/alertConditions/handlers/networkCheck.ts` | Modify: preserve #6353 capability and device-independent entry path; shared alert-device gate and extended failure predicate. |
| `apps/api/src/services/alertConditions/handlers/networkCheck.test.ts` | Modify: mock the resolver module; new cases. |
| `apps/api/src/services/monitors/conversion/networkChecks.ts` | **Create.** Exact mapper + capability-gated preview/convert/count; adoption ledger writes `sourceState.name`; re-export history services. |
| `apps/api/src/services/monitors/conversion/networkChecks.test.ts` | **Create.** Mapper, capability gate and service access tests. |
| `apps/api/src/services/monitors/conversion/index.ts` (W05c1) | Modify: Re-export `retireSource`/`revertConversion` with the `'network_monitors'` case; `previewPartnerConversion`/`convertPartnerLegacy` gate missing network prerequisites and retain all network items in the complete hash; pending count gains `networkChecks`. |
| `apps/api/src/routes/monitorDefinitions.conversion.ts` (W05c1) | Modify: `GET /conversion/network-checks`, `POST /conversion/network-checks/convert` next to W05c1's conversion routes. |
| `apps/api/src/routes/monitorDefinitions.conversion.networkChecks.test.ts` | **Create.** Route tests. |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | Modify (line ~71 block): allowlist entry for the conversion file. |
| `apps/api/src/__tests__/site-ceiling-write-coverage.test.ts` | Modify: allowlist entry for the conversion file. |
| `apps/api/src/routes/monitors.ts` | Modify: `POST /` (461-522), `PATCH /:id` (639-707), `POST /alerts` (870-905), `PATCH /alerts/:id` (925-957), `DELETE /alerts/:id` (959-986), unmanaged `DELETE /:id` (713-744) → 410; delete dead zod schemas (261-343); list projection (430-456) adds `managedByMonitorId`, `retiredAt`, `includeRetired` query. |
| `apps/api/src/routes/monitors_list_create.test.ts`, `monitors_alerts.test.ts`, `monitors_detail.test.ts` | Modify: write paths assert 410. |
| `apps/api/src/routes/discovery.ts` | Modify (`DELETE /assets/:id`, lines 1699-1750): 409 for any bound retained check, managed or unmanaged. |
| `apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts` | **Create.** Real-Postgres/Redis proof: offline alert device → exactly one monitor alert, cross-org asset FK, shared open-status carry-over, retirement → named ledger → revert. |
| `apps/web/src/components/layout/Sidebar.tsx` | Modify (line 275): `name: 'Network'`. |
| `apps/web/src/components/layout/Sidebar.nav.test.tsx` | Modify (lines 86, 179-185, 334). |
| `apps/web/src/locales/*/common.json` | Modify: `nav.networkMonitor` value; `longTail.monitoring.MonitoringPage.*`; `longTail.monitors.NetworkMonitorList.*` (+conversion banner keys); remove `longTail.monitors.CreateMonitorForm`; trim `longTail.monitors.MonitorDetailModal`. |
| `apps/web/src/locales/*/pages.json` | Modify: `titles.monitoring` → "Network". |
| `apps/web/src/locales/*/monitoring.json` | Modify: `fields.*` for the new `network_check` keys; `editor.networkCheckAsset.*`. |
| `apps/web/src/locales/*/devices.json` | Modify: remove `networkDeviceDetailPage.settings.toasts.checkCreated`/`checkCreateFailed`; add `networkDeviceDetailPage.settings.monitoring.addCheckHint`. |
| `apps/web/src/components/monitoring/MonitoringPage.tsx` | Modify: tabs `assets · templates · results` (hash `checks` → `results`), New check button. |
| `apps/web/src/components/monitoring/MonitoringPage.test.tsx` | Modify. |
| `apps/web/src/components/monitors/NetworkMonitorList.tsx` | Modify: read-only results list; monitor link; conversion banner; no create. |
| `apps/web/src/components/monitors/NetworkMonitorList.test.tsx` | **Create.** |
| `apps/web/src/components/monitors/NetworkCheckConversionBanner.tsx` | **Create.** Preview → confirm → convert or per-check Retire; shared persistent ledger/Undo. |
| `apps/web/src/components/monitors/NetworkCheckConversionBanner.test.tsx` | **Create.** |
| `apps/web/src/components/monitors/MonitorDetailModal.tsx` | Modify (PR2 Task 11): remove edit form and alert-rules section; managed link / not-converted note. |
| `apps/web/src/components/monitors/MonitorDetailModal.test.tsx` | Modify (PR2 Task 11): rewrite PATCH tests and move `open()` wait to the new link/note. |
| `apps/web/src/components/monitors/CreateMonitorForm.tsx` | **Delete.** |
| `apps/web/src/components/devices/networkDevice/settings/MonitoringSection.tsx` | Modify (lines 5, 67, 337-340): Add check → navigate to the editor. |
| `apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.ts` | Modify (lines 171-179): remove `createCheck`. |
| `apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts` | Modify. |
| `apps/web/src/components/monitoring/monitorKindFields.ts` | Modify (lines 196-234, 296): new fields, ranges. |
| `apps/web/src/components/monitoring/monitorKindFields.test.ts` | Modify. |
| `apps/web/src/components/monitoring/MonitorEditor.tsx` | Modify: `#kind`/`assetId` prefill; `NetworkCheckAssetBinding` picker. |
| `apps/web/src/components/monitoring/NetworkCheckAssetBinding.tsx`, `apps/web/src/components/monitoring/NetworkCheckAssetBinding.test.tsx` | **Create.** Picker, read error/retry and API-only option round-trip. |
| `apps/web/src/components/monitoring/MonitorEditor.test.tsx` | Modify. |
| `apps/api/src/services/aiToolsMonitoring.ts` | Modify (lines 197-228 description/schema; 305-366 create/update → refusal; `query_monitors` projection). |
| `apps/api/src/services/aiToolsMonitoring.test.ts` | Modify (lines 350-420). |
| `apps/api/src/services/aiToolsMonitors.ts` | Modify (line ~375 description): mention `network_check` and `assetId`. |
| `apps/docs/src/content/docs/features/network-monitors.mdx` | Modify (rewrite; retitle "Network Checks"). |
| `apps/docs/src/content/docs/features/monitors.mdx` | Modify (kinds table, network_check section). |
| `docs/release-notes/next-release-draft.md`, `CHANGELOG.md` | Modify. |

---

### Task 1: Migration, schema and export-policy registration (PR1)

**Files:**
- Create: `apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql`
- Modify: `apps/api/src/db/schema/monitors.ts` (lines 10-56, 80-88)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (line 401)
- Test: `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts` (existing), `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts` (existing, live DB)

**Interfaces:**
- Consumes: nothing new.
- Produces: `network_monitors.retired_at timestamptz null`, `network_monitors.retired_reason text null`, `network_monitor_alert_rules.retired_at timestamptz null`, `network_monitor_alert_rules.retired_reason text null`; Drizzle columns `networkMonitors.retiredAt/retiredReason`, `networkMonitorAlertRules.retiredAt/retiredReason`; index `network_monitors_unmanaged_pending_idx`.

- [ ] **Step 1: Write the failing test.** The export-policy contract is the real red here: once the live DB has the columns and the registry does not, `tenant-export-policy.integration.test.ts` names them. Create the migration first (Step 3), apply it with the test stack, run the suite, and expect the failure text in Step 2. Also pin the Drizzle shape in a unit test so the red does not depend on a live DB — append to `apps/api/src/services/monitors/monitorCompiler.w04.test.ts`:
  ```ts
  import { networkMonitorAlertRules, networkMonitors } from '../../db/schema/monitors';

  describe('W05e retirement columns', () => {
    it('network_monitors and network_monitor_alert_rules carry retired_at / retired_reason', () => {
      expect(networkMonitors.retiredAt.name).toBe('retired_at');
      expect(networkMonitors.retiredReason.name).toBe('retired_reason');
      expect(networkMonitorAlertRules.retiredAt.name).toBe('retired_at');
      expect(networkMonitorAlertRules.retiredReason.name).toBe('retired_reason');
    });
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.**
  ```bash
  cd apps/api && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts
  # expect: TypeError: Cannot read properties of undefined (reading 'name')  — retiredAt is not on the table yet
  ```
- [ ] **Step 3: Implement.** Migration:
  ```sql
  -- Alerting consolidation W05e — network checks become monitors.
  -- Converted checks are ADOPTED (managed_by_monitor_id stamped on the existing
  -- row, history kept); explicitly retired checks and every legacy alert rule
  -- of a converted check are retained in place. No DML in this file.

  -- 1. Retirement columns on network_monitors (explicit source retirement).
  ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS retired_at timestamptz;
  ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS retired_reason text;

  -- 2. Retirement columns on network_monitor_alert_rules. The legacy worker's
  --    rule evaluation adds `retired_at IS NULL`, so a converted check can
  --    never be evaluated by both the worker and the monitor sweep.
  ALTER TABLE network_monitor_alert_rules ADD COLUMN IF NOT EXISTS retired_at timestamptz;
  ALTER TABLE network_monitor_alert_rules ADD COLUMN IF NOT EXISTS retired_reason text;

  -- 3. "Needs conversion" count and the partner-level sweep read unmanaged,
  --    unretired rows per org.
  CREATE INDEX IF NOT EXISTS network_monitors_unmanaged_pending_idx
    ON network_monitors (org_id)
    WHERE managed_by_monitor_id IS NULL AND retired_at IS NULL;
  ```
  Schema (`monitors.ts`) — inside `networkMonitors` after `tlsState`:
  ```ts
    // W05e — set on explicitly retired checks (including representable checks
    // an operator elects to retire); `retired_reason = 'unconvertible:<code>' | 'operator'`. A converted
    // check is adopted through managed_by_monitor_id instead and stays live.
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredReason: text('retired_reason'),
  ```
  and inside `networkMonitorAlertRules` after `isActive`:
  ```ts
    // W05e — stamped 'converted' on every rule of an adopted check; the worker
    // filters `retired_at IS NULL`. Revert clears it.
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredReason: text('retired_reason'),
  ```
  Registry (`tenantExportPolicyRegistry.ts:401`) — append `"retired_at","retired_reason"` to the `included` array of the `network_monitors` entry (they are scalars; `config` stays `excludedOpen`).
- [ ] **Step 4: Run, expect PASS.**
  ```bash
  cd apps/api && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
  pnpm test-stack up
  cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
  pnpm db:check-drift
  ```
  (Run the export-policy suite once **before** editing the registry to see it name `network_monitors.retired_at` — that is the red for the registration.)
- [ ] **Step 5: Commit.** `git add apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql apps/api/src/db/schema/monitors.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/monitors/monitorCompiler.w04.test.ts && git commit -m "feat(monitors): W05e retirement columns on network checks and their alert rules"`

---

### Task 2: Widen the `network_check` condition; compiler emits agent config keys and the asset binding (PR1)

**Files:**
- Modify: `packages/shared/src/validators/monitors.ts` (lines 173-189)
- Modify: `packages/shared/src/validators/monitors.test.ts`
- Modify: `apps/api/src/services/monitors/kinds/networkCheck.ts` (whole file)
- Modify: `apps/api/src/services/monitors/monitorCompiler.ts` (lines 213-245)
- Modify: `apps/api/src/services/monitors/monitorCompiler.w04.test.ts` (lines 175-236)
- Modify: `apps/web/src/components/monitoring/monitorKindFields.ts` (lines 196-234, 296) + `monitorKindFields.test.ts`
- Modify: `apps/web/src/locales/*/monitoring.json` (`fields.*`)

**Interfaces:**
- Consumes: `monitor_type` enum labels; agent payload keys from `agent/internal/heartbeat/handlers_monitor.go` (`expectedStatus`, `method`, `expectedBody`, `headers`, `followRedirects`, `verifySsl`, `count`, `packetSize`, `expectBanner`, `recordType`, `expectedValue`, `nameserver`, `url`, `hostname`).
- Produces (shared):
  ```ts
  export type NetworkCheckMonitorCondition = z.infer<typeof monitorConditionSchemas.network_check>;
  // { checkType, target, assetId?, port?, expectStatus?, count?, packetSize?, expectBanner?,
  //   method?, expectedBody?, headers?, followRedirects?, verifySsl?, recordType?, expectedValue?,
  //   nameserver?, degradedIsFailure (default false), maxResponseMs?, pollingIntervalSeconds (10..86400),
  //   timeoutSeconds (1..300), consecutiveFailures (1..100) }
  export const NETWORK_CHECK_OPTION_KEYS: Record<NetworkCheckType, readonly string[]>;
  ```
- Produces (compiler): `buildCompiledNetworkMonitorConfig(c: NetworkCheckMonitorCondition): Record<string, unknown>` (pure), `buildCompiledNetworkMonitor` now returns `assetId`.

- [ ] **Step 1: Write the failing tests.**
  `packages/shared/src/validators/monitors.test.ts` (append):
  ```ts
  describe('network_check condition (W05e widening)', () => {
    const s = monitorConditionSchemas.network_check;
    it('accepts an asset binding, per-type options and the legacy verdicts', () => {
      const r = s.safeParse({
        checkType: 'http_check', target: 'https://example.com', assetId: '11111111-1111-4111-8111-111111111111',
        expectStatus: 204, method: 'HEAD', verifySsl: false, followRedirects: true,
        degradedIsFailure: true, maxResponseMs: 800, pollingIntervalSeconds: 10, timeoutSeconds: 300, consecutiveFailures: 1,
      });
      expect(r.success).toBe(true);
    });
    it('rejects an option that belongs to a different check type', () => {
      const r = s.safeParse({ checkType: 'icmp_ping', target: '10.0.0.1', expectBanner: 'SSH' });
      expect(r.success).toBe(false);
      expect(r.success ? '' : r.error.issues[0]?.path.join('.')).toBe('expectBanner');
    });
    it('keeps the legacy interval and timeout ranges (routes/monitors.ts createMonitorSchema)', () => {
      expect(s.safeParse({ checkType: 'icmp_ping', target: '10.0.0.1', pollingIntervalSeconds: 86400, timeoutSeconds: 300 }).success).toBe(true);
      expect(s.safeParse({ checkType: 'icmp_ping', target: '10.0.0.1', pollingIntervalSeconds: 9 }).success).toBe(false);
    });
    it('defaults degradedIsFailure to false', () => {
      const r = s.parse({ checkType: 'icmp_ping', target: '10.0.0.1' });
      expect(r.degradedIsFailure).toBe(false);
    });
  });
  ```
  `monitorCompiler.w04.test.ts` — replace the existing `toEqual` in "inherits the definition's ownership axes…" (lines 181-196) with:
  ```ts
  it('emits the AGENT config key names, the asset binding and the http url', () => {
    const row = buildCompiledNetworkMonitor(makeDef({
      condition: {
        checkType: 'http_check', target: 'https://example.com', assetId: 'a0000000-0000-4000-8000-0000000000aa',
        expectStatus: 204, method: 'HEAD', expectedBody: 'ok', verifySsl: false, followRedirects: true,
        pollingIntervalSeconds: 120, timeoutSeconds: 5, consecutiveFailures: 3, degradedIsFailure: false,
      },
    }));
    expect(row).toEqual({
      orgId: 'o0000000-0000-4000-8000-000000000001', partnerId: null,
      name: '[monitor] Gateway reachable', monitorType: 'http_check', target: 'https://example.com',
      assetId: 'a0000000-0000-4000-8000-0000000000aa',
      // `expectedStatus` — the key handlers_monitor.go:210 reads. `expectStatus` was silently ignored before W05e.
      config: { url: 'https://example.com', method: 'HEAD', expectedStatus: 204, expectedBody: 'ok', followRedirects: true, verifySsl: false },
      pollingInterval: 120, timeout: 5, isActive: true, managedByMonitorId: 'd0000000-0000-4000-8000-000000000001',
    });
  });
  it('tcp_port emits port + expectBanner; icmp emits count + packetSize; dns emits hostname + recordType', () => {
    expect(buildCompiledNetworkMonitor(makeDef({ condition: { checkType: 'tcp_port', target: '10.0.0.1', port: 22, expectBanner: 'SSH', pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2, degradedIsFailure: false } })).config).toEqual({ port: 22, expectBanner: 'SSH' });
    expect(buildCompiledNetworkMonitor(makeDef({ condition: { checkType: 'icmp_ping', target: '10.0.0.1', count: 4, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2, degradedIsFailure: false } })).config).toEqual({ count: 4 });
    expect(buildCompiledNetworkMonitor(makeDef({ condition: { checkType: 'dns_check', target: 'example.com', recordType: 'MX', pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2, degradedIsFailure: false } })).config).toEqual({ hostname: 'example.com', recordType: 'MX' });
  });
  ```
  `apps/api/src/services/monitors/kinds/index.test.ts` — no change needed (its `network_check` sample stays valid).
- [ ] **Step 2: Run them, expect FAIL.**
  ```bash
  cd packages/shared && npx vitest run src/validators/monitors.test.ts    # expect: Unrecognized key(s) in object: 'assetId', 'method', …  (strict schema)
  cd ../../apps/api && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts   # expect: expected { config: { expectStatus: 204 } } to equal { config: { url: …, expectedStatus: 204 … } }
  ```
- [ ] **Step 3: Implement.**
  `packages/shared/src/validators/monitors.ts` — replace the `network_check` entry (lines 173-189):
  ```ts
  network_check: z
    .object({
      // These labels ARE the existing `monitor_type` pgEnum values, so the
      // compiler adapter never maps a vocabulary.
      checkType: z.enum(['icmp_ping', 'tcp_port', 'http_check', 'dns_check']),
      target: z.string().min(1).max(500),
      // W05e — binding to a discovered asset. Pins the probe to the asset's
      // site (services/networkExecutorSelection.ts) and names the ONE device
      // the alert attaches to (services/monitors/networkCheckAlertDevice.ts).
      // Not overridable: a policy override that could re-bind the probe would
      // aim one tenant's agent at another's asset.
      assetId: z.string().uuid().optional(),
      port: z.number().int().min(1).max(65535).optional(), // tcp_port
      expectStatus: z.number().int().min(100).max(599).optional(), // http_check → config.expectedStatus
      // W05e — the legacy per-type options (routes/monitors.ts icmp/tcp/http/dns
      // config schemas), so the Monitors editor can author everything the
      // retired Network page form could. Gated on checkType by the superRefine.
      count: z.number().int().min(1).max(20).optional(), // icmp_ping
      packetSize: z.number().int().min(16).max(65535).optional(), // icmp_ping
      expectBanner: z.string().max(500).optional(), // tcp_port
      method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS']).optional(), // http_check
      expectedBody: z.string().max(2000).optional(), // http_check
      headers: z.record(z.string(), z.string()).optional(), // http_check (API only; not editor-authored)
      followRedirects: z.boolean().optional(), // http_check
      verifySsl: z.boolean().optional(), // http_check
      recordType: z.enum(['A', 'AAAA', 'MX', 'CNAME', 'TXT', 'NS']).optional(), // dns_check
      expectedValue: z.string().max(500).optional(), // dns_check
      nameserver: z.string().max(255).optional(), // dns_check
      // W05e — the legacy `degraded` and `response_time_gt` alert rules map here.
      degradedIsFailure: z.boolean().default(false),
      maxResponseMs: z.number().int().min(1).max(600000).optional(),
      // Ranges match the legacy createMonitorSchema (routes/monitors.ts) so no
      // shipped check is unconvertible on range.
      pollingIntervalSeconds: z.number().int().min(10).max(86400).default(60),
      timeoutSeconds: z.number().int().min(1).max(300).default(5),
      consecutiveFailures: z.number().int().min(1).max(100).default(2),
    })
    .strict()
    .refine((v) => v.checkType !== 'tcp_port' || v.port != null, {
      message: 'port required for tcp_port',
      path: ['port'],
    })
    .superRefine((v, ctx) => {
      const allowed = new Set<string>(NETWORK_CHECK_OPTION_KEYS[v.checkType]);
      for (const key of NETWORK_CHECK_ALL_OPTION_KEYS) {
        if ((v as Record<string, unknown>)[key] !== undefined && !allowed.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is not an option of ${v.checkType}` });
        }
      }
    }),
  ```
  and above `monitorConditionSchemas`:
  ```ts
  export type NetworkCheckType = 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  /** Per-type option keys the compiler forwards to the agent under its own names. */
  export const NETWORK_CHECK_OPTION_KEYS: Record<NetworkCheckType, readonly string[]> = {
    icmp_ping: ['count', 'packetSize'],
    tcp_port: ['port', 'expectBanner'],
    http_check: ['expectStatus', 'method', 'expectedBody', 'headers', 'followRedirects', 'verifySsl'],
    dns_check: ['recordType', 'expectedValue', 'nameserver'],
  };
  const NETWORK_CHECK_ALL_OPTION_KEYS = [...new Set(Object.values(NETWORK_CHECK_OPTION_KEYS).flat())];
  ```
  and after `MonitorConditionSchemas`: `export type NetworkCheckMonitorCondition = z.infer<typeof monitorConditionSchemas.network_check>;`. Export both from the package index if `validators/monitors.ts` is re-exported selectively (check `packages/shared/src/index.ts`).

  `kinds/networkCheck.ts` — replace the local `C` type with `NetworkCheckMonitorCondition` from `@breeze/shared`, set `overridableKeys: ['pollingIntervalSeconds', 'consecutiveFailures', 'degradedIsFailure', 'maxResponseMs']`, and:
  ```ts
  toAlertCondition: (c, ctx) => ({
    type: 'network_check',
    monitorId: ctx.monitorId,
    consecutiveFailures: c.consecutiveFailures,
    degradedIsFailure: c.degradedIsFailure,
    ...(c.maxResponseMs != null ? { maxResponseMs: c.maxResponseMs } : {}),
  }),
  ```
  `monitorCompiler.ts` — replace `buildCompiledNetworkMonitor` (lines 219-245):
  ```ts
  function omitUndefined(o: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  }

  /**
   * The managed row's `config`, keyed the way the AGENT reads it
   * (agent/internal/heartbeat/handlers_monitor.go) — `buildMonitorCommand`
   * spreads it into the payload verbatim. Before W05e the compiler wrote
   * `expectStatus`, which the agent never read (it reads `expectedStatus`).
   */
  export function buildCompiledNetworkMonitorConfig(c: NetworkCheckMonitorCondition): Record<string, unknown> {
    switch (c.checkType) {
      case 'icmp_ping':
        return omitUndefined({ count: c.count, packetSize: c.packetSize });
      case 'tcp_port':
        return omitUndefined({ port: c.port, expectBanner: c.expectBanner });
      case 'http_check':
        return omitUndefined({
          url: c.target, method: c.method, expectedStatus: c.expectStatus, expectedBody: c.expectedBody,
          headers: c.headers, followRedirects: c.followRedirects, verifySsl: c.verifySsl,
        });
      case 'dns_check':
        return omitUndefined({ hostname: c.target, recordType: c.recordType, expectedValue: c.expectedValue, nameserver: c.nameserver });
    }
  }

  export function buildCompiledNetworkMonitor(def: MonitorDefinitionRow): typeof networkMonitors.$inferInsert {
    const spec = getMonitorKindSpec(def.kind);
    const c = spec.conditionSchema.parse(def.condition) as NetworkCheckMonitorCondition;
    return {
      orgId: def.orgId,
      partnerId: def.partnerId,
      name: `[monitor] ${def.name}`,
      monitorType: c.checkType,
      target: c.target,
      assetId: c.assetId ?? null,
      config: buildCompiledNetworkMonitorConfig(c),
      pollingInterval: c.pollingIntervalSeconds,
      timeout: c.timeoutSeconds,
      isActive: def.enabled,
      managedByMonitorId: def.id,
    };
  }
  ```
  (`verifyCompiled` at 404-420 compares every key of this object, so `assetId` and the new config keys are covered without a change there.)

  `monitorKindFields.ts` — in `network_check` (lines 196-234): change `pollingIntervalSeconds` to `min: 10, max: 86400`, `timeoutSeconds` to `max: 300`, `consecutiveFailures` to `max: 100`, and insert after `expectStatus`:
  ```ts
  { key: 'count', labelKey: 'monitoring:fields.pingCount', kind: 'number', min: 1, max: 20, optional: true, showWhen: { key: 'checkType', equals: 'icmp_ping' } },
  { key: 'expectBanner', labelKey: 'monitoring:fields.expectBanner', kind: 'text', optional: true, showWhen: { key: 'checkType', equals: 'tcp_port' } },
  { key: 'method', labelKey: 'monitoring:fields.httpMethod', kind: 'select', options: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'], optional: true, showWhen: { key: 'checkType', equals: 'http_check' } },
  { key: 'expectedBody', labelKey: 'monitoring:fields.expectedBody', kind: 'text', optional: true, showWhen: { key: 'checkType', equals: 'http_check' } },
  { key: 'followRedirects', labelKey: 'monitoring:fields.followRedirects', kind: 'boolean', optional: true, showWhen: { key: 'checkType', equals: 'http_check' } },
  { key: 'verifySsl', labelKey: 'monitoring:fields.verifySsl', kind: 'boolean', optional: true, showWhen: { key: 'checkType', equals: 'http_check' } },
  { key: 'recordType', labelKey: 'monitoring:fields.recordType', kind: 'select', options: ['A', 'AAAA', 'MX', 'CNAME', 'TXT', 'NS'], optional: true, showWhen: { key: 'checkType', equals: 'dns_check' } },
  { key: 'expectedValue', labelKey: 'monitoring:fields.expectedValue', kind: 'text', optional: true, showWhen: { key: 'checkType', equals: 'dns_check' } },
  { key: 'nameserver', labelKey: 'monitoring:fields.nameserver', kind: 'text', optional: true, showWhen: { key: 'checkType', equals: 'dns_check' } },
  { key: 'degradedIsFailure', labelKey: 'monitoring:fields.degradedIsFailure', kind: 'boolean' },
  { key: 'maxResponseMs', labelKey: 'monitoring:fields.maxResponseMs', kind: 'number', min: 1, max: 600000, optional: true },
  ```
  (`packetSize` and `headers` are API-only this wave and must survive editor saves unchanged; Task 12 pins that round-trip.) `defaultConditionFor('network_check')` (line 296) gains `degradedIsFailure: false`. If `showWhen` does not support `optional` select fields, follow how `antivirus`/`backup_continuity` fields (lines ~150-190) declare optional selects.

  `monitoring.json` `fields` — add in **all 8 locales** (en values; translate the rest, do not echo English):
  `pingCount` "Echo requests", `expectBanner` "Expected banner", `httpMethod` "HTTP method", `expectedBody` "Response must contain", `followRedirects` "Follow redirects", `verifySsl` "Verify TLS certificate", `recordType` "Record type", `expectedValue` "Expected value", `nameserver` "Nameserver", `degradedIsFailure` "Treat degraded as failure", `maxResponseMs` "Fail when slower than (ms)".
  de-DE: "Echo-Anfragen", "Erwartetes Banner", "HTTP-Methode", "Antwort muss enthalten", "Weiterleitungen folgen", "TLS-Zertifikat prüfen", "Eintragstyp", "Erwarteter Wert", "Nameserver", "Beeinträchtigt als Ausfall werten", "Fehler bei Antwort langsamer als (ms)".
  es-419: "Solicitudes de eco", "Banner esperado", "Método HTTP", "La respuesta debe contener", "Seguir redirecciones", "Verificar certificado TLS", "Tipo de registro", "Valor esperado", "Servidor DNS", "Tratar degradado como falla", "Fallar si tarda más de (ms)".
  fr-CA / fr-FR: "Requêtes d'écho", "Bannière attendue", "Méthode HTTP", "La réponse doit contenir", "Suivre les redirections", "Vérifier le certificat TLS", "Type d'enregistrement", "Valeur attendue", "Serveur de noms", "Considérer « dégradé » comme un échec", "Échec au-delà de (ms)".
  it-IT: "Richieste echo", "Banner atteso", "Metodo HTTP", "La risposta deve contenere", "Segui i reindirizzamenti", "Verifica certificato TLS", "Tipo di record", "Valore atteso", "Nameserver", "Considera degradato come errore", "Fallisci se più lento di (ms)".
  pt-BR: "Solicitações de eco", "Banner esperado", "Método HTTP", "A resposta deve conter", "Seguir redirecionamentos", "Verificar certificado TLS", "Tipo de registro", "Valor esperado", "Servidor de nomes", "Tratar degradado como falha", "Falhar se mais lento que (ms)".
  tr-TR: "Yankı istekleri", "Beklenen banner", "HTTP yöntemi", "Yanıt şunu içermeli", "Yönlendirmeleri izle", "TLS sertifikasını doğrula", "Kayıt türü", "Beklenen değer", "Ad sunucusu", "Bozulmuşu hata say", "Şundan yavaşsa başarısız (ms)".
- [ ] **Step 4: Run, expect PASS.**
  ```bash
  cd packages/shared && npx vitest run src/validators/monitors.test.ts
  cd ../../apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts src/services/monitors/kinds/index.test.ts
  cd ../web && npx vitest run src/components/monitoring/monitorKindFields.test.ts src/lib/__tests__/i18n
  ```
- [ ] **Step 5: Commit.** `git add packages/shared/src/validators/monitors.ts packages/shared/src/validators/monitors.test.ts apps/api/src/services/monitors/kinds/networkCheck.ts apps/api/src/services/monitors/monitorCompiler.ts apps/api/src/services/monitors/monitorCompiler.w04.test.ts apps/web/src/components/monitoring/monitorKindFields.ts apps/web/src/components/monitoring/monitorKindFields.test.ts apps/web/src/locales && git commit -m "feat(monitors): network_check carries the asset binding and every legacy option; compiler emits the agent's config keys"`

---

### Task 3: Preserve device-independent evaluation — shared alert-device resolver, handler gate, legacy verdicts (PR1)

**Files:**
- Create: `apps/api/src/services/monitors/networkCheckAlertDevice.ts`, `networkCheckAlertDevice.test.ts`
- Modify: `apps/api/src/jobs/monitorWorker.ts` (lines 294-345 delete; 393-411; 415), `monitorWorker.test.ts`
- Modify: `apps/api/src/services/alertConditions/types.ts` (lines 147-151)
- Modify: `apps/api/src/services/alertConditions/handlers/networkCheck.ts` (whole file), `networkCheck.test.ts`

**Interfaces:**
- Produces: `export async function resolveNetworkCheckAlertDevice(check: { orgId: string; assetId: string | null }): Promise<string | null>` — body lifted verbatim from `monitorWorker.ts:306-345`.
- Produces: `NetworkCheckCondition { type: 'network_check'; monitorId: string; consecutiveFailures?: number; degradedIsFailure?: boolean; maxResponseMs?: number }`.
- Consumes: `networkMonitorResults.responseMs`, `networkMonitors.assetId`; #6353's device-independent scheduler/evaluation path and `NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION = true as const` capability. The handler gate alone does not provide offline coverage; do not replace that prerequisite path with the online-device sweep.

- [ ] **Step 1: Write the failing tests.**
  `networkCheck.test.ts` — add at top a module mock and new cases (keep the existing `setReads` order: managed, device, results; the managed row now carries `assetId`):
  ```ts
  const { alertDeviceMock } = vi.hoisted(() => ({ alertDeviceMock: vi.fn(async () => 'device-1') }));
  vi.mock('../../monitors/networkCheckAlertDevice', () => ({ resolveNetworkCheckAlertDevice: alertDeviceMock }));
  // in the schema mock: networkMonitors gains assetId: 'networkMonitors.assetId';
  // networkMonitorResults gains responseMs: 'networkMonitorResults.responseMs'.

  beforeEach(() => { vi.clearAllMocks(); mockDb.select.mockReset(); alertDeviceMock.mockResolvedValue('device-1'); });
  describe('one alert device per check per org (W05e)', () => {
    it('breaches on the alert device', async () => {
      alertDeviceMock.mockResolvedValueOnce('device-1');
      setReads([{ id: 'managed-1', assetId: 'a0000000-0000-4000-8000-000000000001' }], offline(2));
      const r = await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 }, DEVICE_ID);
      expect(r.passed).toBe(true);
      expect(alertDeviceMock).toHaveBeenCalledWith({ orgId: 'org-a', assetId: 'a0000000-0000-4000-8000-000000000001' });
    });
    it('never breaches on any other device in the policy scope, even with an offline streak', async () => {
      alertDeviceMock.mockResolvedValueOnce('device-other');
      setReads([{ id: 'managed-1', assetId: null }], offline(5));
      const r = await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 }, DEVICE_ID);
      expect(r.passed).toBe(false);
      expect(r.description).toMatch(/not the alert device/i);
    });
  });

  describe('legacy verdicts (W05e)', () => {
    it('counts degraded as a failure only when degradedIsFailure is set', async () => {
      const degraded = [{ status: 'degraded', responseMs: 10 }, { status: 'degraded', responseMs: 10 }];
      setReads([{ id: 'managed-1', assetId: null }], degraded);
      expect((await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 }, DEVICE_ID)).passed).toBe(false);
      setReads([{ id: 'managed-1', assetId: null }], degraded);
      expect((await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2, degradedIsFailure: true }, DEVICE_ID)).passed).toBe(true);
    });
    it('counts a slow online result as a failure when maxResponseMs is set', async () => {
      setReads([{ id: 'managed-1', assetId: null }], [{ status: 'online', responseMs: 900 }]);
      expect((await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 1, maxResponseMs: 500 }, DEVICE_ID)).passed).toBe(true);
    });
  });
  ```
  (Existing cases keep passing because `alertDeviceMock` defaults to `'device-1'` = `DEVICE_ID`; update `offline(n)` rows to include `responseMs: null`.)
  `networkCheckAlertDevice.test.ts` — Drizzle-mock cases (linked asset → linked device, even offline; unlinked asset with site → the site device query is used, even offline; no asset → most-recently-seen org device, even offline; empty preferred site → org fallback; no org devices → null), following the `mockDb.select` chaining style of `networkCheck.test.ts`.
- [ ] **Step 2: Run them, expect FAIL.**
  ```bash
  cd apps/api && npx vitest run src/services/alertConditions/handlers/networkCheck.test.ts src/services/monitors/networkCheckAlertDevice.test.ts
  # expect: Failed to resolve import "../../monitors/networkCheckAlertDevice"; and `expected true to be false` on the other-device case
  ```
- [ ] **Step 3: Implement.**
  `networkCheckAlertDevice.ts`:
  ```ts
  import { and, desc, eq } from 'drizzle-orm';
  import { db } from '../../db';
  import { devices, discoveredAssets } from '../../db/schema';

  /**
   * THE device a network check's alert attaches to, for one running org (W05e).
   * Lifted verbatim from jobs/monitorWorker.ts so the legacy worker and the
   * `network_check` monitor handler agree: a check is one probe per org, so it
   * raises ONE alert per org — on the asset's linked device when it has one,
   * else the most recently seen non-ephemeral device in the asset's site, else
   * in the org. `orgId` is the RUNNING org (the device's), never the
   * definition owner, which is NULL for a partner-wide check.
   */
  export async function resolveNetworkCheckAlertDevice(check: { orgId: string; assetId: string | null }): Promise<string | null> {
    let preferredSiteId: string | null = null;
    if (check.assetId) {
      const [asset] = await db
        .select({ linkedDeviceId: discoveredAssets.linkedDeviceId, siteId: discoveredAssets.siteId })
        .from(discoveredAssets)
        .where(and(eq(discoveredAssets.id, check.assetId), eq(discoveredAssets.orgId, check.orgId)))
        .limit(1);
      if (asset?.linkedDeviceId) return asset.linkedDeviceId;
      preferredSiteId = asset?.siteId ?? null;
    }
    if (preferredSiteId) {
      const [siteDevice] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.orgId, check.orgId), eq(devices.isEphemeral, false), eq(devices.siteId, preferredSiteId)))
        .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
        .limit(1);
      if (siteDevice?.id) return siteDevice.id;
    }
    const [orgDevice] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.orgId, check.orgId), eq(devices.isEphemeral, false)))
      .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
      .limit(1);
    return orgDevice?.id ?? null;
  }
  ```
  `monitorWorker.ts`: delete `resolveMonitorAlertDevice` (294-345), import `resolveNetworkCheckAlertDevice` and call it at 415 (`const alertDeviceId = await resolveNetworkCheckAlertDevice({ orgId: runningOrgId, assetId: monitor.assetId });`), and change the rules query (405-411) to `and(eq(networkMonitorAlertRules.monitorId, monitor.id), eq(networkMonitorAlertRules.isActive, true), isNull(networkMonitorAlertRules.retiredAt))` (import `isNull`). In `monitorWorker.test.ts` add `retiredAt: 'networkMonitorAlertRules.retiredAt'` to the schema mock if the file mocks `../db/schema` by shape, and mock `../services/monitors/networkCheckAlertDevice` where the old resolver's queries were stubbed.
  `types.ts` (147-151):
  ```ts
  export interface NetworkCheckCondition {
    type: 'network_check';
    monitorId: string;
    consecutiveFailures?: number;
    /** W05e — a `degraded` result counts as a failure (legacy `degraded` rule). */
    degradedIsFailure?: boolean;
    /** W05e — an online result slower than this counts as a failure (legacy `response_time_gt`). */
    maxResponseMs?: number;
  }
  ```
  `handlers/networkCheck.ts` — retain #6353's capability export and device-independent entry path; adapt its verdict body with the following logic. If the prerequisite extracted helpers or changed the entry point, merge this predicate/projection into those existing functions rather than overwriting their scheduling contract. The ordinary per-device handler remains gated as below; the prerequisite scheduler must evaluate the selected device even when offline and exclude these checks from duplicate per-device execution:
  ```ts
  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as NetworkCheckCondition;
    const needed = Math.max(1, cond.consecutiveFailures ?? 2);

    const [managed] = await db
      .select({ id: networkMonitors.id, assetId: networkMonitors.assetId })
      .from(networkMonitors)
      .where(eq(networkMonitors.managedByMonitorId, cond.monitorId))
      .limit(1);
    if (!managed) return { passed: false, description: 'Network check not provisioned yet' };

    const [device] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
    if (!device) return { passed: false, description: 'Device not found for network check evaluation' };

    // W05e — one probe per org raises ONE alert per org, on the same device
    // the legacy worker chose. Every other device in the policy's scope sees
    // "not breaching", so an org-wide policy cannot fan one outage out into
    // one alert per device.
    const alertDeviceId = await resolveNetworkCheckAlertDevice({ orgId: device.orgId, assetId: managed.assetId });
    if (alertDeviceId !== deviceId) {
      return { passed: false, description: 'Not the alert device for this network check' };
    }

    const rows = await db
      .select({ status: networkMonitorResults.status, responseMs: networkMonitorResults.responseMs, timestamp: networkMonitorResults.timestamp })
      .from(networkMonitorResults)
      .where(and(eq(networkMonitorResults.monitorId, managed.id), eq(networkMonitorResults.orgId, device.orgId)))
      .orderBy(desc(networkMonitorResults.timestamp))
      .limit(needed);
    if (rows.length === 0) return { passed: false, description: 'No network check results yet' };

    const isFailure = (row: { status: string; responseMs: number | null }) =>
      row.status === 'offline'
      || (cond.degradedIsFailure === true && row.status === 'degraded')
      || (cond.maxResponseMs != null && row.responseMs != null && row.responseMs > cond.maxResponseMs);

    let consecutive = 0;
    for (const row of rows) {
      if (!isFailure(row)) break;
      consecutive++;
    }
    const passed = consecutive >= needed;
    return {
      passed,
      description: passed
        ? `Network check failing for ${consecutive} consecutive result(s) (threshold ${needed})`
        : `Network check healthy (${consecutive} consecutive failing result(s), threshold ${needed})`,
      actualValue: consecutive,
    };
  },
  ```
  `validate` adds: `if (c.maxResponseMs !== undefined && (typeof c.maxResponseMs !== 'number' || c.maxResponseMs < 1)) errors.push(`${path}.maxResponseMs: Must be a positive number`);` and `if (c.degradedIsFailure !== undefined && typeof c.degradedIsFailure !== 'boolean') errors.push(`${path}.degradedIsFailure: Must be a boolean`);`.
- [ ] **Step 4: Run, expect PASS.**
  ```bash
  cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/alertConditions/handlers/networkCheck.test.ts src/services/monitors/networkCheckAlertDevice.test.ts src/jobs/monitorWorker.test.ts src/jobs/monitorWorker.dbcontext.test.ts src/services/alertConditions/index.test.ts
  ```
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/networkCheckAlertDevice.ts apps/api/src/services/monitors/networkCheckAlertDevice.test.ts apps/api/src/jobs/monitorWorker.ts apps/api/src/jobs/monitorWorker.test.ts apps/api/src/services/alertConditions/types.ts apps/api/src/services/alertConditions/handlers/networkCheck.ts apps/api/src/services/alertConditions/handlers/networkCheck.test.ts && git commit -m "fix(monitors): network_check raises one alert per org on the check's alert device; degraded and slow verdicts"`

---

### Task 4: Enforce asset ownership on create, update and compiled rows (PR1)

**Files:**
- Modify: `apps/api/src/services/monitors/monitorService.ts:239-320` (create and merged update validation), `monitorService.test.ts:17-101` (existing `dbMock`, `auth`, `input` harness).
- Create: `apps/api/src/services/monitors/networkCheckAsset.ts`, `networkCheckAsset.test.ts`.
- Modify: `apps/api/src/db/schema/discovery.ts:143-215`, `apps/api/src/db/schema/monitors.ts:10-56`; Task 1's unshipped `apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql`.
- Test: `apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts` (Task 9 live FK proof).

**Interfaces:** Consumes `discoveredAssets.orgId`, `NetworkCheckMonitorCondition`; produces `assertNetworkCheckAssetOwner(kind, condition, owner, executor): Promise<void>`. The INFERRED ownership finding is confirmed: `monitorService.ts:239-320` only validates shape/escalation, and `monitors.ts:20` has only a single-column FK. Reject a partner definition naming an asset, even one visible to its caller. Validate PATCH against the merged condition and persisted owner.

- [ ] **Step 1: Write the failing test.** New `networkCheckAsset.test.ts`:
  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import { assertNetworkCheckAssetOwner } from './networkCheckAsset';
  const orgId = '11111111-1111-4111-8111-111111111111';
  const assetId = '22222222-2222-4222-8222-222222222222';
  function executor(rows: unknown[]) {
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }));
    return { select };
  }
  it('rejects a missing or foreign-org asset before compilation', async () => {
    await expect(assertNetworkCheckAssetOwner('network_check', { assetId }, { orgId, partnerId: null }, executor([]) as never))
      .rejects.toThrow('asset_not_owned');
  });
  it('rejects an asset on a partner definition without reading the asset', async () => {
    const tx = executor([{ id: assetId }]);
    await expect(assertNetworkCheckAssetOwner('network_check', { assetId }, { orgId: null, partnerId: orgId }, tx as never))
      .rejects.toThrow('asset_requires_org_owner');
    expect(tx.select).not.toHaveBeenCalled();
  });
  it('accepts a same-org asset and an unbound check', async () => {
    const tx = executor([{ id: assetId }]);
    await expect(assertNetworkCheckAssetOwner('network_check', { assetId }, { orgId, partnerId: null }, tx as never)).resolves.toBeUndefined();
    await expect(assertNetworkCheckAssetOwner('network_check', {}, { orgId: null, partnerId: orgId }, tx as never)).resolves.toBeUndefined();
    expect(tx.select).toHaveBeenCalledTimes(1);
  });
  ```
  Append service regressions using the existing harness (no invented fixtures):
  ```ts
  it('create rejects an asset not owned by the definition org', async () => {
    dbMock.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
    await expect(createMonitorDefinition(input({ kind: 'network_check', condition: {
      checkType: 'icmp_ping', target: 'example.com', assetId: '33333333-3333-4333-8333-333333333333',
    } }), auth())).rejects.toThrow('asset_not_owned');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
  it('update validates a replacement asset against the persisted owner', async () => {
    const existing = { ...input(), id: ORG, orgId: ORG, partnerId: null, kind: 'network_check',
      condition: { checkType: 'icmp_ping', target: 'example.com' }, escalationPolicyId: null };
    dbMock.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
    await expect(updateMonitorDefinition(ORG, { condition: { ...existing.condition,
      assetId: '33333333-3333-4333-8333-333333333333' } }, auth())).rejects.toThrow('asset_not_owned');
    expect(dbMock.update).not.toHaveBeenCalled();
  });
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd apps/api && npx vitest run src/services/monitors/networkCheckAsset.test.ts src/services/monitors/monitorService.test.ts` → missing module, then unexpected transaction instead of `asset_not_owned` before the service calls are installed.
- [ ] **Step 3: Implement.** `networkCheckAsset.ts`:
  ```ts
  import { and, eq } from 'drizzle-orm';
  import { db } from '../../db';
  import { discoveredAssets } from '../../db/schema';
  type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
  export class NetworkCheckAssetError extends Error {}
  export async function assertNetworkCheckAssetOwner(
    kind: string, condition: Record<string, unknown>, owner: { orgId: string | null; partnerId: string | null },
    executor: DbExecutor = db,
  ): Promise<void> {
    if (kind !== 'network_check' || !condition.assetId) return;
    if (!owner.orgId || owner.partnerId) throw new NetworkCheckAssetError('asset_requires_org_owner');
    const [asset] = await executor.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, String(condition.assetId)), eq(discoveredAssets.orgId, owner.orgId))).limit(1);
    if (!asset) throw new NetworkCheckAssetError('asset_not_owned');
  }
  ```
  Import `{ assertNetworkCheckAssetOwner, NetworkCheckAssetError }` from `./networkCheckAsset`. After shape validation in both create and update, use the same executor as compilation and translate to the existing `MonitorValidationError` (routes already return 400):
  ```ts
  // create, before any insert; owner/shape come from the existing validation.
  try { await assertNetworkCheckAssetOwner(input.kind, shape.condition, owner, executor ?? db); }
  catch (error) {
    if (error instanceof NetworkCheckAssetError) throw new MonitorValidationError(error.message);
    throw error;
  }
  // update, before any write, using the executor-aware update contract from C2.
  try { await assertNetworkCheckAssetOwner(merged.kind, shape.condition, existing, executor ?? db); }
  catch (error) {
    if (error instanceof NetworkCheckAssetError) throw new MonitorValidationError(error.message);
    throw error;
  }
  ```
  Add to Task 1's migration (before shipping PR1; never edit a shipped migration):
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS discovered_assets_id_org_uidx ON discovered_assets (id, org_id);
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'network_monitors'::regclass AND conname = 'network_monitors_asset_org_fk') THEN
      ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_asset_org_fk
        FOREIGN KEY (asset_id, org_id) REFERENCES discovered_assets (id, org_id)
        DEFERRABLE INITIALLY IMMEDIATE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'network_monitors'::regclass AND conname = 'network_monitors_asset_org_required') THEN
      ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_asset_org_required
        CHECK (asset_id IS NULL OR (org_id IS NOT NULL AND partner_id IS NULL));
    END IF;
  END $$;
  ```
  No cleanup DML: existing cross-owner corruption fails migration visibly and must be investigated; never silently reassign an asset. Drizzle schema callbacks mirror the unique index, FK and check (imports `uniqueIndex`, `foreignKey`, `check`, `sql`):
  ```ts
  // discoveredAssets callback:
  idOrgUidx: uniqueIndex('discovered_assets_id_org_uidx').on(table.id, table.orgId),
  // networkMonitors callback (SQL migration supplies DEFERRABLE):
  assetOrgFk: foreignKey({ name: 'network_monitors_asset_org_fk', columns: [table.assetId, table.orgId],
    foreignColumns: [discoveredAssets.id, discoveredAssets.orgId] }),
  assetOrgRequired: check('network_monitors_asset_org_required', sql`${table.assetId} IS NULL OR (${table.orgId} IS NOT NULL AND ${table.partnerId} IS NULL)`),
  ```
- [ ] **Step 4: Run, expect PASS.** Repeat Step 2, then `cd apps/api && npx tsc --noEmit -p .`; Task 9 verifies real deferrability and cross-tenant rejection, not only schema drift.
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/networkCheckAsset.ts apps/api/src/services/monitors/networkCheckAsset.test.ts apps/api/src/services/monitors/monitorService.ts apps/api/src/services/monitors/monitorService.test.ts apps/api/src/db/schema/discovery.ts apps/api/src/db/schema/monitors.ts apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql && git commit -m "fix(monitors): enforce network asset ownership on create update and compiled rows"`

---

### Task 5: Compiler adoption — a definition's first compile takes over an existing row (PR1)

**Files:**
- Modify: `apps/api/src/services/monitors/monitorCompiler.ts` (lines 286-312 `compileMonitorInTx`)
- Modify: `apps/api/src/services/monitors/monitorService.ts` (lines 239-291)
- Test: `apps/api/src/services/monitors/monitorCompiler.w04.test.ts` (the `compileMonitorInTx` stub at lines 73-110 records upserts)

**Interfaces:**
- Produces:
  ```ts
  export interface CompileOptions { /** W05e — stamp managed_by_monitor_id on this unmanaged, same-org network_monitors row before the upsert so it is UPDATED in place. */ adoptNetworkMonitorId?: string }
  export class NetworkMonitorAdoptionError extends Error { constructor(public readonly networkMonitorId: string) }
  export async function compileMonitorInTx(tx: DbTx, def: MonitorDefinitionRow, opts?: CompileOptions): Promise<CompiledRefs>;
  export function createMonitorDefinition(input: CreateMonitorDefinitionInput, auth: AuthContext, options?: CompileOptions, executor?: DbExecutor): Promise<MonitorDefinitionRow>; // implementation defaults options to {}
  ```

- [ ] **Step 1: Write the failing test.** Extend the actual `makeTx` at `monitorCompiler.w04.test.ts:78` with an optional second argument `adoptable: string | null = null`; its existing outputs remain `_inserts`, `_updates`, `_selectOrder`. Import the real `networkMonitors` table. Replace only its `update` stub:
  ```ts
  update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: () => {
    const adoption = table === networkMonitors && Object.keys(values).length === 1 && 'managedByMonitorId' in values;
    const apply = () => { updates.push({ id: adoption ? adoptable ?? 'missing' : 'existing', values }); };
    return {
      returning: async () => { apply(); return adoption ? (adoptable ? [{ id: adoptable }] : []) : [{ id: 'existing' }]; },
      then: (resolve: (value: undefined) => unknown) => { apply(); return Promise.resolve(undefined).then(resolve); },
    };
  } }) }),
  ```
  Add `NetworkMonitorAdoptionError` to the existing dynamic compiler import, then:
  ```ts
  it('adopts in place using the existing row id', async () => {
    const tx = makeTx({ networkMonitors: 'legacy-row-1' }, 'legacy-row-1');
    await compileMonitorInTx(tx as never, makeDef(), { adoptNetworkMonitorId: 'legacy-row-1' });
    expect(tx._updates).toContainEqual({ id: 'legacy-row-1', values: { managedByMonitorId: makeDef().id } });
    expect(tx._inserts.filter((r: Record<string, unknown>) => 'monitorType' in r)).toHaveLength(0);
    expect(tx._updates.filter((r: { values: Record<string, unknown> }) => 'monitorType' in r.values)).toHaveLength(1);
  });
  it('rejects a row the conditional adoption update cannot acquire', async () => {
    await expect(compileMonitorInTx(makeTx({}, null) as never, makeDef(), { adoptNetworkMonitorId: 'legacy-row-1' }))
      .rejects.toBeInstanceOf(NetworkMonitorAdoptionError);
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/api && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts` → missing adoption export/expected adoption update absent.
- [ ] **Step 3: Implement.** In `monitorCompiler.ts`:
  ```ts
  import { and, eq, isNull } from 'drizzle-orm';

  // Replace the empty compiler-owned CompileOptions alias from C1 Task 7 (forwarded
  // through createValidatedMonitorInTx by C2 Task 16); do not redeclare it in the service.
  export interface CompileOptions { adoptNetworkMonitorId?: string }

  export class NetworkMonitorAdoptionError extends Error {
    constructor(public readonly networkMonitorId: string) {
      super(`network_monitors row ${networkMonitorId} cannot be adopted: already managed, retired, or not owned by the definition's org`);
      this.name = 'NetworkMonitorAdoptionError';
    }
  }
  ```
  and inside `compileMonitorInTx(tx, def, opts?: CompileOptions)`, replace the `if (def.kind === 'network_check')` block:
  ```ts
  if (def.kind === 'network_check') {
    // W05e — conversion ADOPTS the legacy row: stamping managed_by_monitor_id
    // first makes the read-then-write upsert below find it and UPDATE it in
    // place, so the row id, its results history, asset binding and TLS
    // observation survive. Only an unmanaged, unretired row in the
    // definition's own org qualifies; anything else is a hard error, never a
    // silent fresh insert.
    if (opts?.adoptNetworkMonitorId) {
      const [adopted] = await tx
        .update(networkMonitors)
        .set({ managedByMonitorId: def.id })
        .where(and(
          eq(networkMonitors.id, opts.adoptNetworkMonitorId),
          isNull(networkMonitors.managedByMonitorId),
          isNull(networkMonitors.retiredAt),
          def.orgId ? eq(networkMonitors.orgId, def.orgId) : sql`false`,
        ))
        .returning({ id: networkMonitors.id });
      if (!adopted) throw new NetworkMonitorAdoptionError(opts.adoptNetworkMonitorId);
    }
    await upsertManaged(tx, networkMonitors, def.id, { ...buildCompiledNetworkMonitor(def), updatedAt: now });
  }
  ```
  (`sql` from `drizzle-orm`.) Retain C1 Task 7's `DbExecutor` and four-argument `createMonitorDefinition(input, auth, options: CompileOptions = {}, executor: DbExecutor = db)` signature, owner/reference reads, and extracted `createValidatedMonitorInTx(input, auth, owner, shape, options, executor)`. C2 Task 16 forwards `options` through that helper to `compileMonitorInTx(tx, created, options)`; extend the compiler-owned options in place without adding a second type or parameter. Keep its executor-aware transaction boundary verbatim. Import/re-export `CompileOptions` as a type and `NetworkMonitorAdoptionError` as a value from `./monitorCompiler`.
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts src/services/monitors/monitorCompiler.test.ts src/services/monitors/monitorService.test.ts`
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/monitorCompiler.ts apps/api/src/services/monitors/monitorService.ts apps/api/src/services/monitors/monitorCompiler.w04.test.ts && git commit -m "feat(monitors): compile option to adopt an existing network_monitors row in place"`

---

### Task 6: Preserve alert provenance and make network retirement reversible (PR1)

**Files:**
- Create: `apps/api/src/services/monitors/conversion/networkHistory.ts`, `networkHistory.test.ts`.
- Modify (W05c1 producers): `apps/api/src/db/schema/monitorConversions.ts`, `apps/api/src/services/monitors/conversion/convert.ts`, `index.ts`, `lifecycle.ts`, `apps/api/src/routes/monitorDefinitions.conversion.ts`.
- Modify: `apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql` (Task 1, same PR); `apps/api/src/services/tenantExportPolicyRegistry.ts:401` (network row) and W05c1's `monitor_conversions` entry.
- Modify: `apps/api/src/jobs/monitorWorker.ts:464-482` (source/event identity); `monitorWorker.test.ts`.
- Test: Task 9's `apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts`.

**Interfaces:** Consumes W05c1 `OPEN_ALERT_STATUSES` from `conversion/loadSources.ts`, `monitorConversionOutputs.movedAlertRefs` (D13, `excludedOpen`), `isRevertAvailable(sourceTable)` from `conversion/lifecycle.ts`. Produces `carryNetworkAlerts(tx, source, definition)`, `snapshotNetworkSource(tx, source)`, `retireNetworkCheck(sourceId, reason, auth): Promise<{ conversionId: string }>`, `revertNetworkCheckConversion(conversion, outputMonitorIds, auth): Promise<void>`. `networkSourceSnapshot` is a W05e-only nullable JSON column on the common parent ledger, needed even when a retirement has zero outputs. Both retirement and adoption also write `sourceState: { name: row.name }`, matching C1 Task 16's `sourceName` projection; Task 9 verifies the common GET returns the readable name for each. No second ledger or alternate open-status vocabulary.

- [ ] **Step 1: Write the failing tests.** `networkHistory.test.ts`:
  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import { carryNetworkAlerts } from './networkHistory';
  import { OPEN_ALERT_STATUSES } from './loadSources';
  it('carries every shared open status with original refs and never writes a resolution', async () => {
    const rows = OPEN_ALERT_STATUSES.map((status, i) => ({ id: `a-${i}`, status, ruleId: null,
      configPolicyId: null, monitorId: null, context: { source: 'network_monitor', monitorId: 'legacy', alertRuleId: 'rule' } }));
    const writes: Record<string, unknown>[] = [];
    const tx = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ for: async () => rows }) }) })),
      update: vi.fn(() => ({ set: (values: Record<string, unknown>) => ({ where: async () => { writes.push(values); } }) })),
    };
    const refs = await carryNetworkAlerts(tx as never, { id: 'legacy', orgId: 'org' } as never,
      { id: 'definition', compiledAlertRuleId: 'compiled' } as never);
    expect(refs.map(r => r.id)).toEqual(rows.map(r => r.id));
    expect(refs[2]?.context).toEqual(rows[2]?.context); // suppressed included
    expect(writes).toHaveLength(OPEN_ALERT_STATUSES.length);
    for (const write of writes) {
      expect(write).toMatchObject({ ruleId: 'compiled', configPolicyId: null, monitorId: 'definition',
        context: { convertedFrom: { sourceTable: 'network_monitors', sourceId: 'legacy' } } });
      expect(write).not.toHaveProperty('status');
      expect(write).not.toHaveProperty('resolvedAt');
    }
  });
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd apps/api && npx vitest run src/services/monitors/conversion/networkHistory.test.ts` → missing module/export. Task 9 supplies the real retirement/revert, FK and cross-org regression tests.
- [ ] **Step 3: Implement.** Add the parent snapshot to the unshipped W05e migration and Drizzle table, classifying it `excludedOpen` in `CORE_TENANT_EXPORT_POLICY` (the existing D13 output `moved_alert_refs` remains `excludedOpen`):
  ```sql
  ALTER TABLE monitor_conversions ADD COLUMN IF NOT EXISTS network_source_snapshot jsonb;
  ```
  ```ts
  networkSourceSnapshot: jsonb('network_source_snapshot'),
  ```
  `networkHistory.ts`:
  ```ts
  import { createHash } from 'node:crypto';
  import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
  import { db } from '../../../db';
  import { alerts, configPolicyFeatureLinks, configPolicyMonitors, monitorConversions,
    monitorConversionOutputs, monitorDefinitions, networkMonitors, networkMonitorAlertRules } from '../../../db/schema';
  import type { AuthContext } from '../../../middleware/auth';
  import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
  import { OPEN_ALERT_STATUSES } from './loadSources';
  import { isRevertAvailable } from './lifecycle';
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  type Row = typeof networkMonitors.$inferSelect;
  type Definition = typeof monitorDefinitions.$inferSelect;
  type Conversion = typeof monitorConversions.$inferSelect;
  type RuleSnapshot = { id: string; retiredAt: string | null; retiredReason: string | null; isActive: boolean };
  type Snapshot = { name: string; monitorType: Row['monitorType']; target: string; config: Record<string, unknown>; pollingInterval: number;
    timeout: number; assetId: string | null; isActive: boolean; retiredAt: string | null;
    retiredReason: string | null; rules: RuleSnapshot[] };
  export class NetworkHistoryError extends Error {
    constructor(public code: string, public status: 400 | 403 | 404 | 409) { super(code); }
  }
  function assertAccess(orgId: string | null, auth: AuthContext) {
    if (!canMutateOrgWideGovernance(auth)) throw new NetworkHistoryError('site_restricted_conversion', 403);
    if (!orgId || !auth.canAccessOrg(orgId)) throw new NetworkHistoryError('org_not_found', 404);
  }
  export async function snapshotNetworkSource(tx: Tx, row: Row): Promise<Snapshot> {
    const rules = await tx.select().from(networkMonitorAlertRules).where(eq(networkMonitorAlertRules.monitorId, row.id)).for('update');
    return { name: row.name, monitorType: row.monitorType, target: row.target, config: row.config as Record<string, unknown>,
      pollingInterval: row.pollingInterval, timeout: row.timeout, assetId: row.assetId, isActive: row.isActive,
      retiredAt: row.retiredAt?.toISOString() ?? null, retiredReason: row.retiredReason,
      rules: rules.map(r => ({ id: r.id, retiredAt: r.retiredAt?.toISOString() ?? null,
        retiredReason: r.retiredReason, isActive: r.isActive })) };
  }
  export async function carryNetworkAlerts(tx: Tx, row: Row, def: Definition) {
    if (!def.compiledAlertRuleId) throw new Error('network_compiled_rule_missing');
    const open = await tx.select().from(alerts).where(and(eq(alerts.orgId, row.orgId!),
      inArray(alerts.status, [...OPEN_ALERT_STATUSES]), sql`${alerts.context}->>'source' = 'network_monitor'`,
      sql`${alerts.context}->>'monitorId' = ${row.id}`)).for('update');
    const refs = open.map(a => ({ id: a.id, ruleId: a.ruleId, configPolicyId: a.configPolicyId,
      monitorId: a.monitorId, context: a.context as Record<string, unknown> | null }));
    for (const a of open) await tx.update(alerts).set({ ruleId: def.compiledAlertRuleId,
      configPolicyId: null, monitorId: def.id, context: {
        ...(a.context as Record<string, unknown> ?? {}),
        convertedFrom: { sourceTable: 'network_monitors', sourceId: row.id, convertedAt: new Date().toISOString() },
      } }).where(and(eq(alerts.id, a.id), eq(alerts.orgId, row.orgId!)));
    return refs;
  }
  export async function retireNetworkCheck(sourceId: string, reason: string, auth: AuthContext): Promise<{ conversionId: string }> {
    if (!canMutateOrgWideGovernance(auth)) throw new NetworkHistoryError('site_restricted_conversion', 403);
    if (reason !== 'operator' && !/^unconvertible:[a-z0-9_]+$/.test(reason)) {
      throw new NetworkHistoryError('invalid_retirement_reason', 400);
    }
    return db.transaction(async tx => {
      const [row] = await tx.select().from(networkMonitors).where(eq(networkMonitors.id, sourceId)).for('update');
      assertAccess(row?.orgId ?? null, auth);
      if (!row || row.retiredAt || row.managedByMonitorId) throw new NetworkHistoryError('already_converted', 409);
      const networkSourceSnapshot = await snapshotNetworkSource(tx, row);
      const [entry] = await tx.insert(monitorConversions).values({ orgId: row.orgId, partnerId: null,
        sourceTable: 'network_monitors', sourceId, policyId: null, sourceState: { name: row.name },
        convertedBy: auth.scope === 'system' ? null : auth.user.id,
        previewHash: createHash('sha256').update(JSON.stringify({ sourceId, reason, networkSourceSnapshot })).digest('hex'), networkSourceSnapshot }).returning({ id: monitorConversions.id });
      const now = new Date();
      await tx.update(networkMonitors).set({ retiredAt: now, retiredReason: reason, isActive: false, updatedAt: now })
        .where(and(eq(networkMonitors.id, sourceId), eq(networkMonitors.orgId, row.orgId!)));
      await tx.update(networkMonitorAlertRules).set({ retiredAt: now, retiredReason: reason })
        .where(and(eq(networkMonitorAlertRules.monitorId, sourceId), isNull(networkMonitorAlertRules.retiredAt)));
      // Zero outputs. Existing alerts, including suppressed and terminal history,
      // retain their status and source context; manual retirement never resolves them.
      return { conversionId: entry!.id };
    });
  }
  export async function revertNetworkCheckConversion(conversion: Conversion, outputMonitorIds: string[], auth: AuthContext): Promise<void> {
    assertAccess(conversion.orgId, auth);
    if (!isRevertAvailable('network_monitors')) throw new NetworkHistoryError('conversion_revert_unavailable', 409);
    await db.transaction(async tx => {
      const [entry] = await tx.select().from(monitorConversions).where(eq(monitorConversions.id, conversion.id)).for('update');
      if (!entry || entry.revertedAt) throw new NetworkHistoryError('already_reverted', 409);
      const [sourceRow] = await tx.select().from(networkMonitors)
        .where(and(eq(networkMonitors.id, entry.sourceId), eq(networkMonitors.orgId, entry.orgId!))).for('update');
      if (!sourceRow) throw new NetworkHistoryError('source_not_found', 404);
      const source = entry.networkSourceSnapshot as Snapshot | null;
      if (!source) throw new NetworkHistoryError('network_source_snapshot_missing', 409);
      const outputs = await tx.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, entry.id));
      // A second deployment needs the adopted probe. Refuse before mutation if
      // it now has another live owner; never delete another conversion's monitor.
      for (const id of outputMonitorIds) {
        const [other] = await tx.select({ id: monitorConversions.id }).from(monitorConversionOutputs)
          .innerJoin(monitorConversions, eq(monitorConversions.id, monitorConversionOutputs.conversionId))
          .where(and(eq(monitorConversionOutputs.monitorId, id), ne(monitorConversions.id, entry.id), isNull(monitorConversions.revertedAt))).limit(1);
        const attachments = await tx.select({ policyId: configPolicyFeatureLinks.configPolicyId }).from(configPolicyMonitors)
          .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.id, configPolicyMonitors.featureLinkId))
          .where(eq(configPolicyMonitors.monitorId, id));
        if (other || attachments.some(a => a.policyId !== entry.policyId)) throw new NetworkHistoryError('network_revert_in_use', 409);
      }
      for (const output of outputs) {
        // D13 shape: persist exact original refs/context; do not restore statuses
        // because the operator may have acknowledged/resolved since conversion.
        const refs = (output.movedAlertRefs ?? []) as Array<{ id: string; ruleId: string | null;
          configPolicyId: string | null; monitorId: string | null; context: Record<string, unknown> | null }>;
        for (const ref of refs) await tx.update(alerts).set({ ruleId: ref.ruleId,
          configPolicyId: ref.configPolicyId, monitorId: ref.monitorId, context: ref.context })
          .where(and(eq(alerts.id, ref.id), eq(alerts.orgId, entry.orgId!)));
        // Rehome all later alerts (including resolved/dismissed) before the FK
        // target is deleted. Never leave rule_id pointing at a compiled rule.
        if (!output.monitorId) continue; // definition already absent; original refs still restored above
        const later = await tx.select().from(alerts).where(and(eq(alerts.monitorId, output.monitorId), eq(alerts.orgId, entry.orgId!)));
        for (const a of later) await tx.update(alerts).set({ ruleId: null, configPolicyId: null, monitorId: null,
          context: { ...(a.context as Record<string, unknown> ?? {}), source: 'network_monitor',
            monitorId: entry.sourceId, alertRuleId: source.rules.find(r => r.isActive && !r.retiredAt)?.id,
            convertedFrom: { sourceTable: 'network_monitors', sourceId: entry.sourceId, revertedConversionId: entry.id } },
        }).where(eq(alerts.id, a.id));
      }
      // Un-adopt BEFORE deleting the definition; its FK cascades the probe.
      const { rules, retiredAt, ...values } = source;
      await tx.update(networkMonitors).set({ ...values, retiredAt: retiredAt ? new Date(retiredAt) : null,
        managedByMonitorId: null, updatedAt: new Date() }).where(and(eq(networkMonitors.id, entry.sourceId), eq(networkMonitors.orgId, entry.orgId!)));
      for (const rule of rules) await tx.update(networkMonitorAlertRules).set({ isActive: rule.isActive,
        retiredAt: rule.retiredAt ? new Date(rule.retiredAt) : null, retiredReason: rule.retiredReason })
        .where(and(eq(networkMonitorAlertRules.id, rule.id), eq(networkMonitorAlertRules.monitorId, entry.sourceId)));
      for (const id of outputMonitorIds) await tx.delete(monitorDefinitions).where(and(eq(monitorDefinitions.id, id), eq(monitorDefinitions.orgId, entry.orgId!)));
      await tx.update(monitorConversions).set({ revertedAt: new Date() }).where(eq(monitorConversions.id, entry.id));
    });
  }
  ```
  In `routes/monitorDefinitions.conversion.ts` import `NetworkHistoryError` from `../services/monitors/conversion/networkHistory` and put `if (err instanceof NetworkHistoryError) return c.json({ error: err.code }, err.status);` before the existing error branches for retirement/revert. Add this router to the task's git add command. Keep `network_monitors` revertable in D4's lifecycle; W05d's five deleted-runtime sources remain unavailable. D2's persistent ledger shows both conversion and manual retirement entries and refreshes after retirement. D13's `moved_alert_refs` representation above must be the same type imported from C1's provenance contract; do not create a second JSON field on outputs.

  Event consumers: in `monitorWorker.ts` retain `context.monitorId = monitor.id` for historical legacy-source matching, also name it `legacyNetworkMonitorId` in source context. In the `eventPayload` replace `monitorId: monitor.id` with `legacyNetworkMonitorId: monitor.id`; `createSourcedAlert` supplies typed `monitorId` from its definition argument (null on legacy events). Add the regression to `monitorWorker.test.ts`:
  ```ts
  expect(createSourcedAlertMock).toHaveBeenCalledWith(expect.objectContaining({
    context: expect.objectContaining({ monitorId: legacyId, legacyNetworkMonitorId: legacyId }),
    eventPayload: expect.objectContaining({ legacyNetworkMonitorId: legacyId }),
  }));
  const payload = createSourcedAlertMock.mock.calls.at(-1)![0].eventPayload;
  expect(payload).not.toHaveProperty('monitorId');
  ```
  Use the actual test's `createSourcedAlert` mock (`vi.mocked(createSourcedAlert)`) and fixture monitor id; bind `const createSourcedAlertMock = vi.mocked(createSourcedAlert); const legacyId = 'monitor-1';` in that test before these assertions.
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors/conversion/networkHistory.test.ts src/jobs/monitorWorker.test.ts`; then Task 9's live suite and export-policy suite verify the snapshots, zero-output ledger and restoration.
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/conversion apps/api/src/db/schema/monitorConversions.ts apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/jobs/monitorWorker.ts apps/api/src/jobs/monitorWorker.test.ts apps/api/src/routes/monitorDefinitions.conversion.ts && git commit -m "fix(monitors): preserve network alert provenance and reversible retirement"`

---

### Task 7: Conversion — mapper, preview/convert/retire/revert, policy, routes, ledger wiring (PR1)

**Files:**
- Create: `apps/api/src/services/monitors/conversion/networkChecks.ts`, `networkChecks.test.ts`
- Modify (W05c1 producers): `apps/api/src/services/monitors/conversion/convert.ts`, `convert.test.ts`, `index.ts`, `loadSources.ts`, `lifecycle.ts` (D2–D4, D15, D20).
- Modify: `apps/api/src/routes/monitorDefinitions.conversion.ts` (W05c1 producer)
- Create: `apps/api/src/routes/monitorDefinitions.conversion.networkChecks.test.ts`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (allowlist), `apps/api/src/__tests__/site-ceiling-write-coverage.test.ts` (allowlist)

**Interfaces:**
- Consumes (W05c1): `monitorConversions`, `monitorConversionOutputs` tables; `ConversionPreviewItem`; `previewHash` convention; C1 Task 9 `ConversionPrerequisiteMissingError` from `conversion/prerequisites.ts`.
- Consumes: `createMonitorDefinition(input, auth, { adoptNetworkMonitorId }, tx)` (Task 5); `createConfigPolicy`, `assignPolicy`, `addFeatureLink` (`services/configurationPolicy.ts:281, 1963, 1655`); `configPolicyFeatureLinks`, `configPolicyMonitors` (`db/schema/monitorDefinitions.ts:116`); `OPEN_ALERT_STATUSES` from `conversion/loadSources.ts` (W05c1); history helpers from Task 6.
- Produces:
  ```ts
  export const NETWORK_CHECK_UNCONVERTIBLE = {
    alreadyManaged: 'unconvertible:already_managed',
    noOrg: 'unconvertible:no_org',
    assetMissing: 'unconvertible:asset_missing',
    conditionInvalid: 'unconvertible:condition_invalid',
    noActiveRules: 'unconvertible:no_active_rules',
    multipleRules: 'unconvertible:multiple_network_rules',
    predicate: 'unconvertible:network_predicate_unsupported',
    threshold: 'unconvertible:network_threshold_out_of_range',
  } as const;
  export interface NetworkCheckMapping { condition: NetworkCheckMonitorCondition; severity: AlertSeverity; deliveryMode: 'inherit' | 'none'; description?: string; notes: string[] }
  export function mapNetworkMonitorToDefinition(row: typeof networkMonitors.$inferSelect, rules: Array<typeof networkMonitorAlertRules.$inferSelect>): { ok: true; mapping: NetworkCheckMapping } | { ok: false; reason: string };
  export interface NetworkCheckConversionPreview { orgId: string; previewHash: string; blockedBy?: 'prerequisite_missing'; missingPrerequisites?: string[]; items: Array<ConversionPreviewItem & { notes: string[]; openAlerts: number }> }
  export function missingNetworkCheckPrerequisites(runtime?: { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION?: unknown }): string[];
  export async function previewNetworkCheckConversion(orgId: string, auth: AuthContext): Promise<NetworkCheckConversionPreview>;
  export async function convertNetworkChecks(orgId: string, previewHash: string, auth: AuthContext, opts?: { sourceIds?: string[] }): Promise<{ conversionIds: string[]; retired: number; monitorsCreated: number; policyId: string | null }>;
  export async function retireNetworkCheck(sourceId: string, reason: string, auth: AuthContext): Promise<{ conversionId: string }>;
  export async function revertNetworkCheckConversion(conversion: typeof monitorConversions.$inferSelect, outputMonitorIds: string[], auth: AuthContext): Promise<void>;
  export async function countPendingNetworkChecks(orgId: string, auth: AuthContext): Promise<number>;
  export const NETWORK_CHECKS_POLICY_NAME = (orgName: string) => `Network checks — ${orgName}`;
  ```
- Routes: `GET /monitor-definitions/conversion/network-checks?orgId=<uuid>` → `NetworkCheckConversionPreview`; `POST /monitor-definitions/conversion/network-checks/convert` `{ orgId, previewHash, sourceIds? }` → the convert result; `GET /monitor-definitions/conversion/pending?orgId` gains `networkChecks: number`.

**Mapping rules (the contract the tests pin):**
| Legacy | Monitor |
|---|---|
| `monitor_type`, `target`, `asset_id`, `polling_interval`, `timeout` | `checkType`, `target` (http: `config.url ?? target`; dns: `config.hostname ?? target`), `assetId`, `pollingIntervalSeconds`, `timeoutSeconds` |
| `config.{count,packetSize}` / `{port,expectBanner}` / `{method,expectedStatus→expectStatus,expectedBody,headers,followRedirects,verifySsl}` / `{recordType,expectedValue,nameserver}` | same-named condition keys per `NETWORK_CHECK_OPTION_KEYS`; unknown keys ignored with a note |
| one active rule `offline` | `consecutiveFailures: 1`, its exact severity |
| one active rule `consecutive_failures_gt N` | finite nonnegative N → `floor(N)+1` only if ≤100; otherwise `unconvertible:network_threshold_out_of_range` |
| `degraded` or `response_time_gt` | `unconvertible:network_predicate_unsupported` (the monitor predicate also matches offline and would widen coverage) |
| several active rules (including differing thresholds/severities) | `unconvertible:multiple_network_rules`; never collapse independent episodes |
| no active rules | `unconvertible:no_active_rules`; inbox-only still creates alerts and cannot model a non-alerting probe |
| one representable active rule | `deliveryMode: 'inherit'`, `cooldownMinutes: 5`, `autoResolve: true`; enabled state copied to definition and attachment |
| device-independent capability absent/false | whole preview `blockedBy: 'prerequisite_missing'`, `items: []`, no refusals; confirmation → 409 `CONVERSION_PREREQUISITE_MISSING`, no mutation |
| device-independent capability present | representable items are `convertible`; unsupported rule semantics remain explicit per-item refusals |
| open legacy alerts (shared `OPEN_ALERT_STATUSES`, including suppressed) | carry original references/context in `movedAlertRefs`, rebind to compiled rule without resolving; reversal restores references before deleting compiled rows |

- [ ] **Step 1: Write the failing tests.** `networkChecks.test.ts` (pure mapper, no db):
  ```ts
  import { describe, expect, it } from 'vitest';
  import { mapNetworkMonitorToDefinition, NETWORK_CHECK_UNCONVERTIBLE } from './networkChecks';

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'nm-1', orgId: 'org-1', partnerId: null, managedByMonitorId: null, assetId: 'a0000000-0000-4000-8000-000000000001',
    name: 'Gateway', monitorType: 'icmp_ping', target: '10.0.0.1', config: { count: 4 },
    pollingInterval: 60, timeout: 5, isActive: true, retiredAt: null, retiredReason: null, ...over,
  }) as never;
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'r-1', monitorId: 'nm-1', condition: 'offline', threshold: null, severity: 'high', message: null, isActive: true, retiredAt: null, retiredReason: null, ...over,
  }) as never;

  describe('mapNetworkMonitorToDefinition', () => {
    it('maps type, target, asset, interval, timeout and per-type options', () => {
      const r = mapNetworkMonitorToDefinition(row(), [rule()]);
      expect(r).toMatchObject({ ok: true, mapping: { severity: 'high', deliveryMode: 'inherit',
        condition: { checkType: 'icmp_ping', target: '10.0.0.1', assetId: 'a0000000-0000-4000-8000-000000000001', count: 4, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 1, degradedIsFailure: false } } });
    });
    it('http: url wins over target and expectedStatus becomes expectStatus', () => {
      const r = mapNetworkMonitorToDefinition(row({ monitorType: 'http_check', target: 'example.com', config: { url: 'https://example.com/health', expectedStatus: 204, method: 'HEAD' } }), [rule()]);
      expect(r.ok && r.mapping.condition).toMatchObject({ checkType: 'http_check', target: 'https://example.com/health', expectStatus: 204, method: 'HEAD' });
    });
    it.each([
      [[], 'unconvertible:no_active_rules'],
      [[rule({ isActive: false })], 'unconvertible:no_active_rules'],
      [[rule(), rule({ id: 'r-2', severity: 'critical' })], 'unconvertible:multiple_network_rules'],
      [[rule({ condition: 'degraded' })], 'unconvertible:network_predicate_unsupported'],
      [[rule({ condition: 'response_time_gt', threshold: '750' })], 'unconvertible:network_predicate_unsupported'],
      [[rule({ condition: 'consecutive_failures_gt', threshold: '100' })], 'unconvertible:network_threshold_out_of_range'],
    ])('refuses nonrepresentable rules without approximating', (rules, reason) => {
      expect(mapNetworkMonitorToDefinition(row(), rules as never)).toEqual({ ok: false, reason });
    });
    it('preserves the strict consecutive threshold and severity', () => {
      expect(mapNetworkMonitorToDefinition(row(), [rule({ condition: 'consecutive_failures_gt', threshold: '4', severity: 'critical' })]))
        .toMatchObject({ ok: true, mapping: { severity: 'critical', condition: { consecutiveFailures: 5 } } });
    });
    it('refuses a managed row and a row with no org', () => {
      expect(mapNetworkMonitorToDefinition(row({ managedByMonitorId: 'def-1' }), [])).toEqual({ ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.alreadyManaged });
      expect(mapNetworkMonitorToDefinition(row({ orgId: null, partnerId: 'p-1' }), [])).toEqual({ ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.noOrg });
    });
    it('refuses a legacy config outside the kind schema', () => {
      const r = mapNetworkMonitorToDefinition(row({ pollingInterval: 5 }), [rule()]);
      expect(r).toEqual({ ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.conditionInvalid });
    });
  });
  ```
  Append direct-service access tests in `networkChecks.test.ts` (these fail before any DB read):
  ```ts
  import { previewNetworkCheckConversion, convertNetworkChecks } from './networkChecks';
  import type { AuthContext } from '../../../middleware/auth';
  it.each([[], ['11111111-1111-4111-8111-111111111111']])('rejects every site ceiling for preview and convert', async allowedSiteIds => {
    const auth = { scope: 'organization', allowedSiteIds, canAccessOrg: () => true } as unknown as AuthContext;
    await expect(previewNetworkCheckConversion('22222222-2222-4222-8222-222222222222', auth)).rejects.toMatchObject({ code: 'site_restricted_conversion', status: 403 });
    await expect(convertNetworkChecks('22222222-2222-4222-8222-222222222222', 'a'.repeat(64), auth)).rejects.toMatchObject({ code: 'site_restricted_conversion', status: 403 });
  });
  ```
  Add the capability contract cases (import `missingNetworkCheckPrerequisites` from `./networkChecks`):
  ```ts
  it.each([{}, { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION: false }])('blocks an absent/false runtime capability', runtime => {
    expect(missingNetworkCheckPrerequisites(runtime)).toEqual([
      '#6353 network checks evaluate once per managed check independently of alert-device online status',
    ]);
  });
  it('accepts only the real runtime capability', () => {
    expect(missingNetworkCheckPrerequisites()).toEqual([]); // fails until extended #6353 ships
  });
  ```
  In isolated mocked-module service tests, use `vi.resetModules()`/`vi.doMock('../../alertConditions/handlers/networkCheck', () => ({ NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION: runtime.NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION }))` before dynamically importing `./networkChecks`; cover undefined and false exports (declare the mock property explicitly so Vitest's missing-export proxy does not throw; the pure helper above covers an absent key). Call the real preview/convert entry points with unrestricted org auth. Assert preview equals `{ orgId, previewHash: '', blockedBy: 'prerequisite_missing', missingPrerequisites: [theLabelAbove], items: [] }`, convert throws `ConversionPrerequisiteMissingError`, and no source reads/inserts/updates occur. Restore with `vi.doUnmock`/`vi.resetModules`. With the real export present and a pending representable row, assert `outcome: 'convertible'` and no reason; unsupported predicates still produce their exact mapper refusal. Add partner-service regressions in C1's existing `convert.test.ts`: missing network capability yields the prerequisite error before conversion/retirement writes; a mixed network refusal plus retired-runtime refusal remains distinct in the preview/hash (W05d Task 4 owns the sweep exclusion test).

  `monitorDefinitions.conversion.networkChecks.test.ts` — mirror the mocking style of `monitorDefinitions.test.ts` (mock `../services/monitors/conversion/networkChecks`), and assert: `GET /conversion/network-checks` without `orgId` → 400; with an org the caller cannot access → 403/404 per `canAccessOrg`; `POST …/convert` without MFA → the `requireMfa()` response; both GET preview and POST convert with `auth.allowedSiteIds` and `permissions.allowedSiteIds` set to `[]` or `[forbiddenSiteId]` → 403 `site_restricted_conversion`; happy path forwards `{ orgId, previewHash, sourceIds }` and returns the service result. Missing capability preview returns 200 with `blockedBy: 'prerequisite_missing'` and empty items; confirmation returns 409 `{ error: 'CONVERSION_PREREQUISITE_MISSING', missing: [...] }`, never a successful empty conversion.
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/api && npx vitest run src/services/monitors/conversion/networkChecks.test.ts src/routes/monitorDefinitions.conversion.networkChecks.test.ts` → `Failed to resolve import "./networkChecks"`.
- [ ] **Step 3: Implement.** `conversion/networkChecks.ts` (declare `NetworkCheckConversionPreview` from the Interfaces block in this file):
  ```ts
  import { createHash } from 'node:crypto';
  import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
  import { monitorConditionSchemas, NETWORK_CHECK_OPTION_KEYS } from '@breeze/shared';
  import type { AlertSeverity, NetworkCheckMonitorCondition } from '@breeze/shared';
  import { db } from '../../../db';
  import { alerts, configurationPolicies, configPolicyFeatureLinks, configPolicyMonitors, discoveredAssets, monitorConversionOutputs, monitorConversions, networkMonitorAlertRules, networkMonitors, organizations } from '../../../db/schema';
  import type { AuthContext } from '../../../middleware/auth';
  import { addFeatureLink, assignPolicy, createConfigPolicy } from '../../configurationPolicy';
  import { OPEN_ALERT_STATUSES } from './loadSources';
  import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
  import { carryNetworkAlerts, snapshotNetworkSource, retireNetworkCheck, revertNetworkCheckConversion } from './networkHistory';
  export { retireNetworkCheck, revertNetworkCheckConversion } from './networkHistory';
  import { createMonitorDefinition } from '../monitorService';
  import * as networkCheckRuntime from '../../alertConditions/handlers/networkCheck';
  import { ConversionPrerequisiteMissingError } from './prerequisites';
  import type { ConversionPreviewItem } from './types'; // W05c1 producer

  export const NETWORK_CHECK_UNCONVERTIBLE = {
    alreadyManaged: 'unconvertible:already_managed',
    noOrg: 'unconvertible:no_org',
    assetMissing: 'unconvertible:asset_missing',
    conditionInvalid: 'unconvertible:condition_invalid',
    noActiveRules: 'unconvertible:no_active_rules',
    multipleRules: 'unconvertible:multiple_network_rules',
    predicate: 'unconvertible:network_predicate_unsupported',
    threshold: 'unconvertible:network_threshold_out_of_range',
  } as const;

  export const NETWORK_CHECKS_POLICY_NAME = (orgName: string) => `Network checks — ${orgName}`;
  const MANAGED_NAME_PREFIX = '[monitor] ';
    const LEGACY_TO_CONDITION_KEY: Record<string, string> = { expectedStatus: 'expectStatus' };

  type Row = typeof networkMonitors.$inferSelect;
  type Rule = typeof networkMonitorAlertRules.$inferSelect;

  export interface NetworkCheckMapping {
    condition: NetworkCheckMonitorCondition;
    severity: AlertSeverity;
    deliveryMode: 'inherit' | 'none';
    description?: string;
    notes: string[];
  }

  function numeric(threshold: string | null): number | null {
    if (typeof threshold !== 'string' || threshold.trim() === '') return null;
    const n = Number(threshold);
    return Number.isFinite(n) ? n : null;
  }

  export function mapNetworkMonitorToDefinition(row: Row, rules: Rule[]): { ok: true; mapping: NetworkCheckMapping } | { ok: false; reason: string } {
    if (row.managedByMonitorId) return { ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.alreadyManaged };
    if (!row.orgId) return { ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.noOrg };
    const config = (row.config ?? {}) as Record<string, unknown>;
    const notes: string[] = [];

    const target = row.monitorType === 'http_check' && typeof config.url === 'string' ? config.url
      : row.monitorType === 'dns_check' && typeof config.hostname === 'string' ? config.hostname
      : row.target;
    const condition: Record<string, unknown> = {
      checkType: row.monitorType,
      target,
      ...(row.assetId ? { assetId: row.assetId } : {}),
      pollingIntervalSeconds: row.pollingInterval,
      timeoutSeconds: row.timeout,
    };
    const optionKeys = new Set<string>(NETWORK_CHECK_OPTION_KEYS[row.monitorType]);
    const ignored: string[] = [];
    for (const [legacyKey, value] of Object.entries(config)) {
      if (value === undefined || value === null) continue;
      if (legacyKey === 'url' || legacyKey === 'hostname') continue; // folded into target
      const key = LEGACY_TO_CONDITION_KEY[legacyKey] ?? legacyKey;
      if (optionKeys.has(key)) condition[key] = value; else ignored.push(legacyKey);
    }
    if (ignored.length > 0) notes.push(`Ignored config keys with no monitor equivalent: ${ignored.join(', ')}`);

    const active = rules.filter((r) => r.isActive && !r.retiredAt);
    if (active.length === 0) return { ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.noActiveRules };
    if (active.length !== 1) return { ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.multipleRules };
    const rule = active[0]!;
    let consecutive = 1;
    if (rule.condition === 'consecutive_failures_gt') {
      const n = numeric(rule.threshold);
      if (n == null || n < 0 || Math.floor(n) + 1 > 100) {
        return { ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.threshold };
      }
      consecutive = Math.floor(n) + 1;
    } else if (rule.condition !== 'offline') {
      return { ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.predicate };
    }
    const severity = rule.severity;
    const description = rule.message ?? undefined;
    const parsed = monitorConditionSchemas.network_check.safeParse({
      ...condition,
      consecutiveFailures: consecutive,
      degradedIsFailure: false,
    });
    if (!parsed.success) {
      return { ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.conditionInvalid };
    }
    return {
      ok: true,
      mapping: { condition: parsed.data, severity, deliveryMode: 'inherit', description, notes },
    };
  }
  ```
  Preview / convert / retire / revert / count (same file):
  ```ts
  function assertOrgAccess(orgId: string, auth: AuthContext): void {
    if (!canMutateOrgWideGovernance(auth)) throw new NetworkCheckConversionError('site_restricted_conversion', 403);
    if (!auth.canAccessOrg(orgId)) throw new NetworkCheckConversionError('org_not_found', 404);
  }
  export class NetworkCheckConversionError extends Error {
    constructor(public readonly code: 'org_not_found' | 'stale_preview' | 'site_restricted_conversion' | 'already_converted', public readonly status: 404 | 409 | 403) { super(code); this.name = 'NetworkCheckConversionError'; }
  }

  // Namespace lookup handles a server missing the export as well as false;
  // the flag belongs to #6353's real runtime fix, never to this converter.
  export function missingNetworkCheckPrerequisites(
    runtime: { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION?: unknown } = networkCheckRuntime as unknown as { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION?: unknown },
  ): string[] {
    return runtime.NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION === true ? []
      : ['#6353 network checks evaluate once per managed check independently of alert-device online status'];
  }
  function assertNetworkCheckPrerequisites(): void {
    const missing = missingNetworkCheckPrerequisites();
    if (missing.length) throw new ConversionPrerequisiteMissingError(missing);
  }

  async function loadPending(orgId: string, sourceIds?: string[]) {
    const where = [eq(networkMonitors.orgId, orgId), isNull(networkMonitors.managedByMonitorId), isNull(networkMonitors.retiredAt)];
    if (sourceIds?.length) where.push(inArray(networkMonitors.id, sourceIds));
    const rows = await db.select().from(networkMonitors).where(and(...where)).orderBy(networkMonitors.createdAt);
    const ids = rows.map((r) => r.id);
    const rules = ids.length ? await db.select().from(networkMonitorAlertRules).where(inArray(networkMonitorAlertRules.monitorId, ids)) : [];
    const assetIds = [...new Set(rows.map((r) => r.assetId).filter((a): a is string => !!a))];
    const assets = assetIds.length
      ? await db.select({ id: discoveredAssets.id }).from(discoveredAssets).where(and(inArray(discoveredAssets.id, assetIds), eq(discoveredAssets.orgId, orgId)))
      : [];
    const openAlerts = ids.length
      ? await db.select({ id: alerts.id, monitorId: sql<string>`${alerts.context}->>'monitorId'` }).from(alerts)
          .where(and(eq(alerts.orgId, orgId), inArray(alerts.status, [...OPEN_ALERT_STATUSES]), sql`${alerts.context}->>'source' = 'network_monitor'`, sql`${alerts.context}->>'monitorId' = ANY(${ids})`))
      : [];
    return { rows, rulesByMonitor: groupBy(rules, (r) => r.monitorId), assetIds: new Set(assets.map((a) => a.id)), openAlertsByMonitor: groupBy(openAlerts, (a) => a.monitorId) };
  }

  function previewHashFor(rows: Row[], rulesByMonitor: Map<string, Rule[]>): string {
    const material = rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt.toISOString(), rules: (rulesByMonitor.get(r.id) ?? []).map((x) => [x.id, x.condition, x.threshold, x.severity, x.isActive, x.retiredAt?.toISOString() ?? null]) }));
    return createHash('sha256').update(JSON.stringify(material)).digest('hex');
  }

  export async function previewNetworkCheckConversion(orgId: string, auth: AuthContext): Promise<NetworkCheckConversionPreview> {
    assertOrgAccess(orgId, auth);
    const missingPrerequisites = missingNetworkCheckPrerequisites();
    if (missingPrerequisites.length) return { orgId, previewHash: '', items: [],
      blockedBy: 'prerequisite_missing', missingPrerequisites };
    const { rows, rulesByMonitor, assetIds, openAlertsByMonitor } = await loadPending(orgId);
    const items = rows.map((row) => {
      const rules = rulesByMonitor.get(row.id) ?? [];
      const mapped = row.assetId && !assetIds.has(row.assetId)
        ? { ok: false as const, reason: NETWORK_CHECK_UNCONVERTIBLE.assetMissing }
        : mapNetworkMonitorToDefinition(row, rules);
      const openAlerts = (openAlertsByMonitor.get(row.id) ?? []).length;
      const notes = mapped.ok ? [...mapped.mapping.notes] : [];
      if (openAlerts > 0) notes.push(`${openAlerts} open alert(s) retain their status and history`);
      return {
        sourceTable: 'network_monitors' as const, sourceId: row.id, name: row.name,
        outcome: mapped.ok ? 'convertible' as const : 'unconvertible' as const,
        ...(mapped.ok ? {} : { reason: mapped.reason }),
        proposed: mapped.ok ? [{ role: 'primary' as const, kind: 'network_check' as const, name: row.name, condition: mapped.mapping.condition as Record<string, unknown>, severity: mapped.mapping.severity, enabled: row.isActive, cooldownMinutes: 5, autoResolve: true, deliveryMode: mapped.mapping.deliveryMode, deliveryChannelIds: [], escalationPolicyId: null, responses: [] }] : [],
        notes, openAlerts,
      };
    });
    return { orgId, previewHash: previewHashFor(rows, rulesByMonitor), items };
  }

  async function findOrCreateNetworkChecksPolicy(orgId: string, auth: AuthContext, tx: DbExecutor): Promise<{ policyId: string; monitorsLinkId: string }> {
    const actor = auth.scope === 'system' ? null : auth.user.id;
    // Reuse the policy of the most recent unreverted network conversion for
    // this org, so batches never sprawl into one policy per click.
    const [prior] = await tx
      .select({ policyId: monitorConversions.policyId })
      .from(monitorConversions)
      .innerJoin(configurationPolicies, eq(configurationPolicies.id, monitorConversions.policyId))
      .where(and(eq(monitorConversions.orgId, orgId), eq(monitorConversions.sourceTable, 'network_monitors'), isNull(monitorConversions.revertedAt), eq(configurationPolicies.status, 'active')))
      .orderBy(desc(monitorConversions.convertedAt))
      .limit(1);
    let policyId = prior?.policyId ?? null;
    if (!policyId) {
      const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      const policy = await createConfigPolicy({ orgId }, { name: NETWORK_CHECKS_POLICY_NAME(org?.name ?? orgId), description: 'Holds the network_check monitors converted from the Network page. Created by the W05e conversion.' }, actor, tx);
      if (!policy) throw new Error('Failed to create the network checks policy');
      await assignPolicy(policy.id, 'organization', orgId, 0, actor, undefined, undefined, tx);
      await addFeatureLink(policy.id, 'monitors', null, { items: [] }, undefined, tx);
      policyId = policy.id;
    }
    const [link] = await tx.select({ id: configPolicyFeatureLinks.id }).from(configPolicyFeatureLinks)
      .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'monitors'))).limit(1);
    if (!link) throw new Error(`Policy ${policyId} has no monitors feature link`);
    return { policyId, monitorsLinkId: link.id };
  }

  export async function convertNetworkChecks(orgId: string, previewHash: string, auth: AuthContext, opts: { sourceIds?: string[] } = {}) {
    assertOrgAccess(orgId, auth);
    assertNetworkCheckPrerequisites(); // before loading or mutating any sources
    const full = await loadPending(orgId);
    if (previewHashFor(full.rows, full.rulesByMonitor) !== previewHash) throw new NetworkCheckConversionError('stale_preview', 409);
    const selected = opts.sourceIds?.length ? full.rows.filter((r) => opts.sourceIds!.includes(r.id)) : full.rows;
    if (selected.length === 0) return { conversionIds: [], retired: 0, monitorsCreated: 0, policyId: null };
    return adoptNetworkChecksInTx(orgId, previewHash, auth, full, selected);
  }

  // Internal implementation; only reached after the prerequisite and preview
  // checks above. No public bypass parameter.
  async function adoptNetworkChecksInTx(orgId: string, previewHash: string, auth: AuthContext, full: Awaited<ReturnType<typeof loadPending>>, selected: Row[]) {

    // Same shape as ruleConversionService.ts:107-156 — one transaction, every
    // step through the services so RLS and audit see a normal caller.
    return db.transaction(async (tx) => {
      assertNetworkCheckPrerequisites();
      const convertible = selected.filter(row => (!row.assetId || full.assetIds.has(row.assetId))
        && mapNetworkMonitorToDefinition(row, full.rulesByMonitor.get(row.id) ?? []).ok);
      if (!convertible.length) return { conversionIds: [], retired: 0, monitorsCreated: 0, policyId: null };
      const { policyId, monitorsLinkId } = await findOrCreateNetworkChecksPolicy(orgId, auth, tx);
      const [{ nextSort }] = await tx.select({ nextSort: sql<number>`coalesce(max(${configPolicyMonitors.sortOrder}), -1) + 1` }).from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, monitorsLinkId));
      const conversionIds: string[] = [];
      let monitorsCreated = 0;
      let sort = Number(nextSort);
      for (const row of convertible) {
        const rules = full.rulesByMonitor.get(row.id) ?? [];
        const mapped = row.assetId && !full.assetIds.has(row.assetId) ? null : mapNetworkMonitorToDefinition(row, rules);
        if (!mapped || !mapped.ok) continue; // unconvertible: listed by the preview, retired only by an explicit retire
        const sourceSnapshot = await snapshotNetworkSource(tx, row);
        const def = await createMonitorDefinition({
          ownerScope: 'organization', orgId, name: row.name, description: mapped.mapping.description,
          kind: 'network_check', enabled: row.isActive, condition: mapped.mapping.condition as Record<string, unknown>,
          severity: mapped.mapping.severity, cooldownMinutes: 5, autoResolve: true, responses: [],
          deliveryMode: mapped.mapping.deliveryMode, deliveryChannelIds: [], escalationPolicyId: null,
          recurrenceActions: [], pauseResponsesOnEscalation: true,
        } as Parameters<typeof createMonitorDefinition>[0], auth, { adoptNetworkMonitorId: row.id }, tx);
        await tx.insert(configPolicyMonitors).values({ featureLinkId: monitorsLinkId, monitorId: def.id, enabled: row.isActive, sortOrder: sort++ });
        await tx.update(networkMonitorAlertRules).set({ retiredAt: new Date(), retiredReason: 'converted' })
          .where(and(eq(networkMonitorAlertRules.monitorId, row.id), isNull(networkMonitorAlertRules.retiredAt)));
        const movedAlertRefs = await carryNetworkAlerts(tx, row, def);
        const open = movedAlertRefs.map((a) => a.id);
        const [conv] = await tx.insert(monitorConversions).values({
          orgId, partnerId: null, sourceTable: 'network_monitors', sourceId: row.id, policyId, sourceState: { name: row.name },
          convertedBy: auth.scope === 'system' ? null : auth.user.id, previewHash, networkSourceSnapshot: sourceSnapshot,
        }).returning({ id: monitorConversions.id });
        await tx.insert(monitorConversionOutputs).values({ orgId, partnerId: null, conversionId: conv!.id, monitorId: def.id, role: 'primary', movedAlertIds: open, movedAlertRefs, reusedMonitor: false });
        conversionIds.push(conv!.id);
        monitorsCreated++;
      }
      return { conversionIds, retired: 0, monitorsCreated, policyId };
    });
  }

  export async function countPendingNetworkChecks(orgId: string, auth: AuthContext): Promise<number> {
    assertOrgAccess(orgId, auth);
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(networkMonitors)
      .where(and(eq(networkMonitors.orgId, orgId), isNull(networkMonitors.managedByMonitorId), isNull(networkMonitors.retiredAt)));
    return Number(r?.n ?? 0);
  }
  ```
  Local helpers (defined in this file, not assumed from a test harness):
  ```ts
  type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
  function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const row of rows) { const k = key(row); grouped.set(k, [...(grouped.get(k) ?? []), row]); }
    return grouped;
  }
  ```
  All reads and writes in `findOrCreateNetworkChecksPolicy` and `adoptNetworkChecksInTx` use `tx`, including `createConfigPolicy(owner, input, actor, tx)`, `assignPolicy(policyId, 'organization', orgId, 0, actor, undefined, undefined, tx)`, `addFeatureLink(policyId, 'monitors', null, { items: [] }, undefined, tx)`. `actor = auth.scope === 'system' ? null : auth.user.id` (D7). No nested global-db transaction or implicit executor fallback.

  W05c1 wiring in `conversion/convert.ts` (barrel exports in `index.ts`):
  ```ts
  // retireSource's network case returns the same zero-output ledger contract.
  if (sourceTable === 'network_monitors') return retireNetworkCheck(sourceId, reason, auth);
  // After the common isRevertAvailable check and authorization, before mutation:
  if (conversion.sourceTable === 'network_monitors') return revertNetworkCheckConversion(conversion, outputs.flatMap(o => o.monitorId ? [o.monitorId] : []), auth);
  ```
  `previewPartnerConversion(partnerId, auth)` checks network prerequisites before composing its preview: if any org's network preview has `blockedBy: 'prerequisite_missing'`, throw C1's `ConversionPrerequisiteMissingError(missingPrerequisites)` (HTTP 409 `CONVERSION_PREREQUISITE_MISSING`), never translate it into unconvertible source rows. With the capability present, incorporate every network item/refusal from each authorized org into D3's `rows`, `convertible`, `unconvertible` and hash. `convertPartnerLegacy(partnerId, previewHash, auth)` rechecks prerequisites and that complete hash before any mutation; it invokes `convertNetworkChecks` only for network preview items with `outcome === 'convertible'`. W05d Task 4 restricts `retirePreviewRefusals` to its five deleted-runtime source tables and excludes `network_monitors`; retain that exclusion so unsupported checks keep polling/alerting until explicitly retired by an operator. Preserve the original principal and never replace it with system scope. `loadSources.ts` pending helper and `routes/monitorDefinitions.conversion.ts` return `networkChecks: await countPendingNetworkChecks(orgId, auth)` only after the same full-org access guard. Network ledger reads use D2's existing paginated endpoint; `revertable` comes from D4.

  Routes (`routes/monitorDefinitions.conversion.ts`, W05c1's conversion subrouter, **before** `/:id`):
  ```ts
  // Reuse C1's alert-read/write middleware, or define these local aliases
  // with the same existing PERMISSIONS constants (monitorDefinitions.ts:73-74).
  const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
  const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
  const networkChecksQuerySchema = z.object({ orgId: z.string().uuid() });
  const networkChecksConvertSchema = z.object({ orgId: z.string().uuid(), previewHash: z.string().length(64), sourceIds: z.array(z.string().uuid()).max(500).optional() });

  function siteRestricted(c: Context): boolean {
    const permissions = c.get('permissions') as UserPermissions | undefined;
    return Array.isArray(permissions?.allowedSiteIds);
  }

  monitorConversionRoutes.get('/network-checks', requireScope('organization', 'partner', 'system'), requireAlertRead, zValidator('query', networkChecksQuerySchema), async (c) => {
    try {
      return c.json(await previewNetworkCheckConversion(c.req.valid('query').orgId, c.get('auth')));
    } catch (err) {
      if (err instanceof ConversionPrerequisiteMissingError) return c.json({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: err.missing }, 409);
      if (err instanceof NetworkCheckConversionError) return c.json({ error: err.code }, err.status);
      throw err;
    }
  });

  monitorConversionRoutes.post('/network-checks/convert', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), zValidator('json', networkChecksConvertSchema), async (c) => {
    // The conversion writes an ORG-assigned policy; a site-restricted technician
    // must not be able to widen their ceiling through it.
    if (siteRestricted(c)) return c.json({ error: 'site_restricted_conversion' }, 403);
    const body = c.req.valid('json');
    try {
      const result = await convertNetworkChecks(body.orgId, body.previewHash, c.get('auth'), { sourceIds: body.sourceIds });
      writeRouteAudit(c, { orgId: body.orgId, action: 'network_check.convert_to_monitor', resourceType: 'config_policy', resourceId: result.policyId ?? body.orgId, details: { monitorsCreated: result.monitorsCreated, sourceIds: body.sourceIds ?? null } });
      return c.json(result);
    } catch (err) {
      if (err instanceof ConversionPrerequisiteMissingError) return c.json({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: err.missing }, 409);
      if (err instanceof NetworkCheckConversionError) return c.json({ error: err.code }, err.status);
      throw err;
    }
  });
  ```
  Allowlists — `partner-wide-write-coverage.test.ts` (in the `network_monitors` block after line 71):
  `'services/monitors/conversion/networkChecks.ts': 'W05e conversion is org-axis only: every network_monitors write is scoped org_id = <org> AND managed_by_monitor_id IS NULL, and adoption in monitorCompiler.ts refuses a row outside the definition\'s org; a partner-wide (org_id NULL) row can never match',` also register `services/monitors/conversion/networkHistory.ts` with the org-axis snapshot/restore rationale, and the equivalent entries in `site-ceiling-write-coverage.test.ts` with reason `'preview, convert, retire and revert service entries call canMutateOrgWideGovernance before any source/configuration/alert read; an org-assigned policy requires an unrestricted caller'`.
- [ ] **Step 4: Run, expect PASS.**
  ```bash
  cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors/conversion/networkChecks.test.ts src/routes/monitorDefinitions.conversion.networkChecks.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts src/services/monitors/conversion
  ```
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/conversion apps/api/src/routes/monitorDefinitions.conversion.ts apps/api/src/routes/monitorDefinitions.conversion.networkChecks.test.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts apps/api/src/__tests__/site-ceiling-write-coverage.test.ts && git commit -m "feat(monitors): convert unmanaged network checks into network_check monitors through the conversion ledger"`

---

### Task 8: Legacy write paths return 410; results list exposes the managed link; asset delete preserves bound check history (PR1)

**Files:**
- Modify: `apps/api/src/routes/monitors.ts` (`POST /` 461-522, `PATCH /:id` 639-707, `POST /alerts` 870-905, `PATCH /alerts/:id` 925-957, `DELETE /alerts/:id` 959-986; dead schemas 223-238, 261-343; list projection 430-456)
- Modify: `apps/api/src/routes/monitors_list_create.test.ts`, `monitors_alerts.test.ts`, `monitors_detail.test.ts`
- Modify: `apps/api/src/routes/discovery.ts` (`DELETE /assets/:id`, 1699-1750)

**Interfaces:**
- Produces: `410 { error: 'network_check_authoring_retired', message, hint: { route: 'POST /monitor-definitions', kind: 'network_check' } }` on every retired write; `GET /monitors` items gain `managedByMonitorId: string | null`, `retiredAt: string | null`; query `includeRetired?: 'true'` (default excludes retired rows); `DELETE /discovery/assets/:id` → `409 { error: 'asset_has_retained_network_checks', monitorIds: string[] }`.
- Kept: `GET /monitors`, `GET /monitors/dashboard`, `GET /monitors/:id`, `GET /monitors/:id/results`, `GET /monitors/:monitorId/alerts` (read), `POST /monitors/:id/check`, `POST /monitors/:id/test`. `DELETE /monitors/:id` returns 410 for unmanaged checks; managed rows retain their existing 409 guard.

- [ ] **Step 1: Write the failing tests.** In `monitors_list_create.test.ts` replace every "creates a monitor" case with:
  ```ts
  it('POST /monitors is retired: 410 with a pointer to monitor definitions (W05e)', async () => {
    const res = await app.request('/monitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', monitorType: 'icmp_ping', target: '10.0.0.1' }) });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: 'network_check_authoring_retired', hint: { route: 'POST /monitor-definitions', kind: 'network_check' } });
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
  it('DELETE /monitors refuses destructive unmanaged cleanup', async () => {
    const res = await app.request(`/monitors/${MONITOR_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(410);
    expect(vi.mocked(db.delete)).not.toHaveBeenCalled();
  });
  ```
  In `monitors_alerts.test.ts` replace create/update/delete rule cases with 410 assertions (keep the `GET /:monitorId/alerts` read case). In `monitors_detail.test.ts` replace the PATCH cases with one 410 assertion (managed and unmanaged alike). Keep every 401/403 middleware case — the 410 sits **behind** `requireScope`/`requireMonitorWrite`/`requireMfa()`, so unauthenticated callers still get 401.
  For discovery, in `discovery.test.ts:2223` (`mockAssetOnly` at 2224; add `id/orgId/assetId/managedByMonitorId` to its `networkMonitors` schema mock at 134): seed a managed check bound to the asset and assert 409 with `monitorIds`; and `expect(db.transaction).not.toHaveBeenCalled()` so no delete is issued.
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/api && npx vitest run src/routes/monitors_list_create.test.ts src/routes/monitors_alerts.test.ts src/routes/monitors_detail.test.ts` → `expected 201 to be 410`.
- [ ] **Step 3: Implement.** `routes/monitors.ts`:
  ```ts
  // W05e — network checks are authored as monitors of kind `network_check`.
  // Every write that used to author a check or its alert rules is retired
  // (410 Gone, spec §Removed screens). Reads and operational check/test
  // endpoints stay. Unmanaged cleanup is retirement-only through the ledger.
  const NETWORK_CHECK_AUTHORING_RETIRED = {
    error: 'network_check_authoring_retired',
    message: 'Network checks are authored as monitors. Create or edit a monitor of kind network_check under Alerts → Monitors.',
    hint: { route: 'POST /monitor-definitions', kind: 'network_check' },
  } as const;
  const authoringRetired = (c: Context) => c.json(NETWORK_CHECK_AUTHORING_RETIRED, 410);
  ```
  Add `DELETE /:id` (lines 713-744) to the retired handlers; retain its managed-row 409 guard and replace the unmanaged deletion with `authoringRetired(c)`. Replace the other five handlers' bodies with `async (c) => authoringRetired(c)` while keeping their middleware chains (`requireScope(...)`, `requireMonitorWrite`, `requireMfa()`), drop their `zValidator` lines, and delete `validateMonitorConfigForType`, `icmpConfigSchema`…`dnsConfigSchema`, `createMonitorSchema`, `updateMonitorSchema`, `createAlertRuleSchema`, `updateAlertRuleSchema`, `monitorTypes` if now unused (keep `listMonitorsSchema` and add `includeRetired: z.enum(['true', 'false']).optional()`). In the list handler add `if (query.includeRetired !== 'true') conditions.push(isNull(networkMonitors.retiredAt));` and project `managedByMonitorId: m.managedByMonitorId, retiredAt: m.retiredAt?.toISOString() ?? null`. `POST /:id/check` and `/:id/test` keep working for managed rows too (they go through `requireMonitorAccess`, which only refuses partner-wide rows).
  `routes/discovery.ts` — before the transaction at ~1730:
  ```ts
  // W05e — a compiled network_check probe is bound to this asset. Any bound probe, including retired/unmanaged ones, owns
  // results or ledger history. Refuse implicit deletion through asset cleanup.
  const managedChecks = await db
    .select({ monitorId: networkMonitors.managedByMonitorId, checkId: networkMonitors.id })
    .from(networkMonitors)
    .where(and(eq(networkMonitors.assetId, assetId), eq(networkMonitors.orgId, existing.orgId)));
  if (managedChecks.length > 0) {
    return c.json({ error: 'asset_has_retained_network_checks', monitorIds: managedChecks.map((m) => m.monitorId).filter(Boolean), checkIds: managedChecks.map((m) => m.checkId) }, 409);
  }
  ```
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/routes/monitors src/routes/discovery src/services/aiToolsMonitoring.siteScope.test.ts` (check the reported file count — `src/routes/monitors` is a substring match and also pulls in `monitoring*.test.ts`; that is intended here).
- [ ] **Step 5: Commit.** `git add apps/api/src/routes/monitors.ts apps/api/src/routes/monitors_list_create.test.ts apps/api/src/routes/monitors_alerts.test.ts apps/api/src/routes/monitors_detail.test.ts apps/api/src/routes/discovery.ts apps/api/src/routes/discovery*.test.ts && git commit -m "feat(api): retire network-check authoring on /monitors (410); guard asset delete against managed checks"`

---

### Task 9: Integration proof — offline alert-device coverage, ownership, retirement ledger and reversal (PR1)

**Files:** Create `apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts`; consume existing `setup.ts` and `db-utils.ts:129,176,216,295` (`createUser`, `createPartner`, `createOrganization`, `createSite`).

**Interfaces:** Consumes Task 7 preview/convert and Task 6 history functions, D2 `retireSource` returning `{ conversionId }`, D4 lifecycle, `withDbAccessContext`/`withSystemDbAccessContext`. The public path requires the real #6353 capability; never mock it to make a production success test pass. Missing/false capability cases belong in Task 7 unit/HTTP regressions. Exercise public adoption with an offline alert device through the production scheduler/worker, plus carry-over and retirement/revert with suppressed and terminal history.

- [ ] **Step 1: Write the failing test.**
  ```ts
  import './setup';
  import { randomUUID } from 'node:crypto';
  import { Hono } from 'hono';
  import { describe, expect, it } from 'vitest';
  import { and, eq, sql } from 'drizzle-orm';
  import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
  import { alerts, devices, discoveredAssets, monitorConversions, monitorConversionOutputs,
    monitorDefinitions, networkMonitorAlertRules, networkMonitors, networkMonitorResults } from '../../db/schema';
  import { createPartner, createOrganization, createSite, createUser, createRole,
    grantRolePermissions, assignUserToOrganization } from './db-utils';
  import { PERMISSIONS } from '../../services/permissions';
  import { monitorConversionRoutes } from '../../routes/monitorDefinitions.conversion';
  import { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION } from '../../services/alertConditions/handlers/networkCheck';
  import { createAlertWorker, getAlertQueue, processEvaluateAll, shutdownAlertWorkers } from '../../jobs/alertWorker';
  import type { AuthContext } from '../../middleware/auth';
  import { previewNetworkCheckConversion, convertNetworkChecks } from '../../services/monitors/conversion/networkChecks';
  import { retireSource, revertConversion, OPEN_ALERT_STATUSES } from '../../services/monitors/conversion';
  import { carryNetworkAlerts, snapshotNetworkSource } from '../../services/monitors/conversion/networkHistory';
  import { createMonitorDefinition, updateMonitorDefinition } from '../../services/monitors/monitorService';

  async function fixture() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `network-${randomUUID()}@example.com` });
    const role = await createRole({ scope: 'organization', partnerId: partner.id, orgId: org.id });
    await grantRolePermissions(role.id, [PERMISSIONS.ALERTS_READ]);
    await assignUserToOrganization(user.id, org.id, role.id);
    const auth = { scope: 'organization', user, orgId: org.id, partnerId: partner.id,
      token: null, accessibleOrgIds: [org.id], partnerOrgAccess: null,
      canAccessOrg: (id: string) => id === org.id, orgCondition: () => eq(networkMonitors.orgId, org.id) } as AuthContext;
    const run = <T>(fn: () => Promise<T>) => withDbAccessContext({ scope: 'organization', orgId: org.id,
      accessibleOrgIds: [org.id], userId: user.id, currentPartnerId: partner.id }, fn);
    const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({ orgId: org.id, siteId: site.id,
      agentId: randomUUID(), hostname: 'network-test', osType: 'linux', osVersion: 'test', architecture: 'x86_64',
      agentVersion: 'test', status: 'offline', isEphemeral: false }).returning());
    const [asset] = await run(() => db.insert(discoveredAssets).values({ orgId: org.id, siteId: site.id,
      ipAddress: '192.0.2.1', linkedDeviceId: device!.id }).returning());
    const [check] = await run(() => db.insert(networkMonitors).values({ orgId: org.id, assetId: asset!.id,
      name: 'Gateway', monitorType: 'icmp_ping', target: '192.0.2.1', config: { count: 4 } }).returning());
    await run(() => db.insert(networkMonitorAlertRules).values({ monitorId: check!.id, condition: 'offline', severity: 'high' }));
    return { org, partner, auth, run, device: device!, asset: asset!, check: check! };
  }
  async function readLedger(f: Awaited<ReturnType<typeof fixture>>) {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => { c.set('auth', f.auth); await next(); });
    app.route('/monitor-definitions/conversion', monitorConversionRoutes);
    const response = await f.run(() => app.request(`/monitor-definitions/conversion/ledger?orgId=${f.org.id}`));
    expect(response.status).toBe(200);
    return await response.json() as { items: Array<{ id: string; sourceName: string; outputs: unknown[]; revertable: boolean }> };
  }
  describe('W05e network conversion contracts', () => {
    it('adopts a representable check and raises exactly one monitor alert on its offline alert device', async () => {
      expect(NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION).toBe(true);
      const f = await fixture(); // linked alert device starts OFFLINE
      const [prober] = await f.run(() => db.insert(devices).values({ orgId: f.org.id, siteId: f.device.siteId,
        agentId: randomUUID(), hostname: 'network-prober', osType: 'linux', osVersion: 'test', architecture: 'x86_64',
        agentVersion: 'test', status: 'online', lastSeenAt: new Date(), isEphemeral: false }).returning());
      const preview = await f.run(() => previewNetworkCheckConversion(f.org.id, f.auth));
      expect(preview.blockedBy).toBeUndefined();
      expect(preview.items[0]).toMatchObject({ outcome: 'convertible', sourceId: f.check.id });
      const converted = await f.run(() => convertNetworkChecks(f.org.id, preview.previewHash, f.auth));
      expect(converted.monitorsCreated).toBe(1);
      const [check] = await f.run(() => db.select().from(networkMonitors).where(eq(networkMonitors.id, f.check.id)));
      expect(check!.managedByMonitorId).toBeTruthy();
      expect(check!.retiredAt).toBeNull();
      await f.run(() => db.insert(networkMonitorResults).values({ monitorId: f.check.id, orgId: f.org.id,
        deviceId: prober!.id, status: 'offline', responseMs: null }));
      const worker = createAlertWorker();
      const failures: Error[] = [];
      worker.on('error', error => failures.push(error));
      worker.on('failed', (_job, error) => failures.push(error));
      const readAlerts = () => f.run(() => db.select().from(alerts).where(eq(alerts.orgId, f.org.id)));
      try {
        await worker.waitUntilReady();
        // Real scheduler entry point, outside any DB context. #6353 extends
        // this path to evaluate managed checks independently of online devices.
        // Never call evaluateDeviceAlerts(offlineId) directly: that would hide
        // the exact scheduler coverage regression this test must detect.
        await processEvaluateAll({ type: 'evaluate-all' });
        await expect.poll(async () => (await readAlerts()).length, { timeout: 15000 }).toBe(1);
        await expect.poll(async () => {
          const counts = await getAlertQueue().getJobCounts('wait', 'active', 'delayed');
          return Object.values(counts).reduce((sum, n) => sum + n, 0);
        }, { timeout: 15000 }).toBe(0);
        const rows = await readAlerts();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ deviceId: f.device.id, monitorId: check!.managedByMonitorId, status: 'active' });
        expect(failures).toEqual([]);
        const ledger = await readLedger(f);
        expect(ledger.items).toContainEqual(expect.objectContaining({ id: converted.conversionIds[0], sourceName: 'Gateway' }));
      } finally { await worker.close(); await shutdownAlertWorkers(); }
    }, 45000);
    it.each([[], ['33333333-3333-4333-8333-333333333333']])('forbids restricted preview and direct service conversion', async allowedSiteIds => {
      const f = await fixture();
      const auth = { ...f.auth, allowedSiteIds };
      await expect(f.run(() => previewNetworkCheckConversion(f.org.id, auth))).rejects.toMatchObject({ status: 403 });
      await expect(f.run(() => convertNetworkChecks(f.org.id, 'a'.repeat(64), auth))).rejects.toMatchObject({ status: 403 });
    });
    it('retirement records a zero-output ledger and restores exact enabled/retired states', async () => {
      const f = await fixture();
      await f.run(() => db.update(networkMonitors).set({ isActive: false }).where(eq(networkMonitors.id, f.check.id)));
      const sourceContext = { source: 'network_monitor', monitorId: f.check.id };
      const [open] = await f.run(() => db.insert(alerts).values({ orgId: f.org.id, deviceId: f.device.id,
        severity: 'high', title: 'Unreachable', status: 'suppressed', context: sourceContext }).returning());
      const { conversionId } = await f.run(() => retireSource('network_monitors', f.check.id, 'operator', f.auth));
      expect(await f.run(() => db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, conversionId)))).toEqual([]);
      const ledger = await readLedger(f); // real C1 Task 16 common GET, not a mocked projection
      expect(ledger.items).toContainEqual(expect.objectContaining({ id: conversionId, sourceName: 'Gateway', outputs: [], revertable: true }));
      await f.run(() => revertConversion(conversionId, f.auth));
      const [restored] = await f.run(() => db.select().from(networkMonitors).where(eq(networkMonitors.id, f.check.id)));
      expect(restored).toMatchObject({ isActive: false, retiredAt: null, retiredReason: null, name: 'Gateway' });
      const [history] = await f.run(() => db.select().from(alerts).where(eq(alerts.id, open!.id)));
      expect(history).toMatchObject({ status: 'suppressed', resolvedAt: null, context: sourceContext });
    });
    it('carries shared open alerts without touching terminal history', async () => {
      const f = await fixture();
      await f.run(() => db.insert(alerts).values([...OPEN_ALERT_STATUSES, 'resolved' as const, 'dismissed' as const].map(status => ({
        orgId: f.org.id, deviceId: f.device.id, severity: 'high' as const, title: status, status,
        context: { source: 'network_monitor', monitorId: f.check.id },
      }))));
      await f.run(() => db.transaction(async tx => {
        const definition = await createMonitorDefinition({ ownerScope: 'organization', orgId: f.org.id,
          name: 'Test', kind: 'network_check', enabled: false, condition: { checkType: 'icmp_ping', target: '192.0.2.1' },
          severity: 'high', cooldownMinutes: 5, autoResolve: true, responses: [], deliveryMode: 'inherit',
          deliveryChannelIds: [], recurrenceActions: [], pauseResponsesOnEscalation: true,
        }, f.auth, {}, tx);
        const refs = await carryNetworkAlerts(tx, f.check, definition);
        expect(refs).toHaveLength(OPEN_ALERT_STATUSES.length);
        const history = await tx.select().from(alerts).where(eq(alerts.orgId, f.org.id));
        expect(history.filter(a => a.monitorId === definition.id).map(a => a.status).sort()).toEqual([...OPEN_ALERT_STATUSES].sort());
        expect(history.filter(a => ['resolved', 'dismissed'].includes(a.status)).every(a => a.ruleId === null)).toBe(true);
      }));
    });
    it('reverts exact alert refs before compiled deletion and rehomes later history', async () => {
      const f = await fixture();
      const originalContext = { source: 'network_monitor', monitorId: f.check.id, note: 'retain me' };
      const [original] = await f.run(() => db.insert(alerts).values({ orgId: f.org.id, deviceId: f.device.id,
        severity: 'high', title: 'Original', status: 'suppressed', context: originalContext }).returning());
      // Isolate reference restoration with a disabled definition; the public
      // adoption/runtime path is exercised by the first test above.
      const { conversionId, definitionId, laterId } = await f.run(() => db.transaction(async tx => {
        const networkSourceSnapshot = await snapshotNetworkSource(tx, f.check);
        const def = await createMonitorDefinition({ ownerScope: 'organization', orgId: f.org.id,
          name: f.check.name, kind: 'network_check', enabled: false, condition: { checkType: 'icmp_ping', target: f.check.target },
          severity: 'high', cooldownMinutes: 5, autoResolve: true, responses: [], deliveryMode: 'inherit',
          deliveryChannelIds: [], recurrenceActions: [], pauseResponsesOnEscalation: true,
        }, f.auth, { adoptNetworkMonitorId: f.check.id }, tx);
        const movedAlertRefs = await carryNetworkAlerts(tx, f.check, def);
        const [entry] = await tx.insert(monitorConversions).values({ orgId: f.org.id, partnerId: null,
          sourceTable: 'network_monitors', sourceId: f.check.id, policyId: null, convertedBy: null,
          previewHash: 'a'.repeat(64), sourceState: { name: f.check.name }, networkSourceSnapshot }).returning();
        await tx.insert(monitorConversionOutputs).values({ orgId: f.org.id, partnerId: null, conversionId: entry!.id,
          monitorId: def.id, role: 'primary', movedAlertIds: movedAlertRefs.map(a => a.id), movedAlertRefs });
        const [later] = await tx.insert(alerts).values({ orgId: f.org.id, deviceId: f.device.id, ruleId: def.compiledAlertRuleId,
          monitorId: def.id, severity: 'high', title: 'Later', status: 'resolved', context: { detail: 'keep' } }).returning();
        return { conversionId: entry!.id, definitionId: def.id, laterId: later!.id };
      }));
      await f.run(() => updateMonitorDefinition(definitionId, { condition: { checkType: 'dns_check', target: 'example.com' } }, f.auth));
      await f.run(() => revertConversion(conversionId, f.auth));
      const [restored] = await f.run(() => db.select().from(alerts).where(eq(alerts.id, original!.id)));
      expect(restored).toMatchObject({ status: 'suppressed', ruleId: null, configPolicyId: null, monitorId: null, context: originalContext });
      const [later] = await f.run(() => db.select().from(alerts).where(eq(alerts.id, laterId)));
      expect(later).toMatchObject({ status: 'resolved', ruleId: null, monitorId: null,
        context: { detail: 'keep', source: 'network_monitor', monitorId: f.check.id } });
      expect(await f.run(() => db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, definitionId)))).toEqual([]);
      const [check] = await f.run(() => db.select().from(networkMonitors).where(eq(networkMonitors.id, f.check.id)));
      expect(check).toMatchObject({ managedByMonitorId: null, name: f.check.name, assetId: f.asset.id, monitorType: 'icmp_ping', config: { count: 4 } });
    });
    it('refuses reversal of a missing source before mutating its ledger', async () => {
      const f = await fixture();
      const { conversionId } = await f.run(() => retireSource('network_monitors', f.check.id, 'operator', f.auth));
      await f.run(() => db.delete(networkMonitors).where(eq(networkMonitors.id, f.check.id)));
      await expect(f.run(() => revertConversion(conversionId, f.auth))).rejects.toMatchObject({ code: 'source_not_found' });
      const [entry] = await f.run(() => db.select().from(monitorConversions).where(eq(monitorConversions.id, conversionId)));
      expect(entry!.revertedAt).toBeNull();
    });
    it('enforces the cross-org asset FK even under system access and declares it deferrable', async () => {
      const a = await fixture(); const b = await fixture();
      await expect(withSystemDbAccessContext(() => db.insert(networkMonitors).values({ orgId: a.org.id,
        assetId: b.asset.id, name: 'forged', monitorType: 'icmp_ping', target: '192.0.2.1' })))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
      const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT condeferrable, condeferred FROM pg_constraint
        WHERE conrelid = 'network_monitors'::regclass AND conname = 'network_monitors_asset_org_fk'`));
      expect(rows[0]).toMatchObject({ condeferrable: true, condeferred: false });
    });
  });
  ```
  `setup.ts` owns integration cleanup; fixtures use unique ids. The runtime test uses the existing `jobs/alertWorker.ts` exports `processEvaluateAll`, `createAlertWorker`, `getAlertQueue`, `shutdownAlertWorkers`; retain the #6353 scheduler integration through this production entry point, not a test-only offline evaluator. Close workers/queues before DB cleanup, and run against the private test stack. If the driver exposes SQLSTATE directly rather than in `cause`, assert `error.code ?? error.cause?.code` equals `23503` without accepting any other rejection.
- [ ] **Step 2: Run, expect FAIL.** `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/networkCheckConversion.integration.test.ts`. Before Tasks 1–8, missing history exports/FK cause failure; after implementation, wrong status/ownership is a genuine regression.
- [ ] **Step 3: Implement.** Wire Tasks 1–8 exactly; no offline-capability mock. Add the final lifecycle assertion:
  ```ts
  expect(isRevertAvailable('network_monitors')).toBe(true);
  expect(isRevertAvailable('config_policy_alert_rules')).toBe(false); // W05d retained guard
  ```
  Import it from `../../services/monitors/conversion/lifecycle`.
- [ ] **Step 4: Run, expect PASS.** Repeat Step 2 plus the real `tenant-export-policy.integration.test.ts`, `rls-coverage.integration.test.ts`, and `tenantCascade.integration.test.ts` suites with the same integration config. `pnpm test-stack down` from repo root afterward.
- [ ] **Step 5: Commit.** `git add apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts && git commit -m "test(monitors): offline network alert coverage ownership provenance and retirement round trip"`

---

### Task 10: Network page — nav label, titles, tabs, "New check" (PR2)

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (line 275), `Sidebar.nav.test.tsx` (lines 86, 179-185, 334)
- Modify: `apps/web/src/components/monitoring/MonitoringPage.tsx` (whole file, 135 lines), `MonitoringPage.test.tsx`
- Modify: `apps/web/src/locales/*/common.json` (`nav.networkMonitor`, `longTail.monitoring.MonitoringPage.*`), `apps/web/src/locales/*/pages.json` (`titles.monitoring`)

**Interfaces:**
- Produces: tabs `assets | templates | results`; hash `#checks` parsed as `results`; `MonitoringPage` "New check" button (`data-testid="monitoring-page-new-check"`) → `navigateTo('/alerts/monitors/new#kind=network_check[&assetId=…]')`.

- [ ] **Step 1: Write the failing tests.** `Sidebar.nav.test.tsx` — change the test at 179-185 to:
  ```ts
  it('labels /monitoring as Network — checks are authored under Alerts → Monitors (W05e)', () => {
    const item = navSections.find((s) => s.id === 'fleet-management')!.items.find((i) => i.href === '/monitoring')!;
    expect(item.name).toBe('Network');
    expect(item.labelKey).toBe('nav.networkMonitor');
  });
  ```
  and at 86 / 334 replace the string `'Network Monitor'` with `'Network'`. `MonitoringPage.test.tsx`:
  ```ts
  it('renders Assets · Templates · Results and maps the legacy #checks hash to Results', () => {
    window.history.pushState({}, '', '/monitoring#checks');
    render(<MonitoringPage />);
    expect(screen.getByText('Checks tab')).toBeInTheDocument(); // NetworkMonitorList stub
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(['Assets', 'SNMP Templates', 'Results']));
  });
  it('New check opens the monitor editor with kind network_check', () => {
    window.history.pushState({}, '', '/monitoring#results');
    render(<MonitoringPage />);
    fireEvent.click(screen.getByTestId('monitoring-page-new-check'));
    expect(navigateToMock).toHaveBeenCalledWith('/alerts/monitors/new#kind=network_check');
  });
  ```
  (mock `@/lib/navigation` → `{ navigateTo: navigateToMock }` at the top; change the existing `'Network Checks'` click to `'Results'`.)
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/web && npx vitest run src/components/layout/Sidebar.nav.test.tsx src/components/monitoring/MonitoringPage.test.tsx` → `expected 'Network Monitor' to be 'Network'`; `Unable to find an element by: [data-testid="monitoring-page-new-check"]`.
- [ ] **Step 3: Implement.** `Sidebar.tsx:275` → `{ name: 'Network', labelKey: 'nav.networkMonitor', href: '/monitoring', … }` and fix the comment above it ("the Network page: assets, SNMP templates and check results; checks are authored under Alerts → Monitors (W05e)"). `MonitoringPage.tsx`:
  ```ts
  const MONITORING_TABS = ['assets', 'templates', 'results'] as const;
  type MonitoringTab = (typeof MONITORING_TABS)[number];
  // `#checks` was the tab's hash until W05e; bookmarks keep working.
  const parseTab = (h: string): MonitoringTab | undefined =>
    h === 'checks' ? 'results' : (MONITORING_TABS as readonly string[]).includes(h) ? (h as MonitoringTab) : undefined;
  const [activeTab, setActiveTab] = useHashState<MonitoringTab>('assets', parseTab);
  {activeTab === 'results' && (
    <button type="button" data-testid="monitoring-page-new-check"
      onClick={() => void navigateTo(`/alerts/monitors/new#kind=network_check${initialAssetId ? `&assetId=${encodeURIComponent(initialAssetId)}` : ''}`)}
      className="flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">
      <Plus className="h-4 w-4" />
      {t('longTail.monitoring.MonitoringPage.newCheck')}
    </button>
  )}
  ```
  `onOpenChecks={() => navigateToTab('results')}`; `{activeTab === 'results' && <NetworkMonitorList assetId={initialAssetId} />}`; tab order Assets, Templates, Results. i18n (all 8 locales):
  - `nav.networkMonitor`: en "Network", de-DE "Netzwerk", es-419 "Red", fr-CA "Réseau", fr-FR "Réseau", it-IT "Rete", pt-BR "Rede", tr-TR "Ağ".
  - `pages.json` `titles.monitoring`: same values as above.
  - `longTail.monitoring.MonitoringPage.title`: same values. `.description`: en "Assets, SNMP templates and network-check results. Checks are authored as monitors under Alerts."; de-DE "Assets, SNMP-Vorlagen und Ergebnisse der Netzwerkprüfungen. Prüfungen werden als Monitore unter Warnungen erstellt."; es-419 "Activos, plantillas SNMP y resultados de verificaciones de red. Las verificaciones se crean como monitores en Alertas."; fr-CA/fr-FR "Actifs, modèles SNMP et résultats des vérifications réseau. Les vérifications sont créées comme moniteurs sous Alertes."; it-IT "Asset, modelli SNMP e risultati dei controlli di rete. I controlli si creano come monitor in Avvisi."; pt-BR "Ativos, modelos SNMP e resultados das verificações de rede. As verificações são criadas como monitores em Alertas."; tr-TR "Varlıklar, SNMP şablonları ve ağ denetimi sonuçları. Denetimler Uyarılar altında monitör olarak oluşturulur."
  - `tabs.results` (replace `tabs.checks`): en "Results", de-DE "Ergebnisse", es-419 "Resultados", fr-CA/fr-FR "Résultats", it-IT "Risultati", pt-BR "Resultados", tr-TR "Sonuçlar".
  - `newCheck`: en "New check", de-DE "Neue Prüfung", es-419 "Nueva verificación", fr-CA/fr-FR "Nouvelle vérification", it-IT "Nuovo controllo", pt-BR "Nova verificação", tr-TR "Yeni denetim".
- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/layout/Sidebar.nav.test.tsx src/components/monitoring/MonitoringPage.test.tsx src/lib/__tests__/i18n src/lib/__tests__/settingsPageRegistry.test.ts`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.nav.test.tsx apps/web/src/components/monitoring/MonitoringPage.tsx apps/web/src/components/monitoring/MonitoringPage.test.tsx apps/web/src/locales && git commit -m "feat(web): Network Monitor becomes Network — Assets · Templates · Results, New check opens the monitor editor"`

---

### Task 11: Results tab is read-only; conversion banner; device page hands off to the editor (PR2)

**Files:**
- Modify: `apps/web/src/components/monitors/NetworkMonitorList.tsx` (lines 21-22, 99, 239-247, 265-277, 342-350, 361-371)
- Create: `apps/web/src/components/monitors/NetworkMonitorList.test.tsx`, `NetworkCheckConversionBanner.tsx`, `NetworkCheckConversionBanner.test.tsx`
- Modify: `apps/web/src/components/monitors/MonitorDetailModal.tsx` (remove 105-111 edit state, 151-180 `handleSave`, 287-371 edit button + form, 413-437 alert rules), `MonitorDetailModal.test.tsx`
- Delete: `apps/web/src/components/monitors/CreateMonitorForm.tsx`
- Modify: `apps/web/src/components/devices/networkDevice/settings/MonitoringSection.tsx` (lines 5, 67, 337-340), `useNetworkAssetMutations.ts` (lines 171-187), `useNetworkAssetMutations.test.ts`
- Modify: `apps/web/src/locales/*/common.json`, `*/devices.json`

**Interfaces:**
- Consumes: `GET /monitors` items with `managedByMonitorId`; `GET /monitor-definitions/conversion/network-checks?orgId`; `POST /monitor-definitions/conversion/network-checks/convert`.
- Produces: `NetworkCheckConversionBanner({ orgId, onConverted })` — shows "N network checks are not monitors yet" with **Review and convert** → dialog listing each item (name, outcome, notes) → **Convert N** (runAction) → `onConverted()`. `NetworkMonitorList` row: Monitor column (`Open monitor` link to `/alerts/monitors/<id>` or a `Not converted` badge); No Delete affordance. The dialog adds a per-check Retire action (including refused checks) via C2 Task 1's `conversionPaths.retire()`/`retireBody(...)` and `runAction`. Persist history with C2 Task 8's `ConversionLedger({ orgId?, policyId?, revision?, onChanged? })` from `apps/web/src/components/monitoring/conversion/ConversionLedger.tsx`, mounted even when pending items are empty; conversion, retirement and Undo refresh preview, results and history.

- [ ] **Step 1: Write the failing tests.** `NetworkMonitorList.test.tsx`:
  ```ts
  import '@/lib/i18n';
  import { render, screen } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';
  vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
  vi.mock('./NetworkCheckConversionBanner', () => ({ default: () => <div data-testid="conversion-banner" /> }));
  import { fetchWithAuth } from '../../stores/auth';
  import NetworkMonitorList from './NetworkMonitorList';
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
  const row = (over = {}) => ({ id: 'nm-1', orgId: 'org-1', assetId: null, name: 'Gateway', monitorType: 'icmp_ping', target: '10.0.0.1', config: {}, pollingInterval: 60, timeout: 5, isActive: true, lastChecked: null, lastStatus: 'unknown', lastResponseMs: null, lastError: null, consecutiveFailures: 0, managedByMonitorId: null, retiredAt: null, createdAt: '', updatedAt: '', ...over });

  describe('NetworkMonitorList (read-only results, W05e)', () => {
    it('links a managed check to its monitor and offers no delete for it', async () => {
      vi.mocked(fetchWithAuth).mockImplementation(async () => json({ data: [row({ managedByMonitorId: 'def-1' })] }));
      render(<NetworkMonitorList />);
      const link = await screen.findByTestId('network-check-open-monitor');
      expect(link).toHaveAttribute('href', '/alerts/monitors/def-1');
      expect(screen.queryByTestId('network-check-delete')).toBeNull();
      expect(screen.queryByText(/add monitor/i)).toBeNull();
    });
    it('marks an unconverted check and renders the conversion banner', async () => {
      vi.mocked(fetchWithAuth).mockImplementation(async () => json({ data: [row()] }));
      render(<NetworkMonitorList />);
      expect(await screen.findByTestId('network-check-not-converted')).toBeInTheDocument();
      expect(screen.getByTestId('conversion-banner')).toBeInTheDocument();
    });
  });
  ```
  `NetworkCheckConversionBanner.test.tsx`: preview returns 2 items (one convertible with a note, one unconvertible) → banner text "2 network checks…", dialog lists both, the unconvertible shows its reason; clicking Convert posts `{ orgId, previewHash, sourceIds: [convertibleId] }` and calls `onConverted`. `MonitorDetailModal.test.tsx:23-35`: move the `open()` helper wait change here from PR1: await `monitor-check-open-monitor` when the fixture is managed, otherwise `monitor-check-not-converted`. Remove its obsolete `onDeleted` prop along with the component callback. Delete all PATCH/edit cases and the unused `patchBody()` helper; add "shows Open monitor for a managed check and no edit button" and "shows Not converted for an unmanaged check". `useNetworkAssetMutations.test.ts`: remove the `createCheck` case; assert the hook no longer exposes it (`expect('createCheck' in result.current).toBe(false)`).
  Add this real banner + C2 ledger integration regression to `NetworkCheckConversionBanner.test.tsx` (do not stub `ConversionLedger` or `runAction`):
  ```tsx
  import '@/lib/i18n';
  import { fireEvent, render, screen, waitFor } from '@testing-library/react';
  import { beforeEach, expect, it, vi } from 'vitest';
  import { fetchWithAuth } from '../../stores/auth';
  import { showToast } from '../shared/Toast';
  import NetworkCheckConversionBanner from './NetworkCheckConversionBanner';
  vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
  const request = vi.mocked(fetchWithAuth);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  beforeEach(() => vi.resetAllMocks());
  it.each(['convertible', 'unconvertible'] as const)('retires a %s check, retains history when empty, and undoes it', async outcome => {
    let retired = false;
    let undone = false;
    const item = { sourceTable: 'network_monitors', sourceId: 'check-1', name: 'Gateway', outcome,
      ...(outcome === 'unconvertible' ? { reason: 'unconvertible:network_predicate_unsupported' } : {}), notes: [], openAlerts: 0 };
    request.mockImplementation(async (url, init) => {
      if (url === '/monitor-definitions/conversion/retire') { retired = true; return json({ conversionId: 'c1' }); }
      if (url === '/monitor-definitions/conversion/c1/revert') { retired = false; undone = true; return json({ success: true }); }
      if (String(url).startsWith('/monitor-definitions/conversion/ledger?')) return json({ nextCursor: null,
        items: retired || undone ? [{ id: 'c1', sourceTable: 'network_monitors', sourceId: 'check-1', sourceName: 'Gateway',
          policyId: null, convertedBy: null, convertedAt: '2026-09-19T00:00:00Z',
          revertedAt: undone ? '2026-09-20T00:00:00Z' : null, revertable: !undone, outputs: [] }] : [] });
      if (String(url).startsWith('/monitor-definitions/conversion/network-checks?'))
        return json({ orgId: 'org-1', previewHash: 'a'.repeat(64), items: retired ? [] : [item] });
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const refreshResults = vi.fn();
    render(<NetworkCheckConversionBanner orgId="org-1" onConverted={refreshResults} />);
    fireEvent.click(await screen.findByTestId('network-check-conversion-review'));
    fireEvent.click(screen.getByTestId('network-check-retire-check-1'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/monitor-definitions/conversion/retire', {
      method: 'POST', body: JSON.stringify({ sourceTable: 'network_monitors', sourceId: 'check-1', reason: 'operator' }),
    }));
    await waitFor(() => expect(screen.queryByTestId('network-check-conversion-banner')).not.toBeInTheDocument());
    expect(refreshResults).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('ledger-undo-c1')).toBeEnabled();
    expect(screen.getByTestId('conversion-ledger')).toHaveTextContent('Gateway');
    fireEvent.click(screen.getByTestId('ledger-undo-c1'));
    await waitFor(() => expect(refreshResults).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('network-check-conversion-review')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('ledger-undo-c1')).toBeDisabled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('shows blocked-empty prerequisites without offering conversion or retirement', async () => {
    request.mockImplementation(async url => json(String(url).includes('/ledger?') ? { items: [], nextCursor: null }
      : { orgId: 'org-1', previewHash: '', items: [], blockedBy: 'prerequisite_missing' }));
    render(<NetworkCheckConversionBanner orgId="org-1" onConverted={vi.fn()} />);
    expect(await screen.findByTestId('network-check-conversion-blocked')).toHaveTextContent(/prerequisite/i);
    expect(screen.queryByTestId('network-check-conversion-review')).not.toBeInTheDocument();
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  ```
  Also cover failed retirement (409 and network rejection): error feedback appears, results/history never report success, and the row stays available for review/retry. Keep the existing conversion success test.
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/web && npx vitest run src/components/monitors src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts` → `Failed to resolve import "./NetworkCheckConversionBanner"`, `Unable to find … network-check-open-monitor`.
- [ ] **Step 3: Implement.**
  `NetworkCheckConversionBanner.tsx`:
  ```tsx
  import { useCallback, useEffect, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth } from '../../stores/auth';
  import { ActionError, runAction } from '../../lib/runAction';
  import { showToast } from '../shared/Toast';
  import { Dialog } from '../shared/Dialog';
  import { conversionPaths, retireBody } from '../monitoring/conversion/conversionApi';
  import ConversionLedger from '../monitoring/conversion/ConversionLedger';

  type Item = { sourceId: string; name: string; outcome: 'convertible' | 'unconvertible'; reason?: string; notes: string[]; openAlerts: number };
  type Preview = { orgId: string; previewHash: string; blockedBy?: 'prerequisite_missing'; missingPrerequisites?: string[]; items: Item[] };

  export default function NetworkCheckConversionBanner({ orgId, onConverted }: { orgId: string; onConverted: () => void }) {
    const { t } = useTranslation(['common', 'monitoring']);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [open, setOpen] = useState(false);
    const [converting, setConverting] = useState(false);
    const [retiringId, setRetiringId] = useState<string | null>(null);
    const [ledgerRevision, setLedgerRevision] = useState(0);

    const load = useCallback(async () => {
      const res = await fetchWithAuth(`/monitor-definitions/conversion/network-checks?orgId=${encodeURIComponent(orgId)}`);
      if (!res.ok) { setPreview(null); return; }
      setPreview((await res.json()) as Preview);
    }, [orgId]);
    useEffect(() => { void load(); }, [load]);

    const convertible = preview?.items.filter((i) => i.outcome === 'convertible') ?? [];
    const busy = converting || retiringId !== null;
    const refresh = async () => {
      setLedgerRevision(n => n + 1);
      onConverted(); // refresh results after conversion, retirement OR Undo
      await load();
    };

    const convert = async () => {
      if (!preview || preview.blockedBy || busy || convertible.length === 0) return;
      setConverting(true);
      try {
        await runAction({
          request: () => fetchWithAuth('/monitor-definitions/conversion/network-checks/convert', {
            method: 'POST',
            body: JSON.stringify({ orgId, previewHash: preview.previewHash, sourceIds: convertible.map((i) => i.sourceId) }),
          }),
          successMessage: t('longTail.monitors.NetworkCheckConversionBanner.converted', { count: convertible.length }),
          errorFallback: t('longTail.monitors.NetworkCheckConversionBanner.failed'),
        });
        setOpen(false);
        await refresh();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('longTail.monitors.NetworkCheckConversionBanner.failed') });
      } finally {
        setConverting(false);
      }
    };

    const retire = async (item: Item) => {
      if (!preview || preview.blockedBy || busy) return;
      setRetiringId(item.sourceId);
      try {
        await runAction({
          request: () => fetchWithAuth(conversionPaths.retire(), {
            method: 'POST',
            body: JSON.stringify(retireBody('network_monitors', item.sourceId, 'operator')),
          }),
          successMessage: t('monitoring:conversion.retired', { name: item.name }),
          errorFallback: t('monitoring:conversion.errors.retire'),
        });
        await refresh();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:conversion.errors.retire') });
      } finally { setRetiringId(null); }
    };

    return <>
      {preview?.blockedBy && <p role="alert" data-testid="network-check-conversion-blocked">
        {t('monitoring:conversion.blocked.prerequisite_missing')}
      </p>}
      {preview && !preview.blockedBy && preview.items.length > 0 && (
      <div data-testid="network-check-conversion-banner" className="flex items-center justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
        <span>{t('longTail.monitors.NetworkCheckConversionBanner.pending', { count: preview.items.length })}</span>
        <button type="button" data-testid="network-check-conversion-review" onClick={() => setOpen(true)} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted">
          {t('longTail.monitors.NetworkCheckConversionBanner.review')}
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title={t('longTail.monitors.NetworkCheckConversionBanner.title')} maxWidth="2xl">
          <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
            {preview.items.map((item) => (
              <li key={item.sourceId} data-testid={`network-check-conversion-item-${item.outcome}`} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between"><span className="font-medium">{item.name}</span>
                  <span className={item.outcome === 'convertible' ? 'text-success' : 'text-destructive'}>{t(/* i18n-dynamic */ `longTail.monitors.NetworkCheckConversionBanner.outcome.${item.outcome}`)}</span></div>
                {item.reason && <p className="text-xs text-destructive">{item.reason}</p>}
                {item.notes.map((n, i) => <p key={i} className="text-xs text-muted-foreground">{n}</p>)}
                <button type="button" data-testid={`network-check-retire-${item.sourceId}`} disabled={busy}
                  onClick={() => void retire(item)}>{t('monitoring:conversion.retire')}</button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-md border px-4 text-sm">{t('common:actions.cancel')}</button>
            <button type="button" data-testid="network-check-conversion-confirm" disabled={busy || convertible.length === 0} onClick={() => void convert()} className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">
              {t('longTail.monitors.NetworkCheckConversionBanner.convert', { count: convertible.length })}
            </button>
          </div>
        </Dialog>
      </div>)}
      <ConversionLedger orgId={orgId} revision={ledgerRevision} onChanged={() => void refresh()} />
    </>;
  }
  ```
  `NetworkMonitorList.tsx`: drop `CreateMonitorForm` import/state (21, 99, 361-371); type gains `managedByMonitorId: string | null; retiredAt: string | null`; replace the Add Monitor button (239-247) with a link-styled button to `navigateTo('/alerts/monitors/new#kind=network_check' + (filterAssetId ? `&assetId=${encodeURIComponent(filterAssetId)}` : ''))` labelled `actions.newCheck`; empty state (265-277) → `empty.prefix` "No network checks yet." + the same navigate; add a **Monitor** column after Target: managed → `<a data-testid="network-check-open-monitor" href={`/alerts/monitors/${monitor.managedByMonitorId}`}>{t('longTail.monitors.NetworkMonitorList.headers.openMonitor')}</a>`, else `<span data-testid="network-check-not-converted" className="rounded-full bg-warning/15 px-2 py-0.5 text-xs">{t('longTail.monitors.NetworkMonitorList.notConverted')}</span>`; remove the delete button (342-350), delete state, confirmation dialog and `handleConfirmDelete`; render `<NetworkCheckConversionBanner key={currentOrgId} orgId={currentOrgId} onConverted={fetchMonitors} />` above the table when `currentOrgId && !filterAssetId`, outside loading/empty-results returns so zero pending checks never hide the ledger. Remount on org changes to clear stale preview/history. Wrap `handleCheck` in `runAction` (it is POST — `no-silent-mutations.test.ts` will flag the file once it is touched; check `apps/web/src/lib/runActionAllowlist.ts` first).
  `MonitorDetailModal.tsx`: remove the edit state, `handleSave`, the Edit button and form, and the Alert Rules section; type gains `managedByMonitorId: string | null`; after the status bar render:
  ```tsx
  {monitor.managedByMonitorId
    ? <a data-testid="monitor-check-open-monitor" href={`/alerts/monitors/${monitor.managedByMonitorId}`} className="mt-3 inline-block text-sm text-primary hover:underline">{t('longTail.monitors.MonitorDetailModal.openMonitor')}</a>
    : <p data-testid="monitor-check-not-converted" className="mt-3 text-sm text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.notConverted')}</p>}
  ```
  and remove the footer Delete and its `onDeleted` prop/callback entirely (including the `NetworkMonitorList.tsx` caller). Delete `CreateMonitorForm.tsx`. `MonitoringSection.tsx`: remove the import (5) and `addingCheck` render (337-340); the Add check button navigates to `/alerts/monitors/new#kind=network_check&assetId=${assetId}` and a hint line `networkDeviceDetailPage.settings.monitoring.addCheckHint` sits under the checks list. `useNetworkAssetMutations.ts`: delete `createCheck` (171-179) and `deleteCheck` (181-187), their interface members, and the device settings delete button/callback; all check cleanup goes through ledger retirement.
  Delete `actions.addMonitor`, the retired detail editing/alert-rule keys, the whole `CreateMonitorForm` block and the device check-created/check-create-failed keys in all locales. Apply these translations to the following ordered keys (first 16 in `common.json`, last in `devices.json`):
  ```ts
  const keys = [
    'longTail.monitors.NetworkMonitorList.actions.newCheck',
    'longTail.monitors.NetworkMonitorList.headers.monitor',
    'longTail.monitors.NetworkMonitorList.headers.openMonitor',
    'longTail.monitors.NetworkMonitorList.notConverted',
    'longTail.monitors.NetworkMonitorList.empty.prefix',
    'longTail.monitors.NetworkMonitorList.empty.action',
    'longTail.monitors.MonitorDetailModal.openMonitor',
    'longTail.monitors.MonitorDetailModal.notConverted',
    'longTail.monitors.NetworkCheckConversionBanner.pending',
    'longTail.monitors.NetworkCheckConversionBanner.review',
    'longTail.monitors.NetworkCheckConversionBanner.title',
    'longTail.monitors.NetworkCheckConversionBanner.convert',
    'longTail.monitors.NetworkCheckConversionBanner.converted',
    'longTail.monitors.NetworkCheckConversionBanner.failed',
    'longTail.monitors.NetworkCheckConversionBanner.outcome.convertible',
    'longTail.monitors.NetworkCheckConversionBanner.outcome.unconvertible',
    'networkDeviceDetailPage.settings.monitoring.addCheckHint',
  ];
  const translations = {
    en: ['New check', 'Monitor', 'Open monitor', 'Not converted', 'No network checks yet.', 'Create a monitor.', 'Open the monitor for this check', 'Review conversion on the Results tab.', '{{count}} network checks need review.', 'Review conversion', 'Network check conversion', 'Convert {{count}}', 'Converted {{count}} network checks', 'Could not convert network checks', 'Convertible', 'Cannot convert', 'Add check opens the monitor editor with this asset selected.'],
    'de-DE': ['Neue Prüfung', 'Monitor', 'Monitor öffnen', 'Nicht konvertiert', 'Noch keine Netzwerkprüfungen.', 'Monitor erstellen.', 'Monitor dieser Prüfung öffnen', 'Konvertierung im Tab Ergebnisse prüfen.', '{{count}} Netzwerkprüfungen erfordern eine Prüfung.', 'Konvertierung prüfen', 'Netzwerkprüfungen konvertieren', '{{count}} konvertieren', '{{count}} Netzwerkprüfungen konvertiert', 'Netzwerkprüfungen konnten nicht konvertiert werden', 'Konvertierbar', 'Nicht konvertierbar', 'Prüfung hinzufügen öffnet den Monitor-Editor mit diesem Asset.'],
    'es-419': ['Nueva verificación', 'Monitor', 'Abrir monitor', 'Sin convertir', 'Aún no hay verificaciones de red.', 'Crear un monitor.', 'Abrir el monitor de esta verificación', 'Revisa la conversión en Resultados.', '{{count}} verificaciones de red requieren revisión.', 'Revisar conversión', 'Conversión de verificaciones de red', 'Convertir {{count}}', 'Se convirtieron {{count}} verificaciones de red', 'No se pudieron convertir las verificaciones de red', 'Convertible', 'No se puede convertir', 'Agregar verificación abre el editor de monitores con este activo seleccionado.'],
    'fr-CA': ['Nouvelle vérification', 'Moniteur', 'Ouvrir le moniteur', 'Non converti', 'Aucune vérification réseau.', 'Créer un moniteur.', 'Ouvrir le moniteur de cette vérification', 'Vérifiez la conversion dans Résultats.', '{{count}} vérifications réseau sont à examiner.', 'Examiner la conversion', 'Conversion des vérifications réseau', 'Convertir {{count}}', '{{count}} vérifications réseau converties', 'Impossible de convertir les vérifications réseau', 'Convertible', 'Conversion impossible', 'Ajouter une vérification ouvre le moniteur avec cet actif sélectionné.'],
    'fr-FR': ['Nouvelle vérification', 'Moniteur', 'Ouvrir le moniteur', 'Non converti', 'Aucune vérification réseau.', 'Créer un moniteur.', 'Ouvrir le moniteur de cette vérification', 'Vérifiez la conversion dans Résultats.', '{{count}} vérifications réseau sont à examiner.', 'Examiner la conversion', 'Conversion des vérifications réseau', 'Convertir {{count}}', '{{count}} vérifications réseau converties', 'Impossible de convertir les vérifications réseau', 'Convertible', 'Conversion impossible', 'Ajouter une vérification ouvre le moniteur avec cet actif sélectionné.'],
    'it-IT': ['Nuovo controllo', 'Monitor', 'Apri monitor', 'Non convertito', 'Nessun controllo di rete.', 'Crea un monitor.', 'Apri il monitor di questo controllo', 'Esamina la conversione in Risultati.', '{{count}} controlli di rete da esaminare.', 'Esamina conversione', 'Conversione dei controlli di rete', 'Converti {{count}}', '{{count}} controlli di rete convertiti', 'Impossibile convertire i controlli di rete', 'Convertibile', 'Non convertibile', 'Aggiungi controllo apre il monitor con questo asset selezionato.'],
    'pt-BR': ['Nova verificação', 'Monitor', 'Abrir monitor', 'Não convertido', 'Nenhuma verificação de rede.', 'Criar um monitor.', 'Abrir o monitor desta verificação', 'Revise a conversão em Resultados.', '{{count}} verificações de rede precisam de revisão.', 'Revisar conversão', 'Conversão de verificações de rede', 'Converter {{count}}', '{{count}} verificações de rede convertidas', 'Não foi possível converter as verificações de rede', 'Conversível', 'Não é possível converter', 'Adicionar verificação abre o monitor com este ativo selecionado.'],
    'tr-TR': ['Yeni denetim', 'Monitör', 'Monitörü aç', 'Dönüştürülmedi', 'Henüz ağ denetimi yok.', 'Monitör oluştur.', 'Bu denetimin monitörünü aç', 'Dönüşümü Sonuçlar sekmesinde inceleyin.', '{{count}} ağ denetimi inceleme bekliyor.', 'Dönüşümü incele', 'Ağ denetimi dönüşümü', '{{count}} öğeyi dönüştür', '{{count}} ağ denetimi dönüştürüldü', 'Ağ denetimleri dönüştürülemedi', 'Dönüştürülebilir', 'Dönüştürülemez', 'Denetim ekle, bu varlık seçili olarak monitör düzenleyicisini açar.'],
  };
  ```
  The API refusal reason is displayed alongside each unsupported item; Convert is disabled when no item is convertible. D20's blocked-empty preview displays C2's `monitoring:conversion.blocked.prerequisite_missing` copy and offers neither Convert nor Retire. With the capability present, representable items convert. The new per-check Retire action posts exactly `{ sourceTable: 'network_monitors', sourceId, reason: 'operator' }`; C2's persistent ledger supplies Undo, not retirement. Reuse C2 Task 5's translated `conversion.retire`, `conversion.retired`, `conversion.errors.retire` and prerequisite keys in all eight locales. Keep the ledger mounted after retiring the last check.
- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/monitors src/components/devices/networkDevice src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/i18n`
- [ ] **Step 5: Commit.** `git add -A apps/web/src/components/monitors apps/web/src/components/devices/networkDevice/settings apps/web/src/locales && git commit -m "feat(web): Results tab is read-only with a conversion banner; device page hands check creation to the monitor editor"`

---

### Task 12: Monitor editor — `#kind`/`assetId` prefill and the asset picker and option round-trip (PR2)

**Files:**
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (props at 137-139; mount effect near 343-353; condition section render)
- Create: `apps/web/src/components/monitoring/NetworkCheckAssetBinding.tsx`, `NetworkCheckAssetBinding.test.tsx`
- Modify: `apps/web/src/components/monitoring/MonitorEditor.test.tsx`
- Modify: `apps/web/src/locales/*/monitoring.json` (`editor.networkCheckAsset.*`)

**Interfaces:**
- Consumes: `GET /discovery/assets/:id` (`routes/discovery.ts:1184,1263`; the response envelope is `{ data: asset }`).
- Produces: on a new monitor, `#kind=<MonitorKind>` selects the kind (and `defaultConditionFor(kind)`); `assetId=<uuid>` in the hash with `kind=network_check` sets `condition.assetId`, `condition.target = asset.ipAddress ?? asset.hostname`, and a default name `Ping <label>` (icmp) if the name is empty. `NetworkCheckAssetBinding({ orgId, assetId, onSelect })` loads the org-scoped asset list, selects/unbinds assets, and preserves API-only `packetSize`/`headers` on every save. Partner ownership disables binding; changing to partner ownership clears `assetId` explicitly.

- [ ] **Step 1: Write the failing test** (`MonitorEditor.test.tsx`, following its existing `fetchWithAuth` mocking):
  ```ts
  it('prefills kind and asset from the hash for a new monitor (W05e)', async () => {
    window.history.pushState({}, '', '/alerts/monitors/new#kind=network_check&assetId=11111111-1111-4111-8111-111111111111');
    const asset = { id: '11111111-1111-4111-8111-111111111111', label: 'Core switch', ipAddress: '10.0.0.2', hostname: 'core-sw', orgId: 'org-1' };
    fetchMock.mockImplementation(async (input) => input === `/discovery/assets/${asset.id}` ? json({ data: asset })
      : input.startsWith('/discovery/assets?') ? json({ data: [asset] }) : defaultFetchImpl(input));
    render(<MonitorEditor />);
    expect(await screen.findByRole('option', { name: 'Core switch' })).toBeInTheDocument();
    expect((screen.getByLabelText('Target') as HTMLInputElement).value).toBe('10.0.0.2');
    expect((screen.getByLabelText('Check type') as HTMLSelectElement).value).toBe('icmp_ping');
  });
  it('ignores an unknown kind in the hash', async () => {
    window.history.pushState({}, '', '/alerts/monitors/new#kind=bogus');
    render(<MonitorEditor />);
    expect((await screen.findByLabelText('Kind') as HTMLSelectElement).value).toBe('cpu');
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/MonitorEditor.test.tsx` → `Unable to find … network-check-asset-binding`.
- [ ] **Step 3: Implement.** In `MonitorEditor.tsx`, after the fetch effect (343-353):
  ```ts
  // W05e — deep link from the Network page / device page: a fresh editor
  // opened with #kind=network_check&assetId=… Preserve any policy= hash key.
  // Form preselection uses the same hash convention as the policy picker.
  useEffect(() => {
    if (!isNew || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const kind = params.get('kind');
    if (!kind || !(MONITOR_KINDS as readonly string[]).includes(kind)) return;
    handleKindChange(kind as MonitorKind);
    const assetId = params.get('assetId');
    if (kind !== 'network_check' || !assetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) return;
    setValue('ownerScope', 'organization', { shouldDirty: true });
    void (async () => {
      const res = await fetchWithAuth(`/discovery/assets/${encodeURIComponent(assetId)}`);
      if (!res.ok) return;
      const body = await res.json();
      const asset = (body?.data ?? body) as { label?: string | null; hostname?: string | null; ipAddress?: string | null };
      const target = asset.ipAddress ?? asset.hostname ?? '';
      setValue('condition', { ...defaultConditionFor('network_check'), assetId, ...(target ? { target } : {}) }, { shouldDirty: true });
      if (!getValues('name')) setValue('name', `Ping ${asset.label ?? asset.hostname ?? target}`, { shouldDirty: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew]);
  ```
  (`getValues` from the `useForm` destructure.) Render under `MonitorConditionFields` when `watchKind === 'network_check'`:
  ```tsx
  <NetworkCheckAssetBinding
    orgId={isPartnerOwned ? null : ownerOrgId}
    assetId={(watch('condition') as { assetId?: string }).assetId ?? null}
    onSelect={(asset) => setValue('condition', bindNetworkAsset(getValues('condition'), asset), { shouldDirty: true })}
  />
  ```
  `NetworkCheckAssetBinding.tsx` (org-scoped read with error/retry; binding changes form state, its eventual mutation still uses the editor's `runAction`):
  ```tsx
  import { useEffect, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth } from '../../stores/auth';
  export type NetworkAsset = { id: string; label: string | null; hostname: string | null; ipAddress: string | null };
  export function bindNetworkAsset(condition: Record<string, unknown>, asset: NetworkAsset | null): Record<string, unknown> {
    const { assetId: _old, ...rest } = condition;
    // Never reconstruct condition from visible fields: headers/packetSize are
    // supported API-only values and must survive picker changes and Save.
    return asset ? { ...rest, assetId: asset.id, target: asset.ipAddress ?? asset.hostname ?? rest.target } : rest;
  }
  export default function NetworkCheckAssetBinding({ orgId, assetId, onSelect }: {
    orgId: string | null; assetId: string | null; onSelect: (asset: NetworkAsset | null) => void;
  }) {
    const { t } = useTranslation('monitoring');
    const [assets, setAssets] = useState<NetworkAsset[]>([]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let cancelled = false;
      setAssets([]); setStatus('loading');
      if (!orgId) { setStatus('ready'); return; }
      void (async () => {
        try {
          const res = await fetchWithAuth(`/discovery/assets?orgId=${encodeURIComponent(orgId)}`);
          if (!res.ok) throw new Error('asset_read_failed');
          const body = await res.json();
          if (!Array.isArray(body.data)) throw new Error('asset_response_invalid');
          if (!cancelled) { setAssets(body.data); setStatus('ready'); }
        } catch { if (!cancelled) setStatus('error'); }
      })();
      return () => { cancelled = true; };
    }, [orgId, attempt]);
    return <div data-testid="network-check-asset-binding">
      <label htmlFor="network-check-asset-picker">{t('editor.networkCheckAsset.label')}</label>
      <select id="network-check-asset-picker" data-testid="network-check-asset-picker"
        value={assetId ?? ''} disabled={!orgId || status !== 'ready'}
        onChange={e => onSelect(assets.find(a => a.id === e.target.value) ?? null)}>
        <option value="">{t('editor.networkCheckAsset.unbound')}</option>
        {assetId && !assets.some(a => a.id === assetId) && <option value={assetId}>{assetId}</option>}
        {assets.map(a => <option key={a.id} value={a.id}>{a.label ?? a.hostname ?? a.ipAddress ?? a.id}</option>)}
      </select>
      {status === 'error' && <p role="alert">{t('editor.networkCheckAsset.failed')}
        <button type="button" onClick={() => setAttempt(v => v + 1)}>{t('common:actions.retry')}</button></p>}
      {!orgId && <p>{t('editor.networkCheckAsset.orgRequired')}</p>}
    </div>;
  }
  ```
  In `MonitorEditor.tsx`, import `bindNetworkAsset` and the component, preserve raw condition on fetch/reset (`:321`) and submit (`:374`), and explicitly remove the binding on an owner change:
  ```ts
  useEffect(() => {
    if (!isPartnerOwned || watchKind !== 'network_check') return;
    const condition = getValues('condition');
    if (condition.assetId) setValue('condition', bindNetworkAsset(condition, null), { shouldDirty: true });
  }, [isPartnerOwned, watchKind, getValues, setValue]);
  ```
  Retain W05a Task 4's `editorHashParams` and exported `tabFromHash` verbatim (including leading `#`, legacy tab hashes and policy-only → settings). Extend only `editorHashForTab`'s short-hash condition so the new keys survive tab changes:
  ```ts
  export function editorHashForTab(hash: string, tab: EditorTab): string {
    const params = editorHashParams(hash);
    if (!['policy', 'kind', 'assetId'].some(key => params.has(key))) return `#${tab}`;
    params.set('tab', tab);
    return `#${params.toString()}`;
  }
  const switchTab = (tab: EditorTab) => {
    window.location.hash = editorHashForTab(window.location.hash, tab);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  ```
  Keep the hook's hash-change listener; do not invoke its setter, which replaces the complete hash. Remove the unused setter from destructuring. Extend W05a's existing named-import regressions in `MonitorEditor.test.tsx`:
  ```ts
  it('preserves policy, kind and asset preselection across tabs', () => {
    const policy = '11111111-1111-4111-8111-111111111111';
    const assetId = '22222222-2222-4222-8222-222222222222';
    for (const prefix of [`policy=${policy}&`, '']) {
      const hash = editorHashForTab(`#${prefix}kind=network_check&assetId=${assetId}`, 'activity');
      const params = new URLSearchParams(hash.slice(1));
      expect(params.get('kind')).toBe('network_check');
      expect(params.get('assetId')).toBe(assetId);
      expect(params.get('policy')).toBe(prefix ? policy : null);
      expect(tabFromHash(hash)).toBe('activity');
      expect(tabFromHash(editorHashForTab(hash, 'settings'))).toBe('settings');
    }
    expect(tabFromHash(`#policy=${policy}`)).toBe('settings');
    expect(tabFromHash('#activity')).toBe('activity');
    expect(tabFromHash('settings')).toBe('settings');
  });
  ```

  Add `NetworkCheckAssetBinding.test.tsx` with actual component and round-trip regressions:
  ```tsx
  import '@/lib/i18n';
  import { render, screen, fireEvent } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';
  import { fetchWithAuth } from '../../stores/auth';
  import NetworkCheckAssetBinding, { bindNetworkAsset } from './NetworkCheckAssetBinding';
  vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  const asset = { id: '11111111-1111-4111-8111-111111111111', label: 'Gateway', hostname: null, ipAddress: '192.0.2.1' };
  it('selects an asset directly from the editor', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ data: [asset] })));
    const onSelect = vi.fn();
    render(<NetworkCheckAssetBinding orgId="org-1" assetId={null} onSelect={onSelect} />);
    await screen.findByRole('option', { name: 'Gateway' });
    fireEvent.change(screen.getByTestId('network-check-asset-picker'), { target: { value: asset.id } });
    expect(onSelect).toHaveBeenCalledWith(asset);
  });
  it.each([{ checkType: 'icmp_ping', packetSize: 1400 }, { checkType: 'http_check', headers: { 'X-Probe': 'breeze' } }])(
    'retains API-only options when binding and unbinding', option => {
      const original = { target: 'example.com', ...option };
      const bound = bindNetworkAsset(original, asset);
      expect(bound).toMatchObject(option);
      expect(bindNetworkAsset(bound, null)).toMatchObject(option);
    });
  ```
  Append the actual Save round-trip regression to the existing `MonitorEditor.test.tsx` harness (`fetchMock`, `defaultFetchImpl`, `MONITOR_M1_FIXTURE`, `waitFor`):
  ```tsx
  it.each([
    { checkType: 'icmp_ping', packetSize: 1400 },
    { checkType: 'http_check', headers: { 'X-Probe': 'breeze' } },
  ])('PATCH preserves API-only network options', async option => {
    const fixture = { ...MONITOR_M1_FIXTURE, name: 'Network test', kind: 'network_check',
      condition: { ...option, target: 'example.com', pollingIntervalSeconds: 60, timeoutSeconds: 5,
        consecutiveFailures: 2, degradedIsFailure: false } };
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && init?.method === 'PATCH') return json({ data: fixture });
      if (input === '/monitor-definitions/m1') return json({ data: fixture });
      if (input === '/monitor-definitions/m1/devices') return json({ data: [] });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Network test'));
    fireEvent.click(screen.getByTestId('monitor-editor-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/m1', expect.objectContaining({ method: 'PATCH' })));
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions/m1' && init?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body)).condition).toMatchObject(option);
  });
  ```
  New locale values for `editor.networkCheckAsset` (all eight, no English fallbacks):

  | Locale | label | unbound | failed | orgRequired |
  |---|---|---|---|---|
  | en | Asset | No asset binding | Could not load assets | Select organization ownership to bind an asset. |
  | de-DE | Asset | Keine Asset-Bindung | Assets konnten nicht geladen werden | Wählen Sie eine Organisation als Eigentümer, um ein Asset zu binden. |
  | es-419 | Activo | Sin activo vinculado | No se pudieron cargar los activos | Selecciona una organización como propietaria para vincular un activo. |
  | fr-CA | Actif | Aucun actif lié | Impossible de charger les actifs | Sélectionnez une organisation propriétaire pour lier un actif. |
  | fr-FR | Actif | Aucun actif lié | Impossible de charger les actifs | Sélectionnez une organisation propriétaire pour lier un actif. |
  | it-IT | Asset | Nessun asset associato | Impossibile caricare gli asset | Seleziona un'organizzazione proprietaria per associare un asset. |
  | pt-BR | Ativo | Nenhum ativo vinculado | Não foi possível carregar os ativos | Selecione uma organização proprietária para vincular um ativo. |
  | tr-TR | Varlık | Bağlı varlık yok | Varlıklar yüklenemedi | Varlık bağlamak için kuruluş sahipliğini seçin. |

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/monitoring/MonitorEditor.test.tsx src/components/monitoring/MonitorConditionFields src/components/monitoring/NetworkCheckAssetBinding.test.tsx src/lib/__tests__/i18n`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring/MonitorEditor.tsx apps/web/src/components/monitoring/NetworkCheckAssetBinding.tsx apps/web/src/components/monitoring/NetworkCheckAssetBinding.test.tsx apps/web/src/components/monitoring/MonitorEditor.test.tsx apps/web/src/locales && git commit -m "feat(web): monitor editor prefills kind and asset from the hash; network_check asset binding"`

---

### Task 13: AI tools — `manage_monitors` create/update/delete refuse with guidance; reads stay (PR3)

**Files:**
- Modify: `apps/api/src/services/aiToolsMonitoring.ts` (`query_monitors` ~66-190; `manage_monitors` definition 197-228; create 305-346; update 348-380)
- Modify: `apps/api/src/services/aiToolsMonitoring.test.ts` (350-420), `aiToolsMonitoring.deviceScope.test.ts` (if it exercises create/update)
- Modify: `apps/api/src/services/aiToolsMonitors.ts` (`manage_monitor_definitions` description ~375)

**Interfaces:**
- Produces: `manage_monitors` `create`/`update` → `{ error: 'network_check_authoring_retired', useTool: 'manage_monitor_definitions', example: { action: 'create', definition: { kind: 'network_check', name: '…', condition: { checkType: 'icmp_ping', target: '10.0.0.1', assetId: '<optional asset uuid>' } } } }`; `get` unchanged; `delete` refuses with retirement guidance; `query_monitors` rows gain `managedByMonitorId`.

- [ ] **Step 1: Write the failing tests** — replace the `action: create` describe (350-420) with:
  ```ts
  describe('action: create / update are retired (W05e)', () => {
    it('create refuses with a pointer to manage_monitor_definitions and writes nothing', async () => {
      const out = JSON.parse(await handle({ action: 'create', name: 'x', monitorType: 'icmp_ping', target: '10.0.0.1' }, makeUnrestrictedAuth()));
      expect(out).toMatchObject({ error: 'network_check_authoring_retired', useTool: 'manage_monitor_definitions', example: { definition: { kind: 'network_check' } } });
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });
    it('update refuses the same way and reads nothing', async () => {
      const out = JSON.parse(await handle({ action: 'update', monitorId: 'nm-1', name: 'y' }, makeUnrestrictedAuth()));
      expect(out.error).toBe('network_check_authoring_retired');
      expect(vi.mocked(db.select)).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });
  });
  ```
  keep the `get` site-scope cases and replace delete success with `expect(out).toMatchObject({ error: 'network_check_cleanup_retired', hint: { route: 'POST /monitor-definitions/conversion/retire', reason: 'operator' } }); expect(vi.mocked(db.delete)).not.toHaveBeenCalled();`.
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/api && npx vitest run src/services/aiToolsMonitoring.test.ts` → `expected { success: true } to match object { error: 'network_check_authoring_retired' }`.
- [ ] **Step 3: Implement.** At the top of the `manage_monitors` handler:
  ```ts
  // W05e — network checks are authored as monitors of kind `network_check`.
  // The enum keeps 'create'/'update' so an older prompt gets this pointer
  // instead of a schema error.
  if (action === 'delete') {
    return JSON.stringify({ error: 'network_check_cleanup_retired',
      message: 'Retire this check through the conversion ledger; history must be retained.',
      hint: { route: 'POST /monitor-definitions/conversion/retire', sourceTable: 'network_monitors', sourceId: input.monitorId, reason: 'operator' },
    });
  }
  if (action === 'create' || action === 'update') {
    return JSON.stringify({
      error: 'network_check_authoring_retired',
      message: 'Network checks are authored as monitor definitions. Call manage_monitor_definitions with kind "network_check"; bind it to a discovered asset with condition.assetId to pin the probe to the asset\'s site and alert on its device.',
      useTool: 'manage_monitor_definitions',
      example: { action: 'create', definition: { kind: 'network_check', name: 'Gateway reachable', severity: 'high', condition: { checkType: 'icmp_ping', target: '10.0.0.1', assetId: '<optional asset uuid>', consecutiveFailures: 2 } } },
    });
  }
  ```
  Delete the create/update/delete branches that follow. Update the tool description to "Get a network check with recent results. Unconverted checks are retired through the conversion ledger; deletion is unavailable while history is retained. Creating and editing checks moved to manage_monitor_definitions (kind network_check)." and the `monitorType`/`target`/`config` property descriptions to "(retired — use manage_monitor_definitions)". Add `managedByMonitorId` to the `query_monitors` select. In `aiToolsMonitors.ts` extend the `manage_monitor_definitions` description: "…Kind `network_check` compiles to a managed network probe; set `condition.assetId` to bind it to a discovered asset."
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/aiToolsMonitoring src/services/aiToolsMonitors.test.ts src/services/aiAgentSdkTools.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts`
- [ ] **Step 5: Commit.** `git add apps/api/src/services/aiToolsMonitoring.ts apps/api/src/services/aiToolsMonitoring.test.ts apps/api/src/services/aiToolsMonitoring.deviceScope.test.ts apps/api/src/services/aiToolsMonitors.ts && git commit -m "feat(ai): manage_monitors create/update point at manage_monitor_definitions kind network_check"`

---

### Task 14: Docs, release notes, full verification pass (PR3)

**Files:**
- Modify: `apps/docs/src/content/docs/features/network-monitors.mdx` (retitle "Network Checks"; rewrite "In the console" 16-23; replace "Alert Rules on Monitors" 208-289 with "Alerting"; API Reference 375-411 marks the 410s; add "Converting existing checks"; Troubleshooting 463+ "Alert rules not firing" → "The monitor is not firing")
- Modify: `apps/docs/src/content/docs/features/monitors.mdx` (kinds table 12-31 gains `Network check` — and the four other W04 kinds if still missing; "Converting a legacy alert rule" 104-118 gains a "Converting network checks" paragraph; a "Network check fields" table)
- Modify: `docs/release-notes/next-release-draft.md`, `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:** Consumes Tasks 1–13 contracts and D14 mapping/retention and D20 prerequisite decisions; produces verified docs, release notes and the complete API/web/integration verification record.

- [ ] **Step 1: Write the failing test.** Docs build is the test: `cd apps/docs && pnpm build` must pass after the edits; before editing, run `grep -n "POST /api/v1/monitors/alerts\|Alert Rule Schema" apps/docs/src/content/docs/features/network-monitors.mdx` and expect hits — those sections must be gone afterwards (`grep` returns nothing = green).
- [ ] **Step 2: Run it, expect FAIL.** The grep returns lines 260-289 (the alert-rule API that no longer exists).
- [ ] **Step 3: Implement.** `network-monitors.mdx` content contract (write it in the page's existing voice):
  - Frontmatter `title: Network Checks`, `sidebar.label: Network Checks`, description "Ping, port, HTTP and DNS checks run from your agents; authored as monitors, results on the Network page."
  - **In the console**: "Network checks are authored as monitors of kind **Network check** under **Alerts → Monitors**. The **Network** page (Fleet Management → Network, `/monitoring`; called *Network Monitor* before this release) keeps **Assets**, **SNMP Templates** and **Results**. Results lists every check with its last status and links each to the monitor that owns it; **New check** opens the monitor editor with the kind pre-selected and, from an asset or the network device page, the asset pre-bound."
  - **Fields**: the condition table — check type, target, asset binding (what it does: site-pinned executor, alert device), per-type options (map the four legacy config tables 1:1, noting `expectStatus` is the API field name and is sent to the agent as `expectedStatus`), *Treat degraded as failure*, *Fail when slower than*, poll interval 10 s–24 h, timeout 1–300 s, consecutive failures 1–100.
  - **Alerting**: replace the whole section. One monitor → one alert per organization, raised on the asset's linked device or the most recently seen device in the asset's site/org; severity, cooldown, delivery (Inherit/Channels/Inbox only) and escalation come from the monitor; the alert carries `monitorId` and `kind: network_check` on `alert.triggered` (Alert workflows filter on it). Keep the five-minute cooldown and dedupe paragraphs (now per monitor and device). Explain that evaluation runs once per managed check per org even if its alert device is offline, using the same device selection as the legacy worker.
  - **Converting existing checks**: the Results tab banner; exact mapping for a single offline/consecutive-failure rule; explicit refusals for degraded/response-time predicates, mixed rules, out-of-range thresholds and non-alerting probes; a blocked whole preview when the required runtime capability is missing; open legacy alerts keep their status and provenance; the row is adopted (history kept); revert from the conversion ledger; unconvertible reasons.
  - **API Reference**: `POST /monitors`, `PATCH /monitors/:id`, `POST /monitors/alerts`, `PATCH|DELETE /monitors/alerts/:id` → **410 Gone** with the `network_check_authoring_retired` body; reads, `/check`, `/test`, `DELETE /monitors/:id` returns 410 for unmanaged rows (cleanup uses ledger retirement); reads and operational probes unchanged; `GET /monitors` gains `managedByMonitorId`, `retiredAt`, `includeRetired`; `DELETE /discovery/assets/:id` → 409 `asset_has_retained_network_checks`; the two conversion endpoints.
  `monitors.mdx`: kinds table row `| Network check | An ICMP, TCP, HTTP or DNS probe run from an agent fails N times in a row (optionally: is degraded or slow) | High | Agent (probe) + server (verdict) |`; a short "Network check" subsection linking to the Network Checks page; the conversion paragraph.
  `docs/release-notes/next-release-draft.md` → under Self-Hosting / Upgrade Notes:
  - "**Network check authoring moves to Monitors (W05e).** The Network page keeps Assets, SNMP Templates and Results. The monitor editor includes an asset picker. Existing unmanaged checks keep polling and alerting. With #6352 and the extended #6353 deployed, representable checks can be converted while preserving alerts on offline alert devices. If the required runtime capability is missing, the whole preview is blocked with no per-check refusals or automatic network retirement. Checks without active rules remain non-alerting; mixed predicates, severities and unsupported thresholds are refused. Open alerts are never resolved by conversion or retirement. Explicit retirement is recorded in the persistent conversion ledger and can be reversed while the network runtime remains available. Legacy create/update/delete endpoints return 410; cleanup is retirement-only while the ledger is needed."

  - "**Fix:** a `network_check` monitor's *Expected status code* was never sent to the agent under the name it reads (`expectedStatus`); it is now."
  `CHANGELOG.md` `[Unreleased]` → `### Changed` (Network page, conversion, 410s) and `### Fixed` (expectStatus).
- [ ] **Step 4: Run, expect PASS — the full verification pass.** From the repository root; subshells keep every command's working directory explicit:
  ```bash
  (cd apps/docs && pnpm build)
  (cd packages/shared && npx vitest run src/validators/monitors.test.ts)
  (cd apps/api && npx tsc --noEmit -p . && npx vitest run \
    src/services/monitors src/services/alertConditions src/jobs/monitorWorker src/routes/monitors src/routes/monitorDefinitions src/routes/discovery \
    src/services/aiToolsMonitoring src/services/aiToolsMonitors.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts \
    src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts)
  pnpm test-stack up
  (cd apps/api && npx vitest run -c vitest.integration.config.ts \
    src/__tests__/integration/networkCheckConversion.integration.test.ts \
    src/__tests__/integration/networkMonitorPartnerRls.integration.test.ts \
    src/__tests__/integration/monitorDefinitionsPartnerRls.integration.test.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts \
    src/__tests__/integration/rls-coverage.integration.test.ts \
    src/__tests__/integration/tenantCascade.integration.test.ts)
  pnpm db:check-drift
  pnpm test-stack down
  (cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/monitoring src/components/monitors src/components/layout/Sidebar.nav.test.tsx src/components/devices/networkDevice src/lib/__tests__)
  git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | grep -E '^apps/api/migrations/[0-9]{4}-[^/]+\.sql$' | sort | tail -1
  scripts/check-migration-naming.sh --against-ref origin/main
  ```
  The newest top-level migration must sort before the assigned W05e filename; rename the unshipped migration if necessary. Drift checks do not prove FK deferrability, export classification or RLS isolation; those are the live assertions above.
  Then the manual walk on a `pnpm wt-stack up` stack: seed a legacy check via SQL, open `/monitoring#checks` (lands on Results), banner → convert a representable check and verify one alert with its alert device offline; per-check Retire on another check → persistent history → Undo, then open a new monitor and select an asset, `POST /monitors` returns 410, the device page's Add check opens the editor bound to the asset.
- [ ] **Step 5: Commit.** `git add apps/docs/src/content/docs/features/network-monitors.mdx apps/docs/src/content/docs/features/monitors.mdx docs/release-notes/next-release-draft.md CHANGELOG.md && git commit -m "docs(monitoring): network checks as monitors — Network page, conversion, retired write endpoints"`

---

## Open questions

None. D14 settles the asset picker, API-only option round-trip and retirement-only cleanup. D20 requires #6352 and extended #6353 before PR1: capability absence blocks the whole preview without refusals or retirement; capability presence allows representable adoption, backed by the offline-device integration proof.
