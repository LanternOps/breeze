---
tracking_issue: LanternOps/breeze#6367
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05c1 Conversion (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every legacy alert-authoring row a configuration policy owns (inline alert rules, service/process watches, `alert.triggered` automations) and every unmanaged standalone rule/template can be previewed, converted into monitor definitions attached to the same policy, and retired in place — atomically, per policy, with a ledger, an equivalence check over every device in scope, open-alert carry-over, and a revert — through routes the W05c2 panel consumes.

**Architecture:** Three API PRs. **PR1** widens the monitor model so conversion has somewhere to land: a `composite` kind (server-evaluated children only, compiles to an `{logic}` group), `restart_service` parameters on `execute_command`, `consecutiveFailures` 1..100, and an `inheritance: cumulative | replace` setting on the `monitors` feature link honoured by `resolveMonitorsForDevice`. **PR2** adds the retirement columns to the six legacy tables and the two org-XOR-partner ledger tables with RLS, then excludes retired rows from executable results, agent-config builders and lists while preserving shared automation assignment election. **PR3** is the converter (`services/monitors/conversion/`): private normalized baseline and inherited consumer scope, caller-bound previews, pure mappers from the spec's table, a dry-run equivalence check (`resolveLegacyBaseline` before vs `resolveMonitorsForDevice` inside a rolled-back transaction after, job-backed above 500 devices), the transactional convert/revert/retire with ledger and open-alert carry-over, the `/monitor-definitions/conversion/*` routes, the `alert.triggered` payload fields, and the onboarding writer moved from baseline `alert_rules` to built-in monitor attachments. The converter refuses to run until the three prerequisite fixes are provably present.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (dual-axis RLS, deferrable composite FK), zod in `packages/shared`, BullMQ + Redis (equivalence job, cooldown re-key), Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`).

**Spec:** docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md (§Prerequisite defects, §Data model "Monitors" + "Retirement columns", §Conversion incl. Inheritance correction / Equivalence check / Open alerts / Other writers, §Evaluation transitional, §Tenancy and safety, §Waves W05c API half)

## Ordering assumptions (read first)

- **W05a and W05b have merged.** W05a froze creation on the legacy tabs (so the set of rows to convert is stable per policy) and W05b's `resolveDelivery` exists; Task 13 imports W05b's `resolveDelivery` and compares eligible channels, skipped-channel metadata and escalation per device/site. Routing, channel and escalation changes invalidate previews (D1/D6).
- **#6342, #6343 and #6344 have merged as independent PRs.** This plan builds ON them and never re-implements them:
  - **#6343** (`normalizeAutomationActions` keeps `kind` on `execute_command`; the watch builder reads it). Task 3 adds `maxAttempts` / `cooldownSeconds` on top. Verify before Task 3: `grep -n "kind" apps/api/src/services/automationRuntime.ts | sed -n '/execute_command/,/continue/p'` must show `kind` being preserved. If it does not, #6343 is not merged — stop and say so.
  - **#6344** (`resolveMonitorsForDevice` applies assignment `roleFilter` / `osFilter`). Task 5 adds the `inheritance` walk on top. Verify before Task 5: `grep -n "buildRoleOsFilterConditions\|matchesRoleOsFilter" apps/api/src/services/monitors/monitorResolver.ts` must match. If it does not, stop.
  - **#6342** (`offlineAlertEffects` resolves monitors for the device). Task 9 verifies it by grep and exports the capability constant next to it. Verify before Task 9: `grep -n "resolveMonitorsForDevice" apps/api/src/services/offlineAlertEffects.ts` must match.
- The line numbers cited below were verified on `main @ b8dd148bd8` (before W05a/W05b and the three fixes). After those merge the numbers drift by a few lines; every task names the symbol as well as the line, and the `grep` in each task is the authority.
- PR1 (Tasks 1–5) → PR2 (Tasks 6–8) → PR3 (Tasks 9–18). Each PR is independently green and mergeable; PR2 depends on PR1 only for the `composite` enum value in the drift check; PR3 depends on both.
- **Cross-check numbering:** the original HTTP Task 14 is now Task 16 after adding the private-baseline and workflow tasks; its D2/D3/D4/D10 endpoint/type names are unchanged for concurrent W05c2/W05d/W05e work.
- **W05e network extension (D20):** its PR1 additionally requires **#6352 and #6353**, with #6353 evaluating each managed check independently of alert-device online status and exporting `NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION = true as const` from `apps/api/src/services/alertConditions/handlers/networkCheck.ts`. W05e owns that capability check and the offline-device single-alert integration test; missing capability blocks its entire network preview with `blockedBy: 'prerequisite_missing'`, zero conversion/refusal candidates, and no retire sweep. This is separate from C1's three prerequisites; do not manufacture per-check offline refusals.
- **W05c2** (web + tools) consumes the routes and types produced here by exact name. **W05d** consumes `convertPartnerLegacy` and `retireSource`. **W05e** adds a `'network_monitors'` case to `retireSource` / `revertConversion` / `convertPartnerLegacy` and reads `monitor_conversions` — its plan is already written against the names below; do not rename.

## Global Constraints

- **Migration names.** Three files, in this sort order: `2026-10-23-103000-monitor-kind-composite.sql` (PR1 — enum value only; the brief assigned two names and the `monitor_kind` enum needs a third file that lands before the ledger), `2026-10-23-110000-monitor-conversions.sql` (PR2 — ledger tables + RLS), `2026-10-23-120000-legacy-source-retirement-columns.sql` (PR2). Before pushing each PR: `git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | grep -E '^apps/api/migrations/[0-9]{4}-[^/]+\.sql$' | sort | tail -1` plus `scripts/check-migration-naming.sh --against-ref origin/main` must sort **before** the new file (newest at planning time: `2026-10-21-110100-…`; W05b adds `2026-10-23-100000-delivery-routing-default-rows.sql`). Rename (bump `HHMMSS`) if anything newer landed. Never name a file for today's real date — shipped names run ahead of the calendar (CLAUDE.md §Schema Migration Workflow).
- Migrations are idempotent (`IF NOT EXISTS`, `DO $$ … $$`, `DROP POLICY IF EXISTS` + `CREATE`), contain **no inner `BEGIN`/`COMMIT`**, and the two PR2 files contain **no DML** — so `migrationRlsScope.test.ts` needs no `set_config('breeze.scope','system',true)` and its frozen baseline is untouched. If a later edit adds an `UPDATE`/`INSERT`, the elevation line goes first.
- **Tenancy (CLAUDE.md §Tenant Isolation / RLS, §Partner-Wide First).** `monitor_conversions` and `monitor_conversion_outputs` are dual-axis config-shaped tables: `org_id` XOR `partner_id` (`<table>_one_owner_chk`), one dual-axis `FOR ALL` policy, a **separate, additive `FOR SELECT`** partner-wide branch keyed on `public.breeze_current_partner_id()` (template: `apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`; precedent in the same shape: `2026-10-16-160300-monitor-definitions.sql`), RLS enabled + forced, `GRANT … TO breeze_app`. The outputs table denormalises the owner axes and carries both `(conversion_id, partner_id) → monitor_conversions(id, partner_id)` and the composite FK `(conversion_id, org_id) → monitor_conversions(id, org_id)` **`DEFERRABLE INITIALLY IMMEDIATE`** (org merge contract, `orgLifecycleFoundations.integration.test.ts`).
- **Registration lists (same PR as the migration — the step that gets missed, caught 0/5 by review and 5/5 by the contract tests):** `CORE_ORG_CASCADE_DELETE_ORDER` in `apps/api/src/services/tenantCascade.ts` (both tables, alphabetical by `localeCompare`: `monitor_conversion_outputs` < `monitor_conversions` < `monitor_definitions`, which is also child-before-parent); `CORE_TENANT_EXPORT_POLICY` in `apps/api/src/services/tenantExportPolicyRegistry.ts` (both tables; `moved_alert_ids`, `moved_alert_refs` and `source_state` are `excludedOpen`; `preview_hash` matches the `hash` suspicious-name part and is `reviewedIncluded`); `DUAL_AXIS_TENANT_TABLES` **and** `XOR_OWNERSHIP_DUAL_AXIS_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (both tables). New columns on the three org-cascade legacy tables (`alert_rules`, `alert_templates`, `automations`) must be classified in `CORE_TENANT_EXPORT_POLICY` (`included` — scalars and a uuid). `config_policy_alert_rules`, `config_policy_monitoring_watches`, `config_policy_automations` carry no `org_id` (tenant reached through `configuration_policies`, `PARENT_FK_JOIN_POLICY_TABLES` lines 856–861) and need no export entry. Neither ledger table has `device_id`, so the device-side lists do not apply. No new FK lacks an explicit `ON DELETE`, so `orgCascadeFkOnDeleteAllowlist.ts` gains nothing.
- **Partner-axis writers.** `partner-wide-write-coverage.test.ts` is textual: every file under `services/**` or `routes/**` that mutates a `partner_id`-bearing table must mention `canManagePartnerWidePolicies`. The conversion writers (`conversion/convert.ts`, `conversion/workflows.ts`) call it directly for partner-wide policies, so no allowlist entry; the ledger schema file is not a writer. `site-ceiling-write-coverage.test.ts`: the converter writes `configuration_policies` / `config_policy_feature_links` through `configurationPolicy.ts` (already exempt) and the routes gate with `canMutateOrgWideGovernance` (Task 16) — no allowlist entry.
- **DB context.** The panel path runs under the request's `withDbAccessContext` (auth middleware); the equivalence job and the partner sweep run under `withDbAccessContext(<snapshot of the caller's DbAccessContext>)` inside the worker — never a bare pool, never `withSystemDbAccessContext` on the request path (#1105, #2417). Monitors are created only through `createMonitorDefinition` (which compiles in its own transaction) or `compileMonitorInTx`.
- **Every code step has real code; red first.** Each task: write the failing test, run it and read the failure, implement, run green, typecheck (`cd apps/api && npx tsc --noEmit -p .` or `pnpm --filter @breeze/api exec tsc --noEmit`), commit. Never `pnpm --filter X test -- --run` (the `--` breaks vitest). Scoped runs: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`. Integration suites: `pnpm test-stack up` once, then `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`; `pnpm test-stack down` when finished.
- **Do not commit from a plan-execution subagent unless the task says so; the orchestrator owns branches.** Commit messages follow `<type>(<scope>): …`.
- **Web exception:** Task 1 changes only the shared-kind field map, picker and two locale keys; W05c2 owns the composite children/restart controls and their tests. The shared `MONITOR_KINDS` change is visible to `apps/web`; Task 1 runs the web kind-parity tests so the shared package change cannot redden Test Web after merge.

## File Structure (what changes where)

| File | Change |
|---|---|
| `packages/shared/src/validators/monitors.ts` | Modify: `MONITOR_KINDS` += `'composite'`; `SERVER_EVALUATED_MONITOR_KINDS`; `compositeConditionSchema` (`match`, 2..10 `children` of server-evaluated kinds, child conditions cross-validated); `consecutiveFailures` max 100 on `service`/`process`/`network_check`; `monitorsInlineSettingsSchema.inheritance` |
| `packages/shared/src/validators/monitors.test.ts` | Modify: composite + range + inheritance cases |
| `packages/shared/src/validators/automationActions.ts` | Modify: `execute_command` gains `maxAttempts` (0..50) and `cooldownSeconds` (30..86400), both optional |
| `apps/api/migrations/2026-10-23-103000-monitor-kind-composite.sql` | Create: `ALTER TYPE monitor_kind ADD VALUE 'composite'` (guarded) |
| `apps/api/src/db/schema/monitorDefinitions.ts` | Modify: `monitorKindEnum` += `'composite'` |
| `apps/api/src/services/monitors/kinds/types.ts` | Modify: `toAlertCondition` returns `RootCondition` |
| `apps/api/src/services/monitors/kinds/composite.ts` | Create: kind spec, `overridableKeys: []`, `{logic, conditions}` compile |
| `apps/api/src/services/monitors/kinds/index.ts` / `index.test.ts` | Modify: register `composite`; test iterates `.type` only for leaf kinds |
| `apps/api/src/services/monitors/monitorCompiler.ts` | Modify: `buildCompiledCondition` returns `RootCondition`; exports `DbExecutor` and the single compiler-owned `CompileOptions` (Task 7) |
| `apps/api/src/services/automationRuntime.ts` | Modify: `ExecuteCommandAction` + `normalizeAutomationActions` carry `maxAttempts` / `cooldownSeconds` |
| `apps/api/src/routes/agents/helpers.ts` | Modify: monitor-derived watch reads `max_restart_attempts` / `restart_cooldown_seconds` from the `restart_service` response; `resolvePolicyMonitoringSettings` watches read adds `retired_at IS NULL` |
| `apps/api/src/services/monitors/monitorResolver.ts` | Modify: reads `inheritance` off the `monitors` link; `replace` walk; exports `MONITOR_RESOLVER_CAPABILITIES` |
| `apps/api/src/services/configurationPolicy.ts` | Modify: `assembleInlineSettings('monitors')` returns `inheritance`; `deleteNormalizedRows` / `decomposeInlineSettings` / `assembleInlineSettings` for `alert_rule`, `automation`, `monitoring` preserve and hide retired rows |
| `apps/api/migrations/2026-10-23-110000-monitor-conversions.sql` | Create: `monitor_conversions`, `monitor_conversion_outputs`, RLS, indexes |
| `apps/api/migrations/2026-10-23-120000-legacy-source-retirement-columns.sql` | Create: `retired_at`, `retired_reason`, `converted_to_monitor_id` on six tables |
| `apps/api/src/db/schema/monitorConversions.ts` | Create: Drizzle tables + row types |
| `apps/api/src/db/schema/index.ts` | Modify: export the new schema file |
| `apps/api/src/db/schema/alerts.ts`, `automations.ts`, `configurationPolicies.ts` | Modify: three retirement columns on `alertRules`, `alertTemplates`, `automations`, `configPolicyAlertRules`, `configPolicyMonitoringWatches`, `configPolicyAutomations` |
| `apps/api/src/services/tenantCascade.ts` | Modify: two entries in `CORE_ORG_CASCADE_DELETE_ORDER` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Modify: two new table entries; three columns added to `alert_rules`, `alert_templates`, `automations` |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Modify: `DUAL_AXIS_TENANT_TABLES`, `XOR_OWNERSHIP_DUAL_AXIS_TABLES` |
| `apps/api/src/services/featureConfigResolver.ts` | Modify: retired alert-rule filters; shared `resolveAutomationAssignmentForDevice` election; executable-only filtering after election and in scheduled candidates |
| `apps/api/src/services/featureConfigResolver.effectiveLinks.test.ts`, `apps/api/src/jobs/automationWorker.executionIdentity.test.ts` | Modify: converted-child election and shadowed-parent scheduled dispatch regressions |
| `apps/api/src/services/alertService.ts` | Modify: `getApplicableRules` filters retired rules; `alert.triggered` payload gains `monitorId`, `kind`; `CreateAlertParams.kind` |
| `apps/api/src/services/offlineAlertEffects.ts` | Modify: retired filter on the rule read; exports `OFFLINE_EFFECTS_RESOLVE_MONITORS` |
| `apps/api/src/jobs/automationWorker.ts` | Modify: retired filters in event fan-out/execution and queued scheduled-source rechecks; retain the shared per-device election gate |
| `apps/api/src/routes/alerts/rules.ts`, `routes/alertTemplates/helpers.ts`, `routes/automations.ts` | Modify: lists exclude retired rows (`?includeRetired=true` opt-in on rules) |
| `apps/api/src/services/alertCooldown.ts` | Modify: `rekeyConfigPolicyCooldowns(sourceRuleId, compiledRuleId)` |
| `apps/api/src/services/monitors/conversion/types.ts` | Create: the cross-wave contract types |
| `apps/api/src/services/monitors/conversion/prerequisites.ts` | Create: capability check over the three fixes |
| `apps/api/src/services/monitors/conversion/mapping.ts` | Create: pure source → monitor mappers, action fingerprint, signature + preview hash |
| `apps/api/src/services/monitors/conversion/loadSources.ts` | Create: unretired sources of a policy, open-alert counts |
| `apps/api/src/services/monitors/conversion/equivalence.ts` | Create: resolved-delivery and enabled behavior equivalence in a dry-run transaction |
| `apps/api/src/services/monitors/conversion/convert.ts` | Create: `previewPolicyConversion`, `previewPartnerConversion`, `convertPolicy`, `convertPartnerLegacy`, `revertConversion`, `retireSource` |
| `apps/api/src/services/monitors/conversion/legacyBaseline.ts` / `legacyBaseline.test.ts` | Create: private normalized baseline and inherited assignment scope, retained by W05d |
| `apps/api/src/services/monitors/conversion/previewScope.ts` / `previewScope.test.ts` | Create: principal/DB snapshots, full freshness fingerprint, authorized cache reuse |
| `apps/api/src/services/monitors/conversion/workflows.ts` / `workflows.test.ts` | Create: rehome policy workflows and preserve assignment/winner semantics |
| `apps/api/src/services/monitors/conversion/history.ts` / `history.test.ts` | Create: shared open-alert carry-over, original reference restoration and reference-aware deletion |
| `apps/api/src/services/monitors/conversion/lifecycle.ts` / `lifecycle.test.ts` | Create: lifecycle availability and live target-dependency checks shared by revert and ledger |
| `apps/api/src/services/monitors/conversion/ledger.ts` / `ledger.test.ts` | Create: authorized persistent paginated ledger read |
| `apps/api/src/routes/monitorDefinitions.conversion.ts` / `monitorDefinitions.conversion.test.ts` | Create: preview/progress, partner hash confirmation, ledger, retirement id and revert routes |
| `apps/api/src/services/notificationDispatcher.ts` / `notificationDispatcher.configPolicyOverrides.test.ts` | Modify: both legacy override lookups exclude retired sources, queued dispatch regression |
| `apps/api/src/services/monitors/monitorService.ts` / `monitorService.test.ts` | Modify: nullable system actor and executor-aware four-argument creation/deletion |
| `apps/api/src/services/workerRegistry.ts` / `workerRegistry.test.ts` | Modify: socket-owner preview lifecycle |
| `apps/api/src/services/monitors/conversion/index.ts` | Create: re-exports (the module surface W05c2/W05d/W05e import) |
| `apps/api/src/jobs/monitorConversionPreviewWorker.ts` | Create: BullMQ queue + worker for the >500-device equivalence check |
| `apps/api/src/services/monitors/ruleConversionService.ts` | Modify: template-group preview/convert adapter using mapStandaloneRule, all rule/target associations under one ledger |
| `apps/api/src/routes/monitorDefinitions.ts` | Modify: `/conversion/*` routes declared before `/:id` |
| `apps/api/src/modules/mcpInvites/tools/configureDefaults.ts` | Modify: baseline step attaches the partner's built-in monitors to an org policy instead of inserting `alert_rules` |
| `apps/api/src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts` | Create: live-RLS forge proof for the ledger |
| `apps/api/src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts` | Create: convert → fires through the monitor sweep only → revert, against real Postgres + Redis |

---

## PR1 — kinds, actions, inheritance (Tasks 1–5)

### Task 1: Shared validators — `composite` kind, `consecutiveFailures` 100, `restart_service` params, `inheritance` on the `monitors` link (+ the minimal web guard)

**Files:**
- Modify: `packages/shared/src/validators/monitors.ts` (lines 18–41 `MONITOR_KINDS`; 56–190 `monitorConditionSchemas`; 76–96 `service`/`process`; 173–189 `network_check`; 288–299 `monitorsInlineSettingsSchema`)
- Modify: `packages/shared/src/validators/automationActions.ts` (lines 73–87, the `execute_command` arm)
- Test: `packages/shared/src/validators/monitors.test.ts` (existing)
- Modify (web guard, so Test Web stays green — `apps/web/src/components/monitoring/monitorKindFields.test.ts` iterates `MONITOR_KINDS` and requires a field-map entry, schema-shaped keys and a valid default for EVERY kind): `apps/web/src/components/monitoring/monitorKindFields.ts` (map at line 48 ff., `defaultConditionFor` at 247), `apps/web/src/components/monitoring/MonitorEditor.tsx:691` (keep `composite` in the exhaustive kind picker; W05c2 supplies the children editor), `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json` (`kinds.composite`, `fields.match`)

**Interfaces:**
- Produces (shared): `MONITOR_KINDS` (+ `'composite'`), `SERVER_EVALUATED_MONITOR_KINDS: readonly MonitorKind[]`, `ServerEvaluatedMonitorKind`, `compositeConditionSchema`, `CompositeCondition`, `monitorsInheritanceSchema`, `MonitorsInheritance = 'cumulative' | 'replace'`, `monitorsInlineSettingsSchema` (+ `inheritance`, default `'cumulative'`), `execute_command` action with `maxAttempts?: number`, `cooldownSeconds?: number`.
- Consumed by: Task 2 (kind spec), Task 3 (runtime + watch builder), Task 5 (resolver), Task 10 (mappers), W05c2 editor.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/validators/monitors.test.ts` (append to the existing file):

```ts
import { describe, expect, it } from 'vitest';
import {
  MONITOR_KINDS,
  SERVER_EVALUATED_MONITOR_KINDS,
  compositeConditionSchema,
  monitorConditionSchemas,
  monitorsInlineSettingsSchema,
  automationActionSchema,
} from './index';

describe('composite monitor kind (W05c1)', () => {
  it('is a registered kind whose children are restricted to server-evaluated kinds', () => {
    expect(MONITOR_KINDS).toContain('composite');
    expect(SERVER_EVALUATED_MONITOR_KINDS).not.toContain('composite');
    for (const agentKind of ['service', 'process', 'process_resource', 'script', 'network_check']) {
      expect(SERVER_EVALUATED_MONITOR_KINDS).not.toContain(agentKind);
    }
  });

  it('accepts 2..10 children, cross-validates each child against its kind schema, defaults match=all', () => {
    const ok = compositeConditionSchema.safeParse({
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'memory', condition: { operator: 'gt', value: 90, durationMinutes: 5 } },
      ],
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.match).toBe('all');

    const one = compositeConditionSchema.safeParse({ match: 'any', children: [{ kind: 'cpu', condition: { operator: 'gt', value: 80 } }] });
    expect(one.success).toBe(false);

    const badChild = compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'disk', condition: { operator: 'gt', value: 101 } },
      ],
    });
    expect(badChild.success).toBe(false);
    expect(badChild.success ? '' : JSON.stringify(badChild.error.issues[0]?.path)).toBe('["children",1,"condition"]');

    const agentChild = compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'service', condition: { serviceName: 'spooler' } },
      ],
    });
    expect(agentChild.success).toBe(false);

    const nested = compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'composite', condition: { match: 'all', children: [] } },
      ],
    });
    expect(nested.success).toBe(false);
  });

  it('monitorConditionSchemas.composite is the same schema', () => {
    expect(monitorConditionSchemas.composite).toBe(compositeConditionSchema);
  });
});

describe('consecutiveFailures widened to 1..100 (W05c1, matches the watch domain)', () => {
  it.each(['service', 'process', 'network_check'] as const)('%s accepts 100 and rejects 101', (kind) => {
    const base =
      kind === 'service' ? { serviceName: 'x' } : kind === 'process' ? { processName: 'x' } : { checkType: 'icmp_ping', target: '10.0.0.1' };
    expect(monitorConditionSchemas[kind].safeParse({ ...base, consecutiveFailures: 100 }).success).toBe(true);
    expect(monitorConditionSchemas[kind].safeParse({ ...base, consecutiveFailures: 101 }).success).toBe(false);
  });
});

describe('monitors link inheritance (W05c1)', () => {
  it('defaults to cumulative and accepts replace', () => {
    expect(monitorsInlineSettingsSchema.parse({ items: [] }).inheritance).toBe('cumulative');
    expect(monitorsInlineSettingsSchema.parse({ items: [], inheritance: 'replace' }).inheritance).toBe('replace');
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], inheritance: 'closest' }).success).toBe(false);
  });
});

describe('execute_command restart parameters (W05c1, spec C9)', () => {
  it('accepts maxAttempts 0..50 and cooldownSeconds 30..86400, both optional', () => {
    expect(automationActionSchema.safeParse({ type: 'execute_command', command: 'x' }).success).toBe(true);
    expect(
      automationActionSchema.safeParse({ type: 'execute_command', command: 'x', kind: 'restart_service', maxAttempts: 3, cooldownSeconds: 300 }).success,
    ).toBe(true);
    expect(automationActionSchema.safeParse({ type: 'execute_command', command: 'x', maxAttempts: 51 }).success).toBe(false);
    expect(automationActionSchema.safeParse({ type: 'execute_command', command: 'x', cooldownSeconds: 29 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd packages/shared && npx vitest run src/validators/monitors.test.ts` → fails on `SERVER_EVALUATED_MONITOR_KINDS` / `compositeConditionSchema` not exported ("does not provide an export named …") — or, if the file is new, on the first `expect(MONITOR_KINDS).toContain('composite')`.

- [ ] **Step 3: Implement**

`packages/shared/src/validators/monitors.ts` — replace lines 18–41 and restructure the schema map so the composite schema can reference the leaf schemas:

```ts
export const MONITOR_KINDS = [
  'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
  'service', 'process', 'process_resource', 'cert_expiry',
  'bandwidth', 'disk_io', 'network_errors',
  'antivirus', 'software_presence', 'backup_continuity', 'script', 'network_check',
  // W05c1 (alerting consolidation, spec C8): "all/any of the following". Children
  // are restricted to SERVER_EVALUATED_MONITOR_KINDS — agent-delivered and
  // worker-provisioned kinds are selected by ROOT kind when agent config, script
  // probes and network rows are built (helpers.ts, monitorScriptWorker.ts,
  // monitorCompiler.ts), so a composite child of those kinds would never
  // receive evidence.
  'composite',
] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export const monitorKindSchema = z.enum(MONITOR_KINDS);

/** Kinds whose evidence the server sweep reads itself — the only legal composite children. */
export const SERVER_EVALUATED_MONITOR_KINDS = [
  'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance', 'cert_expiry',
  'bandwidth', 'disk_io', 'network_errors', 'antivirus', 'software_presence', 'backup_continuity',
] as const satisfies readonly MonitorKind[];
export type ServerEvaluatedMonitorKind = (typeof SERVER_EVALUATED_MONITOR_KINDS)[number];
```

Rename the existing `export const monitorConditionSchemas = { … } satisfies Record<MonitorKind, z.ZodTypeAny>;` block to `const leafConditionSchemas = { … } satisfies Record<Exclude<MonitorKind, 'composite'>, z.ZodTypeAny>;` (no other change inside it except the three range bumps below), then add after it:

```ts
const compositeChildSchema = z
  .object({
    kind: z.enum(SERVER_EVALUATED_MONITOR_KINDS),
    condition: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * `{ match, children }` — no nesting (the child kind enum excludes `composite`),
 * 2..10 children, each child condition validated against its own kind schema so
 * an invalid leaf fails HERE with a `children[i].condition` path, never at
 * compile time. The API kind spec compiles it to `{ logic: and|or, conditions }`,
 * which `alertConditions/index.ts` `evaluateConditionRecursive` already walks.
 */
export const compositeConditionSchema = z
  .object({
    match: z.enum(['all', 'any']).default('all'),
    children: z.array(compositeChildSchema).min(2).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.children.forEach((child, index) => {
      const result = leafConditionSchemas[child.kind].safeParse(child.condition);
      if (!result.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['children', index, 'condition'],
          message: `child condition does not match kind ${child.kind}: ${result.error.issues[0]?.message ?? 'invalid'}`,
        });
      }
    });
  });
export type CompositeCondition = z.infer<typeof compositeConditionSchema>;

export const monitorConditionSchemas = {
  ...leafConditionSchemas,
  composite: compositeConditionSchema,
} satisfies Record<MonitorKind, z.ZodTypeAny>;
```

Range bumps inside the leaf map: `service.consecutiveFailures` (line 79) and `process.consecutiveFailures` (line 85) → `.max(100)`; `network_check.consecutiveFailures` (line 183) → `.max(100).default(2)`.

Replace lines 295–299:

```ts
export const monitorsInheritanceSchema = z.enum(['cumulative', 'replace']);
export type MonitorsInheritance = z.infer<typeof monitorsInheritanceSchema>;

/**
 * `inheritance` (W05c1, spec §Inheritance correction): how this policy's
 * attachment set combines with the rest of the device's chain in
 * `resolveMonitorsForDevice`.
 *  - cumulative (default): every attachment in the chain competes per monitor,
 *    closest wins; the parent's attachments are consulted.
 *  - replace: among the chain's REPLACE-mode links only the closest one
 *    contributes, and that link's parent is not consulted. Cumulative links in
 *    the same chain still add. This is exactly how the legacy `alert_rule`
 *    feature was selected (closest policy holding the feature wins), which is
 *    what a converted policy needs to reproduce its inline behaviour.
 */
export const monitorsInlineSettingsSchema = z.object({
  items: z.array(monitorAttachmentItemSchema).max(200).default([]),
  inheritance: monitorsInheritanceSchema.default('cumulative'),
});
```

`packages/shared/src/validators/automationActions.ts` lines 73–87 — add two fields after `kind`:

```ts
    kind: z.literal('restart_service').optional(),
    // W05c1 (spec C9): the watch's max_restart_attempts / restart_cooldown_seconds
    // moved to where the restart is authored. Read by the agent watch builder
    // (routes/agents/helpers.ts) with defaults 3 / 300 when absent; kept optional
    // so every stored action still parses and a non-restart command never
    // carries restart knobs.
    maxAttempts: z.number().int().min(0).max(50).optional(),
    cooldownSeconds: z.number().int().min(30).max(86400).optional(),
```

Check that `configFeatureInlineSettingsSchema` (`packages/shared/src/validators/index.ts`, `grep -n "export const configFeatureInlineSettingsSchema" -A 12`) still admits the `monitors` shape after the new key: if it is a `z.record(...)`/passthrough it needs nothing; if it is a discriminated/union over the per-feature schemas, it already includes `monitorsInlineSettingsSchema` by reference and needs nothing. Either way run the shared test file for it.

Web guard (three small edits, no new UI):

`apps/web/src/components/monitoring/monitorKindFields.ts` — add to the map (after `network_check`):

```ts
  // W05c1: the composite kind exists in the shared enum so the API can compile
  // it; W05c2 supplies the children editor and response controls.
  // Keep the picker exhaustive; do not add a composite exclusion.
  composite: [
    { key: 'match', labelKey: 'monitoring:fields.match', kind: 'select', options: ['all', 'any'] },
  ],
```

and in `defaultConditionFor` add a case before `default`:

```ts
    case 'composite':
      return {
        match: 'all',
        children: [
          { kind: 'cpu', condition: { operator: 'gt', value: 90, durationMinutes: 5 } },
          { kind: 'memory', condition: { operator: 'gt', value: 90, durationMinutes: 5 } },
        ],
      };
```

`apps/web/src/components/monitoring/MonitorEditor.tsx:691` — retain `{MONITOR_KINDS.map((kind) => (`. W05c2 PR1 implements the composite children editor, restart parameters and failure-count controls before the combined conversion release; there is no picker exclusion to remove later.

Locale keys (real translations, all eight files, inside the existing `"kinds"` and `"fields"` objects of `monitoring.json`):

| locale | `kinds.composite` | `fields.match` |
|---|---|---|
| en | `Composite (all or any of several)` | `Match` |
| de-DE | `Kombiniert (alle oder eine von mehreren)` | `Bedingung` |
| es-419 | `Compuesto (todas o alguna de varias)` | `Coincidencia` |
| fr-CA | `Composite (toutes ou une parmi plusieurs)` | `Correspondance` |
| fr-FR | `Composite (toutes ou une parmi plusieurs)` | `Correspondance` |
| it-IT | `Composito (tutte o una di più condizioni)` | `Corrispondenza` |
| pt-BR | `Composto (todas ou alguma de várias)` | `Correspondência` |
| tr-TR | `Bileşik (birkaç koşulun tümü veya herhangi biri)` | `Eşleşme` |

- [ ] **Step 4: Run, expect PASS**

`cd packages/shared && npx vitest run src/validators/monitors.test.ts src/validators/automationActions` (check the file count — the second is a substring filter). Then `cd apps/web && npx vitest run src/components/monitoring/monitorKindFields.test.ts src/components/monitoring/MonitorEditor` and `cd apps/web && npx vitest run src/locales` (locale coverage). Then `cd apps/api && npx tsc --noEmit -p .` — expect ONE error: `services/monitors/kinds/index.ts` `MONITOR_KIND_SPECS` is missing `composite` (Task 2 fixes it; this is the expected red that proves the registry is exhaustive).

- [ ] **Step 5: Commit**

`git add packages/shared/src/validators/monitors.ts packages/shared/src/validators/monitors.test.ts packages/shared/src/validators/automationActions.ts apps/web/src/components/monitoring/monitorKindFields.ts apps/web/src/components/monitoring/MonitorEditor.tsx apps/web/src/locales/*/monitoring.json && git commit -m "feat(shared): composite monitor kind, consecutiveFailures 100, restart_service params, monitors link inheritance"`

### Task 2: `composite` kind spec, enum migration, `RootCondition` compile type

**Files:**
- Create: `apps/api/migrations/2026-10-23-103000-monitor-kind-composite.sql`
- Modify: `apps/api/src/db/schema/monitorDefinitions.ts:33-55` (`monitorKindEnum`)
- Modify: `apps/api/src/services/monitors/kinds/types.ts:30-63` (`toAlertCondition` return type)
- Create: `apps/api/src/services/monitors/kinds/composite.ts`
- Modify: `apps/api/src/services/monitors/kinds/index.ts:39-58` (register)
- Modify: `apps/api/src/services/monitors/monitorCompiler.ts:121-128` (`buildCompiledCondition` return type only)
- Test: `apps/api/src/services/monitors/kinds/index.test.ts` (lines 6–44: `SAMPLES`, the "eighteen kinds" pin, the per-kind loop), `apps/api/src/services/monitors/kinds/composite.test.ts` (create)

**Interfaces:**
- Consumes: `compositeConditionSchema`, `SERVER_EVALUATED_MONITOR_KINDS` (Task 1); `MONITOR_KIND_SPECS`; `RootCondition` / `ConditionGroup` from `services/alertConditions/types`.
- Produces: `compositeKind: MonitorKindSpec<CompositeCondition>` with `overridableKeys: []`, `defaultSeverity: 'high'`, `agentDelivered: false`, `toAlertCondition → { logic: 'and' | 'or', conditions: AlertCondition[] }`; `MonitorKindSpec.toAlertCondition` now returns `RootCondition` (a leaf for every other kind — unchanged values).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/monitors/kinds/index.test.ts` — change line 33 to `expect(MONITOR_KINDS).toHaveLength(19);`, add to `SAMPLES`:

```ts
  // W05c1: composite compiles to a group, so the per-kind loop below validates
  // the whole tree through validateConditions like every leaf.
  composite: {
    match: 'any',
    children: [
      { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
      { kind: 'offline', condition: { durationMinutes: 10 } },
    ],
  },
```

`apps/api/src/services/monitors/kinds/composite.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compositeKind } from './composite';
import { applyOverrides, MONITOR_KIND_SPECS } from './index';

const CTX = { monitorId: '00000000-0000-4000-8000-000000000001' };

describe('composite kind (W05c1, spec C8)', () => {
  it('is registered, server-evaluated and has no overridable keys', () => {
    expect(MONITOR_KIND_SPECS.composite).toBe(compositeKind);
    expect(compositeKind.agentDelivered).toBe(false);
    expect(compositeKind.overridableKeys).toEqual([]);
  });

  it('compiles match=all to an and-group of the children compiled by their own specs', () => {
    const compiled = compositeKind.toAlertCondition(
      compositeKind.conditionSchema.parse({
        match: 'all',
        children: [
          { kind: 'cpu', condition: { operator: 'gt', value: 90, durationMinutes: 10 } },
          { kind: 'memory', condition: { operator: 'gte', value: 85 } },
        ],
      }),
      CTX,
    );
    expect(compiled).toEqual({
      logic: 'and',
      conditions: [
        { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90, durationMinutes: 10 },
        { type: 'threshold', metric: 'ramPercent', operator: 'gte', value: 85 },
      ],
    });
  });

  it('compiles match=any to an or-group', () => {
    const compiled = compositeKind.toAlertCondition(
      compositeKind.conditionSchema.parse({
        match: 'any',
        children: [
          { kind: 'disk', condition: { operator: 'gt', value: 95 } },
          { kind: 'offline', condition: { durationMinutes: 5 } },
        ],
      }),
      CTX,
    );
    expect(compiled).toMatchObject({ logic: 'or' });
    expect((compiled as { conditions: unknown[] }).conditions).toHaveLength(2);
  });

  it('applyOverrides on a composite returns the condition unchanged (the sweep override path replaces the root wholesale)', () => {
    const condition = compositeKind.conditionSchema.parse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
        { kind: 'memory', condition: { operator: 'gt', value: 90 } },
      ],
    });
    expect(applyOverrides(compositeKind, condition, { match: 'any', children: [], value: 1 })).toEqual(condition);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/monitors/kinds/` → `index.test.ts` fails "expected 18 to be 19" is already fixed by Task 1, so the failure is `Cannot find module './composite'` from `composite.test.ts` and, in `index.test.ts`, `spec` undefined for `composite`.

- [ ] **Step 3: Implement**

`apps/api/migrations/2026-10-23-103000-monitor-kind-composite.sql`:

```sql
-- Alerting consolidation W05c1 (spec C8): the `composite` monitor kind.
-- Enum value only. Safe inside the runner's transaction because nothing in
-- this file consumes the value. Idempotent (pg_enum guard). No DML.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'composite'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'monitor_kind')
  ) THEN
    ALTER TYPE monitor_kind ADD VALUE 'composite';
  END IF;
END $$;
```

`apps/api/src/db/schema/monitorDefinitions.ts` — append `'composite',` to `monitorKindEnum` after `'network_check'` with the comment `// W05c1 — 2026-10-23-103000-monitor-kind-composite.sql`.

`apps/api/src/services/monitors/kinds/types.ts` — change the import to `import type { RootCondition } from '../../alertConditions/types';` and the method to:

```ts
  /**
   * Compiles the authored condition into the handler-shaped object
   * `alertConditions` evaluates. Every leaf kind returns ONE `AlertCondition`;
   * `composite` (W05c1) returns a `{ logic, conditions }` group, which
   * `evaluateConditionRecursive` already walks. Callers that need `.type`
   * must narrow (`'type' in compiled`).
   */
  toAlertCondition(condition: C, ctx: MonitorCompileContext): RootCondition;
```

`apps/api/src/services/monitors/kinds/composite.ts`:

```ts
import { monitorConditionSchemas, type CompositeCondition } from '@breeze/shared';
import type { AlertCondition } from '../../alertConditions/types';
import type { MonitorKindSpec } from './types';
import { getMonitorKindSpec } from './index';

/**
 * "All / any of the following" (spec C8). Children are server-evaluated kinds
 * only (enforced by the shared schema), no nesting, 2..10 children. Each child
 * is re-parsed through its own kind schema (so child defaults apply) and
 * compiled by that kind's `toAlertCondition`, then wrapped in the group shape
 * `alertConditions/index.ts` `evaluateConditionRecursive` walks.
 *
 * `overridableKeys: []` is the honest contract: the sweep's override path
 * (`alertService.ts` getApplicableRules) replaces the ROOT node wholesale from
 * this spec, so there is no per-key override a policy attachment could apply.
 */
export const compositeKind: MonitorKindSpec<CompositeCondition> = {
  kind: 'composite',
  conditionSchema: monitorConditionSchemas.composite,
  overridableKeys: [],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: '{{ruleName}} on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{conditionsMet}}',
  toAlertCondition: (c, ctx) => ({
    logic: c.match === 'all' ? 'and' : 'or',
    conditions: c.children.map((child) => {
      const spec = getMonitorKindSpec(child.kind);
      const parsed = spec.conditionSchema.parse(child.condition);
      // A server-evaluated child always compiles to a leaf; the cast documents
      // the invariant the shared schema enforces (no composite children).
      return spec.toAlertCondition(parsed, ctx) as AlertCondition;
    }),
  }),
};
```

`apps/api/src/services/monitors/kinds/index.ts` — `import { compositeKind } from './composite';` and `composite: compositeKind,` after `network_check`. (The circular import `composite.ts → index.ts → composite.ts` is safe: `getMonitorKindSpec` is only called at compile time, long after both modules have evaluated. Do NOT hoist a `MONITOR_KIND_SPECS` read into module scope in `composite.ts`.)

`apps/api/src/services/monitors/monitorCompiler.ts:122` — `export function buildCompiledCondition(def: MonitorDefinitionRow): RootCondition {` with `import type { RootCondition } from '../alertConditions/types';` (replacing the `AlertCondition` type import if it becomes unused). `buildCompiledTemplate` stores it in the jsonb `conditions` column — no other change. The comment at lines 140–142 stays true: still a single root node.

Narrow the existing leaf assertion at `kinds/index.test.ts:54-55` after widening `RootCondition`:

```ts
const compiled = MONITOR_KIND_SPECS.process_resource.toAlertCondition(
  { resource: 'memory', processName: 'x', operator: 'gt', value: 1 }, { monitorId: 'm1' });
expect('type' in compiled).toBe(true);
if (!('type' in compiled)) throw new Error('Expected a leaf condition');
expect(compiled.type).toBe('process_memory_high');
```

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/monitors/kinds/ src/services/monitors/monitorCompiler.test.ts src/routes/monitorDefinitions.test.ts` and `cd apps/api && npx tsc --noEmit -p .` (the Task 1 registry error is gone). `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`. With a DB: `pnpm db:migrate && pnpm db:check-drift`.

- [ ] **Step 5: Commit**

`git add apps/api/migrations/2026-10-23-103000-monitor-kind-composite.sql apps/api/src/db/schema/monitorDefinitions.ts apps/api/src/services/monitors/kinds/ apps/api/src/services/monitors/monitorCompiler.ts && git commit -m "feat(monitors): composite kind — server-evaluated children compiled to an and/or group"`

### Task 3: `restart_service` parameters survive `normalizeAutomationActions` and drive the delivered watch (on top of #6343)

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts:330-336` (`ExecuteCommandAction`), `:671-684` (the `execute_command` arm of `normalizeAutomationActions` — after #6343 it already preserves `kind`; add the two numbers)
- Modify: `apps/api/src/routes/agents/helpers.ts:2063-2067` (`MONITOR_WATCH_DEFAULTS` stays as the fallback), `:2148-2156` (the watch push)
- Test: `apps/api/src/services/automationRuntime.test.ts` (next to line 98 "normalizes all supported action types"), `apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts` (next to line 272)

**Interfaces:**
- Consumes: `execute_command.maxAttempts` / `cooldownSeconds` (Task 1); `kind` preservation from #6343.
- Produces: `ExecuteCommandAction.kind?: 'restart_service'; maxAttempts?: number; cooldownSeconds?: number`; delivered watch fields `max_restart_attempts` / `restart_cooldown_seconds` read from the response.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/automationRuntime.test.ts`, after the test at line 112:

```ts
  it('keeps kind, maxAttempts and cooldownSeconds on execute_command (#6343 + W05c1 spec C9)', () => {
    const [action] = normalizeAutomationActions([
      { type: 'execute_command', command: 'Restart-Service Spooler', kind: 'restart_service', maxAttempts: 5, cooldownSeconds: 600 },
    ]);
    expect(action).toMatchObject({ type: 'execute_command', kind: 'restart_service', maxAttempts: 5, cooldownSeconds: 600 });

    const [plain] = normalizeAutomationActions([{ type: 'execute_command', command: 'echo ok' }]);
    expect(plain).not.toHaveProperty('maxAttempts');
    expect(plain).not.toHaveProperty('cooldownSeconds');
  });

  it('rejects out-of-range restart parameters', () => {
    expect(() => normalizeAutomationActions([{ type: 'execute_command', command: 'x', maxAttempts: 51 }])).toThrow(/maxAttempts/);
    expect(() => normalizeAutomationActions([{ type: 'execute_command', command: 'x', cooldownSeconds: 10 }])).toThrow(/cooldownSeconds/);
  });
```

`apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts`, after the test at line 282:

```ts
  it('reads max_restart_attempts / restart_cooldown_seconds from the restart_service response, defaulting 3 / 300 (W05c1 spec C9)', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ resolved: false }),
      [monitorDefRow({ responses: [{ type: 'execute_command', kind: 'restart_service', command: 'Restart-Service Spooler', maxAttempts: 7, cooldownSeconds: 900 }] })],
    ]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID);
    expect(out!.watches[0]).toMatchObject({ auto_restart: true, max_restart_attempts: 7, restart_cooldown_seconds: 900 });

    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ resolved: false }),
      [monitorDefRow({ responses: [{ type: 'execute_command', kind: 'restart_service', command: 'Restart-Service Spooler' }] })],
    ]);
    const defaults = await buildMonitoringConfigUpdate(DEVICE_ID);
    expect(defaults!.watches[0]).toMatchObject({ auto_restart: true, max_restart_attempts: 3, restart_cooldown_seconds: 300 });
  });
```

(`buildMonitoringConfigUpdate` caches per device in Redis for 120 s — the file's `getRedisImpl` mock is a no-op store; if the second call returns the first result, call `dbMock._resetQueue` AND use a second `DEVICE_ID` constant the way the file's other multi-call tests do.)

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/automationRuntime.test.ts src/routes/agents/helpers.monitorWatchDelivery.test.ts` → the runtime test fails "expected … to match object { maxAttempts: 5 }" (fields stripped); the watch test fails "expected 3 to be 7".

- [ ] **Step 3: Implement**

`apps/api/src/services/automationRuntime.ts:330-336`:

```ts
export type ExecuteCommandAction = {
  type: 'execute_command';
  command: string;
  shell?: 'bash' | 'powershell' | 'cmd';
  /** #5128 W4 — see RunScriptAction.whenOffline. */
  whenOffline?: 'queue' | 'skip';
  /** #6343 — explicit intent discriminator; the agent watch builder compiles it to auto_restart. */
  kind?: 'restart_service';
  /** W05c1 (spec C9): the watch's restart knobs, authored on the response. Defaults 3 / 300 at read time. */
  maxAttempts?: number;
  cooldownSeconds?: number;
};
```

`normalizeAutomationActions`, `execute_command` arm — keep #6343's `kind` line and add, before `normalized.push`:

```ts
      const maxAttempts = asFiniteInteger(action.maxAttempts);
      if (maxAttempts !== undefined && (maxAttempts < 0 || maxAttempts > 50)) {
        throw new AutomationValidationError(`actions[${index}] execute_command maxAttempts must be 0..50`);
      }
      const cooldownSeconds = asFiniteInteger(action.cooldownSeconds);
      if (cooldownSeconds !== undefined && (cooldownSeconds < 30 || cooldownSeconds > 86400)) {
        throw new AutomationValidationError(`actions[${index}] execute_command cooldownSeconds must be 30..86400`);
      }
      normalized.push({
        type: 'execute_command',
        command,
        shell: shell === 'bash' || shell === 'powershell' || shell === 'cmd' ? shell : undefined,
        whenOffline: asWhenOffline(action.whenOffline),
        ...(action.kind === 'restart_service' ? { kind: 'restart_service' as const } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(cooldownSeconds !== undefined ? { cooldownSeconds } : {}),
      });
```

with, next to `asString` / `asWhenOffline` in the same file:

```ts
function asFiniteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
```

(If #6343 spelled the `kind` spread differently, keep #6343's spelling and add only the two numeric spreads.)

`apps/api/src/routes/agents/helpers.ts:2148-2156` — replace the `auto_restart` / two constant lines with:

```ts
      // Spec §Responses + W05c1 C9: the restart_service response is the ONLY
      // source of the agent-side restart and its knobs. A free-text `command`
      // is never sniffed for intent.
      auto_restart: restart !== undefined,
      max_restart_attempts: restart?.maxAttempts ?? MONITOR_WATCH_DEFAULTS.maxRestartAttempts,
      restart_cooldown_seconds: restart?.cooldownSeconds ?? MONITOR_WATCH_DEFAULTS.restartCooldownSeconds,
```

and, above `watches.push({` in the same loop:

```ts
    const restart = (def.responses ?? []).find(
      (a): a is { type: 'execute_command'; kind: 'restart_service'; maxAttempts?: number; cooldownSeconds?: number } =>
        a?.type === 'execute_command' && a?.kind === 'restart_service',
    );
```

Update the comment on `MONITOR_WATCH_DEFAULTS` (2058–2062): "`maxRestartAttempts` / `restartCooldownSeconds` are the fallback when a `restart_service` response carries no explicit values (W05c1)".

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/automationRuntime src/routes/agents/helpers.monitorWatchDelivery.test.ts src/routes/agents/helpers.partnerWidePolicies.test.ts` (the substring pulls in every `automationRuntime.*.test.ts`; check the count is 11 files). `npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/automationRuntime.ts apps/api/src/services/automationRuntime.test.ts apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts && git commit -m "feat(monitors): restart_service maxAttempts/cooldownSeconds through normalizeActions to the delivered watch"`

**Task 3 addendum — `command` is optional for `kind: 'restart_service'`; the server-side dispatch is a recorded no-op.** Verified: `executeCommandAction` (`automationRuntime.ts:1598-1660`, reached from `:2128`) dispatches `command` to the device as an ad-hoc script with no special case for `kind`, and the agent restarts locally on its own (`agent/internal/monitoring/monitor.go:206-240`, `restartService` / `killProcess`). A legacy watch restarts ONCE, agent-side. A converted watch must not gain a second, server-side restart, and there is no OS-neutral restart command a policy spanning Windows and Linux could carry. So, in the same PR:

- `packages/shared/src/validators/automationActions.ts` (`execute_command` arm): `command: z.string().optional()` and, on the arm, `.refine((a) => a.kind === 'restart_service' || (a.command?.trim().length ?? 0) > 0, { message: 'command is required unless kind is restart_service', path: ['command'] })`. (If the discriminated union rejects a refined member in this zod version, keep the arm plain and put the same rule in a `superRefine` on `monitorResponsesSchema` and on `automationActionsSchema`'s array — `alertRuleConditions.ts:67-77` documents that refined/piped members DO work in this repo's zod 4, so try the arm first.)
- `automationRuntime.ts` `normalizeAutomationActions` `execute_command` arm: `if (!command && action.kind !== 'restart_service') throw …requires command`; push `command: command ?? ''`.
- `executeCommandAction` (`:1598`): first statement —

```ts
  if (action.kind === 'restart_service' && action.command.trim() === '') {
    // The agent performs the restart locally (auto_restart on the delivered
    // watch, routes/agents/helpers.ts). Nothing to dispatch; record why.
    return {
      outcome: { status: 'succeeded' },
      log: logEntry('restart_service handled by the agent watch; no server-side command', 'info', { actionIndex }),
    };
  }
```

  (`ActionExecutionOutcome` at `automationRuntime.ts:1340-1359` uses `{ status: 'succeeded' }`; `logEntry` is defined at `:1170`.)
- Tests: in `automationRuntime.test.ts` — `normalizeAutomationActions([{ type: 'execute_command', kind: 'restart_service' }])` yields `{ type: 'execute_command', kind: 'restart_service', command: '' }` and `normalizeAutomationActions([{ type: 'execute_command' }])` still throws `/requires command/`; in a new `automationRuntime.restartService.test.ts` (harness copied from `automationRuntime.runScript.test.ts`) — `executeCommandAction({ type: 'execute_command', kind: 'restart_service', command: '' }, 0, ctx)` resolves `outcome: { status: 'succeeded' }` and `dispatchScriptToDevice` is NOT called; with `command: 'Restart-Service Spooler'` it IS called (hand-authored monitors keep today's behaviour). Shared: `automationActionSchema.safeParse({ type: 'execute_command', kind: 'restart_service' }).success === true`, `{ type: 'execute_command' }` false.
- Commit with Task 3 (`feat(automations): execute_command command optional for restart_service; agent-local restart is not re-dispatched`).

### Task 4: `inheritance` persists on the `monitors` link and round-trips through assemble

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts:1117-1131` (`decomposeInlineSettings` `monitors` case — parse only; the value lives in `config_policy_feature_links.inline_settings`), `:1498-1513` (`assembleInlineSettings` `monitors` case)
- Test: `apps/api/src/routes/configurationPolicies/featureLinks.monitors.test.ts` (existing; add a round-trip case) or `apps/api/src/services/configurationPolicy.monitorsInheritance.test.ts` (create, Drizzle-mock)

**Interfaces:**
- Consumes: `monitorsInlineSettingsSchema` (Task 1).
- Produces: `GET /configuration-policies/:id/feature-links` returns `inlineSettings: { items, inheritance }` for `monitors` links; `PUT` accepts `inheritance`.

Fact: `addFeatureLink` (configurationPolicy.ts:1655-1720) and `updateFeatureLink` (:1752-1800) store the parsed `inlineSettings` object on the link row, and `listFeatureLinks` (:1946) returns `assembled ?? link.inlineSettings`. So `inheritance` is already persisted by Task 1's schema change; the only gap is that `assembleInlineSettings('monitors')` rebuilds `{ items }` from `config_policy_monitors` and drops the key whenever at least one attachment exists.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/configurationPolicy.monitorsInheritance.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ queue: [] as unknown[][] }));

vi.mock('../db', () => {
  const next = () => state.queue.shift() ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
  return { db: chain, withDbAccessContext: (_c: unknown, fn: () => unknown) => fn() };
});

import { listFeatureLinks } from './configurationPolicy';

describe('monitors link inheritance round-trip (W05c1)', () => {
  beforeEach(() => { state.queue = []; });

  it('returns inheritance from the link JSON when attachments exist', async () => {
    state.queue = [
      [{ id: 'link-1', configPolicyId: 'p1', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [], inheritance: 'replace' } }],
      [{ id: 'row-1', featureLinkId: 'link-1', monitorId: 'm1', enabled: true, overrides: null, sortOrder: 0 }],
      [{ inlineSettings: { items: [], inheritance: 'replace' } }],
    ];
    const [link] = await listFeatureLinks('p1');
    expect(link!.inlineSettings).toEqual({ items: [{ monitorId: 'm1', enabled: true, overrides: null, sortOrder: 0 }], inheritance: 'replace' });
  });

  it('defaults to cumulative for a link saved before W05c1', async () => {
    state.queue = [
      [{ id: 'link-1', configPolicyId: 'p1', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [] } }],
      [{ id: 'row-1', featureLinkId: 'link-1', monitorId: 'm1', enabled: true, overrides: null, sortOrder: 0 }],
      [{ inlineSettings: { items: [] } }],
    ];
    const [link] = await listFeatureLinks('p1');
    expect((link!.inlineSettings as { inheritance: string }).inheritance).toBe('cumulative');
  });
});
```

Use the direct-service automation-reference mocks from `apps/api/src/services/configurationPolicy.monitors.test.ts:6-37`, also supplied explicitly in Task 8; the route test mocks the service itself and cannot verify assembly. The queue order is links, attachment rows, link JSON.

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/configurationPolicy.monitorsInheritance.test.ts` → "expected { items: [...] } to equal { items: [...], inheritance: 'replace' }".

- [ ] **Step 3: Implement**

`assembleInlineSettings`, `case 'monitors'` (1498–1513):

```ts
    case 'monitors': {
      const rows = await executor
        .select()
        .from(configPolicyMonitors)
        .where(eq(configPolicyMonitors.featureLinkId, linkId))
        .orderBy(asc(configPolicyMonitors.sortOrder));
      // `inheritance` (W05c1) is not a per-attachment fact, so it has no
      // normalized column: it lives on the link's JSON and is re-attached here
      // so the read path never drops it once attachments exist.
      const [link] = await executor
        .select({ inlineSettings: configPolicyFeatureLinks.inlineSettings })
        .from(configPolicyFeatureLinks)
        .where(eq(configPolicyFeatureLinks.id, linkId))
        .limit(1);
      const inheritance = monitorsInheritanceSchema.catch('cumulative').parse(
        (link?.inlineSettings as { inheritance?: unknown } | null)?.inheritance,
      );
      if (rows.length === 0 && inheritance === 'cumulative') return null;
      return {
        items: rows.map((r) => ({
          monitorId: r.monitorId,
          enabled: r.enabled,
          overrides: r.overrides,
          sortOrder: r.sortOrder,
        })),
        inheritance,
      };
    }
```

Add `monitorsInheritanceSchema` to the `@breeze/shared` import at the top of the file. `decomposeInlineSettings` `monitors` case needs no change (it parses through `monitorsInlineSettingsSchema`, which now tolerates the key). `updateFeatureLink` on a `monitors` link: `inlineSettings` replaces the JSON wholesale, so a caller that sends `{ items }` without `inheritance` resets it to cumulative — that is the intended "one save pattern" (the whole tab is one form); W05c2 sends both keys.

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/configurationPolicy.monitorsInheritance.test.ts src/routes/configurationPolicies/featureLinks.monitors.test.ts src/routes/configurationPolicies/featureLinks.test.ts`. `npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.monitorsInheritance.test.ts && git commit -m "feat(config-policy): monitors link inheritance round-trips through assemble"`

### Task 5: `resolveMonitorsForDevice` honours `inheritance: replace` (on top of #6344) and exports its capability constant

**Files:**
- Modify: `apps/api/src/services/monitors/monitorResolver.ts` (`:149-171` assignments read — after #6344 it also carries `roleFilter`/`osFilter` conditions; `:181-198` attachments read gains `inlineSettings`; `:207-248` candidate build)
- Test: `apps/api/src/services/monitors/monitorResolver.test.ts` (pure cases next to `pickWinner`), `apps/api/src/__tests__/integration/monitorResolver.integration.test.ts` (one real-DB case, run in Task 18)

**Interfaces:**
- Produces: `export function selectContributingAttachments(args)` (pure, unit-tested) and `export const MONITOR_RESOLVER_CAPABILITIES = { roleOsFilters: true, inheritance: true } as const` (read by Task 9's prerequisite check; `roleOsFilters` is set in the SAME edit that the grep in Task 9 verifies, so it cannot be true without #6344's code present).
- Semantics (from Task 1's schema comment): sort assignments by hierarchy (level priority desc, priority asc, createdAt asc — `compareCandidates` order). Walk in that order. For a policy whose `monitors` link is **cumulative** (or absent): its own attachments and its parent's contribute, as today. For the **first** `replace` policy met: its own attachments contribute; its parent's do not; mark `replaceTaken`. Every later `replace` policy contributes nothing (own or parent). Cumulative policies after the first replace still contribute. Per monitor, `pickWinner` is unchanged.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/monitors/monitorResolver.test.ts`, append:

```ts
import { selectContributingAttachments, MONITOR_RESOLVER_CAPABILITIES } from './monitorResolver';

describe('inheritance: replace (W05c1, spec §Inheritance correction)', () => {
  const assignment = (policyId: string, level: 'organization' | 'site' | 'partner', parentPolicyId: string | null = null, priority = 0) => ({
    policyId, parentPolicyId, level, priority, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const row = (configPolicyId: string, monitorId: string) => ({ configPolicyId, monitorId, enabled: true, overrides: null });

  it('among replace links only the closest contributes; cumulative links still add; a replace policy never consults its parent', () => {
    const assignments = [
      assignment('partner-p', 'partner'),          // cumulative: built-ins
      assignment('org-p', 'organization', 'org-parent'), // replace: converted org rules
      assignment('site-p', 'site'),                // replace: converted site rules
    ];
    const byPolicy = new Map([
      ['partner-p', [row('partner-p', 'builtin-cpu')]],
      ['org-p', [row('org-p', 'org-rule-1')]],
      ['org-parent', [row('org-parent', 'parent-rule')]],
      ['site-p', [row('site-p', 'site-rule-1')]],
    ]);
    const inheritance = new Map([['org-p', 'replace' as const], ['site-p', 'replace' as const]]);

    const contributed = selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy: inheritance });
    const ids = contributed.map((c) => `${c.sourcePolicyId}:${c.monitorId}:${c.inheritedFromParent ? 'parent' : 'own'}`).sort();
    expect(ids).toEqual(['partner-p:builtin-cpu:own', 'site-p:site-rule-1:own']);
  });

  it('an empty replace attachment set continues to shadow inherited monitors', () => {
    const assignments = [assignment('child', 'site', 'parent')];
    const byPolicy = new Map([['parent', [row('parent', 'cpu')]]]);
    expect(selectContributingAttachments({ assignments, byPolicy,
      inheritanceByPolicy: new Map([['child', 'replace']]) })).toEqual([]);
  });
  it('cumulative everywhere reproduces today\'s behaviour (own + parent for every assignment)', () => {
    const assignments = [assignment('org-p', 'organization', 'org-parent'), assignment('site-p', 'site')];
    const byPolicy = new Map([
      ['org-p', [row('org-p', 'm1')]],
      ['org-parent', [row('org-parent', 'm2')]],
      ['site-p', [row('site-p', 'm3')]],
    ]);
    const contributed = selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy: new Map() });
    expect(contributed.map((c) => c.monitorId).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('declares the capabilities the converter checks', () => {
    expect(MONITOR_RESOLVER_CAPABILITIES).toEqual({ roleOsFilters: true, inheritance: true });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/monitors/monitorResolver.test.ts` → "does not provide an export named 'selectContributingAttachments'".

- [ ] **Step 3: Implement**

In `monitorResolver.ts`, after `pickWinner`:

```ts
import { monitorsInheritanceSchema, type MonitorsInheritance } from '@breeze/shared';

/**
 * Proof-of-presence for the converter's prerequisite check (spec §Risks, last
 * row). `roleOsFilters` is true because this module applies assignment
 * roleFilter/osFilter (#6344) — the grep in conversion/prerequisites.test.ts
 * pins that the filter helper is referenced here. `inheritance` is W05c1.
 */
export const MONITOR_RESOLVER_CAPABILITIES = { roleOsFilters: true, inheritance: true } as const;

type AssignmentRow = {
  policyId: string;
  parentPolicyId: string | null;
  level: string;
  priority: number;
  createdAt: Date;
};
type AttachmentRow = {
  configPolicyId: string;
  monitorId: string;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
};

function compareAssignments(a: AssignmentRow, b: AssignmentRow): number {
  const levelDiff = LEVEL_PRIORITY[b.level as AssignmentLevel] - LEVEL_PRIORITY[a.level as AssignmentLevel];
  if (levelDiff !== 0) return levelDiff;
  const priorityDiff = a.priority - b.priority;
  if (priorityDiff !== 0) return priorityDiff;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Which attachment rows compete for this device (W05c1 §Inheritance correction).
 *
 * Walk assignments closest-first. A CUMULATIVE policy contributes its own rows
 * and its parent's (today's behaviour). The FIRST REPLACE policy contributes
 * its own rows only — its parent is not consulted — and every later REPLACE
 * policy contributes nothing. Cumulative policies after it still add. This is
 * exactly how the legacy `alert_rule` feature was selected (closest policy
 * holding the feature wins, whole-feature), applied only to links that opted
 * in, so partner-wide built-ins attached cumulatively keep reaching the device.
 */
export function selectContributingAttachments(args: {
  assignments: AssignmentRow[];
  byPolicy: Map<string, AttachmentRow[]>;
  inheritanceByPolicy: Map<string, MonitorsInheritance>;
}): MonitorCandidate[] {
  const out: MonitorCandidate[] = [];
  const add = (row: AttachmentRow, assignment: AssignmentRow, inheritedFromParent: boolean) => {
    out.push({
      monitorId: row.monitorId,
      enabled: row.enabled,
      overrides: row.overrides ?? null,
      sourcePolicyId: row.configPolicyId,
      sourceLevel: assignment.level as AssignmentLevel,
      inheritedFromParent,
      priority: assignment.priority,
      assignedAt: assignment.createdAt.getTime(),
    });
  };
  let replaceTaken = false;
  for (const assignment of [...args.assignments].sort(compareAssignments)) {
    const mode = args.inheritanceByPolicy.get(assignment.policyId) ?? 'cumulative';
    if (mode === 'replace') {
      if (replaceTaken) continue;
      replaceTaken = true;
      for (const row of args.byPolicy.get(assignment.policyId) ?? []) add(row, assignment, false);
      continue;
    }
    for (const row of args.byPolicy.get(assignment.policyId) ?? []) add(row, assignment, false);
    if (assignment.parentPolicyId) {
      for (const row of args.byPolicy.get(assignment.parentPolicyId) ?? []) add(row, assignment, true);
    }
  }
  return out;
}
```

In `resolveMonitorsForDevice`: extend the attachments select (181–198) with `inlineSettings: configPolicyFeatureLinks.inlineSettings` and build the inheritance map while grouping:

```ts
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
```

A `replace` link with ZERO attachment rows must still shadow: it has no `config_policy_monitors` row, so it is invisible to the join above. Add one more read after it:

```ts
  const replaceLinks = await executor
    .select({ configPolicyId: configPolicyFeatureLinks.configPolicyId })
    .from(configPolicyFeatureLinks)
    .where(and(
      inArray(configPolicyFeatureLinks.configPolicyId, [...policyIds]),
      eq(configPolicyFeatureLinks.featureType, 'monitors'),
      sql`${configPolicyFeatureLinks.inlineSettings} ->> 'inheritance' = 'replace'`,
    ));
  for (const r of replaceLinks) inheritanceByPolicy.set(r.configPolicyId, 'replace');
```

Then replace the `candidates` construction (207–236) with:

```ts
  const candidates = new Map<string, MonitorCandidate[]>();
  for (const candidate of selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy })) {
    const list = candidates.get(candidate.monitorId) ?? [];
    list.push(candidate);
    candidates.set(candidate.monitorId, list);
  }
```

Keep #6344's role/OS filtering exactly where it put it (the assignments read). Update the module doc comment (lines 12–25) to mention the replace mode.

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/monitors/monitorResolver.test.ts src/services/alertService src/routes/agents/helpers.monitorWatchDelivery.test.ts` (the resolver is mocked in most callers; the substring run confirms no caller broke on the new export). `npx tsc --noEmit -p .`. Add the integration case now (it runs under Task 18): in `apps/api/src/__tests__/integration/monitorResolver.integration.test.ts` add a test that creates partner policy (cumulative, built-in attached), org policy (`inheritance: 'replace'`, monitor A attached, parent policy with monitor P attached) and site policy (`replace`, monitor B), assigns all three to one device, and asserts `resolveMonitorsForDevice` returns exactly `{builtin, B}` — never A or P.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/monitors/monitorResolver.ts apps/api/src/services/monitors/monitorResolver.test.ts apps/api/src/__tests__/integration/monitorResolver.integration.test.ts && git commit -m "feat(monitors): resolver honours monitors-link inheritance=replace; capability constant for the converter"`

**PR1 gate:** `cd apps/api && npx tsc --noEmit -p . && npx vitest run`; `cd packages/shared && npx vitest run`; `cd apps/web && npx vitest run src/components/monitoring src/locales`. Open PR1 (`Refs #<wave>`).

## PR2 — retirement columns, ledger, RLS, readers (Tasks 6–8)

### Task 6: Ledger tables `monitor_conversions` / `monitor_conversion_outputs` — migration, Drizzle schema, every registration list

**Files:**
- Create: `apps/api/migrations/2026-10-23-110000-monitor-conversions.sql`
- Create: `apps/api/src/db/schema/monitorConversions.ts`
- Modify: `apps/api/src/db/schema/index.ts:165-166` (add `export * from './monitorConversions';`)
- Modify: `apps/api/src/services/tenantCascade.ts:558-569` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:387` (two entries before `monitor_definitions`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:349-365` (`DUAL_AXIS_TENANT_TABLES`), `:686-691` (`XOR_OWNERSHIP_DUAL_AXIS_TABLES`)
- Test: `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts` (existing, auto-discover); the live contract suites run in Task 18 — but the red-first step here is the cascade **unit** guard: `apps/api/src/services/tenantCascade.test.ts:139` (existing membership guard).

**Interfaces:**
- Produces: tables (below); Drizzle `monitorConversions`, `monitorConversionOutputs`, types `MonitorConversionRow`, `MonitorConversionOutputRow`, `MONITOR_CONVERSION_SOURCE_TABLES`, `MONITOR_CONVERSION_OUTPUT_ROLES`.
- Consumed by: Tasks 11–16, W05d, W05e (`'network_monitors'` is already a legal `source_table`).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` `DUAL_AXIS_TENANT_TABLES` (after `'monitor_definitions'`):

```ts
  // monitor_conversions / monitor_conversion_outputs (W05c1, alerting
  // consolidation §Conversion): the ledger of legacy-row → monitor conversions.
  // Owned on the SAME axis as the converted policy (org-owned policy → org
  // ledger row; partner-wide policy → partner row), so org XOR partner from day
  // one in 2026-10-23-110000-monitor-conversions with the partner-wide SELECT
  // branch in the same migration. CHECK monitor_conversions_one_owner_chk /
  // monitor_conversion_outputs_one_owner_chk. Functional forge proof:
  // monitorConversionsPartnerRls.integration.test.ts (Task 18).
  'monitor_conversions',
  'monitor_conversion_outputs',
```

and to `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (after `'monitor_definitions'`):

```ts
  // monitor_conversions_one_owner_chk / monitor_conversion_outputs_one_owner_chk,
  // 2026-10-23-110000 (W05c1). Partner-wide SELECT branch ships in the same file.
  'monitor_conversions',
  'monitor_conversion_outputs',
```

`apps/api/src/services/tenantCascade.ts` — insert before `'monitor_definitions'` (line 562), keeping the alphabetical rule (`localeCompare`: `monitor_conversion_outputs` < `monitor_conversions` < `monitor_definitions`):

```ts
  // W05c1 conversion ledger. outputs → conversions (ON DELETE CASCADE) and
  // conversions.policy_id → configuration_policies (SET NULL), outputs.monitor_id
  // → monitor_definitions (SET NULL): alphabetical order is also child-before-
  // parent here.
  'monitor_conversion_outputs',
  'monitor_conversions',
```

`apps/api/src/services/tenantExportPolicyRegistry.ts` — insert before the `"monitor_definitions"` line:

```ts
  "monitor_conversion_outputs": tablePolicy("org_id", {"included":["id","conversion_id","org_id","partner_id","monitor_id","role","reused_monitor","source_rule_id","policy_id","attachment_id","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["moved_alert_ids","moved_alert_refs"]}),
  "monitor_conversions": tablePolicy("org_id", {"included":["id","org_id","partner_id","source_table","source_id","policy_id","converted_by","converted_at","reverted_at","created_at"],"reviewedIncluded":["preview_hash"],"excludedSensitive":[],"excludedOpen":["source_state"]}),
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/tenantCascade.test.ts src/services/tenantExportPolicyRegistry` (static unit checks, if present: "unknown table monitor_conversions" / schema-name mismatch). With `pnpm test-stack up`: `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts` → "relation monitor_conversions does not exist" / "table listed in CORE_ORG_CASCADE_DELETE_ORDER does not exist".

- [ ] **Step 3: Implement**

`apps/api/migrations/2026-10-23-110000-monitor-conversions.sql`:

```sql
-- Alerting consolidation W05c1 (spec §Conversion, §Tenancy and safety):
-- the conversion ledger. One `monitor_conversions` row per converted legacy
-- source row (an alert_templates source is the entire template/rules group) (idempotent on (source_table, source_id) while un-reverted); one
-- `monitor_conversion_outputs` row per monitor that conversion produced
-- (a watch can produce up to three: primary + resource_cpu + resource_memory).
--
-- Tenancy: both tables are owned on the SAME axis as the converted policy —
-- org_id XOR partner_id (CLAUDE.md "Partner-Wide First"), one dual-axis FOR
-- ALL policy, and a SEPARATE, additive FOR SELECT partner-wide branch keyed
-- on breeze_current_partner_id() (template: 2026-10-05-110000-config-policy-
-- partner-wide-select.sql; same shape as 2026-10-16-160300-monitor-definitions).
-- The outputs table denormalises the owner axes so it can sit in the org
-- cascade list in its own right; its composite FK (conversion_id, org_id) is
-- DEFERRABLE INITIALLY IMMEDIATE because org merge re-points org_id on parent
-- and child in separate statements under SET CONSTRAINTS ALL DEFERRED.
--
-- Idempotent (IF NOT EXISTS / DO $$ guards / DROP POLICY IF EXISTS + CREATE).
-- No inner BEGIN/COMMIT. No DML, so no breeze.scope elevation.
-- Rollback: a new migration dropping the two tables.

CREATE TABLE IF NOT EXISTS monitor_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  policy_id uuid REFERENCES configuration_policies(id) ON DELETE SET NULL,
  converted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  converted_at timestamptz NOT NULL DEFAULT now(),
  preview_hash text NOT NULL,
  source_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  reverted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversions_one_owner_chk') THEN
    ALTER TABLE monitor_conversions
      ADD CONSTRAINT monitor_conversions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversions_source_table_chk') THEN
    ALTER TABLE monitor_conversions
      ADD CONSTRAINT monitor_conversions_source_table_chk CHECK (source_table IN (
        'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_templates',
        'automations', 'config_policy_automations', 'network_monitors'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS monitor_conversions_org_id_idx ON monitor_conversions(org_id);
CREATE INDEX IF NOT EXISTS monitor_conversions_partner_id_idx ON monitor_conversions(partner_id);
CREATE INDEX IF NOT EXISTS monitor_conversions_policy_id_idx ON monitor_conversions(policy_id) WHERE policy_id IS NOT NULL;
-- Idempotency: one LIVE conversion per source row.
CREATE UNIQUE INDEX IF NOT EXISTS monitor_conversions_live_source_uidx
  ON monitor_conversions(source_table, source_id) WHERE reverted_at IS NULL;
-- Referenced by the outputs composite FK below (a non-partial unique index is a valid FK target).
CREATE UNIQUE INDEX IF NOT EXISTS monitor_conversions_id_org_uidx ON monitor_conversions(id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_conversions_id_partner_uidx ON monitor_conversions(id, partner_id);

ALTER TABLE monitor_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_conversions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS monitor_conversions_isolation ON monitor_conversions;
CREATE POLICY monitor_conversions_isolation
  ON monitor_conversions
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS monitor_conversions_partner_wide_select ON monitor_conversions;
CREATE POLICY monitor_conversions_partner_wide_select
  ON monitor_conversions
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_conversions TO breeze_app;

CREATE TABLE IF NOT EXISTS monitor_conversion_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversion_id uuid NOT NULL REFERENCES monitor_conversions(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE SET NULL,
  role text NOT NULL,
  moved_alert_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  moved_alert_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  reused_monitor boolean NOT NULL DEFAULT false,
  source_rule_id uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  policy_id uuid REFERENCES configuration_policies(id) ON DELETE SET NULL,
  attachment_id uuid REFERENCES config_policy_monitors(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_one_owner_chk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_role_chk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_role_chk
      CHECK (role IN ('primary', 'resource_cpu', 'resource_memory', 'response'));
  END IF;
  -- Org-merge contract: every composite FK carrying org_id is DEFERRABLE INITIALLY IMMEDIATE.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_conversion_org_fk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_conversion_org_fk
      FOREIGN KEY (conversion_id, org_id) REFERENCES monitor_conversions(id, org_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_conversion_outputs_conversion_partner_fk') THEN
    ALTER TABLE monitor_conversion_outputs
      ADD CONSTRAINT monitor_conversion_outputs_conversion_partner_fk
      FOREIGN KEY (conversion_id, partner_id) REFERENCES monitor_conversions(id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_conversion_id_idx ON monitor_conversion_outputs(conversion_id);
CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_org_id_idx ON monitor_conversion_outputs(org_id);
CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_partner_id_idx ON monitor_conversion_outputs(partner_id);
CREATE INDEX IF NOT EXISTS monitor_conversion_outputs_monitor_id_idx ON monitor_conversion_outputs(monitor_id) WHERE monitor_id IS NOT NULL;

ALTER TABLE monitor_conversion_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_conversion_outputs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS monitor_conversion_outputs_isolation ON monitor_conversion_outputs;
CREATE POLICY monitor_conversion_outputs_isolation
  ON monitor_conversion_outputs
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS monitor_conversion_outputs_partner_wide_select ON monitor_conversion_outputs;
CREATE POLICY monitor_conversion_outputs_partner_wide_select
  ON monitor_conversion_outputs
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_conversion_outputs TO breeze_app;
```

`apps/api/src/db/schema/monitorConversions.ts`:

```ts
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { configurationPolicies } from './configurationPolicies';
import { alertRules } from './alerts';
import { monitorDefinitions, configPolicyMonitors } from './monitorDefinitions';

/**
 * Alerting consolidation W05c1 — the conversion ledger (spec §Conversion).
 * Owned on the same axis as the converted policy: org_id XOR partner_id
 * (`*_one_owner_chk` in 2026-10-23-110000-monitor-conversions.sql).
 */
export const MONITOR_CONVERSION_SOURCE_TABLES = [
  'config_policy_alert_rules',
  'config_policy_monitoring_watches',
  'alert_templates',
  'automations',
  'config_policy_automations',
  'network_monitors', // W05e
] as const;
export type MonitorConversionSourceTable = (typeof MONITOR_CONVERSION_SOURCE_TABLES)[number];

export const MONITOR_CONVERSION_OUTPUT_ROLES = ['primary', 'resource_cpu', 'resource_memory', 'response'] as const;
export type MonitorConversionOutputRole = (typeof MONITOR_CONVERSION_OUTPUT_ROLES)[number];

export const monitorConversions = pgTable(
  'monitor_conversions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    sourceTable: text('source_table').$type<MonitorConversionSourceTable>().notNull(),
    sourceId: uuid('source_id').notNull(),
    policyId: uuid('policy_id').references(() => configurationPolicies.id, { onDelete: 'set null' }),
    convertedBy: uuid('converted_by').references(() => users.id, { onDelete: 'set null' }),
    convertedAt: timestamp('converted_at', { withTimezone: true }).defaultNow().notNull(),
    previewHash: text('preview_hash').notNull(),
    sourceState: jsonb('source_state').notNull().default({}).$type<Record<string, unknown>>(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('monitor_conversions_org_id_idx').on(table.orgId),
    partnerIdIdx: index('monitor_conversions_partner_id_idx').on(table.partnerId),
    liveSourceUidx: uniqueIndex('monitor_conversions_live_source_uidx')
      .on(table.sourceTable, table.sourceId)
      .where(sql`${table.revertedAt} IS NULL`),
    idOrgUidx: uniqueIndex('monitor_conversions_id_org_uidx').on(table.id, table.orgId),
    idPartnerUidx: uniqueIndex('monitor_conversions_id_partner_uidx').on(table.id, table.partnerId),
  }),
);

export const monitorConversionOutputs = pgTable(
  'monitor_conversion_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversionId: uuid('conversion_id')
      .notNull()
      .references(() => monitorConversions.id, { onDelete: 'cascade' }),
    // Denormalised owner axes (same XOR as the parent). The composite FK
    // (conversion_id, org_id) and (conversion_id, partner_id) deferrable FKs
    // live in SQL; Task 18 tests them against Postgres. Drift checks filenames only.
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    monitorId: uuid('monitor_id').references(() => monitorDefinitions.id, { onDelete: 'set null' }),
    role: text('role').$type<MonitorConversionOutputRole>().notNull(),
    movedAlertIds: jsonb('moved_alert_ids').notNull().default([]).$type<string[]>(),
    movedAlertRefs: jsonb('moved_alert_refs').notNull().default([]).$type<Array<{
      id: string; ruleId: string | null; configPolicyId: string | null;
      monitorId: string | null; context: Record<string, unknown> | null;
    }>>(),
    reusedMonitor: boolean('reused_monitor').notNull().default(false),
    sourceRuleId: uuid('source_rule_id').references(() => alertRules.id, { onDelete: 'set null' }),
    policyId: uuid('policy_id').references(() => configurationPolicies.id, { onDelete: 'set null' }),
    attachmentId: uuid('attachment_id').references(() => configPolicyMonitors.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    conversionIdIdx: index('monitor_conversion_outputs_conversion_id_idx').on(table.conversionId),
    orgIdIdx: index('monitor_conversion_outputs_org_id_idx').on(table.orgId),
    partnerIdIdx: index('monitor_conversion_outputs_partner_id_idx').on(table.partnerId),
  }),
);

export type MonitorConversionRow = typeof monitorConversions.$inferSelect;
export type MonitorConversionOutputRow = typeof monitorConversionOutputs.$inferSelect;
```

`apps/api/src/db/schema/index.ts` — add `export * from './monitorConversions';` after the `monitorEpisodes` export.

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/tenantCascade.test.ts src/services/tenantExportPolicyRegistry` and `npx tsc --noEmit -p .`. With the stack: `pnpm db:migrate && pnpm db:check-drift`, then `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts`. Forge as `breeze_app`: `docker exec -it <test-stack pg> psql -U breeze_app -d breeze -c "SELECT set_config('breeze.scope','organization',false); INSERT INTO monitor_conversions (org_id, source_table, source_id, preview_hash) VALUES ('<other org>', 'alert_templates', gen_random_uuid(), 'x');"` → `new row violates row-level security policy`.

- [ ] **Step 5: Commit**

`git add apps/api/migrations/2026-10-23-110000-monitor-conversions.sql apps/api/src/db/schema/monitorConversions.ts apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts && git commit -m "feat(monitors): conversion ledger tables with dual-axis RLS and registrations"`

### Task 7: Retirement columns on the six legacy tables

**Files:**
- Create: `apps/api/migrations/2026-10-23-120000-legacy-source-retirement-columns.sql`
- Modify: `apps/api/src/db/schema/alerts.ts:44-74` (`alertTemplates`), `:83-101` (`alertRules`); `apps/api/src/db/schema/automations.ts:44-79` (`automations`); `apps/api/src/db/schema/configurationPolicies.ts:190-215` (`configPolicyAlertRules`), `:218-235` (`configPolicyAutomations`), `:406-436` (`configPolicyMonitoringWatches`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:124,125,142` (`alert_rules`, `alert_templates`, `automations` gain three `included` columns)
- Test: `apps/api/src/db/autoMigrate.test.ts`, `migrationRlsScope.test.ts` (auto); `tenant-export-policy.integration.test.ts` (live)

- Modify: `apps/api/src/services/monitors/monitorService.ts:119-153,239-290` (executor-aware create and nullable actor); test `apps/api/src/services/monitors/monitorService.test.ts`.
- Modify: `apps/api/src/services/monitors/monitorCompiler.ts:32-33,287-291` (export existing executor type; own the one `CompileOptions` type and optional compiler argument).
- Modify: `apps/api/src/services/configurationPolicy.ts:281-298,1963-1990` (nullable creation/assignment actors); `apps/api/src/db/schema/monitorDefinitions.ts:91` (verify existing nullable declaration).

**Interfaces:**
- Produces: compiler-owned `DbExecutor` and `CompileOptions`, `compileMonitorInTx(tx, def, _options: CompileOptions = {})`, and `createMonitorDefinition(input, auth, options: CompileOptions = {}, executor: DbExecutor = db)`; W05c2 Task 16 retains these signatures and forwards helper options.
- Produces: on each of the six tables `retiredAt: timestamp('retired_at', { withTimezone: true })`, `retiredReason: text('retired_reason')`, `convertedToMonitorId: uuid('converted_to_monitor_id')` (FK `→ monitor_definitions(id) ON DELETE SET NULL` in SQL only, like `managedByMonitorId`, to keep schema imports acyclic). `RETIRED_REASON` vocabulary (Task 9): `'converted' | 'unconvertible:<code>' | 'operator'`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/tenantExportPolicyRegistry.ts` the three columns on each of the three org-cascade tables — `"alert_rules"` `included` gains `"retired_at","retired_reason","converted_to_monitor_id"`; same for `"alert_templates"` and `"automations"`. This is the red: `tenant-export-policy.integration.test.ts` fails "policy names column retired_at which does not exist on alert_rules" until the migration lands.

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts` → the column-existence assertion fails for the three tables.

- [ ] **Step 3: Implement**

`apps/api/migrations/2026-10-23-120000-legacy-source-retirement-columns.sql`:

```sql
-- Alerting consolidation W05c1 (spec §Data model "Retirement columns").
-- A converted (or operator-retired) legacy source row is RETIRED IN PLACE,
-- never deleted: alert history keeps its FK (alerts.rule_id,
-- alerts.config_policy_id) and the ledger can revert. Every evaluator,
-- resolver, agent-config builder and list adds `retired_at IS NULL` (W05c1
-- Task 8). retired_reason: 'converted' | 'unconvertible:<code>' | 'operator'.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / pg_constraint guards). No DML, no
-- inner BEGIN/COMMIT. Rollback: a new migration dropping the three columns.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_rules',
    'alert_templates', 'automations', 'config_policy_automations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS retired_at timestamptz', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS retired_reason text', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS converted_to_monitor_id uuid', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_converted_to_monitor_fk') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (converted_to_monitor_id) REFERENCES public.monitor_definitions(id) ON DELETE SET NULL',
        t, t || '_converted_to_monitor_fk'
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_retired_reason_chk') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (retired_reason IS NULL OR retired_at IS NOT NULL)',
        t, t || '_retired_reason_chk'
      );
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (retired_at) WHERE retired_at IS NOT NULL', t || '_retired_at_idx', t);
  END LOOP;
END $$;
```

Drizzle — add to each of the six table definitions (place after `managedByMonitorId` where it exists, else before `createdAt`):

```ts
  // W05c1 retirement (2026-10-23-120000-legacy-source-retirement-columns.sql):
  // converted or operator-retired rows stay for history; every reader filters
  // `retired_at IS NULL`. FK → monitor_definitions ON DELETE SET NULL in SQL.
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  retiredReason: text('retired_reason'),
  convertedToMonitorId: uuid('converted_to_monitor_id'),
```

(`configurationPolicies.ts` and `automations.ts` already import `text`, `timestamp`, `uuid`; `alerts.ts` too — verify with the tsc run.)

Add to `monitorService.test.ts` using the existing create-definition test fixture and mocks: call `createMonitorDefinition(input, { ...auth, scope: 'system' }, {}, tx)` and assert the insert's `createdBy` is null and the supplied executor performs every owner/reference/insert/compile read. Add this direct schema assertion to the retirement migration's test:

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('allows the system sweep to omit actor FKs', () => {
  const sql = readFileSync(new URL('../../migrations/2026-10-23-120000-legacy-source-retirement-columns.sql', import.meta.url), 'utf8');
  expect(sql).toContain('ALTER TABLE monitor_definitions ALTER COLUMN created_by DROP NOT NULL');
});
```

System actor contract (D7): `monitor_definitions.created_by` is already nullable (`db/schema/monitorDefinitions.ts:91`), as are `configuration_policies.created_by`, `config_policy_assignments.assigned_by` and `automations.created_by`. Add the idempotent safety DDL to this migration (it is a no-op on this tree):

```sql
ALTER TABLE monitor_definitions ALTER COLUMN created_by DROP NOT NULL;
```

In `monitorCompiler.ts`, export the existing executor alias and define the single compiler-owned options type. Preserve the existing compiler body; its optional third argument is reserved for W05e. W05c2 Task 16 consumes these declarations without redeclaring them:

```ts
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbExecutor = typeof db | DbTx;
export type CompileOptions = Record<string, never>;
// Existing implementation signature (body unchanged):
export async function compileMonitorInTx(
  tx: DbTx, def: MonitorDefinitionRow, _options: CompileOptions = {},
): Promise<CompiledRefs> {
```

In `monitorService.ts`, replace its compiler import with `import { compileMonitorInTx, type CompileOptions, type DbExecutor } from './monitorCompiler';`. Do not declare a second options/executor type in this file. In `monitorService.ts:239-284`, retain the four-argument executor contract for every caller (D8); make the owner/reference reads executor-aware as well as the insert/compile. W05e extends the compiler's `CompileOptions`; never collapse argument four:

```ts
export async function createMonitorDefinition(
  input: CreateMonitorDefinitionInput, auth: AuthContext,
  options: CompileOptions = {}, executor: DbExecutor = db,
): Promise<MonitorDefinitionRow> {
  const owner = resolveOwnerForCreate(input, auth);
  await assertEscalationPolicyCompatible(input.escalationPolicyId ?? null, owner, executor);
  const shape = validateDefinitionShape({ kind: input.kind, condition: input.condition,
    responses: input.responses, recurrenceActions: input.recurrenceActions, aiAgentId: input.aiAgentId ?? null });
  // Retain the existing :255-283 insert fields, replacing createdBy with:
  // createdBy: auth.scope === 'system' ? null : auth.user.id
  // and replace db.transaction(...) with executor.transaction(...).
  return createValidatedMonitorInTx(input, auth, owner, shape, options, executor);
}
```

Extract the existing transaction body at `monitorService.ts:253-290` into `createValidatedMonitorInTx` with these exact inferred parameters (the body stays verbatim except the actor and executor):

```ts
async function createValidatedMonitorInTx(
  input: CreateMonitorDefinitionInput, auth: AuthContext,
  owner: ReturnType<typeof resolveOwnerForCreate>, shape: ReturnType<typeof validateDefinitionShape>,
  _options: CompileOptions, executor: DbExecutor,
): Promise<MonitorDefinitionRow> {
  return executor.transaction(async (tx) => {
    const [created] = await tx.insert(monitorDefinitions).values({
      ...input, orgId: owner.orgId, partnerId: owner.partnerId,
      condition: shape.condition, responses: shape.responses as Array<Record<string, unknown>>,
      recurrenceActions: shape.recurrenceActions as Array<Record<string, unknown>>,
      createdBy: auth.scope === 'system' ? null : auth.user.id,
    }).returning();
    if (!created) throw new Error('Failed to create monitor definition');
    const refs = await compileMonitorInTx(tx, created);
    return { ...created, compiledAlertTemplateId: refs.alertTemplateId,
      compiledAlertRuleId: refs.alertRuleId, compiledAutomationId: refs.automationId, compiledHash: refs.hash };
  });
}
```

`assertEscalationPolicyCompatible` (`monitorService.ts:119-153`) gains `executor: DbExecutor = db` and uses `executor.select()`. `createConfigPolicy` (`configurationPolicy.ts:281-298`) and `assignPolicy` (`:1963-1990`) accept `userId: string | null`. All conversion writers pass `auth.scope === 'system' ? null : auth.user.id`; the compiler already copies `def.createdBy` when creating its automation. Add `monitorService.ts`, its existing test, `configurationPolicy.ts` and `monitorDefinitions.ts` to this task's Files/commit inventory. The live final test creates a system conversion in a DB without a zero-UUID user and asserts both monitor and ledger actors are null. W05c2 Task 16 retains these create/helper signatures, renames `_options` to `options` in `createValidatedMonitorInTx`, and forwards it to `compileMonitorInTx(tx, created, options)`; its executor changes apply only to the remaining update path. It must not patch the removed create-body transaction anchor or duplicate the compiler-owned types.

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/monitors/monitorService.test.ts src/services/monitors/monitorCompiler.test.ts && npx tsc --noEmit -p .`; with the stack: `pnpm db:migrate && pnpm db:check-drift && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts`.

- [ ] **Step 5: Commit**

`git add apps/api/migrations/2026-10-23-120000-legacy-source-retirement-columns.sql apps/api/src/db/schema/alerts.ts apps/api/src/db/schema/automations.ts apps/api/src/db/schema/configurationPolicies.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/monitors/monitorService.ts apps/api/src/services/monitors/monitorService.test.ts apps/api/src/services/monitors/monitorCompiler.ts apps/api/src/db/schema/monitorDefinitions.ts apps/api/src/services/configurationPolicy.ts && git commit -m "feat(alerts): retirement columns on the six legacy alert-authoring tables"`

### Task 8: Exclude retired execution after shared automation election; preserve retired rows across re-save

**Files:**
- Modify: `apps/api/src/services/featureConfigResolver.ts:345-360` (`resolveGoverningAlertRulePolicyForDevice` rules join), `:419-422` (`resolveAlertRulesForDevice`), `:499-502` (`resolveAutomationsForDeviceWithPolicy`), `:1408-1440` (`scanScheduledAutomations`)
- Modify: `apps/api/src/services/alertService.ts:893-902` (`getApplicableRules`)
- Modify: `apps/api/src/services/notificationDispatcher.ts:270-299` (both transitional legacy override lookups in `processAlertNotifications`); test `apps/api/src/services/notificationDispatcher.configPolicyOverrides.test.ts:22-42,142-212`.
- Modify: `apps/api/src/services/offlineAlertEffects.ts:29-36` (rule read), `:64-66` (`prepareRule` existence check)
- Modify: `apps/api/src/routes/agents/helpers.ts:2339-2346` (policy watches)
- Modify: `apps/api/src/jobs/automationWorker.ts:495-499` (`processTriggerEvent`), `:849` (scheduled-source recheck), `:1171-1174` (event fan-out candidates), `:1228-1231` (policy automations loop)
- Modify: `apps/api/src/routes/alerts/rules.ts:173-179` (+ query schema in `routes/alerts/schemas.ts`), `apps/api/src/routes/alertTemplates/helpers.ts:45-59` (`getAllTemplates`), `apps/api/src/routes/automations.ts:677-700` (list conditions)
- Modify: `apps/api/src/services/configurationPolicy.ts:907-912` (`decompose` `monitoring` → upsert settings), `:1192-1233` (`deleteNormalizedRows`), `:1271-1276`, `:1296-1300`, `:1437-1441` (`assembleInlineSettings`)
- Test: `apps/api/src/services/featureConfigResolver.effectiveLinks.test.ts` and `apps/api/src/jobs/automationWorker.executionIdentity.test.ts` (existing election/schedule harnesses).
- Test: `apps/api/src/services/retiredSourceReaders.contract.test.ts` (create — static, no DB), `apps/api/src/services/configurationPolicy.retiredRows.test.ts` (create — Drizzle mock on the delete/upsert statements); behavioural proof in Task 18's round-trip

**Interfaces:**
- Produces: `resolveAutomationAssignmentForDevice(deviceId: string, executor: DbExecutor = db): Promise<ResolvedDeviceAutomations | null>` in `featureConfigResolver.ts`. Live rows and retired sources backed by live workflow ledgers compete in one assignment election; public execution removes retired rows only AFTER that election. Task 14 consumes the same winner. Scheduled scans enumerate live candidates, and their per-device dispatch uses this same public resolver.
- Produces: `GET /alerts/rules?includeRetired=true` (default excludes); every other list excludes retired rows unconditionally. `config_policy_monitoring_settings` is now upserted on `feature_link_id` instead of deleted and re-inserted, so a settings row id is stable across saves (the watches' `settings_id` FK survives).

Why the decompose change is load-bearing: `updateFeatureLink` runs `deleteNormalizedRows` then `decomposeInlineSettings` (configurationPolicy.ts:1869-1875). Today `alert_rule` deletes ALL rows for the link and `monitoring` deletes the settings row, which cascades to every watch. After Task 7 that would silently destroy the retired rows (and their `converted_to_monitor_id`) the first time a tech re-saves the frozen legacy tab — and, because `assembleInlineSettings` would have hidden them, the re-insert would not bring them back. Retired rows must be invisible to assemble AND immune to the delete.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/retiredSourceReaders.contract.test.ts` — the mechanical guard (same style as `partner-wide-write-coverage.test.ts`: textual, cheap, catches a missed reader in the unit job):

```ts
/**
 * CONTRACT — every reader of a legacy alert-authoring table filters retired
 * rows (W05c1, spec §Data model "Retirement columns"). Textual on purpose:
 * it cannot prove the predicate is placed correctly (the round-trip
 * integration test does), only that no listed reader forgot it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');
const body = (file: string, fn: string) => {
  const text = read(file);
  const start = text.indexOf(fn);
  expect(start, `${file} must contain ${fn}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n}\n', start) + 3);
};

describe('retired legacy rows are filtered by every reader', () => {
  it.each([
    ['services/featureConfigResolver.ts', 'export async function resolveAlertRulesForDevice', 'configPolicyAlertRules.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function resolveGoverningAlertRulePolicyForDevice', 'configPolicyAlertRules.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function resolveAutomationsForDeviceWithPolicy', 'automation.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function resolveAutomationAssignmentForDevice', 'monitorConversions.sourceState'],
    ['services/featureConfigResolver.ts', 'export async function scanScheduledAutomations', 'configPolicyAutomations.retiredAt'],
    ['services/alertService.ts', 'export async function getApplicableRules', 'alertRules.retiredAt'],
    ['services/notificationDispatcher.ts', 'export async function processAlertNotifications', 'alertRules.retiredAt'],
    ['services/notificationDispatcher.ts', 'export async function processAlertNotifications', 'configPolicyAlertRules.retiredAt'],
    ['services/offlineAlertEffects.ts', 'export async function expandOfflineAlertPlan', 'alertRules.retiredAt'],
    ['routes/agents/helpers.ts', 'async function resolvePolicyMonitoringSettings', 'configPolicyMonitoringWatches.retiredAt'],
    ['jobs/automationWorker.ts', 'async function processTriggerEvent', 'automations.retiredAt'],
    ['jobs/automationWorker.ts', 'export async function queueEventTriggers', 'automations.retiredAt'],
    ['routes/alertTemplates/helpers.ts', 'export async function getAllTemplates', 'alertTemplates.retiredAt'],
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings', 'configPolicyAlertRules.retiredAt'],
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings', 'configPolicyMonitoringWatches.retiredAt'],
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings', 'configPolicyAutomations.retiredAt'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows', 'configPolicyAlertRules.retiredAt'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows', 'configPolicyMonitoringWatches.retiredAt'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows', 'configPolicyAutomations.retiredAt'],
  ])('%s %s references %s', (file, fn, needle) => {
    expect(body(file, fn)).toContain(needle);
  });

  it('the alert rules and automations list routes filter retired rows', () => {
    expect(read('routes/alerts/rules.ts')).toContain('alertRules.retiredAt');
    expect(read('routes/automations.ts')).toContain('automations.retiredAt');
  });
});
```

`apps/api/src/services/configurationPolicy.retiredRows.test.ts` — use the direct-service mocks in `configurationPolicy.monitors.test.ts:6-37` (not the route's service mocks). The complete local chain and read→save regression are:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], deleted: [] as { table: unknown; predicate: any }[], inserted: [] as unknown[], upsert: vi.fn() }));
vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class extends Error {}, resolveOwnedAutomationReferences: vi.fn(),
}));
vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: (a: unknown) => a, resolveAutomationReferencesForOwner: vi.fn(),
}));
vi.mock('../db', () => {
  const tx: any = {};
  function result(rows: unknown[]) {
    const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const name of ['from', 'where', 'orderBy', 'limit', 'returning']) c[name] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({ set: () => result([{ id: 'link' }]) });
  tx.delete = (table: unknown) => ({ where: (predicate: unknown) => {
    m.deleted.push({ table, predicate }); return Promise.resolve([]);
  } });
  tx.insert = (table: unknown) => ({ values: (value: unknown) => {
    m.inserted.push({ table, value }); const c = result([{ id: 'settings' }]);
    c.onConflictDoUpdate = (options: unknown) => { m.upsert(options); return c; }; return c;
  } });
  return { db: tx, runOutsideDbContext: (fn: any) => fn(),
    withDbAccessContext: (_c: any, fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { listFeatureLinks, updateFeatureLink } from './configurationPolicy';
import { configPolicyAlertRules, configPolicyMonitoringSettings } from '../db/schema';
beforeEach(() => { m.rows = []; m.deleted = []; m.inserted = []; m.upsert.mockReset(); });
it.each(['alert_rule', 'automation'])('returns authoritative empty %s instead of retired mirror JSON', async (featureType) => {
  const link = { id: 'link', configPolicyId: 'policy', featureType, featurePolicyId: null,
    inlineSettings: { items: [{ name: 'Retired source' }] } };
  m.rows = [[link], []];
  const [loaded] = await listFeatureLinks('policy');
  expect(loaded!.inlineSettings).toEqual({ items: [] });
});
it('saving an entirely retired rule feature cannot recreate its mirrored rules', async () => {
  const link = { id: 'link', configPolicyId: 'policy', featureType: 'alert_rule', featurePolicyId: null,
    inlineSettings: { items: [{ name: 'Retired source' }] } };
  m.rows = [[link], [], [link]];
  const [loaded] = await listFeatureLinks('policy');
  await updateFeatureLink('link', { inlineSettings: loaded!.inlineSettings }, 'policy');
  expect(m.inserted).toEqual([]);
  const deletion = m.deleted.find((d) => d.table === configPolicyAlertRules)!;
  expect(new PgDialect().sqlToQuery(deletion.predicate).sql).toContain('"retired_at" is null');
});
it('upserts watch settings without cascading deletion of retired watches', async () => {
  m.rows = [[{ id: 'link', configPolicyId: 'policy', featureType: 'monitoring' }]];
  await updateFeatureLink('link', { inlineSettings: { checkIntervalSeconds: 30, watches: [] } }, 'policy');
  expect(m.deleted.some((d) => d.table === configPolicyMonitoringSettings)).toBe(false);
  expect(m.upsert).toHaveBeenCalledWith(expect.objectContaining({ target: configPolicyMonitoringSettings.featureLinkId }));
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/retiredSourceReaders.contract.test.ts src/services/configurationPolicy.retiredRows.test.ts` → every `references` case fails ("expected … to contain 'configPolicyAlertRules.retiredAt'").

- [ ] **Step 3: Implement**

Evaluators / resolvers (add `isNull` to the drizzle imports where missing):

- `featureConfigResolver.ts:419-422`: `.innerJoin(configPolicyAlertRules, and(eq(configPolicyAlertRules.featureLinkId, configPolicyEffectiveFeatureLinks.id), isNull(configPolicyAlertRules.retiredAt)))`; `:348-351` same join shape. Automation joins use the shared election below; do not add a live-only predicate before choosing their winner. In `scanScheduledAutomations` add `isNull(configPolicyAutomations.retiredAt)` to its existing schedule/enabled `where(and(...))`: this enumerates executable candidates, not assignment winners.
- `alertService.ts:896-902`: `and(ownershipCondition, eq(alertRules.isActive, true), isNull(alertRules.retiredAt), or(...targetConditions))`.
- `offlineAlertEffects.ts:31`: `.where(and(ownership, eq(alertRules.isActive, true), isNull(alertRules.retiredAt), or(…)))`; `:65`: `.where(and(eq(table.id, rule.ruleId), isNull(table.retiredAt)))` (both tables now carry the column).
- `routes/agents/helpers.ts:2342-2345`: add `isNull(configPolicyMonitoringWatches.retiredAt)` to the `and(...)`.
- `automationWorker.ts:498`: `and(eq(automations.id, data.automationId), eq(automations.enabled, true), isNull(automations.retiredAt))`; `:1174`: `and(ownershipCondition, eq(automations.enabled, true), isNull(automations.retiredAt))`; `:1229`: `if (!cpAutomation.enabled || cpAutomation.retiredAt) continue;`.

Shared automation election (confirmed in the real `featureConfigResolver.ts:460-527` and `automationWorker.ts:980-1001`): add `or` and `isNull` to the Drizzle imports, add `monitorConversions` to the schema import and `import type { DbExecutor } from './monitors/monitorCompiler';`. Give `loadDeviceHierarchy` the signature `async function loadDeviceHierarchy(deviceId: string, executor: DbExecutor = db): Promise<DeviceHierarchy | null>` and replace its three `await db` reads with `await executor`; every existing caller retains its default. Replace the original `resolveAutomationsForDeviceWithPolicy` implementation with this shared election and public executable projection. Keep disabled rows in election, matching the original semantics; callers enforce enabled/trigger filters afterward.

```ts
export async function resolveAutomationAssignmentForDevice(
  deviceId: string, executor: DbExecutor = db,
): Promise<ResolvedDeviceAutomations | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId, executor);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree, via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(). So this runs in the CALLER'S OWN context (W03
  // deleted the system-context escape). Self-tenanted by this device's own
  // hierarchy on top of RLS.
  const rows = await executor
    .select({
      automation: configPolicyAutomations,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
      policyId: configurationPolicies.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'automation')
      )
    )
    .innerJoin(
      configPolicyAutomations,
      and(eq(configPolicyAutomations.featureLinkId, configPolicyEffectiveFeatureLinks.id),
        or(isNull(configPolicyAutomations.retiredAt), sql`EXISTS (SELECT 1 FROM ${monitorConversions}
          WHERE ${monitorConversions.sourceTable} = 'config_policy_automations'
            AND ${monitorConversions.sourceId} = ${configPolicyAutomations.id}
            AND ${monitorConversions.revertedAt} IS NULL
            AND ${monitorConversions.sourceState}->>'workflowId' IS NOT NULL)`))
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt,
      asc(configPolicyAutomations.sortOrder)
    );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  const winner = sorted[0]!;
  const winning = sorted.filter((r) => r.assignmentId === winner.assignmentId);

  return {
    configPolicyId: winner.policyId,
    automations: winning.map((r) => r.automation),
  };
}

export async function resolveAutomationsForDeviceWithPolicy(
  deviceId: string, executor: DbExecutor = db,
): Promise<ResolvedDeviceAutomations | null> {
  const winner = await resolveAutomationAssignmentForDevice(deviceId, executor);
  return winner ? { ...winner, automations: winner.automations.filter((automation) => !automation.retiredAt) } : null;
}
```

An empty executable array retains the winning `configPolicyId`; it does not fall through to the parent. `scanScheduledAutomations` keeps its live-only candidate predicate, while `processTriggerConfigPolicySchedule` retains the existing per-device winner-policy AND source-id checks. Add `isNull(configPolicyAutomations.retiredAt)` to that worker's initial enabled/source-id read (`automationWorker.ts:849`) so a pre-conversion queued schedule cannot execute a retired source. W05d retains this shared automation election and its ledger predicate when it removes the separate alert-rule readers.

Append to `featureConfigResolver.effectiveLinks.test.ts` using its existing `queueHierarchy` helper; import the new shared resolver beside the existing public resolver:

```ts
it('a converted child still wins; only its legacy executable rows disappear', async () => {
  const rows = [
    { automation: { id: 'parent-auto', retiredAt: null }, policyId: 'parent', assignmentId: 'parent-asg',
      assignmentLevel: 'organization', assignmentPriority: 0, assignmentCreatedAt: new Date(0) },
    { automation: { id: 'child-auto', retiredAt: new Date(0) }, policyId: 'child', assignmentId: 'child-asg',
      assignmentLevel: 'site', assignmentPriority: 0, assignmentCreatedAt: new Date(0) },
  ];
  queueHierarchy([...rows]);
  expect(await resolveAutomationAssignmentForDevice('dev-1')).toEqual({ configPolicyId: 'child', automations: [rows[1]!.automation] });
  queueHierarchy([...rows]);
  expect(await resolveAutomationsForDeviceWithPolicy('dev-1')).toEqual({ configPolicyId: 'child', automations: [] });
  queueHierarchy(rows.slice(0, 1));
  expect((await resolveAutomationsForDeviceWithPolicy('dev-1'))?.automations.map((a) => a.id)).toEqual(['parent-auto']);
});
```

The live Task 18 regression verifies SQL candidate filtering and ledger provenance (the mock above cannot prove WHERE behavior). In `automationWorker.executionIdentity.test.ts`, inside the existing `processTriggerConfigPolicySchedule` describe with `jobData`, `automationChain`, `chain`, and `queueAdd`, append:

```ts
it('does not schedule the shadowed parent when the converted child has no legacy executables', async () => {
  const deviceChain: any = {
    from: () => deviceChain, innerJoin: () => deviceChain,
    where: async () => [{ id: 'dev-1' }],
  };
  vi.mocked(db.select)
    .mockReturnValueOnce(automationChain())
    .mockReturnValueOnce(chain([{ orgId: 'org-a', partnerId: null, status: 'active' }]))
    .mockReturnValueOnce(chain([{ id: 'fl-parent' }]))
    .mockReturnValueOnce(deviceChain);
  vi.mocked(resolveAutomationsForDeviceWithPolicy).mockResolvedValue({ configPolicyId: 'converted-child', automations: [] });
  expect(await processTriggerConfigPolicySchedule({ ...jobData, configPolicyId: 'parent', policyId: 'parent' }))
    .toEqual({ skipped: 'no_winning_devices' });
  expect(queueAdd).not.toHaveBeenCalled();
});
```

Queued dispatch (including jobs enqueued before conversion): in `notificationDispatcher.ts:274` use `.where(and(eq(alertRules.id, alert.ruleId), isNull(alertRules.retiredAt)))`; at `:297` use `.where(and(eq(configPolicyAlertRules.id, alert.configPolicyId), isNull(configPolicyAlertRules.retiredAt)))`. W05b's resolver still owns precedence; retired rows cannot supply `legacyOverride`.

In `notificationDispatcher.configPolicyOverrides.test.ts`, extend the hoisted state with `predicates: [] as SQL[]`; change its `where` mock to `(p: SQL) => { predicates.push(p); return chain; }`, and clear `predicates` in `beforeEach`. Import `SQL` and `PgDialect`. Mock W05b's `./delivery/resolveDelivery` using a hoisted `resolveDeliveryMock` returning `{ channelIds: [], skippedChannelIds: [], escalationPolicyId: null, source: 'none' }` in these cases. Append:

```ts
it.each(['rule', 'policy'] as const)('queued %s dispatch excludes a source retired after enqueue', async (axis) => {
  selectQueue.push(
    [makeAlert(axis === 'rule' ? { ruleId: 'old-rule' } : { configPolicyId: 'old-policy-rule' })],
    [{ id: 'device-1', siteId: 'site-1' }],
    [], // live-only source lookup: source has been retired
  );
  await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
  const sql = predicates.map((p) => new PgDialect().sqlToQuery(p).sql).join('\n');
  expect(sql).toContain(`"${axis === 'rule' ? 'alert_rules' : 'config_policy_alert_rules'}"."retired_at" is null`);
  expect(resolveDeliveryMock.mock.calls.at(-1)?.[0].legacyOverride ?? null).toBeNull();
  expect(queueAddBulkMock).not.toHaveBeenCalled();
});
```

Lists:

- `routes/alerts/schemas.ts` list query: `includeRetired: z.enum(['true', 'false']).optional()`; `routes/alerts/rules.ts:177` after the enabled filter: `if (query.includeRetired !== 'true') conditions.push(isNull(alertRules.retiredAt));`.
- `routes/alertTemplates/helpers.ts:49-57`: wrap the `or(...)` in `and(isNull(alertTemplates.retiredAt), or(...))`. `getTemplateById` stays unfiltered (history reads by id).
- `routes/automations.ts:677`: `const conditions: SQL<unknown>[] = [isNull(automations.retiredAt)];`.

`configurationPolicy.ts`:

- In `assembleInlineSettings`, replace both `if (rows.length === 0) return null;` statements in the `alert_rule` (`:1277`) and `automation` (`:1302`) cases with `if (rows.length === 0) return { items: [] };`. In `listFeatureLinks` (`:1946`), replace the mirror fallback with:

```ts
inlineSettings: link.featureType === 'alert_rule' || link.featureType === 'automation'
  ? (assembled ?? { items: [] })
  : (assembled ?? link.inlineSettings),
```

- `assembleInlineSettings` `alert_rule` (1275): `.where(and(eq(configPolicyAlertRules.featureLinkId, linkId), isNull(configPolicyAlertRules.retiredAt)))`; `automation` (1300) and `monitoring` watches (1440) likewise.
- `deleteNormalizedRows`: `alert_rule` → `.where(and(eq(configPolicyAlertRules.featureLinkId, linkId), isNull(configPolicyAlertRules.retiredAt)))`; `automation` → same with `configPolicyAutomations`; `monitoring` →

```ts
    case 'monitoring': {
      // W05c1: never delete the settings row — that cascades to every watch,
      // including RETIRED ones whose converted_to_monitor_id is the ledger's
      // only link back. Delete the live watches; decompose upserts the
      // settings row in place (same id, so retired watches keep their FK).
      await tx.delete(configPolicyMonitoringWatches).where(and(
        inArray(
          configPolicyMonitoringWatches.settingsId,
          tx.select({ id: configPolicyMonitoringSettings.id })
            .from(configPolicyMonitoringSettings)
            .where(eq(configPolicyMonitoringSettings.featureLinkId, linkId)),
        ),
        isNull(configPolicyMonitoringWatches.retiredAt),
      ));
      break;
    }
```

- `decomposeInlineSettings` `monitoring` (909–912):

```ts
      const [settingsRow] = await tx
        .insert(configPolicyMonitoringSettings)
        .values({ featureLinkId: linkId, checkIntervalSeconds: parsed.checkIntervalSeconds })
        .onConflictDoUpdate({
          target: configPolicyMonitoringSettings.featureLinkId,
          set: { checkIntervalSeconds: parsed.checkIntervalSeconds, updatedAt: new Date() },
        })
        .returning();
```

`removeFeatureLink` (1888) deletes the link row, which cascades to children including retired rows — that is a deliberate whole-feature removal by the tech and is left as is; the ledger's `source_id` then dangles by design (no FK), and `revertConversion` (Task 15) reports `source_not_found` before mutation.

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/retiredSourceReaders.contract.test.ts src/services/configurationPolicy.retiredRows.test.ts src/services/featureConfigResolver src/services/alertService src/services/offlineAlertEffects src/jobs/automationWorker src/routes/alerts/rules src/routes/alertTemplates src/routes/automations src/routes/agents/helpers src/routes/configurationPolicies` (existing Drizzle-mock suites must stay green — a mock queue that now sees one extra predicate in an `and()` does not change call counts). `npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/featureConfigResolver.ts apps/api/src/services/featureConfigResolver.effectiveLinks.test.ts apps/api/src/jobs/automationWorker.executionIdentity.test.ts apps/api/src/services/alertService.ts apps/api/src/services/offlineAlertEffects.ts apps/api/src/routes/agents/helpers.ts apps/api/src/jobs/automationWorker.ts apps/api/src/routes/alerts/rules.ts apps/api/src/routes/alerts/schemas.ts apps/api/src/routes/alertTemplates/helpers.ts apps/api/src/routes/automations.ts apps/api/src/services/configurationPolicy.ts apps/api/src/services/retiredSourceReaders.contract.test.ts apps/api/src/services/configurationPolicy.retiredRows.test.ts apps/api/src/services/notificationDispatcher.ts apps/api/src/services/notificationDispatcher.configPolicyOverrides.test.ts && git commit -m "feat(alerts): exclude retired execution while preserving automation assignment winners and history"`

**PR2 gate:** unit: `cd apps/api && npx tsc --noEmit -p . && npx vitest run`; live (`pnpm test-stack up`): `pnpm db:migrate && pnpm db:check-drift && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/monitorWatchDelivery.integration.test.ts`. Open PR2 (`Refs #<wave>`).

## PR3 — converter, preview, routes, payload, onboarding (Tasks 9–18)

### Task 9: Conversion module contract types and the prerequisite capability check

**Files:**
- Create: `apps/api/src/services/monitors/conversion/types.ts`
- Create: `apps/api/src/services/monitors/conversion/prerequisites.ts`
- Modify: `apps/api/src/services/offlineAlertEffects.ts` (export `OFFLINE_EFFECTS_RESOLVE_MONITORS` next to the #6342 code)
- Create: `apps/api/src/services/monitors/conversion/index.ts` (re-exports; grows in Tasks 13–15)
- Test: `apps/api/src/services/monitors/conversion/prerequisites.test.ts`

**Interfaces (the cross-wave contract — W05c2, W05d, W05e import these names verbatim):**

```ts
// types.ts
import type { AlertSeverity, MonitorKind } from '@breeze/shared';
import type { MonitorConversionSourceTable, MonitorConversionOutputRole } from '../../../db/schema/monitorConversions';

export type ConversionSourceTable = MonitorConversionSourceTable; // 'config_policy_alert_rules' | 'config_policy_monitoring_watches' | 'alert_templates' | 'automations' | 'config_policy_automations' | 'network_monitors'
export type ConversionOutputRole = MonitorConversionOutputRole;   // 'primary' | 'resource_cpu' | 'resource_memory' | 'response'

export interface ProposedMonitor {
  role: ConversionOutputRole;
  kind: MonitorKind;
  enabled: boolean;
  name: string;
  condition: Record<string, unknown>;
  severity: AlertSeverity;
  deliveryMode: 'inherit' | 'channels' | 'none';
  deliveryChannelIds: string[];
  escalationPolicyId: string | null;
  responses: unknown[];
  // Additive to the brief (needed to create the row; W05c2 may ignore them):
  cooldownMinutes: number;
  autoResolve: boolean;
  description?: string;
}

export interface ConversionPreviewItem {
  sourceTable: ConversionSourceTable;
  sourceId: string;
  name: string;
  outcome: 'convertible' | 'unconvertible';
  /** `unconvertible:<code>` — the exact string stored in `retired_reason` on Retire. */
  reason?: string;
  proposed: ProposedMonitor[];
  responseTargetSourceId?: string;
  responseActions?: unknown[];
  workflow?: { policyId: string; sourceId: string; name: string; enabled: boolean; actions: unknown[]; onFailure: 'stop'|'continue'|'notify' };
  /** Human-readable facts the panel prints under the row (behaviour changes, dropped fields). */
  notes: string[];
  /** Open (active | acknowledged | suppressed) alerts the conversion will carry over. */
  openAlerts: number;
}

export interface EquivalenceDelta { deviceId: string; detail: string }

export interface PolicyConversionPreview {
  policyId: string;
  previewHash: string;
  items: ConversionPreviewItem[];
  inheritanceMode: 'cumulative' | 'replace';
  equivalence: { devicesChecked: number; deltas: EquivalenceDelta[] };
  blockedBy?: 'parent_unconverted' | 'prerequisite_missing';
  /** Set with blockedBy = 'prerequisite_missing': the labels of the fixes that are absent. */
  missingPrerequisites?: string[];
}

/** Returned by GET …/preview while the >500-device equivalence job runs (HTTP 202). */
export interface PolicyConversionPreviewPending {
  status: 'running';
  progress: { checked: number; total: number };
}

export interface ConvertPolicyResult { conversionIds: string[]; retired: number; monitorsCreated: number }
export interface ConvertPartnerResult { policies: number; converted: number; unconvertible: number }
export interface PendingConversionCounts { policies: number; rows: number }
export interface PartnerConversionPreview {
  partnerId: string; previewHash: string; policies: number; rows: number; convertible: number;
  unconvertible: Array<{ policyId: string | null; policyName: string | null;
    sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string }>;
}
export interface ConversionLedgerEntry {
  id: string; sourceTable: ConversionSourceTable; sourceId: string; sourceName: string;
  policyId: string | null; convertedBy: string | null; convertedAt: string;
  revertedAt: string | null; revertable: boolean;
  outputs: Array<{ monitorId: string; role: string; reused: boolean }>;
}


export const RETIRED_REASON = {
  converted: 'converted',
  operator: 'operator',
  unconvertible: (code: string) => `unconvertible:${code}` as const,
} as const;

export const EQUIVALENCE_JOB_THRESHOLD = 500;
```

```ts
// prerequisites.ts
export interface ConversionPrerequisite { id: '#6342' | '#6343' | '#6344'; label: string; check: () => boolean }
export const CONVERSION_PREREQUISITES: readonly ConversionPrerequisite[];
export function missingConversionPrerequisites(list?: readonly ConversionPrerequisite[]): string[]; // labels, [] when all present
export class ConversionPrerequisiteMissingError extends Error { readonly missing: string[] }
export function assertConversionPrerequisites(list?: readonly ConversionPrerequisite[]): void; // throws the error above
```

What the panel receives (W05c2): `previewPolicyConversion` returns `{ …, blockedBy: 'prerequisite_missing', missingPrerequisites: ['#6342 offline monitors fire through offlineAlertEffects', …], items: [], equivalence: { devicesChecked: 0, deltas: [] } }`; every mutating route answers `409 { error: 'CONVERSION_PREREQUISITE_MISSING', missing: string[] }`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/monitors/conversion/prerequisites.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CONVERSION_PREREQUISITES,
  ConversionPrerequisiteMissingError,
  assertConversionPrerequisites,
  missingConversionPrerequisites,
} from './prerequisites';

const SRC = resolve(__dirname, '../../..');

describe('conversion prerequisites (spec §Risks: converter refuses until #6342/#6343/#6344 are present)', () => {
  it('all three checks pass on this tree', () => {
    expect(missingConversionPrerequisites()).toEqual([]);
    expect(() => assertConversionPrerequisites()).not.toThrow();
    expect(CONVERSION_PREREQUISITES.map((p) => p.id)).toEqual(['#6342', '#6343', '#6344']);
  });

  it('#6342 — offlineAlertEffects resolves monitors for the device (the capability constant sits next to that code)', () => {
    const src = readFileSync(resolve(SRC, 'services/offlineAlertEffects.ts'), 'utf8');
    expect(src).toContain('resolveMonitorsForDevice');
    expect(src).toContain('export const OFFLINE_EFFECTS_RESOLVE_MONITORS = true');
  });

  it('#6344 — the resolver applies assignment role/OS filters', () => {
    const src = readFileSync(resolve(SRC, 'services/monitors/monitorResolver.ts'), 'utf8');
    expect(src).toMatch(/buildRoleOsFilterConditions|matchesRoleOsFilter/);
    expect(src).toContain('MONITOR_RESOLVER_CAPABILITIES');
  });

  it('a failing check names the fix and blocks', () => {
    const broken = [{ id: '#6343' as const, label: '#6343 restart params preserved', check: () => false }];
    expect(missingConversionPrerequisites(broken)).toEqual(['#6343 restart params preserved']);
    expect(() => assertConversionPrerequisites(broken)).toThrow(ConversionPrerequisiteMissingError);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/monitors/conversion/prerequisites.test.ts` → `Cannot find module './prerequisites'`.

- [ ] **Step 3: Implement**

`apps/api/src/services/offlineAlertEffects.ts` — directly above `expandOfflineAlertPlan`:

```ts
/**
 * Proof-of-presence for the conversion prerequisite check (W05c1). True only
 * because this module resolves monitors for the offline device (#6342);
 * conversion/prerequisites.test.ts pins that `resolveMonitorsForDevice` is
 * referenced in this file.
 */
export const OFFLINE_EFFECTS_RESOLVE_MONITORS = true;
```

`prerequisites.ts`:

```ts
import { normalizeAutomationActions } from '../../automationRuntime';
import { OFFLINE_EFFECTS_RESOLVE_MONITORS } from '../../offlineAlertEffects';
import { MONITOR_RESOLVER_CAPABILITIES } from '../monitorResolver';

export interface ConversionPrerequisite {
  id: '#6342' | '#6343' | '#6344';
  label: string;
  check: () => boolean;
}

/**
 * The converter refuses to run unless the three prerequisite fixes are present
 * (spec §Prerequisite defects, §Risks). Each check is a behavioural probe or a
 * constant exported NEXT TO the fix's code and pinned by a source grep in
 * prerequisites.test.ts — never a flag someone can flip on its own.
 */
export const CONVERSION_PREREQUISITES: readonly ConversionPrerequisite[] = [
  {
    id: '#6342',
    label: '#6342 offline monitors fire through offlineAlertEffects',
    check: () => OFFLINE_EFFECTS_RESOLVE_MONITORS === true,
  },
  {
    id: '#6343',
    label: '#6343 restart_service kind/maxAttempts/cooldownSeconds survive normalizeActions',
    check: () => {
      try {
        const [a] = normalizeAutomationActions([
          { type: 'execute_command', command: 'x', kind: 'restart_service', maxAttempts: 2, cooldownSeconds: 60 },
        ]) as Array<{ kind?: string; maxAttempts?: number; cooldownSeconds?: number }>;
        return a?.kind === 'restart_service' && a.maxAttempts === 2 && a.cooldownSeconds === 60;
      } catch {
        return false;
      }
    },
  },
  {
    id: '#6344',
    label: '#6344 resolveMonitorsForDevice honours assignment role/OS filters',
    check: () => MONITOR_RESOLVER_CAPABILITIES.roleOsFilters === true && MONITOR_RESOLVER_CAPABILITIES.inheritance === true,
  },
];

export class ConversionPrerequisiteMissingError extends Error {
  constructor(readonly missing: string[]) {
    super(`conversion prerequisites missing: ${missing.join('; ')}`);
  }
}

export function missingConversionPrerequisites(list: readonly ConversionPrerequisite[] = CONVERSION_PREREQUISITES): string[] {
  return list.filter((p) => !p.check()).map((p) => p.label);
}

export function assertConversionPrerequisites(list: readonly ConversionPrerequisite[] = CONVERSION_PREREQUISITES): void {
  const missing = missingConversionPrerequisites(list);
  if (missing.length > 0) throw new ConversionPrerequisiteMissingError(missing);
}
```

`types.ts` as in the Interfaces block. `index.ts`: `export * from './types'; export * from './prerequisites';` (Tasks 13–15 add the rest).

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/monitors/conversion/ && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

`git add apps/api/src/services/monitors/conversion/ apps/api/src/services/offlineAlertEffects.ts && git commit -m "feat(monitors): conversion contract types and prerequisite capability check"`

### Task 10: Pure mappers — legacy source → proposed monitors, action fingerprint, signature and preview hash

**Files:**
- Create: `apps/api/src/services/monitors/conversion/mapping.ts`
- Test: `apps/api/src/services/monitors/conversion/mapping.test.ts`
- Reads (unchanged): `apps/api/src/services/monitors/monitorConversion.ts:50-96` (`convertAlertConditionToMonitor`), `apps/api/src/services/monitors/kinds/index.ts` (`getMonitorKindSpec`), `packages/shared` `SERVER_EVALUATED_MONITOR_KINDS`

**Interfaces:**

```ts
export type MappingResult =
  | { ok: true; proposed: ProposedMonitor[]; notes: string[] }
  | { ok: false; reason: string /* 'unconvertible:<code>' */; notes: string[] };

export function mapInlineRule(row: typeof configPolicyAlertRules.$inferSelect): MappingResult;
export function mapWatch(row: typeof configPolicyMonitoringWatches.$inferSelect): MappingResult;
export function mapStandaloneRule(rule: typeof alertRules.$inferSelect, template: typeof alertTemplates.$inferSelect): MappingResult;
export function mapAutomationResponses(row: typeof automations.$inferSelect): { actions: unknown[]; notes: string[] };
export function fingerprintAction(action: unknown): string;          // canonical JSON of the action minus volatile keys
export function monitorSignature(m: Pick<ProposedMonitor, 'enabled'|'kind'|'condition'|'severity'|'cooldownMinutes'|'autoResolve'|'deliveryMode'|'deliveryChannelIds'|'escalationPolicyId'|'responses'>): string; // sha256 of canonical JSON — reuse rule + equivalence key
/** Merge in source order; action order is behavioral, not a set. */
export function mergeResponseProposals(items: ConversionPreviewItem[]): ConversionPreviewItem[] {
  const out = structuredClone(items);
  for (const item of out) {
    if (!item.responseTargetSourceId || item.outcome !== 'convertible') continue;
    const target = out.find((i) => i.sourceId === item.responseTargetSourceId);
    const primary = target?.proposed.find((p) => p.role === 'primary');
    if (!target || target.outcome !== 'convertible' || !primary) {
      item.outcome = 'unconvertible'; item.reason = 'unconvertible:target_unconvertible'; continue;
    }
    const seen = new Set(primary.responses.map(fingerprintAction));
    const added = (item.responseActions ?? []).filter((a) => {
      const key = fingerprintAction(a); if (seen.has(key)) return false; seen.add(key); return true;
    });
    if (primary.responses.length + added.length > 10) {
      item.outcome = target.outcome = 'unconvertible';
      item.reason = target.reason = 'unconvertible:too_many_responses';
      continue;
    }
    primary.responses.push(...added);
  }
  return out;
}

export function previewHash(input: { policyId: string; items: ConversionPreviewItem[]; inheritanceMode: string }): string;
export const UNCONVERTIBLE = { metricWithoutKind: 'metric_without_kind', custom: 'custom_condition', nestedGroup: 'nested_group', childNotComposable: 'child_kind_not_composable', tooManyConditions: 'too_many_conditions', noCondition: 'no_condition', autoResolveConditions: 'auto_resolve_conditions', escalationPolicyAxis: 'escalation_policy_axis', tooManyResponses: 'too_many_responses' } as const;
```

Mapping rules (spec §Conversion table, with the facts verified in code):

| Source | Rule |
|---|---|
| inline rule, `conditions` array length 1 (`alertConditions/index.ts:169-173`: array = implicit AND) | `convertAlertConditionToMonitor(conditions)` → kind + condition; `null` → `metric_without_kind` when `type ∈ {metric, threshold}` and `normalizeMetricName(metric) === 'processCount'`, `custom_condition` when `type === 'custom'`, else `no_condition` |
| inline rule, 2..10 conditions (or a stored flat `{logic, conditions}` group — `routes/alerts/schemas.ts:29` accepts arbitrary shapes for standalone rules, and old policy rows may carry one) | `composite` with `match: logic === 'or' ? 'any' : 'all'`; each child through `convertAlertConditionToMonitor([child])`; child kind ∉ `SERVER_EVALUATED_MONITOR_KINDS` → `child_kind_not_composable`; any child null → that child's code; a child that is itself a group → `nested_group`; >10 → `too_many_conditions` |
| inline rule delivery | `notification_channel_ids` non-empty → `deliveryMode: 'channels'` + ids; empty/null → `'inherit'` (never `'none'`); `escalation_policy_id` → `escalationPolicyId` |
| inline rule scalars | `severity`, `cooldownMinutes`, `autoResolve`, `name`; `rationale` → `description`; `titleTemplate`/`messageTemplate` dropped → note "Title/message use the monitor kind's templates"; non-empty `autoResolveConditions` → `unconvertible:auto_resolve_conditions` (a monitor cannot carry an array of resolve conditions and silently dropping them would change when the alert clears) |
| watch | `enabled` is copied to EVERY definition and attachment, including resource outputs; disabled watches are excluded from the active equivalence set. Primary `service`/`process`: `{ serviceName\|processName: name, consecutiveFailures: alertAfterConsecutiveFailures }`; severity `getMonitorKindSpec(kind).defaultSeverity`; cooldown 5; autoResolve false; delivery `inherit`; `autoRestart` → `responses: [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: maxRestartAttempts, cooldownSeconds: restartCooldownSeconds, whenOffline: 'queue' }]` (Task 3 addendum: empty command = agent-local); `cpuThresholdPercent != null` → extra `process_resource` `{ resource: 'cpu', processName: name, operator: 'gt', value, durationMinutes: ceil(thresholdDurationSeconds/60) \|\| undefined }` role `resource_cpu`, name `"<name> — CPU"`; `memoryThresholdMb != null` → same with `resource: 'memory'`, role `resource_memory`, name `"<name> — memory"`; `alertOnStop`, `alertSeverity`, `displayName` ignored. **Field mapping is lossless; conversion still requires zero equivalence deltas.** Notes: `"Legacy watches never raised an inbox alert (heartbeat.ts monitoring-results ingest only counts failures); the monitor raises a <severity> alert after <n> consecutive failures."`; when `autoRestart`: `"Auto-restart stays agent-local (max <n> attempts, <s>s cooldown) as a restart_service response."`; when `alertOnStop === false`: `"alertOnStop=false was stored but never read; ignored."` |
| standalone rule + template | as `ruleConversionService.ts:92-105` (overrides win over template); template `conditions` with no `type` and no array (the `/settings/alert-templates` envelope `{triggers, thresholdDefaults, …}`) → `no_condition`; target → assignment handled by the template-group writer in Task 15; it calls `mapStandaloneRule` for every rule before any write |
| `automations` with `trigger.type === 'event' && eventType === 'alert.triggered'` and `filter.ruleId` / `filter.configPolicyAlertRuleId` naming a source in this preview | `mapAutomationResponses` → its `actions` (verbatim, `normalizeAutomationActions` shape), dedupe by `fingerprintAction` against the target monitor's responses, cap 10 → note `"<k> actions appended to <monitor>; <d> duplicates skipped"`; merge into proposed monitors BEFORE equivalence/hash; overflow → `unconvertible:too_many_responses` and block conversion of its target source as well, so retiring the rule cannot strand the still-running automation |
| `config_policy_automations` with `triggerType === 'event' && eventType === 'alert.triggered'` | Convertible preservation item, `proposed: []`, `workflow` carries the complete normalized source payload. Rehome atomically to a standalone policy-assigned workflow under Jobs, retaining enabled state, actions, onFailure and dynamic assignment coverage (Task 14). Never emit `unconvertible:alert_workflow_kept`; W05d does not retire preserved workflows. |

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/monitors/conversion/mapping.test.ts` (table-driven; a representative subset — implement every row of the table above as a case):

```ts
import { describe, expect, it } from 'vitest';
import type { ConversionPreviewItem } from './types';
import { fingerprintAction, mapInlineRule, mapWatch, mergeResponseProposals, monitorSignature, previewHash, UNCONVERTIBLE } from './mapping';

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1', featureLinkId: 'l1', name: 'High CPU', severity: 'high', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
  cooldownMinutes: 10, autoResolve: true, autoResolveConditions: null, titleTemplate: 't', messageTemplate: 'm', sortOrder: 0,
  rationale: 'because', escalationPolicyId: null, notificationChannelIds: null, retiredAt: null, retiredReason: null, convertedToMonitorId: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});
const watch = (over: Record<string, unknown> = {}) => ({
  id: 'w1', settingsId: 's1', watchType: 'service', name: 'Spooler', displayName: null, enabled: true, alertOnStop: true,
  alertAfterConsecutiveFailures: 3, alertSeverity: 'critical', cpuThresholdPercent: null, memoryThresholdMb: null, thresholdDurationSeconds: 300,
  autoRestart: false, maxRestartAttempts: 3, restartCooldownSeconds: 300, rationale: null, sortOrder: 0,
  retiredAt: null, retiredReason: null, convertedToMonitorId: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('mapInlineRule', () => {
  it('single metric condition → cpu monitor with delivery inherit and description from rationale', () => {
    const r = mapInlineRule(rule() as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]).toMatchObject({ role: 'primary', kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high', cooldownMinutes: 10, autoResolve: true, deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null, description: 'because', responses: [] });
    expect(r.notes.join(' ')).toMatch(/kind's templates/);
  });
  it('channels non-empty → deliveryMode channels; escalation carried', () => {
    const r = mapInlineRule(rule({ notificationChannelIds: ['c1'], escalationPolicyId: 'e1' }) as never);
    expect(r.ok && r.proposed[0]).toMatchObject({ deliveryMode: 'channels', deliveryChannelIds: ['c1'], escalationPolicyId: 'e1' });
  });
  it('2..10 conditions → composite match=all with children in order', () => {
    const r = mapInlineRule(rule({ conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }, { type: 'offline', durationMinutes: 5 }] }) as never);
    expect(r.ok && r.proposed[0]).toMatchObject({ kind: 'composite', condition: { match: 'all', children: [{ kind: 'cpu', condition: { operator: 'gt', value: 80 } }, { kind: 'offline', condition: { durationMinutes: 5 } }] } });
  });
  it('flat or-group → composite match=any; nested group → nested_group', () => {
    const flat = mapInlineRule(rule({ conditions: { logic: 'or', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }, { type: 'metric', metric: 'ram', operator: 'gt', value: 90 }] } }) as never);
    expect(flat.ok && flat.proposed[0]?.condition).toMatchObject({ match: 'any' });
    const nested = mapInlineRule(rule({ conditions: { logic: 'and', conditions: [{ logic: 'or', conditions: [] }, { type: 'offline' }] } }) as never);
    expect(nested).toMatchObject({ ok: false, reason: `unconvertible:${UNCONVERTIBLE.nestedGroup}` });
  });
  it('processCount → metric_without_kind; custom → custom_condition; autoResolveConditions → auto_resolve_conditions; 11 conditions → too_many_conditions', () => {
    expect(mapInlineRule(rule({ conditions: [{ type: 'metric', metric: 'processCount', operator: 'gt', value: 500 }] }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:metric_without_kind' });
    expect(mapInlineRule(rule({ conditions: [{ type: 'custom', script: 'x' }] }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:custom_condition' });
    expect(mapInlineRule(rule({ autoResolveConditions: [{ type: 'metric', metric: 'cpu', operator: 'lt', value: 50 }] }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:auto_resolve_conditions' });
    expect(mapInlineRule(rule({ conditions: Array.from({ length: 11 }, () => ({ type: 'offline', durationMinutes: 5 })) }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:too_many_conditions' });
  });
});

describe('mapWatch', () => {
  it('service watch → service monitor with consecutiveFailures, kind-default severity, inherit delivery, and the never-alerted note', () => {
    const r = mapWatch(watch() as never);
    expect(r.ok && r.proposed).toEqual([expect.objectContaining({ role: 'primary', kind: 'service', name: 'Spooler', condition: { serviceName: 'Spooler', consecutiveFailures: 3 }, severity: 'high', deliveryMode: 'inherit', responses: [] })]);
    expect(r.notes.join(' ')).toMatch(/never raised an inbox alert/);
  });
  it('autoRestart → restart_service response with empty command and the row\'s knobs', () => {
    const r = mapWatch(watch({ autoRestart: true, maxRestartAttempts: 5, restartCooldownSeconds: 900 }) as never);
    expect(r.ok && r.proposed[0]?.responses).toEqual([{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 5, cooldownSeconds: 900, whenOffline: 'queue' }]);
  });
  it('process watch with both thresholds → three monitors (primary + cpu + memory), durationMinutes rounded up', () => {
    const r = mapWatch(watch({ watchType: 'process', name: 'sqlservr.exe', cpuThresholdPercent: 80, memoryThresholdMb: 4096, thresholdDurationSeconds: 90 }) as never);
    expect(r.ok && r.proposed.map((p) => p.role)).toEqual(['primary', 'resource_cpu', 'resource_memory']);
    expect(r.ok && r.proposed[1]).toMatchObject({ kind: 'process_resource', name: 'sqlservr.exe — CPU', condition: { resource: 'cpu', processName: 'sqlservr.exe', operator: 'gt', value: 80, durationMinutes: 2 } });
    expect(r.ok && r.proposed[2]).toMatchObject({ condition: { resource: 'memory', value: 4096, durationMinutes: 2 } });
  });
});

it('keeps every disabled auto-restart watch output disabled', () => {
  const result = mapWatch(watch({ enabled: false, autoRestart: true, cpuThresholdPercent: 80 }) as never);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.proposed.every((p) => p.enabled === false)).toBe(true);
  expect(result.proposed[0]!.responses).toHaveLength(1);
});

describe('fingerprint / signature / previewHash', () => {
  it('fingerprintAction is key-order independent', () => {
    expect(fingerprintAction({ type: 'run_script', scriptId: 'a', whenOffline: 'queue' })).toBe(fingerprintAction({ whenOffline: 'queue', scriptId: 'a', type: 'run_script' }));
  });
  it('monitorSignature ignores name/description and changes on any behavioural field', () => {
    const base = { enabled: true, kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high', cooldownMinutes: 5, autoResolve: false, deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null, responses: [] } as const;
    expect(monitorSignature({ ...base })).toBe(monitorSignature({ ...base }));
    expect(monitorSignature({ ...base, severity: 'low' })).not.toBe(monitorSignature(base));
  });
  it('hashes action payload and order before conversion, and refuses overflow', () => {
    const r = mapInlineRule(rule() as never); if (!r.ok) throw new Error('Invalid fixture');
    const items: ConversionPreviewItem[] = [
      { sourceTable: 'config_policy_alert_rules', sourceId: 'rule', name: 'CPU', outcome: 'convertible', proposed: r.proposed, notes: [], openAlerts: 0 },
      { sourceTable: 'automations', sourceId: 'auto', name: 'Respond', outcome: 'convertible', proposed: [], notes: [], openAlerts: 0,
        responseTargetSourceId: 'rule', responseActions: [{ type: 'execute_command', command: 'first' }, { type: 'execute_command', command: 'second' }] },
    ];
    const merged = mergeResponseProposals(items);
    expect(merged[0]!.proposed[0]!.responses).toEqual(items[1]!.responseActions);
    const hash = (i: ConversionPreviewItem[]) => previewHash({ policyId: 'policy', items: i, inheritanceMode: 'replace' });
    const changed = structuredClone(items); changed[1]!.responseActions!.reverse();
    expect(hash(merged)).not.toBe(hash(mergeResponseProposals(changed)));
    changed[1]!.responseActions = Array.from({ length: 11 }, (_, i) => ({ type: 'execute_command', command: `echo ${i}` }));
    expect(mergeResponseProposals(changed).map((i) => i.reason)).toEqual(['unconvertible:too_many_responses', 'unconvertible:too_many_responses']);
  });
  it('previewHash is stable for the same items and differs on inheritance mode', () => {
    const items = [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'x', outcome: 'convertible', proposed: [], notes: [], openAlerts: 0 }] as never;
    expect(previewHash({ policyId: 'p', items, inheritanceMode: 'replace' })).toBe(previewHash({ policyId: 'p', items, inheritanceMode: 'replace' }));
    expect(previewHash({ policyId: 'p', items, inheritanceMode: 'replace' })).not.toBe(previewHash({ policyId: 'p', items, inheritanceMode: 'cumulative' }));
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/monitors/conversion/mapping.test.ts` → `Cannot find module './mapping'`.

- [ ] **Step 3: Implement**

`mapping.ts` (core; the helper bodies follow the rules table exactly):

```ts
import { createHash } from 'node:crypto';
import { SERVER_EVALUATED_MONITOR_KINDS, type MonitorKind } from '@breeze/shared';
import type { alertRules, alertTemplates } from '../../../db/schema/alerts';
import type { automations } from '../../../db/schema/automations';
import type { configPolicyAlertRules, configPolicyMonitoringWatches } from '../../../db/schema/configurationPolicies';
import { normalizeMetricName } from '../../alertConditions/utils';
import { getMonitorKindSpec } from '../kinds';
import { convertAlertConditionToMonitor } from '../monitorConversion';
import type { ConversionPreviewItem, ProposedMonitor } from './types';

export const UNCONVERTIBLE = {
  metricWithoutKind: 'metric_without_kind',
  custom: 'custom_condition',
  nestedGroup: 'nested_group',
  childNotComposable: 'child_kind_not_composable',
  tooManyConditions: 'too_many_conditions',
  tooManyResponses: 'too_many_responses',
  noCondition: 'no_condition',
  autoResolveConditions: 'auto_resolve_conditions',
  escalationPolicyAxis: 'escalation_policy_axis',
} as const;

export type MappingResult =
  | { ok: true; proposed: ProposedMonitor[]; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

const fail = (code: string, notes: string[] = []): MappingResult => ({ ok: false, reason: `unconvertible:${code}`, notes });

export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Why a single leaf did not convert — mirrors convertAlertConditionToMonitor's null branches. */
function leafFailureCode(leaf: Record<string, unknown>): string {
  const type = typeof leaf.type === 'string' ? leaf.type : '';
  if (type === 'custom') return UNCONVERTIBLE.custom;
  if (type === 'metric' || type === 'threshold') {
    const metric = normalizeMetricName(String(leaf.metric ?? ''));
    if (metric === 'processCount' || metric === null) return UNCONVERTIBLE.metricWithoutKind;
  }
  return UNCONVERTIBLE.noCondition;
}

function mapConditions(conditions: unknown): { kind: MonitorKind; condition: Record<string, unknown> } | { code: string } {
  let leaves: unknown[];
  let match: 'all' | 'any' = 'all';
  if (Array.isArray(conditions)) {
    leaves = conditions;
  } else if (isRecord(conditions) && 'logic' in conditions && Array.isArray(conditions.conditions)) {
    match = conditions.logic === 'or' ? 'any' : 'all';
    leaves = conditions.conditions;
  } else if (isRecord(conditions)) {
    leaves = [conditions];
  } else {
    return { code: UNCONVERTIBLE.noCondition };
  }
  if (leaves.length === 0) return { code: UNCONVERTIBLE.noCondition };
  if (leaves.length > 10) return { code: UNCONVERTIBLE.tooManyConditions };
  if (leaves.some((l) => isRecord(l) && ('logic' in l || 'conditions' in l))) return { code: UNCONVERTIBLE.nestedGroup };

  if (leaves.length === 1) {
    const one = convertAlertConditionToMonitor([leaves[0]]);
    if (!one) return { code: isRecord(leaves[0]) ? leafFailureCode(leaves[0]) : UNCONVERTIBLE.noCondition };
    return one;
  }

  const children: Array<{ kind: MonitorKind; condition: Record<string, unknown> }> = [];
  for (const leaf of leaves) {
    const child = convertAlertConditionToMonitor([leaf]);
    if (!child) return { code: isRecord(leaf) ? leafFailureCode(leaf) : UNCONVERTIBLE.noCondition };
    if (!(SERVER_EVALUATED_MONITOR_KINDS as readonly string[]).includes(child.kind)) return { code: UNCONVERTIBLE.childNotComposable };
    children.push(child);
  }
  const composite = getMonitorKindSpec('composite').conditionSchema.safeParse({ match, children });
  if (!composite.success) return { code: UNCONVERTIBLE.noCondition };
  return { kind: 'composite', condition: composite.data as Record<string, unknown> };
}

export function mapInlineRule(row: typeof configPolicyAlertRules.$inferSelect): MappingResult {
  const notes: string[] = [];
  if (Array.isArray(row.autoResolveConditions) && row.autoResolveConditions.length > 0) {
    return fail(UNCONVERTIBLE.autoResolveConditions, ['Custom auto-resolve conditions have no monitor equivalent; retire or re-author.']);
  }
  const mapped = mapConditions(row.conditions);
  if ('code' in mapped) return fail(mapped.code);
  notes.push("Title/message use the monitor kind's templates; the rule's titleTemplate/messageTemplate are not carried.");
  const channelIds = Array.isArray(row.notificationChannelIds) ? row.notificationChannelIds : [];
  return {
    ok: true,
    notes,
    proposed: [{
      role: 'primary',
      enabled: true,
      kind: mapped.kind,
      name: row.name,
      condition: mapped.condition,
      severity: row.severity,
      cooldownMinutes: row.cooldownMinutes,
      autoResolve: row.autoResolve,
      deliveryMode: channelIds.length > 0 ? 'channels' : 'inherit',
      deliveryChannelIds: channelIds,
      escalationPolicyId: row.escalationPolicyId ?? null,
      responses: [],
      ...(row.rationale ? { description: row.rationale } : {}),
    }],
  };
}

export function mapWatch(row: typeof configPolicyMonitoringWatches.$inferSelect): MappingResult {
  const kind: MonitorKind = row.watchType === 'service' ? 'service' : 'process';
  const spec = getMonitorKindSpec(kind);
  const notes: string[] = [];
  const responses: unknown[] = row.autoRestart
    ? [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: row.maxRestartAttempts, cooldownSeconds: row.restartCooldownSeconds, whenOffline: 'queue' }]
    : [];
  notes.push(`Legacy watches never raised an inbox alert (the monitoring-results ingest only counts failures); the monitor raises a ${spec.defaultSeverity} alert after ${row.alertAfterConsecutiveFailures} consecutive failures.`);
  if (row.autoRestart) notes.push(`Auto-restart stays agent-local (max ${row.maxRestartAttempts} attempts, ${row.restartCooldownSeconds}s cooldown) as a restart_service response.`);
  if (!row.alertOnStop) notes.push('alertOnStop=false was stored but never read at runtime; ignored.');

  const base = { enabled: row.enabled, severity: spec.defaultSeverity, cooldownMinutes: 5, autoResolve: false, deliveryMode: 'inherit' as const, deliveryChannelIds: [], escalationPolicyId: null };
  const durationMinutes = row.thresholdDurationSeconds > 0 ? Math.ceil(row.thresholdDurationSeconds / 60) : undefined;
  const proposed: ProposedMonitor[] = [{
    ...base, role: 'primary', kind, name: row.name, responses,
    condition: kind === 'service'
      ? { serviceName: row.name, consecutiveFailures: row.alertAfterConsecutiveFailures }
      : { processName: row.name, consecutiveFailures: row.alertAfterConsecutiveFailures },
  }];
  const resourceSpec = getMonitorKindSpec('process_resource');
  if (row.cpuThresholdPercent != null) {
    proposed.push({ ...base, role: 'resource_cpu', kind: 'process_resource', name: `${row.name} — CPU`, severity: resourceSpec.defaultSeverity, responses: [],
      condition: { resource: 'cpu', processName: row.name, operator: 'gt', value: row.cpuThresholdPercent, ...(durationMinutes ? { durationMinutes } : {}) } });
  }
  if (row.memoryThresholdMb != null) {
    proposed.push({ ...base, role: 'resource_memory', kind: 'process_resource', name: `${row.name} — memory`, severity: resourceSpec.defaultSeverity, responses: [],
      condition: { resource: 'memory', processName: row.name, operator: 'gt', value: row.memoryThresholdMb, ...(durationMinutes ? { durationMinutes } : {}) } });
  }
  return { ok: true, proposed, notes };
}

export function mapStandaloneRule(rule: typeof alertRules.$inferSelect, template: typeof alertTemplates.$inferSelect): MappingResult {
  const overrides = (rule.overrideSettings ?? {}) as Record<string, unknown>;
  const mapped = mapConditions(overrides.conditions ?? template.conditions);
  if ('code' in mapped) return fail(mapped.code);
  const channelIds = Array.isArray(overrides.notificationChannelIds) ? (overrides.notificationChannelIds as string[]) : [];
  return {
    ok: true, notes: [],
    proposed: [{
      role: 'primary', enabled: rule.isActive, kind: mapped.kind, name: rule.name, condition: mapped.condition,
      severity: (overrides.severity as ProposedMonitor['severity'] | undefined) ?? template.severity,
      cooldownMinutes: (overrides.cooldownMinutes as number | undefined) ?? template.cooldownMinutes,
      autoResolve: template.autoResolve,
      deliveryMode: channelIds.length > 0 ? 'channels' : 'inherit',
      deliveryChannelIds: channelIds,
      escalationPolicyId: (overrides.escalationPolicyId as string | undefined) ?? null,
      responses: [],
      ...(template.description ? { description: template.description } : {}),
    }],
  };
}

export function mapAutomationResponses(row: typeof automations.$inferSelect): { actions: unknown[]; notes: string[] } {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  return { actions, notes: [`${actions.length} action(s) from automation "${row.name}" become monitor responses.`] };
}

const VOLATILE_ACTION_KEYS = new Set(['id', 'createdAt', 'updatedAt']);
export function fingerprintAction(action: unknown): string {
  if (!isRecord(action)) return sha(canonical(action));
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) if (!VOLATILE_ACTION_KEYS.has(k)) stripped[k] = v;
  return sha(canonical(stripped));
}

export function monitorSignature(m: Pick<ProposedMonitor, 'enabled' | 'kind' | 'condition' | 'severity' | 'cooldownMinutes' | 'autoResolve' | 'deliveryMode' | 'deliveryChannelIds' | 'escalationPolicyId' | 'responses'>): string {
  return sha(canonical({
    enabled: m.enabled, kind: m.kind, condition: m.condition, severity: m.severity, cooldownMinutes: m.cooldownMinutes, autoResolve: m.autoResolve,
    deliveryMode: m.deliveryMode, deliveryChannelIds: [...m.deliveryChannelIds].sort(), escalationPolicyId: m.escalationPolicyId,
    responses: (m.responses as unknown[]).map(fingerprintAction),
  }));
}

export function previewHash(input: { policyId: string; items: ConversionPreviewItem[]; inheritanceMode: string }): string {
  return sha(canonical({
    policyId: input.policyId,
    inheritanceMode: input.inheritanceMode,
    items: input.items.map((i) => ({ t: i.sourceTable, id: i.sourceId, o: i.outcome, r: i.reason ?? null, p: i.proposed.map(monitorSignature), actions: i.responseActions ?? [], workflow: i.workflow ?? null })),
  }));
}
```

(`normalizeMetricName` returns the DB column name; `processCount` is the one metric with no monitor kind — `monitorConversion.ts:23-27, 68-70`.)

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/monitors/conversion/mapping.test.ts src/services/monitors/monitorConversion.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

`git add apps/api/src/services/monitors/conversion/mapping.ts apps/api/src/services/monitors/conversion/mapping.test.ts && git commit -m "feat(monitors): pure legacy-source → monitor mappers with signature and preview hash"`

### Task 11: Load a policy's unretired sources, open-alert counts, and the pending counts for the banner

**Files:**
- Create: `apps/api/src/services/monitors/conversion/loadSources.ts`
- Test: `apps/api/src/services/monitors/conversion/loadSources.test.ts` (Drizzle-mock queue, same harness style as `helpers.monitorWatchDelivery.test.ts`)
- Reads: `configPolicyFeatureLinks` (the policy's OWN links — `configurationPolicy.ts:384-386` documents why not the effective view), `configPolicyAlertRules`, `configPolicyMonitoringSettings` + `configPolicyMonitoringWatches`, `configPolicyAutomations`, `automations` (owner axis of the policy), `alerts`

**Interfaces:**

```ts
export interface PolicySources {
  policy: { id: string; name: string; orgId: string | null; partnerId: string | null; parentPolicyId: string | null };
  links: { alertRule: string | null; monitoring: string | null; monitoringSettingsId: string | null; monitors: { id: string; inheritance: 'cumulative' | 'replace'; items: MonitorAttachmentItem[] } | null };
  inlineRules: Array<typeof configPolicyAlertRules.$inferSelect>;           // retired_at IS NULL
  watches: Array<typeof configPolicyMonitoringWatches.$inferSelect>;         // retired_at IS NULL
  policyAutomations: Array<typeof configPolicyAutomations.$inferSelect>;     // trigger_type = 'event' AND event_type = 'alert.triggered' AND retired_at IS NULL
  standaloneAutomations: Array<typeof automations.$inferSelect>;             // owner axis of the policy, event alert.triggered, filter.configPolicyAlertRuleId ∈ inlineRules ids, retired_at IS NULL
  openAlertsBySource: Map<string, number>;                                   // key = source id (inline rule id); watches/automations have no alert path → 0
  parentUnconverted: boolean;                                                // parentPolicyId has ≥1 unretired inline rule or watch
}
export async function loadPolicySources(policyId: string, executor?: DbExecutor): Promise<PolicySources | null>;
export async function countPendingConversions(scope: { orgId: string | null; partnerId: string | null; includePartnerWide: boolean }, executor?: DbExecutor): Promise<PendingConversionCounts & { standaloneRules: number }>;
```

`countPendingConversions` counts, over active policies in scope (org-owned for `orgId`, plus partner-wide for `partnerId` when `includePartnerWide`; all orgs under the partner when `orgId` is null): `policies` = distinct policies with ≥1 unretired inline rule / watch / `alert.triggered` policy automation; `rows` = the sum of those rows; `standaloneRules` = unretired `alert_rules` in the same scope with `managed_by_monitor_id IS NULL` (additive field; W05e adds `networkChecks`).

- [ ] **Step 1: Write the failing test** — queue-driven: policy row → links → inline rules → settings → watches → policy automations → standalone automations → open-alert counts → parent rows; assert the returned shape, that `standaloneAutomations` keeps only rows whose normalized trigger is `event/alert.triggered` with `filter.configPolicyAlertRuleId` in the rule ids, that `openAlertsBySource.get('r1') === 2`, and that `parentUnconverted` is true when the parent read returns one row. Second test: `countPendingConversions({ orgId: 'o1', partnerId: 'p1', includePartnerWide: true })` sums the three grouped counts and the standalone count.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/monitors/conversion/loadSources.test.ts` → `Cannot find module './loadSources'`.

- [ ] **Step 3: Implement** — `loadSources.ts` (reads in the order the test queues them; every legacy read carries `isNull(<table>.retiredAt)`):

```ts
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { monitorsInlineSettingsSchema, type MonitorAttachmentItem } from '@breeze/shared';
import { db } from '../../../db';
import { alerts, alertRules } from '../../../db/schema/alerts';
import { automations } from '../../../db/schema/automations';
import {
  configPolicyAlertRules, configPolicyAutomations, configPolicyFeatureLinks,
  configPolicyMonitoringSettings, configPolicyMonitoringWatches, configurationPolicies,
} from '../../../db/schema/configurationPolicies';
import { organizations } from '../../../db/schema/orgs';
import { normalizeAutomationTrigger } from '../../automationRuntime';
import type { PendingConversionCounts } from './types';

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export const OPEN_ALERT_STATUSES = ['active', 'acknowledged', 'suppressed'] as const; // alertService.ts:202-206 dedupe set

export async function loadPolicySources(policyId: string, executor: DbExecutor = db): Promise<PolicySources | null> {
  const [policy] = await executor
    .select({ id: configurationPolicies.id, name: configurationPolicies.name, orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId, parentPolicyId: configurationPolicies.parentPolicyId })
    .from(configurationPolicies).where(eq(configurationPolicies.id, policyId)).limit(1);
  if (!policy) return null;

  const links = await executor.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, policyId));
  const link = (t: string) => links.find((l) => l.featureType === t) ?? null;
  const alertRuleLink = link('alert_rule'); const monitoringLink = link('monitoring'); const monitorsLink = link('monitors');

  const inlineRules = alertRuleLink
    ? await executor.select().from(configPolicyAlertRules).where(and(eq(configPolicyAlertRules.featureLinkId, alertRuleLink.id), isNull(configPolicyAlertRules.retiredAt))).orderBy(configPolicyAlertRules.sortOrder)
    : [];
  const [settings] = monitoringLink
    ? await executor.select().from(configPolicyMonitoringSettings).where(eq(configPolicyMonitoringSettings.featureLinkId, monitoringLink.id)).limit(1)
    : [];
  const watches = settings
    ? await executor.select().from(configPolicyMonitoringWatches).where(and(eq(configPolicyMonitoringWatches.settingsId, settings.id), isNull(configPolicyMonitoringWatches.retiredAt))).orderBy(configPolicyMonitoringWatches.sortOrder)
    : [];
  const automationLink = link('automation');
  const policyAutomations = automationLink
    ? (await executor.select().from(configPolicyAutomations).where(and(eq(configPolicyAutomations.featureLinkId, automationLink.id), isNull(configPolicyAutomations.retiredAt))))
        .filter((a) => a.triggerType === 'event' && a.eventType === 'alert.triggered')
    : [];

  const ruleIds = new Set(inlineRules.map((r) => r.id));
  const ownerCondition = policy.orgId ? eq(automations.orgId, policy.orgId) : and(isNull(automations.orgId), eq(automations.partnerId, policy.partnerId!));
  const candidates = ruleIds.size > 0
    ? await executor.select().from(automations).where(and(ownerCondition, isNull(automations.retiredAt), isNull(automations.managedByMonitorId)))
    : [];
  const standaloneAutomations = candidates.filter((a) => {
    try {
      const t = normalizeAutomationTrigger(a.trigger);
      if (t.type !== 'event' || t.eventType !== 'alert.triggered') return false;
      const ref = (t.filter as Record<string, unknown> | undefined)?.configPolicyAlertRuleId;
      return typeof ref === 'string' && ruleIds.has(ref);
    } catch { return false; }
  });

  const openAlertsBySource = new Map<string, number>();
  if (ruleIds.size > 0) {
    const counts = await executor
      .select({ sourceId: alerts.configPolicyId, count: sql<number>`count(*)::int` })
      .from(alerts)
      .where(and(inArray(alerts.configPolicyId, [...ruleIds]), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
      .groupBy(alerts.configPolicyId);
    for (const c of counts) if (c.sourceId) openAlertsBySource.set(c.sourceId, c.count);
  }

  let parentUnconverted = false;
  if (policy.parentPolicyId) {
    const [row] = await executor
      .select({ n: sql<number>`count(*)::int` })
      .from(configPolicyFeatureLinks)
      .leftJoin(configPolicyAlertRules, and(eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id), isNull(configPolicyAlertRules.retiredAt)))
      .leftJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
      .leftJoin(configPolicyMonitoringWatches, and(eq(configPolicyMonitoringWatches.settingsId, configPolicyMonitoringSettings.id), isNull(configPolicyMonitoringWatches.retiredAt)))
      .where(and(eq(configPolicyFeatureLinks.configPolicyId, policy.parentPolicyId), or(sql`${configPolicyAlertRules.id} IS NOT NULL`, sql`${configPolicyMonitoringWatches.id} IS NOT NULL`)));
    parentUnconverted = (row?.n ?? 0) > 0;
  }

  const monitorsSettings = monitorsLink ? monitorsInlineSettingsSchema.safeParse(monitorsLink.inlineSettings ?? { items: [] }) : null;
  return {
    policy,
    links: {
      alertRule: alertRuleLink?.id ?? null,
      monitoring: monitoringLink?.id ?? null,
      monitoringSettingsId: settings?.id ?? null,
      monitors: monitorsLink ? { id: monitorsLink.id, inheritance: monitorsSettings?.success ? monitorsSettings.data.inheritance : 'cumulative', items: monitorsSettings?.success ? monitorsSettings.data.items : [] } : null,
    },
    inlineRules, watches, policyAutomations, standaloneAutomations, openAlertsBySource, parentUnconverted,
  };
}
```

`countPendingConversions` — three grouped counts joined through `configPolicyFeatureLinks → configurationPolicies` filtered by the scope's ownership predicate (`configurationPolicies.orgId = orgId`, or `orgId IN (select id from organizations where partner_id = partnerId)` when `orgId` is null, `OR (org_id IS NULL AND partner_id = partnerId)` when `includePartnerWide`) and `status = 'active'`; the standalone count is `alert_rules` under the same ownership with `managed_by_monitor_id IS NULL AND retired_at IS NULL`. Return `{ policies: <distinct policy ids>, rows: <sum>, standaloneRules }`.

- [ ] **Step 4: Run, expect PASS** — `cd apps/api && npx vitest run src/services/monitors/conversion/ && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** — `git add apps/api/src/services/monitors/conversion/loadSources.ts apps/api/src/services/monitors/conversion/loadSources.test.ts && git commit -m "feat(monitors): load a policy's unretired legacy sources and pending-conversion counts"`

### Task 12: Private normalized legacy baseline and inherited consumer scope

**Files:**
- Create: `apps/api/src/services/monitors/conversion/legacyBaseline.ts`, adjacent `legacyBaseline.test.ts`.
- Reads: `apps/api/src/services/featureConfigResolver.ts:105-244,379-446` (normalized rows and assignment winner); `apps/api/src/routes/agents/helpers.ts:2242-2375` (settings winner before enabled watches); `apps/api/src/db/schema/configurationPolicies.ts:163-188` (effective view's `sourcePolicyId`); `apps/api/src/services/configPolicyOwnership.ts:62`.
- Test: `apps/api/src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts` (final task supplies the fixture).

**Interfaces:**
- Produces `resolveLegacyBaseline(deviceId: string, executor: DbExecutor): Promise<LegacyBaseline>` and internal `resolveDeviceIdsForPolicy(policyId: string, executor: DbExecutor): Promise<string[]>`.
- Consumes normalized tables only; no public legacy reader imports. W05d retains this module. Empty rule links fall through; empty winning watch settings do not. Enabled state and role/OS filters retain their runtime meaning. The INFERRED baseline and inherited-scope findings are confirmed by the code cited above.

- [ ] **Step 1: Write the failing tests**

```ts
// legacyBaseline.test.ts
import { expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resolveLegacyBaseline, resolveDeviceIdsForPolicy, type DbExecutor } from './legacyBaseline';
function fixture(results: unknown[][]) {
  const predicates: any[] = [];
  function query() {
    const result = results.shift() ?? [];
    const c: any = { then: (yes: any, no: any) => Promise.resolve(result).then(yes, no) };
    for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
      c[name] = (...args: unknown[]) => {
        if (name === 'where') predicates.push(args[0]);
        if (name.endsWith('Join')) predicates.push(args[1]);
        return c;
      };
    }
    return c;
  }
  return { executor: { select: query, selectDistinct: query } as unknown as DbExecutor, predicates };
}
const device = { id: 'd', orgId: 'o', siteId: 's', deviceRole: 'server', osType: 'windows' };
it('empty rule links fall through to the closest assignment with normalized rules', async () => {
  const f = fixture([[device], [{ partnerId: 'p' }], [], [
    { rule: { id: 'parent-rule' }, assignmentId: 'parent', level: 'organization', priority: 0, createdAt: new Date(0) },
  ], []]);
  expect((await resolveLegacyBaseline('d', f.executor)).rules.map((r) => r.id)).toEqual(['parent-rule']);
  expect(f.predicates.map((p) => new PgDialect().sqlToQuery(p).sql).join(' ')).toContain('"retired_at" is null');
});
it('an empty enabled-watch set clears watches rather than selecting the next policy', async () => {
  const f = fixture([[device], [{ partnerId: 'p' }], [], [], [
    { settingsId: 'parent', level: 'organization', priority: 0, checkIntervalSeconds: 60 },
    { settingsId: 'child', level: 'site', priority: 0, checkIntervalSeconds: 30 },
  ], []]);
  expect((await resolveLegacyBaseline('d', f.executor)).monitoring).toEqual({ settingsId: 'child', checkIntervalSeconds: 30, watches: [] });
  expect(new PgDialect().sqlToQuery(f.predicates.at(-1)).params).toEqual(['child', true]);
});
it('scope follows effective-link consumers and role/OS filters', async () => {
  const f = fixture([[{ id: 'child-device' }]]);
  expect(await resolveDeviceIdsForPolicy('unassigned-parent', f.executor)).toEqual(['child-device']);
  const text = f.predicates.map((p) => new PgDialect().sqlToQuery(p).sql).join(' ');
  for (const column of ['source_policy_id', 'role_filter', 'os_filter', 'partner_id']) expect(text).toContain(column);
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/monitors/conversion/legacyBaseline.test.ts` → cannot resolve `./legacyBaseline`.

- [ ] **Step 3: Implement**

```ts
// legacyBaseline.ts
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { devices, organizations, deviceGroupMemberships, configurationPolicies,
  configPolicyAssignments, configPolicyEffectiveFeatureLinks, configPolicyAlertRules,
  configPolicyMonitoringSettings, configPolicyMonitoringWatches } from '../../../db/schema';
import { policyOwnershipCondition } from '../../configPolicyOwnership';
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface LegacyBaseline {
  rules: Array<typeof configPolicyAlertRules.$inferSelect>;
  monitoring: { settingsId: string; checkIntervalSeconds: number;
    watches: Array<typeof configPolicyMonitoringWatches.$inferSelect> } | null;
}
const LEVEL: Record<string, number> = { device: 5, device_group: 4, site: 3, organization: 2, partner: 1 };
export async function resolveLegacyBaseline(deviceId: string, executor: DbExecutor): Promise<LegacyBaseline> {
  const [device] = await executor.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) return { rules: [], monitoring: null };
  const [org] = await executor.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, device.orgId)).limit(1);
  const groups = await executor.select({ groupId: deviceGroupMemberships.groupId }).from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const targets = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (org?.partnerId) targets.push(and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId)));
  if (groups.length) targets.push(and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groups.map((g) => g.groupId))));
  const filters = and(or(...targets),
    sql`(${configPolicyAssignments.roleFilter} IS NULL OR ${device.deviceRole} = ANY(${configPolicyAssignments.roleFilter}))`,
    sql`(${configPolicyAssignments.osFilter} IS NULL OR ${device.osType} = ANY(${configPolicyAssignments.osFilter}))`);
  const owner = policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null });
  const rows = await executor.select({ rule: configPolicyAlertRules, assignmentId: configPolicyAssignments.id,
    level: configPolicyAssignments.level, priority: configPolicyAssignments.priority, createdAt: configPolicyAssignments.createdAt })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, and(eq(configPolicyAssignments.configPolicyId, configurationPolicies.id), eq(configurationPolicies.status, 'active'), owner))
    .innerJoin(configPolicyEffectiveFeatureLinks, and(eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id), eq(configPolicyEffectiveFeatureLinks.featureType, 'alert_rule')))
    .innerJoin(configPolicyAlertRules, and(eq(configPolicyAlertRules.featureLinkId, configPolicyEffectiveFeatureLinks.id), isNull(configPolicyAlertRules.retiredAt)))
    .where(filters).orderBy(configPolicyAssignments.level, configPolicyAssignments.priority, configPolicyAssignments.createdAt, asc(configPolicyAlertRules.sortOrder));
  rows.sort((a, b) => (LEVEL[b.level] ?? 0) - (LEVEL[a.level] ?? 0) || a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  const rules = rows.filter((r) => r.assignmentId === rows[0]?.assignmentId).map((r) => r.rule);
  const settings = await executor.select({ settingsId: configPolicyMonitoringSettings.id,
    checkIntervalSeconds: configPolicyMonitoringSettings.checkIntervalSeconds,
    level: configPolicyAssignments.level, priority: configPolicyAssignments.priority })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyEffectiveFeatureLinks, and(eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id), eq(configPolicyEffectiveFeatureLinks.featureType, 'monitoring')))
    .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id))
    .where(and(eq(configurationPolicies.status, 'active'), owner, filters));
  // Actual watch runtime has no creation-time tie-breaker; preserve that order.
  settings.sort((a, b) => (LEVEL[b.level] ?? 0) - (LEVEL[a.level] ?? 0) || a.priority - b.priority);
  const winner = settings[0];
  if (!winner) return { rules, monitoring: null };
  const watches = await executor.select().from(configPolicyMonitoringWatches)
    .where(and(eq(configPolicyMonitoringWatches.settingsId, winner.settingsId), eq(configPolicyMonitoringWatches.enabled, true), isNull(configPolicyMonitoringWatches.retiredAt)))
    .orderBy(configPolicyMonitoringWatches.sortOrder);
  return { rules, monitoring: { settingsId: winner.settingsId, checkIntervalSeconds: winner.checkIntervalSeconds, watches } };
}
export async function resolveDeviceIdsForPolicy(policyId: string, executor: DbExecutor = db): Promise<string[]> {
  const rows = await executor.selectDistinct({ id: devices.id }).from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .innerJoin(configPolicyAssignments, or(
      and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, devices.id)),
      and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, devices.siteId)),
      and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, devices.orgId)),
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, organizations.partnerId)),
      and(eq(configPolicyAssignments.level, 'device_group'), sql`EXISTS (SELECT 1 FROM ${deviceGroupMemberships}
        WHERE ${deviceGroupMemberships.deviceId} = ${devices.id} AND ${deviceGroupMemberships.groupId} = ${configPolicyAssignments.targetId})`)))
    .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyAssignments.configPolicyId))
    .leftJoin(configPolicyEffectiveFeatureLinks, eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(eq(configurationPolicies.status, 'active'),
      or(eq(configurationPolicies.orgId, devices.orgId), and(isNull(configurationPolicies.orgId), eq(configurationPolicies.partnerId, organizations.partnerId))),
      or(eq(configurationPolicies.id, policyId), eq(configPolicyEffectiveFeatureLinks.sourcePolicyId, policyId)),
      sql`(${configPolicyAssignments.roleFilter} IS NULL OR ${devices.deviceRole} = ANY(${configPolicyAssignments.roleFilter}))`,
      sql`(${configPolicyAssignments.osFilter} IS NULL OR ${devices.osType} = ANY(${configPolicyAssignments.osFilter}))`))
    .orderBy(devices.id);
  return rows.map((r) => r.id);
}
```

Add to the final round-trip suite, using its actual `conversionFixture` and schema imports:

```ts
it('checks a parent with no direct assignment through its assigned inheriting child', async () => {
  const f = await conversionFixture();
  await withDbAccessContext(orgContext(f), async () => {
    const [child] = await db.insert(configurationPolicies).values({ orgId: f.orgId, partnerId: null,
      name: 'Inheriting child', parentPolicyId: f.policyId, status: 'active', createdBy: f.userId }).returning();
    await db.update(configPolicyAssignments).set({ configPolicyId: child!.id })
      .where(eq(configPolicyAssignments.configPolicyId, f.policyId));
    expect(await resolveDeviceIdsForPolicy(f.policyId, db)).toContain(f.deviceId);
  });
});
```

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/monitors/conversion/legacyBaseline.test.ts && npx tsc --noEmit -p .`; final verification runs the actual inherited-parent SQL case under RLS.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/monitors/conversion/legacyBaseline.ts apps/api/src/services/monitors/conversion/legacyBaseline.test.ts apps/api/src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts && git commit -m "fix(monitors): preserve normalized legacy semantics and inherited conversion scope"`

### Task 13: Equivalence check over every device in scope (dry-run transaction), job-backed above 500 devices

**Files:**
- Create: `apps/api/src/services/monitors/conversion/equivalence.ts`
- Create: `apps/api/src/jobs/monitorConversionPreviewWorker.ts`
- Modify: `apps/api/src/services/workerRegistry.ts:76-85` (socket-owner lifecycle registration, finalized in Task 18).
- Create: `apps/api/src/services/monitors/conversion/previewScope.ts`, adjacent `previewScope.test.ts`.
- Test: `apps/api/src/services/monitors/conversion/equivalence.test.ts` (pure diff + device-scope filter), `apps/api/src/jobs/monitorConversionPreviewWorker.test.ts` (job data → `withDbAccessContext` + progress writes, harness after `jobs/alertWorker.test.ts`)
- Reads: `configurationPolicy.ts:2580-2627` (`previewEffectiveConfig` — the rolled-back-transaction pattern to mirror), `:2568` (`resolveEffectiveConfig` / `resolveEffectiveConfigWithExecutor(executor, deviceId, auth)`), `featureConfigResolver.ts:1077-1175` (`resolveDeviceIdsForSoftwarePolicy` — the device-scope walk to mirror, keyed on a policy id), `:146-167` (`matchesRoleOsFilter`, `buildRoleOsFilterConditions`), `monitorResolver.ts` (`resolveMonitorsForDevice(deviceId, executor)`), `db/index.ts:642` (`withDbAccessContext(context, fn)`), `services/redis.ts:125,286`, `services/bullmqQueue.ts:41` (`createInstrumentedQueue`)

**Interfaces:**

```ts
export interface EquivalenceProposal {
  policy: PolicySources['policy'];
  inheritanceMode: 'cumulative' | 'replace';
  /** convertible items only: source id → the monitors to mint (or reuse) */
  bySource: Array<{ sourceTable: ConversionSourceTable; sourceId: string; monitors: ProposedMonitor[]; workflow?: ConversionPreviewItem['workflow']; responseTargetSourceId?: string }>;
}
export async function resolveDeviceIdsForPolicy(policyId: string, executor?: DbExecutor): Promise<string[]>; // private baseline module: own and inheriting effective-link consumers, role/OS filters
export function diffSignatureSets(before: Map<string, string>, after: Map<string, string>): string[]; // label→signature maps; returns human-readable deltas
export async function computeEquivalence(proposal: EquivalenceProposal, deviceIds: string[], auth: AuthContext, onProgress?: (checked: number, total: number) => Promise<void> | void): Promise<{ devicesChecked: number; deltas: EquivalenceDelta[] }>;

// job worker
export const MONITOR_CONVERSION_PREVIEW_QUEUE = 'monitor-conversion-preview';
export interface ConversionPreviewJobData { policyId: string; snapshot: PreviewAccessSnapshot; sourcesHash: string; scopeHash: string }
export function getMonitorConversionPreviewQueue(): Queue;
export function createMonitorConversionPreviewWorker(): Worker<ConversionPreviewJobData>;
export const previewJobKey = (policyId: string, scopeHash: string, sourcesHash: string) => `monitorconv:preview:${policyId}:${scopeHash}:${sourcesHash}`; // Redis JSON { status:'running'|'done'|'failed', progress:{checked,total}, sourcesHash, result?: PolicyConversionPreview, error?: string, startedAt }, TTL 3600 s
```

Before / after, per device — both sides expressed as `monitorSignature` strings keyed by a label so a delta can say WHAT changed:

- **before**: `resolveLegacyBaseline(deviceId, tx)` reads the normalized legacy rules and enabled watches with the real winner/fall-through semantics. Add the existing enabled effective monitors. Load standalone response automations targeting these rules and merge their canonical ordered actions before signing, so already-running responses are part of the baseline.
- **after**: inside the same repeatable-read transaction, mint proposed definitions and attachments (`enabled` copied on both), retire the selected source rows, and compute `resolveLegacyBaseline(deviceId, tx)` plus `resolveMonitorsForDevice(deviceId, tx)` again; throw `PreviewRollback` so no proposed mutation persists. Public `resolveEffectiveConfig` and public legacy readers are never used. All policies/devices/assignments/definitions and routing/channel/escalation rows are fingerprinted from this same snapshot. Compare resolved delivery through W05b's `resolveDelivery(input, tx)` on BOTH sides, with no kind on a legacy rule and the new monitor's kind/id afterward. That catches a CPU-kind route newly matching an inherited legacy rule. Escalation uses D22 on both sides: the monitor's explicit policy (unless `deliveryMode = 'none'`) → an unretired legacy source's explicit policy → the winning routing row's policy → null. Before conversion, legacy escalation must beat routing even when the source inherits channels; afterward the carried monitor policy must produce the same resolved escalation.
- A device's delta = labels present on one side only, or same label with a different signature: `"device <id>: gains <name> (<kind>) from <policy>"`, `"loses …"`, `"<name>: severity high → low"` (the signature carries kind/condition/severity/cooldown/autoResolve/delivery/responses, so any of those changing is a delta). `deltas` is capped at 200 entries with a final `"… and N more"` entry.

Devices come from `legacyBaseline.resolveDeviceIdsForPolicy`, including assigned inheriting children; no direct-assignment shortcut. Reject site/device-restricted preview callers with the shared governance guard before loading device details, rather than certifying a partial policy scope. Above 500 devices use the original principal snapshot; never `createSystemAuthContext()` for an interactive job. On each GET poll and confirmation, current middleware auth must pass the owner/governance checks again; recompute both fingerprints before returning cached results. Do not serve a result under a narrower/wider/revoked caller snapshot.

- [ ] **Step 1: Write the failing tests** — `equivalence.test.ts`: an unretired legacy rule with inherited channels and explicit escalation A against a winning route with escalation B resolves A before conversion and the carried monitor escalation A afterward (no escalation delta); dropping A from the proposal produces a delta; a retired source supplies no legacy escalation. `diffSignatureSets` (gain / loss / change / identical → `[]`); `resolveDeviceIdsForPolicy` with a mocked queue (assignments: one `site` with `roleFilter: ['server']`, devices under the site with roles `server` and `workstation` → only the server id). `monitorConversionPreviewWorker.test.ts`: the processor calls `withDbAccessContext` with `job.data.snapshot.dbContext` (mock `../db`), writes a running entry then a done entry to the mocked Redis (`setex` calls with the key from `previewJobKey`), and a thrown preview error writes `{ status: 'failed', error }`.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/monitors/conversion/equivalence.test.ts src/jobs/monitorConversionPreviewWorker.test.ts` → module-not-found for both.

- [ ] **Step 3: Implement** — `equivalence.ts` core (scope comes from the private baseline task):

```ts
class PreviewRollback extends Error {}

import { resolveDelivery } from '../../delivery/resolveDelivery';
import { resolveLegacyBaseline, resolveDeviceIdsForPolicy } from './legacyBaseline';
import type { LegacyBaseline } from './legacyBaseline';
import { canonical, sha, mergeResponseProposals } from './mapping';

async function effectiveSignature(p: ProposedMonitor, input: Parameters<typeof resolveDelivery>[0], executor: DbExecutor) {
  const resolved = await resolveDelivery(input, executor);
  return sha(canonical({
    behavior: monitorSignature({ ...p, deliveryMode: 'channels',
      deliveryChannelIds: resolved.channelIds, escalationPolicyId: resolved.escalationPolicyId }),
    skippedChannelIds: [...resolved.skippedChannelIds].sort((a, b) => a.id.localeCompare(b.id)),
  }));
}
async function signatureMapForLegacy(deviceId: string, effective: LegacyBaseline, executor: DbExecutor): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const [device] = await executor.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) return out;
  for (const row of effective.rules) {
    const mapped = mapInlineRule(row);
    if (!mapped.ok) { out.set(`legacy:${row.id}`, sha(canonical(row))); continue; }
    // The same loader and merge are used by preview: actions exist before conversion too.
    const candidates = await executor.select().from(automations).where(and(isNull(automations.retiredAt), eq(automations.enabled, true),
      sql`${automations.trigger}->'filter'->>'configPolicyAlertRuleId' = ${row.id}`));
    const responses = candidates.map((a) => ({ sourceTable: 'automations' as const, sourceId: a.id, name: a.name,
      outcome: 'convertible' as const, proposed: [], notes: [], openAlerts: 0,
      responseTargetSourceId: row.id, responseActions: a.actions as unknown[] }));
    const [item] = mergeResponseProposals([{ sourceTable: 'config_policy_alert_rules', sourceId: row.id, name: row.name,
      outcome: 'convertible', proposed: mapped.proposed, notes: [], openAlerts: 0 }, ...responses]);
    for (const p of item!.proposed) out.set(`rule:${row.id}:${p.role}`, await effectiveSignature(p, {
      orgId: device.orgId, siteId: device.siteId, severity: p.severity, kind: null,
      legacyOverride: { channelIds: row.notificationChannelIds, escalationPolicyId: row.escalationPolicyId },
    }, executor));
  }
  for (const row of effective.monitoring?.watches ?? []) {
    if (!row.enabled) continue;
    const mapped = mapWatch(row);
    if (!mapped.ok) { out.set(`legacy:watch:${row.id}`, sha(canonical(row))); continue; }
    for (const p of mapped.proposed) out.set(`watch:${row.id}:${p.role}`, await effectiveSignature(p,
      { orgId: device.orgId, siteId: device.siteId, severity: p.severity, kind: null }, executor));
  }
  return out;
}

async function signatureMapForMonitors(deviceId: string, executor: DbExecutor): Promise<Map<string, string>> {
  const res = await resolveMonitorsForDevice(deviceId, executor);
  const out = new Map<string, string>();
  if (res.kind !== 'resolved') return out;
  const enabled = res.monitors.filter((m) => m.enabled);
  if (enabled.length === 0) return out;
  const defs = await executor.select().from(monitorDefinitions).where(inArray(monitorDefinitions.id, enabled.map((m) => m.monitorId)));
  const [device] = await executor.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) return out;
  for (const def of defs) {
    if (!def.enabled) continue;
    const eff = enabled.find((m) => m.monitorId === def.id)!;
    const spec = getMonitorKindSpec(def.kind);
    const condition = applyOverrides(spec, spec.conditionSchema.parse(def.condition), eff.overrides);
    out.set(`monitor:${def.id}`, await effectiveSignature({
      enabled: true, role: 'primary', name: def.name, kind: def.kind, condition, severity: (eff.overrides?.severity as ProposedMonitor['severity']) ?? def.severity,
      cooldownMinutes: def.cooldownMinutes, autoResolve: def.autoResolve, deliveryMode: def.deliveryMode as ProposedMonitor['deliveryMode'],
      deliveryChannelIds: def.deliveryChannelIds, escalationPolicyId: def.escalationPolicyId, responses: def.responses,
    }, { orgId: device.orgId, siteId: device.siteId, monitorId: def.id, kind: def.kind,
      severity: (eff.overrides?.severity as ProposedMonitor['severity']) ?? def.severity }, executor));
  }
  return out;
}

export function diffSignatureSets(before: Map<string, string>, after: Map<string, string>): string[] {
  const counts = (values: Map<string, string>) => {
    const out = new Map<string, number>();
    for (const value of values.values()) out.set(value, (out.get(value) ?? 0) + 1);
    return out;
  };
  const a = counts(before), b = counts(after), deltas: string[] = [];
  for (const signature of new Set([...a.keys(), ...b.keys()])) {
    const delta = (b.get(signature) ?? 0) - (a.get(signature) ?? 0);
    if (delta) deltas.push(`${delta > 0 ? 'gains' : 'loses'} ${Math.abs(delta)} condition instance(s): ${signature}`);
  }
  return deltas;
}

export async function computeEquivalence(proposal, deviceIds, auth, onProgress) {
  const deltas: EquivalenceDelta[] = [];
  const before = new Map<string, Map<string, string>>();
  let checked = 0;
  try {
    await db.transaction(async (tx) => {
      for (const id of deviceIds) {
        const legacy = await signatureMapForLegacy(id, await resolveLegacyBaseline(id, tx), tx);
        const monitors = await signatureMapForMonitors(id, tx);
        before.set(id, new Map([...legacy, ...monitors]));
      }
      await applyProposalInTx(tx, proposal, auth);   // insert defs, upsert link + attachments, retire this policy's source rows
      for (const id of deviceIds) {
        const legacy = await signatureMapForLegacy(id, await resolveLegacyBaseline(id, tx), tx);
        const monitors = await signatureMapForMonitors(id, tx);
        for (const d of diffSignatureSets(before.get(id)!, new Map([...legacy, ...monitors]))) {
          if (deltas.length < 200) deltas.push({ deviceId: id, detail: d });
        }
        checked++;
        if (onProgress && checked % 50 === 0) await onProgress(checked, deviceIds.length);
      }
      throw new PreviewRollback();
    }, { isolationLevel: 'repeatable read' });
  } catch (err) {
    if (!(err instanceof PreviewRollback)) throw err;
  }
  if (deltas.length === 200) deltas.push({ deviceId: '*', detail: '… and more devices differ' });
  return { devicesChecked: checked, deltas };
}
```

`applyProposalInTx` is exported and reused by the real converter. Extend `EquivalenceProposal.bySource` with `workflow?: ConversionPreviewItem['workflow']`, `responseTargetSourceId?: string`, and the complete merged proposals. Process `config_policy_automations` through the rehome helper and source ledger in BOTH dry-run and commit. Never call `updateFeatureLink` to append attachments: it deletes/reinserts unrelated rows and invalidates provenance ids. For an existing monitors link, use this executor-aware write core (new definitions are created with `createMonitorDefinition(input, auth, {}, tx)`):

```ts
const existing = await tx.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, link.id));
const missing = proposedAttachments.filter((p) => !existing.some((e) => e.monitorId === p.monitorId));
const inserted = missing.length ? await tx.insert(configPolicyMonitors).values(missing.map((p, i) => ({
  featureLinkId: link.id, monitorId: p.monitorId, enabled: p.enabled, overrides: null,
  sortOrder: Math.max(-1, ...existing.map((e) => e.sortOrder)) + 1 + i,
}))).returning() : [];
await tx.update(configPolicyFeatureLinks).set({ inlineSettings: { inheritance: proposal.inheritanceMode,
  items: [...existing, ...inserted].map((r) => ({ monitorId: r.monitorId, enabled: r.enabled, overrides: r.overrides, sortOrder: r.sortOrder })) },
  updatedAt: new Date() }).where(eq(configPolicyFeatureLinks.id, link.id));
// Record inserted ids only; if an attachment already existed, attachmentId is null.
```

If no monitors link exists, `addFeatureLink(..., tx)` creates it once. An empty replace link is retained and shadows; delete only an empty cumulative link with no settings/history. W05d further prohibits deleting a link that owns monitoring settings or historical watches.

Caller snapshot and freshness (`previewScope.ts`): only data crosses BullMQ. Token credentials and functions never do. `null` and omitted ceilings remain distinct from empty arrays.

```ts
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { getCurrentDbAccessContext, runOutsideDbContext, type DbAccessContext } from '../../../db';
import type { AuthContext } from '../../../middleware/auth';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { getConfigPolicy } from '../../configurationPolicy';
import { canonical, sha } from './mapping';
export type SerializedAuth = Omit<AuthContext, 'orgCondition'|'canAccessOrg'|'canAccessSite'|'token'>;
export interface PreviewAccessSnapshot { auth: SerializedAuth; dbContext: DbAccessContext }
export function snapshotPreviewAccess(auth: AuthContext): PreviewAccessSnapshot {
  const dbContext = getCurrentDbAccessContext();
  if (!dbContext) throw new Error('Preview requires caller DB context');
  const { orgCondition, canAccessOrg, canAccessSite, token, ...data } = auth;
  return structuredClone({ auth: data, dbContext });
}
export function restorePreviewAuth(snapshot: PreviewAccessSnapshot): AuthContext {
  const a = snapshot.auth;
  return { ...a, token: null,
    canAccessOrg: (id) => a.scope === 'system' || (a.accessibleOrgIds ?? []).includes(id),
    canAccessSite: (id) => a.allowedSiteIds === undefined || (!!id && a.allowedSiteIds.includes(id)),
    orgCondition: (column) => a.scope === 'system' ? undefined : inArray(column, a.accessibleOrgIds ?? []),
  };
}
export const previewScopeHash = (snapshot: PreviewAccessSnapshot) => sha(canonical(snapshot));
export async function authorizePreview(policyId: string, auth: AuthContext) {
  if (!canMutateOrgWideGovernance(auth)) throw new ConversionError('partner_wide_denied', 'Full policy scope is required');
  const policy = await getConfigPolicy(policyId, auth);
  if (!policy) throw new ConversionError('policy_not_found', 'Policy not found');
  if (!policy.orgId && !canManagePartnerWidePolicies(auth)) throw new ConversionError('partner_wide_denied', 'Partner-wide access required');
  return policy;
}
```

Import `ConversionError` from `./convert` and `canManagePartnerWidePolicies` from `../../partnerWideAccess`. Add a `previewFreshness` function in this same module; it takes the already-authorized policy's sources, full device scope and these real executor reads. Fingerprint full row content (including dates), not only source timestamps:

```ts
export async function previewFreshness(policyId: string, executor: DbExecutor): Promise<string> {
  const sources = await loadPolicySources(policyId, executor);
  if (!sources) throw new ConversionError('policy_not_found', 'Policy not found');
  const ids = await resolveDeviceIdsForPolicy(policyId, executor);
  const deviceRows = ids.length ? await executor.select().from(devices).where(inArray(devices.id, ids)).orderBy(devices.id) : [];
  const orgIds = [...new Set(deviceRows.map((d) => d.orgId))];
  const orgs = orgIds.length ? await executor.select().from(organizations).where(inArray(organizations.id, orgIds)).orderBy(organizations.id) : [];
  const partnerIds = [...new Set([sources.policy.partnerId, ...orgs.map((o) => o.partnerId)].filter((v): v is string => !!v))];
  const axis = (table: { orgId: any; partnerId: any }) => or(inArray(table.orgId, orgIds), and(isNull(table.orgId), inArray(table.partnerId, partnerIds)));
  const routes = await executor.select().from(notificationRoutingRules).where(axis(notificationRoutingRules)).orderBy(notificationRoutingRules.id);
  const channels = await executor.select().from(notificationChannels).where(axis(notificationChannels)).orderBy(notificationChannels.id);
  const escalation = await executor.select().from(escalationPolicies).where(axis(escalationPolicies)).orderBy(escalationPolicies.id);
  const policies = await executor.select().from(configurationPolicies).where(axis(configurationPolicies)).orderBy(configurationPolicies.id);
  const policyIds = policies.map((p) => p.id);
  const assignments = policyIds.length ? await executor.select().from(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, policyIds)).orderBy(configPolicyAssignments.id) : [];
  const links = policyIds.length ? await executor.select().from(configPolicyFeatureLinks).where(inArray(configPolicyFeatureLinks.configPolicyId, policyIds)).orderBy(configPolicyFeatureLinks.id) : [];
  const definitions = await executor.select().from(monitorDefinitions).where(axis(monitorDefinitions)).orderBy(monitorDefinitions.id);
  const competitors = await Promise.all(policies.map((p) => loadPolicySources(p.id, executor)));
  return sha(canonical({ competitors: competitors.map((p) => p ? { ...p, openAlertsBySource: [...p.openAlertsBySource] } : null), sources: { ...sources, openAlertsBySource: [...sources.openAlertsBySource] }, ids,
    deviceRows, policies, assignments, links, definitions, routes, channels, escalation }));
}
```

The imports here are the existing schema exports plus `loadPolicySources`, `DbExecutor` and `resolveDeviceIdsForPolicy` from the private baseline. Only the digest is persisted; channel configuration/secrets never enter Redis or preview responses. Add normalized rules/watches/automation payloads of all competing effective policies to `sources` in this fingerprint using `loadPolicySources` for each policy, sorted by id, so changing a competitor also invalidates the baseline.

Job enqueue and worker code (the queue getter/lifecycle are finalized in Task 18):

```ts
// Inside previewPolicyConversion, after authorizePreview and fresh fingerprints:
const snapshot = snapshotPreviewAccess(auth);
const scopeHash = previewScopeHash(snapshot);
const sourcesHash = await previewFreshness(policyId, db);
const key = previewJobKey(policyId, scopeHash, sourcesHash);
await runOutsideDbContext(() => getMonitorConversionPreviewQueue().add('preview',
  { policyId, snapshot, scopeHash, sourcesHash },
  { jobId: sha(key), removeOnComplete: true, removeOnFail: true }));
// BullMQ custom ids contain no colon; Redis keys may. No DB read in the outside callback.

// Worker processor:
async function runPreviewJob(data: ConversionPreviewJobData) {
  return withDbAccessContext(data.snapshot.dbContext, async () => {
    const auth = restorePreviewAuth(data.snapshot);
    await authorizePreview(data.policyId, auth);
    if (previewScopeHash(data.snapshot) !== data.scopeHash || await previewFreshness(data.policyId, db) !== data.sourcesHash) {
      throw new ConversionError('preview_stale', 'Preview inputs changed');
    }
    const key = previewJobKey(data.policyId, data.scopeHash, data.sourcesHash);
    const result = await buildPolicyConversionPreview(data.policyId, { userId: auth.scope === 'system' ? null : auth.user.id, auth }, {
      onProgress: async (checked, total) => { await getRedis()!.setex(key, 3600, JSON.stringify({ status: 'running', progress: { checked, total }, scopeHash: data.scopeHash, sourcesHash: data.sourcesHash })); },
    });
    await getRedis()!.setex(key, 3600, JSON.stringify({ status: 'done', result, scopeHash: data.scopeHash, sourcesHash: data.sourcesHash }));
    return result;
  });
}
export function createMonitorConversionPreviewWorker() {
  return new Worker<ConversionPreviewJobData>(MONITOR_CONVERSION_PREVIEW_QUEUE, async (job) => {
    const { policyId, scopeHash, sourcesHash } = job.data;
    const key = previewJobKey(policyId, scopeHash, sourcesHash);
    await getRedis()!.setex(key, 3600, JSON.stringify({ status: 'running', progress: { checked: 0, total: 0 }, scopeHash, sourcesHash }));
    try { return await runPreviewJob(job.data); }
    catch (error) {
      await getRedis()!.setex(key, 3600, JSON.stringify({ status: 'failed', error: 'preview_failed', scopeHash, sourcesHash }));
      throw error;
    }
  }, { connection: getBullMQConnection(), concurrency: 2, lockDuration: 600_000 });
}
```

Add executable regressions in `previewScope.test.ts` (mock the DB context getter with `vi.hoisted`, returning a fixed complete `DbAccessContext`; use a complete `AuthContext` fixture as in the final task):

```ts
it('separates every principal and access ceiling, including empty ceilings', () => {
  const full = snapshotPreviewAccess(auth);
  const restricted = snapshotPreviewAccess({ ...auth, allowedSiteIds: [] });
  expect(previewScopeHash(full)).not.toBe(previewScopeHash(restricted));
  expect(previewScopeHash(full)).not.toBe(previewScopeHash(snapshotPreviewAccess({ ...auth, allowedDeviceIds: [] })));
  const restored = restorePreviewAuth(restricted);
  expect(restored.principal).toEqual(auth.principal);
  expect(restored.scope).toBe(auth.scope);
  expect(restored.canAccessSite!('any-site')).toBe(false);
});
```

In the worker test, use the real instrumented queue tripwire with strict mode and mock only transport; assert `getCurrentDbAccessContext()` is undefined inside `add`, and equals `data.snapshot.dbContext` inside the preview builder. The route regressions reject both empty and nonempty site/device ceilings before returning a cached result. The final live equivalence regression creates an inherited CPU rule with a CPU-kind routing row and asserts a delta; changing routing or an escalation step after preview must yield `preview_stale` on confirmation.

- [ ] **Step 4: Run, expect PASS** — `cd apps/api && npx vitest run src/services/monitors/conversion/ src/jobs/monitorConversionPreviewWorker.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** — `git add apps/api/src/services/monitors/conversion/equivalence.ts apps/api/src/services/monitors/conversion/equivalence.test.ts apps/api/src/jobs/monitorConversionPreviewWorker.ts apps/api/src/jobs/monitorConversionPreviewWorker.test.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/monitors/conversion/previewScope.ts apps/api/src/services/monitors/conversion/previewScope.test.ts && git commit -m "feat(monitors): conversion equivalence check over every device in scope, job-backed above 500"`

### Task 14: Rehome broad policy alert workflows without narrowing coverage

**Files:**
- Create: `apps/api/src/services/monitors/conversion/workflows.ts`, adjacent `workflows.test.ts`.
- Modify: `apps/api/src/jobs/automationWorker.ts:495-499,1140-1255` (`processTriggerEvent`, `queueEventTriggers`); test `apps/api/src/jobs/automationWorker.test.ts`.
- Consumes: Task 8's `resolveAutomationAssignmentForDevice` in `apps/api/src/services/featureConfigResolver.ts` (shared winning automation assignment); `apps/api/src/services/automationRuntime.ts:845-887` (owner authorization and durable resource bindings); `apps/api/src/db/schema/configurationPolicies.ts:218-235` (no rule filter).

**Interfaces:**
- Produces `rehomePolicyWorkflow(tx, source, policy, auth): Promise<string>` and `policyWorkflowApplies(automation, deviceId, tx): Promise<boolean>`.
- Stores `{ _policyWorkflow: { policyId, sourceId } }` in the existing standalone trigger's filter; normalizer already retains arbitrary filter records (`automationRuntime.ts:551`). This reserved field is server-owned assignment metadata and is removed before generic event-filter matching. The source is retired `converted` only after the new workflow and ledger exist. `source_state.workflowId` binds reversal and runtime assignment provenance; there are no monitor outputs. Existing export policy already excludes `automations.trigger` JSON; ledger `source_state` is `excludedOpen`.
- W05d keeps these workflows and this assignment resolver. Its retirement candidates exclude already-converted sources; it must never emit `unconvertible:alert_workflow_kept`.

- [ ] **Step 1: Write the failing tests**

```ts
// workflows.test.ts
import { expect, it, vi } from 'vitest';
import { rehomePolicyWorkflow, policyWorkflowApplies } from './workflows';
import { resolveAutomationAssignmentForDevice } from '../../featureConfigResolver';
vi.mock('../../featureConfigResolver', () => ({ resolveAutomationAssignmentForDevice: vi.fn() }));
vi.mock('../../automationRuntime', () => ({
  normalizeAutomationActions: (a: unknown) => a,
  resolveAutomationReferencesForOwner: vi.fn().mockResolvedValue({}),
  replaceAutomationResourceBindings: vi.fn().mockResolvedValue(undefined),
}));
it('preserves enabled, actions and failure behavior on a same-axis standalone workflow', async () => {
  const values = vi.fn();
  const tx: any = { insert: () => ({ values: (v: unknown) => { values(v); return { returning: async () => [{ id: 'workflow' }] }; } }) };
  const source = { id: 'source', name: 'All critical alerts', enabled: false, actions: [{ type: 'execute_command', command: 'echo triage' }], onFailure: 'continue' };
  await expect(rehomePolicyWorkflow(tx, source as never, { id: 'policy', orgId: 'org', partnerId: null }, { scope: 'system', canAccessOrg: () => true } as never)).resolves.toBe('workflow');
  expect(values).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, actions: source.actions, onFailure: 'continue', createdBy: null,
    trigger: { type: 'event', eventType: 'alert.triggered', filter: { _policyWorkflow: { policyId: 'policy', sourceId: 'source' } } } }));
});
it('uses the shared winner, including converted sources, for broad workflow coverage', async () => {
  const tx: any = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ policyId: 'policy' }] }) }) }) };
  const automation = { id: 'workflow', trigger: { filter: { _policyWorkflow: { policyId: 'policy', sourceId: 'child-source' } } } };
  vi.mocked(resolveAutomationAssignmentForDevice).mockResolvedValue({ configPolicyId: 'child', automations: [{ id: 'child-source', retiredAt: new Date() } as never] });
  expect(await policyWorkflowApplies(automation as never, 'device', tx)).toBe(true);
  expect(resolveAutomationAssignmentForDevice).toHaveBeenLastCalledWith('device', tx);
  vi.mocked(resolveAutomationAssignmentForDevice).mockResolvedValue({ configPolicyId: 'parent', automations: [{ id: 'parent-source' } as never] });
  expect(await policyWorkflowApplies(automation as never, 'device', tx)).toBe(false);
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/monitors/conversion/workflows.test.ts` → cannot resolve `./workflows`.

- [ ] **Step 3: Implement**

```ts
// workflows.ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../../../middleware/auth';
import { db } from '../../../db';
import type { DbExecutor } from './legacyBaseline';
import { automations, configPolicyAutomations, monitorConversions } from '../../../db/schema';
import { resolveAutomationAssignmentForDevice } from '../../featureConfigResolver';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { normalizeAutomationActions, resolveAutomationReferencesForOwner, replaceAutomationResourceBindings } from '../../automationRuntime';

export async function rehomePolicyWorkflow(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0], source: typeof configPolicyAutomations.$inferSelect,
  policy: { id: string; orgId: string | null; partnerId: string | null }, auth: AuthContext,
): Promise<string> {
  if (policy.orgId ? !auth.canAccessOrg(policy.orgId) : (!canManagePartnerWidePolicies(auth) || (auth.scope !== 'system' && auth.partnerId !== policy.partnerId))) {
    throw new Error('Workflow owner access denied');
  }
  const actions = normalizeAutomationActions(source.actions);
  const owner = { orgId: policy.orgId, partnerId: policy.partnerId };
  const references = await resolveAutomationReferencesForOwner(tx, owner, actions);
  const [created] = await tx.insert(automations).values({ ...owner, name: source.name,
    enabled: source.enabled, actions, onFailure: source.onFailure,
    createdBy: auth.scope === 'system' ? null : auth.user.id,
    trigger: { type: 'event', eventType: 'alert.triggered', filter: {
      _policyWorkflow: { policyId: policy.id, sourceId: source.id },
    } },
  }).returning();
  if (!created) throw new Error('Workflow creation failed');
  await replaceAutomationResourceBindings(tx, created.id, owner, references);
  return created.id;
}
export async function policyWorkflowApplies(automation: typeof automations.$inferSelect, deviceId: string, tx: DbExecutor): Promise<boolean> {
  const meta = (automation.trigger as { filter?: { _policyWorkflow?: { policyId: string; sourceId: string } } }).filter?._policyWorkflow;
  if (!meta) return true;
  const [ledger] = await tx.select().from(monitorConversions).where(and(
    eq(monitorConversions.sourceTable, 'config_policy_automations'), eq(monitorConversions.sourceId, meta.sourceId),
    isNull(monitorConversions.revertedAt), sql`${monitorConversions.sourceState}->>'workflowId' = ${automation.id}`)).limit(1);
  if (!ledger || ledger.policyId !== meta.policyId) return false;
  const winner = await resolveAutomationAssignmentForDevice(deviceId, tx);
  return winner?.automations.some((source) => source.id === meta.sourceId) ?? false;
}
```

In `queueEventTriggers` immediately after normalizing each standalone trigger, and again in `processTriggerEvent` before starting the automation, run the policy assignment check. Preserve the existing maintenance suppression and enqueue idempotency of policy jobs for rehomed workflows; apply the same maintenance check already at `automationWorker.ts:1234-1247` before either queueing or executing one. Strip only the reserved assignment metadata before generic filter matching:

```ts
const policyWorkflow = trigger.type === 'event' && trigger.filter?._policyWorkflow;
if (policyWorkflow) {
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : undefined;
  if (!deviceId || !await policyWorkflowApplies(automation, deviceId, db)) continue;
  const settings = await resolveMaintenanceConfigForDevice(deviceId);
  if (settings) {
    const window = isInMaintenanceWindow(settings);
    if (window.active && window.suppressAutomations) continue;
  }
  const { _policyWorkflow, ...filter } = trigger.filter!;
  trigger = { ...trigger, filter };
}
```

The execution-path equivalent returns its existing skipped result instead of `continue`, using `data.eventPayload` as `payload`; it repeats assignment and maintenance checks so an assignment removed after enqueue cannot execute. Both paths use Task 8's shared assignment election: the original normalized source remains in competition via its live workflow ledger, and only the public executable projection then hides it. A converted child therefore continues to shadow its unconverted parent for events and scheduled dispatch; the workflow path must not implement a second election. Do not replace its filter with the ids of the policy's monitors: it still receives alerts from unrelated rules on governed devices.

Add a real queued-event regression to `automationWorker.test.ts`: mock `policyWorkflowApplies` true, queue an `alert.triggered` with an unrelated `ruleId`, assert one standalone event job and no retired policy job; mock false for the same device after reassignment and assert no job. Disabled source produces disabled standalone workflow and is excluded by the existing `enabled` predicate. Unit tests also assert `rehomePolicyWorkflow` propagates reference-authorization failures without source retirement.

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/monitors/conversion/workflows.test.ts src/jobs/automationWorker.test.ts src/services/automationRuntime.configPolicy.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

`git add apps/api/src/services/monitors/conversion/workflows.ts apps/api/src/services/monitors/conversion/workflows.test.ts apps/api/src/jobs/automationWorker.ts apps/api/src/jobs/automationWorker.test.ts && git commit -m "feat(monitors): preserve broad policy workflows as assigned standalone jobs"`

### Task 15: `previewPolicyConversion` / `convertPolicy` / `convertPartnerLegacy` / `revertConversion` / `retireSource` — ledger, open-alert carry-over, cooldown re-key, standalone rules

**Files:**
- Create: `apps/api/src/services/monitors/conversion/convert.ts`
- Modify: `apps/api/src/services/monitors/conversion/index.ts` (re-export everything)
- Modify: `apps/api/src/services/alertCooldown.ts` (add `moveCooldownKeys`, `rekeyConfigPolicyCooldowns`, `rekeyCooldownsBackToConfigPolicy` next to `:290-365`)
- Modify: `apps/api/src/services/monitors/ruleConversionService.ts:49-70,75-160` (template-group adapter; use `mapStandaloneRule`, preserve existing response envelope).
- Create: `apps/api/src/services/monitors/conversion/history.ts`, `lifecycle.ts`; adjacent `history.test.ts`, `lifecycle.test.ts`.
- Consumes Task 6's complete ledger schema (`reused_monitor`, `moved_alert_refs`, `source_state`, source-rule/policy/attachment associations). No PR3 edit to a shipped PR2 migration.
- Test: `apps/api/src/services/monitors/conversion/convert.test.ts` (Drizzle-mock, the decision logic), `apps/api/src/services/alertCooldown.rekey.test.ts` (ioredis mock: SCAN → SET PX → DEL), `apps/api/src/services/monitors/ruleConversionService.test.ts` (existing; extend); the transactional proof is Task 18's round-trip

**Interfaces (the contract from the brief, verbatim names):**

```ts
export async function previewPolicyConversion(policyId: string, auth: AuthContext, opts?: { mode?: 'auto' | 'inline' }): Promise<PolicyConversionPreview | PolicyConversionPreviewPending>;
export async function buildPolicyConversionPreview(policyId: string, ctx: { userId: string | null; auth: AuthContext }, opts?: { onProgress?: (c: number, t: number) => Promise<void> | void }): Promise<PolicyConversionPreview>; // no threshold logic; used inline and by the job
export async function convertPolicy(policyId: string, previewHash: string, auth: AuthContext, opts?: { sourceIds?: string[] }): Promise<{ conversionIds: string[]; retired: number; monitorsCreated: number }>;
export async function convertPartnerLegacy(partnerId: string, previewHash: string, auth: AuthContext): Promise<{ policies: number; converted: number; unconvertible: number }>;
export async function revertConversion(conversionId: string, auth: AuthContext): Promise<void>;
export async function retireSource(sourceTable: ConversionSourceTable, sourceId: string, reason: string, auth: AuthContext): Promise<{ conversionId: string }>;
export async function previewPartnerConversion(partnerId: string, auth: AuthContext): Promise<PartnerConversionPreview>;
export class ConversionError extends Error { constructor(readonly code: 'policy_not_found' | 'partner_wide_denied' | 'prerequisite_missing' | 'blocked' | 'preview_stale' | 'equivalence_delta' | 'source_not_found' | 'already_converted' | 'invalid_reason' | 'conversion_not_found' | 'conversion_revert_unavailable', message: string, readonly details?: unknown) }
```

Behaviour (all validation is also enforced in the service; route guards are not the only boundary):

- **`buildPolicyConversionPreview`** authorizes full policy scope with `authorizePreview`, then loads source rows and prerequisite capabilities. Preserve the existing blocked-prerequisite/parent response shapes. Map rules/watches including enabled state, create `responseTargetSourceId` + canonical `responseActions` for rule-bound automations, and `workflow` metadata for broad policy automations. Run `mergeResponseProposals` BEFORE equivalence/hash; overflow refuses both automation and target source. Disabled response automations remain disabled standalone sources rather than becoming active monitor responses. Check escalation owner compatibility before accepting proposals. Hash the complete proposals, ordered actions/workflows, scope hash and `previewFreshness` digest. No actions are appended for the first time during conversion.
- **`previewPolicyConversion`** authorizes before every cache lookup; ≤500 devices run inline, larger scopes use Task 13's snapshot/key/worker. A completed entry is reusable only with matching caller scope AND full freshness digest. A failed/stale entry is recomputed. Queue.add runs inside `runOutsideDbContext` with only the previously authorized snapshot. Polling remains GET on the same URL, HTTP 202 while running (W05c2 implements polling/cancellation/blocked-empty in PR1).
- **`convertPolicy`** freshly authorizes and rebuilds the full preview; selected `sourceIds` must include a response's target and all of its dependent response items. A mismatched hash is `preview_stale`; a blocked preview or any equivalence delta refuses before writing. Lock the policy, sources and relevant definitions in a transaction and recompute freshness after acquiring locks; serialize policy/partner conversion operations with `pg_advisory_xact_lock` and use SERIALIZABLE isolation for the read→write proof. Apply the EXACT proposed behavior using `createMonitorDefinition(input, auth, {}, tx)`. Reuse requires exact nullable `(orgId, partnerId)` equality plus full `monitorSignature` equality, including enabled state and ordered responses. Visibility alone never permits reuse. Existing attachments/settings remain intact; record only attachment ids actually inserted by this conversion. Ledger outputs always copy both owner axes from their parent. Store original source/link state in `source_state`, including prior retirement/enabled/inheritance fields. Rehome broad workflows through `rehomePolicyWorkflow`; store `workflowId` in the source's ledger state, then retire the source `converted`. Return actual counts; a source race yields `already_converted` without another ledger row.
- **`previewPartnerConversion`** requires full partner membership (`canManagePartnerWidePolicies`) and unrestricted governance scope. Load every active partner policy and org policy under the partner plus every unmanaged template group, including disabled rules. Resolve inherited consumers before filtering devices. Build all policy and group previews in stable source order, parents before children; use a rolled-back transaction to stage parent conversions when previewing dependent children. The hash covers the complete initial plan, all refusals, scopes, source/target assignments and delivery freshness. Return D3's `PartnerConversionPreview`. Reusing an org count is forbidden. No source is retired by preview.
- **`convertPartnerLegacy(partnerId, previewHash, auth)`** repeats partner authorization, rebuilds that complete partner plan and checks the supplied aggregate hash before any write. Apply the same staged plan atomically under a per-partner transaction lock. Each staged child is checked against its parent conversion in the same transaction. Preserve evaluable unconvertible sources during W05c; only explicit retirement or W05d's later sweep retires them. W05d calls `previewPartnerConversion` then `convertPartnerLegacy(partnerId, preview.previewHash, auth)` under system scope. Global built-in and compliance-bridge templates are excluded. There is ONE ledger row per template group, never one per rule; a group with any unconvertible member is refused as a whole.
- **`revertConversion`** checks owner authorization and `isRevertAvailable(sourceTable)` BEFORE mutation; unavailable returns `conversion_revert_unavailable`. Lock the ledger, sources, outputs and definitions; missing sources yield `source_not_found` and leave ledger/outputs unchanged. Restore source state and every persisted moved-alert reference/context BEFORE any compiled row deletion. New post-conversion alerts are never resolved or dropped; retain history on a still-referenced definition or rehome it using output source provenance before deleting the compiled rule. Detach ONLY this conversion's inserted attachments. Keep a definition when another live conversion, attachment, alert history or unmanaged deployment still references it. Disable a rehomed workflow before restoring its legacy source. Restore previous inheritance only when no later conversion or user edit requires the current value; otherwise keep it and refuse behavior-changing reversal. Set `reverted_at` last. Re-key cooldowns after commit only for restored sources.
- **`retireSource`** accepts exactly `operator` or `unconvertible:<code>`; uses the same source lock, authorization and ledger helper as conversion, recording complete pre-retirement state with zero outputs. Return `{ conversionId }`. A zero-row compare-and-set returns `already_converted`; W05d treats that race as already completed without duplicate reports. W05e network retirement uses this SAME function/ledger and original enabled/retirement state, not a separate no-ledger path. Conversion and retirement never mass-resolve open alerts.

Cooldown re-key (`alertCooldown.ts`):

```ts
async function moveCooldownKeys(redis: Redis, fromPattern: string, toKey: (deviceId: string) => string): Promise<number> {
  let cursor = '0'; let moved = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', fromPattern, 'COUNT', 200);
    cursor = next;
    for (const key of keys) {
      const deviceId = key.slice(key.lastIndexOf(':') + 1);
      const ttl = await redis.pttl(key);
      if (ttl > 0) await redis.set(toKey(deviceId), Date.now().toString(), 'PX', ttl);
      await redis.del(key);
      moved++;
    }
  } while (cursor !== '0');
  return moved;
}
/** `cpar:<source>:<device>` → `<compiledRule>:<device>` (W05c1 §Open alerts). */
export async function rekeyConfigPolicyCooldowns(sourceRuleId: string, compiledRuleId: string): Promise<number> {
  const redis = getRedis(); if (!redis) return 0;
  return moveCooldownKeys(redis, `${CONFIG_POLICY_COOLDOWN_PREFIX}:${sourceRuleId}:*`, (d) => buildCooldownKey(compiledRuleId, d));
}
export async function rekeyCooldownsBackToConfigPolicy(compiledRuleId: string, sourceRuleId: string): Promise<number> {
  const redis = getRedis(); if (!redis) return 0;
  return moveCooldownKeys(redis, `${COOLDOWN_PREFIX}:${compiledRuleId}:*`, (d) => buildConfigPolicyCooldownKey(sourceRuleId, d));
}
```

(The adaptive-multiplier keys `${COOLDOWN_PREFIX}:adaptive:<rule>:<device>` are NOT moved — they are a noise heuristic, and the `:475-478` cleanup already treats `:cpar:` and `:adaptive:` keys as separate families. `fromPattern` for the compiled rule is safe because a compiled rule id never collides with the `adaptive`/`cpar` segments.)

The final policy hash binds both authorization and live configuration, not just the mappers' proposal hash:

```ts
const scopeHash = previewScopeHash(snapshotPreviewAccess(auth));
const freshness = await previewFreshness(policyId, executor);
const previewHashValue = sha(canonical({
  proposal: previewHash({ policyId, items: mergeResponseProposals(items), inheritanceMode }),
  scopeHash, freshness,
}));
```

Use this value in `PolicyConversionPreview.previewHash`, cache results and the ledger. The partner hash similarly includes `partnerId`, caller scope, and every policy/group input hash and refusal in stable source order. Template-group input hashing includes ALL `alert_rules` fields and target assignments, not just the template timestamp (rules have no `updated_at` column). Recompute before confirmation under the same lock/snapshot and reject if either the affected set or any input changed.

```ts
export function partnerPreviewHash(partnerId: string, scopeHash: string,
  parts: Array<{ sourceTable: ConversionSourceTable; sourceId: string; inputHash: string; reason: string | null }>): string {
  return sha(canonical({ partnerId, scopeHash,
    parts: [...parts].sort((a, b) => a.sourceTable.localeCompare(b.sourceTable) || a.sourceId.localeCompare(b.sourceId)) }));
}
```

Append to `convert.test.ts`:

```ts
it('partner confirmation changes when another org adds a source or changes a refusal', () => {
  const first = [{ sourceTable: 'alert_templates' as const, sourceId: 'template-a', inputHash: 'h1', reason: null }];
  expect(partnerPreviewHash('partner', 'scope', first)).not.toBe(partnerPreviewHash('partner', 'scope', [
    ...first, { sourceTable: 'alert_templates', sourceId: 'other-org-template', inputHash: 'h2', reason: 'unconvertible:no_condition' },
  ]));
  expect(partnerPreviewHash('partner', 'scope', first)).not.toBe(partnerPreviewHash('partner', 'narrower-scope', first));
});
```

Record rule-bound response automations as `role: 'response'` outputs referencing the target monitor, with null `attachment_id`, `reused_monitor: true`, and `source_state` containing the added ordered actions and `targetConversionId: <target ledger id>` (the exact key consumed by `findLiveTargetDependencies`). Reverting a target conversion restores its response sources in the same transaction; a response-only revert while its target remains converted returns `409 blocked`, preventing an original legacy rule filter from becoming inert. Once the target is restored, remove only that contribution and preserve responses still required by another live conversion. This dependency is included in the ledger's revertability calculation and the final round-trip regression.

Reuse candidate selection belongs in `applyProposalInTx`; do not filter after choosing a signature match:

```ts
const reusable = visibleDefinitions.find((candidate) =>
  candidate.orgId === proposal.policy.orgId && candidate.partnerId === proposal.policy.partnerId
  && monitorSignature(candidate as ProposedMonitor) === monitorSignature(proposed));
```

`history.test.ts` is an executable statement-order regression using its exported history helpers; it does not invent a test harness:

```ts
import { expect, it, vi } from 'vitest';
import { restoreMovedAlertRefs, canDeleteConversionMonitor } from './history';
it('restores exact standalone references and context before deletion is considered', async () => {
  const set = vi.fn(() => ({ where: async () => [] }));
  const tx = { update: () => ({ set }) };
  const original = { id: 'alert', ruleId: 'legacy-rule', configPolicyId: null, monitorId: null,
    context: { retained: true, convertedFrom: { original: true } } };
  await restoreMovedAlertRefs(tx as never, [original]);
  const { id, ...refs } = original;
  expect(set).toHaveBeenCalledWith(refs);
});
it('retains a monitor referenced by another live conversion', async () => {
  const results = [[{ id: 'another-output' }], [], []];
  const query = () => {
    const rows = results.shift()!;
    const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const method of ['from', 'innerJoin', 'where', 'limit']) c[method] = () => c;
    return c;
  };
  expect(await canDeleteConversionMonitor({ select: query } as never, 'monitor', 'first-conversion')).toBe(false);
});
```

The live final suite additionally inserts a post-conversion resolved alert and proves it survives revert with its original status, restored source linkage and retained context. Add a mocked lifecycle-false service test to `convert.test.ts`: `isRevertAvailable.mockReturnValue(false)`, expect `conversion_revert_unavailable`, and assert update/delete/insert were never called.

Template-group write core: export the verified `assignmentForRule` helper (`ruleConversionService.ts:49-70`) and use `mapStandaloneRule` instead of its old `convertAlertConditionToMonitor` call. Add `convertTemplateGroup(templateId, expectedHash, auth, executor)` in `convert.ts`; its input is the group from the partner preview (all rules sorted by id, all targets, every mapping/refusal). `convertRuleToMonitor(ruleId: string, auth: AuthContext, executor: DbExecutor = db)` first previews the WHOLE group, then invokes this writer and projects the selected rule's primary output to the existing `ConversionSuccess` shape. Extend that response additively with `conversionId` and `convertedRuleIds` so the caller sees the group scope. Authorization must cover the template and every member; any mixed owner axis is refused before writes.

```ts
// Inside convertTemplateGroup's already-authorized SERIALIZABLE transaction:
const [template] = await tx.select().from(alertTemplates).where(eq(alertTemplates.id, templateId)).limit(1).for('update');
if (!template || template.managedByMonitorId || template.retiredAt) throw new ConversionError('source_not_found', 'Template unavailable');
const rules = await tx.select().from(alertRules).where(and(eq(alertRules.templateId, templateId), isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt)))
  .orderBy(alertRules.id).for('update');
const plans = rules.map((rule) => ({ rule, target: assignmentForRule(rule), mapped: mapStandaloneRule(rule, template) }));
if (plans.some((p) => !p.target || !p.mapped.ok || p.rule.orgId !== template.orgId || p.rule.partnerId !== template.partnerId)) {
  throw new ConversionError('blocked', 'Template group cannot be converted atomically');
}
const [ledger] = await tx.insert(monitorConversions).values({
  orgId: template.orgId, partnerId: template.partnerId, sourceTable: 'alert_templates', sourceId: template.id,
  policyId: null, convertedBy: auth.scope === 'system' ? null : auth.user.id, previewHash: expectedHash,
  sourceState: { template, rules },
}).returning();
if (!ledger) throw new Error('Ledger insert failed');
for (const plan of plans) {
  if (!plan.mapped.ok || !plan.target) throw new Error('Invalid group plan');
  const owner = plan.rule.orgId ? { orgId: plan.rule.orgId } : { partnerId: plan.rule.partnerId! };
  const actor = auth.scope === 'system' ? null : auth.user.id;
  const policy = await createConfigPolicy(owner, { name: `Converted: ${plan.rule.name}` }, actor, tx);
  await assignPolicy(policy.id, plan.target.level, plan.target.targetId, 0, actor, undefined, undefined, tx);
  for (const proposed of plan.mapped.proposed) {
    const monitor = await createMonitorDefinition({ ...proposed, ownerScope: plan.rule.orgId ? 'organization' : 'partner',
      orgId: plan.rule.orgId ?? undefined, responses: proposed.responses, recurrenceActions: [], pauseResponsesOnEscalation: true,
    } as Parameters<typeof createMonitorDefinition>[0], { ...auth, partnerId: plan.rule.partnerId ?? auth.partnerId }, {}, tx);
    const link = await addFeatureLink(policy.id, 'monitors', null, { inheritance: 'cumulative',
      items: [{ monitorId: monitor.id, enabled: proposed.enabled }] }, undefined, tx);
    if (!link) throw new Error('Attachment failed');
    const [attachment] = await tx.select().from(configPolicyMonitors).where(and(eq(configPolicyMonitors.featureLinkId, link.id), eq(configPolicyMonitors.monitorId, monitor.id))).limit(1);
    const movedAlertRefs = await carryOpenAlerts(tx, { sourceTable: 'alert_templates', sourceId: template.id,
      ruleId: plan.rule.id, compiledRuleId: monitor.compiledAlertRuleId!, monitorId: monitor.id });
    await tx.insert(monitorConversionOutputs).values({ conversionId: ledger.id, orgId: ledger.orgId, partnerId: ledger.partnerId,
      monitorId: monitor.id, role: proposed.role, sourceRuleId: plan.rule.id, policyId: policy.id,
      attachmentId: attachment!.id, reusedMonitor: false, movedAlertIds: movedAlertRefs.map((a) => a.id), movedAlertRefs });
    if (proposed.role === 'primary') await tx.update(alertRules).set({ retiredAt: new Date(), retiredReason: 'converted',
      convertedToMonitorId: monitor.id }).where(eq(alertRules.id, plan.rule.id));
  }
}
await tx.update(alertTemplates).set({ retiredAt: new Date(), retiredReason: 'converted' }).where(eq(alertTemplates.id, template.id));
```

Do not set `isActive: false` or alter `overrideSettings` as a side effect: retirement predicates stop evaluation and original enabled/override state remains available for reversal. Apply group equivalence and the expected preview hash BEFORE entering this core; use the same core in the rolled-back group preview. It creates a policy per original target, but one template ledger and per-output policy/rule associations.

`history.ts` — shared with W05e. `OPEN_ALERT_STATUSES` from Task 11 is the only open-status definition. Capture original references under row locks, before moving any alert:

```ts
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alerts, monitorConversions, monitorConversionOutputs, configPolicyMonitors } from '../../../db/schema';
import { OPEN_ALERT_STATUSES } from './loadSources';
import type { DbExecutor } from './legacyBaseline';
import type { ConversionSourceTable } from './types';
export async function carryOpenAlerts(tx: DbExecutor, source: {
  sourceTable: ConversionSourceTable; sourceId: string; ruleId?: string;
  compiledRuleId: string; monitorId: string;
}) {
  const match = source.ruleId ? eq(alerts.ruleId, source.ruleId)
    : source.sourceTable === 'network_monitors'
      ? sql`${alerts.context}->>'source' = 'network_monitor' AND ${alerts.context}->>'monitorId' = ${source.sourceId}`
      : eq(alerts.configPolicyId, source.sourceId);
  const original = await tx.select({ id: alerts.id, ruleId: alerts.ruleId, configPolicyId: alerts.configPolicyId,
    monitorId: alerts.monitorId, context: alerts.context }).from(alerts)
    .where(and(match, inArray(alerts.status, [...OPEN_ALERT_STATUSES]))).for('update');
  for (const row of original) await tx.update(alerts).set({ ruleId: source.compiledRuleId, configPolicyId: null,
    monitorId: source.monitorId, context: { ...(row.context as Record<string, unknown> ?? {}), convertedFrom: {
      sourceTable: source.sourceTable, sourceId: source.sourceId, ruleId: source.ruleId ?? null,
    } } }).where(eq(alerts.id, row.id));
  return original as Array<{ id: string; ruleId: string | null; configPolicyId: string | null; monitorId: string | null; context: Record<string, unknown> | null }>;
}
export async function restoreMovedAlertRefs(tx: DbExecutor, refs: Awaited<ReturnType<typeof carryOpenAlerts>>) {
  for (const { id, ...original } of refs) await tx.update(alerts).set(original).where(eq(alerts.id, id));
}
export async function canDeleteConversionMonitor(tx: DbExecutor, monitorId: string, conversionId: string) {
  const live = await tx.select({ id: monitorConversionOutputs.id }).from(monitorConversionOutputs)
    .innerJoin(monitorConversions, eq(monitorConversions.id, monitorConversionOutputs.conversionId))
    .where(and(eq(monitorConversionOutputs.monitorId, monitorId), ne(monitorConversions.id, conversionId), isNull(monitorConversions.revertedAt))).limit(1);
  const attachments = await tx.select({ id: configPolicyMonitors.id }).from(configPolicyMonitors)
    .where(eq(configPolicyMonitors.monitorId, monitorId)).limit(1);
  const history = await tx.select({ id: alerts.id }).from(alerts).where(eq(alerts.monitorId, monitorId)).limit(1);
  return live.length === 0 && attachments.length === 0 && history.length === 0;
}
```

Revert core, after lifecycle/owner checks and source restoration, BEFORE calling `deleteMonitorDefinition`:

```ts
for (const output of outputs) await restoreMovedAlertRefs(tx, output.movedAlertRefs);
for (const output of outputs) {
  // Never wholesale-save the link: that would recreate every attachment id.
  if (output.attachmentId) await tx.delete(configPolicyMonitors).where(eq(configPolicyMonitors.id, output.attachmentId));
  if (!output.monitorId) continue;
  const otherLive = await tx.select({ id: monitorConversionOutputs.id }).from(monitorConversionOutputs)
    .innerJoin(monitorConversions, eq(monitorConversions.id, monitorConversionOutputs.conversionId))
    .where(and(eq(monitorConversionOutputs.monitorId, output.monitorId), ne(monitorConversions.id, ledger.id), isNull(monitorConversions.revertedAt))).limit(1);
  const otherAttachments = await tx.select({ id: configPolicyMonitors.id }).from(configPolicyMonitors).where(eq(configPolicyMonitors.monitorId, output.monitorId)).limit(1);
  if (otherLive.length || otherAttachments.length) continue;
  // Post-conversion history belongs back to this source only when no other deployment owns it.
  // Terminal status, timestamps and resolution fields remain untouched.
  if (output.sourceRuleId || ledger.sourceTable === 'config_policy_alert_rules') {
    await tx.update(alerts).set({ ruleId: output.sourceRuleId ?? null,
      configPolicyId: output.sourceRuleId ? null : ledger.sourceId, monitorId: null,
      context: sql`COALESCE(${alerts.context}, '{}'::jsonb) || jsonb_build_object('revertedConversionId', ${ledger.id}::text)`,
    }).where(eq(alerts.monitorId, output.monitorId));
  }
  // Watch/network/other history may lack a legacy rule target. Keep that definition
  // and compiled rows as an unattached history owner instead of orphaning history.
  if (!output.reusedMonitor && await canDeleteConversionMonitor(tx, output.monitorId, ledger.id)) {
    await deleteMonitorDefinition(output.monitorId, auth, tx);
  }
}
await tx.update(monitorConversions).set({ revertedAt: new Date() }).where(eq(monitorConversions.id, ledger.id));
```

Thread optional `executor: DbExecutor = db` through `getMonitorDefinition`, `deleteMonitorDefinition` and its internal reads/transaction (`monitorService.ts:226-237,382-390`); do not execute deletion through a bare/global executor. Synchronize link JSON from remaining normalized attachments while preserving `inheritance`; use `tx.update(configPolicyFeatureLinks)` rather than `updateFeatureLink` (which recreates attachment ids). Retirement reversal restores `source_state`'s original enabled/retirement values, including W05e network checks; a conversion with no outputs still reverts correctly.

`lifecycle.ts` and test:

```ts
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { monitorConversions } from '../../../db/schema';
import type { DbExecutor } from '../monitorCompiler';
import type { ConversionSourceTable } from './types';
export function isRevertAvailable(_sourceTable: ConversionSourceTable): boolean { return true; }
/** Response entries cannot revert while their target conversion is still live. */
export async function findLiveTargetDependencies(
  rows: Array<{ id: string; sourceState: Record<string, unknown> }>, executor: DbExecutor = db,
): Promise<Set<string>> {
  const targetIds = [...new Set(rows.map((r) => r.sourceState.targetConversionId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!targetIds.length) return new Set();
  // Resolve outside the page/policy filter: a target can be on another ledger page.
  // Text comparison avoids treating malformed historical JSON as a UUID cast error.
  const live = await executor.select({ id: monitorConversions.id }).from(monitorConversions)
    .where(and(inArray(sql<string>`${monitorConversions.id}::text`, targetIds), isNull(monitorConversions.revertedAt)));
  const liveIds = new Set(live.map((r) => r.id));
  return new Set(rows.filter((r) => typeof r.sourceState.targetConversionId === 'string'
    && liveIds.has(r.sourceState.targetConversionId)).map((r) => r.id));
}
// lifecycle.test.ts
import { expect, it } from 'vitest';
import { isRevertAvailable } from './lifecycle';
it('allows legacy reversal while W05c runtimes still exist', () => {
  expect(isRevertAvailable('config_policy_alert_rules')).toBe(true);
  expect(isRevertAvailable('alert_templates')).toBe(true);
});
```

At the start of `revertConversion`, after the authorized, locked ledger read, import both lifecycle helpers and check before any mutation:

```ts
if (!isRevertAvailable(ledger.sourceTable)) {
  throw new ConversionError('conversion_revert_unavailable', 'This source runtime has been retired');
}
if ((await findLiveTargetDependencies([ledger], tx)).has(ledger.id)) {
  throw new ConversionError('blocked', 'Revert the target conversion before this response');
}
```

W05d changes that one function to false for the five removed legacy runtime tables; network checks retain their separately supported reversal. The ledger read computes `revertable` using this same lifecycle function AND `findLiveTargetDependencies`; its dependency check uses the same persisted `targetConversionId` as the mutation guard. W05c2 disables Undo once false and documents that legacy Undo ends when W05d is installed.

- [ ] **Step 1: Write the failing tests** — `convert.test.ts` (mocked `loadPolicySources`, `computeEquivalence`, `resolveDeviceIdsForPolicy`, `getConfigPolicy`, `listMonitorDefinitions`, `createMonitorDefinition`, `db`): (a) prerequisites missing → `blockedBy: 'prerequisite_missing'` with labels; (b) partner-wide policy + org token → `ConversionError('partner_wide_denied')`; (c) `parentUnconverted` → `blockedBy: 'parent_unconverted'` and `computeEquivalence` NOT called; (d) three inline rules (one processCount) + one watch with thresholds → 4 items, outcomes `['convertible','convertible','unconvertible','convertible']`, the watch item has 3 proposed, `inheritanceMode === 'replace'`, `openAlerts` copied from the map; (e) `convertPolicy` with a wrong hash → `preview_stale`; with deltas → `equivalence_delta`; (f) reuse: an exact-owner monitor with an equal signature is attached; an otherwise equal visible partner monitor is NOT reused by an org policy, `createMonitorDefinition` not called, output `reused_monitor: true`; (g) `retireSource` rejects `'bogus'` with `invalid_reason` and accepts `'operator'`. `alertCooldown.rekey.test.ts`: two `cpar` keys with TTLs 1000/0 → one `set … PX 1000`, two `del`, returns 2. `ruleConversionService.test.ts`: two rules sharing one template produce one ledger, both rule outputs and both target assignments; a flat group uses `mapStandaloneRule`; one unconvertible member rolls the entire group back.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/monitors/conversion/convert.test.ts src/services/alertCooldown.rekey.test.ts src/services/monitors/ruleConversionService.test.ts` → module-not-found / "expected update payload to contain retiredReason".

- [ ] **Step 3: Implement** — `convert.ts` per the Behaviour list (every write inside `db.transaction`; every partner-axis write path passes `canManagePartnerWidePolicies` first — the file must contain that identifier for `partner-wide-write-coverage.test.ts`); `alertCooldown.ts` additions above; `ruleConversionService.ts` change above; `index.ts`:

```ts
export * from './types';
export * from './prerequisites';
export * from './mapping';
export { loadPolicySources, countPendingConversions, OPEN_ALERT_STATUSES } from './loadSources';
export { computeEquivalence, diffSignatureSets, applyProposalInTx } from './equivalence';
export { resolveDeviceIdsForPolicy } from './legacyBaseline';
export { isRevertAvailable } from './lifecycle';
export { carryOpenAlerts, restoreMovedAlertRefs } from './history';
export { previewPolicyConversion, buildPolicyConversionPreview, previewPartnerConversion, convertPolicy, convertPartnerLegacy, revertConversion, retireSource, ConversionError } from './convert';
```

- [ ] **Step 4: Run, expect PASS** — `cd apps/api && npx vitest run src/services/monitors/conversion/ src/services/alertCooldown src/services/monitors/ruleConversionService.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** — `git add apps/api/src/services/monitors/conversion/ apps/api/src/services/alertCooldown.ts apps/api/src/services/alertCooldown.rekey.test.ts apps/api/src/services/monitors/ruleConversionService.ts apps/api/src/services/monitors/ruleConversionService.test.ts apps/api/src/services/policyAlertBridge.ts apps/api/src/services/monitors/monitorService.ts && git commit -m "feat(monitors): policy conversion — preview, convert, partner sweep, revert, retire; ledger, open-alert carry-over, cooldown re-key"`

### Task 16: Conversion HTTP routes — policy preview/convert, revert, retire, partner preview/convert-all, persistent ledger and pending counts

**Files:**
- Modify: `apps/api/src/routes/monitorDefinitions.ts:68-74,174` (authenticated parent; mount the conversion resource before `/:id`).
- Create: `apps/api/src/routes/monitorDefinitions.conversion.ts` (the conversion resource and its validation/error boundary).
- Create: `apps/api/src/services/monitors/conversion/ledger.ts`, adjacent `ledger.test.ts`; modify `conversion/index.ts` (created Task 9).
- Test: `apps/api/src/routes/monitorDefinitions.test.ts:218-249` (extend mount regression), `apps/api/src/routes/monitorDefinitions.conversion.test.ts` (create); `apps/api/src/routes/monitorDefinitions.authGate.test.ts` (existing authentication regression).
- Consumed implementations verified: `apps/api/src/services/partnerWideAccess.ts:26-31`, `apps/api/src/services/siteCeilingAccess.ts:67-72`, `apps/api/src/middleware/auth.ts:75-176`, `apps/api/src/lib/validation.ts:105-142`. Conversion services are created by Tasks 9–15, rather than existing source files.

**Interfaces:**
- Consumes: Task 15's `findLiveTargetDependencies(rows, executor)` and `isRevertAvailable(sourceTable)` for the ledger's dependency/lifecycle projection.
- Consumes: `previewPolicyConversion(policyId, auth)`, `convertPolicy(policyId, previewHash, auth, opts?)`, `revertConversion(conversionId, auth)`, `retireSource(sourceTable, sourceId, reason, auth)`, `previewPartnerConversion(partnerId, auth)`, `convertPartnerLegacy(partnerId, previewHash, auth)`, `countPendingConversions(scope)`, `ConversionError`, `ConversionPrerequisiteMissingError`, `MONITOR_CONVERSION_SOURCE_TABLES`.
- Produces the exact W05c2 HTTP resource, mounted at `/monitor-definitions/conversion`:

| Method / suffix | Input | Success |
|---|---|---|
| GET `/policies/:policyId/preview` | UUID path | `200 { data: PolicyConversionPreview }`; `202 { data: PolicyConversionPreviewPending }` while running |
| POST `/policies/:policyId/convert` | `{ previewHash: string, sourceIds?: string[] }` | `200 { data: ConvertPolicyResult }` |
| POST `/:conversionId/revert` | UUID path, no body | `200 { success: true }` |
| POST `/retire` | `{ sourceTable: ConversionSourceTable, sourceId: string, reason: string }` | `200 { success: true, conversionId: string }` |
| POST `/partner/preview` | no body; partner identity comes from `auth.partnerId` | `200 { data: PartnerConversionPreview }` |
| POST `/partner/convert-all` | `{ previewHash: string }`; partner identity comes from `auth.partnerId` | `200 { data: ConvertPartnerResult }` |
| GET `/ledger?orgId&policyId&cursor&limit` | authorized filters, opaque cursor, limit 1..100 (default 25) | `200 { items: ConversionLedgerEntry[]; nextCursor: string | null }` |
| GET `/pending?orgId` | optional UUID; default `auth.orgId` | `200 { data: { policies: number, rows: number } }` |

The domain payload of pending is the brief's `{ policies, rows }`; the transport envelope follows W05c2's `ApiResponse<T>` convention. `standaloneRules` remains an internal additive service field. Preview progress is polled at the **same** GET URL; no job-id API or new UI query state. Partner confirmation uses the hash returned by the new partner-wide preview, never current-org pending counts. Ledger is a persistent read with an intentionally unwrapped D2 pagination response. Each policy still gets Task 15's equivalence/staleness checks. A system HTTP caller must carry a selected partner; the background W05d sweep calls the service directly with its explicit partner id.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/monitorDefinitions.conversion.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

const m = vi.hoisted(() => ({
  authenticated: true, permission: true, mfa: true,
  preview: vi.fn(), convert: vi.fn(), revert: vi.fn(), retire: vi.fn(),
  partner: vi.fn(), partnerPreview: vi.fn(), ledger: vi.fn(), counts: vi.fn(), audit: vi.fn(),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => m.authenticated ? next() : c.json({ error: 'Unauthorized' }, 401),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (c: any, next: any) => m.permission ? next() : c.json({ error: 'Permission denied' }, 403),
  requireMfa: () => async (c: any, next: any) => m.mfa ? next() : c.json({ error: 'MFA required' }, 403),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: m.audit }));
vi.mock('../services/monitors/conversion', () => ({
  previewPolicyConversion: m.preview, convertPolicy: m.convert,
  revertConversion: m.revert, retireSource: m.retire,
  convertPartnerLegacy: m.partner, previewPartnerConversion: m.partnerPreview, listConversionLedger: m.ledger, countPendingConversions: m.counts,
  ConversionError: class extends Error {
    constructor(public code: string, message: string, public details?: unknown) { super(message); }
  },
  ConversionPrerequisiteMissingError: class extends Error {
    constructor(public missing: string[]) { super('conversion prerequisites missing'); }
  },
}));
import { monitorConversionRoutes } from './monitorDefinitions.conversion';
import { ConversionError, ConversionPrerequisiteMissingError } from '../services/monitors/conversion';

const ORG = '10000000-0000-4000-8000-000000000001';
const PARTNER = '10000000-0000-4000-8000-000000000002';
const POLICY = '10000000-0000-4000-8000-000000000003';
const SOURCE = '10000000-0000-4000-8000-000000000004';
const OTHER = '10000000-0000-4000-8000-000000000005';
const HASH = 'a'.repeat(64);
function app(overrides: Partial<AuthContext> = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: PARTNER,
      user: { id: SOURCE }, canAccessOrg: (id: string) => id === ORG,
      ...overrides,
    } as AuthContext);
    await next();
  });
  a.route('/monitor-definitions/conversion', monitorConversionRoutes);
  return a;
}
function request(path: string, method = 'GET', body?: unknown, auth: Partial<AuthContext> = {}) {
  return app(auth).request(`/monitor-definitions/conversion${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const mutations: Array<[string, unknown]> = [
  [`/policies/${POLICY}/convert`, { previewHash: HASH, sourceIds: [SOURCE] }],
  [`/${SOURCE}/revert`, undefined],
  ['/retire', { sourceTable: 'config_policy_alert_rules', sourceId: SOURCE, reason: 'operator' }],
  ['/partner/convert-all', { previewHash: HASH }],
];
beforeEach(() => {
  vi.resetAllMocks();
  m.authenticated = m.permission = m.mfa = true;
  m.preview.mockResolvedValue({ policyId: POLICY, previewHash: HASH, items: [], inheritanceMode: 'replace', equivalence: { devicesChecked: 0, deltas: [] } });
  m.convert.mockResolvedValue({ conversionIds: [SOURCE], retired: 1, monitorsCreated: 1 });
  m.counts.mockResolvedValue({ policies: 0, rows: 0, standaloneRules: 9 });
  m.retire.mockResolvedValue({ conversionId: SOURCE });
  m.ledger.mockResolvedValue({ items: [], nextCursor: null });
  m.partnerPreview.mockResolvedValue({ partnerId: PARTNER, previewHash: HASH, policies: 2, rows: 3, convertible: 3, unconvertible: [] });
  m.partner.mockResolvedValue({ policies: 2, converted: 3, unconvertible: 1 });
});
describe('conversion resource', () => {
  it('returns a finished preview and passes the authenticated identity', async () => {
    const r = await request(`/policies/${POLICY}/preview`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { policyId: POLICY, previewHash: HASH } });
    expect(m.preview).toHaveBeenCalledWith(POLICY, expect.objectContaining({ orgId: ORG }));
  });
  it('polls the same preview resource with 202 and progress', async () => {
    m.preview.mockResolvedValue({ status: 'running', progress: { checked: 50, total: 501 } });
    const r = await request(`/policies/${POLICY}/preview`);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ data: { status: 'running', progress: { checked: 50, total: 501 } } });
  });
  it('passes preview hash and selected sources without accepting a caller-supplied owner', async () => {
    const r = await request(mutations[0]![0], 'POST', mutations[0]![1]);
    expect(r.status).toBe(200);
    expect(m.convert).toHaveBeenCalledWith(POLICY, HASH, expect.anything(), { sourceIds: [SOURCE] });
    expect(await r.json()).toEqual({ data: { conversionIds: [SOURCE], retired: 1, monitorsCreated: 1 } });
  });
  it('revert and retire return explicit mutation outcomes', async () => {
    for (const [path, body] of mutations.slice(1, 3)) {
      const r = await request(path, 'POST', body);
      expect(await r.json()).toEqual(path === '/retire' ? { success: true, conversionId: SOURCE } : { success: true });
    }
    expect(m.revert).toHaveBeenCalledWith(SOURCE, expect.anything());
    expect(m.retire).toHaveBeenCalledWith('config_policy_alert_rules', SOURCE, 'operator', expect.anything());
    expect(m.audit).toHaveBeenCalledTimes(2);
  });
  it('partner convert-all infers the partner and requires full partner membership', async () => {
    expect((await request('/partner/convert-all', 'POST', { previewHash: HASH })).status).toBe(403);
    expect((await request('/partner/convert-all', 'POST', { previewHash: HASH }, { scope: 'partner', partnerOrgAccess: 'selected' })).status).toBe(403);
    const r = await request('/partner/convert-all', 'POST', { previewHash: HASH }, { scope: 'partner', orgId: null, partnerOrgAccess: 'all' });
    expect(r.status).toBe(200);
    expect(m.partner).toHaveBeenCalledWith(PARTNER, HASH, expect.objectContaining({ scope: 'partner' }));
  });
  it('pending projects the banner contract and denies a cross-org query before reading', async () => {
    const r = await request('/pending');
    expect(await r.json()).toEqual({ data: { policies: 0, rows: 0 } });
    expect(m.counts).toHaveBeenCalledWith({ orgId: ORG, partnerId: PARTNER, includePartnerWide: false });
    m.counts.mockClear();
    expect((await request(`/pending?orgId=${OTHER}`)).status).toBe(403);
    expect(m.counts).not.toHaveBeenCalled();
  });
  it.each(mutations)('guards %s with auth, permissions, MFA, site and device ceilings', async (path, body) => {
    m.authenticated = false;
    expect((await request(path, 'POST', body)).status).toBe(401);
    m.authenticated = true; m.permission = false;
    expect((await request(path, 'POST', body)).status).toBe(403);
    m.permission = true; m.mfa = false;
    expect((await request(path, 'POST', body)).status).toBe(403);
    m.mfa = true;
    expect((await request(path, 'POST', body, { allowedSiteIds: [] })).status).toBe(403);
    expect((await request(path, 'POST', body, { allowedDeviceIds: [SOURCE] })).status).toBe(403);
    expect(m.convert).not.toHaveBeenCalled();
    expect(m.revert).not.toHaveBeenCalled();
    expect(m.retire).not.toHaveBeenCalled();
    expect(m.partner).not.toHaveBeenCalled();
  });
  it.each([
    ['/policies/not-a-uuid/preview', 'GET', undefined],
    [`/policies/${POLICY}/convert`, 'POST', {}],
    [`/policies/${POLICY}/convert`, 'POST', { previewHash: HASH, sourceIds: [] }],
    [`/policies/${POLICY}/convert`, 'POST', { previewHash: HASH, sourceIds: ['bad'] }],
    ['/retire', 'POST', { sourceTable: 'alerts', sourceId: SOURCE, reason: 'operator' }],
    ['/retire', 'POST', { sourceTable: 'automations', sourceId: SOURCE, reason: 'converted' }],
    ['/pending?orgId=bad', 'GET', undefined],
  ])('rejects invalid input %s', async (path, method, body) => {
    expect((await request(path as string, method as string, body)).status).toBe(400);
  });
  it.each([
    ['policy_not_found', 404], ['partner_wide_denied', 403],
    ['preview_stale', 409], ['conversion_revert_unavailable', 409], ['equivalence_delta', 409], ['blocked', 409],
    ['source_not_found', 404], ['conversion_not_found', 404], ['already_converted', 409],
  ] as const)('maps %s without claiming success', async (code, status) => {
    m.convert.mockRejectedValue(new ConversionError(code, code, { reason: code }));
    const r = await request(mutations[0]![0], 'POST', mutations[0]![1]);
    expect(r.status).toBe(status);
    expect(await r.json()).toMatchObject({ error: code, details: { reason: code } });
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('names missing prerequisites and lets unexpected failures become 500', async () => {
    m.convert.mockRejectedValueOnce(new ConversionPrerequisiteMissingError(['#6342']));
    const r = await request(mutations[0]![0], 'POST', mutations[0]![1]);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: ['#6342'] });
    m.convert.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await request(mutations[0]![0], 'POST', mutations[0]![1])).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

From the repository root: `cd apps/api && npx vitest run src/routes/monitorDefinitions.conversion.test.ts` → `Failed to resolve import "./monitorDefinitions.conversion"` (the new route module is absent). Do not interpret an auth/DB import failure as this expected red.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/monitorDefinitions.conversion.ts`:

```ts
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';
import { MONITOR_CONVERSION_SOURCE_TABLES } from '../db/schema/monitorConversions';
import {
  previewPolicyConversion, convertPolicy, revertConversion, retireSource,
  convertPartnerLegacy, previewPartnerConversion, listConversionLedger, countPendingConversions,
  ConversionError, ConversionPrerequisiteMissingError,
} from '../services/monitors/conversion';

type Env = { Variables: { auth: AuthContext } };
export const monitorConversionRoutes = new Hono<Env>();
// Also authenticated when mounted in isolation by tools/tests. The real auth
// middleware already short-circuits an existing authenticated context.
monitorConversionRoutes.use('*', authMiddleware);
monitorConversionRoutes.use('*', requireScope('organization', 'partner', 'system'));
const read = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const write = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
const governance: MiddlewareHandler<Env> = async (c, next) => {
  if (!canMutateOrgWideGovernance(c.get('auth'))) {
    return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
  }
  await next();
};
const policyParam = z.object({ policyId: z.string().uuid() });
const conversionParam = z.object({ conversionId: z.string().uuid() });
const convertBody = z.object({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
}).strict();
const retireBody = z.object({
  sourceTable: z.enum(MONITOR_CONVERSION_SOURCE_TABLES),
  sourceId: z.string().uuid(),
  reason: z.string().max(200).regex(/^(operator|unconvertible:[a-z][a-z0-9_]*)$/),
}).strict();

monitorConversionRoutes.onError((error, c) => {
  if (error instanceof ConversionPrerequisiteMissingError) {
    return c.json({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: error.missing }, 409);
  }
  if (!(error instanceof ConversionError)) throw error;
  if (error.code === 'prerequisite_missing') {
    return c.json({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: Array.isArray(error.details) ? error.details : [] }, 409);
  }
  const status = error.code === 'partner_wide_denied' ? 403
    : ['policy_not_found', 'source_not_found', 'conversion_not_found'].includes(error.code) ? 404
    : error.code === 'invalid_reason' ? 400 : 409;
  return c.json({ error: error.code, message: error.message, details: error.details }, status);
});

monitorConversionRoutes.post('/partner/preview', read, governance, async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  if (!auth.partnerId) return c.json({ error: 'Select a partner' }, 400);
  return c.json({ data: await previewPartnerConversion(auth.partnerId, auth) });
});
monitorConversionRoutes.get('/ledger', read,
  zValidator('query', z.object({ orgId: z.string().uuid().optional(), policyId: z.string().uuid().optional(),
    cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })), async (c) => {
    return c.json(await listConversionLedger(c.req.valid('query'), c.get('auth')));
  });
monitorConversionRoutes.get('/pending', read,
  zValidator('query', z.object({ orgId: z.string().uuid().optional() })), async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.valid('query').orgId ?? auth.orgId;
    if (orgId && !auth.canAccessOrg(orgId)) return c.json({ error: 'Organization access denied' }, 403);
    if (!orgId && !auth.partnerId) return c.json({ error: 'Select an organization or partner' }, 400);
    const counts = await countPendingConversions({
      orgId, partnerId: auth.partnerId,
      includePartnerWide: canManagePartnerWidePolicies(auth),
    });
    return c.json({ data: { policies: counts.policies, rows: counts.rows } });
  });
monitorConversionRoutes.get('/policies/:policyId/preview', read,
  zValidator('param', policyParam), async (c) => {
    const data = await previewPolicyConversion(c.req.valid('param').policyId, c.get('auth'));
    return c.json({ data }, 'status' in data && data.status === 'running' ? 202 : 200);
  });
monitorConversionRoutes.post('/policies/:policyId/convert', write, requireMfa(), governance,
  zValidator('param', policyParam), zValidator('json', convertBody), async (c) => {
    const { policyId } = c.req.valid('param');
    const { previewHash, sourceIds } = c.req.valid('json');
    const data = await convertPolicy(policyId, previewHash, c.get('auth'), { sourceIds });
    writeRouteAudit(c, { action: 'monitor.conversion.convert', resourceType: 'configuration_policy', resourceId: policyId, details: data });
    return c.json({ data });
  });
monitorConversionRoutes.post('/partner/convert-all', write, requireMfa(), governance,
  zValidator('json', z.object({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()), async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  if (!auth.partnerId) return c.json({ error: 'Select a partner' }, 400);
  const data = await convertPartnerLegacy(auth.partnerId, c.req.valid('json').previewHash, auth);
  writeRouteAudit(c, { action: 'monitor.conversion.convert_all', resourceType: 'partner', resourceId: auth.partnerId, details: data });
  return c.json({ data });
});
monitorConversionRoutes.post('/retire', write, requireMfa(), governance,
  zValidator('json', retireBody), async (c) => {
    const { sourceTable, sourceId, reason } = c.req.valid('json');
    const { conversionId } = await retireSource(sourceTable, sourceId, reason, c.get('auth'));
    writeRouteAudit(c, { action: 'monitor.conversion.retire', resourceType: sourceTable, resourceId: sourceId, details: { reason, conversionId } });
    return c.json({ success: true, conversionId });
  });
monitorConversionRoutes.post('/:conversionId/revert', write, requireMfa(), governance,
  zValidator('param', conversionParam), async (c) => {
    const { conversionId } = c.req.valid('param');
    await revertConversion(conversionId, c.get('auth'));
    writeRouteAudit(c, { action: 'monitor.conversion.revert', resourceType: 'monitor_conversion', resourceId: conversionId });
    return c.json({ success: true });
  });
```

In `monitorDefinitions.ts`, import and mount before the `// GET /monitors/:id` comment:

```ts
import { monitorConversionRoutes } from './monitorDefinitions.conversion';
// Literal conversion resource must be registered before parameterized ids.
monitorDefinitionRoutes.route('/conversion', monitorConversionRoutes);
```

Extend `monitorDefinitions.test.ts` with a mount regression. Mock the conversion module, so existing monitor-only tests keep their DB graph small:

```ts
vi.mock('./monitorDefinitions.conversion', async () => {
  const { Hono } = await import('hono');
  return { monitorConversionRoutes: new Hono().get('/pending', (c) => c.json({ data: { policies: 0, rows: 0 } })) };
});
it('mounts the literal conversion resource before monitor ids', async () => {
  const response = await jsonRequest(buildApp(), 'GET', '/conversion/pending');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { policies: 0, rows: 0 } });
  expect(getMonitorDefinitionMock).not.toHaveBeenCalled();
});
```

Create `apps/api/src/services/monitors/conversion/ledger.ts` and re-export `listConversionLedger` from the barrel. Add this file and its adjacent tests to this task's Files and commit command. It uses the same owner predicates as the converter and Task 15's lifecycle guard:

```ts
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { monitorConversions, monitorConversionOutputs } from '../../../db/schema';
import type { AuthContext } from '../../../middleware/auth';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { getConfigPolicy } from '../../configurationPolicy';
import { ConversionError } from './convert';
import { isRevertAvailable, findLiveTargetDependencies } from './lifecycle';
import type { ConversionLedgerEntry } from './types';
export async function listConversionLedger(query: { orgId?: string; policyId?: string; cursor?: string; limit?: number }, auth: AuthContext): Promise<{ items: ConversionLedgerEntry[]; nextCursor: string | null }> {
  if (query.orgId && !auth.canAccessOrg(query.orgId)) throw new ConversionError('partner_wide_denied', 'Organization access denied');
  if (query.policyId && !await getConfigPolicy(query.policyId, auth)) throw new ConversionError('policy_not_found', 'Policy not found');
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const owner = auth.scope === 'system' ? undefined : or(
    inArray(monitorConversions.orgId, auth.accessibleOrgIds ?? []),
    auth.partnerId ? and(isNull(monitorConversions.orgId), eq(monitorConversions.partnerId, auth.partnerId)) : undefined);
  const rows = await db.select().from(monitorConversions).where(and(owner,
    query.orgId ? eq(monitorConversions.orgId, query.orgId) : undefined,
    query.cursor ? lt(monitorConversions.id, query.cursor) : undefined,
    query.policyId ? or(eq(monitorConversions.policyId, query.policyId), sql`EXISTS (SELECT 1 FROM ${monitorConversionOutputs}
      WHERE ${monitorConversionOutputs.conversionId} = ${monitorConversions.id} AND ${monitorConversionOutputs.policyId} = ${query.policyId})`) : undefined,
  )).orderBy(desc(monitorConversions.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const blockedByLiveTarget = await findLiveTargetDependencies(page, db);
  const outputs = page.length ? await db.select().from(monitorConversionOutputs).where(inArray(monitorConversionOutputs.conversionId, page.map((r) => r.id))) : [];
  return { items: page.map((r) => ({ id: r.id, sourceTable: r.sourceTable, sourceId: r.sourceId,
    sourceName: String(r.sourceState.name ?? (r.sourceState.template as { name?: string } | undefined)?.name ?? r.sourceId),
    policyId: r.policyId, convertedBy: r.convertedBy, convertedAt: r.convertedAt.toISOString(), revertedAt: r.revertedAt?.toISOString() ?? null,
    revertable: !r.revertedAt && isRevertAvailable(r.sourceTable) && canMutateOrgWideGovernance(auth)
      && (r.orgId ? auth.canAccessOrg(r.orgId) : canManagePartnerWidePolicies(auth))
      && !blockedByLiveTarget.has(r.id),
    outputs: outputs.filter((o) => o.conversionId === r.id && o.monitorId).map((o) => ({ monitorId: o.monitorId!, role: o.role, reused: o.reusedMonitor })),
  })), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
}
```

W05d Task 6 must retain this full projection, including `&& !blockedByLiveTarget.has(r.id)`, when changing lifecycle availability. The dependency query deliberately ignores pagination and `policyId` filters, while staying in the caller's DB context. System actor/name contracts stay unchanged: W05e stores `sourceState.name`, and system conversions retain `convertedBy: null`.

Create the following executable `ledger.test.ts` regressions; they exercise the real dependency helper and ledger projection with real Drizzle predicates. Keep the previously specified ownership/policy-filter tests alongside them.

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], predicates: [] as any[] }));
vi.mock('../../../db', () => ({ db: { select: () => {
  const rows = m.rows.shift() ?? [];
  const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
  for (const method of ['from', 'orderBy', 'limit']) c[method] = () => c;
  c.where = (predicate: unknown) => { m.predicates.push(predicate); return c; };
  return c;
} } }));
vi.mock('../../configurationPolicy', () => ({ getConfigPolicy: vi.fn() }));
vi.mock('./convert', () => ({ ConversionError: class extends Error {
  constructor(public code: string, message: string) { super(message); }
} }));
import { listConversionLedger } from './ledger';
import type { AuthContext } from '../../../middleware/auth';
const ORG = '10000000-0000-4000-8000-000000000001';
const RESPONSE = '10000000-0000-4000-8000-000000000002';
const TARGET = '10000000-0000-4000-8000-000000000003';
const auth = { scope: 'organization', orgId: ORG, partnerId: null, accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG } as AuthContext;
const entry = { id: RESPONSE, orgId: ORG, partnerId: null, sourceTable: 'automations', sourceId: RESPONSE,
  policyId: null, convertedBy: null, convertedAt: new Date(0), revertedAt: null,
  sourceState: { name: 'CPU response', targetConversionId: TARGET } };
beforeEach(() => { m.rows = []; m.predicates = []; });
it.each([true, false])('projects response Undo against target liveness outside this page (%s)', async (live) => {
  m.rows = [[entry], live ? [{ id: TARGET }] : [], []];
  const result = await listConversionLedger({ limit: 1 }, auth);
  expect(result.items[0]).toMatchObject({ id: RESPONSE, sourceName: 'CPU response', revertable: !live });
  const dependency = new PgDialect().sqlToQuery(m.predicates[1]);
  expect(dependency.sql).toContain('"reverted_at" is null');
  expect(dependency.params).toEqual([TARGET]);
});
it('retirement has no dependency and network history preserves its stored name', async () => {
  m.rows = [[{ ...entry, sourceTable: 'network_monitors', sourceState: { name: 'Branch gateway' } }], []];
  expect((await listConversionLedger({}, auth)).items[0]).toMatchObject({ sourceName: 'Branch gateway', revertable: true, outputs: [] });
});
it.each([
  { row: { ...entry, revertedAt: new Date(1), sourceState: {} }, caller: auth },
  { row: { ...entry, sourceState: {} }, caller: { ...auth, allowedSiteIds: [] } },
  { row: { ...entry, orgId: null, partnerId: TARGET, sourceState: {} }, caller: auth },
])('retains lifecycle, governance and owner restrictions', async ({ row, caller }) => {
  m.rows = [[row], []];
  expect((await listConversionLedger({}, caller)).items[0]!.revertable).toBe(false);
});
```

Append these concrete HTTP regressions to the test above. Add direct `ledger.test.ts` using the chain helper from the private baseline test to prove the SQL predicates include org ownership and policy output associations; the service denies inaccessible org/policy filters before selecting ledger rows.

```ts
it('previews the whole partner and requires its hash at confirmation', async () => {
  const auth = { scope: 'partner' as const, orgId: null, partnerOrgAccess: 'all' as const };
  expect((await request('/partner/preview', 'POST', undefined, auth)).status).toBe(200);
  expect(m.partnerPreview).toHaveBeenCalledWith(PARTNER, expect.objectContaining(auth));
  expect((await request('/partner/convert-all', 'POST', {}, auth)).status).toBe(400);
  m.partner.mockRejectedValueOnce(new ConversionError('preview_stale', 'Partner scope changed'));
  expect((await request('/partner/convert-all', 'POST', { previewHash: HASH }, auth)).status).toBe(409);
});
it('browses persistent ledger entries with an opaque cursor and lifecycle availability', async () => {
  const entry = { id: SOURCE, sourceTable: 'config_policy_alert_rules', sourceId: SOURCE, sourceName: 'CPU',
    policyId: POLICY, convertedBy: null, convertedAt: '2026-09-19T00:00:00.000Z', revertedAt: null,
    revertable: false, outputs: [] };
  m.ledger.mockResolvedValueOnce({ items: [entry], nextCursor: SOURCE });
  const response = await request(`/ledger?orgId=${ORG}&policyId=${POLICY}&limit=1`);
  expect(await response.json()).toEqual({ items: [entry], nextCursor: SOURCE });
  expect(m.ledger).toHaveBeenCalledWith({ orgId: ORG, policyId: POLICY, limit: 1 }, expect.anything());
  expect((await request('/ledger?limit=101')).status).toBe(400);
});
it('rejects unavailable revert before mutation or success audit', async () => {
  m.revert.mockRejectedValueOnce(new ConversionError('conversion_revert_unavailable', 'Legacy runtime retired'));
  const response = await request(`/${SOURCE}/revert`, 'POST');
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'conversion_revert_unavailable' });
  expect(m.audit).not.toHaveBeenCalled();
});
it.each([[], [SOURCE]])('does not return policy preview to site-restricted callers', async (allowedSiteIds) => {
  m.preview.mockRejectedValueOnce(new ConversionError('partner_wide_denied', 'Full policy scope required'));
  expect((await request(`/policies/${POLICY}/preview`, 'GET', undefined, { allowedSiteIds })).status).toBe(403);
});
```

The ledger route regression also returns a response entry with `revertable: false` while its target is live; the direct service and round-trip tests above establish the actual dependency behavior behind that projection.

The service-level cache test must use a completed result from one scope, then request as another principal/ceiling and assert it is never returned. `retireSource` returning its `conversionId` lets W05c2 immediately refresh this persistent ledger after manual retirement. All W05c2 POST handlers use `runAction`, including partner preview; selection stays in the hash.

- [ ] **Step 4: Run, expect PASS**

From the repository root: `cd apps/api && npx vitest run src/routes/monitorDefinitions.conversion.test.ts src/services/monitors/conversion/ledger.test.ts src/services/monitors/conversion/lifecycle.test.ts src/routes/monitorDefinitions.test.ts src/routes/monitorDefinitions.authGate.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts` → all pass; `cd apps/api && npx tsc --noEmit -p .` → exit 0. W05c2 uses `runAction` for all four POST actions, preserves the 202 polling state, and uses `location.hash` for selected UI state; there are no new web mutations or translations in this task.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/monitorDefinitions.ts apps/api/src/routes/monitorDefinitions.conversion.ts apps/api/src/routes/monitorDefinitions.conversion.test.ts apps/api/src/routes/monitorDefinitions.test.ts apps/api/src/services/monitors/conversion/ledger.ts apps/api/src/services/monitors/conversion/ledger.test.ts apps/api/src/services/monitors/conversion/index.ts
git commit -m "feat(monitors): expose scoped conversion preview, convert, revert, retire and pending routes"
```

### Task 17: Publish monitor identity/kind and move onboarding plus the historical alert importer to monitor attachments

**Files:**
- Modify: `apps/api/src/services/alertService.ts:46-68,157-160,226-267,289-326,349-399,1102-1113`; test `apps/api/src/services/alertService.test.ts:145-232`.
- Modify: `apps/api/src/modules/mcpInvites/tools/configureDefaults.ts:3-13,40-48,76-159,259-260`; test `apps/api/src/modules/mcpInvites/tools/configureDefaults.test.ts:153-315,391-485`.
- Create: `apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.ts` and adjacent `configureDefaults.monitors.test.ts` (isolate the policy attachment graph from the three other bootstrap steps).
- Modify: `apps/api/src/scripts/migrateToConfigPolicies.ts:30-52,176,222,275,329,349-418,634,647-655,694-703`; create adjacent `migrateToConfigPolicies.test.ts`.
- Reads: `apps/api/src/modules/mcpInvites/types.ts:17-27` (no authenticated user in `BootstrapContext`); `apps/api/src/services/monitors/builtInMonitors.ts:58-99`; `apps/api/src/db/schema/configurationPolicies.ts:78-104` (no default-policy marker); `apps/api/src/services/configurationPolicy.ts:1655-1662,1752-1758,1901-1949`; `apps/api/src/services/monitors/ruleConversionService.ts:25-40,49-70,120-139`; `apps/api/src/services/featureConfigResolver.ts:52-79` (synthetic system identity); `apps/api/src/db/index.ts:734-745,950` (system context / `runOutsideDbContext`).

**Interfaces:**
- Consumes: existing `monitorDefinitions.builtinKey`, the partner-wide SELECT-only branch, `addFeatureLink(..., executor)`, `updateFeatureLink(..., executor)`, `listFeatureLinks(policyId, executor)`, Task 1's `monitorsInlineSettingsSchema`, Task 15's ledger-aware `convertRuleToMonitor(ruleId, auth, executor?)`.
- Produces: `CreateAlertParams.kind?: MonitorKind | null`, `CreateSourcedAlertParams.kind?: MonitorKind | null`; published `alert.triggered` includes `monitorId: string | null` and `kind: MonitorKind | null`. Existing `ruleId` filters remain unchanged. Missing kind on an existing monitor id is resolved from the definition under the current DB context, so offline/recurrence callers need no parallel lookup code.
- Produces: `applyStandardAlertPolicy(orgId: string, framework: 'standard' | 'cis', expectedPartnerId: string): Promise<{ created: boolean; skipped_reason?: string }>`; the bootstrap output key remains `applied.alert_policy` for compatibility.
- Produces: exported `migrateAlertRulesLive(tx: Tx, orgId: string, auth: AuthContext): Promise<number>`, using target-specific monitor policies, never adding alert monitors to the historical umbrella policy.

The schema has no default-policy pointer. For onboarding, establish the explicit local convention `name = 'Default monitoring'`, `description = 'Baseline monitor attachments created by configure_defaults.'`, owned by the bootstrap org. Reuse only that marked policy; preserve inactive state and all existing attachment settings. Lock the org before checking/creating so concurrent bootstrap calls cannot create duplicate baselines. Do not seed monitors: a partner's deleted/disabled built-ins are deliberate choices.

The importer remains labelled historical and is still deleted by W05d. This is an interim repair of its alert-writing function, **not** an instruction to rerun the one-shot migration. Any future explicitly authorized system invocation writes null actor FKs (D7); never persist the synthetic zero-UUID user.

- [ ] **Step 1: Write the failing tests**

Append to `alertService.test.ts` using its existing `dbMock`, publish and cooldown mocks:

```ts
describe('alert.triggered monitor identity and kind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([{ id: 'alert-kind' }]);
  });
  const input = { deviceId: 'device-1', orgId: 'org-1', severity: 'high' as const, title: 'CPU', message: 'High CPU' };
  it('publishes the supplied compiled-monitor kind and keeps ruleId', async () => {
    dbMock._selectResults.push(
      [{ id: 'rule-1', templateId: 'template-1', managedByMonitorId: 'monitor-1' }],
      [{ cooldownMinutes: 5 }], [],
    );
    await createAlert({ ...input, ruleId: 'rule-1', monitorId: 'monitor-1', kind: 'cpu' });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ ruleId: 'rule-1', monitorId: 'monitor-1', kind: 'cpu' }),
      'alert-service', { siteId: 'site-1' });
  });
  it('resolves a sourced monitor kind when the recurrence producer only knows its id', async () => {
    dbMock._selectResults.push([{ kind: 'disk' }]);
    await createSourcedAlert({ ...input, monitorId: 'monitor-1', context: { source: 'monitor_recurrence' }, publisher: 'monitor-escalation' });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ ruleId: null, monitorId: 'monitor-1', kind: 'disk' }),
      'monitor-escalation', { siteId: 'site-1' });
  });
  it('sourced payload extras cannot replace canonical monitor identity', async () => {
    await createSourcedAlert({ ...input, monitorId: 'monitor-1', kind: 'memory',
      context: { source: 'monitor_recurrence' }, publisher: 'monitor-escalation',
      eventPayload: { monitorId: 'wrong', kind: 'cpu' } });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ monitorId: 'monitor-1', kind: 'memory' }),
      'monitor-escalation', { siteId: 'site-1' });
  });
  it('feature-sourced alerts have explicit nulls and retain source-specific context', async () => {
    await createSourcedAlert({ ...input, context: { source: 'network_monitor', monitorId: 'legacy-check' },
      publisher: 'monitor-worker', eventPayload: { monitorId: 'legacy-check' } });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ monitorId: null, kind: null, source: 'network_monitor' }),
      'monitor-worker', { siteId: 'site-1' });
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});
```

In the existing sourced-network test at `alertService.test.ts:218`, change the expected event `monitorId: 'monitor-1'` to `monitorId: null, kind: null`. Keep its input context unchanged: legacy network check ids are not `monitor_definitions.id`. The source-specific id remains in `alerts.context.monitorId` until W05e adopts the check. W05e consumers retain the legacy check id in source context and use typed `monitorId` only for definition ids (D13/D15).

Create `configureDefaults.monitors.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], inserts: [] as unknown[], predicates: [] as any[], links: vi.fn(), add: vi.fn(), update: vi.fn() }));
vi.mock('../../../db', () => {
  const tx: any = {
    transaction: (fn: any) => fn(tx),
    select: () => {
      const result = m.rows.shift() ?? [];
      const c: any = { from: () => c, where: (p: any) => { m.predicates.push(p); return c; },
        limit: () => c, for: () => c, orderBy: () => c,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
      return c;
    },
    insert: (table: unknown) => ({ values: (value: unknown) => {
      m.inserts.push({ table, value });
      const c: any = { onConflictDoNothing: () => c, returning: async () => [{ id: '20000000-0000-4000-8000-000000000003' }] };
      return c;
    } }),
  };
  return { db: tx };
});
vi.mock('../../../services/configurationPolicy', () => ({ listFeatureLinks: m.links, addFeatureLink: m.add, updateFeatureLink: m.update }));
import { applyStandardAlertPolicy } from './configureDefaults.monitors';
import { alertRules, configPolicyAssignments, configurationPolicies } from '../../../db/schema';
const ORG = '20000000-0000-4000-8000-000000000001';
const PARTNER = '20000000-0000-4000-8000-000000000002';
const MONITOR = '20000000-0000-4000-8000-000000000004';
const OTHER = '20000000-0000-4000-8000-000000000005';
beforeEach(() => {
  vi.resetAllMocks(); m.rows = []; m.inserts = []; m.predicates = [];
  m.links.mockResolvedValue([]); m.add.mockResolvedValue({ id: 'link-1' });
});
describe('baseline monitor attachments', () => {
  it('creates an org policy, assignment and monitors link, never a legacy rule', async () => {
    m.rows = [[{ id: ORG }], [{ id: MONITOR }], []];
    expect(await applyStandardAlertPolicy(ORG, 'standard', PARTNER)).toEqual({ created: true });
    expect(m.inserts).toContainEqual({ table: configurationPolicies, value: expect.objectContaining({ orgId: ORG, partnerId: null, createdBy: null }) });
    expect(m.inserts).toContainEqual({ table: configPolicyAssignments, value: expect.objectContaining({ targetId: ORG, level: 'organization', assignedBy: null }) });
    expect(m.inserts.some((x: any) => x.table === alertRules)).toBe(false);
    expect(m.add).toHaveBeenCalledWith(expect.any(String), 'monitors', null,
      expect.objectContaining({ inheritance: 'cumulative', items: [{ monitorId: MONITOR, enabled: true, overrides: null, sortOrder: 0 }] }), undefined, expect.anything());
    const query = m.predicates.map((p) => new PgDialect().sqlToQuery(p));
    expect(query[0]!.params).toEqual([ORG, PARTNER]);
    expect(query[1]!.sql).toContain('"builtin_key" is not null');
    expect(query[1]!.params).toContain(PARTNER);
  });
  it('preserves a disabled attachment, custom overrides and replace inheritance', async () => {
    m.rows = [[{ id: ORG }], [{ id: MONITOR }, { id: OTHER }], [{ id: 'policy', status: 'active' }]];
    const existing = { monitorId: MONITOR, enabled: false, overrides: { value: 95 }, sortOrder: 8 };
    m.links.mockResolvedValue([{ id: 'link', featureType: 'monitors', inlineSettings: { inheritance: 'replace', items: [existing] } }]);
    await applyStandardAlertPolicy(ORG, 'standard', PARTNER);
    expect(m.update).toHaveBeenCalledWith('link', { inlineSettings: {
      inheritance: 'replace', items: [existing, { monitorId: OTHER, enabled: true, overrides: null, sortOrder: 9 }],
    } }, 'policy', undefined, expect.anything());
  });
  it('does not rewrite a fully attached baseline', async () => {
    m.rows = [[{ id: ORG }], [{ id: MONITOR }], [{ id: 'policy', status: 'active' }]];
    m.links.mockResolvedValue([{ id: 'link', featureType: 'monitors', inlineSettings: { items: [{ monitorId: MONITOR, enabled: false, overrides: null, sortOrder: 0 }], inheritance: 'cumulative' } }]);
    // The assignment already exists; returning [] makes this a genuine no-op.
    const { db } = await import('../../../db');
    vi.spyOn(db, 'insert').mockReturnValueOnce({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) } as never);
    expect(await applyStandardAlertPolicy(ORG, 'standard', PARTNER)).toEqual({ created: false });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.add).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('does not create policies when built-ins are absent and respects an inactive baseline', async () => {
    m.rows = [[{ id: ORG }], []];
    expect(await applyStandardAlertPolicy(ORG, 'cis', PARTNER)).toMatchObject({ created: false, skipped_reason: 'no enabled built-in monitors found' });
    m.rows = [[{ id: ORG }], [{ id: MONITOR }], [{ id: 'policy', status: 'archived' }]];
    expect(await applyStandardAlertPolicy(ORG, 'cis', PARTNER)).toMatchObject({ created: false, skipped_reason: 'default monitoring policy is inactive' });
    expect(m.inserts).toEqual([]);
  });
  it('fails closed on a missing or cross-partner organization', async () => {
    m.rows = [[]];
    await expect(applyStandardAlertPolicy(ORG, 'standard', PARTNER)).rejects.toThrow('Organization not found for bootstrap partner');
    expect(m.inserts).toEqual([]);
    expect(m.add).not.toHaveBeenCalled();
  });
});
```

Create `migrateToConfigPolicies.test.ts` (uses the real Drizzle predicate builder, a mocked converter, and no CLI execution):

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock('../services/monitors/ruleConversionService', () => ({ convertRuleToMonitor: m.convert }));
import { migrateAlertRulesLive } from './migrateToConfigPolicies';
import type { AuthContext } from '../middleware/auth';
const auth = { scope: 'system', user: { id: '30000000-0000-4000-8000-000000000001' } } as AuthContext;
const ORG = '30000000-0000-4000-8000-000000000002';
function tx(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  return { db: { select: () => ({ from: () => ({ where }) }), insert: vi.fn() }, where };
}
beforeEach(() => vi.resetAllMocks());
it('converts each source via the ledger-aware service and never writes umbrella attachments', async () => {
  const f = tx([{ id: 'r1', templateId: 't1' }, { id: 'r2', templateId: 't1' }]);
  m.convert.mockResolvedValue({ ok: true, data: { monitorId: 'monitor', configPolicyId: 'target-specific-policy', convertedRuleIds: ['r1', 'r2'] } });
  expect(await migrateAlertRulesLive(f.db as never, ORG, auth)).toBe(2);
  expect(m.convert.mock.calls).toEqual([['r1', auth, f.db]]);
  expect(f.db.insert).not.toHaveBeenCalled();
  const query = new PgDialect().sqlToQuery(f.where.mock.calls[0]![0]);
  expect(query.sql).toContain('"managed_by_monitor_id" is null');
  expect(query.sql).toContain('"retired_at" is null');
  expect(query.params).toEqual([ORG]);
});
it('empty input does nothing and an unconvertible source is reported, never retired silently', async () => {
  expect(await migrateAlertRulesLive(tx([]).db as never, ORG, auth)).toBe(0);
  m.convert.mockResolvedValue({ ok: false, failure: { kind: 'not_convertible' } });
  await expect(migrateAlertRulesLive(tx([{ id: 'r1' }]).db as never, ORG, auth)).rejects.toThrow('r1: not_convertible');
});
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/alertService.test.ts src/modules/mcpInvites/tools/configureDefaults.monitors.test.ts src/scripts/migrateToConfigPolicies.test.ts` → event assertions report missing `kind`; the new baseline module is not found; the historical script does not export `migrateAlertRulesLive`. Before importing the historical script in the red test run, first add the `import.meta.url` entry guard shown below (testability-only change), so importing the test can never launch the CLI. Do not run the historical CLI itself.

- [ ] **Step 3: Implement**

In `alertService.ts`, import `type MonitorKind` from `@breeze/shared`, add `kind?: MonitorKind | null` beside `monitorId` in both parameter interfaces, and add:

```ts
async function monitorEventFields(monitorId: string | null | undefined, kind?: MonitorKind | null): Promise<{ monitorId: string | null; kind: MonitorKind | null }> {
  if (!monitorId) return { monitorId: null, kind: null };
  if (kind) return { monitorId, kind };
  const [definition] = await db.select({ kind: monitorDefinitions.kind })
    .from(monitorDefinitions).where(eq(monitorDefinitions.id, monitorId)).limit(1);
  return { monitorId, kind: definition?.kind ?? null };
}
```

Immediately before the `createAlert` insert (after its dedupe/flapping gates):

```ts
  const monitorFields = await monitorEventFields(monitorId ?? rule.managedByMonitorId, params.kind);
```

Use `monitorId: monitorFields.monitorId` in that insert and append `...monitorFields` to its event payload after `message`. In `evaluateDeviceAlerts`, pass `kind: monitor?.kind ?? null` after `monitorId` so the normal sweep reuses its batched definition read. Immediately before the `createSourcedAlert` insert:

```ts
  const monitorFields = await monitorEventFields(params.monitorId, params.kind);
```

Keep its persisted `monitorId: params.monitorId ?? null`; replace the tail of its event payload with:

```ts
      ...eventPayload,
      ...monitorFields,
      source: context.source,
```

No `kind` column or migration: this is event metadata. Non-monitor sourced alerts use explicit nulls; `source`, site-scoping, dedupe, publish rollback, and correlation behavior stay intact.

Create `configureDefaults.monitors.ts`:

```ts
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { monitorsInlineSettingsSchema } from '@breeze/shared';
import { db } from '../../../db';
import { organizations, monitorDefinitions, configurationPolicies, configPolicyAssignments } from '../../../db/schema';
import { addFeatureLink, listFeatureLinks, updateFeatureLink } from '../../../services/configurationPolicy';

const BASELINE_NAME = 'Default monitoring';
const BASELINE_DESCRIPTION = 'Baseline monitor attachments created by configure_defaults.';
export async function applyStandardAlertPolicy(orgId: string, _framework: 'standard' | 'cis', expectedPartnerId: string): Promise<{ created: boolean; skipped_reason?: string }> {
  return db.transaction(async (tx) => {
    // Serializes bootstrap calls for this org without granting any new DB scope.
    const [org] = await tx.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, expectedPartnerId)))
      .limit(1).for('update');
    if (!org) throw new Error('Organization not found for bootstrap partner');
    const builtIns = await tx.select({ id: monitorDefinitions.id }).from(monitorDefinitions)
      .where(and(eq(monitorDefinitions.partnerId, expectedPartnerId), isNull(monitorDefinitions.orgId),
        isNotNull(monitorDefinitions.builtinKey), eq(monitorDefinitions.enabled, true)))
      .orderBy(asc(monitorDefinitions.builtinKey));
    if (builtIns.length === 0) return { created: false, skipped_reason: 'no enabled built-in monitors found' };
    let [policy] = await tx.select().from(configurationPolicies).where(and(
      eq(configurationPolicies.orgId, orgId), isNull(configurationPolicies.partnerId),
      eq(configurationPolicies.name, BASELINE_NAME), eq(configurationPolicies.description, BASELINE_DESCRIPTION),
    )).limit(1).for('update');
    if (policy && policy.status !== 'active') return { created: false, skipped_reason: 'default monitoring policy is inactive' };
    let created = false;
    if (!policy) {
      [policy] = await tx.insert(configurationPolicies).values({
        orgId, partnerId: null, name: BASELINE_NAME, description: BASELINE_DESCRIPTION,
        status: 'active', createdBy: null,
      }).returning();
      if (!policy) throw new Error('Could not create default monitoring policy');
      created = true;
    }
    const assignments = await tx.insert(configPolicyAssignments).values({
      configPolicyId: policy.id, level: 'organization', targetId: orgId, priority: 0, assignedBy: null,
    }).onConflictDoNothing().returning({ id: configPolicyAssignments.id });
    created ||= assignments.length > 0;
    const links = await listFeatureLinks(policy.id, tx);
    const link = links.find((item) => item.featureType === 'monitors');
    const settings = monitorsInlineSettingsSchema.parse(link?.inlineSettings ?? { items: [] });
    const existing = new Set(settings.items.map((item) => item.monitorId));
    const missing = builtIns.filter((monitor) => !existing.has(monitor.id));
    if (missing.length === 0) return { created };
    const nextOrder = settings.items.reduce((max, item) => Math.max(max, item.sortOrder ?? 0), -1) + 1;
    const next = monitorsInlineSettingsSchema.parse({ ...settings, items: [
      ...settings.items,
      ...missing.map((monitor, i) => ({ monitorId: monitor.id, enabled: true, overrides: null, sortOrder: nextOrder + i })),
    ] });
    if (link) {
      await updateFeatureLink(link.id, { inlineSettings: next }, policy.id, undefined, tx);
    } else {
      const added = await addFeatureLink(policy.id, 'monitors', null, next, undefined, tx);
      if (!added) throw new Error('Default monitoring feature link changed concurrently');
    }
    return { created: true };
  });
}
```

In `configureDefaults.ts`, remove `STANDARD_TEMPLATE_PATTERNS` and the old `applyStandardAlertPolicy` body (76–159), remove the unused legacy schema and predicate imports, then import/re-export the helper and pass the verified bootstrap partner:

```ts
import { applyStandardAlertPolicy } from './configureDefaults.monitors';
export { applyStandardAlertPolicy } from './configureDefaults.monitors';
// In TOOL_DESCRIPTION, replace item (2):
// '(2) attach the partner\'s enabled built-in monitors to this organization\'s default monitoring policy, preserving existing thresholds and attachments,'
// In configureDefaultsHandler's existing alert_policy try/catch:
    applied.alert_policy = await applyStandardAlertPolicy(defaultOrgId, framework, partnerId);
```

Keep the existing per-step error aggregation and audit event. In `configureDefaults.test.ts`, replace the obsolete `describe('applyStandardAlertPolicy')` block (153–315) with this delegation assertion, and mock the isolated helper:

```ts
vi.mock('./configureDefaults.monitors', () => ({ applyStandardAlertPolicy: vi.fn().mockResolvedValue({ created: true }) }));
it('passes the bootstrap partner identity to the monitor attachment step', async () => {
  mockSelectQueue([[], [{ settings: {} }], []]);
  mockInsertOk(); mockUpdateOk();
  await configureDefaultsTool.handler({}, ctx);
  expect(applyStandardAlertPolicy).toHaveBeenCalledWith(ORG_ID, 'standard', PARTNER_ID);
});
```

Replace the happy-path SELECT queue with `[[], [{ settings: {} }], []]`; replace the idempotent queue with `[[{ id: 'dg-1' }], [{ settings: { riskProfile: 'standard' } }], [{ id: 'nc-1' }]]` and set `vi.mocked(applyStandardAlertPolicy).mockResolvedValueOnce({ created: false })`. Replace the partial-failure queue at 454 with `[[{ settings: {} }], []]` and keep the first-select throw. Add the helper failure case:

```ts
it('reports monitor attachment failure and still configures the other defaults', async () => {
  mockSelectQueue([[], [{ settings: {} }], []]); mockInsertOk(); mockUpdateOk();
  vi.mocked(applyStandardAlertPolicy).mockRejectedValueOnce(new Error('attachment rejected'));
  const result = await configureDefaultsTool.handler({}, ctx);
  expect(result.errors).toContainEqual({ step: 'alert_policy', error: 'attachment rejected' });
  expect(result.applied.notification_channel.created).toBe(true);
});
```

Historical importer: add these imports; remove `configPolicyAlertRules`, `alertTemplates`, and the now-unused `AlertOverrideSettings`, severity constants/type (these belonged exclusively to the deleted legacy alert mapper):

```ts
import { pathToFileURL } from 'node:url';
import { isNull } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import type { AuthContext } from '../middleware/auth';
import { createSystemAuthContext } from '../services/featureConfigResolver';
import { convertRuleToMonitor } from '../services/monitors/ruleConversionService';
```

Replace `migrateAlertRulesLive` (349–418):

```ts
export async function migrateAlertRulesLive(tx: Tx, orgId: string, auth: AuthContext): Promise<number> {
  const rules = await tx.select({ id: alertRules.id, templateId: alertRules.templateId }).from(alertRules).where(and(
    eq(alertRules.orgId, orgId), isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt),
  ));
  let converted = 0;
  const templates = new Set<string>();
  for (const rule of rules) {
    if (templates.has(rule.templateId)) continue;
    templates.add(rule.templateId);
    const result = await convertRuleToMonitor(rule.id, auth, tx);
    if (!result.ok) throw new Error(`${rule.id}: ${result.failure.kind}`);
    converted += result.data.convertedRuleIds.length;
  }
  return converted;
}
```

Change `migrate()` to `migrate(auth: AuthContext)`; `migrateOrgLive(orgId)` to `migrateOrgLive(orgId, auth: AuthContext)`; pass `auth` at the call in `migrate`. Replace the alert branch in `migrateOrgLive`:

```ts
    const convertedAlerts = await migrateAlertRulesLive(tx, orgId, auth);
    summary.alertRulesCreated += convertedAlerts;
    log(`    Alert monitors: ${convertedAlerts} converted with original target assignments`);
```

Do **not** pass `policyId` or `createAssignment` to this helper: the standalone converter creates a policy with the original rule's exact target. In the dry-run alert query at 634, add `isNull(alertRules.managedByMonitorId)` and `isNull(alertRules.retiredAt)`. Replace the alert counter block at 647–655 with:

```ts
  if (legacyAlerts.length > 0) {
    parts.push(`${legacyAlerts.length} candidate monitor conversion(s), each retaining its original target; equivalence/convertibility not checked in this historical dry-run`);
  }
```

Replace the entry point (694–703) with an import-safe guard. The existing historical warning remains; this task's commands never invoke this CLI:

```ts
async function runHistoricalMigration() {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const base = createSystemAuthContext();
    if (DRY_RUN) return migrate(base);
    return migrate(base); // system writes persist null actors through the shared converter
  }, 'historical-config-policy-migration'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHistoricalMigration()
    .then(() => { log('Migration complete.'); return closeDb(); })
    .then(() => { process.exitCode = 0; })
    .catch(async (error) => {
      console.error('Migration failed:', error);
      process.exitCode = 1;
      await closeDb();
    });
}
```

This standalone script still requires the deployment's administrative database configuration. Background conversion writes null for system actors (D7); onboarding's API key remains only in `writeAuditEvent.actorId` with `actorType: 'api_key'`.

- [ ] **Step 4: Run, expect PASS**

From the root: `cd apps/api && npx vitest run src/services/alertService.test.ts src/services/alertService.episodes.test.ts src/services/monitors/escalationLatch.test.ts src/modules/mcpInvites/tools/configureDefaults.test.ts src/modules/mcpInvites/tools/configureDefaults.monitors.test.ts src/scripts/migrateToConfigPolicies.test.ts src/services/monitors/ruleConversionService.test.ts` → all pass. `cd apps/api && npx tsc --noEmit -p .` → exit 0. Run `rg -n 'insert\(alertRules\)|insert\(configPolicyAlertRules\)|STANDARD_TEMPLATE_PATTERNS' apps/api/src/modules/mcpInvites/tools/configureDefaults.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.ts apps/api/src/scripts/migrateToConfigPolicies.ts` → no matches (exit 1, the desired result). No Docker, migration CLI or production data access is needed for these unit checks.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertService.test.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.test.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.test.ts apps/api/src/scripts/migrateToConfigPolicies.ts apps/api/src/scripts/migrateToConfigPolicies.test.ts
git commit -m "feat(alerts): publish monitor identity and route baseline writers through monitor attachments"
```

### Task 18: Final verification — live ledger RLS, conversion/revert continuity, worker registration, and all PR gates

**Files:**
- Create: `apps/api/src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts`.
- Create: `apps/api/src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts`.
- Create: `apps/api/src/__tests__/integration/monitorConversionFixtures.ts` (explicit fixture implementation shared by these two suites).
- Modify: `apps/api/src/services/workerRegistry.ts:76-85` (Task 13's actual worker registration location; the API entry point delegates to this registry).
- Modify: `apps/api/src/jobs/monitorConversionPreviewWorker.ts` (Task 13's lifecycle exports).
- Test: `apps/api/src/services/workerRegistry.test.ts` (existing), `apps/api/src/jobs/monitorConversionPreviewWorker.test.ts` (Task 13), and the explicit suites below.
- Verified fixture/reference paths: `apps/api/src/__tests__/integration/setup.ts:1-26,68-103,279-390`; `db-utils.ts:134-160,176,216,295`; `monitorDefinitionsPartnerRls.integration.test.ts:29-67,99-138`; `monitorCompiler.integration.test.ts:28-58`; `monitorResolver.integration.test.ts:29-45,145-170`; `apps/api/src/db/schema/devices.ts:421-446`; `apps/api/src/services/alertConditions/handlers/threshold.ts:8-35`.

**Interfaces:**
- Consumes every PR1–PR3 contract: actual migrations and forced-RLS tables; `previewPolicyConversion`, `convertPolicy`, `revertConversion`, `retireSource`, `resolveMonitorsForDevice`, `getApplicableRules`, both transitional sweep functions, and the published event payload.
- Produces executable verification evidence: a same-tenant positive control, cross-org/cross-partner insert denial with SQLSTATE `42501`, XOR denial with `23514`, SELECT-only partner visibility, one live ledger row per source, unchanged terminal history, migrated open alert ids, preserved cooldown TTL, exactly one firing path after conversion, and successful revert.
- Produces `initializeMonitorConversionPreviewWorker(): Promise<void>` and `shutdownMonitorConversionPreviewWorker(): Promise<void>` registered as `monitorConversionPreviewWorker` with `placement: 'socket-owner'`. No HTTP handler starts workers.

These commands are for the eventual implementation worker. **During plan completion, do not execute them, start Docker, or commit.** Every command block below starts from the repository root unless it contains its own parenthesized `cd`.

- [ ] **Step 1: Write the failing tests**

Create `monitorConversionsPartnerRls.integration.test.ts`:

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { monitorConversions, monitorConversionOutputs } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { conversionFixture, orgContext, partnerContext, SYSTEM_CONTEXT } from './monitorConversionFixtures';

async function sqlState(fn: () => Promise<unknown>, expected: string) {
  let caught: unknown;
  try { await fn(); } catch (error) { caught = error; }
  expect(caught, `expected SQLSTATE ${expected}; write unexpectedly succeeded`).toBeDefined();
  expect(pgErrorCode(caught)).toBe(expected);
}
describe('conversion ledger live RLS', () => {
  it('allows own-org writes, denies cross-org and cross-partner forges on both tables', async () => {
    const a = await conversionFixture();
    const b = await conversionFixture();
    const ledgerValues = { orgId: a.orgId, partnerId: null, sourceTable: 'config_policy_alert_rules' as const, sourceId: a.sourceId, policyId: a.policyId, previewHash: 'test' };
    const [ledger] = await withDbAccessContext(orgContext(a), () => db.insert(monitorConversions).values(ledgerValues).returning());
    expect(ledger!.orgId).toBe(a.orgId);
    const outputValues = { conversionId: ledger!.id, orgId: a.orgId, partnerId: null, monitorId: null, role: 'primary' as const, movedAlertIds: [] };
    const outputs = await withDbAccessContext(orgContext(a), () => db.insert(monitorConversionOutputs).values(outputValues).returning());
    expect(outputs).toHaveLength(1);
    for (const context of [orgContext(b), partnerContext(b)]) {
      await sqlState(() => withDbAccessContext(context, () => db.insert(monitorConversions).values({ ...ledgerValues, sourceId: b.sourceId })), '42501');
      await sqlState(() => withDbAccessContext(context, () => db.insert(monitorConversionOutputs).values(outputValues)), '42501');
      const visible = await withDbAccessContext(context, () => db.select().from(monitorConversions).where(eq(monitorConversions.id, ledger!.id)));
      expect(visible).toEqual([]);
    }
  });
  it('partner-wide visibility grants org sessions SELECT only on both ledger tables', async () => {
    const a = await conversionFixture();
    const b = await conversionFixture();
    const values = { orgId: null, partnerId: a.partnerId, sourceTable: 'automations' as const, sourceId: a.sourceId, previewHash: 'test' };
    const [ledger] = await withDbAccessContext(partnerContext(a), () => db.insert(monitorConversions).values(values).returning());
    const output = { conversionId: ledger!.id, orgId: null, partnerId: a.partnerId, role: 'response' as const, movedAlertIds: [] };
    const [savedOutput] = await withDbAccessContext(partnerContext(a), () => db.insert(monitorConversionOutputs).values(output).returning());
    await withDbAccessContext(orgContext(a), async () => {
      expect(await db.select().from(monitorConversions).where(eq(monitorConversions.id, ledger!.id))).toHaveLength(1);
      expect(await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.id, savedOutput!.id))).toHaveLength(1);
      expect(await db.update(monitorConversions).set({ previewHash: 'forged' }).where(eq(monitorConversions.id, ledger!.id)).returning()).toEqual([]);
      expect(await db.delete(monitorConversionOutputs).where(eq(monitorConversionOutputs.id, savedOutput!.id)).returning()).toEqual([]);
    });
    await sqlState(() => withDbAccessContext(orgContext(a), () => db.insert(monitorConversions).values({ ...values, sourceId: b.sourceId })), '42501');
    await sqlState(() => withDbAccessContext(orgContext(a), () => db.insert(monitorConversionOutputs).values(output)), '42501');
    await sqlState(() => withDbAccessContext(partnerContext(b), () => db.insert(monitorConversions).values({ ...values, sourceId: b.sourceId })), '42501');
    await withDbAccessContext(orgContext(b), async () => {
      expect(await db.select().from(monitorConversions).where(eq(monitorConversions.id, ledger!.id))).toEqual([]);
      expect(await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.id, savedOutput!.id))).toEqual([]);
    });
  });
  it('enforces both parent owner axes even in system scope', async () => {
    const a = await conversionFixture(); const b = await conversionFixture();
    const [partnerLedger] = await withDbAccessContext(SYSTEM_CONTEXT, () => db.insert(monitorConversions).values({
      orgId: null, partnerId: a.partnerId, sourceTable: 'automations', sourceId: a.sourceId, previewHash: 'x',
    }).returning());
    const [orgLedger] = await withDbAccessContext(SYSTEM_CONTEXT, () => db.insert(monitorConversions).values({
      orgId: a.orgId, partnerId: null, sourceTable: 'automations', sourceId: b.sourceId, previewHash: 'x',
    }).returning());
    const insert = (conversionId: string, partnerId: string) => withDbAccessContext(SYSTEM_CONTEXT, () =>
      db.insert(monitorConversionOutputs).values({ conversionId, orgId: null, partnerId, role: 'primary' }));
    await insert(partnerLedger!.id, a.partnerId); // positive control
    await sqlState(() => insert(partnerLedger!.id, b.partnerId), '23503');
    await sqlState(() => insert(orgLedger!.id, a.partnerId), '23503');
    await sqlState(() => withDbAccessContext(SYSTEM_CONTEXT, () => db.insert(monitorConversionOutputs).values({
      conversionId: partnerLedger!.id, orgId: a.orgId, partnerId: null, role: 'primary',
    })), '23503');
  });
  it('enforces XOR on conversions and outputs and cascades ledger children', async () => {
    const a = await conversionFixture();
    const values = { sourceTable: 'automations' as const, sourceId: a.sourceId, previewHash: 'test' };
    for (const axes of [{ orgId: null, partnerId: null }, { orgId: a.orgId, partnerId: a.partnerId }]) {
      await sqlState(() => withDbAccessContext(SYSTEM_CONTEXT, () => db.insert(monitorConversions).values({ ...values, ...axes })), '23514');
    }
    const [ledger] = await withDbAccessContext(orgContext(a), () => db.insert(monitorConversions).values({ ...values, orgId: a.orgId }).returning());
    for (const axes of [{ orgId: null, partnerId: null }, { orgId: a.orgId, partnerId: a.partnerId }]) {
      await sqlState(() => withDbAccessContext(SYSTEM_CONTEXT, () => db.insert(monitorConversionOutputs).values({ conversionId: ledger!.id, role: 'primary', ...axes })), '23514');
    }
    await withDbAccessContext(orgContext(a), async () => {
      await db.insert(monitorConversionOutputs).values({ conversionId: ledger!.id, orgId: a.orgId, role: 'primary' });
      await db.delete(monitorConversions).where(eq(monitorConversions.id, ledger!.id));
      expect(await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, ledger!.id))).toEqual([]);
    });
  });
});
```

Create `monitorConversionRoundtrip.integration.test.ts`:

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { alerts, alertRules, alertTemplates, automations, configPolicyAutomations, configPolicyFeatureLinks, configPolicyAlertRules, monitorDefinitions, configurationPolicies, configPolicyAssignments, monitorConversions, monitorConversionOutputs } from '../../db/schema';
import { getTestRedis } from './setup';
import { convertPolicy, previewPolicyConversion, retireSource, revertConversion, resolveDeviceIdsForPolicy, listConversionLedger } from '../../services/monitors/conversion';
import { evaluateDeviceAlerts, evaluateDeviceAlertsFromPolicy, getApplicableRules } from '../../services/alertService';
import { resolveAlertRulesForDevice, resolveAutomationAssignmentForDevice, resolveAutomationsForDeviceWithPolicy, scanScheduledAutomations } from '../../services/featureConfigResolver';
import { policyWorkflowApplies } from '../../services/monitors/conversion/workflows';
import { convertRuleToMonitor } from '../../services/monitors/ruleConversionService';
import { conversionFixture, orgContext, seedConversionDevice } from './monitorConversionFixtures';

describe('conversion round-trip under caller RLS', () => {
  it('converting a child’s last automation keeps its unconverted parent shadowed for events and schedules', async () => {
    const f = await conversionFixture();
    await withDbAccessContext(orgContext(f), async () => {
      // This fixture exercises automation election only; no unconverted parent alert rule blocks preview.
      await db.delete(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, f.sourceId));
      const [parentLink] = await db.insert(configPolicyFeatureLinks).values({ configPolicyId: f.policyId, featureType: 'automation' }).returning();
      const parentRows = await db.insert(configPolicyAutomations).values([
        { featureLinkId: parentLink!.id, name: 'Parent event', triggerType: 'event', eventType: 'alert.triggered', actions: [{ type: 'execute_command', command: 'echo triage' }] },
        { featureLinkId: parentLink!.id, name: 'Parent schedule', triggerType: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC', actions: [{ type: 'execute_command', command: 'echo triage' }] },
      ]).returning();
      const [child] = await db.insert(configurationPolicies).values({ orgId: f.orgId, partnerId: null,
        parentPolicyId: f.policyId, name: 'Site child', status: 'active', createdBy: f.userId }).returning();
      const [childLink] = await db.insert(configPolicyFeatureLinks).values({ configPolicyId: child!.id, featureType: 'automation' }).returning();
      const [source] = await db.insert(configPolicyAutomations).values({ featureLinkId: childLink!.id,
        name: 'Child event', triggerType: 'event', eventType: 'alert.triggered', actions: [{ type: 'execute_command', command: 'echo triage' }] }).returning();
      const [assignment] = await db.insert(configPolicyAssignments).values({ configPolicyId: child!.id,
        level: 'site', targetId: f.siteId, assignedBy: f.userId }).returning();
      expect((await resolveAutomationsForDeviceWithPolicy(f.deviceId))?.automations.map((a) => a.id)).toEqual([source!.id]);
      const preview = await previewPolicyConversion(child!.id, f.auth, { mode: 'inline' });
      if ('status' in preview) throw new Error('Expected inline preview');
      expect(preview.blockedBy).toBeUndefined();
      const converted = await convertPolicy(child!.id, preview.previewHash, f.auth);
      const [ledger] = await db.select().from(monitorConversions).where(eq(monitorConversions.id, converted.conversionIds[0]!));
      const [workflow] = await db.select().from(automations).where(eq(automations.id, String(ledger!.sourceState.workflowId)));
      expect((await resolveAutomationAssignmentForDevice(f.deviceId, db))?.automations.map((a) => a.id)).toEqual([source!.id]);
      expect(await resolveAutomationsForDeviceWithPolicy(f.deviceId)).toEqual({ configPolicyId: child!.id, automations: [] });
      expect(await policyWorkflowApplies(workflow!, f.deviceId, db)).toBe(true);
      const candidates = await scanScheduledAutomations();
      expect(candidates.some((row) => row.automation.id === parentRows[1]!.id)).toBe(true);
      const executable = await resolveAutomationsForDeviceWithPolicy(f.deviceId);
      expect(candidates.filter((row) => executable !== null && row.policyId === executable.configPolicyId
        && executable.automations.some((a) => a.id === row.automation.id))).toEqual([]);
      await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.id, assignment!.id));
      expect(await policyWorkflowApplies(workflow!, f.deviceId, db)).toBe(false);
      expect(new Set((await resolveAutomationsForDeviceWithPolicy(f.deviceId))!.automations.map((a) => a.id)))
        .toEqual(new Set(parentRows.map((a) => a.id)));
    });
  });
  it('ledger Undo and the response-only revert guard agree while the target conversion is live', async () => {
    const f = await conversionFixture();
    await withDbAccessContext(orgContext(f), async () => {
      const [response] = await db.insert(automations).values({ orgId: f.orgId, partnerId: null, name: 'CPU response',
        trigger: { type: 'event', eventType: 'alert.triggered', filter: { configPolicyAlertRuleId: f.sourceId } },
        actions: [{ type: 'execute_command', command: 'echo triage' }], createdBy: f.userId }).returning();
      const preview = await previewPolicyConversion(f.policyId, f.auth, { mode: 'inline' });
      if ('status' in preview) throw new Error('Expected inline preview');
      await convertPolicy(f.policyId, preview.previewHash, f.auth);
      const rows = await db.select().from(monitorConversions).where(eq(monitorConversions.policyId, f.policyId));
      const target = rows.find((r) => r.sourceId === f.sourceId)!;
      const responseLedger = rows.find((r) => r.sourceId === response!.id)!;
      expect(responseLedger.sourceState.targetConversionId).toBe(target.id);
      expect((await listConversionLedger({ policyId: f.policyId }, f.auth)).items.find((r) => r.id === responseLedger.id)?.revertable).toBe(false);
      await expect(revertConversion(responseLedger.id, f.auth)).rejects.toMatchObject({ code: 'blocked' });
      const [unchanged] = await db.select().from(monitorConversions).where(eq(monitorConversions.id, responseLedger.id));
      expect(unchanged).toEqual(responseLedger);
      await revertConversion(target.id, f.auth);
      const [restored] = await db.select().from(automations).where(eq(automations.id, response!.id));
      expect(restored!.retiredAt).toBeNull();
    });
  });
  it('moves every non-terminal alert, preserves terminal history and restores provenance on revert', async () => {
    const f = await conversionFixture();
    const redis = getTestRedis();
    const oldKey = `breeze:alerts:cooldown:cpar:${f.sourceId}:${f.deviceId}`;
    await redis.set(oldKey, '1', 'PX', 60_000);
    const statuses = ['active', 'acknowledged', 'suppressed', 'resolved', 'dismissed'] as const;
    let compiledRuleId = '';
    await withDbAccessContext(orgContext(f), async () => {
      const history = await db.insert(alerts).values(statuses.map((status) => ({
        orgId: f.orgId, deviceId: f.deviceId, configPolicyId: f.sourceId,
        ruleId: null, status, severity: 'high' as const, title: 'Existing CPU alert', context: { retained: true },
      }))).returning();
      const preview = await previewPolicyConversion(f.policyId, f.auth, { mode: 'inline' });
      if ('status' in preview) throw new Error('inline preview unexpectedly queued');
      expect(preview.blockedBy).toBeUndefined();
      expect(preview.equivalence).toEqual({ devicesChecked: 1, deltas: [] });
      const converted = await convertPolicy(f.policyId, preview.previewHash, f.auth);
      expect(converted.retired).toBe(1);
      expect(converted.monitorsCreated).toBe(1);
      const [source] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, f.sourceId));
      expect(source!.retiredReason).toBe('converted');
      expect(source!.convertedToMonitorId).toBeTruthy();
      const [output] = await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, converted.conversionIds[0]!));
      expect(new Set(output!.movedAlertIds)).toEqual(new Set(history.slice(0, 3).map((a) => a.id)));
      const rows = await db.select().from(alerts).where(eq(alerts.deviceId, f.deviceId));
      for (const original of history) {
        const after = rows.find((row) => row.id === original.id)!;
        expect(after.status).toBe(original.status);
        if (['active', 'acknowledged', 'suppressed'].includes(original.status)) {
          expect(after.configPolicyId).toBeNull();
          expect(after.monitorId).toBe(source!.convertedToMonitorId);
          expect(after.context).toMatchObject({ retained: true, convertedFrom: { sourceId: f.sourceId, sourceTable: 'config_policy_alert_rules' } });
          compiledRuleId = after.ruleId!;
        } else {
          expect(after.configPolicyId).toBe(f.sourceId);
          expect(after.ruleId).toBeNull();
          expect(after.context).toEqual({ retained: true });
        }
      }
      expect(await redis.exists(oldKey)).toBe(0);
      const newKey = `breeze:alerts:cooldown:${compiledRuleId}:${f.deviceId}`;
      expect(await redis.pttl(newKey)).toBeGreaterThan(0);
      expect(await redis.pttl(newKey)).toBeLessThanOrEqual(60_000);
      expect(await resolveAlertRulesForDevice(f.deviceId)).toEqual([]);
      expect(await getApplicableRules(f.deviceId)).toHaveLength(1);
      await revertConversion(converted.conversionIds[0]!, f.auth);
      const restored = await db.select().from(alerts).where(eq(alerts.deviceId, f.deviceId));
      for (const row of restored) {
        expect(row.ruleId).toBeNull();
        expect(row.configPolicyId).toBe(f.sourceId);
        expect(row.context).toEqual({ retained: true });
      }
      const [restoredSource] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, f.sourceId));
      expect(restoredSource!.retiredAt).toBeNull();
      expect(restoredSource!.convertedToMonitorId).toBeNull();
      expect(await resolveAlertRulesForDevice(f.deviceId)).toHaveLength(1);
      expect(await getApplicableRules(f.deviceId)).toEqual([]);
    });
    expect(await redis.exists(`breeze:alerts:cooldown:${compiledRuleId}:${f.deviceId}`)).toBe(0);
    expect(await redis.pttl(oldKey)).toBeGreaterThan(0);
    await redis.del(oldKey);
  });
  it('converts two rules of one template atomically and restores standalone alert references', async () => {
    const f = await conversionFixture();
    await withDbAccessContext(orgContext(f), async () => {
      const [template] = await db.insert(alertTemplates).values({ orgId: f.orgId, partnerId: null,
        name: 'Legacy group', conditions: { logic: 'and', conditions: [
          { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 80 },
          { type: 'threshold', metric: 'ramPercent', operator: 'gt', value: 80 },
        ] }, severity: 'high', titleTemplate: 'Legacy', messageTemplate: 'Legacy', isBuiltIn: false }).returning();
      const rules = await db.insert(alertRules).values([
        { orgId: f.orgId, partnerId: null, templateId: template!.id, name: 'Device target', targetType: 'device', targetId: f.deviceId },
        { orgId: f.orgId, partnerId: null, templateId: template!.id, name: 'Site target', targetType: 'site', targetId: f.siteId, isActive: false },
      ]).returning();
      const [history] = await db.insert(alerts).values({ orgId: f.orgId, deviceId: f.deviceId, ruleId: rules[0]!.id,
        status: 'suppressed', severity: 'high', title: 'Existing', context: { retained: 'original' } }).returning();
      const result = await convertRuleToMonitor(rules[0]!.id, f.auth, db);
      expect(result.ok).toBe(true); if (!result.ok) throw new Error('Group conversion refused');
      expect(new Set(result.data.convertedRuleIds)).toEqual(new Set(rules.map((r) => r.id)));
      const ledger = await db.select().from(monitorConversions).where(eq(monitorConversions.sourceId, template!.id));
      expect(ledger).toHaveLength(1);
      const outputs = await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, ledger[0]!.id));
      expect(new Set(outputs.map((o) => o.sourceRuleId))).toEqual(new Set(rules.map((r) => r.id)));
      expect(new Set(outputs.map((o) => o.policyId)).size).toBe(2);
      expect(outputs.flatMap((o) => o.movedAlertRefs)).toContainEqual(expect.objectContaining({ id: history!.id,
        ruleId: rules[0]!.id, configPolicyId: null, context: { retained: 'original' } }));
      const disabledOutput = outputs.find((o) => o.sourceRuleId === rules[1]!.id)!;
      const [disabled] = await db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, disabledOutput.monitorId!));
      expect(disabled!.enabled).toBe(false); expect(disabled!.kind).toBe('composite');
      await revertConversion(ledger[0]!.id, f.auth);
      const [restored] = await db.select().from(alerts).where(eq(alerts.id, history!.id));
      expect(restored).toMatchObject({ ruleId: rules[0]!.id, configPolicyId: null, status: 'suppressed', context: { retained: 'original' } });
      expect(await db.select().from(alertRules).where(eq(alertRules.templateId, template!.id))).toHaveLength(2);
    });
  });
  it('preserves post-conversion history and writes nullable system actors', async () => {
    const f = await conversionFixture();
    await withDbAccessContext(orgContext(f), async () => {
      const systemAuth = { ...f.auth, scope: 'system' as const };
      const preview = await previewPolicyConversion(f.policyId, systemAuth, { mode: 'inline' });
      if ('status' in preview) throw new Error('Expected inline preview');
      const result = await convertPolicy(f.policyId, preview.previewHash, systemAuth);
      const [output] = await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, result.conversionIds[0]!));
      const [monitor] = await db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, output!.monitorId!));
      const [ledger] = await db.select().from(monitorConversions).where(eq(monitorConversions.id, result.conversionIds[0]!));
      expect(monitor!.createdBy).toBeNull(); expect(ledger!.convertedBy).toBeNull();
      const [later] = await db.insert(alerts).values({ orgId: f.orgId, deviceId: f.deviceId, ruleId: monitor!.compiledAlertRuleId,
        monitorId: monitor!.id, status: 'resolved', severity: 'high', title: 'After conversion', context: { retained: true } }).returning();
      await revertConversion(ledger!.id, systemAuth);
      const [history] = await db.select().from(alerts).where(eq(alerts.id, later!.id));
      expect(history).toMatchObject({ status: 'resolved', configPolicyId: f.sourceId, ruleId: null, monitorId: null });
      expect(history!.context).toMatchObject({ retained: true, revertedConversionId: ledger!.id });
    });
  });
  it('reverting the creating conversion keeps a definition reused by another policy', async () => {
    const f = await conversionFixture();
    await withDbAccessContext(orgContext(f), async () => {
      const preview = await previewPolicyConversion(f.policyId, f.auth, { mode: 'inline' });
      if ('status' in preview) throw new Error('Expected inline preview');
      const first = await convertPolicy(f.policyId, preview.previewHash, f.auth);
      const [output] = await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, first.conversionIds[0]!));
      const [other] = await db.insert(monitorConversions).values({ orgId: f.orgId, sourceTable: 'automations',
        sourceId: f.deviceId, previewHash: 'later' }).returning();
      await db.insert(monitorConversionOutputs).values({ conversionId: other!.id, orgId: f.orgId, partnerId: null,
        monitorId: output!.monitorId, reusedMonitor: true, role: 'primary' });
      await revertConversion(first.conversionIds[0]!, f.auth);
      expect(await db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, output!.monitorId!))).toHaveLength(1);
      expect(await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, other!.id))).toHaveLength(1);
    });
  });
  it('fires through the monitor sweep only after conversion; a repeat sweep dedupes', async () => {
    const f = await conversionFixture();
    await withDbAccessContext(orgContext(f), async () => {
      const preview = await previewPolicyConversion(f.policyId, f.auth, { mode: 'inline' });
      if ('status' in preview) throw new Error('inline preview unexpectedly queued');
      await convertPolicy(f.policyId, preview.previewHash, f.auth);
      // Fresh device in the same assignment: no episode, alert, or cooldown exists.
      const deviceId = await seedConversionDevice(f.orgId, f.siteId);
      expect(await evaluateDeviceAlertsFromPolicy(deviceId)).toEqual([]);
      const fired = await evaluateDeviceAlerts(deviceId);
      expect(fired).toHaveLength(1);
      expect(await evaluateDeviceAlerts(deviceId)).toEqual([]);
      const [stored] = await db.select().from(alerts).where(eq(alerts.id, fired[0]!));
      expect(stored!.monitorId).toBeTruthy();
      expect(stored!.configPolicyId).toBeNull();
      const [source] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, f.sourceId));
      expect(stored!.monitorId).toBe(source!.convertedToMonitorId);
    });
  });
  it('rejects a stale preview without creating output and supports reversible operator retirement', async () => {
    const f = await conversionFixture();
    await withDbAccessContext(orgContext(f), async () => {
      const preview = await previewPolicyConversion(f.policyId, f.auth, { mode: 'inline' });
      if ('status' in preview) throw new Error('inline preview unexpectedly queued');
      await db.update(configPolicyAlertRules).set({ severity: 'critical', updatedAt: new Date() }).where(eq(configPolicyAlertRules.id, f.sourceId));
      await expect(convertPolicy(f.policyId, preview.previewHash, f.auth)).rejects.toMatchObject({ code: 'preview_stale' });
      expect(await db.select().from(monitorConversions).where(eq(monitorConversions.sourceId, f.sourceId))).toEqual([]);
      await retireSource('config_policy_alert_rules', f.sourceId, 'operator', f.auth);
      const [ledger] = await db.select().from(monitorConversions).where(and(eq(monitorConversions.sourceId, f.sourceId), isNull(monitorConversions.revertedAt)));
      expect(ledger).toBeDefined();
      expect(await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, ledger!.id))).toEqual([]);
      await revertConversion(ledger!.id, f.auth);
      const [source] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, f.sourceId));
      expect(source!.retiredAt).toBeNull();
      expect(source!.retiredReason).toBeNull();
    });
  });
  it('cannot preview, convert or retire another tenant source through a direct service call', async () => {
    const a = await conversionFixture();
    const b = await conversionFixture();
    await withDbAccessContext(orgContext(b), async () => {
      await expect(previewPolicyConversion(a.policyId, b.auth, { mode: 'inline' })).rejects.toMatchObject({ code: 'policy_not_found' });
      await expect(convertPolicy(a.policyId, 'a'.repeat(64), b.auth)).rejects.toMatchObject({ code: 'policy_not_found' });
      await expect(retireSource('config_policy_alert_rules', a.sourceId, 'operator', b.auth)).rejects.toMatchObject({ code: 'source_not_found' });
    });
  });
});
```

Worker placement follows the actual runtime import graph: Task 13's preview imports the converter/prerequisite module, which imports `automationRuntime`; its dynamic `softwareDeployment` import (`automationRuntime.ts:2330`) reaches `routes/agentWs.ts` (`softwareDeployment.ts:26`). The registry's closure contract counts dynamic imports, so use `socket-owner` and run that contract below. Do not label this graph global merely because equivalence itself does not dispatch commands.

Append a worker registration assertion in `apps/api/src/services/workerRegistry.test.ts` (its existing `WORKER_REGISTRY` import is reused):

```ts
it('registers monitor conversion preview work in the socket-owner lane', () => {
  const registrations = WORKER_REGISTRY.filter((entry) => entry.name === 'monitorConversionPreviewWorker');
  expect(registrations).toHaveLength(1);
  expect(registrations[0]!.placement).toBe('socket-owner');
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
pnpm test-stack up
(cd apps/api && npx vitest run src/services/workerRegistry.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts)
```

Expected red: `Failed to resolve import "./monitorConversionFixtures"`; if the fixture has already been added, a missing registry entry reports `expected [] to have a length of 1`. A schema/RLS/provenance failure after fixture installation is a real defect to resolve, not a reason to weaken the assertion. Stack-start/connectivity failures are environmental failures, never a passing or expected behavioral red.

- [ ] **Step 3: Implement the fixture and complete the worker lifecycle wiring**

Create `monitorConversionFixtures.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { configPolicyAlertRules, configPolicyAssignments, configPolicyFeatureLinks, configurationPolicies, devices, deviceMetrics } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

export const SYSTEM_CONTEXT: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
type Tenant = { orgId: string; partnerId: string; userId: string };
export function orgContext(f: Tenant): DbAccessContext {
  return { scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [], currentPartnerId: f.partnerId, userId: f.userId };
}
export function partnerContext(f: Tenant): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], currentPartnerId: f.partnerId, userId: f.userId };
}
// Runs under the caller's context; never silently elevates a device write.
export async function seedConversionDevice(orgId: string, siteId: string): Promise<string> {
  const [device] = await db.insert(devices).values({
    orgId, siteId, agentId: `conversion-${randomUUID()}`, hostname: `conversion-${randomUUID()}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning();
  await db.insert(deviceMetrics).values({
    orgId, deviceId: device!.id, timestamp: new Date(), cpuPercent: 95, ramPercent: 20,
    ramUsedMb: 2048, diskPercent: 20, diskUsedGb: 10,
  });
  return device!.id;
}
export async function conversionFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const tenant = { partnerId: partner.id, orgId: org.id, userId: user.id };
  const seeded = await withDbAccessContext(SYSTEM_CONTEXT, async () => {
    const deviceId = await seedConversionDevice(org.id, site.id);
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org.id, partnerId: null, name: `Conversion ${randomUUID()}`, status: 'active', createdBy: user.id,
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'alert_rule',
    }).returning();
    const [source] = await db.insert(configPolicyAlertRules).values({
      featureLinkId: link!.id, name: 'High CPU', severity: 'high', cooldownMinutes: 5, autoResolve: false,
      conditions: [{ type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 80 }],
      notificationChannelIds: null, escalationPolicyId: null,
    }).returning();
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'organization', targetId: org.id, assignedBy: user.id,
    });
    return { policyId: policy!.id, sourceId: source!.id, deviceId, siteId: site.id };
  });
  const auth: AuthContext = {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: false },
    token: null, scope: 'organization', orgId: org.id, partnerId: partner.id,
    accessibleOrgIds: [org.id], partnerOrgAccess: null,
    orgCondition: (column) => eq(column, org.id), canAccessOrg: (id) => id === org.id,
  };
  return { ...tenant, ...seeded, auth };
}
```

Any integration test that seeds a notification channel and expects delivery must also seed a matching routing row or an Everything else row; there is no channel fallback (D27). All fixture factories use real UUID rows; the RLS-negative tests run as `breeze_app` through the production context proxy. The shared integration setup truncates the tenant roots with cascade between tests. No synthetic actor is written into a users FK.

At the end of `monitorConversionPreviewWorker.ts`, add the lifecycle wrappers around Task 13's factory:

```ts
let activePreviewWorker: ReturnType<typeof createMonitorConversionPreviewWorker> | null = null;
export async function initializeMonitorConversionPreviewWorker(): Promise<void> {
  if (!activePreviewWorker) activePreviewWorker = createMonitorConversionPreviewWorker();
}
export async function shutdownMonitorConversionPreviewWorker(): Promise<void> {
  if (!activePreviewWorker) return;
  await activePreviewWorker.close();
  activePreviewWorker = null;
  await getMonitorConversionPreviewQueue().close();
}
```

Add immediately after the `alertWorkers` entry in `WORKER_REGISTRY`:

```ts
  {
    name: 'monitorConversionPreviewWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/monitorConversionPreviewWorker');
      return { init: m.initializeMonitorConversionPreviewWorker, shutdown: m.shutdownMonitorConversionPreviewWorker };
    },
  },
```

Make the queue singleton and lifecycle agree: replace Task 13's getter with the following concrete getter, using its existing `Queue` and `createInstrumentedQueue` imports. In shutdown, close this variable instead of calling the getter so stopping a worker cannot create a fresh queue.

```ts
let previewQueue: Queue | null = null;
export function getMonitorConversionPreviewQueue(): Queue {
  if (!previewQueue) previewQueue = createInstrumentedQueue(MONITOR_CONVERSION_PREVIEW_QUEUE);
  return previewQueue;
}
```

The shutdown tail replacing `await getMonitorConversionPreviewQueue().close()` is:

```ts
  if (previewQueue) {
    await previewQueue.close();
    previewQueue = null;
  }
```

In `workerRegistry.test.ts:30`, insert `'monitorConversionPreviewWorker'` immediately after `'alertWorkers'` in `EXPECTED_WORKER_NAMES`; replace the count assertion at line 91 with `expect(WORKER_REGISTRY.length).toBe(EXPECTED_WORKER_NAMES.length)`. The explicit ordered names still detect accidental additions and removals.

Keep one registry entry only; remove any duplicate initialization added while following Task 13's worker registration. This is the actual runtime entry point found during plan completion, not a second startup path.

- [ ] **Step 4: Run the complete verification pass, expect PASS**

Run the following once against the implementation, with the worktree's test stack still running. Each subshell returns to the repository root; none uses `test -- --run`.

```bash
pnpm --filter @breeze/api build
(cd packages/shared && npx vitest run src/validators/monitors.test.ts src/validators/automationActions.test.ts)
(cd apps/api && npx vitest run)
(cd apps/web && npx vitest run src/components/monitoring/monitorKindFields.test.ts src/components/monitoring/MonitorEditor src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts src/__tests__/integration/monitorResolver.integration.test.ts src/__tests__/integration/monitorWatchDelivery.integration.test.ts src/__tests__/integration/monitorCompiler.integration.test.ts src/__tests__/integration/monitorDefinitionsPartnerRls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeExecution.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
```

Expect exit 0 from every command, actual executed tests from both new integration files (no skips), and no unhandled rejections or open preview workers. In particular, the forge tests must fail at Postgres with `42501`, not at an application guard; the positive controls must succeed. The existing resolver/watch integration suites cover assignment filters and agent restart delivery. The new continuity suite drives real sweep code and real Redis, rather than asserting only SQL text.

Check migration ordering and drift with the test database explicitly selected. Do not let drift detection fall back to a developer or production database:

```bash
(cd apps/api && node --env-file=../../.env.test --import=tsx -e "const { spawnSync } = require('node:child_process'); const result = spawnSync('pnpm', ['db:check-drift'], { env: process.env, stdio: 'inherit' }); process.exit(result.status ?? 1)")
git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | grep -E '^apps/api/migrations/[0-9]{4}-[^/]+\.sql$' | sort | tail -1
scripts/check-migration-naming.sh --against-ref origin/main
git diff --check
```

Before pushing, repeat the filtered recursive command above; optional and preflight migrations are excluded. All new columns, including `reused_monitor`, `moved_alert_refs`, `source_state` and output attachment/source associations, land in Task 6's unshipped ledger migration. Never modify a shipped migration. `db:check-drift` proves migration-filename parity only; the live RLS, FK, export and cascade suites above prove the structural contracts. Classify `moved_alert_ids`, `moved_alert_refs` and `source_state` as `excludedOpen`, scalar associations as `included`, and `preview_hash` as `reviewedIncluded`.

Verify the two shared locale keys exist in every actual locale directory (the values were supplied in Task 1), and verify mutation and hash conventions through the named web checks. No new locale key is introduced by Tasks 16–18.

```bash
python3 - <<'PY'
from pathlib import Path
import json
root = Path('apps/web/src/locales')
for locale in sorted(p for p in root.iterdir() if p.is_dir()):
    content = json.loads((locale / 'monitoring.json').read_text())
    for section, key in [('kinds', 'composite'), ('fields', 'match')]:
        value = content[section][key]
        assert isinstance(value, str) and value.strip(), (locale.name, section, key)
    print(locale.name, 'OK')
PY
pnpm test-stack down
```

Coverage reconciliation: Tasks 1–5 cover shared schemas, kind registration/compiler, runtime/watch params and inheritance; Tasks 6–8 cover all ledger/retirement migrations, six schemas, export/cascade/RLS registrations and retired readers; Tasks 9–15 cover capabilities, source loading, mapping, equivalence/job, conversion/cooldowns/standalone rule service; Task 16 covers the promised routes; Task 17 covers the payload and both identified legacy writers; this task supplies both integration files promised in File Structure and the runtime worker registration. Task numbers 1–18 all exist. The cross-check changes are folded into the affected tasks; no contradictory addendum overrides them.

- [ ] **Step 5: Commit the verified PR3 gate**

```bash
git add apps/api/src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts apps/api/src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts apps/api/src/__tests__/integration/monitorConversionFixtures.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts apps/api/src/jobs/monitorConversionPreviewWorker.ts
git commit -m "test(monitors): verify conversion isolation, alert continuity, revert and worker lifecycle"
```

Record the actual command outcomes in the implementation PR. PR3 is not ready while any required integration check is skipped or failing; do not claim a green gate from unit tests alone. The plan author does not execute this commit command.

**Open questions:** None. The cross-check decisions D1–D20 settle the previously listed questions; their applicable resolutions are requirements in the tasks above.
