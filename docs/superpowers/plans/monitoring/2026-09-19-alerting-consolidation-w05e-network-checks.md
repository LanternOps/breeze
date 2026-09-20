---
tracking_issue: (set by feature-lifecycle after registration)
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05e Network Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every network check is a monitor of kind `network_check`: the unmanaged `network_monitors` rows and their `network_monitor_alert_rules` are adopted into monitor definitions through the W05c1 ledger, the Network Monitor page becomes the **Network** page (Assets · Templates · Results) with no check authoring, and every other writer (REST, AI tool, device page) points at the monitor editor.

**Architecture:** Conversion *adopts* the existing `network_monitors` row rather than replacing it — the new definition's first compile stamps `managed_by_monitor_id` on the legacy row and updates it in place, so the row id, its `network_monitor_results` history, its asset binding, its TLS observation and `alerts.context.monitorId` all survive; only the alert rules are retired (`retired_at`) and the legacy worker's per-rule evaluation stops. The `network_check` condition is widened to carry everything the retired form could author (asset binding, per-type options, the `degraded` and `response_time_gt` verdicts, the legacy interval/timeout ranges) so nothing is unconvertible on shape, and the compiler emits the agent's own config key names (fixing the shipped `expectStatus`/`expectedStatus` mismatch). The `network_check` handler gains the legacy worker's *one alert device per check per org* rule, so a converted check attached to an org-wide policy raises one alert, on the same device it did before.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16, zod (`packages/shared`), BullMQ, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`), React + react-i18next (8 locales), Astro Starlight docs.

**Spec:** docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md (§Decisions C10, §End state "Navigation" and "Removed screens", §Non-goals "Network SNMP template authoring", §Conversion ledger, §Waves W05e row)

## Ordering assumptions (read first)

- **W05a–W05d have shipped.** This plan consumes, by exact name, W05c1's `apps/api/src/services/monitors/conversion/` module (`ConversionSourceTable` already lists `'network_monitors'`, `ConversionPreviewItem`, `PolicyConversionPreview`, `convertPartnerLegacy`, `revertConversion`, `retireSource`, the `monitor_conversions` / `monitor_conversion_outputs` tables with `role in ('primary','resource_cpu','resource_memory','response')`, and `GET /monitor-definitions/conversion/pending`). **Verify before Task 5:** `ls apps/api/src/services/monitors/conversion/ && grep -n "network_monitors" apps/api/src/services/monitors/conversion/*.ts`. Neither existed on `main @ b8dd148bd8` when this plan was written; if W05c1's file names differ, follow W05c1's names and keep this plan's function names for the network-specific pieces.
- **W05c1 already widened `network_check.consecutiveFailures` to `1..100`** (brief: `service`/`process`/`network_check` max 20 → 100). Task 2 keeps that and widens two *other* ranges.
- **The spec's W05e row says "target = asset".** On `main` the `network_check` condition has no asset binding and `buildCompiledNetworkMonitor` (`apps/api/src/services/monitors/monitorCompiler.ts:219-245`) never writes `assetId`, so a compiled check today is always unbound (org-wide executor, org-level alert device). Task 2 adds `assetId` to the condition and the compiled row. This is a code fact the spec assumed was already true.
- **Two shipped W04 defects are fixed here because conversion exposes them** (both verified in code, neither listed in the spec):
  1. `buildCompiledNetworkMonitor` writes `config.expectStatus`; `buildMonitorCommand` (`services/monitorCommands.ts:37-44`) spreads config verbatim into the agent payload; the agent reads `expectedStatus` (`agent/internal/heartbeat/handlers_monitor.go:210`, default 200). A `network_check` monitor's expected status is silently ignored. Task 2 makes the compiler emit the legacy key names.
  2. The alert sweep resolves monitors **per device** (`services/alertService.ts:881` → `resolveMonitorsForDevice`) and the `network_check` handler (`services/alertConditions/handlers/networkCheck.ts`) breaches for *any* device in the policy's scope. A converted check on an org-wide policy would raise one alert per online device for one outage; the legacy worker raises one alert per org on one resolved device (`jobs/monitorWorker.ts:294-345` `resolveMonitorAlertDevice`). Task 3 moves that rule into a shared resolver and gates the handler on it.
- **All unmanaged `network_monitors` rows are org-owned.** Both legacy writers (`routes/monitors.ts:495-507`, `services/aiToolsMonitoring.ts` create) insert `orgId` only; a partner-wide row (`org_id NULL`) is always a compiled artefact (`routes/monitors.ts:80-92`). Conversion is therefore an **org-axis** operation: no partner-axis write, no `canManagePartnerWidePolicies` gate, and `monitor_conversions.org_id` is always set.
- **No "default policy" exists on config policies** (verified: no `is_default` column in `db/schema/configurationPolicies.ts`; onboarding at `modules/mcpInvites/tools/configureDefaults.ts:142` writes baseline `alert_rules`, not a policy). Task 5 mirrors `ruleConversionService.ts:130-140`: one generated policy **"Network checks — <org name>"** per org, assigned at organization level, reused across conversion batches through the ledger.
- **Known limitation, filed not fixed:** the sweep only enqueues online devices (`jobs/alertWorker.ts:196-199`). After conversion, a check whose alert device is offline is silent until that device is back; the legacy worker created the alert regardless. File it as a follow-up ("evaluate `network_check` monitors for the alert device even when offline") and say so in the release notes.
- **Three PRs, in order:** PR1 = Tasks 1–7 (API), PR2 = Tasks 8–10 (web), PR3 = Tasks 11–12 (tools, docs, verification). PR2 and PR3 each depend on PR1 being merged (they consume the 410s, the `managedByMonitorId` list field and the conversion routes). Do not stack them on each other's branches — a PR based on a sibling branch runs no CI (CLAUDE.md, tenancy section).

## Global Constraints

- **Migration filename `2026-10-24-110000-network-checks-as-monitors.sql`** (assigned by the common brief). Before pushing: `git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1` must sort **before** it (newest at planning time on `main`: `2026-10-21-100200-billing-profiles-permissions.sql`; W05b/c1/d claim `2026-10-21-*` and `2026-10-22-100000-*`). Rename with a later `HHMMSS` if anything newer landed. Never name it for today's real date.
- Migration is idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), has **no inner `BEGIN`/`COMMIT`**, and contains **no DML** — so no `set_config('breeze.scope','system',true)` is needed and none is added (`migrationRlsScope.test.ts` only requires the elevation before a write; if you add any `UPDATE`/`INSERT`/`DELETE`, put `SELECT set_config('breeze.scope', 'system', true);` first and report row counts with `GET DIAGNOSTICS … RAISE WARNING`).
- **No new tenant tables. New columns on registered tables:** `network_monitors.retired_at`/`retired_reason` must be classified `included` in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:401`) in the same PR — the export-policy row is the one registration that fires on a **column**. `network_monitor_alert_rules` has no `org_id` (it reaches its tenant through `network_monitors`, `rls-coverage.integration.test.ts:832`), so it needs no export-policy entry and no cascade entry. No `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_*` or `DUAL_AXIS_TENANT_TABLES` change.
- `partner-wide-write-coverage.test.ts` scans every file that mutates a dual-axis table. `network_monitors` is dual-axis, so the new conversion file needs an allowlist entry with a reason (Task 5 Step 6). `site-ceiling-write-coverage.test.ts` likewise; the conversion refuses site-restricted callers outright (Task 5), which is the reason recorded there.
- **Worker-created rows take the DEVICE's org; compiled rows take the DEFINITION's owner** (unchanged). Adoption only ever stamps `managed_by_monitor_id` on a row whose `org_id` equals the definition's `org_id` (Task 4).
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); catch pattern per CLAUDE.md. Every new i18n key needs **real translations in all 8 locales** (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`); the coverage test fails on a missing or English-echoed key. Removed components take their `longTail.*` blocks out of all 8 files.
- Hash for tab state (`useHashState`/`useHashTab`); the **new-monitor prefill uses query params** (`/alerts/monitors/new?kind=network_check&assetId=…`) because it is a deep link into a fresh form, not transient UI state — the same precedent `MonitoringPage.tsx:31-36` already sets with `/monitoring?assetId=`.
- Every task: **red test first**, then `cd apps/api && npx tsc --noEmit -p .` (or `pnpm --filter @breeze/api exec tsc --noEmit`), then the task's targeted tests, then commit. Use `cd apps/api && npx vitest run <path>`; never `pnpm --filter … test -- --run <path>`; never a trailing-slash path filter.
- `pnpm test` does **not** run the integration / export-policy suites. Tasks 1, 5 and 7 need `pnpm test-stack up` (private pg+redis for this worktree) and `pnpm test-stack down` afterwards — nothing reaps it for you.
- Do not commit from a subagent; the orchestrator commits. Each task's Step 5 gives the commit message the orchestrator uses.

## File Structure (what changes where)

| File | Change |
|---|---|
| `apps/api/migrations/2026-10-24-110000-network-checks-as-monitors.sql` | **Create.** `retired_at`/`retired_reason` on `network_monitors` and `network_monitor_alert_rules`; partial index for the pending count. |
| `apps/api/src/db/schema/monitors.ts` | Modify (lines 10-56, 80-88): add the four columns. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Modify (line 401): classify `retired_at`, `retired_reason` as `included`. |
| `packages/shared/src/validators/monitors.ts` | Modify (lines 173-189): widen `network_check` — `assetId`, per-type options, `degradedIsFailure`, `maxResponseMs`, legacy ranges; export `NetworkCheckMonitorCondition`. |
| `packages/shared/src/validators/monitors.test.ts` | Modify: new `network_check` cases. |
| `apps/api/src/services/monitors/kinds/networkCheck.ts` | Modify (whole file, 47 lines): condition type, `overridableKeys`, `toAlertCondition` carries the new verdict keys. |
| `apps/api/src/services/monitors/monitorCompiler.ts` | Modify (lines 213-245 `buildCompiledNetworkMonitor`; 286-312 `compileMonitorInTx`): agent config key names, `assetId`, adoption option. |
| `apps/api/src/services/monitors/monitorCompiler.w04.test.ts` | Modify (lines 175-236): config keys, `assetId`, adoption. |
| `apps/api/src/services/monitors/monitorService.ts` | Modify (lines 239-291 `createMonitorDefinition`): optional `opts.adoptNetworkMonitorId` passthrough. |
| `apps/api/src/services/monitors/networkCheckAlertDevice.ts` | **Create.** `resolveNetworkCheckAlertDevice` — lifted from `jobs/monitorWorker.ts:294-345`. |
| `apps/api/src/services/monitors/networkCheckAlertDevice.test.ts` | **Create.** |
| `apps/api/src/jobs/monitorWorker.ts` | Modify (lines 294-345 delete local resolver; 393-411 rule query adds `retired_at IS NULL`; 415 uses shared resolver). |
| `apps/api/src/jobs/monitorWorker.test.ts` | Modify: schema mock gains `retiredAt`; resolver import. |
| `apps/api/src/services/alertConditions/types.ts` | Modify (lines 147-151): `NetworkCheckCondition` gains `degradedIsFailure?`, `maxResponseMs?`. |
| `apps/api/src/services/alertConditions/handlers/networkCheck.ts` | Modify (whole file, 110 lines): alert-device gate, failure predicate. |
| `apps/api/src/services/alertConditions/handlers/networkCheck.test.ts` | Modify: mock the resolver module; new cases. |
| `apps/api/src/services/monitors/conversion/networkChecks.ts` | **Create.** Pure mapper + preview/convert/retire/revert/count. |
| `apps/api/src/services/monitors/conversion/networkChecks.test.ts` | **Create.** Mapper unit tests. |
| `apps/api/src/services/monitors/conversion/index.ts` (W05c1) | Modify: `retireSource`/`revertConversion` gain the `'network_monitors'` case; `convertPartnerLegacy` loops orgs into `convertNetworkChecks`; pending count gains `networkChecks`. |
| `apps/api/src/routes/monitorDefinitions.ts` | Modify: `GET /conversion/network-checks`, `POST /conversion/network-checks/convert` next to W05c1's conversion routes. |
| `apps/api/src/routes/monitorDefinitions.conversion.networkChecks.test.ts` | **Create.** Route tests. |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | Modify (line ~71 block): allowlist entry for the conversion file. |
| `apps/api/src/__tests__/site-ceiling-write-coverage.test.ts` | Modify: allowlist entry for the conversion file. |
| `apps/api/src/routes/monitors.ts` | Modify: `POST /` (461-522), `PATCH /:id` (639-707), `POST /alerts` (870-905), `PATCH /alerts/:id` (925-957), `DELETE /alerts/:id` (959-986) → 410; delete dead zod schemas (261-343); list projection (430-456) adds `managedByMonitorId`, `retiredAt`, `includeRetired` query. |
| `apps/api/src/routes/monitors_list_create.test.ts`, `monitors_alerts.test.ts`, `monitors_detail.test.ts` | Modify: write paths assert 410. |
| `apps/api/src/routes/discovery.ts` | Modify (`DELETE /assets/:id`, lines 1699-1750): 409 when managed checks are bound to the asset. |
| `apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts` | **Create.** Real-Postgres proof: adopt → results → one alert on the alert device through the compiled rule → revert. |
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
| `apps/web/src/components/monitors/NetworkCheckConversionBanner.tsx` | **Create.** Preview → confirm → convert. |
| `apps/web/src/components/monitors/NetworkCheckConversionBanner.test.tsx` | **Create.** |
| `apps/web/src/components/monitors/MonitorDetailModal.tsx` | Modify: remove edit form and alert-rules section; managed link / not-converted note. |
| `apps/web/src/components/monitors/MonitorDetailModal.test.tsx` | Modify (rewrite the PATCH tests). |
| `apps/web/src/components/monitors/CreateMonitorForm.tsx` | **Delete.** |
| `apps/web/src/components/devices/networkDevice/settings/MonitoringSection.tsx` | Modify (lines 5, 67, 337-340): Add check → navigate to the editor. |
| `apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.ts` | Modify (lines 171-179): remove `createCheck`. |
| `apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts` | Modify. |
| `apps/web/src/components/monitoring/monitorKindFields.ts` | Modify (lines 196-234, 296): new fields, ranges. |
| `apps/web/src/components/monitoring/monitorKindFields.test.ts` | Modify. |
| `apps/web/src/components/monitoring/MonitorEditor.tsx` | Modify: `?kind`/`?assetId` prefill; `NetworkCheckAssetBinding` chip. |
| `apps/web/src/components/monitoring/NetworkCheckAssetBinding.tsx` | **Create.** |
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
  -- row, history kept); only unconvertible checks and every legacy alert rule
  -- of a converted check are retired in place. No DML in this file.

  -- 1. Retirement columns on network_monitors (unconvertible rows only).
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
    // W05e — set only on a check that could NOT be converted to a monitor
    // (`retired_reason = 'unconvertible:<code>' | 'operator'`). A converted
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
  (`packetSize` and `headers` are API-only this wave.) `defaultConditionFor('network_check')` (line 296) gains `degradedIsFailure: false`. If `showWhen` does not support `optional` select fields, follow how `antivirus`/`backup_continuity` fields (lines ~150-190) declare optional selects.

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

### Task 3: One alert device per check — shared resolver, handler gate, legacy verdicts (PR1)

**Files:**
- Create: `apps/api/src/services/monitors/networkCheckAlertDevice.ts`, `networkCheckAlertDevice.test.ts`
- Modify: `apps/api/src/jobs/monitorWorker.ts` (lines 294-345 delete; 393-411; 415), `monitorWorker.test.ts`
- Modify: `apps/api/src/services/alertConditions/types.ts` (lines 147-151)
- Modify: `apps/api/src/services/alertConditions/handlers/networkCheck.ts` (whole file), `networkCheck.test.ts`

**Interfaces:**
- Produces: `export async function resolveNetworkCheckAlertDevice(check: { orgId: string; assetId: string | null }): Promise<string | null>` — body lifted verbatim from `monitorWorker.ts:306-345`.
- Produces: `NetworkCheckCondition { type: 'network_check'; monitorId: string; consecutiveFailures?: number; degradedIsFailure?: boolean; maxResponseMs?: number }`.
- Consumes: `networkMonitorResults.responseMs`, `networkMonitors.assetId`.

- [ ] **Step 1: Write the failing tests.**
  `networkCheck.test.ts` — add at top a module mock and new cases (keep the existing `setReads` order: managed, device, results; the managed row now carries `assetId`):
  ```ts
  const { alertDeviceMock } = vi.hoisted(() => ({ alertDeviceMock: vi.fn(async () => 'device-1') }));
  vi.mock('../../monitors/networkCheckAlertDevice', () => ({ resolveNetworkCheckAlertDevice: alertDeviceMock }));
  // in the schema mock: networkMonitors gains assetId: 'networkMonitors.assetId';
  // networkMonitorResults gains responseMs: 'networkMonitorResults.responseMs'.

  describe('one alert device per check per org (W05e)', () => {
    it('breaches on the alert device', async () => {
      alertDeviceMock.mockResolvedValueOnce('device-1');
      setReads([{ id: 'managed-1', assetId: 'asset-1' }], offline(2));
      const r = await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 }, DEVICE_ID);
      expect(r.passed).toBe(true);
      expect(alertDeviceMock).toHaveBeenCalledWith({ orgId: 'org-a', assetId: 'asset-1' });
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
  `networkCheckAlertDevice.test.ts` — a Drizzle-mock test with three cases (linked asset → linked device; unlinked asset with site → the site device query is used; no asset → org query), following the `mockDb.select` chaining style of `networkCheck.test.ts`.
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
  `handlers/networkCheck.ts` — replace `evaluate`:
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

### Task 4: Compiler adoption — a definition's first compile takes over an existing row (PR1)

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
  export async function createMonitorDefinition(input: CreateMonitorDefinitionInput, auth: AuthContext, opts?: CompileOptions): Promise<MonitorDefinitionRow>;
  ```

- [ ] **Step 1: Write the failing test** (`monitorCompiler.w04.test.ts`, in the network_check describe; extend the tx stub so `tx.update(networkMonitors).set().where().returning()` returns `[{ id }]` when a recorded `adoptable` id is set and `[]` otherwise):
  ```ts
  it('adopts an unmanaged same-org row: the managed upsert UPDATES it instead of inserting', async () => {
    const tx = makeTx({ adoptable: 'legacy-row-1' });
    await compileMonitorInTx(tx as never, makeDef(), { adoptNetworkMonitorId: 'legacy-row-1' });
    expect(tx.adoptions).toEqual([{ id: 'legacy-row-1', managedByMonitorId: 'd0000000-0000-4000-8000-000000000001' }]);
    expect(tx.inserted.filter((r) => r.table === 'network_monitors')).toHaveLength(0);
    expect(tx.updated.filter((r) => r.table === 'network_monitors')).toHaveLength(1);
  });
  it('refuses to adopt a row that is already managed or belongs to another org', async () => {
    const tx = makeTx({ adoptable: null });
    await expect(compileMonitorInTx(tx as never, makeDef(), { adoptNetworkMonitorId: 'legacy-row-1' }))
      .rejects.toBeInstanceOf(NetworkMonitorAdoptionError);
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/api && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts` → `NetworkMonitorAdoptionError is not exported` / adoptions `[]`.
- [ ] **Step 3: Implement.** In `monitorCompiler.ts`:
  ```ts
  import { and, eq, isNull } from 'drizzle-orm';

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
  (`sql` from `drizzle-orm`.) In `monitorService.ts` `createMonitorDefinition(input, auth, opts?: CompileOptions)` → `compileMonitorInTx(tx, created, opts)`; import and re-export `CompileOptions`, `NetworkMonitorAdoptionError`.
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors/monitorCompiler.w04.test.ts src/services/monitors/monitorCompiler.test.ts src/services/monitors/monitorService.test.ts`
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/monitorCompiler.ts apps/api/src/services/monitors/monitorService.ts apps/api/src/services/monitors/monitorCompiler.w04.test.ts && git commit -m "feat(monitors): compile option to adopt an existing network_monitors row in place"`

---

### Task 5: Conversion — mapper, preview/convert/retire/revert, policy, routes, ledger wiring (PR1)

**Files:**
- Create: `apps/api/src/services/monitors/conversion/networkChecks.ts`, `networkChecks.test.ts`
- Modify: W05c1's `apps/api/src/services/monitors/conversion/index.ts` (or wherever `retireSource`, `revertConversion`, `convertPartnerLegacy` and the pending count live — verify with `grep -rn "export async function retireSource\|export async function revertConversion\|export async function convertPartnerLegacy" apps/api/src/services/monitors/conversion/`)
- Modify: `apps/api/src/routes/monitorDefinitions.ts` (next to W05c1's `/conversion/*` routes)
- Create: `apps/api/src/routes/monitorDefinitions.conversion.networkChecks.test.ts`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (allowlist), `apps/api/src/__tests__/site-ceiling-write-coverage.test.ts` (allowlist)

**Interfaces:**
- Consumes (W05c1): `monitorConversions`, `monitorConversionOutputs` tables; `ConversionPreviewItem`; `previewHash` convention.
- Consumes: `createMonitorDefinition(input, auth, { adoptNetworkMonitorId })` (Task 4); `createConfigPolicy`, `assignPolicy`, `addFeatureLink` (`services/configurationPolicy.ts:281, 1963, 1655`); `configPolicyFeatureLinks`, `configPolicyMonitors` (`db/schema/monitorDefinitions.ts:116`); `resolveAlert` (`services/alertService.ts`).
- Produces:
  ```ts
  export const NETWORK_CHECK_UNCONVERTIBLE = {
    alreadyManaged: 'unconvertible:already_managed',
    noOrg: 'unconvertible:no_org',
    assetMissing: 'unconvertible:asset_missing',
    conditionInvalid: 'unconvertible:condition_invalid',
  } as const;
  export interface NetworkCheckMapping { condition: NetworkCheckMonitorCondition; severity: AlertSeverity; deliveryMode: 'inherit' | 'none'; description?: string; notes: string[] }
  export function mapNetworkMonitorToDefinition(row: typeof networkMonitors.$inferSelect, rules: Array<typeof networkMonitorAlertRules.$inferSelect>): { ok: true; mapping: NetworkCheckMapping } | { ok: false; reason: string };
  export interface NetworkCheckConversionPreview { orgId: string; previewHash: string; items: Array<ConversionPreviewItem & { notes: string[]; openAlerts: number }> }
  export async function previewNetworkCheckConversion(orgId: string, auth: AuthContext): Promise<NetworkCheckConversionPreview>;
  export async function convertNetworkChecks(orgId: string, previewHash: string, auth: AuthContext, opts?: { sourceIds?: string[] }): Promise<{ conversionIds: string[]; retired: number; monitorsCreated: number; policyId: string | null }>;
  export async function retireNetworkCheck(sourceId: string, reason: string, auth: AuthContext): Promise<void>;
  export async function revertNetworkCheckConversion(conversion: typeof monitorConversions.$inferSelect, outputMonitorIds: string[], auth: AuthContext): Promise<void>;
  export async function countPendingNetworkChecks(orgId: string): Promise<number>;
  export const NETWORK_CHECKS_POLICY_NAME = (orgName: string) => `Network checks — ${orgName}`;
  ```
- Routes: `GET /monitor-definitions/conversion/network-checks?orgId=<uuid>` → `NetworkCheckConversionPreview`; `POST /monitor-definitions/conversion/network-checks/convert` `{ orgId, previewHash, sourceIds? }` → the convert result; `GET /monitor-definitions/conversion/pending?orgId` gains `networkChecks: number`.

**Mapping rules (the contract the tests pin):**
| Legacy | Monitor |
|---|---|
| `monitor_type`, `target`, `asset_id`, `polling_interval`, `timeout` | `checkType`, `target` (http: `config.url ?? target`; dns: `config.hostname ?? target`), `assetId`, `pollingIntervalSeconds`, `timeoutSeconds` |
| `config.{count,packetSize}` / `{port,expectBanner}` / `{method,expectedStatus→expectStatus,expectedBody,headers,followRedirects,verifySsl}` / `{recordType,expectedValue,nameserver}` | same-named condition keys per `NETWORK_CHECK_OPTION_KEYS`; unknown keys ignored with a note |
| rule `offline` | `consecutiveFailures` candidate 1 |
| rule `consecutive_failures_gt N` | candidate `min(100, floor(N)+1)` |
| rule `degraded` | `degradedIsFailure: true`, candidate 1 |
| rule `response_time_gt ms` | `maxResponseMs = min(existing, ms)`, candidate 1 |
| several active rules | `consecutiveFailures = min(candidates)`, `severity = highest` (critical > high > medium > low > info), note "Collapsed N alert rules…" |
| no active rules | `severity: 'info'`, `deliveryMode: 'none'`, `consecutiveFailures: 2`, note "No active alert rules: converts as info, inbox-only" |
| ≥1 active rule | `deliveryMode: 'inherit'` (the legacy `createSourcedAlert` path dispatched through routing/fallback, which is what `inherit` resolves to after W05b) |
| first rule `message` | monitor `description` |
| `is_active` | `enabled` |
| open legacy alerts (`context.source='network_monitor'`, `context.monitorId=row.id`, status active/acknowledged) | resolved in the conversion transaction with note "Resolved on conversion to monitor <id>; the monitor re-raises if the check is still failing"; ids stored in `moved_alert_ids` |

- [ ] **Step 1: Write the failing tests.** `networkChecks.test.ts` (pure mapper, no db):
  ```ts
  import { describe, expect, it } from 'vitest';
  import { mapNetworkMonitorToDefinition, NETWORK_CHECK_UNCONVERTIBLE } from './networkChecks';

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'nm-1', orgId: 'org-1', partnerId: null, managedByMonitorId: null, assetId: 'asset-1',
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
        condition: { checkType: 'icmp_ping', target: '10.0.0.1', assetId: 'asset-1', count: 4, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 1, degradedIsFailure: false } } });
    });
    it('http: url wins over target and expectedStatus becomes expectStatus', () => {
      const r = mapNetworkMonitorToDefinition(row({ monitorType: 'http_check', target: 'example.com', config: { url: 'https://example.com/health', expectedStatus: 204, method: 'HEAD' } }), [rule()]);
      expect(r.ok && r.mapping.condition).toMatchObject({ checkType: 'http_check', target: 'https://example.com/health', expectStatus: 204, method: 'HEAD' });
    });
    it('consecutive_failures_gt N → N+1; several rules collapse to min threshold / max severity with a note', () => {
      const r = mapNetworkMonitorToDefinition(row(), [rule({ condition: 'consecutive_failures_gt', threshold: '4', severity: 'critical' }), rule({ id: 'r-2', condition: 'offline', severity: 'medium' })]);
      expect(r.ok && r.mapping).toMatchObject({ severity: 'critical', condition: { consecutiveFailures: 1 } });
      expect(r.ok && r.mapping.notes.join(' ')).toMatch(/Collapsed 2 alert rules/);
    });
    it('degraded → degradedIsFailure; response_time_gt → maxResponseMs', () => {
      const r = mapNetworkMonitorToDefinition(row(), [rule({ condition: 'degraded' }), rule({ id: 'r-2', condition: 'response_time_gt', threshold: '750' })]);
      expect(r.ok && r.mapping.condition).toMatchObject({ degradedIsFailure: true, maxResponseMs: 750, consecutiveFailures: 1 });
    });
    it('no active rules → info, inbox-only, default threshold, with a note', () => {
      const r = mapNetworkMonitorToDefinition(row(), [rule({ isActive: false })]);
      expect(r.ok && r.mapping).toMatchObject({ severity: 'info', deliveryMode: 'none', condition: { consecutiveFailures: 2 } });
      expect(r.ok && r.mapping.notes.join(' ')).toMatch(/No active alert rules/);
    });
    it('refuses a managed row and a row with no org', () => {
      expect(mapNetworkMonitorToDefinition(row({ managedByMonitorId: 'def-1' }), [])).toEqual({ ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.alreadyManaged });
      expect(mapNetworkMonitorToDefinition(row({ orgId: null, partnerId: 'p-1' }), [])).toEqual({ ok: false, reason: NETWORK_CHECK_UNCONVERTIBLE.noOrg });
    });
    it('reports the failing key when the legacy config does not satisfy the kind schema', () => {
      const r = mapNetworkMonitorToDefinition(row({ pollingInterval: 5 }), [rule()]);
      expect(r).toEqual({ ok: false, reason: `${NETWORK_CHECK_UNCONVERTIBLE.conditionInvalid}:pollingIntervalSeconds` });
    });
  });
  ```
  `monitorDefinitions.conversion.networkChecks.test.ts` — mirror the mocking style of `monitorDefinitions.test.ts` (mock `../services/monitors/conversion/networkChecks`), and assert: `GET /conversion/network-checks` without `orgId` → 400; with an org the caller cannot access → 403/404 per `canAccessOrg`; `POST …/convert` without MFA → the `requireMfa()` response; a site-restricted caller (`permissions.allowedSiteIds` set) → 403 `site_restricted_conversion`; happy path forwards `{ orgId, previewHash, sourceIds }` and returns the service result.
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/api && npx vitest run src/services/monitors/conversion/networkChecks.test.ts src/routes/monitorDefinitions.conversion.networkChecks.test.ts` → `Failed to resolve import "./networkChecks"`.
- [ ] **Step 3: Implement.** `conversion/networkChecks.ts`:
  ```ts
  import { createHash } from 'node:crypto';
  import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
  import { monitorConditionSchemas, NETWORK_CHECK_OPTION_KEYS } from '@breeze/shared';
  import type { AlertSeverity, NetworkCheckMonitorCondition } from '@breeze/shared';
  import { db } from '../../../db';
  import { alerts, configurationPolicies, configPolicyFeatureLinks, configPolicyMonitors, discoveredAssets, monitorConversionOutputs, monitorConversions, networkMonitorAlertRules, networkMonitors, organizations } from '../../../db/schema';
  import type { AuthContext } from '../../../middleware/auth';
  import { addFeatureLink, assignPolicy, createConfigPolicy } from '../../configurationPolicy';
  import { resolveAlert } from '../../alertService';
  import { createMonitorDefinition, deleteMonitorDefinition } from '../monitorService';
  import type { ConversionPreviewItem } from './types'; // W05c1 — adjust to its actual export

  export const NETWORK_CHECK_UNCONVERTIBLE = {
    alreadyManaged: 'unconvertible:already_managed',
    noOrg: 'unconvertible:no_org',
    assetMissing: 'unconvertible:asset_missing',
    conditionInvalid: 'unconvertible:condition_invalid',
  } as const;

  export const NETWORK_CHECKS_POLICY_NAME = (orgName: string) => `Network checks — ${orgName}`;
  const MANAGED_NAME_PREFIX = '[monitor] ';
  const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
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
    let consecutive: number | null = null;
    let degradedIsFailure = false;
    let maxResponseMs: number | null = null;
    let severity: AlertSeverity | null = null;
    let description: string | undefined;
    for (const r of active) {
      let candidate: number | null = null;
      switch (r.condition) {
        case 'offline': candidate = 1; break;
        case 'degraded': degradedIsFailure = true; candidate = 1; break;
        case 'response_time_gt': {
          const ms = numeric(r.threshold);
          if (ms == null) { notes.push(`Rule ${r.id}: response_time_gt without a numeric threshold — ignored`); break; }
          maxResponseMs = maxResponseMs == null ? ms : Math.min(maxResponseMs, ms);
          candidate = 1;
          break;
        }
        case 'consecutive_failures_gt': {
          const n = numeric(r.threshold);
          if (n == null) { notes.push(`Rule ${r.id}: consecutive_failures_gt without a numeric threshold — ignored`); break; }
          candidate = Math.min(100, Math.max(1, Math.floor(n) + 1));
          break;
        }
        default:
          notes.push(`Rule ${r.id}: unsupported condition '${r.condition}' — ignored`);
      }
      if (candidate != null) consecutive = consecutive == null ? candidate : Math.min(consecutive, candidate);
      if (!severity || SEVERITY_RANK[r.severity] > SEVERITY_RANK[severity]) severity = r.severity;
      if (!description && r.message) description = r.message;
    }
    if (active.length > 1) notes.push(`Collapsed ${active.length} alert rules into one condition (lowest threshold, highest severity)`);
    if (rules.length > active.length) notes.push(`${rules.length - active.length} inactive alert rule(s) retired without effect`);
    if (active.length === 0) notes.push('No active alert rules: converts as info, inbox-only');

    const parsed = monitorConditionSchemas.network_check.safeParse({
      ...condition,
      consecutiveFailures: consecutive ?? 2,
      degradedIsFailure,
      ...(maxResponseMs != null ? { maxResponseMs } : {}),
    });
    if (!parsed.success) {
      return { ok: false, reason: `${NETWORK_CHECK_UNCONVERTIBLE.conditionInvalid}:${parsed.error.issues[0]?.path.join('.') ?? 'unknown'}` };
    }
    return {
      ok: true,
      mapping: { condition: parsed.data, severity: severity ?? 'info', deliveryMode: active.length === 0 ? 'none' : 'inherit', description, notes },
    };
  }
  ```
  Preview / convert / retire / revert / count (same file):
  ```ts
  function assertOrgAccess(orgId: string, auth: AuthContext): void {
    if (!auth.canAccessOrg(orgId)) throw new NetworkCheckConversionError('org_not_found', 404);
  }
  export class NetworkCheckConversionError extends Error {
    constructor(public readonly code: 'org_not_found' | 'stale_preview' | 'site_restricted', public readonly status: 404 | 409 | 403) { super(code); this.name = 'NetworkCheckConversionError'; }
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
          .where(and(eq(alerts.orgId, orgId), inArray(alerts.status, ['active', 'acknowledged']), sql`${alerts.context}->>'source' = 'network_monitor'`, sql`${alerts.context}->>'monitorId' = ANY(${ids})`))
      : [];
    return { rows, rulesByMonitor: groupBy(rules, (r) => r.monitorId), assetIds: new Set(assets.map((a) => a.id)), openAlertsByMonitor: groupBy(openAlerts, (a) => a.monitorId) };
  }

  function previewHashFor(rows: Row[], rulesByMonitor: Map<string, Rule[]>): string {
    const material = rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt.toISOString(), rules: (rulesByMonitor.get(r.id) ?? []).map((x) => [x.id, x.condition, x.threshold, x.severity, x.isActive, x.retiredAt?.toISOString() ?? null]) }));
    return createHash('sha256').update(JSON.stringify(material)).digest('hex');
  }

  export async function previewNetworkCheckConversion(orgId: string, auth: AuthContext): Promise<NetworkCheckConversionPreview> {
    assertOrgAccess(orgId, auth);
    const { rows, rulesByMonitor, assetIds, openAlertsByMonitor } = await loadPending(orgId);
    const items = rows.map((row) => {
      const rules = rulesByMonitor.get(row.id) ?? [];
      const mapped = row.assetId && !assetIds.has(row.assetId)
        ? { ok: false as const, reason: NETWORK_CHECK_UNCONVERTIBLE.assetMissing }
        : mapNetworkMonitorToDefinition(row, rules);
      const openAlerts = (openAlertsByMonitor.get(row.id) ?? []).length;
      const notes = mapped.ok ? [...mapped.mapping.notes] : [];
      if (openAlerts > 0) notes.push(`${openAlerts} open alert(s) will be resolved with a conversion note`);
      return {
        sourceTable: 'network_monitors' as const, sourceId: row.id, name: row.name,
        outcome: mapped.ok ? ('convertible' as const) : ('unconvertible' as const),
        reason: mapped.ok ? undefined : mapped.reason,
        proposed: mapped.ok ? [{ role: 'primary' as const, kind: 'network_check' as const, name: row.name, condition: mapped.mapping.condition as Record<string, unknown>, severity: mapped.mapping.severity, deliveryMode: mapped.mapping.deliveryMode, deliveryChannelIds: [], escalationPolicyId: null, responses: [] }] : [],
        notes, openAlerts,
      };
    });
    return { orgId, previewHash: previewHashFor(rows, rulesByMonitor), items };
  }

  async function findOrCreateNetworkChecksPolicy(orgId: string, auth: AuthContext): Promise<{ policyId: string; monitorsLinkId: string }> {
    // Reuse the policy of the most recent unreverted network conversion for
    // this org, so batches never sprawl into one policy per click.
    const [prior] = await db
      .select({ policyId: monitorConversions.policyId })
      .from(monitorConversions)
      .innerJoin(configurationPolicies, eq(configurationPolicies.id, monitorConversions.policyId))
      .where(and(eq(monitorConversions.orgId, orgId), eq(monitorConversions.sourceTable, 'network_monitors'), isNull(monitorConversions.revertedAt), eq(configurationPolicies.status, 'active')))
      .orderBy(desc(monitorConversions.convertedAt))
      .limit(1);
    let policyId = prior?.policyId ?? null;
    if (!policyId) {
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      const policy = await createConfigPolicy({ orgId }, { name: NETWORK_CHECKS_POLICY_NAME(org?.name ?? orgId), description: 'Holds the network_check monitors converted from the Network page. Created by the W05e conversion.' }, auth.user.id);
      if (!policy) throw new Error('Failed to create the network checks policy');
      await assignPolicy(policy.id, 'organization', orgId, 0, auth.user.id);
      await addFeatureLink(policy.id, 'monitors', null, { items: [] });
      policyId = policy.id;
    }
    const [link] = await db.select({ id: configPolicyFeatureLinks.id }).from(configPolicyFeatureLinks)
      .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'monitors'))).limit(1);
    if (!link) throw new Error(`Policy ${policyId} has no monitors feature link`);
    return { policyId, monitorsLinkId: link.id };
  }

  export async function convertNetworkChecks(orgId: string, previewHash: string, auth: AuthContext, opts: { sourceIds?: string[] } = {}) {
    assertOrgAccess(orgId, auth);
    const full = await loadPending(orgId);
    if (previewHashFor(full.rows, full.rulesByMonitor) !== previewHash) throw new NetworkCheckConversionError('stale_preview', 409);
    const selected = opts.sourceIds?.length ? full.rows.filter((r) => opts.sourceIds!.includes(r.id)) : full.rows;
    if (selected.length === 0) return { conversionIds: [], retired: 0, monitorsCreated: 0, policyId: null };

    // Same shape as ruleConversionService.ts:107-156 — one transaction, every
    // step through the services so RLS and audit see a normal caller.
    return db.transaction(async () => {
      const { policyId, monitorsLinkId } = await findOrCreateNetworkChecksPolicy(orgId, auth);
      const [{ nextSort }] = await db.select({ nextSort: sql<number>`coalesce(max(${configPolicyMonitors.sortOrder}), -1) + 1` }).from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, monitorsLinkId));
      const conversionIds: string[] = [];
      let monitorsCreated = 0;
      let sort = Number(nextSort);
      for (const row of selected) {
        const rules = full.rulesByMonitor.get(row.id) ?? [];
        const mapped = row.assetId && !full.assetIds.has(row.assetId) ? null : mapNetworkMonitorToDefinition(row, rules);
        if (!mapped || !mapped.ok) continue; // unconvertible: listed by the preview, retired only by an explicit retire
        const def = await createMonitorDefinition({
          ownerScope: 'organization', orgId, name: row.name, description: mapped.mapping.description,
          kind: 'network_check', enabled: row.isActive, condition: mapped.mapping.condition as Record<string, unknown>,
          severity: mapped.mapping.severity, cooldownMinutes: 5, autoResolve: true, responses: [],
          deliveryMode: mapped.mapping.deliveryMode, deliveryChannelIds: [], escalationPolicyId: null,
          recurrenceActions: [], pauseResponsesOnEscalation: true,
        } as Parameters<typeof createMonitorDefinition>[0], auth, { adoptNetworkMonitorId: row.id });
        await db.insert(configPolicyMonitors).values({ featureLinkId: monitorsLinkId, monitorId: def.id, enabled: true, sortOrder: sort++ });
        await db.update(networkMonitorAlertRules).set({ retiredAt: new Date(), retiredReason: 'converted' })
          .where(and(eq(networkMonitorAlertRules.monitorId, row.id), isNull(networkMonitorAlertRules.retiredAt)));
        const open = full.openAlertsByMonitor.get(row.id) ?? [];
        for (const a of open) await resolveAlert(a.id, `Resolved on conversion to monitor ${def.id}; the monitor re-raises if the check is still failing`);
        const [conv] = await db.insert(monitorConversions).values({
          orgId, partnerId: null, sourceTable: 'network_monitors', sourceId: row.id, policyId,
          convertedBy: auth.user.id, previewHash,
        }).returning({ id: monitorConversions.id });
        await db.insert(monitorConversionOutputs).values({ conversionId: conv!.id, monitorId: def.id, role: 'primary', movedAlertIds: open.map((a) => a.id) });
        conversionIds.push(conv!.id);
        monitorsCreated++;
      }
      return { conversionIds, retired: 0, monitorsCreated, policyId };
    });
  }

  export async function retireNetworkCheck(sourceId: string, reason: string, auth: AuthContext): Promise<void> {
    const [row] = await db.select().from(networkMonitors).where(and(eq(networkMonitors.id, sourceId), isNull(networkMonitors.managedByMonitorId))).limit(1);
    if (!row?.orgId) throw new NetworkCheckConversionError('org_not_found', 404);
    assertOrgAccess(row.orgId, auth);
    await db.transaction(async () => {
      const now = new Date();
      await db.update(networkMonitors).set({ retiredAt: now, retiredReason: reason, isActive: false, updatedAt: now }).where(eq(networkMonitors.id, sourceId));
      await db.update(networkMonitorAlertRules).set({ retiredAt: now, retiredReason: reason }).where(and(eq(networkMonitorAlertRules.monitorId, sourceId), isNull(networkMonitorAlertRules.retiredAt)));
      const open = await db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.orgId, row.orgId!), inArray(alerts.status, ['active', 'acknowledged']), sql`${alerts.context}->>'source' = 'network_monitor'`, sql`${alerts.context}->>'monitorId' = ${sourceId}`));
      for (const a of open) await resolveAlert(a.id, `Resolved: network check retired (${reason})`);
    });
  }

  export async function revertNetworkCheckConversion(conversion: typeof monitorConversions.$inferSelect, outputMonitorIds: string[], auth: AuthContext): Promise<void> {
    if (!conversion.orgId) throw new NetworkCheckConversionError('org_not_found', 404);
    assertOrgAccess(conversion.orgId, auth);
    await db.transaction(async () => {
      // ORDER MATTERS: managed_by_monitor_id is ON DELETE CASCADE to the
      // definition. Un-adopt first, then delete the definition, or the legacy
      // row and its whole result history go with it.
      await db.update(networkMonitors)
        .set({ managedByMonitorId: null, name: sql`regexp_replace(${networkMonitors.name}, '^\\[monitor\\] ', '')`, updatedAt: new Date() })
        .where(eq(networkMonitors.id, conversion.sourceId));
      await db.update(networkMonitorAlertRules).set({ retiredAt: null, retiredReason: null })
        .where(and(eq(networkMonitorAlertRules.monitorId, conversion.sourceId), eq(networkMonitorAlertRules.retiredReason, 'converted')));
      for (const id of outputMonitorIds) await deleteMonitorDefinition(id, auth);
      await db.update(monitorConversions).set({ revertedAt: new Date() }).where(eq(monitorConversions.id, conversion.id));
    });
  }

  export async function countPendingNetworkChecks(orgId: string): Promise<number> {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(networkMonitors)
      .where(and(eq(networkMonitors.orgId, orgId), isNull(networkMonitors.managedByMonitorId), isNull(networkMonitors.retiredAt)));
    return Number(r?.n ?? 0);
  }
  ```
  (`groupBy` is a 4-line local helper returning `Map<string, T[]>`.) The resolved alerts are **not** re-opened on revert — say so in the ledger UI copy (W05c2 panel) and in the docs.

  W05c1 wiring (its module): `retireSource` — `case 'network_monitors': return retireNetworkCheck(sourceId, reason, auth);`. `revertConversion` — after loading the ledger row and its outputs: `if (conversion.sourceTable === 'network_monitors') return revertNetworkCheckConversion(conversion, outputs.map((o) => o.monitorId), auth);`. `convertPartnerLegacy(partnerId, auth)` — after the policy loop: for each org under the partner (`organizations.partnerId = partnerId`), `const p = await previewNetworkCheckConversion(org.id, auth); const r = await convertNetworkChecks(org.id, p.previewHash, auth); converted += r.monitorsCreated; unconvertible += p.items.filter((i) => i.outcome === 'unconvertible').length;`. Pending count handler — add `networkChecks: await countPendingNetworkChecks(orgId)`.

  Routes (`routes/monitorDefinitions.ts`, next to W05c1's conversion routes, **before** `/:id`):
  ```ts
  const networkChecksQuerySchema = z.object({ orgId: z.string().uuid() });
  const networkChecksConvertSchema = z.object({ orgId: z.string().uuid(), previewHash: z.string().length(64), sourceIds: z.array(z.string().uuid()).max(500).optional() });

  function siteRestricted(c: Context): boolean {
    const permissions = c.get('permissions') as UserPermissions | undefined;
    return Array.isArray(permissions?.allowedSiteIds);
  }

  monitorDefinitionRoutes.get('/conversion/network-checks', requireScope('organization', 'partner', 'system'), requireAlertRead, zValidator('query', networkChecksQuerySchema), async (c) => {
    try {
      return c.json(await previewNetworkCheckConversion(c.req.valid('query').orgId, c.get('auth')));
    } catch (err) {
      if (err instanceof NetworkCheckConversionError) return c.json({ error: err.code }, err.status);
      throw err;
    }
  });

  monitorDefinitionRoutes.post('/conversion/network-checks/convert', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), zValidator('json', networkChecksConvertSchema), async (c) => {
    // The conversion writes an ORG-assigned policy; a site-restricted technician
    // must not be able to widen their ceiling through it.
    if (siteRestricted(c)) return c.json({ error: 'site_restricted_conversion' }, 403);
    const body = c.req.valid('json');
    try {
      const result = await convertNetworkChecks(body.orgId, body.previewHash, c.get('auth'), { sourceIds: body.sourceIds });
      writeRouteAudit(c, { orgId: body.orgId, action: 'network_check.convert_to_monitor', resourceType: 'config_policy', resourceId: result.policyId ?? body.orgId, details: { monitorsCreated: result.monitorsCreated, sourceIds: body.sourceIds ?? null } });
      return c.json(result);
    } catch (err) {
      if (err instanceof NetworkCheckConversionError) return c.json({ error: err.code }, err.status);
      throw err;
    }
  });
  ```
  Allowlists — `partner-wide-write-coverage.test.ts` (in the `network_monitors` block after line 71):
  `'services/monitors/conversion/networkChecks.ts': 'W05e conversion is org-axis only: every network_monitors write is scoped org_id = <org> AND managed_by_monitor_id IS NULL, and adoption in monitorCompiler.ts refuses a row outside the definition\'s org; a partner-wide (org_id NULL) row can never match',` and the equivalent entry in `site-ceiling-write-coverage.test.ts` with reason `'route refuses site-restricted callers (403 site_restricted_conversion) before the service runs; the service writes an org-assigned policy'`.
- [ ] **Step 4: Run, expect PASS.**
  ```bash
  cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors/conversion/networkChecks.test.ts src/routes/monitorDefinitions.conversion.networkChecks.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts src/services/monitors/conversion
  ```
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/conversion apps/api/src/routes/monitorDefinitions.ts apps/api/src/routes/monitorDefinitions.conversion.networkChecks.test.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts apps/api/src/__tests__/site-ceiling-write-coverage.test.ts && git commit -m "feat(monitors): convert unmanaged network checks into network_check monitors through the conversion ledger"`

---

### Task 6: Legacy write paths return 410; results list exposes the managed link; asset delete guards managed checks (PR1)

**Files:**
- Modify: `apps/api/src/routes/monitors.ts` (`POST /` 461-522, `PATCH /:id` 639-707, `POST /alerts` 870-905, `PATCH /alerts/:id` 925-957, `DELETE /alerts/:id` 959-986; dead schemas 223-238, 261-343; list projection 430-456)
- Modify: `apps/api/src/routes/monitors_list_create.test.ts`, `monitors_alerts.test.ts`, `monitors_detail.test.ts`
- Modify: `apps/api/src/routes/discovery.ts` (`DELETE /assets/:id`, 1699-1750)

**Interfaces:**
- Produces: `410 { error: 'network_check_authoring_retired', message, hint: { route: 'POST /monitor-definitions', kind: 'network_check' } }` on every retired write; `GET /monitors` items gain `managedByMonitorId: string | null`, `retiredAt: string | null`; query `includeRetired?: 'true'` (default excludes retired rows); `DELETE /discovery/assets/:id` → `409 { error: 'asset_has_managed_network_checks', monitorIds: string[] }`.
- Kept: `GET /monitors`, `GET /monitors/dashboard`, `GET /monitors/:id`, `GET /monitors/:id/results`, `GET /monitors/:monitorId/alerts` (read), `POST /monitors/:id/check`, `POST /monitors/:id/test`, `DELETE /monitors/:id` (unmanaged only; managed → 409 unchanged).

- [ ] **Step 1: Write the failing tests.** In `monitors_list_create.test.ts` replace every "creates a monitor" case with:
  ```ts
  it('POST /monitors is retired: 410 with a pointer to monitor definitions (W05e)', async () => {
    const res = await app.request('/monitors', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'x', monitorType: 'icmp_ping', target: '10.0.0.1' }) });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: 'network_check_authoring_retired', hint: { route: 'POST /monitor-definitions', kind: 'network_check' } });
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
  it('GET /monitors projects managedByMonitorId and hides retired rows unless includeRetired=true', async () => { /* seed two rows, one retired; assert 1 vs 2 and the field */ });
  ```
  In `monitors_alerts.test.ts` replace create/update/delete rule cases with 410 assertions (keep the `GET /:monitorId/alerts` read case). In `monitors_detail.test.ts` replace the PATCH cases with one 410 assertion (managed and unmanaged alike). Keep every 401/403 middleware case — the 410 sits **behind** `requireScope`/`requireMonitorWrite`/`requireMfa()`, so unauthenticated callers still get 401.
  For discovery, in the nearest `discovery*.test.ts` that covers `DELETE /assets/:id`: seed a managed check bound to the asset and assert 409 with `monitorIds`; and that no `delete` was issued.
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/api && npx vitest run src/routes/monitors_list_create.test.ts src/routes/monitors_alerts.test.ts src/routes/monitors_detail.test.ts` → `expected 201 to be 410`.
- [ ] **Step 3: Implement.** `routes/monitors.ts`:
  ```ts
  // W05e — network checks are authored as monitors of kind `network_check`.
  // Every write that used to author a check or its alert rules is retired
  // (410 Gone, spec §Removed screens). Reads, DELETE of an unmanaged check,
  // and the operational check/test endpoints stay.
  const NETWORK_CHECK_AUTHORING_RETIRED = {
    error: 'network_check_authoring_retired',
    message: 'Network checks are authored as monitors. Create or edit a monitor of kind network_check under Alerts → Monitors.',
    hint: { route: 'POST /monitor-definitions', kind: 'network_check' },
  } as const;
  const authoringRetired = (c: Context) => c.json(NETWORK_CHECK_AUTHORING_RETIRED, 410);
  ```
  Replace the five handlers' bodies with `async (c) => authoringRetired(c)` while keeping their middleware chains (`requireScope(...)`, `requireMonitorWrite`, `requireMfa()`), drop their `zValidator` lines, and delete `validateMonitorConfigForType`, `icmpConfigSchema`…`dnsConfigSchema`, `createMonitorSchema`, `updateMonitorSchema`, `createAlertRuleSchema`, `updateAlertRuleSchema`, `monitorTypes` if now unused (keep `listMonitorsSchema` and add `includeRetired: z.enum(['true', 'false']).optional()`). In the list handler add `if (query.includeRetired !== 'true') conditions.push(isNull(networkMonitors.retiredAt));` and project `managedByMonitorId: m.managedByMonitorId, retiredAt: m.retiredAt?.toISOString() ?? null`. `POST /:id/check` and `/:id/test` keep working for managed rows too (they go through `requireMonitorAccess`, which only refuses partner-wide rows).
  `routes/discovery.ts` — before the transaction at ~1730:
  ```ts
  // W05e — a compiled network_check probe is bound to this asset. Deleting the
  // asset from under it would delete the managed row behind the compiler (the
  // handler would then read "not provisioned" forever). Refuse and name them.
  const managedChecks = await db
    .select({ monitorId: networkMonitors.managedByMonitorId })
    .from(networkMonitors)
    .where(and(eq(networkMonitors.assetId, assetId), eq(networkMonitors.orgId, existing.orgId), isNotNull(networkMonitors.managedByMonitorId)));
  if (managedChecks.length > 0) {
    return c.json({ error: 'asset_has_managed_network_checks', monitorIds: managedChecks.map((m) => m.monitorId) }, 409);
  }
  ```
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/routes/monitors src/routes/discovery src/services/aiToolsMonitoring.siteScope.test.ts` (check the reported file count — `src/routes/monitors` is a substring match and also pulls in `monitoring*.test.ts`; that is intended here).
- [ ] **Step 5: Commit.** `git add apps/api/src/routes/monitors.ts apps/api/src/routes/monitors_list_create.test.ts apps/api/src/routes/monitors_alerts.test.ts apps/api/src/routes/monitors_detail.test.ts apps/api/src/routes/discovery.ts apps/api/src/routes/discovery*.test.ts && git commit -m "feat(api): retire network-check authoring on /monitors (410); guard asset delete against managed checks"`

---

### Task 7: Integration proof — adopt, poll, one alert through the compiled rule, revert (PR1)

**Files:**
- Create: `apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts`
- Test infra: `apps/api/src/__tests__/integration/setup.ts`, `db-utils.ts` (`createPartner`, `createOrganization`, `createSite`, `createUser`)

**Interfaces consumed:** `previewNetworkCheckConversion`, `convertNetworkChecks`, `revertConversion` (W05c1), `recordMonitorCheckResult` (`jobs/monitorWorker.ts:496`), `networkCheckHandler`, `evaluateDeviceAlerts` (`services/alertService.ts:998`), `publishEvent` (`services/eventBus`).

- [ ] **Step 1: Write the failing test.**
  ```ts
  /**
   * W05e — a converted network check keeps producing results and raises its
   * alert through the MONITOR path (compiled alert rule + alert.triggered),
   * exactly once per org, on the device the legacy worker used. Real Postgres
   * under RLS; alertCooldown falls back to memory without Redis.
   */
  import './setup';
  import { randomUUID } from 'node:crypto';
  import { afterEach, describe, expect, it, vi } from 'vitest';
  import { and, eq, sql } from 'drizzle-orm';
  import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
  import { alerts, configPolicyAssignments, configurationPolicies, devices, discoveredAssets, monitorConversions, monitorDefinitions, networkMonitorAlertRules, networkMonitorResults, networkMonitors } from '../../db/schema';
  import type { AuthContext } from '../../middleware/auth';
  import { createOrganization, createPartner, createSite, createUser } from './db-utils';

  const publishEventMock = vi.fn(async () => undefined);
  vi.mock('../../services/eventBus', async (orig) => ({ ...(await orig<typeof import('../../services/eventBus')>()), publishEvent: publishEventMock }));

  const { previewNetworkCheckConversion, convertNetworkChecks } = await import('../../services/monitors/conversion/networkChecks');
  const { revertConversion } = await import('../../services/monitors/conversion'); // W05c1
  const { recordMonitorCheckResult } = await import('../../jobs/monitorWorker');
  const { networkCheckHandler } = await import('../../services/alertConditions/handlers/networkCheck');
  const { evaluateDeviceAlerts } = await import('../../services/alertService');

  function orgAuth(orgId: string, partnerId: string, userId: string): AuthContext {
    return {
      user: { id: userId }, token: null, partnerId, orgId, scope: 'organization',
      accessibleOrgIds: [orgId], partnerOrgAccess: 'all',
      orgCondition: (col: unknown) => eq(col as never, orgId),
      canAccessOrg: (id: string) => id === orgId,
    } as unknown as AuthContext;
  }
  function orgCtx(orgId: string, partnerId: string, userId: string): DbAccessContext {
    return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId, currentPartnerId: partnerId };
  }

  async function insertDevice(orgId: string, siteId: string) {
    const u = randomUUID().slice(0, 8);
    const [d] = await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId, siteId, agentId: `w05e-${u}`, hostname: `w05e-${u}`, osType: 'linux', osVersion: '22.04',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', lastSeenAt: new Date(), isEphemeral: false,
    }).returning());
    return d!;
  }

  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; publishEventMock.mockClear(); });

  describe('network check conversion (W05e)', () => {
    it('adopts the row, retires its rules, and alerts once through the compiled rule on the linked device', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org.id });
      const user = await createUser({ partnerId: partner.id, orgId: org.id });
      const linked = await insertDevice(org.id, site.id);   // the asset's device → the alert device
      const prober = await insertDevice(org.id, site.id);   // runs the probe, must NOT alert
      const [asset] = await withSystemDbAccessContext(() => db.insert(discoveredAssets).values({ orgId: org.id, siteId: site.id, ipAddress: '10.9.9.1', hostname: 'gw', linkedDeviceId: linked.id } as never).returning());
      const [legacy] = await withSystemDbAccessContext(() => db.insert(networkMonitors).values({ orgId: org.id, assetId: asset!.id, name: 'Gateway', monitorType: 'icmp_ping', target: '10.9.9.1', config: { count: 4 }, pollingInterval: 60, timeout: 5 }).returning());
      await withSystemDbAccessContext(() => db.insert(networkMonitorAlertRules).values({ monitorId: legacy!.id, condition: 'consecutive_failures_gt', threshold: '1', severity: 'high' }));
      cleanup.push(async () => withSystemDbAccessContext(async () => {
        await db.delete(alerts).where(eq(alerts.orgId, org.id));
        await db.delete(monitorConversions).where(eq(monitorConversions.orgId, org.id));
        await db.delete(monitorDefinitions).where(eq(monitorDefinitions.orgId, org.id));
        await db.delete(networkMonitors).where(eq(networkMonitors.orgId, org.id));
        await db.delete(configurationPolicies).where(eq(configurationPolicies.orgId, org.id));
        await db.delete(discoveredAssets).where(eq(discoveredAssets.orgId, org.id));
        await db.delete(devices).where(eq(devices.orgId, org.id));
      }));

      const auth = orgAuth(org.id, partner.id, user.id);
      const ctx = orgCtx(org.id, partner.id, user.id);

      const preview = await withDbAccessContext(ctx, () => previewNetworkCheckConversion(org.id, auth));
      expect(preview.items).toHaveLength(1);
      expect(preview.items[0]).toMatchObject({ outcome: 'convertible', proposed: [{ kind: 'network_check', severity: 'high', condition: { consecutiveFailures: 2, assetId: asset!.id } }] });

      const result = await withDbAccessContext(ctx, () => convertNetworkChecks(org.id, preview.previewHash, auth));
      expect(result.monitorsCreated).toBe(1);

      // Adopted in place: same row id, now managed, history intact, asset kept.
      const [row] = await withSystemDbAccessContext(() => db.select().from(networkMonitors).where(eq(networkMonitors.id, legacy!.id)));
      expect(row!.managedByMonitorId).toBeTruthy();
      expect(row!.assetId).toBe(asset!.id);
      expect(row!.name).toBe('[monitor] Gateway');
      expect(row!.config).toEqual({ count: 4 });
      const [rule] = await withSystemDbAccessContext(() => db.select().from(networkMonitorAlertRules).where(eq(networkMonitorAlertRules.monitorId, legacy!.id)));
      expect(rule!.retiredReason).toBe('converted');
      const [def] = await withSystemDbAccessContext(() => db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, row!.managedByMonitorId!)));
      const [assignment] = await withSystemDbAccessContext(() => db.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, result.policyId!)));
      expect(assignment).toMatchObject({ level: 'organization', targetId: org.id });

      // Two offline results from the prober, attributed to the org.
      for (let i = 0; i < 2; i++) {
        await withSystemDbAccessContext(() => recordMonitorCheckResult(legacy!.id, { monitorId: legacy!.id, status: 'offline', responseMs: 0, error: 'timeout' }, { orgId: org.id, deviceId: prober.id }));
      }
      const legacyAlerts = await withSystemDbAccessContext(() => db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.orgId, org.id), sql`${alerts.context}->>'source' = 'network_monitor'`)));
      expect(legacyAlerts).toHaveLength(0); // the legacy worker no longer raises for a converted check

      const cond = { type: 'network_check', monitorId: def!.id, consecutiveFailures: 2 };
      expect((await withSystemDbAccessContext(() => networkCheckHandler.evaluate(cond, linked.id))).passed).toBe(true);
      expect((await withSystemDbAccessContext(() => networkCheckHandler.evaluate(cond, prober.id))).passed).toBe(false);

      const raised = await withSystemDbAccessContext(() => evaluateDeviceAlerts(linked.id));
      expect(raised.length).toBeGreaterThanOrEqual(1);
      const [alert] = await withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.id, raised[0]!)));
      expect(alert!.ruleId).toBe(def!.compiledAlertRuleId);
      expect(alert!.deviceId).toBe(linked.id);
      expect(publishEventMock).toHaveBeenCalledWith('alert.triggered', org.id, expect.objectContaining({ monitorId: def!.id, kind: 'network_check' }), expect.anything(), expect.anything());
      expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(prober.id))).toHaveLength(0);

      // Revert: un-adopt BEFORE deleting the definition, history survives.
      await withDbAccessContext(ctx, () => revertConversion(result.conversionIds[0]!, auth));
      const [reverted] = await withSystemDbAccessContext(() => db.select().from(networkMonitors).where(eq(networkMonitors.id, legacy!.id)));
      expect(reverted).toMatchObject({ managedByMonitorId: null, name: 'Gateway' });
      const results = await withSystemDbAccessContext(() => db.select().from(networkMonitorResults).where(eq(networkMonitorResults.monitorId, legacy!.id)));
      expect(results).toHaveLength(2);
      const [ruleBack] = await withSystemDbAccessContext(() => db.select().from(networkMonitorAlertRules).where(eq(networkMonitorAlertRules.monitorId, legacy!.id)));
      expect(ruleBack!.retiredAt).toBeNull();
    });
  });
  ```
  (`alert.triggered` carries `monitorId` and `kind` after W05c1 — brief line "alert.triggered payload gains monitorId and kind". If `publishEvent`'s positional signature differs, match the call at `alertService.ts:110`.)
- [ ] **Step 2: Run it, expect FAIL.** `pnpm test-stack up && cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/networkCheckConversion.integration.test.ts` — before Tasks 3–5 this fails at the import; after them it must pass on the first full run. If it fails on `configPolicyAssignments` naming, check `db/schema/configurationPolicies.ts` for the assignments table export name.
- [ ] **Step 3: Implement.** Nothing new — this task proves Tasks 1–6. If the `prober.id` evaluation raises an alert, Task 3's gate is not wired into the handler the sweep actually calls (check `alertConditions/registry.ts` registers the edited handler).
- [ ] **Step 4: Run, expect PASS.** Same command; then `pnpm test-stack down`.
- [ ] **Step 5: Commit.** `git add apps/api/src/__tests__/integration/networkCheckConversion.integration.test.ts && git commit -m "test(monitors): integration proof that a converted network check alerts once through the monitor path"`

---

### Task 8: Network page — nav label, titles, tabs, "New check" (PR2)

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (line 275), `Sidebar.nav.test.tsx` (lines 86, 179-185, 334)
- Modify: `apps/web/src/components/monitoring/MonitoringPage.tsx` (whole file, 135 lines), `MonitoringPage.test.tsx`
- Modify: `apps/web/src/locales/*/common.json` (`nav.networkMonitor`, `longTail.monitoring.MonitoringPage.*`), `apps/web/src/locales/*/pages.json` (`titles.monitoring`)

**Interfaces:**
- Produces: tabs `assets | templates | results`; hash `#checks` parsed as `results`; `MonitoringPage` "New check" button (`data-testid="monitoring-page-new-check"`) → `navigateTo('/alerts/monitors/new?kind=network_check[&assetId=…]')`.

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
    expect(navigateToMock).toHaveBeenCalledWith('/alerts/monitors/new?kind=network_check');
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
  …
  const [activeTab, setActiveTab] = useHashState<MonitoringTab>('assets', parseTab);
  …
  {activeTab === 'results' && (
    <button type="button" data-testid="monitoring-page-new-check"
      onClick={() => void navigateTo(`/alerts/monitors/new?kind=network_check${initialAssetId ? `&assetId=${encodeURIComponent(initialAssetId)}` : ''}`)}
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

### Task 9: Results tab is read-only; conversion banner; device page hands off to the editor (PR2)

**Files:**
- Modify: `apps/web/src/components/monitors/NetworkMonitorList.tsx` (lines 21-22, 99, 239-247, 265-277, 342-350, 361-371)
- Create: `apps/web/src/components/monitors/NetworkMonitorList.test.tsx`, `NetworkCheckConversionBanner.tsx`, `NetworkCheckConversionBanner.test.tsx`
- Modify: `apps/web/src/components/monitors/MonitorDetailModal.tsx` (remove 105-111 edit state, 151-180 `handleSave`, 287-371 edit button + form, 413-437 alert rules), `MonitorDetailModal.test.tsx`
- Delete: `apps/web/src/components/monitors/CreateMonitorForm.tsx`
- Modify: `apps/web/src/components/devices/networkDevice/settings/MonitoringSection.tsx` (lines 5, 67, 337-340), `useNetworkAssetMutations.ts` (lines 171-179), `useNetworkAssetMutations.test.ts`
- Modify: `apps/web/src/locales/*/common.json`, `*/devices.json`

**Interfaces:**
- Consumes: `GET /monitors` items with `managedByMonitorId`; `GET /monitor-definitions/conversion/network-checks?orgId`; `POST /monitor-definitions/conversion/network-checks/convert`.
- Produces: `NetworkCheckConversionBanner({ orgId, onConverted })` — shows "N network checks are not monitors yet" with **Review and convert** → dialog listing each item (name, outcome, notes) → **Convert N** (runAction) → `onConverted()`. `NetworkMonitorList` row: Monitor column (`Open monitor` link to `/alerts/monitors/<id>` or a `Not converted` badge); Delete only when `managedByMonitorId === null`.

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
      vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [row({ managedByMonitorId: 'def-1' })] }));
      render(<NetworkMonitorList />);
      const link = await screen.findByTestId('network-check-open-monitor');
      expect(link).toHaveAttribute('href', '/alerts/monitors/def-1');
      expect(screen.queryByTestId('network-check-delete')).toBeNull();
      expect(screen.queryByText(/add monitor/i)).toBeNull();
    });
    it('marks an unconverted check and renders the conversion banner', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [row()] }));
      render(<NetworkMonitorList />);
      expect(await screen.findByTestId('network-check-not-converted')).toBeInTheDocument();
      expect(screen.getByTestId('conversion-banner')).toBeInTheDocument();
    });
  });
  ```
  `NetworkCheckConversionBanner.test.tsx`: preview returns 2 items (one convertible with a note, one unconvertible) → banner text "2 network checks…", dialog lists both, the unconvertible shows its reason; clicking Convert posts `{ orgId, previewHash, sourceIds: [convertibleId] }` and calls `onConverted`. `MonitorDetailModal.test.tsx`: delete the two PATCH/edit cases; add "shows Open monitor for a managed check and no edit button" and "shows Not converted for an unmanaged check". `useNetworkAssetMutations.test.ts`: remove the `createCheck` case; assert the hook no longer exposes it (`expect('createCheck' in result.current).toBe(false)`).
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

  type Item = { sourceId: string; name: string; outcome: 'convertible' | 'unconvertible'; reason?: string; notes: string[]; openAlerts: number };
  type Preview = { orgId: string; previewHash: string; items: Item[] };

  export default function NetworkCheckConversionBanner({ orgId, onConverted }: { orgId: string; onConverted: () => void }) {
    const { t } = useTranslation('common');
    const [preview, setPreview] = useState<Preview | null>(null);
    const [open, setOpen] = useState(false);
    const [converting, setConverting] = useState(false);

    const load = useCallback(async () => {
      const res = await fetchWithAuth(`/monitor-definitions/conversion/network-checks?orgId=${encodeURIComponent(orgId)}`);
      if (!res.ok) { setPreview(null); return; }
      setPreview((await res.json()) as Preview);
    }, [orgId]);
    useEffect(() => { void load(); }, [load]);

    const convertible = preview?.items.filter((i) => i.outcome === 'convertible') ?? [];
    if (!preview || preview.items.length === 0) return null;

    const convert = async () => {
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
        onConverted();
        await load();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('longTail.monitors.NetworkCheckConversionBanner.failed') });
      } finally {
        setConverting(false);
      }
    };

    return (
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
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-md border px-4 text-sm">{t('common:actions.cancel')}</button>
            <button type="button" data-testid="network-check-conversion-confirm" disabled={converting || convertible.length === 0} onClick={() => void convert()} className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">
              {t('longTail.monitors.NetworkCheckConversionBanner.convert', { count: convertible.length })}
            </button>
          </div>
        </Dialog>
      </div>
    );
  }
  ```
  `NetworkMonitorList.tsx`: drop `CreateMonitorForm` import/state (21, 99, 361-371); type gains `managedByMonitorId: string | null; retiredAt: string | null`; replace the Add Monitor button (239-247) with a link-styled button to `navigateTo('/alerts/monitors/new?kind=network_check' + (filterAssetId ? `&assetId=${…}` : ''))` labelled `actions.newCheck`; empty state (265-277) → `empty.prefix` "No network checks yet." + the same navigate; add a **Monitor** column after Target: managed → `<a data-testid="network-check-open-monitor" href={`/alerts/monitors/${monitor.managedByMonitorId}`}>{t('…headers.openMonitor')}</a>`, else `<span data-testid="network-check-not-converted" className="rounded-full bg-warning/15 px-2 py-0.5 text-xs">{t('…notConverted')}</span>`; delete button (342-350) gets `data-testid="network-check-delete"` and renders only when `!monitor.managedByMonitorId`; render `<NetworkCheckConversionBanner orgId={currentOrgId} onConverted={fetchMonitors} />` above the table when `currentOrgId && !filterAssetId`. Wrap `handleCheck`/`handleConfirmDelete` in `runAction` (they are POST/DELETE — `no-silent-mutations.test.ts` will flag the file once it is touched; check `apps/web/src/lib/runActionAllowlist.ts` first).
  `MonitorDetailModal.tsx`: remove the edit state, `handleSave`, the Edit button and form, and the Alert Rules section; type gains `managedByMonitorId: string | null`; after the status bar render:
  ```tsx
  {monitor.managedByMonitorId
    ? <a data-testid="monitor-check-open-monitor" href={`/alerts/monitors/${monitor.managedByMonitorId}`} className="mt-3 inline-block text-sm text-primary hover:underline">{t('longTail.monitors.MonitorDetailModal.openMonitor')}</a>
    : <p data-testid="monitor-check-not-converted" className="mt-3 text-sm text-muted-foreground">{t('longTail.monitors.MonitorDetailModal.notConverted')}</p>}
  ```
  and show the footer Delete only when unmanaged. Delete `CreateMonitorForm.tsx`. `MonitoringSection.tsx`: remove the import (5) and `addingCheck` render (337-340); the Add check button navigates to `/alerts/monitors/new?kind=network_check&assetId=${assetId}` and a hint line `networkDeviceDetailPage.settings.monitoring.addCheckHint` sits under the checks list. `useNetworkAssetMutations.ts`: delete `createCheck` (171-179).
  i18n (8 locales; en shown, translate the rest): `longTail.monitors.NetworkMonitorList.actions.newCheck` "New check", `headers.monitor` "Monitor", `headers.openMonitor` "Open monitor", `notConverted` "Not converted", `empty.prefix` "No network checks yet.", `empty.action` "Create one as a monitor."; delete `actions.addMonitor`; `longTail.monitors.MonitorDetailModal.openMonitor` "Open the monitor that owns this check", `.notConverted` "This check is not a monitor yet — convert it from the Results tab."; delete `MonitorDetailModal.fields.*`, `.targetResetNote`, `.saved`, `.actions.cancelEdit`, `.alertRules.*`, `.errors.updateMonitor`; delete the whole `longTail.monitors.CreateMonitorForm` block; `longTail.monitors.NetworkCheckConversionBanner.{pending: "{{count}} network check(s) on this page are not monitors yet.", review: "Review and convert", title: "Convert network checks to monitors", convert: "Convert {{count}}", converted: "Converted {{count}} network check(s) to monitors", failed: "Could not convert network checks", outcome.convertible: "Convertible", outcome.unconvertible: "Cannot convert"}`; `devices.json` — delete `networkDeviceDetailPage.settings.toasts.checkCreated`/`checkCreateFailed`, add `networkDeviceDetailPage.settings.monitoring.addCheckHint` "Checks are authored as monitors. Add check opens the monitor editor bound to this asset."
- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/monitors src/components/devices/networkDevice src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/i18n`
- [ ] **Step 5: Commit.** `git add -A apps/web/src/components/monitors apps/web/src/components/devices/networkDevice/settings apps/web/src/locales && git commit -m "feat(web): Results tab is read-only with a conversion banner; device page hands check creation to the monitor editor"`

---

### Task 10: Monitor editor — `?kind`/`?assetId` prefill and the asset binding chip (PR2)

**Files:**
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (props at 137-139; mount effect near 343-353; condition section render)
- Create: `apps/web/src/components/monitoring/NetworkCheckAssetBinding.tsx`
- Modify: `apps/web/src/components/monitoring/MonitorEditor.test.tsx`
- Modify: `apps/web/src/locales/*/monitoring.json` (`editor.networkCheckAsset.*`)

**Interfaces:**
- Consumes: `GET /discovery/assets/:id` (`routes/discovery.ts:1185`; the response envelope is what `useAssetMonitoring.ts:75-114` already reads — mirror its parsing).
- Produces: on a new monitor, `?kind=<MonitorKind>` selects the kind (and `defaultConditionFor(kind)`); `?assetId=<uuid>` with `kind=network_check` sets `condition.assetId`, `condition.target = asset.ipAddress ?? asset.hostname`, and a default name `Ping <label>` (icmp) if the name is empty. `NetworkCheckAssetBinding({ assetId, onUnbind })` renders the asset label/IP or "Not bound — probe runs from any online agent in the org".

- [ ] **Step 1: Write the failing test** (`MonitorEditor.test.tsx`, following its existing `fetchWithAuth` mocking):
  ```ts
  it('prefills kind and asset from the query string for a new monitor (W05e)', async () => {
    window.history.pushState({}, '', '/alerts/monitors/new?kind=network_check&assetId=11111111-1111-4111-8111-111111111111');
    mockFetch({ '/discovery/assets/11111111-1111-4111-8111-111111111111': { data: { id: '11111111-1111-4111-8111-111111111111', label: 'Core switch', ipAddress: '10.0.0.2', hostname: 'core-sw', orgId: 'org-1' } } });
    render(<MonitorEditor />);
    expect(await screen.findByTestId('network-check-asset-binding')).toHaveTextContent('Core switch');
    expect((screen.getByLabelText('Target') as HTMLInputElement).value).toBe('10.0.0.2');
    expect((screen.getByLabelText('Check type') as HTMLSelectElement).value).toBe('icmp_ping');
  });
  it('ignores an unknown kind in the query string', async () => {
    window.history.pushState({}, '', '/alerts/monitors/new?kind=bogus');
    render(<MonitorEditor />);
    expect((await screen.findByLabelText('Kind') as HTMLSelectElement).value).toBe('cpu');
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/MonitorEditor.test.tsx` → `Unable to find … network-check-asset-binding`.
- [ ] **Step 3: Implement.** In `MonitorEditor.tsx`, after the fetch effect (343-353):
  ```ts
  // W05e — deep link from the Network page / device page: a fresh editor
  // opened with ?kind=network_check&assetId=… Query params (not the hash) on
  // purpose: this is a one-shot prefill of a new form, the same precedent
  // MonitoringPage sets with /monitoring?assetId=.
  useEffect(() => {
    if (!isNew || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const kind = params.get('kind');
    if (!kind || !(MONITOR_KINDS as readonly string[]).includes(kind)) return;
    handleKindChange(kind as MonitorKind);
    const assetId = params.get('assetId');
    if (kind !== 'network_check' || !assetId || !/^[0-9a-f-]{36}$/i.test(assetId)) return;
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
    assetId={(watch('condition') as { assetId?: string }).assetId ?? null}
    onUnbind={() => { const { assetId: _drop, ...rest } = watch('condition') as Record<string, unknown>; setValue('condition', rest, { shouldDirty: true }); }}
  />
  ```
  `NetworkCheckAssetBinding.tsx` fetches `/discovery/assets/:id` when `assetId` is set and renders `<div data-testid="network-check-asset-binding">` with `t('monitoring:editor.networkCheckAsset.bound', { label, ip })` + an **Unbind** button, or `t('monitoring:editor.networkCheckAsset.unbound')` when null. i18n `monitoring.json` `editor.networkCheckAsset` (8 locales): `bound` "Bound to asset {{label}} ({{ip}}) — probes run from this asset's site and alert on its linked device", `unbind` "Unbind", `unbound` "Not bound to an asset — the probe runs from any online agent in the organization". Translate for de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR (no English echoes).
  A picker for choosing an asset from inside the editor is deliberately not built this wave — binding comes from the Network page and the device page deep links; file a follow-up.
- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/monitoring/MonitorEditor.test.tsx src/components/monitoring/MonitorConditionFields src/lib/__tests__/i18n`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring/MonitorEditor.tsx apps/web/src/components/monitoring/NetworkCheckAssetBinding.tsx apps/web/src/components/monitoring/MonitorEditor.test.tsx apps/web/src/locales && git commit -m "feat(web): monitor editor prefills kind and asset from the query string; network_check asset binding"`

---

### Task 11: AI tools — `manage_monitors` create/update refuse with a pointer; reads stay (PR3)

**Files:**
- Modify: `apps/api/src/services/aiToolsMonitoring.ts` (`query_monitors` ~66-190; `manage_monitors` definition 197-228; create 305-346; update 348-380)
- Modify: `apps/api/src/services/aiToolsMonitoring.test.ts` (350-420), `aiToolsMonitoring.deviceScope.test.ts` (if it exercises create/update)
- Modify: `apps/api/src/services/aiToolsMonitors.ts` (`manage_monitor_definitions` description ~375)

**Interfaces:**
- Produces: `manage_monitors` `create`/`update` → `{ error: 'network_check_authoring_retired', useTool: 'manage_monitor_definitions', example: { action: 'create', definition: { kind: 'network_check', name: '…', condition: { checkType: 'icmp_ping', target: '10.0.0.1', assetId: '<optional asset uuid>' } } } }`; `get`/`delete` unchanged; `query_monitors` rows gain `managedByMonitorId`.

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
  and keep the `get`/`delete` site-scope cases.
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/api && npx vitest run src/services/aiToolsMonitoring.test.ts` → `expected { success: true } to match object { error: 'network_check_authoring_retired' }`.
- [ ] **Step 3: Implement.** At the top of the `manage_monitors` handler:
  ```ts
  // W05e — network checks are authored as monitors of kind `network_check`.
  // The enum keeps 'create'/'update' so an older prompt gets this pointer
  // instead of a schema error.
  if (action === 'create' || action === 'update') {
    return JSON.stringify({
      error: 'network_check_authoring_retired',
      message: 'Network checks are authored as monitor definitions. Call manage_monitor_definitions with kind "network_check"; bind it to a discovered asset with condition.assetId to pin the probe to the asset\'s site and alert on its device.',
      useTool: 'manage_monitor_definitions',
      example: { action: 'create', definition: { kind: 'network_check', name: 'Gateway reachable', severity: 'high', condition: { checkType: 'icmp_ping', target: '10.0.0.1', assetId: '<optional asset uuid>', consecutiveFailures: 2 } } },
    });
  }
  ```
  Delete the create/update branches that follow. Update the tool description to "Get a network check with recent results, or delete an unconverted one. Creating and editing checks moved to manage_monitor_definitions (kind network_check)." and the `monitorType`/`target`/`config` property descriptions to "(retired — use manage_monitor_definitions)". Add `managedByMonitorId` to the `query_monitors` select. In `aiToolsMonitors.ts` extend the `manage_monitor_definitions` description: "…Kind `network_check` compiles to a managed network probe; set `condition.assetId` to bind it to a discovered asset."
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/aiToolsMonitoring src/services/aiToolsMonitors.test.ts src/services/aiAgentSdkTools.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts`
- [ ] **Step 5: Commit.** `git add apps/api/src/services/aiToolsMonitoring.ts apps/api/src/services/aiToolsMonitoring.test.ts apps/api/src/services/aiToolsMonitoring.deviceScope.test.ts apps/api/src/services/aiToolsMonitors.ts && git commit -m "feat(ai): manage_monitors create/update point at manage_monitor_definitions kind network_check"`

---

### Task 12: Docs, release notes, full verification pass (PR3)

**Files:**
- Modify: `apps/docs/src/content/docs/features/network-monitors.mdx` (retitle "Network Checks"; rewrite "In the console" 16-23; replace "Alert Rules on Monitors" 208-289 with "Alerting"; API Reference 375-411 marks the 410s; add "Converting existing checks"; Troubleshooting 463+ "Alert rules not firing" → "The monitor is not firing")
- Modify: `apps/docs/src/content/docs/features/monitors.mdx` (kinds table 12-31 gains `Network check` — and the four other W04 kinds if still missing; "Converting a legacy alert rule" 104-118 gains a "Converting network checks" paragraph; a "Network check fields" table)
- Modify: `docs/release-notes/next-release-draft.md`, `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Write the failing test.** Docs build is the test: `cd apps/docs && pnpm build` must pass after the edits; before editing, run `grep -n "POST /api/v1/monitors/alerts\|Alert Rule Schema" apps/docs/src/content/docs/features/network-monitors.mdx` and expect hits — those sections must be gone afterwards (`grep` returns nothing = green).
- [ ] **Step 2: Run it, expect FAIL.** The grep returns lines 260-289 (the alert-rule API that no longer exists).
- [ ] **Step 3: Implement.** `network-monitors.mdx` content contract (write it in the page's existing voice):
  - Frontmatter `title: Network Checks`, `sidebar.label: Network Checks`, description "Ping, port, HTTP and DNS checks run from your agents; authored as monitors, results on the Network page."
  - **In the console**: "Network checks are authored as monitors of kind **Network check** under **Alerts → Monitors**. The **Network** page (Fleet Management → Network, `/monitoring`; called *Network Monitor* before this release) keeps **Assets**, **SNMP Templates** and **Results**. Results lists every check with its last status and links each to the monitor that owns it; **New check** opens the monitor editor with the kind pre-selected and, from an asset or the network device page, the asset pre-bound."
  - **Fields**: the condition table — check type, target, asset binding (what it does: site-pinned executor, alert device), per-type options (map the four legacy config tables 1:1, noting `expectStatus` is the API field name and is sent to the agent as `expectedStatus`), *Treat degraded as failure*, *Fail when slower than*, poll interval 10 s–24 h, timeout 1–300 s, consecutive failures 1–100.
  - **Alerting**: replace the whole section. One monitor → one alert per organization, raised on the asset's linked device or the most recently seen device in the asset's site/org; severity, cooldown, delivery (Inherit/Channels/Inbox only) and escalation come from the monitor; the alert carries `monitorId` and `kind: network_check` on `alert.triggered` (Alert workflows filter on it). Keep the five-minute cooldown and dedupe paragraphs (now per monitor and device). Note the online-device limitation and the follow-up.
  - **Converting existing checks**: the Results tab banner; what the mapping does (offline / consecutive failures / degraded / response time → the condition; several rules collapse; no rules → info + inbox-only; open legacy alerts are resolved with a note); the row is adopted (history kept); revert from the conversion ledger; unconvertible reasons.
  - **API Reference**: `POST /monitors`, `PATCH /monitors/:id`, `POST /monitors/alerts`, `PATCH|DELETE /monitors/alerts/:id` → **410 Gone** with the `network_check_authoring_retired` body; reads, `/check`, `/test`, `DELETE /monitors/:id` (unconverted only) unchanged; `GET /monitors` gains `managedByMonitorId`, `retiredAt`, `includeRetired`; `DELETE /discovery/assets/:id` → 409 `asset_has_managed_network_checks`; the two conversion endpoints.
  `monitors.mdx`: kinds table row `| Network check | An ICMP, TCP, HTTP or DNS probe run from an agent fails N times in a row (optionally: is degraded or slow) | High | Agent (probe) + server (verdict) |`; a short "Network check" subsection linking to the Network Checks page; the conversion paragraph.
  `docs/release-notes/next-release-draft.md` → under Self-Hosting / Upgrade Notes:
  - "**Network checks are monitors now (W05e).** The *Network Monitor* nav entry is *Network* (Assets · Templates · Results). Existing checks keep polling unchanged; convert them from the Results tab banner (hosted: we run the partner-level *Convert everything*). A converted check keeps its row, history and asset binding; its alert rules are retired and the monitor raises one alert per organization on the asset's device. `POST /monitors`, `PATCH /monitors/:id` and every `/monitors/alerts*` write return **410**; the AI tool `manage_monitors` refuses create/update and points at `manage_monitor_definitions`. Checks with no alert rules convert as *info, inbox only*. Open legacy network alerts are resolved with a conversion note at conversion time. Known limitation: the sweep evaluates online devices only, so a check whose alert device is offline is silent until it is back (follow-up filed)."
  - "**Fix:** a `network_check` monitor's *Expected status code* was never sent to the agent under the name it reads (`expectedStatus`); it is now."
  `CHANGELOG.md` `[Unreleased]` → `### Changed` (Network page, conversion, 410s) and `### Fixed` (expectStatus).
- [ ] **Step 4: Run, expect PASS — the full verification pass.**
  ```bash
  cd apps/docs && pnpm build
  cd ../../packages/shared && npx vitest run src/validators/monitors.test.ts
  cd ../../apps/api && npx tsc --noEmit -p . && npx vitest run \
    src/services/monitors src/services/alertConditions src/jobs/monitorWorker src/routes/monitors src/routes/monitorDefinitions src/routes/discovery \
    src/services/aiToolsMonitoring src/services/aiToolsMonitors.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts \
    src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
  pnpm test-stack up
  cd apps/api && npx vitest run -c vitest.integration.config.ts \
    src/__tests__/integration/networkCheckConversion.integration.test.ts \
    src/__tests__/integration/networkMonitorPartnerRls.integration.test.ts \
    src/__tests__/integration/monitorDefinitionsPartnerRls.integration.test.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts \
    src/__tests__/integration/rls-coverage.integration.test.ts \
    src/__tests__/integration/tenantCascade.integration.test.ts
  pnpm db:check-drift
  pnpm test-stack down
  cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/monitoring src/components/monitors src/components/layout/Sidebar.nav.test.tsx src/components/devices/networkDevice src/lib/__tests__
  git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1   # must sort BEFORE 2026-10-24-110000-…; rename if not
  ```
  Then the manual walk on a `pnpm wt-stack up` stack: seed a legacy check via SQL, open `/monitoring#checks` (lands on Results), banner → convert, the row links to its monitor, the monitor editor shows the asset chip, `POST /monitors` returns 410, the device page's Add check opens the editor bound to the asset.
- [ ] **Step 5: Commit.** `git add apps/docs/src/content/docs/features/network-monitors.mdx apps/docs/src/content/docs/features/monitors.mdx docs/release-notes/next-release-draft.md CHANGELOG.md && git commit -m "docs(monitoring): network checks as monitors — Network page, conversion, retired write endpoints"`

---

## Follow-ups to file at plan approval (not in scope)

1. Sweep evaluates online devices only (`jobs/alertWorker.ts:196-199`): a `network_check` whose alert device is offline is silent. Extend the sweep to evaluate network-check monitors for the alert device regardless of its online state (or evaluate them per org instead of per device).
2. An asset picker inside the monitor editor for `network_check` (today binding comes only from the Network page / device page deep links).
3. `packetSize` and `headers` are API-only condition keys (not editor-authored).
4. `manage_monitors` `delete` for unconverted checks and `DELETE /monitors/:id` could be removed once the ledger shows zero unmanaged rows on EU and US.
