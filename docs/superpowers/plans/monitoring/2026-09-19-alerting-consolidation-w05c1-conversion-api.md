---
tracking_issue: (set by feature-lifecycle after registration)
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05c1 Conversion (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every legacy alert-authoring row a configuration policy owns (inline alert rules, service/process watches, `alert.triggered` automations) and every unmanaged standalone rule/template can be previewed, converted into monitor definitions attached to the same policy, and retired in place — atomically, per policy, with a ledger, an equivalence check over every device in scope, open-alert carry-over, and a revert — through routes the W05c2 panel consumes.

**Architecture:** Three API PRs. **PR1** widens the monitor model so conversion has somewhere to land: a `composite` kind (server-evaluated children only, compiles to an `{logic}` group), `restart_service` parameters on `execute_command`, `consecutiveFailures` 1..100, and an `inheritance: cumulative | replace` setting on the `monitors` feature link honoured by `resolveMonitorsForDevice`. **PR2** adds the retirement columns to the six legacy tables and the two org-XOR-partner ledger tables with RLS, then puts `retired_at IS NULL` in every evaluator, resolver, agent-config builder and list. **PR3** is the converter (`services/monitors/conversion/`): pure mappers from the spec's table, a dry-run equivalence check (`resolveEffectiveConfig` before vs `resolveMonitorsForDevice` inside a rolled-back transaction after, job-backed above 500 devices), the transactional convert/revert/retire with ledger and open-alert carry-over, the `/monitor-definitions/conversion/*` routes, the `alert.triggered` payload fields, and the onboarding writer moved from baseline `alert_rules` to built-in monitor attachments. The converter refuses to run until the three prerequisite fixes are provably present.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (dual-axis RLS, deferrable composite FK), zod in `packages/shared`, BullMQ + Redis (equivalence job, cooldown re-key), Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`).

**Spec:** docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md (§Prerequisite defects, §Data model "Monitors" + "Retirement columns", §Conversion incl. Inheritance correction / Equivalence check / Open alerts / Other writers, §Evaluation transitional, §Tenancy and safety, §Waves W05c API half)

## Ordering assumptions (read first)

- **W05a and W05b have merged.** W05a froze creation on the legacy tabs (so the set of rows to convert is stable per policy) and W05b's `resolveDelivery` exists; this plan does not touch delivery resolution. Nothing here imports W05b symbols, so the two are only sequenced, not coupled.
- **#6342, #6343 and #6344 have merged as independent PRs.** This plan builds ON them and never re-implements them:
  - **#6343** (`normalizeActions` keeps `kind` on `execute_command`; the watch builder reads it). Task 4 adds `maxAttempts` / `cooldownSeconds` on top. Verify before Task 4: `grep -n "kind" apps/api/src/services/automationRuntime.ts | sed -n '/execute_command/,/continue/p'` must show `kind` being preserved. If it does not, #6343 is not merged — stop and say so.
  - **#6344** (`resolveMonitorsForDevice` applies assignment `roleFilter` / `osFilter`). Task 5 adds the `inheritance` walk on top. Verify before Task 5: `grep -n "buildRoleOsFilterConditions\|matchesRoleOsFilter" apps/api/src/services/monitors/monitorResolver.ts` must match. If it does not, stop.
  - **#6342** (`offlineAlertEffects` resolves monitors for the device). Task 9 verifies it by grep and exports the capability constant next to it. Verify before Task 9: `grep -n "resolveMonitorsForDevice" apps/api/src/services/offlineAlertEffects.ts` must match.
- The line numbers cited below were verified on `main @ b8dd148bd8` (before W05a/W05b and the three fixes). After those merge the numbers drift by a few lines; every task names the symbol as well as the line, and the `grep` in each task is the authority.
- PR1 (Tasks 1–5) → PR2 (Tasks 6–8) → PR3 (Tasks 9–16). Each PR is independently green and mergeable; PR2 depends on PR1 only for the `composite` enum value in the drift check; PR3 depends on both.
- **W05c2** (web + tools) consumes the routes and types produced here by exact name. **W05d** consumes `convertPartnerLegacy` and `retireSource`. **W05e** adds a `'network_monitors'` case to `retireSource` / `revertConversion` / `convertPartnerLegacy` and reads `monitor_conversions` — its plan is already written against the names below; do not rename.

## Global Constraints

- **Migration names.** Three files, in this sort order: `2026-10-23-103000-monitor-kind-composite.sql` (PR1 — enum value only; the brief assigned two names and the `monitor_kind` enum needs a third file that lands before the ledger), `2026-10-23-110000-monitor-conversions.sql` (PR2 — ledger tables + RLS), `2026-10-23-120000-legacy-source-retirement-columns.sql` (PR2). Before pushing each PR: `git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1` must sort **before** the new file (newest at planning time: `2026-10-21-100200-billing-profiles-permissions.sql`; W05b adds `2026-10-23-100000-delivery-routing-default-rows.sql`). Rename (bump `HHMMSS`) if anything newer landed. Never name a file for today's real date — shipped names run ahead of the calendar (CLAUDE.md §Schema Migration Workflow).
- Migrations are idempotent (`IF NOT EXISTS`, `DO $$ … $$`, `DROP POLICY IF EXISTS` + `CREATE`), contain **no inner `BEGIN`/`COMMIT`**, and the two PR2 files contain **no DML** — so `migrationRlsScope.test.ts` needs no `set_config('breeze.scope','system',true)` and its frozen baseline is untouched. If a later edit adds an `UPDATE`/`INSERT`, the elevation line goes first.
- **Tenancy (CLAUDE.md §Tenant Isolation / RLS, §Partner-Wide First).** `monitor_conversions` and `monitor_conversion_outputs` are dual-axis config-shaped tables: `org_id` XOR `partner_id` (`<table>_one_owner_chk`), one dual-axis `FOR ALL` policy, a **separate, additive `FOR SELECT`** partner-wide branch keyed on `public.breeze_current_partner_id()` (template: `apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`; precedent in the same shape: `2026-10-16-160300-monitor-definitions.sql`), RLS enabled + forced, `GRANT … TO breeze_app`. The outputs table denormalises the owner axes and carries the composite FK `(conversion_id, org_id) → monitor_conversions(id, org_id)` **`DEFERRABLE INITIALLY IMMEDIATE`** (org merge contract, `orgLifecycleFoundations.integration.test.ts`).
- **Registration lists (same PR as the migration — the step that gets missed, caught 0/5 by review and 5/5 by the contract tests):** `CORE_ORG_CASCADE_DELETE_ORDER` in `apps/api/src/services/tenantCascade.ts` (both tables, alphabetical by `localeCompare`: `monitor_conversion_outputs` < `monitor_conversions` < `monitor_definitions`, which is also child-before-parent); `CORE_TENANT_EXPORT_POLICY` in `apps/api/src/services/tenantExportPolicyRegistry.ts` (both tables; `moved_alert_ids` is `excludedOpen`; `preview_hash` matches the `hash` suspicious-name part and is `reviewedIncluded`); `DUAL_AXIS_TENANT_TABLES` **and** `XOR_OWNERSHIP_DUAL_AXIS_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (both tables). New columns on the three org-cascade legacy tables (`alert_rules`, `alert_templates`, `automations`) must be classified in `CORE_TENANT_EXPORT_POLICY` (`included` — scalars and a uuid). `config_policy_alert_rules`, `config_policy_monitoring_watches`, `config_policy_automations` carry no `org_id` (tenant reached through `configuration_policies`, `PARENT_FK_JOIN_POLICY_TABLES` lines 856–861) and need no export entry. Neither ledger table has `device_id`, so the device-side lists do not apply. No new FK lacks an explicit `ON DELETE`, so `orgCascadeFkOnDeleteAllowlist.ts` gains nothing.
- **Partner-axis writers.** `partner-wide-write-coverage.test.ts` is textual: every file under `services/**` or `routes/**` that mutates a `partner_id`-bearing table must mention `canManagePartnerWidePolicies`. The conversion module's writer (`conversion/convert.ts`) calls it directly for partner-wide policies, so no allowlist entry; the ledger schema file is not a writer. `site-ceiling-write-coverage.test.ts`: the converter writes `configuration_policies` / `config_policy_feature_links` through `configurationPolicy.ts` (already exempt) and the routes gate with `canMutateOrgWideGovernance` (Task 14) — no allowlist entry.
- **DB context.** The panel path runs under the request's `withDbAccessContext` (auth middleware); the equivalence job and the partner sweep run under `withDbAccessContext(<snapshot of the caller's DbAccessContext>)` inside the worker — never a bare pool, never `withSystemDbAccessContext` on the request path (#1105, #2417). Monitors are created only through `createMonitorDefinition` (which compiles in its own transaction) or `compileMonitorInTx`.
- **Every code step has real code; red first.** Each task: write the failing test, run it and read the failure, implement, run green, typecheck (`cd apps/api && npx tsc --noEmit -p .` or `pnpm --filter @breeze/api exec tsc --noEmit`), commit. Never `pnpm --filter X test -- --run` (the `--` breaks vitest). Scoped runs: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`. Integration suites: `pnpm test-stack up` once, then `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`; `pnpm test-stack down` when finished.
- **Do not commit from a plan-execution subagent unless the task says so; the orchestrator owns branches.** Commit messages follow `<type>(<scope>): …`.
- **No web changes in this wave** (W05c2). The shared `MONITOR_KINDS` change is visible to `apps/web`; Task 1 runs the web kind-parity tests so the shared package change cannot redden Test Web after merge.

## File Structure (what changes where)

| File | Change |
|---|---|
| `packages/shared/src/validators/monitors.ts` | Modify: `MONITOR_KINDS` += `'composite'`; `SERVER_EVALUATED_MONITOR_KINDS`; `compositeConditionSchema` (`match`, 2..10 `children` of server-evaluated kinds, child conditions cross-validated); `consecutiveFailures` max 100 on `service`/`process`/`network_check`; `monitorsInlineSettingsSchema.inheritance` |
| `packages/shared/src/validators/monitors.test.ts` | Modify/create: composite + range + inheritance cases |
| `packages/shared/src/validators/automationActions.ts` | Modify: `execute_command` gains `maxAttempts` (0..50) and `cooldownSeconds` (30..86400), both optional |
| `apps/api/migrations/2026-10-23-103000-monitor-kind-composite.sql` | Create: `ALTER TYPE monitor_kind ADD VALUE 'composite'` (guarded) |
| `apps/api/src/db/schema/monitorDefinitions.ts` | Modify: `monitorKindEnum` += `'composite'` |
| `apps/api/src/services/monitors/kinds/types.ts` | Modify: `toAlertCondition` returns `RootCondition` |
| `apps/api/src/services/monitors/kinds/composite.ts` | Create: kind spec, `overridableKeys: []`, `{logic, conditions}` compile |
| `apps/api/src/services/monitors/kinds/index.ts` / `index.test.ts` | Modify: register `composite`; test iterates `.type` only for leaf kinds |
| `apps/api/src/services/monitors/monitorCompiler.ts` | Modify: `buildCompiledCondition` returns `RootCondition` (no behaviour change) |
| `apps/api/src/services/automationRuntime.ts` | Modify: `ExecuteCommandAction` + `normalizeActions` carry `maxAttempts` / `cooldownSeconds` |
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
| `apps/api/src/services/featureConfigResolver.ts` | Modify: `retired_at IS NULL` in `resolveAlertRulesForDevice`, `resolveGoverningAlertRulePolicyForDevice`, `resolveAutomationsForDeviceWithPolicy`, `scanScheduledAutomations` |
| `apps/api/src/services/alertService.ts` | Modify: `getApplicableRules` filters retired rules; `alert.triggered` payload gains `monitorId`, `kind`; `CreateAlertParams.kind` |
| `apps/api/src/services/offlineAlertEffects.ts` | Modify: retired filter on the rule read; exports `OFFLINE_EFFECTS_RESOLVE_MONITORS` |
| `apps/api/src/jobs/automationWorker.ts` | Modify: retired filter in `processTriggerEvent` and the event fan-out |
| `apps/api/src/routes/alerts/rules.ts`, `routes/alertTemplates/helpers.ts`, `routes/automations.ts` | Modify: lists exclude retired rows (`?includeRetired=true` opt-in on rules) |
| `apps/api/src/services/alertCooldown.ts` | Modify: `rekeyConfigPolicyCooldowns(sourceRuleId, compiledRuleId)` |
| `apps/api/src/services/monitors/conversion/types.ts` | Create: the cross-wave contract types |
| `apps/api/src/services/monitors/conversion/prerequisites.ts` | Create: capability check over the three fixes |
| `apps/api/src/services/monitors/conversion/mapping.ts` | Create: pure source → monitor mappers, action fingerprint, signature + preview hash |
| `apps/api/src/services/monitors/conversion/loadSources.ts` | Create: unretired sources of a policy, open-alert counts |
| `apps/api/src/services/monitors/conversion/equivalence.ts` | Create: device scope, before/after signatures, dry-run resolver |
| `apps/api/src/services/monitors/conversion/convert.ts` | Create: `previewPolicyConversion`, `convertPolicy`, `convertPartnerLegacy`, `revertConversion`, `retireSource`, `countPendingConversions` |
| `apps/api/src/services/monitors/conversion/index.ts` | Create: re-exports (the module surface W05c2/W05d/W05e import) |
| `apps/api/src/jobs/monitorConversionPreviewWorker.ts` | Create: BullMQ queue + worker for the >500-device equivalence check |
| `apps/api/src/services/monitors/ruleConversionService.ts` | Modify: retire the rule (`retired_at`, `converted_to_monitor_id`) and write a ledger row |
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
- Test: `packages/shared/src/validators/monitors.test.ts` (create if absent; the file exists as `monitors.test.ts` only if a prior wave added it — `ls packages/shared/src/validators/monitors*.test.ts`)
- Modify (web guard, so Test Web stays green — `apps/web/src/components/monitoring/monitorKindFields.test.ts` iterates `MONITOR_KINDS` and requires a field-map entry, schema-shaped keys and a valid default for EVERY kind): `apps/web/src/components/monitoring/monitorKindFields.ts` (map at line 48 ff., `defaultConditionFor` at 247), `apps/web/src/components/monitoring/MonitorEditor.tsx:691` (hide `composite` from the kind picker until W05c2 builds its editor), `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json` (`kinds.composite`, `fields.match`)

**Interfaces:**
- Produces (shared): `MONITOR_KINDS` (+ `'composite'`), `SERVER_EVALUATED_MONITOR_KINDS: readonly MonitorKind[]`, `ServerEvaluatedMonitorKind`, `compositeConditionSchema`, `CompositeCondition`, `monitorsInheritanceSchema`, `MonitorsInheritance = 'cumulative' | 'replace'`, `monitorsInlineSettingsSchema` (+ `inheritance`, default `'cumulative'`), `execute_command` action with `maxAttempts?: number`, `cooldownSeconds?: number`.
- Consumed by: Task 2 (kind spec), Task 4 (runtime + watch builder), Task 5 (resolver), Task 10 (mappers), W05c2 editor.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/validators/monitors.test.ts` (append to the existing file or create it):

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
  // it; the children editor ships in W05c2. Until then only `match` renders and
  // the kind is hidden from the picker (MonitorEditor.tsx).
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

`apps/web/src/components/monitoring/MonitorEditor.tsx:691` — `{MONITOR_KINDS.filter((kind) => kind !== 'composite').map((kind) => (` with the comment `/* W05c2 adds the composite children editor; until then the kind is API-only */`.

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

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/monitors/kinds/ src/services/monitors/monitorCompiler.test.ts src/routes/monitorDefinitions.test.ts` and `cd apps/api && npx tsc --noEmit -p .` (the Task 1 registry error is gone). `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`. With a DB: `pnpm db:migrate && pnpm db:check-drift`.

- [ ] **Step 5: Commit**

`git add apps/api/migrations/2026-10-23-103000-monitor-kind-composite.sql apps/api/src/db/schema/monitorDefinitions.ts apps/api/src/services/monitors/kinds/ apps/api/src/services/monitors/monitorCompiler.ts && git commit -m "feat(monitors): composite kind — server-evaluated children compiled to an and/or group"`

### Task 3: `restart_service` parameters survive `normalizeActions` and drive the delivered watch (on top of #6343)

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts:330-336` (`ExecuteCommandAction`), `:671-684` (the `execute_command` arm of `normalizeActions` — after #6343 it already preserves `kind`; add the two numbers)
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

`normalizeActions`, `execute_command` arm — keep #6343's `kind` line and add, before `normalized.push`:

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
- `automationRuntime.ts` `normalizeActions` `execute_command` arm: `if (!command && action.kind !== 'restart_service') throw …requires command`; push `command: command ?? ''`.
- `executeCommandAction` (`:1598`): first statement —

```ts
  if (action.kind === 'restart_service' && action.command.trim() === '') {
    // The agent performs the restart locally (auto_restart on the delivered
    // watch, routes/agents/helpers.ts). Nothing to dispatch; record why.
    return {
      outcome: 'success',
      log: logEntry('restart_service handled by the agent watch; no server-side command', 'info', { actionIndex }),
    };
  }
```

  (`ActionExecutionOutcome` — check the union at `:1368` and use its success member's literal; `logEntry` is the helper used at `:1634`.)
- Tests: in `automationRuntime.test.ts` — `normalizeAutomationActions([{ type: 'execute_command', kind: 'restart_service' }])` yields `{ type: 'execute_command', kind: 'restart_service', command: '' }` and `normalizeAutomationActions([{ type: 'execute_command' }])` still throws `/requires command/`; in a new `automationRuntime.restartService.test.ts` (harness copied from `automationRuntime.runScript.test.ts`) — `executeCommandAction({ type: 'execute_command', kind: 'restart_service', command: '' }, 0, ctx)` resolves `outcome: 'success'` and `dispatchScriptToDevice` is NOT called; with `command: 'Restart-Service Spooler'` it IS called (hand-authored monitors keep today's behaviour). Shared: `automationActionSchema.safeParse({ type: 'execute_command', kind: 'restart_service' }).success === true`, `{ type: 'execute_command' }` false.
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

(If `configurationPolicy.ts`'s import graph makes a bare `../db` mock insufficient — the file imports many services — copy the mock preamble from `apps/api/src/routes/configurationPolicies/featureLinks.monitors.test.ts` instead and drive the route; the assertions stay the same. The queue order above is: links read, attachment rows, link JSON read.)

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
- Test: `apps/api/src/services/monitors/monitorResolver.test.ts` (pure cases next to `pickWinner`), `apps/api/src/__tests__/integration/monitorResolver.integration.test.ts` (one real-DB case, run in Task 16)

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

`cd apps/api && npx vitest run src/services/monitors/monitorResolver.test.ts src/services/alertService src/routes/agents/helpers.monitorWatchDelivery.test.ts` (the resolver is mocked in most callers; the substring run confirms no caller broke on the new export). `npx tsc --noEmit -p .`. Add the integration case now (it runs under Task 16): in `apps/api/src/__tests__/integration/monitorResolver.integration.test.ts` add a test that creates partner policy (cumulative, built-in attached), org policy (`inheritance: 'replace'`, monitor A attached, parent policy with monitor P attached) and site policy (`replace`, monitor B), assigns all three to one device, and asserts `resolveMonitorsForDevice` returns exactly `{builtin, B}` — never A or P.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/monitors/monitorResolver.ts apps/api/src/services/monitors/monitorResolver.test.ts apps/api/src/__tests__/integration/monitorResolver.integration.test.ts && git commit -m "feat(monitors): resolver honours monitors-link inheritance=replace; capability constant for the converter"`

**PR1 gate:** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors src/services/automationRuntime src/routes/agents/helpers.monitorWatchDelivery.test.ts src/routes/monitorDefinitions src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`; `cd packages/shared && npx vitest run`; `cd apps/web && npx vitest run src/components/monitoring src/locales`. Open PR1 (`Refs #<wave>`).

## PR2 — retirement columns, ledger, RLS, readers (Tasks 6–8)

### Task 6: Ledger tables `monitor_conversions` / `monitor_conversion_outputs` — migration, Drizzle schema, every registration list

**Files:**
- Create: `apps/api/migrations/2026-10-23-110000-monitor-conversions.sql`
- Create: `apps/api/src/db/schema/monitorConversions.ts`
- Modify: `apps/api/src/db/schema/index.ts:165-166` (add `export * from './monitorConversions';`)
- Modify: `apps/api/src/services/tenantCascade.ts:558-569` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:387` (two entries before `monitor_definitions`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:349-365` (`DUAL_AXIS_TENANT_TABLES`), `:686-691` (`XOR_OWNERSHIP_DUAL_AXIS_TABLES`)
- Test: `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts` (existing, auto-discover); the live contract suites run in Task 16 — but the red-first step here is the cascade **unit** guard: `apps/api/src/services/tenantCascade.test.ts` if it pins membership statically, else the integration suite.

**Interfaces:**
- Produces: tables (below); Drizzle `monitorConversions`, `monitorConversionOutputs`, types `MonitorConversionRow`, `MonitorConversionOutputRow`, `MONITOR_CONVERSION_SOURCE_TABLES`, `MONITOR_CONVERSION_OUTPUT_ROLES`.
- Consumed by: Tasks 11–14, W05d, W05e (`'network_monitors'` is already a legal `source_table`).

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
  // monitorConversionsPartnerRls.integration.test.ts (Task 16).
  'monitor_conversions',
  'monitor_conversion_outputs',
```

and to `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (after `'monitor_definitions'`):

```ts
  // monitor_conversions_one_owner_chk / monitor_conversion_outputs_one_owner_chk,
  // 2026-10-21-110000 (W05c1). Partner-wide SELECT branch ships in the same file.
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
  "monitor_conversion_outputs": tablePolicy("org_id", {"included":["id","conversion_id","org_id","partner_id","monitor_id","role","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["moved_alert_ids"]}),
  "monitor_conversions": tablePolicy("org_id", {"included":["id","org_id","partner_id","source_table","source_id","policy_id","converted_by","converted_at","reverted_at","created_at"],"reviewedIncluded":["preview_hash"],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/tenantCascade.test.ts src/services/tenantExportPolicyRegistry` (static unit checks, if present: "unknown table monitor_conversions" / schema-name mismatch). With `pnpm test-stack up`: `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts` → "relation monitor_conversions does not exist" / "table listed in CORE_ORG_CASCADE_DELETE_ORDER does not exist".

- [ ] **Step 3: Implement**

`apps/api/migrations/2026-10-23-110000-monitor-conversions.sql`:

```sql
-- Alerting consolidation W05c1 (spec §Conversion, §Tenancy and safety):
-- the conversion ledger. One `monitor_conversions` row per converted legacy
-- source row (idempotent on (source_table, source_id) while un-reverted); one
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
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { configurationPolicies } from './configurationPolicies';
import { monitorDefinitions } from './monitorDefinitions';

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
    // (conversion_id, org_id) DEFERRABLE INITIALLY IMMEDIATE lives in the
    // migration only — drift detection compares columns, not FK declarations.
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    monitorId: uuid('monitor_id').references(() => monitorDefinitions.id, { onDelete: 'set null' }),
    role: text('role').$type<MonitorConversionOutputRole>().notNull(),
    movedAlertIds: jsonb('moved_alert_ids').notNull().default([]).$type<string[]>(),
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

**Interfaces:**
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

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts && npx tsc --noEmit -p .`; with the stack: `pnpm db:migrate && pnpm db:check-drift && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts`.

- [ ] **Step 5: Commit**

`git add apps/api/migrations/2026-10-23-120000-legacy-source-retirement-columns.sql apps/api/src/db/schema/alerts.ts apps/api/src/db/schema/automations.ts apps/api/src/db/schema/configurationPolicies.ts apps/api/src/services/tenantExportPolicyRegistry.ts && git commit -m "feat(alerts): retirement columns on the six legacy alert-authoring tables"`

### Task 8: `retired_at IS NULL` in every evaluator, resolver, agent builder and list; re-save never resurrects or deletes retired rows

**Files:**
- Modify: `apps/api/src/services/featureConfigResolver.ts:345-360` (`resolveGoverningAlertRulePolicyForDevice` rules join), `:419-422` (`resolveAlertRulesForDevice`), `:499-502` (`resolveAutomationsForDeviceWithPolicy`), `:1408-1440` (`scanScheduledAutomations`)
- Modify: `apps/api/src/services/alertService.ts:893-902` (`getApplicableRules`)
- Modify: `apps/api/src/services/offlineAlertEffects.ts:29-36` (rule read), `:64-66` (`prepareRule` existence check)
- Modify: `apps/api/src/routes/agents/helpers.ts:2339-2346` (policy watches)
- Modify: `apps/api/src/jobs/automationWorker.ts:495-499` (`processTriggerEvent`), `:1171-1174` (event fan-out candidates), `:1228-1231` (policy automations loop)
- Modify: `apps/api/src/routes/alerts/rules.ts:173-179` (+ query schema in `routes/alerts/schemas.ts`), `apps/api/src/routes/alertTemplates/helpers.ts:45-59` (`getAllTemplates`), `apps/api/src/routes/automations.ts:677-700` (list conditions)
- Modify: `apps/api/src/services/configurationPolicy.ts:907-912` (`decompose` `monitoring` → upsert settings), `:1192-1233` (`deleteNormalizedRows`), `:1271-1276`, `:1296-1300`, `:1437-1441` (`assembleInlineSettings`)
- Test: `apps/api/src/services/retiredSourceReaders.contract.test.ts` (create — static, no DB), `apps/api/src/services/configurationPolicy.retiredRows.test.ts` (create — Drizzle mock on the delete/upsert statements); behavioural proof in Task 16's round-trip

**Interfaces:**
- Produces: `GET /alerts/rules?includeRetired=true` (default excludes); every other list excludes retired rows unconditionally. `config_policy_monitoring_settings` is now upserted on `feature_link_id` instead of deleted and re-inserted, so a settings row id is stable across saves (the watches' `settings_id` FK survives).

Why the decompose change is load-bearing: `updateFeatureLink` runs `deleteNormalizedRows` then `decomposeInlineSettings` (configurationPolicy.ts:1188-1233). Today `alert_rule` deletes ALL rows for the link and `monitoring` deletes the settings row, which cascades to every watch. After Task 7 that would silently destroy the retired rows (and their `converted_to_monitor_id`) the first time a tech re-saves the frozen legacy tab — and, because `assembleInlineSettings` would have hidden them, the re-insert would not bring them back. Retired rows must be invisible to assemble AND immune to the delete.

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
    ['services/featureConfigResolver.ts', 'export async function resolveAutomationsForDeviceWithPolicy', 'configPolicyAutomations.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function scanScheduledAutomations', 'configPolicyAutomations.retiredAt'],
    ['services/alertService.ts', 'export async function getApplicableRules', 'alertRules.retiredAt'],
    ['services/offlineAlertEffects.ts', 'export async function expandOfflineAlertPlan', 'alertRules.retiredAt'],
    ['routes/agents/helpers.ts', 'async function resolvePolicyMonitoringSettings', 'configPolicyMonitoringWatches.retiredAt'],
    ['jobs/automationWorker.ts', 'async function processTriggerEvent', 'automations.retiredAt'],
    ['jobs/automationWorker.ts', 'export async function handleAutomationEvent', 'automations.retiredAt'],
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

`apps/api/src/services/configurationPolicy.retiredRows.test.ts` — assert the SQL shape of the three writes (use the same `vi.mock('../db')` capture harness as `configurationPolicy.monitorsInheritance.test.ts` from Task 4, recording `delete().where(cond)` / `insert().values().onConflictDoUpdate(...)` calls):

```ts
  it('deleteNormalizedRows(alert_rule) deletes only unretired rows', async () => {
    await updateFeatureLink('link-1', { inlineSettings: { items: [] } }, 'p1');
    const deleteWhere = dbMock.delete.mock.calls /* find the configPolicyAlertRules delete */;
    expect(JSON.stringify(deleteWhere)).toMatch(/retired_at.*is null/i);
  });
  it('decompose(monitoring) upserts the settings row on feature_link_id instead of delete+insert', async () => {
    await updateFeatureLink('link-2', { inlineSettings: { checkIntervalSeconds: 30, watches: [] } }, 'p1');
    expect(dbMock.insert.mock.results.some((r) => r.value.onConflictDoUpdate.mock.calls.length > 0)).toBe(true);
    expect(dbMock.delete /* configPolicyMonitoringSettings */).not.toHaveBeenCalledWith(expect.objectContaining({ table: 'config_policy_monitoring_settings' }));
  });
```

(Shape the harness after `apps/api/src/routes/configurationPolicies/featureLinks.monitors.test.ts`, which already drives `updateFeatureLink` through a Drizzle mock; the assertions above are what must hold, the capture plumbing follows that file.)

- [ ] **Step 2: Run it, expect FAIL**

`cd apps/api && npx vitest run src/services/retiredSourceReaders.contract.test.ts src/services/configurationPolicy.retiredRows.test.ts` → every `references` case fails ("expected … to contain 'configPolicyAlertRules.retiredAt'").

- [ ] **Step 3: Implement**

Evaluators / resolvers (add `isNull` to the drizzle imports where missing):

- `featureConfigResolver.ts:419-422`: `.innerJoin(configPolicyAlertRules, and(eq(configPolicyAlertRules.featureLinkId, configPolicyEffectiveFeatureLinks.id), isNull(configPolicyAlertRules.retiredAt)))`; `:348-351` same join shape; `:499-502`: `and(eq(configPolicyAutomations.featureLinkId, …), isNull(configPolicyAutomations.retiredAt))`; `:1417-1421` (`scanScheduledAutomations` join) same.
- `alertService.ts:896-902`: `and(ownershipCondition, eq(alertRules.isActive, true), isNull(alertRules.retiredAt), or(...targetConditions))`.
- `offlineAlertEffects.ts:31`: `.where(and(ownership, eq(alertRules.isActive, true), isNull(alertRules.retiredAt), or(…)))`; `:65`: `.where(and(eq(table.id, rule.ruleId), isNull(table.retiredAt)))` (both tables now carry the column).
- `routes/agents/helpers.ts:2342-2345`: add `isNull(configPolicyMonitoringWatches.retiredAt)` to the `and(...)`.
- `automationWorker.ts:498`: `and(eq(automations.id, data.automationId), eq(automations.enabled, true), isNull(automations.retiredAt))`; `:1174`: `and(ownershipCondition, eq(automations.enabled, true), isNull(automations.retiredAt))`; `:1229`: `if (!cpAutomation.enabled || cpAutomation.retiredAt) continue;`.

Lists:

- `routes/alerts/schemas.ts` list query: `includeRetired: z.enum(['true', 'false']).optional()`; `routes/alerts/rules.ts:177` after the enabled filter: `if (query.includeRetired !== 'true') conditions.push(isNull(alertRules.retiredAt));`.
- `routes/alertTemplates/helpers.ts:49-57`: wrap the `or(...)` in `and(isNull(alertTemplates.retiredAt), or(...))`. `getTemplateById` stays unfiltered (history reads by id).
- `routes/automations.ts:677`: `const conditions: SQL<unknown>[] = [isNull(automations.retiredAt)];`.

`configurationPolicy.ts`:

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

`removeFeatureLink` (1888) deletes the link row, which cascades to children including retired rows — that is a deliberate whole-feature removal by the tech and is left as is; the ledger's `source_id` then dangles by design (no FK), and `revertConversion` (Task 13) reports `source_missing`.

- [ ] **Step 4: Run, expect PASS**

`cd apps/api && npx vitest run src/services/retiredSourceReaders.contract.test.ts src/services/configurationPolicy.retiredRows.test.ts src/services/featureConfigResolver src/services/alertService src/services/offlineAlertEffects src/jobs/automationWorker src/routes/alerts/rules src/routes/alertTemplates src/routes/automations src/routes/agents/helpers src/routes/configurationPolicies` (existing Drizzle-mock suites must stay green — a mock queue that now sees one extra predicate in an `and()` does not change call counts). `npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/featureConfigResolver.ts apps/api/src/services/alertService.ts apps/api/src/services/offlineAlertEffects.ts apps/api/src/routes/agents/helpers.ts apps/api/src/jobs/automationWorker.ts apps/api/src/routes/alerts/rules.ts apps/api/src/routes/alerts/schemas.ts apps/api/src/routes/alertTemplates/helpers.ts apps/api/src/routes/automations.ts apps/api/src/services/configurationPolicy.ts apps/api/src/services/retiredSourceReaders.contract.test.ts apps/api/src/services/configurationPolicy.retiredRows.test.ts && git commit -m "feat(alerts): retired legacy rows are invisible to every evaluator, resolver, agent builder and list; re-save preserves them"`

**PR2 gate:** unit: `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/db src/services/tenantCascade src/services/retiredSourceReaders.contract.test.ts src/services/configurationPolicy`; live (`pnpm test-stack up`): `pnpm db:migrate && pnpm db:check-drift && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/monitorWatchDelivery.integration.test.ts`. Open PR2 (`Refs #<wave>`).

## PR3 — converter, preview, routes, payload, onboarding (Tasks 9–16)

### Task 9: Conversion module contract types and the prerequisite capability check

**Files:**
- Create: `apps/api/src/services/monitors/conversion/types.ts`
- Create: `apps/api/src/services/monitors/conversion/prerequisites.ts`
- Modify: `apps/api/src/services/offlineAlertEffects.ts` (export `OFFLINE_EFFECTS_RESOLVE_MONITORS` next to the #6342 code)
- Create: `apps/api/src/services/monitors/conversion/index.ts` (re-exports; grows in Tasks 12–13)
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
export function missingConversionPrerequisites(): string[]; // labels, [] when all present
export class ConversionPrerequisiteMissingError extends Error { readonly missing: string[] }
export function assertConversionPrerequisites(): void; // throws the error above
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

`types.ts` as in the Interfaces block. `index.ts`: `export * from './types'; export * from './prerequisites';` (Tasks 12–13 add the rest).

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
export function monitorSignature(m: Pick<ProposedMonitor, 'kind'|'condition'|'severity'|'cooldownMinutes'|'autoResolve'|'deliveryMode'|'deliveryChannelIds'|'escalationPolicyId'|'responses'>): string; // sha256 of canonical JSON — reuse rule + equivalence key
export function previewHash(input: { policyId: string; items: ConversionPreviewItem[]; inheritanceMode: string }): string;
export const UNCONVERTIBLE = { metricWithoutKind: 'metric_without_kind', custom: 'custom_condition', nestedGroup: 'nested_group', childNotComposable: 'child_kind_not_composable', tooManyConditions: 'too_many_conditions', noCondition: 'no_condition', autoResolveConditions: 'auto_resolve_conditions', escalationPolicyAxis: 'escalation_policy_axis', alertWorkflowKept: 'alert_workflow_kept' } as const;
```

Mapping rules (spec §Conversion table, with the facts verified in code):

| Source | Rule |
|---|---|
| inline rule, `conditions` array length 1 (`alertConditions/index.ts:169-173`: array = implicit AND) | `convertAlertConditionToMonitor(conditions)` → kind + condition; `null` → `metric_without_kind` when `type ∈ {metric, threshold}` and `normalizeMetricName(metric) === 'processCount'`, `custom_condition` when `type === 'custom'`, else `no_condition` |
| inline rule, 2..10 conditions (or a stored flat `{logic, conditions}` group — `routes/alerts/schemas.ts:29` accepts arbitrary shapes for standalone rules, and old policy rows may carry one) | `composite` with `match: logic === 'or' ? 'any' : 'all'`; each child through `convertAlertConditionToMonitor([child])`; child kind ∉ `SERVER_EVALUATED_MONITOR_KINDS` → `child_kind_not_composable`; any child null → that child's code; a child that is itself a group → `nested_group`; >10 → `too_many_conditions` |
| inline rule delivery | `notification_channel_ids` non-empty → `deliveryMode: 'channels'` + ids; empty/null → `'inherit'` (never `'none'`); `escalation_policy_id` → `escalationPolicyId` |
| inline rule scalars | `severity`, `cooldownMinutes`, `autoResolve`, `name`; `rationale` → `description`; `titleTemplate`/`messageTemplate` dropped → note "Title/message use the monitor kind's templates"; non-empty `autoResolveConditions` → `unconvertible:auto_resolve_conditions` (a monitor cannot carry an array of resolve conditions and silently dropping them would change when the alert clears) |
| watch | primary `service`/`process`: `{ serviceName\|processName: name, consecutiveFailures: alertAfterConsecutiveFailures }`; severity `getMonitorKindSpec(kind).defaultSeverity`; cooldown 5; autoResolve false; delivery `inherit`; `autoRestart` → `responses: [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: maxRestartAttempts, cooldownSeconds: restartCooldownSeconds, whenOffline: 'queue' }]` (Task 3 addendum: empty command = agent-local); `cpuThresholdPercent != null` → extra `process_resource` `{ resource: 'cpu', processName: name, operator: 'gt', value, durationMinutes: ceil(thresholdDurationSeconds/60) \|\| undefined }` role `resource_cpu`, name `"<name> — CPU"`; `memoryThresholdMb != null` → same with `resource: 'memory'`, role `resource_memory`, name `"<name> — memory"`; `alertOnStop`, `alertSeverity`, `displayName` ignored. **Always convertible.** Notes: `"Legacy watches never raised an inbox alert (heartbeat.ts monitoring-results ingest only counts failures); the monitor raises a <severity> alert after <n> consecutive failures."`; when `autoRestart`: `"Auto-restart stays agent-local (max <n> attempts, <s>s cooldown) as a restart_service response."`; when `alertOnStop === false`: `"alertOnStop=false was stored but never read; ignored."` |
| standalone rule + template | as `ruleConversionService.ts:92-105` (overrides win over template); template `conditions` with no `type` and no array (the `/settings/alert-templates` envelope `{triggers, thresholdDefaults, …}`) → `no_condition`; target → assignment handled by the caller (Task 13 reuses `convertRuleToMonitor`) |
| `automations` with `trigger.type === 'event' && eventType === 'alert.triggered'` and `filter.ruleId` / `filter.configPolicyAlertRuleId` naming a source in this preview | `mapAutomationResponses` → its `actions` (verbatim, `normalizeAutomationActions` shape), dedupe by `fingerprintAction` against the target monitor's responses, cap 10 → note `"<k> actions appended to <monitor>; <d> duplicates skipped"`; overflow → `unconvertible:too_many_responses` for the automation only |
| `config_policy_automations` with `triggerType === 'event' && eventType === 'alert.triggered'` | **kept, listed** as `outcome: 'unconvertible'`, `reason: 'unconvertible:alert_workflow_kept'`, note `"Fires on every alert for devices governed by this policy (no rule filter exists on policy automations); it stays an Alert workflow. Retire it here only when a monitor response replaces it."` — appending it to this policy's monitors would NARROW its coverage (it fires on alerts from any rule today), which is the coverage change Codex warned about; there is no `filter` column on `config_policy_automations` (schema :218-235), so the spec's `filter.ruleId` branch can only apply to standalone `automations` |

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/monitors/conversion/mapping.test.ts` (table-driven; a representative subset — implement every row of the table above as a case):

```ts
import { describe, expect, it } from 'vitest';
import { fingerprintAction, mapInlineRule, mapWatch, monitorSignature, previewHash, UNCONVERTIBLE } from './mapping';

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

describe('fingerprint / signature / previewHash', () => {
  it('fingerprintAction is key-order independent', () => {
    expect(fingerprintAction({ type: 'run_script', scriptId: 'a', whenOffline: 'queue' })).toBe(fingerprintAction({ whenOffline: 'queue', scriptId: 'a', type: 'run_script' }));
  });
  it('monitorSignature ignores name/description and changes on any behavioural field', () => {
    const base = { kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high', cooldownMinutes: 5, autoResolve: false, deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null, responses: [] } as const;
    expect(monitorSignature({ ...base })).toBe(monitorSignature({ ...base }));
    expect(monitorSignature({ ...base, severity: 'low' })).not.toBe(monitorSignature(base));
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
  alertWorkflowKept: 'alert_workflow_kept',
} as const;

export type MappingResult =
  | { ok: true; proposed: ProposedMonitor[]; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

const fail = (code: string, notes: string[] = []): MappingResult => ({ ok: false, reason: `unconvertible:${code}`, notes });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

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

  const base = { severity: spec.defaultSeverity, cooldownMinutes: 5, autoResolve: false, deliveryMode: 'inherit' as const, deliveryChannelIds: [], escalationPolicyId: null };
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
      role: 'primary', kind: mapped.kind, name: rule.name, condition: mapped.condition,
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

export function monitorSignature(m: Pick<ProposedMonitor, 'kind' | 'condition' | 'severity' | 'cooldownMinutes' | 'autoResolve' | 'deliveryMode' | 'deliveryChannelIds' | 'escalationPolicyId' | 'responses'>): string {
  return sha(canonical({
    kind: m.kind, condition: m.condition, severity: m.severity, cooldownMinutes: m.cooldownMinutes, autoResolve: m.autoResolve,
    deliveryMode: m.deliveryMode, deliveryChannelIds: [...m.deliveryChannelIds].sort(), escalationPolicyId: m.escalationPolicyId,
    responses: (m.responses as unknown[]).map(fingerprintAction).sort(),
  }));
}

export function previewHash(input: { policyId: string; items: ConversionPreviewItem[]; inheritanceMode: string }): string {
  return sha(canonical({
    policyId: input.policyId,
    inheritanceMode: input.inheritanceMode,
    items: input.items.map((i) => ({ t: i.sourceTable, id: i.sourceId, o: i.outcome, r: i.reason ?? null, p: i.proposed.map(monitorSignature) })),
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

### Task 12: Equivalence check over every device in scope (dry-run transaction), job-backed above 500 devices

**Files:**
- Create: `apps/api/src/services/monitors/conversion/equivalence.ts`
- Create: `apps/api/src/jobs/monitorConversionPreviewWorker.ts`
- Modify: wherever `createAlertWorker()` is started (`grep -rn "createAlertWorker()" apps/api/src --include='*.ts' | grep -v test` — register `createMonitorConversionPreviewWorker()` beside it)
- Test: `apps/api/src/services/monitors/conversion/equivalence.test.ts` (pure diff + device-scope filter), `apps/api/src/jobs/monitorConversionPreviewWorker.test.ts` (job data → `withDbAccessContext` + progress writes, harness after `jobs/alertWorker.test.ts`)
- Reads: `configurationPolicy.ts:2580-2627` (`previewEffectiveConfig` — the rolled-back-transaction pattern to mirror), `:2568` (`resolveEffectiveConfig` / `resolveEffectiveConfigWithExecutor(executor, deviceId, auth)`), `featureConfigResolver.ts:1077-1175` (`resolveDeviceIdsForSoftwarePolicy` — the device-scope walk to mirror, keyed on a policy id), `:146-167` (`matchesRoleOsFilter`, `buildRoleOsFilterConditions`), `monitorResolver.ts` (`resolveMonitorsForDevice(deviceId, executor)`), `db/index.ts:642` (`withDbAccessContext(context, fn)`), `services/redis.ts:125,286`, `services/bullmqQueue.ts:41` (`createInstrumentedQueue`)

**Interfaces:**

```ts
export interface EquivalenceProposal {
  policy: PolicySources['policy'];
  inheritanceMode: 'cumulative' | 'replace';
  /** convertible items only: source id → the monitors to mint (or reuse) */
  bySource: Array<{ sourceTable: ConversionSourceTable; sourceId: string; monitors: ProposedMonitor[] }>;
}
export async function resolveDeviceIdsForPolicy(policyId: string, executor?: DbExecutor): Promise<string[]>; // assignments of THIS policy → devices, roleFilter/osFilter applied per assignment via matchesRoleOsFilter
export function diffSignatureSets(before: Map<string, string>, after: Map<string, string>): string[]; // label→signature maps; returns human-readable deltas
export async function computeEquivalence(proposal: EquivalenceProposal, deviceIds: string[], auth: AuthContext, onProgress?: (checked: number, total: number) => Promise<void> | void): Promise<{ devicesChecked: number; deltas: EquivalenceDelta[] }>;

// job worker
export const MONITOR_CONVERSION_PREVIEW_QUEUE = 'monitor-conversion-preview';
export interface ConversionPreviewJobData { policyId: string; dbContext: DbAccessContext; requestedBy: string; sourcesHash: string }
export function getMonitorConversionPreviewQueue(): Queue;
export function createMonitorConversionPreviewWorker(): Worker<ConversionPreviewJobData>;
export const previewJobKey = (policyId: string) => `monitorconv:preview:${policyId}`; // Redis JSON { status:'running'|'done'|'failed', progress:{checked,total}, sourcesHash, result?: PolicyConversionPreview, error?: string, startedAt }, TTL 3600 s
```

Before / after, per device — both sides expressed as `monitorSignature` strings keyed by a label so a delta can say WHAT changed:

- **before** (outside the transaction): the legacy sweep's effective set = `resolveEffectiveConfig(deviceId, auth).features.alert_rule.inlineSettings.items` mapped through `mapInlineRule` (each convertible rule → its signatures; an unconvertible rule contributes the label `legacy:<name>` with a signature of its canonical row so it still has to be present after) + `features.monitoring.inlineSettings.watches` through `mapWatch` + the monitor sweep's effective set (`resolveMonitorsForDevice` → enabled monitors → their `monitor_definitions` rows, overrides applied with `applyOverrides`, → `monitorSignature`).
- **after** (inside `db.transaction`, thrown away with a `PreviewRollback` exactly as `previewEffectiveConfig` does): insert the proposed `monitor_definitions` rows directly (no compile — the resolver reads only `monitor_definitions` + `config_policy_monitors`), upsert the policy's `monitors` link with `inheritance` and the new attachment rows (through `addFeatureLink` / `updateFeatureLink` with `tx` as executor so the link JSON and normalized rows agree), mark this policy's source rows `retired_at = now()` (so the legacy resolver stops seeing them and the NEXT policy in the chain, if any, becomes the legacy winner — that is a real delta the check must surface), then for each device compute the same two sets with `resolveEffectiveConfigWithExecutor(tx, deviceId, auth)` and `resolveMonitorsForDevice(deviceId, tx)`.
- A device's delta = labels present on one side only, or same label with a different signature: `"device <id>: gains <name> (<kind>) from <policy>"`, `"loses …"`, `"<name>: severity high → low"` (the signature carries kind/condition/severity/cooldown/autoResolve/delivery/responses, so any of those changing is a delta). `deltas` is capped at 200 entries with a final `"… and N more"` entry.

Devices: `resolveDeviceIdsForPolicy` mirrors `resolveDeviceIdsForSoftwarePolicy` (device / device_group / site / organization / partner levels → device ids), then applies `matchesRoleOsFilter(assignment, device)` per assignment so a "servers only" assignment scopes the check exactly as #6344 scopes the resolver. Above `EQUIVALENCE_JOB_THRESHOLD` (500) the caller enqueues the job instead (Task 13's `previewPolicyConversion` decides; this task provides both pieces).

Job worker: `createInstrumentedQueue(MONITOR_CONVERSION_PREVIEW_QUEUE)`; `new Worker(…, async (job) => withDbAccessContext(job.data.dbContext, () => runPreviewJob(job.data)), { connection: getBullMQConnection(), concurrency: 2, lockDuration: 600_000 })`; `jobId: previewJobKey(policyId)` so a second click while running is a no-op (`Queue.add` with an existing jobId returns the existing job). `runPreviewJob` builds the preview through Task 13's `buildPolicyConversionPreview(policyId, { userId: requestedBy, auth: createSystemAuthContext() }, { onProgress })` — the RLS boundary is the caller's own `dbContext`, so the app-layer system auth cannot see more than the caller could (RLS is stricter, CLAUDE.md §Partner-Wide First step 3) — writing `{ status: 'running', progress }` to Redis every 50 devices and `{ status: 'done', result }` at the end.

- [ ] **Step 1: Write the failing tests** — `equivalence.test.ts`: `diffSignatureSets` (gain / loss / change / identical → `[]`); `resolveDeviceIdsForPolicy` with a mocked queue (assignments: one `site` with `roleFilter: ['server']`, devices under the site with roles `server` and `workstation` → only the server id). `monitorConversionPreviewWorker.test.ts`: the processor calls `withDbAccessContext` with `job.data.dbContext` (mock `../db`), writes a running entry then a done entry to the mocked Redis (`setex` calls with the key from `previewJobKey`), and a thrown preview error writes `{ status: 'failed', error }`.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/monitors/conversion/equivalence.test.ts src/jobs/monitorConversionPreviewWorker.test.ts` → module-not-found for both.

- [ ] **Step 3: Implement** — `equivalence.ts` core (the device-scope walk copies the `switch (assignment.level)` from `featureConfigResolver.ts:1118-1172` with `configPolicyAssignments.configPolicyId = policyId` as the first query and a `matchesRoleOsFilter` pass per assignment):

```ts
class PreviewRollback extends Error {}

function signatureMapForLegacy(effective: EffectiveConfiguration | null): Map<string, string> {
  const out = new Map<string, string>();
  const rules = (effective?.features.alert_rule?.inlineSettings as { items?: unknown[] } | undefined)?.items ?? [];
  for (const raw of rules) {
    const row = raw as Parameters<typeof mapInlineRule>[0];
    const m = mapInlineRule(row);
    if (m.ok) m.proposed.forEach((p, i) => out.set(`rule:${row.name}#${i}`, monitorSignature(p)));
    else out.set(`legacy:${row.name}`, sha(canonical(row.conditions)));
  }
  const watches = (effective?.features.monitoring?.inlineSettings as { watches?: unknown[] } | undefined)?.watches ?? [];
  for (const raw of watches) {
    const m = mapWatch(raw as Parameters<typeof mapWatch>[0]);
    if (m.ok) m.proposed.forEach((p) => out.set(`watch:${p.name}`, monitorSignature(p)));
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
  for (const def of defs) {
    const eff = enabled.find((m) => m.monitorId === def.id)!;
    const spec = getMonitorKindSpec(def.kind);
    const condition = applyOverrides(spec, spec.conditionSchema.parse(def.condition), eff.overrides);
    out.set(`monitor:${def.name}`, monitorSignature({
      kind: def.kind, condition, severity: (eff.overrides?.severity as ProposedMonitor['severity']) ?? def.severity,
      cooldownMinutes: def.cooldownMinutes, autoResolve: def.autoResolve, deliveryMode: def.deliveryMode as ProposedMonitor['deliveryMode'],
      deliveryChannelIds: def.deliveryChannelIds, escalationPolicyId: def.escalationPolicyId, responses: def.responses,
    }));
  }
  return out;
}

export function diffSignatureSets(before: Map<string, string>, after: Map<string, string>): string[] {
  const deltas: string[] = [];
  const bySig = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [v, k]));
  const afterBySig = bySig(after), beforeBySig = bySig(before);
  for (const [label, sig] of before) if (!afterBySig.has(sig)) deltas.push(`loses ${label}`);
  for (const [label, sig] of after) if (!beforeBySig.has(sig)) deltas.push(`gains ${label}`);
  return deltas;
}

export async function computeEquivalence(proposal, deviceIds, auth, onProgress) {
  const deltas: EquivalenceDelta[] = [];
  const before = new Map<string, Map<string, string>>();
  for (const id of deviceIds) {
    const legacy = signatureMapForLegacy(await resolveEffectiveConfig(id, auth));
    const monitors = await signatureMapForMonitors(id, db);
    before.set(id, new Map([...legacy, ...monitors]));
  }
  let checked = 0;
  try {
    await db.transaction(async (tx) => {
      await applyProposalInTx(tx, proposal, auth);   // insert defs, upsert link + attachments, retire this policy's source rows
      for (const id of deviceIds) {
        const legacy = signatureMapForLegacy(await resolveEffectiveConfigWithExecutor(tx, id, auth));
        const monitors = await signatureMapForMonitors(id, tx);
        for (const d of diffSignatureSets(before.get(id)!, new Map([...legacy, ...monitors]))) {
          if (deltas.length < 200) deltas.push({ deviceId: id, detail: d });
        }
        checked++;
        if (onProgress && checked % 50 === 0) await onProgress(checked, deviceIds.length);
      }
      throw new PreviewRollback();
    });
  } catch (err) {
    if (!(err instanceof PreviewRollback)) throw err;
  }
  if (deltas.length === 200) deltas.push({ deviceId: '*', detail: '… and more devices differ' });
  return { devicesChecked: checked, deltas };
}
```

`applyProposalInTx` is exported and REUSED by Task 13's real `convertPolicy` (same statements, no rollback) — one code path for dry-run and commit is what makes the preview trustworthy. It: inserts each `ProposedMonitor` as a `monitor_definitions` row owned like the policy (`orgId`/`partnerId` from `proposal.policy`), collects `sourceId → monitorIds`, upserts the `monitors` link (`addFeatureLink(policyId, 'monitors', null, { items, inheritance }, undefined, tx)` or `updateFeatureLink(link.id, { inlineSettings: { items: [...existing, ...new], inheritance } }, policyId, undefined, tx)`), and `UPDATE`s the source rows `retired_at = now(), retired_reason = 'converted', converted_to_monitor_id = <primary>` for `inlineRules` / `watches` / `standaloneAutomations` in `proposal.bySource`. In the dry run the compile step is skipped (the resolver does not need compiled rows); the commit path (Task 13) compiles.

- [ ] **Step 4: Run, expect PASS** — `cd apps/api && npx vitest run src/services/monitors/conversion/ src/jobs/monitorConversionPreviewWorker.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** — `git add apps/api/src/services/monitors/conversion/equivalence.ts apps/api/src/services/monitors/conversion/equivalence.test.ts apps/api/src/jobs/monitorConversionPreviewWorker.ts apps/api/src/jobs/monitorConversionPreviewWorker.test.ts <worker registration file> && git commit -m "feat(monitors): conversion equivalence check over every device in scope, job-backed above 500"`

### Task 13: `previewPolicyConversion` / `convertPolicy` / `convertPartnerLegacy` / `revertConversion` / `retireSource` — ledger, open-alert carry-over, cooldown re-key, standalone rules

**Files:**
- Create: `apps/api/src/services/monitors/conversion/convert.ts`
- Modify: `apps/api/src/services/monitors/conversion/index.ts` (re-export everything)
- Modify: `apps/api/src/services/alertCooldown.ts` (add `moveCooldownKeys`, `rekeyConfigPolicyCooldowns`, `rekeyCooldownsBackToConfigPolicy` next to `:290-365`)
- Modify: `apps/api/src/services/monitors/ruleConversionService.ts:142-148` (retire + ledger instead of `isActive: false` only)
- Modify: `apps/api/migrations/2026-10-23-110000-monitor-conversions.sql` + `db/schema/monitorConversions.ts` + export policy (Task 6, same PR2 if not yet merged; otherwise a new `2026-10-23-121000-monitor-conversion-outputs-reused.sql`): `monitor_conversion_outputs.reused_monitor boolean NOT NULL DEFAULT false` (`included` in the export policy) — revert must know whether to delete the monitor or only detach it
- Test: `apps/api/src/services/monitors/conversion/convert.test.ts` (Drizzle-mock, the decision logic), `apps/api/src/services/alertCooldown.rekey.test.ts` (ioredis mock: SCAN → SET PX → DEL), `apps/api/src/services/monitors/ruleConversionService.test.ts` (existing; extend); the transactional proof is Task 16's round-trip

**Interfaces (the contract from the brief, verbatim names):**

```ts
export async function previewPolicyConversion(policyId: string, auth: AuthContext, opts?: { mode?: 'auto' | 'inline' }): Promise<PolicyConversionPreview | PolicyConversionPreviewPending>;
export async function buildPolicyConversionPreview(policyId: string, ctx: { userId: string; auth: AuthContext }, opts?: { onProgress?: (c: number, t: number) => Promise<void> | void }): Promise<PolicyConversionPreview>; // no threshold logic; used inline and by the job
export async function convertPolicy(policyId: string, previewHash: string, auth: AuthContext, opts?: { sourceIds?: string[] }): Promise<{ conversionIds: string[]; retired: number; monitorsCreated: number }>;
export async function convertPartnerLegacy(partnerId: string, auth: AuthContext): Promise<{ policies: number; converted: number; unconvertible: number }>;
export async function revertConversion(conversionId: string, auth: AuthContext): Promise<void>;
export async function retireSource(sourceTable: ConversionSourceTable, sourceId: string, reason: string, auth: AuthContext): Promise<void>;
export class ConversionError extends Error { constructor(readonly code: 'policy_not_found' | 'partner_wide_denied' | 'prerequisite_missing' | 'blocked' | 'preview_stale' | 'equivalence_delta' | 'source_not_found' | 'already_converted' | 'invalid_reason' | 'conversion_not_found', message: string, readonly details?: unknown) }
```

Behaviour:

- **`buildPolicyConversionPreview`**: `assertConversionPrerequisites()` → on `ConversionPrerequisiteMissingError` return `{ policyId, previewHash: '', items: [], inheritanceMode: 'cumulative', equivalence: { devicesChecked: 0, deltas: [] }, blockedBy: 'prerequisite_missing', missingPrerequisites }`. `getConfigPolicy(policyId, auth)` null → `ConversionError('policy_not_found')`. Partner-wide policy (`orgId === null`) and `!canManagePartnerWidePolicies(auth)` → `ConversionError('partner_wide_denied', PARTNER_WIDE_WRITE_DENIED_MESSAGE)`. `loadPolicySources`. `parentUnconverted` → `blockedBy: 'parent_unconverted'` with the items still listed (the panel shows why) and no equivalence run. Items: inline rules → `mapInlineRule`; watches → `mapWatch`; standalone automations referencing a rule → convertible item whose `proposed` is `[]` and whose notes name the target monitor (its actions are appended to that rule's primary monitor at convert time; a rule that is unconvertible makes the automation `unconvertible:target_unconvertible`); policy automations → `unconvertible:alert_workflow_kept`. Escalation axis: for a partner-wide policy any proposed `escalationPolicyId` that is not a partner-wide policy of the same partner → `unconvertible:escalation_policy_axis` (same rule as `monitorService.assertEscalationPolicyCompatible`, `:119-153`; read `escalation_policies` owner columns). `openAlerts` from `openAlertsBySource`. `inheritanceMode = inlineRules.length > 0 ? 'replace' : (links.monitors?.inheritance ?? 'cumulative')`. Equivalence over `resolveDeviceIdsForPolicy` with the convertible items. `previewHash` from Task 10.
- **`previewPolicyConversion`** (`mode: 'auto'`): count devices first; `≤ 500` → build inline; `> 500` → read `previewJobKey`; a `done` entry whose `sourcesHash` (sha of the source ids + `updated_at`s) still matches → return its result; `running` → return `{ status: 'running', progress }`; otherwise enqueue `{ policyId, dbContext: getCurrentDbAccessContext()!, requestedBy: auth.user.id, sourcesHash }` and return running with `{ checked: 0, total }`. `mode: 'inline'` (partner sweep, W05d) always builds inline.
- **`convertPolicy`**: prerequisites → `ConversionError('prerequisite_missing')`; rebuild the preview inline (or take the `done` job result when its `sourcesHash` matches); `preview.blockedBy` → `blocked`; `preview.previewHash !== previewHash` → `preview_stale`; `deltas.length > 0` → `equivalence_delta` (details = deltas); then one `db.transaction`: `applyProposalInTx` with the real monitor path — for each convertible item's monitors, **reuse** an existing monitor visible to the policy's owner whose `monitorSignature` equals the proposal's (read `listMonitorDefinitions(auth)` once, compute signatures) else `createMonitorDefinition` (runs `compileMonitorInTx`; nested in the outer transaction as a savepoint); attach; append standalone-automation actions to the target monitor via `updateMonitorDefinition(monitorId, { responses: dedupedByFingerprint.slice(0, 10) }, auth)`; retire source rows (`retired_reason = 'converted'`, `converted_to_monitor_id = primary`); ledger `monitor_conversions` row per source (owner axis = policy owner, `policy_id`, `converted_by = auth.user.id`, `preview_hash`) + `monitor_conversion_outputs` per produced monitor (`role`, `reused_monitor`); **open-alert carry-over** per inline rule: `UPDATE alerts SET rule_id = <compiled rule id of the primary monitor>, config_policy_id = NULL, monitor_id = <monitor id>, context = COALESCE(context,'{}') || jsonb_build_object('convertedFrom', jsonb_build_object('sourceTable','config_policy_alert_rules','sourceId',<rule id>,'convertedAt',now())) WHERE config_policy_id = <rule id> AND status IN ('active','acknowledged','suppressed') RETURNING id` → `moved_alert_ids` on the primary output. After commit: `rekeyConfigPolicyCooldowns(rule.id, compiledRuleId)` for each converted inline rule (Redis is not transactional; a failure here logs + `captureException` and does not roll back — the worst case is one extra alert after the cooldown would have expired). Returns `{ conversionIds, retired, monitorsCreated }`.
- **`convertPartnerLegacy`**: `canManagePartnerWidePolicies(auth)` else `partner_wide_denied`; `auth.scope !== 'system' && auth.partnerId !== partnerId` → denied. Policies = active partner-wide policies of the partner + active org policies of every org under it, those with pending rows (`countPendingConversions` per policy or one grouped query); for each, `buildPolicyConversionPreview` (inline, no threshold — the sweep is an admin action) and, when `!blockedBy && deltas.length === 0`, `convertPolicy(policyId, preview.previewHash, auth)`; `unconvertible` sums items with `outcome: 'unconvertible'` and policies skipped for deltas/blocked. Then standalone rules: every `alert_rules` row in the partner's scope with `managed_by_monitor_id IS NULL AND retired_at IS NULL AND is_active` → `convertRuleToMonitor(rule.id, auth)` (below); `not_convertible` → `retireSource('alert_templates', rule.templateId, 'unconvertible:no_condition', auth)` when the template has no `type` anywhere in its conditions AND is not the compliance-bridge template (`policyAlertBridge.ts:20` `POLICY_TEMPLATE_NAME = 'Policy Compliance Violation'` — export the constant and compare by name + `is_built_in`), which also retires the template's rules with the same reason; otherwise leave the rule (it fires today and is listed as unconvertible). Global built-in templates (`is_built_in AND org_id IS NULL`) are never touched.
- **`revertConversion`**: load `monitor_conversions` by id (RLS + `policy_not_found`-style access: org rows via `auth.canAccessOrg`, partner rows via partner scope + capability), `reverted_at` set → `already_converted`-style `conversion_not_found`; in one transaction: un-retire the source (`retired_at = NULL, retired_reason = NULL, converted_to_monitor_id = NULL`; missing row → `source_not_found`, ledger still marked reverted); per output: role `response` → remove the appended actions (by fingerprint of the source automation's actions) from the monitor's responses via `updateMonitorDefinition`; other roles → `reused_monitor` ? remove the attachment item from the policy's `monitors` link : `deleteMonitorDefinition(monitorId, auth)` (attachments cascade; alerts keep history with `monitor_id` NULL); restore `moved_alert_ids`: `UPDATE alerts SET rule_id = NULL, config_policy_id = <source id>, monitor_id = NULL, context = context - 'convertedFrom' WHERE id = ANY(...)`; if the source was an inline rule and it was the policy's only converted rule set, flip the link's `inheritance` back to `cumulative` only when no other converted inline rule remains (otherwise leave it); `reverted_at = now()`. After commit: `rekeyCooldownsBackToConfigPolicy(compiledRuleId, sourceId)`.
- **`retireSource`**: `reason` must be `'operator'` or start with `'unconvertible:'` else `invalid_reason`; resolve the row's owner (config tables: through link → policy; `alert_rules`/`alert_templates`/`automations`: the row's own axes) and gate (org access / partner capability); `UPDATE … SET retired_at = now(), retired_reason = reason WHERE id = … AND retired_at IS NULL` (0 rows → `already_converted`); write a `monitor_conversions` row with no outputs so the retirement is listed and revertible.

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

`ruleConversionService.ts:142-148` — replace the `isActive: false` update with retire-in-place plus a ledger row, inside the same transaction:

```ts
    await db.update(alertRules).set({
      isActive: false,
      overrideSettings: { ...overrides, convertedToMonitorId: monitor.id },
      retiredAt: new Date(),
      retiredReason: 'converted',
      convertedToMonitorId: monitor.id,
    }).where(eq(alertRules.id, ruleId));
    const [ledger] = await db.insert(monitorConversions).values({
      orgId: rule.orgId, partnerId: rule.orgId ? null : rule.partnerId, sourceTable: 'alert_templates', sourceId: rule.templateId,
      policyId: policy.id, convertedBy: auth.user.id, previewHash: monitorSignature(/* the created definition */),
    }).returning({ id: monitorConversions.id });
    await db.insert(monitorConversionOutputs).values({ conversionId: ledger!.id, orgId: rule.orgId, partnerId: rule.orgId ? null : rule.partnerId, monitorId: monitor.id, role: 'primary', movedAlertIds: movedIds });
```

where `movedIds` comes from the same open-alert `UPDATE … RETURNING id` (standalone alerts are keyed `rule_id`, not `config_policy_id`: `UPDATE alerts SET rule_id = <compiled>, monitor_id = <monitor>, context = … WHERE rule_id = <old rule> AND status IN (…)`), and the template is retired `'converted'` when no other unretired rule references it. Keep the existing `ConversionFailure` union; `already_managed` now also covers `retired_at IS NOT NULL`.

- [ ] **Step 1: Write the failing tests** — `convert.test.ts` (mocked `loadPolicySources`, `computeEquivalence`, `resolveDeviceIdsForPolicy`, `getConfigPolicy`, `listMonitorDefinitions`, `createMonitorDefinition`, `db`): (a) prerequisites missing → `blockedBy: 'prerequisite_missing'` with labels; (b) partner-wide policy + org token → `ConversionError('partner_wide_denied')`; (c) `parentUnconverted` → `blockedBy: 'parent_unconverted'` and `computeEquivalence` NOT called; (d) three inline rules (one processCount) + one watch with thresholds → 4 items, outcomes `['convertible','convertible','unconvertible','convertible']`, the watch item has 3 proposed, `inheritanceMode === 'replace'`, `openAlerts` copied from the map; (e) `convertPolicy` with a wrong hash → `preview_stale`; with deltas → `equivalence_delta`; (f) reuse: a visible monitor with an equal signature is attached, `createMonitorDefinition` not called, output `reused_monitor: true`; (g) `retireSource` rejects `'bogus'` with `invalid_reason` and accepts `'operator'`. `alertCooldown.rekey.test.ts`: two `cpar` keys with TTLs 1000/0 → one `set … PX 1000`, two `del`, returns 2. `ruleConversionService.test.ts`: the update carries `retiredAt`/`retiredReason: 'converted'`/`convertedToMonitorId` and a ledger insert follows.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/monitors/conversion/convert.test.ts src/services/alertCooldown.rekey.test.ts src/services/monitors/ruleConversionService.test.ts` → module-not-found / "expected update payload to contain retiredReason".

- [ ] **Step 3: Implement** — `convert.ts` per the Behaviour list (every write inside `db.transaction`; every partner-axis write path passes `canManagePartnerWidePolicies` first — the file must contain that identifier for `partner-wide-write-coverage.test.ts`); `alertCooldown.ts` additions above; `ruleConversionService.ts` change above; `index.ts`:

```ts
export * from './types';
export * from './prerequisites';
export * from './mapping';
export { loadPolicySources, countPendingConversions, OPEN_ALERT_STATUSES } from './loadSources';
export { computeEquivalence, resolveDeviceIdsForPolicy, diffSignatureSets, applyProposalInTx } from './equivalence';
export { previewPolicyConversion, buildPolicyConversionPreview, convertPolicy, convertPartnerLegacy, revertConversion, retireSource, ConversionError } from './convert';
```

- [ ] **Step 4: Run, expect PASS** — `cd apps/api && npx vitest run src/services/monitors/conversion/ src/services/alertCooldown src/services/monitors/ruleConversionService.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** — `git add apps/api/src/services/monitors/conversion/ apps/api/src/services/alertCooldown.ts apps/api/src/services/alertCooldown.rekey.test.ts apps/api/src/services/monitors/ruleConversionService.ts apps/api/src/services/monitors/ruleConversionService.test.ts apps/api/src/services/policyAlertBridge.ts <reused_monitor migration/schema/export-policy files> && git commit -m "feat(monitors): policy conversion — preview, convert, partner sweep, revert, retire; ledger, open-alert carry-over, cooldown re-key"`

### Task 14: Conversion HTTP routes — policy preview/convert, revert, retire, partner convert-all, and pending counts

**Files:**
- Modify: `apps/api/src/routes/monitorDefinitions.ts:68-74,174` (authenticated parent; mount the conversion resource before `/:id`).
- Create: `apps/api/src/routes/monitorDefinitions.conversion.ts` (the conversion resource and its validation/error boundary).
- Test: `apps/api/src/routes/monitorDefinitions.test.ts:218-249` (extend mount regression), `apps/api/src/routes/monitorDefinitions.conversion.test.ts` (create); `apps/api/src/routes/monitorDefinitions.authGate.test.ts` (existing authentication regression).
- Consumed implementations verified: `apps/api/src/services/partnerWideAccess.ts:26-31`, `apps/api/src/services/siteCeilingAccess.ts:67-72`, `apps/api/src/middleware/auth.ts:75-176`, `apps/api/src/lib/validation.ts:105-142`. Conversion services are created by Tasks 9–13, rather than existing source files.

**Interfaces:**
- Consumes: `previewPolicyConversion(policyId, auth)`, `convertPolicy(policyId, previewHash, auth, opts?)`, `revertConversion(conversionId, auth)`, `retireSource(sourceTable, sourceId, reason, auth)`, `convertPartnerLegacy(partnerId, auth)`, `countPendingConversions(scope)`, `ConversionError`, `ConversionPrerequisiteMissingError`, `MONITOR_CONVERSION_SOURCE_TABLES`.
- Produces the exact W05c2 HTTP resource, mounted at `/monitor-definitions/conversion`:

| Method / suffix | Input | Success |
|---|---|---|
| GET `/policies/:policyId/preview` | UUID path | `200 { data: PolicyConversionPreview }`; `202 { data: PolicyConversionPreviewPending }` while running |
| POST `/policies/:policyId/convert` | `{ previewHash: string, sourceIds?: string[] }` | `200 { data: ConvertPolicyResult }` |
| POST `/:conversionId/revert` | UUID path, no body | `200 { success: true }` |
| POST `/retire` | `{ sourceTable: ConversionSourceTable, sourceId: string, reason: string }` | `200 { success: true }` |
| POST `/partner/convert-all` | no body; partner identity comes from `auth.partnerId` | `200 { data: ConvertPartnerResult }` |
| GET `/pending?orgId` | optional UUID; default `auth.orgId` | `200 { data: { policies: number, rows: number } }` |

The domain payload of pending is the brief's `{ policies, rows }`; the transport envelope follows W05c2's `ApiResponse<T>` convention. `standaloneRules` remains an internal additive service field. Preview progress is polled at the **same** GET URL; no job-id API or new UI query state. The partner action is already the confirmation step of W05c2's preview/confirm UI. Each policy still gets Task 13's equivalence/staleness checks. A system HTTP caller must carry a selected partner; the background W05d sweep calls the service directly with its explicit partner id.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/monitorDefinitions.conversion.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

const m = vi.hoisted(() => ({
  authenticated: true, permission: true, mfa: true,
  preview: vi.fn(), convert: vi.fn(), revert: vi.fn(), retire: vi.fn(),
  partner: vi.fn(), counts: vi.fn(), audit: vi.fn(),
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
  convertPartnerLegacy: m.partner, countPendingConversions: m.counts,
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
  ['/partner/convert-all', undefined],
];
beforeEach(() => {
  vi.resetAllMocks();
  m.authenticated = m.permission = m.mfa = true;
  m.preview.mockResolvedValue({ policyId: POLICY, previewHash: HASH, items: [], inheritanceMode: 'replace', equivalence: { devicesChecked: 0, deltas: [] } });
  m.convert.mockResolvedValue({ conversionIds: [SOURCE], retired: 1, monitorsCreated: 1 });
  m.counts.mockResolvedValue({ policies: 0, rows: 0, standaloneRules: 9 });
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
      expect(await r.json()).toEqual({ success: true });
    }
    expect(m.revert).toHaveBeenCalledWith(SOURCE, expect.anything());
    expect(m.retire).toHaveBeenCalledWith('config_policy_alert_rules', SOURCE, 'operator', expect.anything());
    expect(m.audit).toHaveBeenCalledTimes(2);
  });
  it('partner convert-all infers the partner and requires full partner membership', async () => {
    expect((await request('/partner/convert-all', 'POST')).status).toBe(403);
    expect((await request('/partner/convert-all', 'POST', undefined, { scope: 'partner', partnerOrgAccess: 'selected' })).status).toBe(403);
    const r = await request('/partner/convert-all', 'POST', undefined, { scope: 'partner', orgId: null, partnerOrgAccess: 'all' });
    expect(r.status).toBe(200);
    expect(m.partner).toHaveBeenCalledWith(PARTNER, expect.objectContaining({ scope: 'partner' }));
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
    ['preview_stale', 409], ['equivalence_delta', 409], ['blocked', 409],
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
  convertPartnerLegacy, countPendingConversions,
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
monitorConversionRoutes.post('/partner/convert-all', write, requireMfa(), governance, async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  if (!auth.partnerId) return c.json({ error: 'Select a partner' }, 400);
  const data = await convertPartnerLegacy(auth.partnerId, auth);
  writeRouteAudit(c, { action: 'monitor.conversion.convert_all', resourceType: 'partner', resourceId: auth.partnerId, details: data });
  return c.json({ data });
});
monitorConversionRoutes.post('/retire', write, requireMfa(), governance,
  zValidator('json', retireBody), async (c) => {
    const { sourceTable, sourceId, reason } = c.req.valid('json');
    await retireSource(sourceTable, sourceId, reason, c.get('auth'));
    writeRouteAudit(c, { action: 'monitor.conversion.retire', resourceType: sourceTable, resourceId: sourceId, details: { reason } });
    return c.json({ success: true });
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

- [ ] **Step 4: Run, expect PASS**

From the repository root: `cd apps/api && npx vitest run src/routes/monitorDefinitions.conversion.test.ts src/routes/monitorDefinitions.test.ts src/routes/monitorDefinitions.authGate.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts` → all pass; `cd apps/api && npx tsc --noEmit -p .` → exit 0. W05c2 uses `runAction` for all four POST actions, preserves the 202 polling state, and uses `location.hash` for selected UI state; there are no new web mutations or translations in this task.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/monitorDefinitions.ts apps/api/src/routes/monitorDefinitions.conversion.ts apps/api/src/routes/monitorDefinitions.conversion.test.ts apps/api/src/routes/monitorDefinitions.test.ts
git commit -m "feat(monitors): expose scoped conversion preview, convert, revert, retire and pending routes"
```

### Task 15: Publish monitor identity/kind and move onboarding plus the historical alert importer to monitor attachments

**Files:**
- Modify: `apps/api/src/services/alertService.ts:46-68,157-160,226-267,289-326,349-399,1102-1113`; test `apps/api/src/services/alertService.test.ts:145-232`.
- Modify: `apps/api/src/modules/mcpInvites/tools/configureDefaults.ts:3-13,40-48,76-159,259-260`; test `apps/api/src/modules/mcpInvites/tools/configureDefaults.test.ts:153-315,391-485`.
- Create: `apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.ts` and adjacent `configureDefaults.monitors.test.ts` (isolate the policy attachment graph from the three other bootstrap steps).
- Modify: `apps/api/src/scripts/migrateToConfigPolicies.ts:30-52,176,222,275,329,349-418,634,647-655,694-703`; create adjacent `migrateToConfigPolicies.test.ts`.
- Reads: `apps/api/src/modules/mcpInvites/types.ts:17-27` (no authenticated user in `BootstrapContext`); `apps/api/src/services/monitors/builtInMonitors.ts:58-99`; `apps/api/src/db/schema/configurationPolicies.ts:78-104` (no default-policy marker); `apps/api/src/services/configurationPolicy.ts:1655-1662,1752-1758,1901-1949`; `apps/api/src/services/monitors/ruleConversionService.ts:25-40,49-70,120-139`; `apps/api/src/services/featureConfigResolver.ts:52-79` (synthetic system identity); `apps/api/src/db/index.ts:734-745,950` (system context / `runOutsideDbContext`).

**Interfaces:**
- Consumes: existing `monitorDefinitions.builtinKey`, the partner-wide SELECT-only branch, `addFeatureLink(..., executor)`, `updateFeatureLink(..., executor)`, `listFeatureLinks(policyId, executor)`, Task 1's `monitorsInlineSettingsSchema`, Task 13's ledger-aware `convertRuleToMonitor(ruleId, auth)`.
- Produces: `CreateAlertParams.kind?: MonitorKind | null`, `CreateSourcedAlertParams.kind?: MonitorKind | null`; published `alert.triggered` includes `monitorId: string | null` and `kind: MonitorKind | null`. Existing `ruleId` filters remain unchanged. Missing kind on an existing monitor id is resolved from the definition under the current DB context, so offline/recurrence callers need no parallel lookup code.
- Produces: `applyStandardAlertPolicy(orgId: string, framework: 'standard' | 'cis', expectedPartnerId: string): Promise<{ created: boolean; skipped_reason?: string }>`; the bootstrap output key remains `applied.alert_policy` for compatibility.
- Produces: exported `migrateAlertRulesLive(tx: Tx, orgId: string, auth: AuthContext): Promise<number>`, using target-specific monitor policies, never adding alert monitors to the historical umbrella policy.

The schema has no default-policy pointer. For onboarding, establish the explicit local convention `name = 'Default monitoring'`, `description = 'Baseline monitor attachments created by configure_defaults.'`, owned by the bootstrap org. Reuse only that marked policy; preserve inactive state and all existing attachment settings. Lock the org before checking/creating so concurrent bootstrap calls cannot create duplicate baselines. Do not seed monitors: a partner's deleted/disabled built-ins are deliberate choices.

The importer remains labelled historical and is still deleted by W05d. This is an interim repair of its alert-writing function, **not** an instruction to rerun the one-shot migration. Require a real actor for any future explicitly authorized invocation; the all-zero synthetic system user is not a valid `created_by`/`converted_by` FK.

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

In the existing sourced-network test at `alertService.test.ts:218`, change the expected event `monitorId: 'monitor-1'` to `monitorId: null, kind: null`. Keep its input context unchanged: legacy network check ids are not `monitor_definitions.id`. The source-specific id remains in `alerts.context.monitorId` until W05e adopts the check. This collision is recorded in the closing questions.

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
  const f = tx([{ id: 'r1' }, { id: 'r2' }]);
  m.convert.mockResolvedValue({ ok: true, data: { monitorId: 'monitor', configPolicyId: 'target-specific-policy' } });
  expect(await migrateAlertRulesLive(f.db as never, ORG, auth)).toBe(2);
  expect(m.convert.mock.calls).toEqual([['r1', auth], ['r2', auth]]);
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
import { z } from 'zod';
import { isNull } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { createSystemAuthContext } from '../services/featureConfigResolver';
import { convertRuleToMonitor } from '../services/monitors/ruleConversionService';
```

Replace `migrateAlertRulesLive` (349–418):

```ts
export async function migrateAlertRulesLive(tx: Tx, orgId: string, auth: AuthContext): Promise<number> {
  const rules = await tx.select({ id: alertRules.id }).from(alertRules).where(and(
    eq(alertRules.orgId, orgId), isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt),
  ));
  let converted = 0;
  for (const rule of rules) {
    const result = await convertRuleToMonitor(rule.id, auth);
    if (!result.ok) throw new Error(`${rule.id}: ${result.failure.kind}`);
    converted++;
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
    const actorFlag = process.argv.find((arg) => arg.startsWith('--actor-user-id='));
    const actorId = z.string().uuid().parse(actorFlag?.slice('--actor-user-id='.length));
    const [actor] = await db.select().from(users).where(eq(users.id, actorId)).limit(1);
    if (!actor) throw new Error('Historical migration requires an existing actor user');
    return migrate({ ...base, user: { id: actor.id, email: actor.email, name: actor.name, isPlatformAdmin: false } });
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

The actor flag identifies the audit actor; it grants no interactive request privileges. This standalone script still requires the deployment's administrative database configuration. Background conversion keeps real FK identities; onboarding's API key remains only in `writeAuditEvent.actorId` with `actorType: 'api_key'`.

- [ ] **Step 4: Run, expect PASS**

From the root: `cd apps/api && npx vitest run src/services/alertService.test.ts src/services/alertService.episodes.test.ts src/services/monitors/escalationLatch.test.ts src/modules/mcpInvites/tools/configureDefaults.test.ts src/modules/mcpInvites/tools/configureDefaults.monitors.test.ts src/scripts/migrateToConfigPolicies.test.ts src/services/monitors/ruleConversionService.test.ts` → all pass. `cd apps/api && npx tsc --noEmit -p .` → exit 0. Run `rg -n 'insert\(alertRules\)|insert\(configPolicyAlertRules\)|STANDARD_TEMPLATE_PATTERNS' apps/api/src/modules/mcpInvites/tools/configureDefaults.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.ts apps/api/src/scripts/migrateToConfigPolicies.ts` → no matches (exit 1, the desired result). No Docker, migration CLI or production data access is needed for these unit checks.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertService.test.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.test.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.ts apps/api/src/modules/mcpInvites/tools/configureDefaults.monitors.test.ts apps/api/src/scripts/migrateToConfigPolicies.ts apps/api/src/scripts/migrateToConfigPolicies.test.ts
git commit -m "feat(alerts): publish monitor identity and route baseline writers through monitor attachments"
```

### Task 16: Final verification — live ledger RLS, conversion/revert continuity, worker registration, and all PR gates

**Files:**
- Create: `apps/api/src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts`.
- Create: `apps/api/src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts`.
- Create: `apps/api/src/__tests__/integration/monitorConversionFixtures.ts` (explicit fixture implementation shared by these two suites).
- Modify: `apps/api/src/services/workerRegistry.ts:76-85` (Task 12's actual worker registration location; the API entry point delegates to this registry).
- Modify: `apps/api/src/jobs/monitorConversionPreviewWorker.ts` (Task 12's lifecycle exports).
- Test: `apps/api/src/services/workerRegistry.test.ts` (existing), `apps/api/src/jobs/monitorConversionPreviewWorker.test.ts` (Task 12), and the explicit suites below.
- Verified fixture/reference paths: `apps/api/src/__tests__/integration/setup.ts:1-26,68-103,279-390`; `db-utils.ts:129-160`; `monitorDefinitionsPartnerRls.integration.test.ts:29-67,99-138`; `monitorCompiler.integration.test.ts:28-58`; `monitorResolver.integration.test.ts:29-45,145-170`; `apps/api/src/db/schema/devices.ts:421-446`; `apps/api/src/services/alertConditions/handlers/threshold.ts:8-35`.

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
import { alerts, configPolicyAlertRules, monitorConversions, monitorConversionOutputs } from '../../db/schema';
import { getTestRedis } from './setup';
import { convertPolicy, previewPolicyConversion, retireSource, revertConversion } from '../../services/monitors/conversion';
import { evaluateDeviceAlerts, evaluateDeviceAlertsFromPolicy, getApplicableRules } from '../../services/alertService';
import { resolveAlertRulesForDevice } from '../../services/featureConfigResolver';
import { conversionFixture, orgContext, seedConversionDevice } from './monitorConversionFixtures';

describe('conversion round-trip under caller RLS', () => {
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

Worker placement follows the actual runtime import graph: Task 12's preview imports the converter/prerequisite module, which imports `automationRuntime`; its dynamic `softwareDeployment` import (`automationRuntime.ts:2330`) reaches `routes/agentWs.ts` (`softwareDeployment.ts:26`). The registry's closure contract counts dynamic imports, so use `socket-owner` and run that contract below. Do not label this graph global merely because equivalence itself does not dispatch commands.

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

All fixture factories use real UUID rows; the RLS-negative tests run as `breeze_app` through the production context proxy. The shared integration setup truncates the tenant roots with cascade between tests. No synthetic actor is written into a users FK.

At the end of `monitorConversionPreviewWorker.ts`, add the lifecycle wrappers around Task 12's factory:

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

Make the queue singleton and lifecycle agree: replace Task 12's getter with the following concrete getter, using its existing `Queue` and `createInstrumentedQueue` imports. In shutdown, close this variable instead of calling the getter so stopping a worker cannot create a fresh queue.

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

In `workerRegistry.test.ts:31`, insert `'monitorConversionPreviewWorker'` immediately after `'alertWorkers'` in `EXPECTED_WORKER_NAMES`; replace the count assertion at line 91 with `expect(WORKER_REGISTRY.length).toBe(EXPECTED_WORKER_NAMES.length)`. The explicit ordered names still detect accidental additions and removals.

Keep one registry entry only; remove any duplicate initialization added while following Task 12's original `createAlertWorker()` search. This is the actual runtime entry point found during plan completion, not a second startup path.

- [ ] **Step 4: Run the complete verification pass, expect PASS**

Run the following once against the implementation, with the worktree's test stack still running. Each subshell returns to the repository root; none uses `test -- --run`.

```bash
pnpm --filter @breeze/api build
(cd packages/shared && npx vitest run src/validators/monitors.test.ts src/validators/automationActions.test.ts)
(cd apps/api && npx vitest run src/services/monitors/ src/services/automationRuntime src/services/alertCooldown src/services/alertService src/services/offlineAlertEffects src/services/featureConfigResolver src/services/configurationPolicy.monitorsInheritance.test.ts src/services/configurationPolicy.retiredRows.test.ts src/services/retiredSourceReaders.contract.test.ts src/routes/monitorDefinitions src/routes/agents/helpers.monitorWatchDelivery.test.ts src/routes/agents/helpers.partnerWidePolicies.test.ts src/routes/configurationPolicies/featureLinks.monitors.test.ts src/routes/configurationPolicies/featureLinks.test.ts src/jobs/automationWorker.test.ts src/jobs/monitorConversionPreviewWorker.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/modules/mcpInvites/tools/configureDefaults.test.ts src/modules/mcpInvites/tools/configureDefaults.monitors.test.ts src/scripts/migrateToConfigPolicies.test.ts)
(cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/tenantCascade.test.ts src/services/tenantExportPolicyRegistry.tls.test.ts src/services/tenantExportPolicyRegistry.trigger.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts)
(cd apps/web && npx vitest run src/components/monitoring/monitorKindFields.test.ts src/components/monitoring/MonitorEditor src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts src/__tests__/integration/monitorResolver.integration.test.ts src/__tests__/integration/monitorWatchDelivery.integration.test.ts src/__tests__/integration/monitorCompiler.integration.test.ts src/__tests__/integration/monitorDefinitionsPartnerRls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeExecution.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
```

Expect exit 0 from every command, actual executed tests from both new integration files (no skips), and no unhandled rejections or open preview workers. In particular, the forge tests must fail at Postgres with `42501`, not at an application guard; the positive controls must succeed. The existing resolver/watch integration suites cover assignment filters and agent restart delivery. The new continuity suite drives real sweep code and real Redis, rather than asserting only SQL text.

Check migration ordering and drift with the test database explicitly selected. Do not let drift detection fall back to a developer or production database:

```bash
(cd apps/api && node --env-file=../../.env.test --import=tsx -e "const { spawnSync } = require('node:child_process'); const result = spawnSync('pnpm', ['db:check-drift'], { env: process.env, stdio: 'inherit' }); process.exit(result.status ?? 1)")
git fetch origin main
git ls-tree -r --name-only origin/main apps/api/migrations | sort | tail -1
ls apps/api/migrations | sort | tail -1
git diff --check
```

Before pushing, repeat `ls apps/api/migrations | sort | tail -1` in the `origin/main` checkout (or use the recursive `git ls-tree` above without changing the worktree). Each new migration must sort after the newest shipped migration in its dependency order. Task 13's `reused_monitor` addition is a **new** `2026-10-23-121000-monitor-conversion-outputs-reused.sql` in PR3 when PR2 is already merged; never modify the shipped `110000` file. If upstream advanced, bump the unshipped names consistently in the plan, migration references and tests before implementation is pushed. Drift must be zero, scalar retirement columns classified as included, `moved_alert_ids` as `excludedOpen`, and `preview_hash` as `reviewedIncluded`.

Verify the two shared locale keys exist in every actual locale directory (the values were supplied in Task 1), and verify mutation and hash conventions through the named web checks. No new locale key is introduced by Tasks 14–16.

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

Coverage reconciliation: Tasks 1–5 cover shared schemas, kind registration/compiler, runtime/watch params and inheritance; Tasks 6–8 cover all ledger/retirement migrations, six schemas, export/cascade/RLS registrations and retired readers; Tasks 9–13 cover capabilities, source loading, mapping, equivalence/job, conversion/cooldowns/standalone rule service; Task 14 covers the promised routes; Task 15 covers the payload and both identified legacy writers; this task supplies both integration files promised in File Structure and the runtime worker registration. Task numbers 1–16 all exist. Task 13's original five steps were complete at the append boundary; none was rewritten.

- [ ] **Step 5: Commit the verified PR3 gate**

```bash
git add apps/api/src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts apps/api/src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts apps/api/src/__tests__/integration/monitorConversionFixtures.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts apps/api/src/jobs/monitorConversionPreviewWorker.ts
git commit -m "test(monitors): verify conversion isolation, alert continuity, revert and worker lifecycle"
```

Record the actual command outcomes in the implementation PR. PR3 is not ready while any required integration check is skipped or failing; do not claim a green gate from unit tests alone. The plan author does not execute this commit command.

**Open questions for the orchestrator (do not block on them):**

- **Preexisting task numbering and web exception:** this plan's original lines 23–24 call restart params “Task 4”, but their task is 3 (line 511); its Global Constraints line 40 says no web changes, while Task 1 explicitly includes kind-map/editor/locale changes. Preserve the original text; use task titles and the explicit Task 1 files as authoritative when scheduling.
- **Policy alert workflows must be re-homed, not retired:** `apps/api/src/db/schema/configurationPolicies.ts:218-235` has no filter column; this plan's original lines 1834 and 2428 mark broad policy workflows `unconvertible:alert_workflow_kept`. Spec `docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md:405` requires preserving their coverage by re-homing them to standalone workflows assigned to the same policy. Follow that spec in implementation; do not let the W05d sweep retire still-working broad workflows merely because these older task paragraphs call them unconvertible.
- **Response overflow must be surfaced:** this plan's original line 2430 uses `dedupedByFingerprint.slice(0, 10)`, whereas the spec's conversion table at `2026-09-19-alerting-consolidation-design.md:405` carries actions verbatim, with a maximum of ten. Task 10 already specifies `unconvertible:too_many_responses`. Use that explicit refusal before any write, never silent truncation.
- **Standalone ledger cardinality and reversal need source provenance:** `apps/api/src/services/monitors/ruleConversionService.ts:75-97` converts one rule, and `apps/api/src/db/schema/alerts.ts:83-101` allows multiple rules per template. This plan's original lines 2468–2474 key their ledger by template id despite a unique live `(source_table, source_id)` index; its line 2432 restores every moved alert as `rule_id = NULL, config_policy_id = sourceId`. Spec `2026-09-19-alerting-consolidation-design.md:379-384` requires restoration of original `rule_id`/`config_policy_id`. Keep the fixed `ConversionSourceTable` union; resolve multi-rule template grouping and record per-alert original provenance before shipping standalone conversion. Restore moved alert FKs **before** deleting compiled monitor rows: `apps/api/src/db/schema/alerts.ts:107` declares a rule FK, so delete-first can fail.
- **Full-scope equivalence and cached authorization:** the spec at `2026-09-19-alerting-consolidation-design.md:420-425` requires every affected device. This plan's original Task 12 limits the scope to assignments of this policy and keys Redis previews only by policy id (`:2310-2319`), while `apps/api/src/db/index.ts:646-650` does not replace an already active context. Check inheriting-child assignments too; bind cached jobs to the caller's complete access snapshot and reauthorize before returning a cached preview. Do not use `createSystemAuthContext` to widen an interactive preview's application authorization; transport the real principal and scope into the worker.
- **Baseline naming and shipped defaults:** `apps/api/src/db/schema/configurationPolicies.ts:78-104` has no default-policy field. Task 15 uses a marked org baseline policy as the spec's default-policy attachment target. The old bootstrap description at `apps/api/src/modules/mcpInvites/tools/configureDefaults.ts:44` advertises CPU/disk/offline, but `apps/api/src/services/monitors/builtInMonitors.ts:58-99` contains CPU/memory/disk/patch compliance with different windows. Follow the spec's existing partner built-ins, preserving their actual definitions; the old copy is replaced.
- **Historical importer lifecycle and actor:** `apps/api/src/scripts/migrateToConfigPolicies.ts:1-10` explicitly prohibits rerunning the historical script, while it still recreates inline alerts at `:397-409`. The spec at `2026-09-19-alerting-consolidation-design.md:433,501` schedules its deletion for W05d. Task 15 is an interim writer repair only; the script stays historical and is not executed by this plan. `apps/api/src/services/featureConfigResolver.ts:67` uses an all-zero system actor, but `apps/api/src/services/monitors/monitorService.ts:277` persists `auth.user.id`; W05d's automated sweep must also resolve that real-user/nullable-actor contract instead of inserting a nonexistent FK.
- **Event identity collision:** `apps/api/src/jobs/monitorWorker.ts:412-416` uses the legacy network check id in `alerts.context.monitorId`; `apps/api/src/services/alertService.test.ts:201-223` also expects that id in the event payload. Task 15 reserves the new typed event fields for monitor definitions and keeps legacy identity in the source context. Coordinate the W05e consumers before removing any source-specific lookup; never mislabel a `network_monitors.id` as a monitor-definition id.
- **Async preview consumer:** W05c2 `docs/superpowers/plans/monitoring/2026-09-19-alerting-consolidation-w05c2-conversion-web-and-tools.md:25,175-185` assumes a completed preview shape, while this plan's original `:1635-1640,2429` and the spec's >500-device rule require HTTP 202 progress. Task 14 fixes the API contract; W05c2 must poll the same GET endpoint and disable confirm until it receives a completed hash.
- **Queue enqueue boundary:** this plan's original line 2429 enqueues from inside the request's DB context, but `apps/api/src/services/bullmqQueue.ts:60-65` calls `assertOutsideHeldDbContext` before `Queue.add`. Snapshot and authorize within the request, then enqueue outside the held DB context without elevating its scope; retain that caller snapshot in the worker. Do not weaken the tripwire. The runtime closure also requires `socket-owner` placement as implemented in Task 16 (`automationRuntime.ts:2330` → `softwareDeployment.ts:26`).
- **Verification wording:** `apps/api/scripts/check-drift.ts:89-115` compares migration filenames against `breeze_migrations`; it explicitly does not compare live structural schema against Drizzle. Task 16 therefore requires the live RLS/export/cascade suites in addition to a successful drift command; a zero filename delta alone does not prove schema parity.
