---
tracking_issue: (set by feature-lifecycle after registration)
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05d Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire every legacy alert-authoring path for good: a boot-time system-scope sweep converts (or retires with a reason) whatever W05c left unconverted, the per-policy check interval moves to the `monitors` link, and the policy Alerts / Service & Process tabs, `/alerts/rules`, the legacy write routers, the second evaluation sweep, the transitional delivery override and the one-shot migrate script are deleted — with a startup count check that is loud, never silent, when something is still unretired.

**Architecture:** The sweep is TypeScript, not SQL — W05c1's converter creates monitor definitions, compiles them, moves open alerts and runs an equivalence check over devices, none of which SQL can express — so it mirrors the built-in-monitors backfill (`apps/api/src/index.ts:1855-1871`): detached after `serve()`, one `runOutsideDbContext + withSystemDbAccessContext` transaction per partner, outcome recorded on `partners.settings`, opt-out by env var. The migration file does only the SQL-expressible half: re-keying `config_policy_monitoring_settings` from each policy's `monitoring` link to its `monitors` link (creating that link when absent) and reporting unretired counts. The startup count check is chained *after* the sweep in the same detached promise, so the first boot after upgrade cannot fire it spuriously; it logs at error level, reports to Sentry and feeds the pending endpoint the banner already reads. Retired `alert_rule`/`monitoring` feature-link rows stay in the database (the Postgres enum keeps the values); the API filters `RETIRED_CONFIG_FEATURE_TYPES` out of every listing and resolver so no reader ever sees a feature type outside `CONFIG_FEATURE_TYPES`.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16, zod (`packages/shared`), Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`), React + react-i18next (8 locales), Astro (web pages + Starlight docs), Sentry (`services/sentry.ts`).

**Spec:** docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md (§Removed screens and routes — rows marked W05d; §Data model "Monitors" last bullet and "Config feature types (W05d)"; §Delivery resolution "Transitional (W05b → W05d)"; §Conversion "Other writers" rows marked W05d and "Who runs it" self-hosted bullet; §Evaluation W05d bullet; §AI / MCP tools rows marked W05d; §Docs and release notes; §Waves W05d row)

## Ordering assumptions (read first)

- **W05a, W05b, W05c1 and W05c2 have shipped in a prior release.** W05d must not ship in the same release as W05c: the hosted "Convert everything" pass and the self-hosted banner need one full release cycle before anything is deleted (spec §Waves: "W05d depends on W05c having shipped in a prior release"). Both W05d PRs ship in the *same* release, PR2 after PR1 is merged.
- **W05c1 names come from its plan** (`2026-09-19-alerting-consolidation-w05c1-conversion-api.md`, File Structure rows 73-82): the module is `apps/api/src/services/monitors/conversion/{types,prerequisites,mapping,loadSources,equivalence,convert,index}.ts`; `convert.ts` owns `previewPolicyConversion`, `convertPolicy`, `convertPartnerLegacy`, `revertConversion`, `retireSource`, `countPendingConversions`; `loadSources.ts` loads a policy's unretired sources (its `case 'monitoring'` at plan line ~1507 is the watch lookup Task 4 widens); `index.ts` re-exports the surface; the routes live under `/monitor-definitions/conversion/*` in `routes/monitorDefinitions.ts`, declared before `/:id`, with `GET …/conversion/pending?orgId → { data: { policies, rows } }`. The retirement columns come from `2026-10-23-120000-legacy-source-retirement-columns.sql`. **Before Task 4:** `ls apps/api/src/services/monitors/conversion/ && grep -n "export async function convertPartnerLegacy\|export async function retireSource\|conversion/pending" apps/api/src/services/monitors/conversion/convert.ts apps/api/src/routes/monitorDefinitions.ts` — if a shipped name differs, follow the shipped code and keep this plan's names for the W05d-only pieces (`runLegacyAlertingRetirement`, `checkLegacyAlertingRetired`, the `retireUnconvertible` option, the `sweep`/`unconvertible` fields on the pending response).
- **W05c2 names come from its plan** (`2026-09-19-alerting-consolidation-w05c2-conversion-web-and-tools.md`): the banner is `apps/web/src/components/monitoring/conversion/ConversionPendingBanner.tsx`, every conversion path is centralised in `components/monitoring/conversion/conversionApi.ts` (`conversionPaths.pending(orgId)`), and W05c2 Task 3 put the *Check interval* field on the Monitors tab (test id `monitors-tab-check-interval`) writing through `useFeatureLink.save(…, { featureType: 'monitoring', … })` — spec §Data model: keyed by the `monitoring` link **until W05d**. Task 2 repoints that write at the `monitors` link and rewrites W05c2's three test cases for it. W05a already deleted the `hub.*` keys in `monitoring.json` and the `pages/monitoring/*.astro` redirect stubs, and `AlertRuleEditPage`/`AlertRuleEditor`; `apps/web/src/components/alerts/AlertRuleForm.tsx` (+ `AlertRuleForm.retiredCondition.test.tsx`, `index.ts` export) survives W05a with no page importing it and goes in Task 11.
- **Sweep = TypeScript after `serve()`, migration = SQL before it.** `initializeDatabaseForStartup({ autoMigrateEnabled })` (`apps/api/src/index.ts:1679-1682`) runs every migration before the listener; `ensureBuiltInMonitorsForAllPartners()` (`index.ts:1855-1871`, body at `services/monitors/builtInMonitors.ts:226-264`) is the precedent for per-partner work that must not delay `/health`. The W05d sweep is wired exactly the same way, immediately after it. Between `serve()` and the sweep finishing, unconverted inline rules do not fire — that window is the reason the release notes (Task 13) tell self-hosters to run *Convert everything* on the W05c release first.
- **The startup check counts two tables, not one.** The spec names `config_policy_alert_rules WHERE retired_at IS NULL`; after Task 3 the agent config builder no longer delivers `config_policy_monitoring_watches` either, so an unretired watch is exactly as silent as an unretired rule. Both counts must be zero.
- **Equivalence refusals in the sweep become `unconvertible:equivalence_delta`.** The per-policy panel refuses a conversion whose before/after device sets differ and waits for a human (spec §Equivalence check). The sweep has no human, and after Task 8 the legacy evaluator is gone, so an unretired-but-unconverted row would be *silently* dead. The sweep therefore retires such rows with that reason so they are listed in the banner (spec §Conversion "Who runs it": "Nothing stops firing without being listed"). This is the conservative reading; the alternative — convert anyway and list the delta — changes what fires for some device, which the spec forbids. Flagged as an open question in the report.
- **Open alerts of a retired-unconvertible source stay open for a human.** `checkAutoResolveFromConfigPolicy` (`services/alertService.ts:1386`, called from `jobs/alertWorker.ts:324`) is part of the legacy path and is deleted in Task 8; converted sources already had their non-terminal alerts moved to the compiled rule by W05c1 (spec §Open alerts), so only unconvertible sources are affected. Release notes say so.
- **Code facts the spec/brief did not list, all verified and all in scope here:** `evaluateDeviceAlertsFromPolicy` has a *second* caller, `jobs/offlineDetector.ts:505` (`triggerConfigPolicyOfflineAlerts`, lines 476-520); the acknowledge-cooldown branch is duplicated in `routes/mobile.ts:1252-1256` and `services/alertService.ts:746-756` (`resolveAlert`); `getApplicableRulesFromPolicy` is also read by `services/offlineAlertEffects.ts:49` (the #6342 fix adds monitor resolution "alongside" it — the legacy half goes here); `PARTNER_LINKABLE_FEATURE_TYPES` (`services/configurationPolicy.ts:2654`) and `validateFeaturePolicyExists` (`:2804`, `:2826`, `:2890`) still name `alert_rule`/`monitoring`; the shared `addFeatureLinkSchema` hand-lists every feature type (`packages/shared/src/validators/index.ts:568`) instead of deriving from `CONFIG_FEATURE_TYPES`, as does the AI tool's JSON schema (`services/aiToolsConfigPolicy.ts:908-916`); `manage_alert_rules` `create_rule`/`update_rule`/`delete_rule` are *already* refused (`services/aiToolsFleet.ts:2579-2583`) but every pointer says `manage_policy_feature_link` + `alert_rule`; `routes/agents/helpers.partnerWidePolicies.test.ts` pins the `monitoring`-link query sequence that Task 3 changes.
- **Retired feature-link rows are kept, and filtered.** Deleting `config_policy_feature_links` rows of type `alert_rule`/`monitoring` would cascade-delete `config_policy_alert_rules` (FK `ON DELETE CASCADE`, `db/schema/configurationPolicies.ts:190`) and strand `alerts.config_policy_id` history, which spec C4 forbids. So the rows stay; `listFeatureLinks` and `resolveEffectiveConfigWithExecutor` exclude `RETIRED_CONFIG_FEATURE_TYPES` (Task 6), and the web never receives them.
- **Two PRs, in order:** PR1 = Tasks 1–5 (migration + re-key + agent builder + sweep + boot check + pending endpoint/banner). PR2 = Tasks 6–13 (constants + parity, service-branch deletions, evaluator deletion, transitional delivery removal, 410 routers, web deletions, AI tools + migrate script, docs + release notes). Task 14 is the verification pass run at the end of each PR. PR2 branches from `main` after PR1 merges — a PR based on a sibling branch runs no CI (CLAUDE.md, tenancy section).

## Global Constraints

- **Migration filename `2026-10-24-100000-legacy-alerting-retirement-sweep.sql`** (assigned by the common brief). Before pushing: `git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1` must sort **before** it (newest at planning time: `2026-10-21-100200-billing-profiles-permissions.sql`; W05b/W05c1 claim `2026-10-21-*`, W05e claims `2026-10-22-110000-*`). Rename with a later `HHMMSS` if anything newer landed. Never name it for today's real date — shipped names run weeks ahead of the calendar and a today-named file would replay before the W05c1 columns it depends on.
- The migration is idempotent (`NOT EXISTS` guards on every insert/update), has **no inner `BEGIN`/`COMMIT`**, starts with `SELECT set_config('breeze.scope', 'system', true);` because it contains DML (`migrationRlsScope.test.ts` — never join its frozen baseline), and every `INSERT`/`UPDATE`/`DELETE` reports its row count with `GET DIAGNOSTICS … RAISE WARNING`. The detection `SELECT`s that report unretired counts run *after* the elevation for the same reason (a `'none'`-scope read sees zero rows through `FORCE ROW LEVEL SECURITY`).
- **No new tables, no new columns, no RLS change.** `config_policy_monitoring_settings` keeps its shape; only `feature_link_id` values move. No `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `CORE_DEVICE_*` or `DUAL_AXIS_TENANT_TABLES` change. `partners.settings` (jsonb) gains a `legacyAlertingRetirement` key — `partners` carries no `org_id`, so no export-policy entry.
- **Partner-axis writes:** the sweep writes `partners.settings` and, through the converter, `monitor_definitions` rows with `partner_id`. If `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` or `site-ceiling-write-coverage.test.ts` flags `services/monitors/conversion/retirementSweep.ts`, add the allowlist entry with the reason *"boot-time system sweep; per-partner `runOutsideDbContext + withSystemDbAccessContext`, no caller"* — the same reason `builtInMonitors.ts` carries.
- **The agent wire shape is frozen.** `monitoring_settings` on the wire stays exactly `{ check_interval_seconds: int, watches: MonitoringWatchConfig[] }` (`routes/agents/helpers.ts:2019-2036`; Go `agent/internal/monitoring/types.go`). Task 3 changes only where the values come from. `auto_restart` semantics are unchanged.
- Deleted code is deleted, not commented out or feature-flagged. Every deleted export gets its tests deleted or rewritten in the same task; `pnpm --filter @breeze/api exec tsc --noEmit` is the sweep for missed importers.
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); catch pattern per CLAUDE.md. Tab state is hash-based (`useHashTab`); the legacy hashes are rewritten with `history.replaceState`, never with a query param.
- Every new i18n key needs **real translations in all 8 locales** (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`); the coverage test fails on a missing or English-echoed key. Removed components take their key blocks out of all 8 files.
- Every task: **red test first**, then `pnpm --filter @breeze/api exec tsc --noEmit` (and `pnpm --filter @breeze/web exec tsc --noEmit` for web tasks), then the task's targeted tests, then commit. Use `cd apps/api && npx vitest run <path>`; never `pnpm --filter … test -- --run <path>`; never a trailing-slash path filter.
- `pnpm test` does **not** run the integration suites. Tasks 1, 3, 4 and 14 need `pnpm test-stack up` (private pg+redis for this worktree) and `pnpm test-stack down` afterwards — nothing reaps it for you.
- Do not commit from a subagent; the orchestrator commits. Each task's Step 5 gives the commit message.

## File Structure (what changes where)

| File | Change |
|---|---|
| `apps/api/migrations/2026-10-24-100000-legacy-alerting-retirement-sweep.sql` | **Create (PR1).** Re-key `config_policy_monitoring_settings` to the `monitors` link; mirror `checkIntervalSeconds` into the link's `inline_settings`; report unretired counts. |
| `apps/api/src/__tests__/integration/legacyAlertingRetirementMigration.integration.test.ts` | **Create (PR1).** Replays the migration against fixture policies; re-key, link creation, idempotency. |
| `packages/shared/src/validators/monitors.ts` | Modify (PR1, lines 295-297): `monitorsInlineSettingsSchema` gains `checkIntervalSeconds` (10–3600, default 60). (PR2, Task 6: nothing further here.) |
| `packages/shared/src/validators/monitors.test.ts` | Modify (PR1). |
| `apps/api/src/services/configurationPolicy.ts` | Modify (PR1): `case 'monitors'` in `decomposeInlineSettings` (line 1117) upserts the settings row; `assembleInlineSettings` (line 1498) reads it back. Modify (PR2): delete `alert_rule`/`monitoring` arms at 756-790, 907-935, 1165-1167, 1171-1173, 1198-1199, 1219-1233, 1271-1291, 1430-1465; `PARTNER_LINKABLE_FEATURE_TYPES` (2654); `validateFeaturePolicyExists` (2804, 2826, 2890); `listFeatureLinks` (1901) and `resolveEffectiveConfigWithExecutor` (2308) exclude retired types. |
| `apps/api/src/services/configurationPolicy.test.ts` (+ siblings that cover decompose/assemble) | Modify (PR1, PR2). |
| `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` | Modify (PR1): *Check interval* writes `checkIntervalSeconds` into the `monitors` link's inline settings, not the `monitoring` link. |
| `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx` | Modify (PR1). |
| `apps/api/src/routes/agents/helpers.ts` | Modify (PR1, lines 2163-2243 and 2243-2370): `resolvePolicyMonitoringSettings` joins `featureType = 'monitors'`, returns only `check_interval_seconds`; watches come from monitors only; `unionMonitoringWatches` deleted. |
| `apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts`, `helpers.partnerWidePolicies.test.ts`, `heartbeat.test.ts` | Modify (PR1): query sequence and fixtures move to the `monitors` link. |
| `apps/api/src/__tests__/integration/monitorWatchDelivery.integration.test.ts`, `agentPolicyResolversPartnerWide.integration.test.ts` | Modify (PR1): check interval fixtures on the `monitors` link. |
| `apps/api/src/services/monitors/conversion/convert.ts`, `types.ts`, `loadSources.ts` (W05c1) | Modify (PR1): `convertPartnerLegacy` gains `opts?: { retireUnconvertible?: boolean }` and returns `retired: RetiredSource[]`; the watch loader accepts settings rows under either link type. |
| `apps/api/src/services/monitors/conversion/retirementSweep.ts` | **Create (PR1).** `runLegacyAlertingRetirement()`, `sweepPartnerLegacyAlerting(partnerId)`, `checkLegacyAlertingRetired()`, `LegacyAlertingUnretiredError`, marker read/write. |
| `apps/api/src/services/monitors/conversion/retirementSweep.test.ts` | **Create (PR1).** |
| `apps/api/src/__tests__/integration/legacyAlertingRetirementSweep.integration.test.ts` | **Create (PR1).** Real-Postgres proof: convertible row converted, unconvertible row retired with reason, marker written, count check zero/non-zero. |
| `apps/api/src/index.ts` | Modify (PR1, after line 1871): detached `runLegacyAlertingRetirement()` chain. |
| `apps/api/src/routes/monitorDefinitions.ts` (W05c1 conversion routes) | Modify (PR1): `GET /conversion/pending` response gains `unconvertible` and `sweep`. |
| `apps/api/src/routes/monitorDefinitions.conversion.pending.test.ts` | **Create (PR1).** |
| `apps/web/src/components/monitoring/conversion/ConversionPendingBanner.tsx` (W05c2 name may differ) | Modify (PR1): post-sweep "could not be converted — review" list with per-viewer dismiss. |
| `apps/web/src/components/monitoring/conversion/ConversionPendingBanner.test.tsx` | Modify (PR1). |
| `apps/web/src/locales/*/monitoring.json` | Modify (PR1): `conversion.retirement.*` keys. |
| `packages/shared/src/constants/configFeatureTypes.ts` | Modify (PR2, lines 22-30): remove `alert_rule`, `monitoring`; add `RETIRED_CONFIG_FEATURE_TYPES`, `RetiredConfigFeatureType`, `isRetiredConfigFeatureType`. |
| `packages/shared/src/constants/index.ts` | Modify (PR2): export the new names. |
| `packages/shared/src/validators/index.ts` | Modify (PR2, line 568): `addFeatureLinkSchema.featureType = z.enum(CONFIG_FEATURE_TYPES)`. |
| `apps/api/src/services/configFeatureTypes.ts` | Modify (PR2): re-export the retired list. |
| `apps/api/src/services/policyBaselineDefaults.ts` | Modify (PR2, lines 62-81): drop the two `NOT_ENFORCED` entries. |
| `apps/api/src/services/policyBaselineDefaults.test.ts` | Modify (PR2, lines 87-91): parity = `CONFIG_FEATURE_TYPES ∪ RETIRED_CONFIG_FEATURE_TYPES` vs DB enum, disjoint. |
| `apps/api/src/routes/configurationPolicies/resolution.test.ts` | Modify (PR2, lines 13, 16): fixture list. |
| `apps/api/src/routes/configurationPolicies/featureLinks.ts` | Modify (PR2, lines 273-300, 517-535): delete the `alert_rule`/`monitoring` validation branches; refuse retired types with a pointer. |
| `apps/api/src/routes/configurationPolicies/featureLinks.test.ts` (+ `*.alertRule*.test.ts` siblings) | Modify/delete (PR2). |
| `apps/api/src/routes/configurationPolicies/alertRuleTest.ts` (+ `alertRuleTest.test.ts`, `schemas.ts` `testConfigPolicyAlertRuleSchema`) | **Delete (PR2).** Mount at `routes/configurationPolicies/index.ts:5,19` removed. |
| `apps/api/src/services/featureConfigResolver.ts` | Modify (PR2, lines 257-441): delete `GoverningAlertRulePolicy`, `resolveGoverningAlertRulePolicyForDevice`, `resolveAlertRulesForDevice`. |
| `apps/api/src/services/alertService.ts` | Modify (PR2): delete `ConfigPolicyAlertRule`, `getApplicableRulesFromPolicy` (1196-1230), `evaluateDeviceAlertsFromPolicy` (1239-1372), `checkAutoResolveFromConfigPolicy` (1386-~1480), the `resolveAlert` cooldown branch (746-756); imports at 21, 27, 28. |
| `apps/api/src/services/alertService.test.ts` (+ `alertService.autoResolveOutcome.test.ts`, `alertService.resolveCas.test.ts`) | Modify (PR2). |
| `apps/api/src/services/alertCooldown.ts` | Modify (PR2, lines 294-360): delete `isConfigPolicyRuleCooling`, `markConfigPolicyRuleCooldown`, `buildConfigPolicyCooldownKey`; keep the `:cpar:` filter at line 478. |
| `apps/api/src/jobs/alertWorker.ts` | Modify (PR2, lines 13-18, 254-275, 300-330): single sweep, single auto-resolve. |
| `apps/api/src/jobs/alertWorker.test.ts`, `alertQueue.test.ts` | Modify (PR2). |
| `apps/api/src/jobs/offlineDetector.ts` | Modify (PR2, lines 16, 476-520, 522-545): delete `triggerConfigPolicyOfflineAlerts`; `triggerOfflineAlerts` runs the legacy standalone path only (monitors are #6342's `offlineAlertEffects`). |
| `apps/api/src/jobs/offlineDetector_configPolicy.test.ts` | **Delete (PR2).** `offlineDetector.dbcontext.test.ts`, `offlineDetector_reeval.test.ts`: modify. |
| `apps/api/src/services/offlineAlertEffects.ts` | Modify (PR2, lines 5, 49-50, 63-70): drop the `getApplicableRulesFromPolicy` branch and the `policy: true` plan shape. |
| `apps/api/src/routes/alerts/alerts.ts`, `apps/api/src/routes/mobile.ts` | Modify (PR2, `alerts.ts:22,1082-1088`; `mobile.ts:23,1252-1256`): delete the `configPolicyId` cooldown branch. |
| `apps/api/src/routes/alerts/alerts.test.ts`, `alerts.resolveCas.test.ts`, `routes/mobile.resolveCas.test.ts`, `routes/mobile.ackCas.test.ts` | Modify (PR2). |
| `apps/api/src/services/delivery/resolveDelivery.ts` (W05b) | Modify (PR2): delete the `legacy_override` step and the `legacyOverride` input; `DeliverySource` drops `'legacy_override'`. |
| `apps/api/src/services/delivery/resolveDelivery.test.ts`, `services/notificationDispatcher.ts` (call sites) | Modify (PR2). |
| `apps/api/src/routes/alerts/rules.ts` | Modify (PR2, lines 272-806, 808-~900): `POST /rules`, `PUT /rules/:id`, `DELETE /rules/:id`, `POST /rules/:id/test` → 410. |
| `apps/api/src/routes/alertTemplates/templates.ts` | Modify (PR2, lines 215-320, 353-431, 433-486): `POST /templates`, `PATCH /templates/:id`, `DELETE /templates/:id` → 410. |
| `apps/api/src/routes/alertTemplates/rules.ts` | Modify (PR2, lines 128-227, 261-360, 362-417, 419-491): `POST /rules`, `PATCH /rules/:id`, `DELETE /rules/:id`, `POST /rules/:id/toggle` → 410. |
| `apps/api/src/routes/legacyAlertingGone.ts` | **Create (PR2).** Shared 410 body + handler. |
| `apps/api/src/routes/alerts/rules.managedByMonitor.test.ts`, `rules.authz.test.ts`, `rules.testVerdict.test.ts`, `alertTemplates/templates.managedByMonitor.test.ts`, `templates.guard.test.ts`, `templates.authz.test.ts`, `rules.managedByMonitor.test.ts`, `rules.authz.test.ts` | Modify (PR2): write cases assert 410; read cases unchanged. |
| `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx`, `AlertRuleTab.test.tsx`, `AlertRuleTab.testVerdict.test.tsx`, `AlertRuleTestModal.tsx`, `MonitoringTab.tsx`, `MonitoringTab.test.tsx` | **Delete (PR2).** |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` | Modify (PR2, lines 61, 65): drop the two `FEATURE_META` rows. |
| `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` | Modify (PR2, lines 112, 123, 136-170, 432, 442): icons, `LEGACY_TAB_ALIASES`, hash rewrite, render cases. |
| `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx` | Modify (PR2): hash alias cases. |
| `apps/web/src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts` | Modify (PR2): retired types have no `FEATURE_META` row and no tab. |
| `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx` | Modify (PR2, lines 120, 127): drop the two rows. |
| `apps/web/src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts` | Modify (PR2): retired types excluded. |
| `apps/web/src/components/monitoring/LegacyRulesPage.tsx`, `LegacyRulesPage.test.tsx` | **Delete (PR2).** |
| `apps/web/src/pages/alerts/rules/index.astro`, `new.astro`, `[id].astro` | Modify (PR2): `Astro.redirect('/alerts/monitors', 301)`. |
| `apps/web/src/components/alerts/AlertsTabStrip.tsx`, `AlertsTabStrip.test.tsx` | Modify (PR2, lines 10, 46; test line 33-36): Rules tab removed. |
| `apps/web/src/locales/*/policies.json`, `pages.json`, `alerts.json`, `monitoring.json` | Modify (PR2): remove `longTail.…alertRuleTab`/`monitoringTab` blocks (en: 201-266, 799-837), `titles.alertsRules` (line 32), `alertsTabStrip.tabs.rules` (en 622), `hub.tabs.legacyRules` (en 16) — all 8 locales. |
| `apps/api/src/services/aiToolsConfigPolicy.ts` | Modify (PR2, lines 101-108, 876-916, 1000-1014): retired-type refusal, `VALIDATED_INLINE_SETTINGS`, description, JSON-schema enum from `CONFIG_FEATURE_TYPES`. |
| `apps/api/src/services/aiToolsFleet.ts` | Modify (PR2, lines 2450-2520, 2579-2583, 3170-3215): `list_templates` removed, `list_rules` managed-only, pointers → `manage_monitor_definitions`; `manage_service_monitors` `list` legacy query removed if W05c2 left it. |
| `apps/api/src/services/aiToolSchemasFleet.ts`, `aiAgentSdkTools.ts`, `aiGuardrails.ts`, `aiAgentSystemPrompt.ts`, `mcpGuidance.ts` | Modify (PR2, `aiToolSchemasFleet.ts:165`; `aiAgentSdkTools.ts:1999-2014`; `aiGuardrails.ts:1006`; `aiAgentSystemPrompt.ts:70,74,88`; `mcpGuidance.ts:101`). |
| `apps/api/src/services/aiAgentSdkTools.mcpCoverage.test.ts`, `aiToolsConfigPolicy.test.ts`, `aiToolsFleet.test.ts` | Modify (PR2). |
| `apps/api/src/scripts/migrateToConfigPolicies.ts` | **Delete (PR2).** Allowlist entry `services/featureLinkReaders.contract.test.ts:83` removed. |
| `apps/docs/src/content/docs/features/service-monitoring.mdx` | **Delete (PR2).** Redirect → `/features/monitors/`. |
| `apps/docs/astro.config.mjs` | Modify (PR2, line 126; `redirects`): sidebar entry removed, redirect added. |
| `apps/docs/src/content/docs/features/alerts.mdx`, `configuration-policies.mdx` (lines 107, 375), `monitors.mdx` | Modify (PR2). |
| `docs/release-notes/next-release-draft.md`, `CHANGELOG.md` | Modify (PR2). |

---

### Task 1: Migration — re-key `config_policy_monitoring_settings` to the `monitors` link and report leftovers (PR1)

**Files:**
- Create: `apps/api/migrations/2026-10-24-100000-legacy-alerting-retirement-sweep.sql`
- Create: `apps/api/src/__tests__/integration/legacyAlertingRetirementMigration.integration.test.ts`
- Test (existing, auto-discover): `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`

**Interfaces:**
- Consumes: `config_policy_feature_links(config_policy_id, feature_type, feature_policy_id, inline_settings)` with `config_feature_links_unique (config_policy_id, feature_type)` (`db/schema/configurationPolicies.ts:118-133`); `config_policy_monitoring_settings(feature_link_id UNIQUE, check_interval_seconds)` (`:384-390`); W05c1 columns `retired_at` on `config_policy_alert_rules`, `config_policy_monitoring_watches`, `alert_rules`, `alert_templates`; `managed_by_monitor_id` on `alert_rules`/`alert_templates` (`db/schema/alerts.ts:66,95`).
- Produces: every settings row keyed on a `monitors` link; a `monitors` link (`inline_settings = {items:[], inheritance:'cumulative', checkIntervalSeconds:<n>}`) for each policy that had only a `monitoring` link; `inline_settings->>'checkIntervalSeconds'` mirrored on every `monitors` link that owns a settings row; `RAISE WARNING` counts for everything still unretired.

- [ ] **Step 1: Write the failing test.** Create `apps/api/src/__tests__/integration/legacyAlertingRetirementMigration.integration.test.ts`:

```ts
/**
 * W05d Task 1 — the re-key migration moves each policy's monitoring settings
 * row from its `monitoring` link to its `monitors` link (creating the link),
 * mirrors checkIntervalSeconds onto the link, and is a no-op on replay.
 * Real Postgres: the migration is SQL and the unique index on
 * feature_link_id is what makes the duplicate case interesting.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyFeatureLinks,
  configPolicyMonitoringSettings,
  configurationPolicies,
} from '../../db/schema';
import { replayMigration } from './replayMigration';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2026-10-24-100000-legacy-alerting-retirement-sweep.sql';
const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, partnerId: null, userId: null, roleId: null, isPlatformAdmin: false };

const created: string[] = [];
afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of created.splice(0)) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
});

async function policyWithMonitoringLink(orgId: string, checkIntervalSeconds: number, alsoMonitorsLink: boolean) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db.insert(configurationPolicies).values({ orgId, name: `W05d ${Math.random()}`, status: 'active' }).returning();
    created.push(policy!.id);
    const [monitoringLink] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'monitoring', inlineSettings: { checkIntervalSeconds, watches: [] },
    }).returning();
    await db.insert(configPolicyMonitoringSettings).values({ featureLinkId: monitoringLink!.id, checkIntervalSeconds });
    let monitorsLinkId: string | null = null;
    if (alsoMonitorsLink) {
      const [m] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: 'monitors', inlineSettings: { items: [] },
      }).returning();
      monitorsLinkId = m!.id;
    }
    return { policyId: policy!.id, monitoringLinkId: monitoringLink!.id, monitorsLinkId };
  });
}

async function settingsLinkFor(policyId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ featureType: configPolicyFeatureLinks.featureType, linkId: configPolicyFeatureLinks.id, inline: configPolicyFeatureLinks.inlineSettings, interval: configPolicyMonitoringSettings.checkIntervalSeconds })
      .from(configPolicyMonitoringSettings)
      .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.id, configPolicyMonitoringSettings.featureLinkId))
      .where(eq(configPolicyFeatureLinks.configPolicyId, policyId)),
  );
}

describe('2026-10-24-100000-legacy-alerting-retirement-sweep.sql', () => {
  it('re-keys a monitoring-only policy onto a freshly created monitors link and mirrors the interval', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId } = await policyWithMonitoringLink(org.id, 90, false);

    await replayMigration(MIGRATION);

    const rows = await settingsLinkFor(policyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.featureType).toBe('monitors');
    expect(rows[0]!.interval).toBe(90);
    expect((rows[0]!.inline as Record<string, unknown>).checkIntervalSeconds).toBe(90);
    expect((rows[0]!.inline as Record<string, unknown>).inheritance).toBe('cumulative');
  });

  it('re-keys onto the existing monitors link when the policy has both', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId, monitorsLinkId } = await policyWithMonitoringLink(org.id, 120, true);

    await replayMigration(MIGRATION);

    const rows = await settingsLinkFor(policyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.linkId).toBe(monitorsLinkId);
    expect((rows[0]!.inline as Record<string, unknown>).checkIntervalSeconds).toBe(120);
  });

  it('is a no-op on replay', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId } = await policyWithMonitoringLink(org.id, 45, false);
    await replayMigration(MIGRATION);
    const before = await settingsLinkFor(policyId);
    await replayMigration(MIGRATION);
    const after = await settingsLinkFor(policyId);
    expect(after).toEqual(before);
    const links = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ n: sql<number>`count(*)::int` }).from(configPolicyFeatureLinks)
        .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'monitors'))),
    );
    expect(links[0]!.n).toBe(1);
  });
});
```

(`DbAccessContext` field list: copy the `SYSTEM_CTX` literal from `monitorWatchDelivery.integration.test.ts:38-45` if the type has gained fields.)

- [ ] **Step 2: Run it, expect FAIL.**
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/legacyAlertingRetirementMigration.integration.test.ts
```
Expected: `ENOENT: no such file or directory … 2026-10-24-100000-legacy-alerting-retirement-sweep.sql` from `replayMigration`.

- [ ] **Step 3: Implement.** Create `apps/api/migrations/2026-10-24-100000-legacy-alerting-retirement-sweep.sql`:

```sql
-- Alerting consolidation W05d — legacy alerting retirement, the SQL half.
-- Spec: docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md
--       (§Data model "Monitors" last bullet; §Conversion "Who runs it").
--
-- 1. Re-key config_policy_monitoring_settings from each policy's `monitoring`
--    link to its `monitors` link, creating the `monitors` link when absent.
--    Retired watches stay attached to the settings row (alert history); the
--    `monitors` assemble path never reads them.
-- 2. Mirror check_interval_seconds into the monitors link's inline_settings so
--    the JSONB mirror and the normalized row agree.
-- 3. Report what is still unretired. The boot-time TypeScript sweep
--    (services/monitors/conversion/retirementSweep.ts) converts or retires it;
--    SQL cannot — conversion compiles monitors and moves open alerts.
--
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps the file). DML below,
-- so elect system scope first: FORCE ROW LEVEL SECURITY binds the owner role
-- and a 'none'-scope UPDATE matches zero rows silently.
SELECT set_config('breeze.scope', 'system', true);

-- 1a. A `monitors` link for every policy that owns a settings row through a
--     `monitoring` link and has no `monitors` link. `items: []` is the W02
--     empty attachment set; `inheritance: 'cumulative'` is W05c1's default.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO config_policy_feature_links (config_policy_id, feature_type, feature_policy_id, inline_settings)
  SELECT l.config_policy_id,
         'monitors'::config_feature_type,
         NULL,
         jsonb_build_object(
           'items', '[]'::jsonb,
           'inheritance', 'cumulative',
           'checkIntervalSeconds', s.check_interval_seconds
         )
  FROM config_policy_feature_links l
  JOIN config_policy_monitoring_settings s ON s.feature_link_id = l.id
  WHERE l.feature_type = 'monitoring'
    AND NOT EXISTS (
      SELECT 1 FROM config_policy_feature_links m
      WHERE m.config_policy_id = l.config_policy_id AND m.feature_type = 'monitors'
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: created % monitors link(s) for policies that only had a monitoring link', n;
  END IF;
END $$;

-- 1b. Re-key. feature_link_id is UNIQUE, so a monitors link that already owns
--     a row keeps it and the monitoring-keyed row is left where it is (1c
--     reports it; nothing is deleted — its watches may be unconverted).
DO $$
DECLARE n integer;
BEGIN
  UPDATE config_policy_monitoring_settings s
  SET feature_link_id = m.id,
      updated_at = now()
  FROM config_policy_feature_links l
  JOIN config_policy_feature_links m
    ON m.config_policy_id = l.config_policy_id AND m.feature_type = 'monitors'
  WHERE s.feature_link_id = l.id
    AND l.feature_type = 'monitoring'
    AND NOT EXISTS (
      SELECT 1 FROM config_policy_monitoring_settings s2 WHERE s2.feature_link_id = m.id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: re-keyed % monitoring settings row(s) onto the monitors link', n;
  END IF;
END $$;

-- 1c. Report (never delete) settings rows still keyed on a monitoring link.
--     Only reachable when a policy had a settings row under BOTH links.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM config_policy_monitoring_settings s
  JOIN config_policy_feature_links l ON l.id = s.feature_link_id
  WHERE l.feature_type = 'monitoring';
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: % settings row(s) still keyed on a monitoring link because the monitors link already owned one — the sweep converts their watches; the row itself is inert', n;
  END IF;
END $$;

-- 2. Mirror the normalized interval onto the monitors link's JSONB.
DO $$
DECLARE n integer;
BEGIN
  UPDATE config_policy_feature_links m
  SET inline_settings = COALESCE(m.inline_settings, '{}'::jsonb)
                        || jsonb_build_object('checkIntervalSeconds', s.check_interval_seconds),
      updated_at = now()
  FROM config_policy_monitoring_settings s
  WHERE s.feature_link_id = m.id
    AND m.feature_type = 'monitors'
    AND (m.inline_settings ->> 'checkIntervalSeconds') IS DISTINCT FROM s.check_interval_seconds::text;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W05d retirement: mirrored checkIntervalSeconds onto % monitors link(s)', n;
  END IF;
END $$;

-- 3. What the W05c release left unconverted. Counts only; the boot sweep acts.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT 'config_policy_alert_rules' AS t, count(*) AS n
      FROM config_policy_alert_rules WHERE retired_at IS NULL
    UNION ALL
    SELECT 'config_policy_monitoring_watches', count(*)
      FROM config_policy_monitoring_watches WHERE retired_at IS NULL
    UNION ALL
    SELECT 'alert_rules (unmanaged)', count(*)
      FROM alert_rules WHERE retired_at IS NULL AND managed_by_monitor_id IS NULL
    UNION ALL
    SELECT 'alert_templates (unmanaged, custom)', count(*)
      FROM alert_templates WHERE retired_at IS NULL AND managed_by_monitor_id IS NULL AND is_built_in = false
  LOOP
    IF r.n > 0 THEN
      RAISE WARNING 'W05d retirement: % unretired row(s) in % — the boot-time sweep converts or retires them; the startup check reports whatever remains', r.n, r.t;
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 4: Run, expect PASS.**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/legacyAlertingRetirementMigration.integration.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
bash scripts/check-migration-naming.sh --against-ref origin/main
```
All three green; the naming guard prints nothing.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/migrations/2026-10-24-100000-legacy-alerting-retirement-sweep.sql apps/api/src/__tests__/integration/legacyAlertingRetirementMigration.integration.test.ts
git commit -m "feat(api): W05d migration re-keys monitoring settings to the monitors link and reports unretired legacy alerting"
```

---

### Task 2: `monitors` inline settings carry `checkIntervalSeconds`; decompose/assemble own the settings row; Monitors tab writes it there (PR1)

**Files:**
- Modify: `packages/shared/src/validators/monitors.ts` (lines 295-297)
- Modify: `packages/shared/src/validators/monitors.test.ts` (append after line 130)
- Modify: `apps/api/src/services/configurationPolicy.ts` (`decomposeInlineSettings` `case 'monitors'` line 1117-1130; `deleteNormalizedRows` `case 'monitors'` line 1245; `assembleInlineSettings` `case 'monitors'` line 1498-1512)
- Modify: `apps/api/src/services/configurationPolicy.monitors.test.ts`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (`handleSave` line 168-183, `handleOverride` line 197-204; the W05c2 *Check interval* field)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx`

**Interfaces:**
- Consumes: `monitorsInlineSettingsSchema` (`{ items, inheritance }` after W05c1), `configPolicyMonitoringSettings`, `useFeatureLink(policyId).save(existingLinkId, { featureType, featurePolicyId, inlineSettings })`.
- Produces: `MonitorsInlineSettings.checkIntervalSeconds: number` (10–3600, default 60); `decomposeInlineSettings('monitors')` upserts `config_policy_monitoring_settings(feature_link_id, check_interval_seconds)`; `assembleInlineSettings('monitors')` returns `{ items, inheritance, checkIntervalSeconds }` (and returns a non-null object even when `items` is empty, because the interval is a value); `deleteNormalizedRows('monitors')` also deletes the settings row.

- [ ] **Step 1: Write the failing tests.** Append to `packages/shared/src/validators/monitors.test.ts`:

```ts
describe('monitors inline settings — checkIntervalSeconds (W05d)', () => {
  it('defaults to 60 and accepts 10..3600', () => {
    expect(monitorsInlineSettingsSchema.parse({ items: [] }).checkIntervalSeconds).toBe(60);
    expect(monitorsInlineSettingsSchema.parse({ items: [], checkIntervalSeconds: 10 }).checkIntervalSeconds).toBe(10);
    expect(monitorsInlineSettingsSchema.parse({ items: [], checkIntervalSeconds: 3600 }).checkIntervalSeconds).toBe(3600);
  });
  it('rejects out-of-range and non-integer values', () => {
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], checkIntervalSeconds: 9 }).success).toBe(false);
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], checkIntervalSeconds: 3601 }).success).toBe(false);
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], checkIntervalSeconds: 60.5 }).success).toBe(false);
  });
});
```

Append to `apps/api/src/services/configurationPolicy.monitors.test.ts` (follow the file's existing `tx`/`db` mock shape — it already exercises the `monitors` decompose arm):

```ts
describe('monitors decompose/assemble own config_policy_monitoring_settings (W05d)', () => {
  it('decompose upserts the settings row keyed on the monitors link', async () => {
    const tx = makeTx(); // the file's existing transaction mock factory
    await decomposeForTest(tx, 'link-1', 'monitors', { items: [], checkIntervalSeconds: 120 });
    expect(tx.insert).toHaveBeenCalledWith(configPolicyMonitoringSettings);
    expect(tx.insertValues).toHaveBeenCalledWith(expect.objectContaining({ featureLinkId: 'link-1', checkIntervalSeconds: 120 }));
    expect(tx.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ target: configPolicyMonitoringSettings.featureLinkId }));
  });
  it('assemble returns the interval even with zero attachments', async () => {
    const executor = makeExecutor({ monitorsRows: [], settingsRows: [{ checkIntervalSeconds: 45 }] });
    const out = await assembleForTest(executor, 'monitors', 'link-1');
    expect(out).toEqual(expect.objectContaining({ items: [], checkIntervalSeconds: 45 }));
  });
  it('deleteNormalizedRows for monitors removes the settings row too', async () => {
    const tx = makeTx();
    await deleteNormalizedForTest(tx, 'link-1', 'monitors');
    expect(tx.delete).toHaveBeenCalledWith(configPolicyMonitors);
    expect(tx.delete).toHaveBeenCalledWith(configPolicyMonitoringSettings);
  });
});
```

`decomposeForTest` / `assembleForTest` / `deleteNormalizedForTest` are whatever that file already uses to reach the private arms (it drives them through `addFeatureLink` / `updateFeatureLink` / `getConfigPolicy` with a mocked `db`); keep its convention rather than exporting the private functions.

In `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx`, replace W05c2 Task 3's three cases (they assert a PATCH/POST on the `monitoring` link with `{ checkIntervalSeconds, watches }`) with:

```tsx
it('saves the check interval inside the monitors link inline settings (W05d)', async () => {
  fetchMock.mockResolvedValue(json({ data: [] }));
  render(<MonitorsTab {...baseProps} existingLink={{ id: 'l1', featureType: 'monitors', inlineSettings: { items: [], checkIntervalSeconds: 60 } } as never} />);
  fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '120' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    expect.stringMatching(/\/configuration-policies\/p1\/feature-links\/l1$/),
    expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('"checkIntervalSeconds":120') }),
  ));
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/monitoring/), expect.anything());
});
```

- [ ] **Step 2: Run them, expect FAIL.**
```bash
cd packages/shared && npx vitest run src/validators/monitors.test.ts
cd apps/api && npx vitest run src/services/configurationPolicy.monitors.test.ts
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx
```
Expected: shared — `expected undefined to be 60`; api — `expected "spy" to be called with [configPolicyMonitoringSettings]`; web — body does not contain `checkIntervalSeconds` (or the field is posted at the `monitoring` link URL).

- [ ] **Step 3: Implement.**

`packages/shared/src/validators/monitors.ts` (lines 295-297; keep W05c1's `inheritance` field):
```ts
export const monitorsInlineSettingsSchema = z.object({
  items: z.array(monitorAttachmentItemSchema).max(200).default([]),
  inheritance: z.enum(['cumulative', 'replace']).default('cumulative'),
  // W05d — the only per-policy agent-collection setting the retired
  // Service & Process tab carried. Stored normalized on
  // config_policy_monitoring_settings, keyed by THIS link.
  checkIntervalSeconds: z.number().int().min(10).max(3600).default(60),
});
```

`apps/api/src/services/configurationPolicy.ts`, `decomposeInlineSettings` `case 'monitors'` (line 1117):
```ts
    case 'monitors': {
      const parsed = monitorsInlineSettingsSchema.parse(s);
      if (parsed.items.length > 0) {
        await tx.insert(configPolicyMonitors).values(
          parsed.items.map((item, idx) => ({
            featureLinkId: linkId,
            monitorId: item.monitorId,
            enabled: item.enabled,
            overrides: item.overrides ?? null,
            sortOrder: item.sortOrder ?? idx,
          }))
        );
      }
      // W05d: the per-policy check interval lives on the settings row this
      // link owns (re-keyed from the retired `monitoring` link by
      // 2026-10-24-100000-legacy-alerting-retirement-sweep.sql). Upsert, so an
      // update that re-decomposes never loses the row's id — retired watches
      // (alert history) still hang off it via settings_id.
      await tx
        .insert(configPolicyMonitoringSettings)
        .values({ featureLinkId: linkId, checkIntervalSeconds: parsed.checkIntervalSeconds })
        .onConflictDoUpdate({
          target: configPolicyMonitoringSettings.featureLinkId,
          set: { checkIntervalSeconds: parsed.checkIntervalSeconds, updatedAt: new Date() },
        });
      break;
    }
```

`deleteNormalizedRows` `case 'monitors'` (line 1245) — delete attachments only, **not** the settings row (the upsert above owns it; deleting it would cascade the retired watches). Leave that arm as it is and add the comment:
```ts
    case 'monitors':
      // Attachments are replaced wholesale; the settings row is upserted by
      // decompose (W05d) and deliberately NOT deleted here — its retired
      // watches are alert history.
      await tx.delete(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, linkId));
      break;
```
(Adjust the third unit test above accordingly: assert `tx.delete` was **not** called with `configPolicyMonitoringSettings`. Link deletion still removes the row through the FK cascade, which is the existing behaviour for a removed link.)

`assembleInlineSettings` `case 'monitors'` (line 1498):
```ts
    case 'monitors': {
      const rows = await executor
        .select()
        .from(configPolicyMonitors)
        .where(eq(configPolicyMonitors.featureLinkId, linkId))
        .orderBy(asc(configPolicyMonitors.sortOrder));
      const [settingsRow] = await executor
        .select({ checkIntervalSeconds: configPolicyMonitoringSettings.checkIntervalSeconds })
        .from(configPolicyMonitoringSettings)
        .where(eq(configPolicyMonitoringSettings.featureLinkId, linkId))
        .limit(1);
      if (rows.length === 0 && !settingsRow) return null;
      return {
        items: rows.map((r) => ({
          monitorId: r.monitorId,
          enabled: r.enabled,
          overrides: r.overrides,
          sortOrder: r.sortOrder,
        })),
        checkIntervalSeconds: settingsRow?.checkIntervalSeconds ?? 60,
      };
    }
```
(W05c1 stores `inheritance` on the link's JSONB and merges it in its own arm — keep whatever it added; only the `checkIntervalSeconds` read is new.)

`apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx`: W05c2 added a *Check interval* input that wrote to the `monitoring` link. Replace that write path: hold the value in component state seeded from `existingLink?.inlineSettings.checkIntervalSeconds ?? parentLink?.inlineSettings.checkIntervalSeconds ?? 60`, and include it in every `save(...)` payload:
```tsx
const [checkIntervalSeconds, setCheckIntervalSeconds] = useState<number>(
  readCheckInterval(existingLink) ?? readCheckInterval(parentLink) ?? 60,
);
function readCheckInterval(link: InlineSettingsLike): number | undefined {
  const v = (link?.inlineSettings as { checkIntervalSeconds?: unknown } | null | undefined)?.checkIntervalSeconds;
  return typeof v === 'number' ? v : undefined;
}
// in handleSave / handleOverride:
inlineSettings: { items: buildPayloadItems(), inheritance, checkIntervalSeconds },
```
and change `handleSave`'s empty-items branch so a policy with no attachments but a non-default interval keeps its link (`if (items.length === 0 && checkIntervalSeconds === 60 && inheritance === 'cumulative')` → remove; otherwise save). Delete the W05c2 `monitoring`-link fetch/PATCH for the interval and its "creating an empty-watch link" helper. The input keeps W05c2's `data-testid="monitors-tab-check-interval"` and label key — no new i18n keys in this task. W05c2's `siblingLinks` plumbing (its Task 2) that existed only so the Monitors tab could write the `monitoring` sibling link is deleted with the write.

- [ ] **Step 4: Run, expect PASS.**
```bash
cd packages/shared && npx vitest run src/validators/monitors.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/services/configurationPolicy.monitors.test.ts src/services/configurationPolicy.inheritance.test.ts src/routes/configurationPolicies/featureLinks.test.ts
pnpm --filter @breeze/web exec tsc --noEmit
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx
```

- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/validators/monitors.ts packages/shared/src/validators/monitors.test.ts apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.monitors.test.ts apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx
git commit -m "feat(monitors): checkIntervalSeconds lives on the monitors link; decompose/assemble own the settings row"
```

---

### Task 3: Agent config builder reads the `monitors` link; policy watches leave the wire (PR1)

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (`unionMonitoringWatches` 2163-2195 — delete; `resolveDeviceMonitoringSettings` 2197-2241; `resolvePolicyMonitoringSettings` 2243-2370)
- Modify: `apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts`, `helpers.partnerWidePolicies.test.ts` (lines 244-290 fixture, 465-516 `monitoring:` cases, 518-560 #2949 case), `heartbeat.test.ts`
- Modify: `apps/api/src/__tests__/integration/monitorWatchDelivery.integration.test.ts`, `apps/api/src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts`

**Interfaces:**
- Consumes: `configPolicyEffectiveFeatureLinks.featureType = 'monitors'`, `configPolicyMonitoringSettings.checkIntervalSeconds`, `resolveMonitorDerivedWatches(deviceId)` (2091), `MONITOR_ONLY_CHECK_INTERVAL_SECONDS` (2070).
- Produces: `buildMonitoringConfigUpdate(deviceId): Promise<MonitoringConfigUpdate | null>` unchanged in signature and wire shape; `check_interval_seconds` from the winning `monitors` link's settings row (default 60); `watches` from monitors only. `resolvePolicyMonitoringSettings` now returns `{ check_interval_seconds: number } | null` (renamed `resolvePolicyCheckInterval`).

- [ ] **Step 1: Write the failing tests.** In `helpers.partnerWidePolicies.test.ts`, change the `monitoring:` cases (465-516): the fixture link's `feature` becomes `'monitors'`, the watches select is gone, and add:

```ts
it('monitors: the check interval comes from the winning monitors link, and no watches query runs (W05d)', async () => {
  seedPolicyRows([{ level: 'partner', feature: 'monitors', settingsId: 's1', checkIntervalSeconds: 90 }]);
  seedMonitorDerivedWatches([]);
  const result = await buildMonitoringConfigUpdate('dev-1');
  expect(result?.check_interval_seconds).toBe(90);
  expect(result?.watches).toEqual([]);
  expect(selectFromTables()).not.toContain(configPolicyMonitoringWatches);
  expect(joinedFeatureTypes()).toEqual(['monitors']);
});
it('a monitoring-link settings row is ignored after the re-key (W05d)', async () => {
  seedPolicyRows([{ level: 'organization', feature: 'monitoring', settingsId: 's-legacy', checkIntervalSeconds: 15 }]);
  seedMonitorDerivedWatches([]);
  expect(await buildMonitoringConfigUpdate('dev-1')).toBeNull();
});
```
(`seedPolicyRows`, `seedMonitorDerivedWatches`, `selectFromTables`, `joinedFeatureTypes` are the file's existing helpers around lines 244-316; extend them if a name differs.) In `helpers.monitorWatchDelivery.test.ts`, replace the union cases ("policy watch fills thresholds", "auto_restart is OR'd") with one case asserting a policy-tab watch row is **not** delivered even when present, and keep the monitor-derived cases unchanged. In `monitorWatchDelivery.integration.test.ts`, the fixture that inserts a `monitoring` link with a settings row for the check interval must insert a `monitors` link instead (`configPolicyFeatureLinks.featureType: 'monitors'`) and assert `check_interval_seconds` still reads 90 through it.

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/routes/agents/helpers.partnerWidePolicies.test.ts src/routes/agents/helpers.monitorWatchDelivery.test.ts
```
Expected: `expected ['monitoring'] to deeply equal ['monitors']` and `expected [configPolicyMonitoringWatches…] not to contain …`.

- [ ] **Step 3: Implement.** In `helpers.ts`:

1. Delete `unionMonitoringWatches` (2163-2195).
2. `resolveDeviceMonitoringSettings` (2197-2241):
```ts
async function resolveDeviceMonitoringSettings(deviceId: string): Promise<MonitoringConfigUpdate | null> {
  // W05d: monitors are the ONLY source of watches. The policy read supplies
  // one value — the per-policy check interval — from the `monitors` link.
  const policy = await resolvePolicyCheckInterval(deviceId);
  const monitorResult = await resolveMonitorDerivedWatches(deviceId);
  if (monitorResult.kind === 'device_missing') {
    console.warn(`[monitoring] device vanished mid-resolution, omitting monitoring update for device ${deviceId}`);
    return null;
  }
  // Null ONLY when no `monitors` link resolved AND no monitor produced a
  // watch. A resolved link with zero watches still returns `watches: []` —
  // the #2949 "stop watching" signal.
  if (!policy && monitorResult.watches.length === 0) return null;
  return {
    check_interval_seconds: policy?.check_interval_seconds ?? MONITOR_ONLY_CHECK_INTERVAL_SECONDS,
    watches: monitorResult.watches,
  };
}
```
3. Rename `resolvePolicyMonitoringSettings` → `resolvePolicyCheckInterval(deviceId): Promise<{ check_interval_seconds: number } | null>`; in the join at 2305-2312 change `eq(configPolicyEffectiveFeatureLinks.featureType, 'monitoring')` to `'monitors'`; delete steps 7 (the watches query, 2333-2369) and return `{ check_interval_seconds: winner.checkIntervalSeconds }`. Keep the `#4673 W03` comment about the caller's own context — it is still why no system escape is needed (the `config_policy_feature_links` partner-wide SELECT branch and the agent GUC do the work). Update the doc comment on `MONITOR_ONLY_CHECK_INTERVAL_SECONDS` (2070): it is now the default when no `monitors` link resolves.
4. `MonitoringWatchConfig` and `MonitoringConfigUpdate` (2019-2036): unchanged.

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/routes/agents/helpers.partnerWidePolicies.test.ts src/routes/agents/helpers.monitorWatchDelivery.test.ts src/routes/agents/heartbeat.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/monitorWatchDelivery.integration.test.ts src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts
```
Also confirm the Go side never learns anything: `cd agent && go test -race ./internal/monitoring/...` (no change expected; it is the wire-shape control).

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts apps/api/src/routes/agents/helpers.partnerWidePolicies.test.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/__tests__/integration/monitorWatchDelivery.integration.test.ts apps/api/src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts
git commit -m "feat(agents): monitoring_settings check interval reads the monitors link; policy watches leave the wire"
```

---

### Task 4: Boot-time system sweep + startup count check (PR1)

**Files:**
- Create: `apps/api/src/services/monitors/conversion/retirementSweep.ts`
- Create: `apps/api/src/services/monitors/conversion/retirementSweep.test.ts`
- Create: `apps/api/src/__tests__/integration/legacyAlertingRetirementSweep.integration.test.ts`
- Modify: `apps/api/src/services/monitors/conversion/convert.ts` (W05c1; `convertPartnerLegacy`), `conversion/types.ts` (the widened return type), `conversion/loadSources.ts` (the watch source predicate)
- Modify: `apps/api/src/index.ts` (import block near line 170; the detached block after line 1871)
- Test (existing): `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, `site-ceiling-write-coverage.test.ts` (allowlist if flagged)

**Interfaces:**
- Consumes: `convertPartnerLegacy(partnerId, auth)`, `retireSource(sourceTable, sourceId, reason, auth)`, `previewPolicyConversion(policyId, auth)` and `ConversionPreviewItem` (W05c1); `createSystemAuthContext()` (`services/featureConfigResolver.ts:52`); `runOutsideDbContext`, `withSystemDbAccessContext` (`db/index.ts`); `captureException(err, c?, tags?)` (`services/sentry.ts:687`); `partners.settings` jsonb (`db/schema/orgs.ts:39`).
- Produces:
  ```ts
  // services/monitors/conversion/convert.ts (W05c1 signature widened, backwards compatible; types in conversion/types.ts, re-exported by index.ts)
  export interface ConvertPartnerLegacyOptions { retireUnconvertible?: boolean }
  export interface RetiredSource { sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string; policyId: string | null }
  export async function convertPartnerLegacy(partnerId: string, auth: AuthContext, opts?: ConvertPartnerLegacyOptions):
    Promise<{ policies: number; converted: number; unconvertible: number; retired: RetiredSource[] }>;

  // services/monitors/conversion/retirementSweep.ts
  export const LEGACY_ALERTING_RETIREMENT_VERSION = 1;
  export interface LegacyAlertingRemaining { configPolicyAlertRules: number; configPolicyMonitoringWatches: number }
  export interface RetirementRunResult { partners: number; converted: number; retired: number; failed: number; remaining: LegacyAlertingRemaining }
  export class LegacyAlertingUnretiredError extends Error { readonly remaining: LegacyAlertingRemaining }
  export async function listPartnersWithUnretiredLegacyAlerting(): Promise<string[]>;
  export async function sweepPartnerLegacyAlerting(partnerId: string): Promise<{ converted: number; retired: RetiredSource[] }>;
  export async function checkLegacyAlertingRetired(): Promise<LegacyAlertingRemaining>;
  export async function runLegacyAlertingRetirement(): Promise<RetirementRunResult>;
  ```
  Marker: `partners.settings.legacyAlertingRetirement = { version: 1, sweptAt: ISO, converted: n, retired: n, unconvertible: RetiredSource[] (≤ 200) }`. Env opt-out: `BREEZE_LEGACY_ALERTING_SWEEP=false` (sweep skipped; the count check still runs).

- [ ] **Step 1: Write the failing tests.** Create `apps/api/src/services/monitors/conversion/retirementSweep.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  convertPartnerLegacy: vi.fn(),
  captureException: vi.fn(),
  executeRows: [] as Array<Record<string, unknown>>,
  updateSet: vi.fn(),
  countRows: [{ rules: 0, watches: 0 }],
}));

vi.mock('../../../db', () => ({
  db: {
    execute: vi.fn(async () => h.executeRows),
    update: vi.fn(() => ({ set: h.updateSet.mockReturnValue({ where: vi.fn(async () => undefined) }) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => h.countRows) })) })),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./index', () => ({ convertPartnerLegacy: h.convertPartnerLegacy }));
vi.mock('../../sentry', () => ({ captureException: h.captureException }));
vi.mock('../../featureConfigResolver', () => ({ createSystemAuthContext: () => ({ scope: 'system' }) }));

import { runLegacyAlertingRetirement, checkLegacyAlertingRetired, LegacyAlertingUnretiredError } from './retirementSweep';

beforeEach(() => {
  vi.clearAllMocks();
  h.executeRows = [];
  h.countRows = [{ rules: 0, watches: 0 }];
  delete process.env.BREEZE_LEGACY_ALERTING_SWEEP;
});

describe('runLegacyAlertingRetirement (W05d)', () => {
  it('sweeps only partners that still own unretired legacy rows and records the marker', async () => {
    h.executeRows = [{ partner_id: 'p1' }, { partner_id: 'p2' }];
    h.convertPartnerLegacy.mockResolvedValueOnce({ policies: 1, converted: 2, unconvertible: 1, retired: [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'Custom', reason: 'unconvertible:custom', policyId: 'pol' }] });
    h.convertPartnerLegacy.mockResolvedValueOnce({ policies: 0, converted: 0, unconvertible: 0, retired: [] });
    const out = await runLegacyAlertingRetirement();
    expect(h.convertPartnerLegacy).toHaveBeenCalledTimes(2);
    expect(h.convertPartnerLegacy).toHaveBeenCalledWith('p1', expect.objectContaining({ scope: 'system' }), { retireUnconvertible: true });
    expect(out).toMatchObject({ partners: 2, converted: 2, retired: 1, failed: 0 });
    expect(h.updateSet).toHaveBeenCalledTimes(2);
  });
  it('one partner failing never blocks the rest, and is reported to Sentry', async () => {
    h.executeRows = [{ partner_id: 'p1' }, { partner_id: 'p2' }];
    h.convertPartnerLegacy.mockRejectedValueOnce(new Error('boom'));
    h.convertPartnerLegacy.mockResolvedValueOnce({ policies: 0, converted: 1, unconvertible: 0, retired: [] });
    const out = await runLegacyAlertingRetirement();
    expect(out).toMatchObject({ partners: 1, failed: 1, converted: 1 });
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ area: 'legacy_alerting_sweep', partnerId: 'p1' }));
  });
  it('BREEZE_LEGACY_ALERTING_SWEEP=false skips conversion but still counts', async () => {
    process.env.BREEZE_LEGACY_ALERTING_SWEEP = 'false';
    h.executeRows = [{ partner_id: 'p1' }];
    h.countRows = [{ rules: 3, watches: 0 }];
    const out = await runLegacyAlertingRetirement();
    expect(h.convertPartnerLegacy).not.toHaveBeenCalled();
    expect(out.remaining).toEqual({ configPolicyAlertRules: 3, configPolicyMonitoringWatches: 0 });
  });
});

describe('checkLegacyAlertingRetired (W05d)', () => {
  it('is silent at zero', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkLegacyAlertingRetired();
    expect(err).not.toHaveBeenCalled();
    expect(h.captureException).not.toHaveBeenCalled();
  });
  it('logs at error level and reports to Sentry when anything is unretired — and never throws', async () => {
    h.countRows = [{ rules: 2, watches: 5 }];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const remaining = await checkLegacyAlertingRetired();
    expect(remaining).toEqual({ configPolicyAlertRules: 2, configPolicyMonitoringWatches: 5 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('2 config_policy_alert_rules'));
    expect(h.captureException).toHaveBeenCalledWith(expect.any(LegacyAlertingUnretiredError), undefined, expect.objectContaining({ area: 'legacy_alerting_unretired' }));
  });
});
```

Create `apps/api/src/__tests__/integration/legacyAlertingRetirementSweep.integration.test.ts` (real Postgres; proves the sweep through W05c1's converter):

```ts
/**
 * W05d Task 4 — the boot sweep converts a convertible inline rule, retires an
 * unconvertible one with a reason, records the partner marker, and the count
 * check reads zero afterwards. Runs W05c1's real converter against real RLS:
 * a system context per partner, never a bare pool.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { configPolicyAlertRules, configPolicyFeatureLinks, configPolicyMonitors, configurationPolicies, monitorDefinitions, partners } from '../../db/schema';
import { runLegacyAlertingRetirement, checkLegacyAlertingRetired } from '../../services/monitors/conversion/retirementSweep';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, partnerId: null, userId: null, roleId: null, isPlatformAdmin: false };
const policyIds: string[] = [];
afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of policyIds.splice(0)) await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
  });
});

describe('legacy alerting retirement sweep', () => {
  it('converts, retires with reason, writes the marker, and the count check is zero', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId, convertibleId, customId } = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [policy] = await db.insert(configurationPolicies).values({ orgId: org.id, name: 'W05d sweep', status: 'active' }).returning();
      policyIds.push(policy!.id);
      const [link] = await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'alert_rule', inlineSettings: { items: [] } }).returning();
      const [a] = await db.insert(configPolicyAlertRules).values({
        featureLinkId: link!.id, name: 'CPU high', severity: 'high', cooldownMinutes: 5, autoResolve: true,
        conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80, durationMinutes: 5 }],
        titleTemplate: 't', messageTemplate: 'm', sortOrder: 0,
      }).returning();
      const [b] = await db.insert(configPolicyAlertRules).values({
        featureLinkId: link!.id, name: 'Custom thing', severity: 'low', cooldownMinutes: 5, autoResolve: false,
        conditions: [{ type: 'custom', script: 'x' }], titleTemplate: 't', messageTemplate: 'm', sortOrder: 1,
      }).returning();
      return { policyId: policy!.id, convertibleId: a!.id, customId: b!.id };
    });

    const run = await runLegacyAlertingRetirement();
    expect(run.failed).toBe(0);
    expect(run.converted).toBeGreaterThanOrEqual(1);
    expect(run.retired).toBeGreaterThanOrEqual(1);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [conv] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, convertibleId));
      expect(conv!.retiredAt).not.toBeNull();
      expect(conv!.retiredReason).toBe('converted');
      expect(conv!.convertedToMonitorId).not.toBeNull();
      const [attach] = await db.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.monitorId, conv!.convertedToMonitorId!));
      expect(attach).toBeDefined();
      const [def] = await db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, conv!.convertedToMonitorId!));
      expect(def!.kind).toBe('cpu');
      expect(def!.orgId).toBe(org.id);

      const [cust] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, customId));
      expect(cust!.retiredAt).not.toBeNull();
      expect(cust!.retiredReason).toMatch(/^unconvertible:/);
      expect(cust!.convertedToMonitorId).toBeNull();

      const [p] = await db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, partner.id));
      const marker = (p!.settings as Record<string, any>).legacyAlertingRetirement;
      expect(marker.version).toBe(1);
      expect(marker.unconvertible).toEqual([expect.objectContaining({ sourceId: customId })]);
    });

    expect(await checkLegacyAlertingRetired()).toEqual({ configPolicyAlertRules: 0, configPolicyMonitoringWatches: 0 });
    expect(policyId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/services/monitors/conversion/retirementSweep.test.ts
```
Expected: `Failed to resolve import "./retirementSweep"`.

- [ ] **Step 3: Implement.**

`apps/api/src/services/monitors/conversion/convert.ts` (W05c1) — widen `convertPartnerLegacy` (put `ConvertPartnerLegacyOptions` / `RetiredSource` in `conversion/types.ts` and re-export from `index.ts`):
```ts
export interface ConvertPartnerLegacyOptions { retireUnconvertible?: boolean }
export interface RetiredSource { sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string; policyId: string | null }

export async function convertPartnerLegacy(
  partnerId: string,
  auth: AuthContext,
  opts: ConvertPartnerLegacyOptions = {},
): Promise<{ policies: number; converted: number; unconvertible: number; retired: RetiredSource[] }> {
  // …existing W05c1 body: order policies parents-first, preview each,
  // convertPolicy(policyId, preview.previewHash, auth) for the convertible
  // items, accumulate { policies, converted, unconvertible } …
  const retired: RetiredSource[] = [];
  if (opts.retireUnconvertible) {
    for (const { policyId, preview } of previews) {
      // A policy the equivalence check refused, or one still blocked after the
      // parents-first pass, cannot convert without a human — and after W05d
      // nothing evaluates its rows. Retire them with the reason so the banner
      // lists them (spec §Conversion "Who runs it").
      const policyReason = preview.blockedBy
        ? `unconvertible:${preview.blockedBy}`
        : preview.equivalence.deltas.length > 0
          ? 'unconvertible:equivalence_delta'
          : null;
      for (const item of preview.items) {
        const reason = item.outcome === 'unconvertible' ? `unconvertible:${item.reason ?? 'unknown'}` : policyReason;
        if (!reason) continue;
        await retireSource(item.sourceTable, item.sourceId, reason, auth);
        retired.push({ sourceTable: item.sourceTable, sourceId: item.sourceId, name: item.name, reason, policyId });
      }
    }
  }
  return { policies, converted, unconvertible, retired };
}
```
`item.reason` is W05c1's code (`custom`, `nested_group`, `no_condition`, `escalation_policy_axis`, …); store it prefixed, matching the `retired_reason` domain in spec §Data model (`'unconvertible:<code>'`). `retireSource` is idempotent on an already-retired row (W05c1 contract) — a re-run of the sweep must not double-list; skip items whose row already carries `retired_at` (the preview omits them).

**Watch source after the re-key:** `grep -n "'monitoring'" apps/api/src/services/monitors/conversion/loadSources.ts` (W05c1 plan line ~1507, `case 'monitoring'`). Where the loader reaches `config_policy_monitoring_watches` through `config_policy_feature_links.feature_type = 'monitoring'`, widen the predicate to `inArray(configPolicyFeatureLinks.featureType, ['monitoring', 'monitors'])` — Task 1 moved the settings rows under the `monitors` link, and the watches follow their settings row. Without this the sweep finds zero watches on every re-keyed policy and the count check flags them forever.

Create `apps/api/src/services/monitors/conversion/retirementSweep.ts`:
```ts
/**
 * W05d — boot-time retirement sweep for legacy alerting.
 *
 * Converts whatever the W05c release left unconverted (self-hosters who never
 * pressed "Convert everything"), retires the unconvertible rows with a reason,
 * and then counts what is still unretired so a skipped or failed sweep is loud
 * rather than silent. Mirrors ensureBuiltInMonitorsForAllPartners: called
 * WITHOUT an enclosing DB context, after the HTTP listener is up, one system
 * context (= one top-level transaction) per partner so one failure never
 * blocks the rest. Never refuses boot.
 */
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { configPolicyAlertRules, configPolicyMonitoringWatches, partners } from '../../../db/schema';
import { captureException } from '../../sentry';
import { createSystemAuthContext } from '../../featureConfigResolver';
import { convertPartnerLegacy, type RetiredSource } from './index';

export const LEGACY_ALERTING_RETIREMENT_VERSION = 1;
const MARKER_UNCONVERTIBLE_CAP = 200;

export interface LegacyAlertingRemaining { configPolicyAlertRules: number; configPolicyMonitoringWatches: number }
export interface RetirementRunResult { partners: number; converted: number; retired: number; failed: number; remaining: LegacyAlertingRemaining }

export class LegacyAlertingUnretiredError extends Error {
  constructor(readonly remaining: LegacyAlertingRemaining) {
    super(
      `Legacy alerting rows are still unretired after the W05d sweep: ` +
      `${remaining.configPolicyAlertRules} config_policy_alert_rules, ` +
      `${remaining.configPolicyMonitoringWatches} config_policy_monitoring_watches. ` +
      `Nothing evaluates them any more. Open Alerts → Monitors for the list, or run the ` +
      `partner "Convert everything" action; set BREEZE_LEGACY_ALERTING_SWEEP=true if it was disabled.`,
    );
    this.name = 'LegacyAlertingUnretiredError';
  }
}

function sweepEnabled(): boolean {
  return process.env.BREEZE_LEGACY_ALERTING_SWEEP !== 'false';
}

/** Partners that still own an unretired legacy source row, on either axis. */
export async function listPartnersWithUnretiredLegacyAlerting(): Promise<string[]> {
  const rows = await db.execute<{ partner_id: string }>(sql`
    SELECT DISTINCT partner_id FROM (
      SELECT COALESCE(cp.partner_id, o.partner_id) AS partner_id
        FROM config_policy_alert_rules r
        JOIN config_policy_feature_links l ON l.id = r.feature_link_id
        JOIN configuration_policies cp ON cp.id = l.config_policy_id
        LEFT JOIN organizations o ON o.id = cp.org_id
       WHERE r.retired_at IS NULL
      UNION ALL
      SELECT COALESCE(cp.partner_id, o.partner_id)
        FROM config_policy_monitoring_watches w
        JOIN config_policy_monitoring_settings s ON s.id = w.settings_id
        JOIN config_policy_feature_links l ON l.id = s.feature_link_id
        JOIN configuration_policies cp ON cp.id = l.config_policy_id
        LEFT JOIN organizations o ON o.id = cp.org_id
       WHERE w.retired_at IS NULL
      UNION ALL
      SELECT COALESCE(ar.partner_id, o.partner_id)
        FROM alert_rules ar LEFT JOIN organizations o ON o.id = ar.org_id
       WHERE ar.retired_at IS NULL AND ar.managed_by_monitor_id IS NULL
      UNION ALL
      SELECT COALESCE(t.partner_id, o.partner_id)
        FROM alert_templates t LEFT JOIN organizations o ON o.id = t.org_id
       WHERE t.retired_at IS NULL AND t.managed_by_monitor_id IS NULL AND t.is_built_in = false
    ) u
    JOIN partners p ON p.id = u.partner_id AND p.deleted_at IS NULL
  `);
  return rows.map((r) => r.partner_id);
}

export async function sweepPartnerLegacyAlerting(partnerId: string): Promise<{ converted: number; retired: RetiredSource[] }> {
  const auth = createSystemAuthContext();
  const result = await convertPartnerLegacy(partnerId, auth, { retireUnconvertible: true });
  const now = new Date().toISOString();
  await db
    .update(partners)
    .set({
      settings: sql`COALESCE(${partners.settings}, '{}'::jsonb) || jsonb_build_object('legacyAlertingRetirement', jsonb_build_object(
        'version', ${LEGACY_ALERTING_RETIREMENT_VERSION}::int,
        'sweptAt', ${now}::text,
        'converted', ${result.converted}::int,
        'retired', ${result.retired.length}::int,
        'unconvertible', ${JSON.stringify(result.retired.slice(0, MARKER_UNCONVERTIBLE_CAP))}::jsonb
      ))`,
    })
    .where(eq(partners.id, partnerId));
  return { converted: result.converted, retired: result.retired };
}

export async function checkLegacyAlertingRetired(): Promise<LegacyAlertingRemaining> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          rules: sql<number>`(SELECT count(*)::int FROM ${configPolicyAlertRules} WHERE ${configPolicyAlertRules.retiredAt} IS NULL)`,
          watches: sql<number>`(SELECT count(*)::int FROM ${configPolicyMonitoringWatches} WHERE ${configPolicyMonitoringWatches.retiredAt} IS NULL)`,
        })
        .from(sql`(SELECT 1) AS one`),
    ),
  );
  const remaining = { configPolicyAlertRules: row?.rules ?? 0, configPolicyMonitoringWatches: row?.watches ?? 0 };
  if (remaining.configPolicyAlertRules > 0 || remaining.configPolicyMonitoringWatches > 0) {
    const err = new LegacyAlertingUnretiredError(remaining);
    console.error(`[legacy-alerting-retirement] ${err.message}`);
    captureException(err, undefined, { area: 'legacy_alerting_unretired' });
  }
  return remaining;
}

export async function runLegacyAlertingRetirement(): Promise<RetirementRunResult> {
  let swept = 0, converted = 0, retired = 0, failed = 0;
  if (!sweepEnabled()) {
    console.warn('[legacy-alerting-retirement] sweep disabled by BREEZE_LEGACY_ALERTING_SWEEP=false; only counting');
  } else {
    const partnerIds = await runOutsideDbContext(() => withSystemDbAccessContext(listPartnersWithUnretiredLegacyAlerting));
    for (const partnerId of partnerIds) {
      try {
        const r = await runOutsideDbContext(() => withSystemDbAccessContext(() => sweepPartnerLegacyAlerting(partnerId)));
        swept += 1; converted += r.converted; retired += r.retired.length;
      } catch (err) {
        failed += 1;
        console.error(`[legacy-alerting-retirement] partner ${partnerId} failed:`, err);
        captureException(err, undefined, { area: 'legacy_alerting_sweep', partnerId });
      }
    }
  }
  const remaining = await checkLegacyAlertingRetired();
  return { partners: swept, converted, retired, failed, remaining };
}
```
(The unit test's `db.select` mock returns `[{ rules, watches }]`; keep the column aliases `rules`/`watches`.)

`apps/api/src/index.ts` — import next to line 170:
```ts
import { runLegacyAlertingRetirement } from './services/monitors/conversion/retirementSweep';
```
and after the built-in monitors block (after line 1871):
```ts
  // W05d — convert whatever legacy alerting the W05c release left unconverted,
  // retire what cannot convert (listed in the Monitors banner), then count what
  // is still unretired. Detached after serve() for the same reason as the
  // built-ins above; chained so the count runs AFTER the sweep and cannot fire
  // spuriously on the first boot after upgrade. Never refuses boot.
  void runLegacyAlertingRetirement()
    .then((r) => {
      console.log(
        `[startup] Legacy alerting retirement: ${r.partners} partner(s) swept, ${r.converted} converted, ` +
        `${r.retired} retired, ${r.failed} failed; unretired rules=${r.remaining.configPolicyAlertRules} ` +
        `watches=${r.remaining.configPolicyMonitoringWatches}`,
      );
    })
    .catch((err) => {
      console.error('[startup] Legacy alerting retirement failed:', err);
      captureException(err, undefined, { area: 'legacy_alerting_sweep' });
    });
```
(`captureException` is already imported in `index.ts` — `grep -n "captureException" apps/api/src/index.ts` — reuse the import.)

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/services/monitors/conversion/retirementSweep.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/legacyAlertingRetirementSweep.integration.test.ts
```
If either coverage test names `retirementSweep.ts`, add its allowlist entry with the reason from Global Constraints and re-run.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/services/monitors/conversion/retirementSweep.ts apps/api/src/services/monitors/conversion/retirementSweep.test.ts apps/api/src/services/monitors/conversion/convert.ts apps/api/src/services/monitors/conversion/types.ts apps/api/src/services/monitors/conversion/loadSources.ts apps/api/src/services/monitors/conversion/index.ts apps/api/src/__tests__/integration/legacyAlertingRetirementSweep.integration.test.ts apps/api/src/index.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts apps/api/src/__tests__/site-ceiling-write-coverage.test.ts
git commit -m "feat(api): boot-time legacy alerting retirement sweep with startup count check"
```

---

### Task 5: Pending endpoint lists unconvertible rows and the sweep outcome; banner shows them once (PR1)

**Files:**
- Modify: `apps/api/src/routes/monitorDefinitions.ts` (W05c1's `GET /conversion/pending` handler)
- Create: `apps/api/src/routes/monitorDefinitions.conversion.pending.test.ts`
- Modify: `apps/web/src/components/monitoring/conversion/ConversionPendingBanner.tsx` (W05c2's name — see Ordering assumptions), `ConversionPendingBanner.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json`

**Interfaces:**
- Consumes: W05c1 `GET /monitor-definitions/conversion/pending?orgId → { data: { policies: number; rows: number } }` (handler in `routes/monitorDefinitions.ts`, backed by `countPendingConversions` in `conversion/convert.ts`); W05c2 `conversionPaths.pending(orgId)` in `components/monitoring/conversion/conversionApi.ts`; `partners.settings.legacyAlertingRetirement` (Task 4); `retired_reason` on the four source tables.
- Produces:
  ```ts
  interface PendingConversionResponse {
    policies: number; rows: number;                          // W05c1, unchanged (still wrapped in { data: … })
    unconvertible: Array<{ sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string; policyId: string | null; policyName: string | null; retiredAt: string }>; // ≤ 200, newest first
    sweep: { sweptAt: string; converted: number; retired: number } | null; // the caller's partner marker
  }
  ```
  Web: banner variant "N legacy rules could not be converted — review" with an expandable list and **Dismiss**; dismissal is per viewer in `localStorage` under `breeze.legacyAlertingRetirement.dismissed:<scopeId>:<sweptAt>` (a new sweep re-shows it), wrapped in try/catch.

- [ ] **Step 1: Write the failing tests.** `apps/api/src/routes/monitorDefinitions.conversion.pending.test.ts` (Drizzle mock pattern as in `monitorDefinitions.test.ts`):

```ts
it('GET /conversion/pending returns unconvertible rows and the partner sweep marker (W05d)', async () => {
  seedSelect([
    // pending counts (W05c1 queries) …
    [{ policies: 0, rows: 0 }],
    // unconvertible rows across the four source tables
    [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'Custom', reason: 'unconvertible:custom', policyId: 'pol', policyName: 'Servers', retiredAt: new Date('2026-11-01T00:00:00Z') }],
    // partner marker
    [{ settings: { legacyAlertingRetirement: { version: 1, sweptAt: '2026-11-01T00:00:00.000Z', converted: 4, retired: 1 } } }],
  ]);
  const res = await app.request('/monitor-definitions/conversion/pending?orgId=org-1', { headers: partnerAuth });
  expect(res.status).toBe(200);
  const { data: body } = await res.json();
  expect(body.unconvertible).toEqual([expect.objectContaining({ sourceId: 'r1', reason: 'unconvertible:custom', retiredAt: '2026-11-01T00:00:00.000Z' })]);
  expect(body.sweep).toEqual({ sweptAt: '2026-11-01T00:00:00.000Z', converted: 4, retired: 1 });
});
it('sweep is null when the partner has never been swept', async () => { /* marker query returns [{ settings: {} }] → data.sweep === null */ });
```

`ConversionPendingBanner.test.tsx`:
```tsx
it('lists unconvertible rows after the sweep and dismisses per viewer (W05d)', async () => {
  fetchMock.mockResolvedValue(json({ data: { policies: 0, rows: 0, sweep: { sweptAt: 's1', converted: 2, retired: 1 },
    unconvertible: [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'Custom', reason: 'unconvertible:custom', policyId: 'p', policyName: 'Servers', retiredAt: 's1' }] } }));
  render(<ConversionPendingBanner orgId="org-1" />);
  expect(await screen.findByText(/1 legacy rule could not be converted/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /review/i }));
  expect(screen.getByText('Custom')).toBeInTheDocument();
  expect(screen.getByText(/Servers/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(screen.queryByText(/could not be converted/i)).not.toBeInTheDocument();
  expect(window.localStorage.getItem('breeze.legacyAlertingRetirement.dismissed:org-1:s1')).toBe('1');
});
it('stays hidden when nothing is unconvertible', async () => {
  fetchMock.mockResolvedValue(json({ data: { policies: 0, rows: 0, sweep: null, unconvertible: [] } }));
  render(<ConversionPendingBanner orgId="org-1" />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(screen.queryByText(/could not be converted/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/routes/monitorDefinitions.conversion.pending.test.ts
cd apps/web && npx vitest run src/components/monitoring/conversion/ConversionPendingBanner.test.tsx
```
Expected: `expected undefined to deeply equal [ObjectContaining…]` (api); `Unable to find an element with the text: /1 legacy rule could not be converted/` (web).

- [ ] **Step 3: Implement.** In the pending handler, after W05c1's two counts:

```ts
const unconvertible = await db.execute<{ source_table: string; source_id: string; name: string; reason: string; policy_id: string | null; policy_name: string | null; retired_at: Date }>(sql`
  SELECT * FROM (
    SELECT 'config_policy_alert_rules' AS source_table, r.id AS source_id, r.name, r.retired_reason AS reason,
           cp.id AS policy_id, cp.name AS policy_name, r.retired_at
      FROM config_policy_alert_rules r
      JOIN config_policy_feature_links l ON l.id = r.feature_link_id
      JOIN configuration_policies cp ON cp.id = l.config_policy_id
     WHERE r.retired_reason LIKE 'unconvertible:%' AND ${policyAccessCondition(auth) ?? sql`true`}
    UNION ALL
    SELECT 'config_policy_monitoring_watches', w.id, COALESCE(w.display_name, w.name), w.retired_reason, cp.id, cp.name, w.retired_at
      FROM config_policy_monitoring_watches w
      JOIN config_policy_monitoring_settings s ON s.id = w.settings_id
      JOIN config_policy_feature_links l ON l.id = s.feature_link_id
      JOIN configuration_policies cp ON cp.id = l.config_policy_id
     WHERE w.retired_reason LIKE 'unconvertible:%' AND ${policyAccessCondition(auth) ?? sql`true`}
    UNION ALL
    SELECT 'alert_templates', t.id, t.name, t.retired_reason, NULL, NULL, t.retired_at
      FROM alert_templates t
     WHERE t.retired_reason LIKE 'unconvertible:%' AND ${templateAccessCondition(auth)}
    UNION ALL
    SELECT 'alert_rules', ar.id, ar.name, ar.retired_reason, NULL, NULL, ar.retired_at
      FROM alert_rules ar
     WHERE ar.retired_reason LIKE 'unconvertible:%' AND ${alertRuleAccessCondition(auth)}
  ) u
  ORDER BY retired_at DESC
  LIMIT 200
`);
```
`policyAccessCondition(auth)` is `services/configurationPolicy.ts:232`; the template/rule ownership predicates are the ones W05c1's pending counts already use (`routes/alerts/helpers.ts` `alertRuleOwnershipConditionForOrg` / the partner-wide rule scope helpers) — reuse them, do not write a fourth. RLS is the backstop either way. Then:
```ts
const partnerId = auth.scope === 'partner' ? auth.partnerId : (await orgPartnerId(orgId));
const [p] = partnerId ? await db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, partnerId)).limit(1) : [];
const marker = (p?.settings as Record<string, any> | null)?.legacyAlertingRetirement;
const sweep = marker?.sweptAt ? { sweptAt: marker.sweptAt, converted: marker.converted ?? 0, retired: marker.retired ?? 0 } : null;
return c.json({ data: { policies, rows, unconvertible: unconvertible.map(camel), sweep } });
```

`ConversionPendingBanner.tsx`: keep the W05c2 "needs conversion" variant; add the retirement variant rendered when `data.unconvertible.length > 0` and `!isDismissed(scopeId, data.sweep?.sweptAt ?? 'manual')`:
```tsx
const dismissKey = (scopeId: string, sweptAt: string) => `breeze.legacyAlertingRetirement.dismissed:${scopeId}:${sweptAt}`;
function isDismissed(scopeId: string, sweptAt: string): boolean {
  try { return window.localStorage.getItem(dismissKey(scopeId, sweptAt)) === '1'; } catch { return false; }
}
function dismiss(scopeId: string, sweptAt: string) {
  try { window.localStorage.setItem(dismissKey(scopeId, sweptAt), '1'); } catch { /* private window: render without persistence */ }
}
// …
<div role="status" data-testid="legacy-retirement-banner" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
  <div className="flex items-center justify-between gap-2">
    <span>{t('conversion.retirement.summary', { count: data.unconvertible.length })}</span>
    <div className="flex gap-2">
      <button type="button" className="underline" onClick={() => setOpen((o) => !o)}>{t('conversion.retirement.review')}</button>
      <button type="button" className="underline" onClick={() => { dismiss(scopeId, sweptAt); setHidden(true); }}>{t('conversion.retirement.dismiss')}</button>
    </div>
  </div>
  {open && (
    <ul className="mt-2 space-y-1">
      {data.unconvertible.map((u) => (
        <li key={`${u.sourceTable}:${u.sourceId}`}>
          <span className="font-medium">{u.name}</span>
          {u.policyName ? <span className="text-muted-foreground"> — {u.policyName}</span> : null}
          <span className="ml-2 rounded bg-muted px-1 text-xs">{t(/* i18n-dynamic */ `conversion.retirement.reasons.${u.reason.replace('unconvertible:', '')}`, { defaultValue: u.reason })}</span>
        </li>
      ))}
      <li className="text-muted-foreground">{t('conversion.retirement.openAlertsNote')}</li>
    </ul>
  )}
</div>
```
`monitoring.json` keys (add to all 8 locales; `summary` uses i18next plurals `_one`/`_other`):
| key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|
| `conversion.retirement.summary_one` | `{{count}} legacy rule could not be converted to a monitor — review it.` | `{{count}} alte Regel konnte nicht in einen Monitor umgewandelt werden – bitte prüfen.` | `{{count}} regla heredada no pudo convertirse en un monitor; revísala.` | `{{count}} règle héritée n’a pas pu être convertie en moniteur — à vérifier.` | `{{count}} regola legacy non è stata convertita in un monitor: verificala.` | `{{count}} regra legada não pôde ser convertida em monitor — revise.` | `{{count}} eski kural bir monitöre dönüştürülemedi — inceleyin.` |
| `conversion.retirement.summary_other` | `{{count}} legacy rules could not be converted to monitors — review them.` | `{{count}} alte Regeln konnten nicht in Monitore umgewandelt werden – bitte prüfen.` | `{{count}} reglas heredadas no pudieron convertirse en monitores; revísalas.` | `{{count}} règles héritées n’ont pas pu être converties en moniteurs — à vérifier.` | `{{count}} regole legacy non sono state convertite in monitor: verificale.` | `{{count}} regras legadas não puderam ser convertidas em monitores — revise.` | `{{count}} eski kural monitörlere dönüştürülemedi — inceleyin.` |
| `conversion.retirement.review` | `Review` | `Prüfen` | `Revisar` | `Vérifier` | `Verifica` | `Revisar` | `İncele` |
| `conversion.retirement.dismiss` | `Dismiss` | `Ausblenden` | `Descartar` | `Ignorer` | `Ignora` | `Dispensar` | `Kapat` |
| `conversion.retirement.openAlertsNote` | `These rules no longer fire. Their open alerts stay open until someone resolves them; recreate the condition as a monitor if it is still needed.` | `Diese Regeln lösen nicht mehr aus. Ihre offenen Warnungen bleiben offen, bis jemand sie löst; legen Sie die Bedingung bei Bedarf als Monitor neu an.` | `Estas reglas ya no se disparan. Sus alertas abiertas siguen abiertas hasta que alguien las resuelva; vuelve a crear la condición como monitor si aún la necesitas.` | `Ces règles ne se déclenchent plus. Leurs alertes ouvertes le restent jusqu’à ce que quelqu’un les résolve ; recréez la condition sous forme de moniteur si elle est encore nécessaire.` | `Queste regole non scattano più. Gli avvisi aperti restano aperti finché qualcuno non li risolve; ricrea la condizione come monitor se serve ancora.` | `Estas regras não disparam mais. Os alertas abertos permanecem abertos até que alguém os resolva; recrie a condição como monitor se ainda for necessária.` | `Bu kurallar artık tetiklenmiyor. Açık uyarıları biri çözene kadar açık kalır; hâlâ gerekiyorsa koşulu bir monitör olarak yeniden oluşturun.` |
| `conversion.retirement.reasons.custom` | `custom condition` | `benutzerdefinierte Bedingung` | `condición personalizada` | `condition personnalisée` | `condizione personalizzata` | `condição personalizada` | `özel koşul` |
| `conversion.retirement.reasons.nested_group` | `nested condition group` | `verschachtelte Bedingungsgruppe` | `grupo de condiciones anidado` | `groupe de conditions imbriqué` | `gruppo di condizioni annidato` | `grupo de condições aninhado` | `iç içe koşul grubu` |
| `conversion.retirement.reasons.no_condition` | `no evaluable condition` | `keine auswertbare Bedingung` | `sin condición evaluable` | `aucune condition évaluable` | `nessuna condizione valutabile` | `sem condição avaliável` | `değerlendirilebilir koşul yok` |
| `conversion.retirement.reasons.equivalence_delta` | `conversion would change what fires on some devices` | `Umwandlung würde ändern, was auf einigen Geräten auslöst` | `la conversión cambiaría lo que se dispara en algunos dispositivos` | `la conversion changerait ce qui se déclenche sur certains appareils` | `la conversione cambierebbe cosa scatta su alcuni dispositivi` | `a conversão mudaria o que dispara em alguns dispositivos` | `dönüştürme bazı cihazlarda neyin tetikleneceğini değiştirirdi` |
| `conversion.retirement.reasons.escalation_policy_axis` | `escalation policy belongs to a single organization` | `Eskalationsrichtlinie gehört zu einer einzelnen Organisation` | `la política de escalamiento pertenece a una sola organización` | `la politique d’escalade appartient à une seule organisation` | `la policy di escalation appartiene a una sola organizzazione` | `a política de escalonamento pertence a uma única organização` | `yükseltme politikası tek bir kuruluşa ait` |
| `conversion.retirement.reasons.parent_unconverted` | `parent policy was not converted` | `übergeordnete Richtlinie wurde nicht umgewandelt` | `la política superior no se convirtió` | `la politique parente n’a pas été convertie` | `la policy padre non è stata convertita` | `a política pai não foi convertida` | `üst politika dönüştürülmedi` |
| `conversion.retirement.reasons.prerequisite_missing` | `a prerequisite fix is missing on this server` | `auf diesem Server fehlt eine vorausgesetzte Korrektur` | `falta una corrección previa en este servidor` | `un correctif préalable manque sur ce serveur` | `su questo server manca una correzione prerequisita` | `falta uma correção pré-requisito neste servidor` | `bu sunucuda ön koşul düzeltmesi eksik` |

(Any additional W05c1 reason code you find in `grep -rn "unconvertible:" apps/api/src/services/monitors/conversion/` gets a row in all 8 files; unknown codes fall back to the raw reason via `defaultValue`.)

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/routes/monitorDefinitions.conversion.pending.test.ts src/routes/monitorDefinitions.test.ts
pnpm --filter @breeze/web exec tsc --noEmit
cd apps/web && npx vitest run src/components/monitoring/conversion/ConversionPendingBanner.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/locales
```
(The last filter is the locale coverage suite; it must report the new keys translated in all 8 files.)

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/monitorDefinitions.ts apps/api/src/routes/monitorDefinitions.conversion.pending.test.ts apps/web/src/components/monitoring/conversion/ConversionPendingBanner.tsx apps/web/src/components/monitoring/conversion/ConversionPendingBanner.test.tsx apps/web/src/locales/*/monitoring.json
git commit -m "feat(monitors): pending endpoint lists unconvertible legacy rows and the sweep outcome; one-time review banner"
```

**PR1 ends here.** Run Task 14 (verification) for PR1 before opening it; PR body carries `Closes #<W05d sub-issue>` only on PR2.

---

### Task 6: `RETIRED_CONFIG_FEATURE_TYPES` — shared constants, API parity, retired links filtered out of every listing and resolver (PR2)

**Files:**
- Modify: `packages/shared/src/constants/configFeatureTypes.ts` (lines 22-30)
- Create: `packages/shared/src/constants/configFeatureTypes.test.ts`
- Modify: `packages/shared/src/constants/index.ts` (export the new names if it exports by name)
- Modify: `packages/shared/src/validators/index.ts` (line 568)
- Modify: `apps/api/src/services/configFeatureTypes.ts` (re-export)
- Modify: `apps/api/src/services/policyBaselineDefaults.ts` (lines 62-81), `policyBaselineDefaults.test.ts` (lines 87-91)
- Modify: `apps/api/src/routes/configurationPolicies/resolution.test.ts` (lines 13, 16)
- Modify: `apps/api/src/services/configurationPolicy.ts` (`listFeatureLinks` 1901-1905; link query in `resolveEffectiveConfigWithExecutor` 2394-2431; `PARTNER_LINKABLE_FEATURE_TYPES` 2650-2665; `validateFeaturePolicyExists` 2801-2835 and 2889-2897)
- Create: `apps/api/src/services/configurationPolicy.retiredFeatureTypes.test.ts`
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts` (POST `/:id/features` prologue), `featureLinks.test.ts`

**Interfaces:**
- Consumes: `configFeatureTypeEnum` (`db/schema/configurationPolicies.ts:32`, unchanged — the Postgres enum keeps both values).
- Produces:
  ```ts
  // packages/shared/src/constants/configFeatureTypes.ts
  export const CONFIG_FEATURE_TYPES = ['patch','backup','security','maintenance','compliance','automation','event_log','software_policy','sensitive_data','peripheral_control','warranty','helper','remote_access','pam','onedrive_helper','vulnerability','device_lifecycle','monitors'] as const;
  export const RETIRED_CONFIG_FEATURE_TYPES = ['alert_rule', 'monitoring'] as const;
  export type RetiredConfigFeatureType = typeof RETIRED_CONFIG_FEATURE_TYPES[number];
  export function isRetiredConfigFeatureType(value: unknown): value is RetiredConfigFeatureType;
  ```
  `addFeatureLinkSchema.featureType = z.enum(CONFIG_FEATURE_TYPES)`; `POST /configuration-policies/:id/features` with a retired `featureType` → `410 { error, hint, retiredFeatureType }`; `listFeatureLinks` and the effective-config resolver never return a retired link.

- [ ] **Step 1: Write the failing tests.** Create `packages/shared/src/constants/configFeatureTypes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CONFIG_FEATURE_TYPES, RETIRED_CONFIG_FEATURE_TYPES, isRetiredConfigFeatureType } from './configFeatureTypes';

describe('config feature types after the alerting consolidation (W05d)', () => {
  it('alert_rule and monitoring are retired, not canonical', () => {
    expect([...RETIRED_CONFIG_FEATURE_TYPES]).toEqual(['alert_rule', 'monitoring']);
    for (const t of RETIRED_CONFIG_FEATURE_TYPES) expect(CONFIG_FEATURE_TYPES as readonly string[]).not.toContain(t);
  });
  it('monitors stays canonical', () => { expect(CONFIG_FEATURE_TYPES).toContain('monitors'); });
  it('isRetiredConfigFeatureType narrows', () => {
    expect(isRetiredConfigFeatureType('alert_rule')).toBe(true);
    expect(isRetiredConfigFeatureType('monitors')).toBe(false);
    expect(isRetiredConfigFeatureType(undefined)).toBe(false);
  });
});
```
Replace `policyBaselineDefaults.test.ts:87-91` with:
```ts
describe('CONFIG_FEATURE_TYPES parity with DB enum (W05d: canonical ∪ retired)', () => {
  it('canonical plus retired matches configFeatureTypeEnum.enumValues exactly', () => {
    expect([...CONFIG_FEATURE_TYPES, ...RETIRED_CONFIG_FEATURE_TYPES].sort())
      .toEqual([...configFeatureTypeEnum.enumValues].sort());
  });
  it('the two lists are disjoint and retired types have no baseline entry', () => {
    const baseline = getPolicyBaselineDefaults().map((e) => e.featureType);
    for (const t of RETIRED_CONFIG_FEATURE_TYPES) {
      expect(CONFIG_FEATURE_TYPES as readonly string[]).not.toContain(t);
      expect(baseline).not.toContain(t);
    }
  });
});
```
Create `apps/api/src/services/configurationPolicy.retiredFeatureTypes.test.ts` (Drizzle mock in the style of `configurationPolicy.inheritance.test.ts`):
```ts
it('listFeatureLinks never returns a retired link even when the row exists', async () => {
  seedLinks([{ id: 'l1', configPolicyId: 'p1', featureType: 'alert_rule', inlineSettings: { items: [] } }, { id: 'l2', configPolicyId: 'p1', featureType: 'monitors', inlineSettings: { items: [] } }]);
  const links = await listFeatureLinks('p1');
  expect(links.map((l) => l.featureType)).toEqual(['monitors']);
  expect(whereSql()).toContain('feature_type');            // the filter is in SQL, not post-hoc
  expect(whereSql()).toMatch(/not in/i);
});
it('resolveEffectiveConfig omits retired feature types from features and chain', async () => {
  seedEffectiveRows([{ featureType: 'alert_rule', … }, { featureType: 'monitors', … }]);
  const out = await resolveEffectiveConfig('dev-1', auth);
  expect(Object.keys(out.features)).toEqual(['monitors']);
  expect(out.chain.flatMap((c) => [...c.featureTypes])).not.toContain('alert_rule');
});
it('PARTNER_LINKABLE_FEATURE_TYPES no longer lists alert_rule', () => {
  expect(PARTNER_LINKABLE_FEATURE_TYPES.has('alert_rule' as never)).toBe(false);
});
```
In `featureLinks.test.ts`:
```ts
it('POST /:id/features with a retired featureType is 410 with a pointer (W05d)', async () => {
  const res = await app.request('/configuration-policies/p1/features', { method: 'POST', headers: partnerAuthJson, body: JSON.stringify({ featureType: 'alert_rule', inlineSettings: { items: [] } }) });
  expect(res.status).toBe(410);
  expect(await res.json()).toEqual(expect.objectContaining({ retiredFeatureType: 'alert_rule', hint: expect.stringContaining('/monitor-definitions') }));
});
```

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd packages/shared && npx vitest run src/constants/configFeatureTypes.test.ts
cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts src/services/configurationPolicy.retiredFeatureTypes.test.ts src/routes/configurationPolicies/featureLinks.test.ts
```
Expected: `Failed to resolve import` (no `RETIRED_CONFIG_FEATURE_TYPES` export), then `expected ['alert_rule','monitors'] to deeply equal ['monitors']`, `expected 400 to be 410`.

- [ ] **Step 3: Implement.**

`packages/shared/src/constants/configFeatureTypes.ts` (replace lines 22-30 and append):
```ts
export const CONFIG_FEATURE_TYPES = [
  'patch', 'backup', 'security', 'maintenance',
  'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
  'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper',
  'vulnerability', 'device_lifecycle',
  // #5289 — monitor definitions attached to a policy. The singular
  // 'monitoring' (service/process watches) and 'alert_rule' were retired by
  // the alerting consolidation (W05d) — see RETIRED_CONFIG_FEATURE_TYPES.
  'monitors',
] as const;

export type ConfigFeatureType = typeof CONFIG_FEATURE_TYPES[number];

/**
 * Feature types retired by the alerting consolidation
 * (docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md,
 * W05d). The Postgres `config_feature_type` enum KEEPS these values: retired
 * feature-link rows and their child rows (config_policy_alert_rules,
 * config_policy_monitoring_watches) stay as alert history (spec C4). Nothing
 * authors, resolves, lists, delivers or renders them; the api parity test
 * asserts canonical ∪ retired == enum and the two are disjoint.
 */
export const RETIRED_CONFIG_FEATURE_TYPES = ['alert_rule', 'monitoring'] as const;
export type RetiredConfigFeatureType = typeof RETIRED_CONFIG_FEATURE_TYPES[number];
export function isRetiredConfigFeatureType(value: unknown): value is RetiredConfigFeatureType {
  return typeof value === 'string' && (RETIRED_CONFIG_FEATURE_TYPES as readonly string[]).includes(value);
}
```
`packages/shared/src/validators/index.ts:568` → `featureType: z.enum(CONFIG_FEATURE_TYPES),` with `import { CONFIG_FEATURE_TYPES } from '../constants/configFeatureTypes';` at the top (a pure leaf; no cycle). `apps/api/src/services/configFeatureTypes.ts` → `export { CONFIG_FEATURE_TYPES, RETIRED_CONFIG_FEATURE_TYPES, isRetiredConfigFeatureType, type ConfigFeatureType, type RetiredConfigFeatureType } from '@breeze/shared/constants';`. `policyBaselineDefaults.ts`: delete the `alert_rule` (line 64) and `monitoring` (line 67) rows of `NOT_ENFORCED`. `resolution.test.ts`: delete lines 13 and 16.

`configurationPolicy.ts`:
```ts
// listFeatureLinks (1901)
const links = await executor
  .select()
  .from(configPolicyFeatureLinks)
  .where(and(
    eq(configPolicyFeatureLinks.configPolicyId, configPolicyId),
    // W05d — retired link rows stay for history; no reader sees them.
    notInArray(configPolicyFeatureLinks.featureType, [...RETIRED_CONFIG_FEATURE_TYPES]),
  ));
```
In the link query inside `withDevicePartnerPolicyVisibility` (2426-2431) add the same predicate to the `.where(and(...))`:
```ts
    .where(and(
      sql`(${sql.join(targetConditions, sql` OR `)})`,
      notInArray(configPolicyEffectiveFeatureLinks.featureType, [...RETIRED_CONFIG_FEATURE_TYPES]),
      ...buildRoleOsFilterConditions(device),
    ))
```
`PARTNER_LINKABLE_FEATURE_TYPES` (2654): delete `'alert_rule',`. `validateFeaturePolicyExists`: delete `featureType === 'alert_rule' ||` (2804) and the `: featureType === 'alert_rule' ? { table: alertRules, label: 'Alert rule' }` arm (2826-2827); delete `featureType === 'monitoring' ||` (2890). Drop the `alertRules` import if tsc reports it unused. Import `RETIRED_CONFIG_FEATURE_TYPES` from `./configFeatureTypes` and `notInArray` from `drizzle-orm`.

`routes/configurationPolicies/featureLinks.ts` — before the POST's `zValidator('json', addFeatureLinkSchema)`:
```ts
export const RETIRED_FEATURE_TYPE_GONE = (featureType: string) => ({
  error: `Feature type "${featureType}" was retired by the alerting consolidation.`,
  hint: 'Author the condition as a monitor (POST /monitor-definitions) and attach it to the policy through the "monitors" feature link.',
  retiredFeatureType: featureType,
});
const rejectRetiredFeatureType = async (c: Context, next: Next) => {
  const body = await c.req.raw.clone().json().catch(() => null);
  const ft = (body as { featureType?: unknown } | null)?.featureType;
  if (isRetiredConfigFeatureType(ft)) return c.json(RETIRED_FEATURE_TYPE_GONE(ft), 410);
  await next();
};
featureLinkRoutes.post('/:id/features', requireScope(…), requireConfigPolicyWrite, rejectRetiredFeatureType, zValidator('json', addFeatureLinkSchema), async (c) => { … });
```
(PATCH takes no `featureType`; a PATCH on an existing retired link cannot happen because `listFeatureLinks` never surfaces its id — and `updateFeatureLink` refuses it in Task 7.)

- [ ] **Step 4: Run, expect PASS.**
```bash
cd packages/shared && npx vitest run src/constants/configFeatureTypes.test.ts src/validators/index_configpolicy.test.ts
pnpm --filter @breeze/api exec tsc --noEmit     # expect errors ONLY in files Tasks 7, 8, 12 delete/modify — list them; nothing else may appear
cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts src/services/configurationPolicy.retiredFeatureTypes.test.ts src/routes/configurationPolicies/resolution.test.ts src/routes/configurationPolicies/featureLinks.test.ts src/services/configurationPolicy.inheritance.test.ts
```
The web build is red from here until Task 11 (its `Record<FeatureType, …>` maps still name the retired keys) — expected; PR2 is one branch.

- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/constants/configFeatureTypes.ts packages/shared/src/constants/configFeatureTypes.test.ts packages/shared/src/constants/index.ts packages/shared/src/validators/index.ts apps/api/src/services/configFeatureTypes.ts apps/api/src/services/policyBaselineDefaults.ts apps/api/src/services/policyBaselineDefaults.test.ts apps/api/src/routes/configurationPolicies/resolution.test.ts apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.retiredFeatureTypes.test.ts apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts
git commit -m "feat(shared,api): retire alert_rule and monitoring feature types; retired links filtered from every reader"
```

---

### Task 7: Delete the `alert_rule` / `monitoring` service arms, the inline-rule test route and the legacy policy resolvers (PR2)

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` — delete `decomposeInlineSettings` arms `case 'alert_rule'` (756-790) and `case 'monitoring'` (907-935); `assertDecomposableInlineSettings` arms (1165-1167, 1171-1173); `deleteNormalizedRows` arms (1198-1199, 1219-1233); `assembleInlineSettings` arms (1271-1291, 1430-1465); imports `alertRuleInlineSettingsSchema`, `monitoringInlineSettingsSchema`, `configPolicyAlertRules`, `configPolicyMonitoringWatches` if unused after; `updateFeatureLink` (1752) refuses a retired link.
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts` — delete the `alert_rule`/`monitoring` validation blocks (273-300, 517-535) and `findOfflineDurationViolation` (+ its module if separate: `grep -rn findOfflineDurationViolation apps/api/src`).
- Delete: `apps/api/src/routes/configurationPolicies/alertRuleTest.ts` (+ its tests: `ls apps/api/src/routes/configurationPolicies/alertRuleTest*.test.ts`); `testConfigPolicyAlertRuleSchema` in `routes/configurationPolicies/schemas.ts:15` and in `packages/shared/src/validators` (grep); mount at `routes/configurationPolicies/index.ts:5,19`.
- Modify: `apps/api/src/services/featureConfigResolver.ts` — delete `GoverningAlertRulePolicy` (257-296), `resolveGoverningAlertRulePolicyForDevice` (298-377), `resolveAlertRulesForDevice` (379-441) and now-unused imports.
- Modify: `apps/api/src/services/featureLinkReaders.contract.test.ts` (if it lists `alertRuleTest.ts` or the resolver; grep).
- Modify/delete tests: `configurationPolicy.*.test.ts` cases that drive the two arms; `featureLinks.test.ts` alert_rule/monitoring cases; `featureConfigResolver.test.ts` alert-rule cases.

**Interfaces:**
- Consumes: Task 6's `isRetiredConfigFeatureType`.
- Produces: `updateFeatureLink(linkId, …)` throws `Error('Feature link <id> is retired (alert_rule); it cannot be edited')` → route maps to 410 with `RETIRED_FEATURE_TYPE_GONE`; no code path parses `alertRuleInlineSettingsSchema` / `monitoringInlineSettingsSchema` in the service or routes.

- [ ] **Step 1: Write the failing tests.** In `configurationPolicy.retiredFeatureTypes.test.ts` (Task 6 file):
```ts
it('updateFeatureLink refuses a retired link instead of re-decomposing it', async () => {
  seedLinkById('l-legacy', { featureType: 'alert_rule', configPolicyId: 'p1' });
  await expect(updateFeatureLink('l-legacy', 'p1', { inlineSettings: { items: [] } }, auth)).rejects.toThrow(/retired/);
  expect(tx.delete).not.toHaveBeenCalled();
});
it('assembleInlineSettings has no arm for retired types (falls to default → null)', async () => {
  seedLinks([{ id: 'l1', configPolicyId: 'p1', featureType: 'monitors', inlineSettings: { items: [] } }]);
  await listFeatureLinks('p1');
  expect(selectFromTables()).not.toContain(configPolicyAlertRules);
  expect(selectFromTables()).not.toContain(configPolicyMonitoringWatches);
});
```
In `featureLinks.test.ts`, delete the "offline duration exceeds horizon" and "invalid monitoring settings" cases and add:
```ts
it('PATCH on a retired link is 410', async () => {
  updateFeatureLinkMock.mockRejectedValueOnce(new Error('Feature link l-legacy is retired (alert_rule); it cannot be edited'));
  const res = await app.request('/configuration-policies/p1/features/l-legacy', { method: 'PATCH', headers: partnerAuthJson, body: JSON.stringify({ inlineSettings: {} }) });
  expect(res.status).toBe(410);
});
```
A contract test that the routes tree no longer mounts the inline-rule test endpoint — in `apps/api/src/routes/configurationPolicies/index.test.ts` (create if absent):
```ts
it('POST /:id/alert-rules/test is gone (W05d)', async () => {
  const res = await app.request('/configuration-policies/p1/alert-rules/test', { method: 'POST', headers: partnerAuthJson, body: '{}' });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/services/configurationPolicy.retiredFeatureTypes.test.ts src/routes/configurationPolicies/featureLinks.test.ts src/routes/configurationPolicies/index.test.ts
```
Expected: `promise resolved instead of rejecting`, `expected 200 to be 410`, `expected 200 to be 404`.

- [ ] **Step 3: Implement.** Delete the arms listed under **Files** (each `case` block in full, including its comments). In `updateFeatureLink` (1752), after the existing link lookup:
```ts
  if (isRetiredConfigFeatureType(existing.featureType)) {
    throw new Error(`Feature link ${linkId} is retired (${existing.featureType}); it cannot be edited`);
  }
```
and in the PATCH route's catch, map that message to `c.json(RETIRED_FEATURE_TYPE_GONE(existingLink.featureType), 410)` (the route already reads `existingLink.featureType` at 517/530 — reuse that read, then delete the two validation blocks). `git rm apps/api/src/routes/configurationPolicies/alertRuleTest.ts` and its tests; remove the import and mount (`index.ts:5,19`); delete `testConfigPolicyAlertRuleSchema` from `schemas.ts:15` and from `packages/shared/src/validators/index.ts` (grep; delete its zod object). In `featureConfigResolver.ts` delete lines 257-441 (the two exports and the type) and the `configPolicyAlertRules` import if unused. `alertService.ts:28` still imports `resolveAlertRulesForDevice` — Task 8 deletes that import; until then tsc is red on exactly that line (note it in the Task 7 commit body).

- [ ] **Step 4: Run, expect PASS.**
```bash
cd apps/api && npx vitest run src/services/configurationPolicy src/routes/configurationPolicies src/services/featureConfigResolver.test.ts src/services/featureLinkReaders.contract.test.ts
pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | grep -v "alertService.ts(28\|alertService.ts(12[0-9][0-9]\|alertService.ts(13[0-9][0-9]\|alertService.ts(14[0-9][0-9]" ; # only Task 8's file may remain red
```

- [ ] **Step 5: Commit.**
```bash
git add -A apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.retiredFeatureTypes.test.ts apps/api/src/routes/configurationPolicies apps/api/src/services/featureConfigResolver.ts apps/api/src/services/featureConfigResolver.test.ts apps/api/src/services/featureLinkReaders.contract.test.ts packages/shared/src/validators/index.ts
git commit -m "refactor(api): delete alert_rule/monitoring decompose/assemble/validate arms, the inline-rule test route and the legacy policy resolvers"
```

---

### Task 8: Delete the second evaluation sweep and the config-policy cooldown branches (PR2)

**Files:**
- Modify: `apps/api/src/services/alertService.ts` — delete `ConfigPolicyAlertRule` + `getApplicableRulesFromPolicy` (1193-1230), `evaluateDeviceAlertsFromPolicy` (1232-1372), `checkAutoResolveFromConfigPolicy` (1374-~1480, through the end of its function); the `resolveAlert` config-policy cooldown branch (742-756: keep the `else if (alert.ruleId)` body as the only branch); imports at 21 (`configPolicyAlertRules`), 27 (`isConfigPolicyRuleCooling`, `markConfigPolicyRuleCooldown`), 28 (`resolveAlertRulesForDevice`); the comment at 816.
- Modify: `apps/api/src/services/alertCooldown.ts` — delete lines 290-360 (`CONFIG_POLICY_COOLDOWN_PREFIX`, `buildConfigPolicyCooldownKey`, `isConfigPolicyRuleCooling`, `markConfigPolicyRuleCooldown`); **keep** the `':cpar:'` exclusion at 478 with a comment that stale keys expire on their own TTL.
- Modify: `apps/api/src/jobs/alertWorker.ts` — imports 13-18; `processEvaluateDevice` (254-275); `processCheckAutoResolve` (300-330); `isRelationNotFoundError`/`_configPolicyTableWarningLogged` (31-38) if unused after.
- Modify: `apps/api/src/jobs/offlineDetector.ts` — import 16; delete `triggerConfigPolicyOfflineAlerts` (476-520); `triggerOfflineAlerts` (522-…): drop the `configPolicyResult` uses (541-542, 566-568 and the later `fatalError` re-throw); `_configPolicyTableWarningLogged`/`isRelationNotFoundError` (83-90) if unused.
- Modify: `apps/api/src/services/offlineAlertEffects.ts` — import 5 (keep `alertRuleOwnershipConditionForOrg`), delete 49-50; `prepareRule` (61-70): `rule.policy` is always false now — remove the `policy` discriminator from `OfflineRulePlan` and the `configPolicyAlertRules` table switch. **Coordinate with #6342:** that fix added monitor resolution here; keep it, delete only the `getApplicableRulesFromPolicy` half.
- Modify: `apps/api/src/routes/alerts/alerts.ts` (import 22; delete 1082-1088), `apps/api/src/routes/mobile.ts` (import 23; delete 1251-1256).
- Tests: delete `apps/api/src/jobs/offlineDetector_configPolicy.test.ts`; modify `alertWorker.test.ts`, `alertQueue.test.ts`, `offlineDetector.dbcontext.test.ts`, `offlineDetector_reeval.test.ts`, `alertService.test.ts`, `alertService.autoResolveOutcome.test.ts`, `alertService.resolveCas.test.ts`, `routes/alerts/alerts.test.ts`, `alerts.resolveCas.test.ts`, `routes/mobile.resolveCas.test.ts`, `mobile.ackCas.test.ts`, `__tests__/multi-tenant-isolation.test.ts` (the grep list in Ordering assumptions) — every mock of a deleted export goes; every "config policy branch" case is replaced by one asserting the branch is absent.

**Interfaces:**
- Consumes: nothing new.
- Produces: `evaluateDeviceAlerts` is the only device sweep; `checkAllAutoResolve` the only auto-resolve; `alertCooldown.ts` exports no `cpar` functions; `alerts.config_policy_id` is read only by history/detail views (`routes/alerts/alerts.ts` GET paths, `alertService.createSourcedAlert` no longer writes it).

- [ ] **Step 1: Write the failing tests.** `alertWorker.test.ts`:
```ts
it('evaluate-device runs exactly one sweep (W05d)', async () => {
  evaluateDeviceAlertsMock.mockResolvedValue(['a1']);
  const out = await processJob({ type: 'evaluate-device', deviceId: 'd1', orgId: 'o1' });
  expect(out.alertsCreated).toBe(1);
  expect(alertServiceModule).not.toHaveProperty('evaluateDeviceAlertsFromPolicy');
  expect(alertServiceModule).not.toHaveProperty('checkAutoResolveFromConfigPolicy');
});
it('check-auto-resolve no longer queries alerts by config_policy_id', async () => {
  await processJob({ type: 'check-auto-resolve', orgId: 'o1' });
  expect(dbSelectMock).not.toHaveBeenCalled();           // the per-device config-policy loop is gone
  expect(checkAllAutoResolveMock).toHaveBeenCalledWith('o1');
});
```
`alertService.resolveCas.test.ts`: replace the "sets the config policy cooldown on resolve" case with:
```ts
it('resolving a legacy config-policy alert sets no cooldown (history-only, W05d)', async () => {
  seedAlert({ id: 'a1', ruleId: null, configPolicyId: 'cpar-1', deviceId: 'd1' });
  await resolveAlert('a1', { … });
  expect(setCooldownMock).not.toHaveBeenCalled();
  expect(Object.keys(alertCooldownModule)).not.toContain('markConfigPolicyRuleCooldown');
});
```
`offlineDetector_reeval.test.ts`: the "config policy offline alerts" case becomes "triggerOfflineAlerts evaluates standalone offline rules only and never imports the policy evaluator". `routes/alerts/alerts.resolveCas.test.ts` / `mobile.resolveCas.test.ts`: the `configPolicyId` cooldown case asserts no cooldown call.

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/jobs/alertWorker.test.ts src/services/alertService.resolveCas.test.ts src/jobs/offlineDetector_reeval.test.ts src/routes/alerts/alerts.resolveCas.test.ts src/routes/mobile.resolveCas.test.ts
```
Expected: `expected {…} not to have property "evaluateDeviceAlertsFromPolicy"`, `expected "spy" not to be called`.

- [ ] **Step 3: Implement.** `alertWorker.ts` `processEvaluateDevice` (254-275) becomes:
```ts
  try {
    const alertIds = await evaluateDeviceAlerts(data.deviceId);
    if (alertIds.length > 0) {
      console.log(`[AlertWorker] Created ${alertIds.length} alerts for device ${data.deviceId}`);
    }
    return { deviceId: data.deviceId, alertsCreated: alertIds.length, durationMs: Date.now() - startTime };
  } catch (error) {
```
`processCheckAutoResolve` (300-330): keep only `const resolvedCount = await checkAllAutoResolve(data.orgId);` and the log. Imports (13-18): `evaluateDeviceAlerts, checkAllAutoResolve` only; drop `alerts`, `isNotNull` if unused.

`offlineDetector.ts`: delete `triggerConfigPolicyOfflineAlerts`; in `triggerOfflineAlerts` replace lines 541-542 with `let alertCreated = false;` and delete the `configPolicyResult.fatalError` throws (566-568 and any later one); doc comment (522-535) becomes "Evaluates legacy standalone `alertRules` with offline conditions. Config-policy inline rules were retired (W05d); monitors of kind `offline` fire through `offlineAlertEffects` (#6342)."

`offlineAlertEffects.ts`: delete lines 49-50; `OfflineRulePlan` loses `policy`; `prepareRule`'s `const table = rule.policy ? configPolicyAlertRules : alertRules;` becomes `alertRules` and the `if (rule.policy) { maintenance … }` block is deleted (the standalone path never honoured maintenance here — unchanged behaviour). Keep #6342's monitor branch untouched.

`alertService.ts`: delete the three functions and the type; `resolveAlert` (742-756):
```ts
  // Set a cooldown after resolution so the condition must persist beyond the
  // window before a new alert is created. Legacy config-policy alerts
  // (config_policy_id set, rule_id null) are history-only since W05d: nothing
  // evaluates their source, so no cooldown is written for them.
  if (alert.ruleId) {
    const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, alert.ruleId)).limit(1);
    …existing body…
  }
```
`routes/alerts/alerts.ts` 1082-1088 and `routes/mobile.ts` 1251-1256: delete the `else if (alert.configPolicyId) { … }` branch; drop `markConfigPolicyRuleCooldown` from the imports (22 / 23). `alertCooldown.ts`: delete 290-360; at 478:
```ts
    // ':cpar:' keys were written by the retired config-policy evaluator (W05d);
    // none are written any more and the survivors expire on their own TTL.
    const filteredKeys = keys.filter(k => !k.includes(':adaptive:') && !k.includes(':cpar:'));
```

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/jobs/alertWorker src/jobs/alertQueue.test.ts src/jobs/offlineDetector src/services/alertService src/services/alertCooldown src/services/offlineAlertEffects src/routes/alerts/alerts src/routes/mobile src/__tests__/multi-tenant-isolation.test.ts
grep -rn "evaluateDeviceAlertsFromPolicy\|getApplicableRulesFromPolicy\|checkAutoResolveFromConfigPolicy\|isConfigPolicyRuleCooling\|markConfigPolicyRuleCooldown\|resolveAlertRulesForDevice" apps/api/src   # must print nothing
```

- [ ] **Step 5: Commit.**
```bash
git add -A apps/api/src/services/alertService.ts apps/api/src/services/alertCooldown.ts apps/api/src/jobs/alertWorker.ts apps/api/src/jobs/offlineDetector.ts apps/api/src/services/offlineAlertEffects.ts apps/api/src/routes/alerts/alerts.ts apps/api/src/routes/mobile.ts apps/api/src/jobs apps/api/src/services apps/api/src/routes/alerts apps/api/src/routes/mobile.resolveCas.test.ts apps/api/src/routes/mobile.ackCas.test.ts apps/api/src/__tests__/multi-tenant-isolation.test.ts
git commit -m "refactor(api): delete evaluateDeviceAlertsFromPolicy and the config-policy cooldown/auto-resolve paths — one sweep"
```

---

### Task 9: Remove the transitional legacy delivery override (PR2)

**Files:**
- Modify: `apps/api/src/services/delivery/resolveDelivery.ts` (W05b: `DeliverySource` union, `ResolveDeliveryInput.legacyOverride`, precedence step 3)
- Modify: `apps/api/src/services/delivery/resolveDelivery.test.ts` (W05b cases at plan lines ~523-536)
- Modify: `apps/api/src/services/notificationDispatcher.ts` (W05b's `legacyOverride` construction — the `alert.ruleId` unmanaged branch and the `alert.configPolicyId` branch — and the `legacyOverride` argument to `resolveDelivery`)
- Modify: `apps/api/src/services/notificationDispatcher.test.ts` (+ `notificationDispatcher.*.test.ts` siblings that seed `configPolicyAlertRules` or `overrideSettings.notificationChannelIds`)
- Modify: `apps/api/src/routes/alerts/delivery.ts` (W05b preview endpoint) only if it accepted a `legacyOverride`-shaped query (it should not; verify with grep).

**Interfaces:**
- Consumes: W05b `resolveDelivery`.
- Produces: `DeliverySource = 'monitor_none' | 'monitor_channels' | 'routing_rule' | 'default_row' | 'none'`; `ResolveDeliveryInput` has no `legacyOverride`; the dispatcher passes `{ orgId, severity, monitorId, kind, siteId }` only. An unmanaged, unretired `alert_rules` row (a standalone rule nobody converted) now routes through routing rows like every other non-monitor alert — this is the one behaviour change and it is in the release notes (Task 13).

- [ ] **Step 1: Write the failing tests.** In `resolveDelivery.test.ts`, delete the three `legacy_override` cases and add:
```ts
it('has no legacy override step (W05d): an input carrying one is a type error and, at runtime, ignored', async () => {
  seedRoutingRows([{ id: 'r1', channelIds: [CH_ORG], severities: ['high'], isDefault: false, orgId: ORG }]);
  // @ts-expect-error legacyOverride was removed in W05d
  const out = await resolveDelivery({ orgId: ORG, severity: 'high', legacyOverride: { channelIds: [CH_LEGACY] } });
  expect(out).toEqual({ channelIds: [CH_ORG], escalationPolicyId: null, source: 'routing_rule', routingRuleId: 'r1', routingRuleName: expect.any(String) });
});
it('DeliverySource no longer includes legacy_override', () => {
  const s: DeliverySource = 'routing_rule';
  // @ts-expect-error removed in W05d
  const bad: DeliverySource = 'legacy_override';
  expect([s, bad]).toBeDefined();
});
```
In `notificationDispatcher.test.ts`: the "config-policy alert uses the rule's notification_channel_ids" and "unmanaged rule overrides win over routing" cases become "an alert with config_policy_id and no monitor resolves through routing rows; config_policy_alert_rules is never queried":
```ts
expect(selectFromTables()).not.toContain(configPolicyAlertRules);
expect(resolveDeliveryMock).toHaveBeenCalledWith(expect.not.objectContaining({ legacyOverride: expect.anything() }));
```

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/services/delivery/resolveDelivery.test.ts src/services/notificationDispatcher.test.ts
```
Expected: tsc-in-vitest error `Unused '@ts-expect-error' directive` and `expected { source: 'legacy_override' … }`.

- [ ] **Step 3: Implement.** `resolveDelivery.ts`: remove `'legacy_override'` from `DeliverySource`; remove `legacyOverride` from `ResolveDeliveryInput`; delete step 3 (the `legacyChannels`/`legacyEscalation` block); renumber the comment ladder (1 monitor none → 2 monitor channels → 3 routing rows → 4 org default → 5 partner default → 6 none) and the file header. Escalation: `escalationPolicyId: monitorEscalation ?? row.escalationPolicyId ?? null` stays. `notificationDispatcher.ts`: delete the `legacyOverride` variable, the `if (!rule.managedByMonitorId) { … }` block inside the `alert.ruleId` branch (keep `monitorId = monitorId ?? rule.managedByMonitorId ?? null`), the whole `else if (alert.configPolicyId) { … }` branch, and the `legacyOverride` property in the `resolveDelivery({...})` call; drop the `configPolicyAlertRules` import. `grep -n "legacyOverride\|legacy_override" apps/api/src` must print nothing.

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/services/delivery src/services/notificationDispatcher src/routes/alerts/delivery
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryResolution.integration.test.ts   # W05b's dispatch-vs-preview parity suite; name per W05b plan
```

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/services/delivery/resolveDelivery.ts apps/api/src/services/delivery/resolveDelivery.test.ts apps/api/src/services/notificationDispatcher.ts apps/api/src/services/notificationDispatcher.test.ts
git commit -m "refactor(delivery): remove the transitional legacy override from resolveDelivery and the dispatcher"
```

---

### Task 10: Legacy write routers → 410 Gone, reads retained (PR2)

**Files:**
- Create: `apps/api/src/routes/legacyAlertingGone.ts`
- Modify: `apps/api/src/routes/alerts/rules.ts` — `POST /rules` (272-477), `PUT /rules/:id` (479-729), `DELETE /rules/:id` (731-806), `POST /rules/:id/test` (808-~900) replaced; `createAlertRuleSchema`/`updateAlertRuleSchema`/`testAlertRuleSchema` imports and helpers used only by them deleted (`canAccessRuleTargets` stays if a GET uses it — grep).
- Modify: `apps/api/src/routes/alertTemplates/templates.ts` — `POST /templates` (215-320), `PATCH /templates/:id` (353-431), `DELETE /templates/:id` (433-486) replaced; `createTemplateSchema`/`updateTemplateSchema` imports deleted; `assertTemplateWriteAccess`-style helpers (95-108) deleted if unused.
- Modify: `apps/api/src/routes/alertTemplates/rules.ts` — `POST /rules` (128-227), `PATCH /rules/:id` (261-360), `DELETE /rules/:id` (362-417), `POST /rules/:id/toggle` (419-491) replaced.
- Modify: `apps/api/src/routes/alertTemplates/schemas.ts`, `apps/api/src/routes/alerts/schemas.ts` — delete the write schemas that no longer have a consumer (grep each name across `apps/api/src` first; `packages/shared` validators stay).
- Tests: `routes/alerts/rules.managedByMonitor.test.ts`, `rules.authz.test.ts`, `rules.testVerdict.test.ts` (delete — it tested `POST /rules/:id/test`), `rules.conditionTypes.test.ts` (delete the POST cases), `alertTemplates/templates.managedByMonitor.test.ts`, `templates.guard.test.ts`, `templates.authz.test.ts`, `alertTemplates/rules.managedByMonitor.test.ts`, `rules.authz.test.ts`, `conditionTypes.test.ts` — write cases assert 410; read cases (`rules.list.test.ts`, `rules.siteScope.test.ts`, `templates.scope.test.ts`, `templates.siteScope.test.ts`, `siteScope.test.ts`) unchanged.

**Interfaces:**
- Consumes: `requireScope`, `requireAlertWrite`, `requireMfa` (existing middleware on each replaced route — kept so an unauthenticated caller still gets 401, not 410).
- Produces:
  ```ts
  // apps/api/src/routes/legacyAlertingGone.ts
  export const LEGACY_ALERTING_GONE = {
    error: 'This endpoint was retired by the alerting consolidation.',
    message: 'Alert conditions are authored as monitors. Create, update and delete through /api/v1/monitor-definitions; attach a monitor to a configuration policy through its "monitors" feature link. Read endpoints for legacy rows remain for alert history.',
    docs: 'https://docs.breezermm.com/features/monitors/',
  } as const;
  export const legacyAlertingGone = (c: Context) => c.json(LEGACY_ALERTING_GONE, 410);
  ```
  Every `POST|PUT|PATCH|DELETE` under `/alerts/rules*` and `/alert-templates/templates*`, `/alert-templates/rules*` returns 410 with that body after auth + scope + write-permission + MFA middleware. `GET`s are untouched. `/alert-templates/correlations*` (correlation rules — a different object, not an alert-authoring surface) is untouched.

- [ ] **Step 1: Write the failing tests.** Rewrite `routes/alerts/rules.managedByMonitor.test.ts` (its three cases all exercised writes) into `rules.gone.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { app, partnerAuthJson } from './testApp';   // the file's existing app/auth fixtures
import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';

describe('legacy /alerts/rules writes are 410 (W05d)', () => {
  it.each([
    ['POST', '/alerts/rules'],
    ['PUT', '/alerts/rules/00000000-0000-0000-0000-000000000001'],
    ['DELETE', '/alerts/rules/00000000-0000-0000-0000-000000000001'],
    ['POST', '/alerts/rules/00000000-0000-0000-0000-000000000001/test'],
  ])('%s %s', async (method, path) => {
    const res = await app.request(path, { method, headers: partnerAuthJson, body: method === 'DELETE' ? undefined : '{}' });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(LEGACY_ALERTING_GONE);
  });
  it('still 401s without a token (middleware precedes the 410)', async () => {
    const res = await app.request('/alerts/rules', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
  it('GET /alerts/rules still lists (reads retained)', async () => {
    const res = await app.request('/alerts/rules?limit=1', { headers: partnerAuthJson });
    expect(res.status).toBe(200);
  });
});
```
Same shape for `alertTemplates/templates.gone.test.ts` (`POST /alert-templates/templates`, `PATCH|DELETE /alert-templates/templates/:id`) and `alertTemplates/rules.gone.test.ts` (`POST /alert-templates/rules`, `PATCH|DELETE /alert-templates/rules/:id`, `POST /alert-templates/rules/:id/toggle`), plus one case that `GET /alert-templates/correlations` is unaffected.

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/routes/alerts/rules.gone.test.ts src/routes/alertTemplates/templates.gone.test.ts src/routes/alertTemplates/rules.gone.test.ts
```
Expected: `Failed to resolve import "../legacyAlertingGone"`, then `expected 400 to be 410` (zod rejects `{}` before any handler today).

- [ ] **Step 3: Implement.** Create `legacyAlertingGone.ts` as in **Interfaces** (`import type { Context } from 'hono'`). Replace each route body, keeping its middleware chain and dropping the `zValidator` (a 410 must not depend on the body parsing):
```ts
// routes/alerts/rules.ts — replaces 272-477, 479-729, 731-806, 808-~900
rulesRoutes.post('/rules', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
rulesRoutes.put('/rules/:id', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
rulesRoutes.delete('/rules/:id', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
rulesRoutes.post('/rules/:id/test', requireScope('organization', 'partner', 'system'), requireAlertRead, legacyAlertingGone);
```
```ts
// routes/alertTemplates/templates.ts — replaces 215-320, 353-431, 433-486
templateRoutes.post('/templates', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
templateRoutes.patch('/templates/:id', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
templateRoutes.delete('/templates/:id', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
```
```ts
// routes/alertTemplates/rules.ts — replaces 128-227, 261-360, 362-417, 419-491
ruleRoutes.post('/rules', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
ruleRoutes.patch('/rules/:id', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
ruleRoutes.delete('/rules/:id', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
ruleRoutes.post('/rules/:id/toggle', requireScope('organization', 'partner', 'system'), requireAlertWrite, requireMfa(), legacyAlertingGone);
```
Keep the exact middleware each route had on `main` (the lines quoted above are what `rules.ts:272-277`, `templates.ts:215-220`, `alertTemplates/rules.ts:128-133, 419-424` carry today). Then delete the now-unreferenced helpers, schemas and imports until `tsc` and `eslint` are clean. **Do not touch** `monitorCompiler.ts` — compiled monitors write `alert_rules`/`alert_templates` through the service, not these routes (spec §Non-goals).

Also delete the web-side writer that only these routes served: `apps/web/src/components/alerts/AlertRuleForm.tsx`, `AlertRuleForm.retiredCondition.test.tsx`, and its export in `components/alerts/index.ts` (nothing imports it after W05a; `grep -rn "AlertRuleForm" apps/web/src` must print nothing afterwards).

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/routes/alerts/rules src/routes/alertTemplates src/routes/alerts/helpers
pnpm --filter @breeze/api exec eslint src/routes/alerts/rules.ts src/routes/alertTemplates/templates.ts src/routes/alertTemplates/rules.ts
```

- [ ] **Step 5: Commit.**
```bash
git add -A apps/api/src/routes/legacyAlertingGone.ts apps/api/src/routes/alerts apps/api/src/routes/alertTemplates apps/web/src/components/alerts
git commit -m "feat(api): legacy alert rule and template write endpoints return 410 Gone; reads retained"
```

---

### Task 11: Web — delete the policy Alerts / Service & Process tabs and `/alerts/rules`; hash aliases; parity tests; i18n (PR2)

**Files:**
- Delete: `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx`, `AlertRuleTab.test.tsx`, `AlertRuleTab.testVerdict.test.tsx`, `AlertRuleTestModal.tsx`, `MonitoringTab.tsx`, `MonitoringTab.test.tsx`
- Delete: `apps/web/src/components/monitoring/LegacyRulesPage.tsx`, `LegacyRulesPage.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts` (lines 61, 65)
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (imports; icons 112, 123; `VALID_TABS` 140-148; `useHashTab` 158-170; render cases 432, 442)
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts`
- Modify: `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx` (lines 120, 127), `DeviceEffectiveConfigTab.featureParity.test.ts`
- Modify: `apps/web/src/pages/alerts/rules/index.astro`, `new.astro`, `[id].astro`
- Modify: `apps/web/src/components/alerts/AlertsTabStrip.tsx` (lines 10, 46), `AlertsTabStrip.test.tsx` (lines 26-37)
- Modify: `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` only if it lists `/alerts/rules` (grep)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/policies.json` (remove `…alertRuleTab` block, en 201-266, and `…monitoringTab` block, en 799-837), `pages.json` (`titles.alertsRules`, line 32), `alerts.json` (`alertsTabStrip.tabs.rules`, en 622; `list.*` block at en ~370-378 if only `LegacyRulesPage` read it — grep each key)

**Interfaces:**
- Consumes: Task 6's `CONFIG_FEATURE_TYPES` / `RETIRED_CONFIG_FEATURE_TYPES` (from `@breeze/shared`); `useHashTab` (`lib/useHashState.ts:77`).
- Produces: `FEATURE_META` and `featureTabIcons` keyed by the new `FeatureType`; `LEGACY_TAB_ALIASES: Record<'alert_rule' | 'monitoring', 'monitors'>` exported from `ConfigPolicyDetailPage.tsx`; a deep link to `#alert_rule` / `#monitoring` lands on `#monitors` with the URL rewritten via `history.replaceState`; `/alerts/rules`, `/alerts/rules/new`, `/alerts/rules/:id` → `301 /alerts/monitors`; `AlertsTabStrip` shows Alerts · Correlations · Monitors · Delivery (W05b already replaced Channels with Delivery — keep its list; only the Rules entry goes).

- [ ] **Step 1: Write the failing tests.** `featureTypeParity.test.ts` — replace the last case with:
```ts
it('every canonical type has a tab and no retired type does (W05d)', () => {
  expect([...EDITOR_EXCLUDED_FEATURE_TYPES]).toEqual([]);
  expect(Object.keys(FEATURE_META).sort()).toEqual([...CONFIG_FEATURE_TYPES].sort());
  for (const retired of RETIRED_CONFIG_FEATURE_TYPES) {
    expect(FEATURE_META).not.toHaveProperty(retired);
    expect(FEATURE_TYPES as readonly string[]).not.toContain(retired);
  }
});
it('legacy hashes alias to the monitors tab', () => {
  expect(LEGACY_TAB_ALIASES).toEqual({ alert_rule: 'monitors', monitoring: 'monitors' });
  for (const k of Object.keys(LEGACY_TAB_ALIASES)) expect(RETIRED_CONFIG_FEATURE_TYPES).toContain(k);
});
```
`DeviceEffectiveConfigTab.featureParity.test.ts` — add:
```ts
it('renders no retired feature type (W05d)', () => {
  for (const retired of RETIRED_CONFIG_FEATURE_TYPES) expect(ALL_FEATURE_TYPES as readonly string[]).not.toContain(retired);
});
```
`ConfigPolicyDetailPage.test.tsx` — add (follow the file's existing render/mocks; `window.location.hash` is settable in jsdom):
```tsx
it.each(['#alert_rule', '#monitoring'])('deep link %s lands on the Monitors tab and rewrites the hash', async (hash) => {
  window.location.hash = hash;
  const replace = vi.spyOn(window.history, 'replaceState');
  render(<ConfigPolicyDetailPage policyId="p1" />);
  expect(await screen.findByRole('tab', { name: /monitors/i, selected: true })).toBeInTheDocument();
  expect(replace).toHaveBeenCalledWith(expect.anything(), '', expect.stringMatching(/#monitors$/));
  expect(window.location.hash).toBe('#monitors');
});
```
`AlertsTabStrip.test.tsx` — delete the `Regras`/`Rules` expectations (lines 30, 33-37) and add:
```tsx
it('has no Rules tab (W05d)', () => {
  render(<AlertsTabStrip />);
  expect(screen.queryByRole('link', { name: 'Rules' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/alerts', '/alerts/correlations', '/alerts/monitors', '/alerts/delivery']);
});
```

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx src/components/alerts/AlertsTabStrip.test.tsx
```
Expected: `expected {…} not to have property "alert_rule"`, `LEGACY_TAB_ALIASES is not exported`, `Unable to find role="tab" … selected`, `expected null not to be in the document` (Rules link present).

- [ ] **Step 3: Implement.**
`git rm` the six tab files and the two `LegacyRulesPage` files. `types.ts`: delete lines 61 and 65 (`alert_rule`, `monitoring` rows) — `FeatureType` is `Exclude<ConfigFeatureType, …>`, so the `Record<FeatureType, …>` compiles again once the rows go. `ConfigPolicyDetailPage.tsx`: delete the two imports, icon rows 112 and 123, render cases 432 and 442, and add:
```tsx
// Hashes of the tabs retired by the alerting consolidation (W05d). A saved
// deep link, a docs link or the contextual-help button may still carry them;
// they land on the Monitors tab and the URL is rewritten so the next reload
// is clean. Keys are RETIRED_CONFIG_FEATURE_TYPES — featureTypeParity.test.ts
// asserts that.
export const LEGACY_TAB_ALIASES: Record<'alert_rule' | 'monitoring', Tab> = {
  alert_rule: 'monitors',
  monitoring: 'monitors',
};

// inside the component, right after `const [activeTab, setActiveTab] = useHashTab<Tab>(VALID_TABS, "overview");`
useEffect(() => {
  if (typeof window === 'undefined') return;
  const raw = window.location.hash.replace(/^#/, '');
  const alias = (LEGACY_TAB_ALIASES as Record<string, Tab | undefined>)[raw];
  if (!alias) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${alias}`);
  setActiveTab(alias);
}, [setActiveTab]);
```
(`useHashTab` ignores an unknown hash and starts on `overview`; the effect runs post-mount, same timing `useHashState` uses to adopt the hash — see the #2421 note at lines 158-161.) `DeviceEffectiveConfigTab.tsx`: delete lines 120 and 127. Astro pages:
```astro
---
// W05d — the legacy rules page was absorbed into Monitors.
return Astro.redirect('/alerts/monitors', 301);
---
```
for all three `pages/alerts/rules/*.astro`. `AlertsTabStrip.tsx`: delete line 10 and line 46. Locales: delete the listed blocks/keys in all 8 files (the coverage test fails on a key present in one locale and absent in another, in either direction). Run `grep -rn "alertRuleTab\|monitoringTab\|alertsRules\|LegacyRulesPage\|alerts/rules" apps/web/src` — must print nothing except the three 301 stubs.

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/web exec tsc --noEmit
cd apps/web && npx vitest run src/components/configurationPolicies src/components/devices/DeviceEffectiveConfigTab src/components/alerts/AlertsTabStrip.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/locales
pnpm --filter @breeze/web build     # Astro must compile the three redirect stubs
```

- [ ] **Step 5: Commit.**
```bash
git add -A apps/web/src/components/configurationPolicies apps/web/src/components/monitoring apps/web/src/components/devices apps/web/src/components/alerts apps/web/src/pages/alerts/rules apps/web/src/locales apps/web/src/lib/__tests__
git commit -m "feat(web): retire the policy Alerts and Service & Process tabs and /alerts/rules; legacy hashes land on Monitors"
```

---

### Task 12: AI tools refuse the retired feature types; `manage_alert_rules` loses `list_templates`; the one-shot migrate script goes (PR2)

**Files:**
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts` (`VALIDATED_INLINE_SETTINGS` 101-108; `manage_policy_feature_link` description 876-905 incl. the `alert_rule`/`monitoring` shape paragraphs at 879-880; JSON-schema `featureType.enum` 907-916; handler `add` branch 1000-1014; `update` anti-bypass 956-994)
- Modify: `apps/api/src/services/aiToolsFleet.ts` (`manage_alert_rules` 2450-2520 description/schema/`list_templates` branch; `list_rules` branch ~2521-2560; refusal text 2579-2583; `manage_service_monitors` `list` 3170-3215 if W05c2 left the `monitoring` join)
- Modify: `apps/api/src/services/aiToolSchemasFleet.ts:164-185`, `aiAgentSdkTools.ts:1999-2014` and `:2347-2357`, `aiToolSchemas.ts:1386`, `aiGuardrails.ts:1005-1010`, `aiAgentSystemPrompt.ts:67-74, 88-89`, `mcpGuidance.ts:92-101`
- Modify: `apps/api/src/services/aiAgentSdkTools.mcpCoverage.test.ts` (line 378 case), `aiToolsConfigPolicy.test.ts`, `aiToolsFleet.test.ts`, `aiToolSchemasFleet.test.ts`
- Delete: `apps/api/src/scripts/migrateToConfigPolicies.ts`; entry at `apps/api/src/services/featureLinkReaders.contract.test.ts:83`
- Delete (shared, now importer-less): `alertRuleInlineSettingsSchema`, `monitoringInlineSettingsSchema` and their types in `packages/shared/src/validators/index.ts` (+ cases in `index_configpolicy.test.ts`) — only after `grep -rn "alertRuleInlineSettingsSchema\|monitoringInlineSettingsSchema" apps packages --include='*.ts' --include='*.tsx' | grep -v node_modules` shows no consumer outside the validator file and its test.

**Interfaces:**
- Consumes: Task 6's `CONFIG_FEATURE_TYPES` / `isRetiredConfigFeatureType`; the W05c2 warning text for `alert_rule`/`monitoring` (replaced by a refusal).
- Produces:
  - `manage_policy_feature_link` `add` with `featureType` in `RETIRED_CONFIG_FEATURE_TYPES` → `{ error: 'Feature type "alert_rule" was retired by the alerting consolidation. Author the condition with manage_monitor_definitions and attach it to the policy with featureType "monitors".', retiredFeatureType, useTool: 'manage_monitor_definitions' }`; its JSON-schema `featureType.enum` is `[...CONFIG_FEATURE_TYPES]`; `update` on a retired link → the same error (the anti-bypass read at 967-974 already fetches the existing link's type).
  - `manage_alert_rules` actions: `list_rules | get_rule | test_rule | list_channels | alert_summary` (no `list_templates`; `create_rule`/`update_rule`/`delete_rule` dropped from every schema, not just refused); `list_rules` returns rows with `managed_by_monitor_id IS NOT NULL` only and each row carries `monitorId`; every pointer says `manage_monitor_definitions`.
  - No file under `apps/api/src/scripts/` inserts `config_policy_alert_rules`.

- [ ] **Step 1: Write the failing tests.** `aiAgentSdkTools.mcpCoverage.test.ts` — replace the case at line 378:
```ts
it('manage_policy_feature_link accepts every canonical feature type and refuses every retired one', () => {
  for (const ft of CONFIG_FEATURE_TYPES) {
    expect(validateToolInput('manage_policy_feature_link', { action: 'add', configPolicyId: UUID, featureType: ft, inlineSettings: {} }).ok).toBe(true);
  }
  for (const ft of RETIRED_CONFIG_FEATURE_TYPES) {
    expect(validateToolInput('manage_policy_feature_link', { action: 'add', configPolicyId: UUID, featureType: ft, inlineSettings: {} }).ok).toBe(false);
  }
  // The DB enum still carries the retired values; the tool surface must not.
  expect([...CONFIG_FEATURE_TYPES, ...RETIRED_CONFIG_FEATURE_TYPES].sort()).toEqual([...configFeatureTypeEnum.enumValues].sort());
});
it('manage_alert_rules has no list_templates and no write actions (W05d)', () => {
  const schema = aiTools.get('manage_alert_rules')!.definition.input_schema as { properties: { action: { enum: string[] } } };
  expect(schema.properties.action.enum).toEqual(['list_rules', 'get_rule', 'test_rule', 'list_channels', 'alert_summary']);
  expect(aiTools.get('manage_alert_rules')!.definition.description).toContain('manage_monitor_definitions');
  expect(aiTools.get('manage_alert_rules')!.definition.description).not.toMatch(/featureType "alert_rule"/);
});
```
`aiToolsConfigPolicy.test.ts`:
```ts
it('add with a retired featureType is refused with a pointer, before any DB read', async () => {
  const out = JSON.parse(await handler({ action: 'add', configPolicyId: 'p1', featureType: 'monitoring', inlineSettings: { checkIntervalSeconds: 60, watches: [] } }, auth));
  expect(out).toEqual(expect.objectContaining({ retiredFeatureType: 'monitoring', useTool: 'manage_monitor_definitions' }));
  expect(dbSelectMock).not.toHaveBeenCalled();
});
```
`aiToolsFleet.test.ts`:
```ts
it('manage_alert_rules list_rules returns managed rules only (W05d)', async () => {
  seedRules([{ id: 'r1', managedByMonitorId: 'm1' }, { id: 'r2', managedByMonitorId: null }]);
  const out = JSON.parse(await handler({ action: 'list_rules' }, auth));
  expect(out.rules.map((r: { id: string }) => r.id)).toEqual(['r1']);
  expect(whereSql()).toMatch(/managed_by_monitor_id.*is not null/i);
});
it('manage_alert_rules list_templates is unknown', async () => {
  const out = JSON.parse(await handler({ action: 'list_templates' }, auth));
  expect(out.error).toMatch(/unknown action/i);
});
```
`featureLinkReaders.contract.test.ts`: no new case — removing the allowlist line makes the contract fail if the file still exists.

- [ ] **Step 2: Run, expect FAIL.**
```bash
cd apps/api && npx vitest run src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiToolsConfigPolicy.test.ts src/services/aiToolsFleet.test.ts
```
Expected: `expected true to be false` (retired type accepted), `expected ['list_templates', …] to deeply equal ['list_rules', …]`, `expected ['r1','r2'] to deeply equal ['r1']`.

- [ ] **Step 3: Implement.**
`aiToolsConfigPolicy.ts`: delete the `alert_rule` and `monitoring` rows of `VALIDATED_INLINE_SETTINGS` (103-104); delete the two shape paragraphs (879-880) and add one line to the description: `- alert_rule / monitoring: RETIRED. Author conditions with manage_monitor_definitions and attach them via featureType "monitors".`; replace the hand-listed enum (908-916) with `enum: [...CONFIG_FEATURE_TYPES]`; in the `add` branch, before the `ORG_SCOPED_ONLY_FEATURE_TYPES` check (1007):
```ts
        if (isRetiredConfigFeatureType(featureType)) {
          return JSON.stringify({
            error: `Feature type "${featureType}" was retired by the alerting consolidation. Author the condition with manage_monitor_definitions and attach it to the policy with featureType "monitors".`,
            retiredFeatureType: featureType,
            useTool: 'manage_monitor_definitions',
          });
        }
```
and in the `update` path, after `existingFeatureType` is read (974), the same refusal keyed on `existingFeatureType`. Delete W05c2's warning branch for the two types.

`aiToolsFleet.ts` `manage_alert_rules` (2450-2520): description → `'Query alert rules and notification channels (read-only). Every alert condition is authored as a monitor — use manage_monitor_definitions to create, change or delete one; list_rules shows the rules monitors compiled (each carries monitorId). Actions: list_rules, get_rule, test_rule, list_channels, alert_summary.'`; `action.enum` → the five actions; delete the `category` property and the whole `if (action === 'list_templates') { … }` block; in `list_rules` add `isNotNull(alertRules.managedByMonitorId)` to `conditions` and `monitorId: alertRules.managedByMonitorId` to the projection; replace the 2579-2583 refusal with the generic unknown-action fallthrough the handler already ends with (the three actions are no longer in any schema). `manage_service_monitors` `list` (3170-3215): if W05c2 left the `monitoring`-link join, delete it — the resolver read is the only one. `aiToolSchemasFleet.ts:165` and `aiAgentSdkTools.ts:2002`: the five-action enum; drop `templateId`, `targetType`, `targetId`, `overrideSettings`, `isActive`, `name`, `category` and the `create_rule` refinement (183). `aiAgentSdkTools.ts:2353` and `aiToolSchemas.ts:1386` already derive from `CONFIG_FEATURE_TYPES` (unchanged). `aiGuardrails.ts:1006`: delete `list_templates`. `aiAgentSystemPrompt.ts:70`: drop `alert_rule, monitoring` from the inline-settings list; `:74`: the watches example becomes a `manage_monitor_definitions` example; `:88`: `manage_alert_rules (read-only, compiled rules)`. `mcpGuidance.ts:101`: `Core alert conditions as monitors (manage_monitor_definitions, attached via the policy's "monitors" feature link): …`.

`git rm apps/api/src/scripts/migrateToConfigPolicies.ts`; delete `featureLinkReaders.contract.test.ts:83`. Delete the two shared schemas only when the grep in **Files** is clean.

- [ ] **Step 4: Run, expect PASS.**
```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/services/aiAgentSdkTools src/services/aiToolsConfigPolicy src/services/aiToolsFleet src/services/aiToolSchemas src/services/aiGuardrails src/services/featureLinkReaders.contract.test.ts src/services/mcpGuidance
cd packages/shared && npx vitest run src/validators
grep -rn "featureType \"alert_rule\"\|featureType \"monitoring\"\|list_templates" apps/api/src --include='*.ts' | grep -v '\.test\.'   # must print nothing
```

- [ ] **Step 5: Commit.**
```bash
git add -A apps/api/src/services apps/api/src/scripts packages/shared/src/validators
git commit -m "feat(ai): policy feature-link tool refuses retired types; manage_alert_rules is compiled-rules-only; delete the one-shot migrate script"
```

---

### Task 13: Docs and release notes (PR2)

**Files:**
- Delete: `apps/docs/src/content/docs/features/service-monitoring.mdx`
- Modify: `apps/docs/astro.config.mjs` (sidebar line 126; add/extend `redirects`)
- Modify: `apps/docs/src/content/docs/features/alerts.mdx` (sections at 116-170 "Creating Alert Rules", "Testing a Rule", "Partner-wide Rules", and 240 "Offline Duration for Configuration Policy Rules")
- Modify: `apps/docs/src/content/docs/features/configuration-policies.mdx` (lines 107, 375)
- Modify: `apps/docs/src/content/docs/features/monitors.mdx` (lines 35, 104-118 "Converting a legacy alert rule", 157 API row, 169-173 troubleshooting)
- Modify: `docs/release-notes/next-release-draft.md`, `CHANGELOG.md` (`[Unreleased]`)
- Modify: the nine `apps/docs/src/content/docs/migration/*.mdx` guides only where they still say "alert rule" as an authoring instruction (`grep -ln "alert rule\|Alert Rules" apps/docs/src/content/docs/migration/*.mdx`) — W05c2 re-pointed most; finish the sweep.

**Interfaces:**
- Consumes: W05c2's docs state (`alert-templates.mdx` already removed with a redirect; `alerts.mdx` already the three-facet domain page if W05c2 rewrote it — `git log --oneline -3 -- apps/docs/src/content/docs/features/alerts.mdx`).
- Produces: `/features/service-monitoring/` → `/features/monitors/` (Astro `redirects`); no docs page instructs a reader to open a policy's **Alerts** or **Service & Process Monitoring** tab, `/alerts/rules`, or `POST /alerts/rules`; the `featureType` list at `configuration-policies.mdx:375` equals `CONFIG_FEATURE_TYPES`; release notes carry the removals, the boot check and what self-hosters see.

- [ ] **Step 1: Write the failing check.** Docs have no unit tests; the red is the build plus a grep contract. Add to `apps/docs/package.json` scripts (if a `check:links`-style script does not already exist) nothing — instead run the grep as the assertion:
```bash
grep -rn "Service & Process Monitoring tab\|/features/service-monitoring\|/alerts/rules\|POST /alerts/rules\|Alerts tab\|alert_rule\b" apps/docs/src/content/docs --include='*.mdx' | grep -v "retired\|no longer" 
```
Expected before the change: matches at `configuration-policies.mdx:107,375`, `monitors.mdx:35,157,173`, `alerts.mdx:116-170`, `astro.config.mjs:126`. Expected after: no output.

- [ ] **Step 2: Run it, expect FAIL** (matches listed above). Also `cd apps/docs && pnpm build` is green today; after deleting `service-monitoring.mdx` and before fixing the sidebar it fails with `Sidebar entry features/service-monitoring not found` — that is the second red.

- [ ] **Step 3: Implement.**
`astro.config.mjs`: delete line 126; add at the top level of `defineConfig({ … })`:
```js
  redirects: {
    // W05d — Service & Process Monitoring became monitors of kind service/process/process_resource.
    '/features/service-monitoring/': '/features/monitors/',
  },
```
(if W05c2 already added a `redirects` map for `/features/alert-templates/`, add this entry to it). `git rm apps/docs/src/content/docs/features/service-monitoring.mdx`.

`configuration-policies.mdx:107` → `A single policy carries every alert condition — service and process watches, thresholds, offline detection, event-log patterns — as monitors attached on its **Monitors** tab, plus one agent-collection setting, *Check interval*. See [Monitors](/features/monitors/).` `:375` → the canonical list without `alert_rule`/`monitoring`, ending: ``The retired values `alert_rule` and `monitoring` are rejected with `410 Gone`.``

`monitors.mdx`: line 35 → `**Service stopped**, **Process stopped** and **Process resource** monitors are delivered to the agent directly from the policy's attached monitors; the per-policy *Check interval* on the Monitors tab sets how often the agent evaluates them.`; §"Converting a legacy alert rule" (104-118) → a short "Legacy rules" section: conversion happened in the previous release; anything that could not convert is listed once on **Alerts → Monitors** with its reason; open alerts from those rules stay open until resolved; the legacy write endpoints return `410 Gone`; delete the API row at 157 if W05c2 removed `convert-from-rule` (grep the routes) or reword it as retired; troubleshooting 169-173 → replace with "**The Monitors page shows *N legacy rules could not be converted*.** Open the list; each row names the policy and the reason. Recreate the condition as a monitor (Composite for multi-condition rules), then dismiss the banner."

`alerts.mdx`: "Creating Alert Rules" (116-160), "Testing a Rule" (162), "Partner-wide Rules" (168) and "Offline Duration for Configuration Policy Rules" (240) → one section **Alert conditions are monitors** pointing at `/features/monitors/`, keeping the severity/status/response/correlation/notification sections. Update the intro sentence at line 10 ("triggered by **rules** you define" → "raised by **monitors** you define").

`docs/release-notes/next-release-draft.md` — under **Self-Hosting / Upgrade Notes**:
```md
- **Legacy alerting retired (alerting consolidation W05d).** The policy **Alerts** and **Service & Process Monitoring** tabs, the `/alerts/rules` page and `POST/PUT/PATCH/DELETE /alerts/rules*` and `/alert-templates*` are gone (`410 Gone`; reads remain for history). On first boot the API converts whatever the previous release's *Convert everything* left unconverted, per partner, and retires what cannot convert with a reason; **Alerts → Monitors** shows a one-time banner listing those rows. Open alerts raised by a retired rule stay open until someone resolves them. Standalone alert rules nobody converted now route through Delivery routing rows instead of their own channel list. Every boot then counts unretired `config_policy_alert_rules` / `config_policy_monitoring_watches`; a non-zero count is logged at error level and reported to Sentry (nothing evaluates those rows any more) — the banner tells you what to do. `BREEZE_LEGACY_ALERTING_SWEEP=false` skips the conversion (the count still runs). Run the previous release's *Convert everything* before upgrading if you want to preview each conversion; this release does it unattended.
- **Migration `2026-10-24-100000-legacy-alerting-retirement-sweep.sql`** re-keys each policy's check interval to its `monitors` feature link and prints `RAISE WARNING` counts of anything still unretired. Idempotent; no data is deleted.
```
`CHANGELOG.md` `[Unreleased]`: under **Removed** — the tabs, page, endpoints, `evaluateDeviceAlertsFromPolicy`, the `alert_rule`/`monitoring` feature types (`RETIRED_CONFIG_FEATURE_TYPES`), `manage_alert_rules.list_templates`, `scripts/migrateToConfigPolicies.ts`; under **Changed** — check interval on the `monitors` link; boot sweep + count check; delivery for unconverted standalone rules; under **Critical for self-hosters upgrading to this release** — the two bullets above condensed.

- [ ] **Step 4: Run, expect PASS.**
```bash
cd apps/docs && pnpm build
grep -rn "Service & Process Monitoring tab\|/features/service-monitoring\|/alerts/rules\|POST /alerts/rules\|Alerts tab\|alert_rule\b" apps/docs/src/content/docs --include='*.mdx' | grep -v "retired\|no longer"   # no output
```

- [ ] **Step 5: Commit.**
```bash
git add -A apps/docs/src/content/docs apps/docs/astro.config.mjs docs/release-notes/next-release-draft.md CHANGELOG.md
git commit -m "docs: alerting consolidation W05d — removals, boot check, self-hoster notes; service-monitoring page redirects to monitors"
```

---

### Task 14: Verification pass (end of PR1 and again at end of PR2)

**Files:** none created. Read-only checks against the whole tree.

- [ ] **Step 1: Migration naming and RLS scope.**
```bash
git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1     # must sort BEFORE 2026-10-24-100000-…
bash scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/config/composeBindMounts.test.ts
```

- [ ] **Step 2: Typecheck every package touched.**
```bash
pnpm --filter @breeze/shared exec tsc --noEmit
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec tsc --noEmit
pnpm --filter @breeze/web build
cd apps/docs && pnpm build          # PR2 only
```

- [ ] **Step 3: Unit suites for every touched area.**
```bash
cd packages/shared && npx vitest run src/constants src/validators
cd apps/api && npx vitest run src/services/configurationPolicy src/services/policyBaselineDefaults.test.ts src/routes/configurationPolicies src/routes/agents/helpers src/routes/agents/heartbeat.test.ts src/services/monitors src/routes/monitorDefinitions src/services/alertService src/services/alertCooldown src/jobs/alertWorker src/jobs/alertQueue.test.ts src/jobs/offlineDetector src/services/offlineAlertEffects src/services/delivery src/services/notificationDispatcher src/routes/alerts src/routes/alertTemplates src/routes/mobile src/services/aiAgentSdkTools src/services/aiToolsConfigPolicy src/services/aiToolsFleet src/services/aiToolSchemas src/services/aiGuardrails src/services/featureLinkReaders.contract.test.ts src/services/featureConfigResolver.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts src/__tests__/multi-tenant-isolation.test.ts
cd apps/web && npx vitest run src/components/configurationPolicies src/components/devices/DeviceEffectiveConfigTab src/components/alerts src/components/monitoring src/lib/__tests__ src/locales
```
Check the reported file counts against the File Structure table — vitest's filter is a substring match; a typo silently runs zero files.

- [ ] **Step 4: Integration suites (live stack).** Touches migrations, the agent config builder and system-context writes, so all of these run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/legacyAlertingRetirementMigration.integration.test.ts \
  src/__tests__/integration/legacyAlertingRetirementSweep.integration.test.ts \
  src/__tests__/integration/monitorWatchDelivery.integration.test.ts \
  src/__tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd apps/api && npx vitest run -c vitest.config.rls.ts
pnpm test-stack down
```
`rls-coverage`, `tenantCascade`, both export-policy suites and the org-lifecycle merge contract must be green *unchanged* — this wave adds no table, column, policy or list entry; a red there means a stray schema change slipped in.

- [ ] **Step 5: Grep contracts (PR2).** Each must print nothing:
```bash
grep -rn "evaluateDeviceAlertsFromPolicy\|getApplicableRulesFromPolicy\|checkAutoResolveFromConfigPolicy\|isConfigPolicyRuleCooling\|markConfigPolicyRuleCooldown\|resolveAlertRulesForDevice\|resolveGoverningAlertRulePolicyForDevice" apps/api/src
grep -rn "legacyOverride\|legacy_override" apps/api/src
grep -rn "AlertRuleTab\|MonitoringTab\|LegacyRulesPage\|AlertRuleForm\|AlertRuleTestModal" apps/web/src
grep -rn "'alert_rule'\|'monitoring'" apps/api/src/services/configurationPolicy.ts apps/api/src/routes/configurationPolicies apps/api/src/routes/agents/helpers.ts apps/api/src/services/aiToolsConfigPolicy.ts apps/api/src/services/aiToolsFleet.ts | grep -v "RETIRED\|retired"
grep -rn "list_templates\|migrateToConfigPolicies" apps/api/src packages/shared/src
grep -rn "alertRuleTab\|monitoringTab\|alertsRules" apps/web/src/locales
```
And one that must print exactly the retired list: `grep -n "RETIRED_CONFIG_FEATURE_TYPES = " packages/shared/src/constants/configFeatureTypes.ts`.

- [ ] **Step 6: Boot smoke (PR2).** Bring up the worktree stack (`pnpm wt-stack up`), watch the API log for `[startup] Legacy alerting retirement: … unretired rules=0 watches=0`, `GET /api/v1/monitor-definitions/conversion/pending?orgId=<seed org>` returns `sweep` non-null, `POST /api/v1/alerts/rules` returns 410, `/alerts/rules` redirects to `/alerts/monitors`, and `/configuration-policies/<id>#alert_rule` lands on `#monitors` with the hash rewritten. Then seed one unretired `config_policy_alert_rules` row by hand (`retired_at = NULL`) with `BREEZE_LEGACY_ALERTING_SWEEP=false`, restart the API, and confirm the error log line and the Sentry capture (`[legacy-alerting-retirement] Legacy alerting rows are still unretired …`) — that is the only proof the loud path is wired. `pnpm wt-stack down` afterwards; say what you left running.

- [ ] **Step 7: PR hygiene.** PR1 title `feat(alerting): W05d part 1 — retirement sweep, settings re-key, boot check`; PR2 title `feat(alerting): W05d part 2 — retire legacy alerting surfaces (410s, tabs, evaluator, docs)` with `Closes #<W05d sub-issue>`. Both bodies state: ordering assumption (W05c shipped in a prior release), the migration name check result, the sweep/boot-check design (TypeScript after `serve()`, mirrors built-in monitors), the two-table count, the equivalence-refusal → retire decision, and that no cascade/export/RLS list changed. Run `/pr-review-toolkit:review-pr` once per PR; act only on confirmed findings.

**Open questions for the orchestrator (do not block on them):**
1. Sweep refusal policy — retire on equivalence delta (chosen, spec-conservative) vs convert-and-list-the-delta (keeps more firing). Decide before PR1 ships to hosted.
2. `POST /alerts/rules/:id/test` is read-only in effect; it is 410'd here because the spec says `POST/PUT/DELETE /alerts/rules*`. If a caller still needs a verdict on a compiled rule, the monitor test endpoint is the replacement.
3. Open alerts of retired-unconvertible sources are left open for a human (no auto-resolve path remains). If that produces stale-alert noise on hosted, a one-time "resolve alerts of retired sources" admin action is a follow-up, not part of this wave.
