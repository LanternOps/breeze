# Alerts / Monitoring Feature Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `alert_rule` config-policy feature the sole owner of every server-evaluated alert rule (metric, offline, event-log), and shrink the `monitoring` feature to what the agent actually consumes (service/process watches + check interval) — eliminating the duplicated rule editor, duplicate-alert footgun, cross-feature shadowing bug, and the validation asymmetry between the two write paths.

**Architecture:** Boundary is *evaluation locus*, not topic. Server-evaluated rules (alert worker reads `device_metrics` / `device_event_logs`) all live in `config_policy_alert_rules` rows hung off an `alert_rule` feature link. Agent-delivered config (watches, auto-restart, check interval) stays under `monitoring`. A one-time idempotent SQL migration moves existing rule rows **in place** (UPDATE `feature_link_id`, preserving row ids because `alerts.config_policy_id` stores the rule id), rebuilds both JSONB `inline_settings` mirrors, then the resolver drops its `'monitoring'` branch.

**Tech Stack:** Drizzle ORM, hand-written SQL migrations (autoMigrate), Zod (shared validators), Vitest, React (config policy feature tabs).

**Design provenance:** Advisor quorum 2026-07-30 — Fable and Codex (gpt-5.6-sol, xhigh, read-only) independently converged on this design ("Option A+"). Codex-verified facts incorporated below: all five extended condition types (`bandwidth_high`, `disk_io_high`, `network_errors`, `patch_compliance`, `cert_expiry`) have registered handlers but real bugs (field-name mismatch `networkDirection`/`diskDirection` vs `direction`, bytes-vs-bits 8× error, cumulative-counter overcounting, no freshness guard, mTLS-cert-only scope); `custom` has **no** handler and never fires; event-log alerts are evaluated server-side only (agent never receives them); `alerts.config_policy_id` stores `config_policy_alert_rules.id` and auto-resolve reloads that row.

## Global Constraints

- Migration file naming: `YYYY-MM-DD-<slug>.sql`, idempotent, no inner `BEGIN;`/`COMMIT;`, cleanup statements report row counts via `RAISE WARNING` (CLAUDE.md migration rules). Never edit a shipped migration.
- `config_policy_alert_rules` already has RLS + cascade registration; **no new tables are created** by this plan, so no allowlist/cascade/export-policy registration is needed. No columns are added either.
- The migration runs privileged (autoMigrate): every row move MUST join source and target feature links on the **same `config_policy_id`** — never by feature type or tenant alone.
- Rule row ids MUST be preserved on move (`UPDATE ... SET feature_link_id`, never copy/delete) — `alerts.config_policy_id` references them (`apps/api/src/services/alertService.ts:767`).
- Resolver cutover (Task 6) MUST NOT ship before the migration (Task 4) — autoMigrate runs at boot before serving, so same release is safe; earlier release is not.
- `pnpm test` does not run the integration/RLS contract suites — run `vitest -c vitest.integration.config.ts` explicitly for Tasks 4–6 (needs local Postgres).
- Node 22.20.0; run `pnpm --filter @breeze/api test` and `pnpm --filter @breeze/web test` per task, plus typecheck via turbo build where noted.

## File Structure (what changes where)

| File | Change |
|---|---|
| `packages/shared/src/validators/index.ts` | New canonical `alertRuleConditionSchema` (discriminated union) + `alertRuleInlineSettingsSchema`; `monitoringInlineSettingsSchema` loses `eventLogAlerts`/`alertRules` (rejects non-empty legacy arrays with a clear message) |
| `apps/api/src/services/configurationPolicy.ts` | `alert_rule` decompose validates via canonical schema; `monitoring` decompose stops writing `config_policy_alert_rules`; `monitoring` assemble stops reading them; `alert_rule` assemble handles event-log items |
| `apps/api/migrations/2026-07-30-alert-rule-ownership-consolidation.sql` | In-place row move + fingerprint dedupe + JSONB mirror rebuild + postcondition check |
| `apps/api/src/services/featureConfigResolver.ts` | `resolveAlertRulesForDevice` joins `featureType = 'alert_rule'` only |
| `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.tsx` | Remove "Metric & Status Alert Rules" + "Event Log Alerts" sections; pointer copy to Alerts tab |
| `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx` | Add `event_log` condition editor; remove dead `custom` type |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` | Clarified `FEATURE_META` labels/descriptions |
| `apps/api/src/services/aiToolsConfigPolicy.ts` | Updated inline-settings shape docs for both feature types |
| `apps/docs/` | Customer-facing "Alerts vs Monitoring" explanation (via update-breeze-docs skill) |

---

### Task 1: Canonical alert-rule condition schema (shared validators)

**Files:**
- Modify: `packages/shared/src/validators/index.ts` (near line 755, `monitoringInlineSettingsSchema`)
- Test: `packages/shared/src/validators/alertRuleConditions.test.ts` (new, co-located per repo convention)

**Interfaces:**
- Produces: `alertRuleConditionSchema` (Zod discriminated union on `type`), `alertRuleItemSchema`, `alertRuleInlineSettingsSchema = z.object({ items: z.array(alertRuleItemSchema).max(100).default([]) })` — consumed by Tasks 2, 3, 8.

Supported condition types for **writes**: `metric` (alias input `threshold` normalized to `metric`? No — store what the evaluator registers: keep `metric` and `offline` as the UI-facing names since the evaluator aliases them), `offline` (accept legacy `status` on read, canonicalize to `offline` on write), `event_log`. The five extended types and `custom` are **rejected on write** (extended types graduate later — see Follow-ups; `custom` has no handler). Reads stay tolerant: `assembleInlineSettings` never parses.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/validators/alertRuleConditions.test.ts
import { describe, expect, it } from 'vitest';
import { alertRuleConditionSchema, alertRuleInlineSettingsSchema, monitoringInlineSettingsSchema } from './index';

describe('alertRuleConditionSchema', () => {
  it('accepts a metric condition', () => {
    const r = alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'cpu', operator: 'gt', value: 85, duration: 300 });
    expect(r.success).toBe(true);
  });

  it('accepts an offline condition and canonicalizes legacy status', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'offline', durationMinutes: 10 }).success).toBe(true);
    const legacy = alertRuleConditionSchema.safeParse({ type: 'status', durationMinutes: 10 });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect(legacy.data.type).toBe('offline');
  });

  it('accepts an event_log condition', () => {
    const r = alertRuleConditionSchema.safeParse({
      type: 'event_log', category: 'system', level: 'error',
      sourcePattern: 'disk', countThreshold: 3, windowMinutes: 15,
    });
    expect(r.success).toBe(true);
  });

  it('rejects custom (no evaluator handler) and unreleased extended types', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'custom', customCondition: 'x' }).success).toBe(false);
    expect(alertRuleConditionSchema.safeParse({ type: 'bandwidth_high', value: 100 }).success).toBe(false);
  });

  it('rejects a metric condition with no metric name', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'metric', operator: 'gt', value: 85 }).success).toBe(false);
  });
});

describe('alertRuleInlineSettingsSchema', () => {
  it('parses items with defaults', () => {
    const r = alertRuleInlineSettingsSchema.parse({
      items: [{ name: 'High CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }] }],
    });
    expect(r.items[0]!.severity).toBe('medium');
    expect(r.items[0]!.cooldownMinutes).toBe(5);
  });
});

describe('monitoringInlineSettingsSchema (post-consolidation)', () => {
  it('rejects non-empty legacy alertRules with a pointer message', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      checkIntervalSeconds: 60, watches: [],
      alertRules: [{ name: 'x', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }] }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('Alerts feature');
  });

  it('rejects non-empty legacy eventLogAlerts', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      eventLogAlerts: [{ name: 'x', category: 'system', level: 'error' }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts empty/absent legacy arrays (stale clients sending [])', () => {
    expect(monitoringInlineSettingsSchema.safeParse({ checkIntervalSeconds: 60, watches: [], alertRules: [], eventLogAlerts: [] }).success).toBe(true);
    expect(monitoringInlineSettingsSchema.safeParse({ watches: [{ watchType: 'service', name: 'MSSQLSERVER' }] }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/shared test -- alertRuleConditions` → FAIL (`alertRuleConditionSchema` not exported).

- [ ] **Step 3: Implement in `packages/shared/src/validators/index.ts`** (insert directly above `monitoringInlineSettingsSchema`):

```typescript
const metricConditionSchema = z.object({
  type: z.literal('metric'),
  metric: z.enum(['cpu', 'ram', 'memory', 'disk']),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
  value: z.number(),
  duration: z.number().int().min(0).max(86400).optional(), // seconds the condition must hold
});

const offlineConditionSchema = z.object({
  type: z.enum(['offline', 'status']).transform(() => 'offline' as const),
  durationMinutes: z.number().int().min(1).max(10080).optional(),
});

const eventLogConditionSchema = z.object({
  type: z.literal('event_log'),
  category: z.enum(['security', 'hardware', 'application', 'system']),
  level: z.enum(['warning', 'error', 'critical']),
  sourcePattern: z.string().max(500).optional(),
  messagePattern: z.string().max(500).optional(),
  countThreshold: z.number().int().min(1).max(10000).default(1),
  windowMinutes: z.number().int().min(1).max(1440).default(15),
});

// Canonical write-path schema for server-evaluated alert rule conditions.
// Extended types (bandwidth_high, disk_io_high, network_errors, patch_compliance,
// cert_expiry) have evaluator handlers but known payload/unit bugs — they are
// write-blocked until fixed (see plans/monitoring/2026-07-30 follow-ups). `custom`
// has no handler at all. Reads of existing rows remain tolerant (no parse on read).
export const alertRuleConditionSchema = z.union([
  metricConditionSchema,
  offlineConditionSchema,
  eventLogConditionSchema,
]);

export const alertRuleItemSchema = z.object({
  name: z.string().min(1).max(200),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('medium'),
  conditions: z.array(alertRuleConditionSchema).min(1).max(10),
  cooldownMinutes: z.number().int().min(1).max(1440).default(5),
  autoResolve: z.boolean().default(false),
  autoResolveConditions: z.array(alertRuleConditionSchema).nullable().optional(),
  titleTemplate: z.string().max(500).optional(),
  messageTemplate: z.string().max(2000).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const alertRuleInlineSettingsSchema = z.object({
  items: z.array(alertRuleItemSchema).max(100).default([]),
});
```

Then edit `monitoringInlineSettingsSchema`: delete the `eventLogAlerts` and `alertRules` object shapes and replace both keys with write-barrier stubs (keep the keys so stale clients sending `[]` still parse):

```typescript
  // Write barrier (2026-07-30 consolidation): server-evaluated rules moved to the
  // alert_rule feature. Empty arrays from stale clients are tolerated; non-empty
  // payloads are rejected so stale editor sessions can't resurrect ghost rules.
  eventLogAlerts: z.array(z.never(), {
    message: 'Event log alert rules have moved to the Alerts feature of this policy',
  }).max(0, 'Event log alert rules have moved to the Alerts feature of this policy').default([]),
  alertRules: z.array(z.never(), {
    message: 'Metric alert rules have moved to the Alerts feature of this policy',
  }).max(0, 'Metric alert rules have moved to the Alerts feature of this policy').default([]),
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @breeze/shared test -- alertRuleConditions` → PASS. Also run the full shared suite (`pnpm --filter @breeze/shared test`) to catch consumers of the old shapes.

- [ ] **Step 5: Commit** — `git commit -m "feat(validators): canonical alert-rule condition schema + monitoring write barrier"`

---

### Task 2: Validate the `alert_rule` decompose path (closes the no-validation hole)

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` — `decomposeInlineSettings`, `case 'alert_rule'` (~line 395)
- Test: `apps/api/src/services/configurationPolicy.test.ts` (extend existing suite)

**Interfaces:**
- Consumes: `alertRuleInlineSettingsSchema` from Task 1 (import from `@breeze/shared`).
- Produces: `case 'alert_rule'` now throws `ZodError` on invalid conditions; stored rows come from the **parsed** result (defaults applied), not the raw input.

- [ ] **Step 1: Write the failing test** — in the existing `configurationPolicy.test.ts` describe block for decompose (follow the file's existing Drizzle mock pattern — see `breeze-testing` skill):

```typescript
it('rejects alert_rule inlineSettings with an unknown condition type', async () => {
  await expect(
    addFeatureLink(policyId, {
      featureType: 'alert_rule',
      inlineSettings: { items: [{ name: 'bad', conditions: [{ type: 'custom', customCondition: 'x' }] }] },
    }, auth)
  ).rejects.toThrow(/invalid|custom/i);
});

it('applies schema defaults when storing alert_rule rows', async () => {
  await addFeatureLink(policyId, {
    featureType: 'alert_rule',
    inlineSettings: { items: [{ name: 'High CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }] }] },
  }, auth);
  // assert the mocked insert received severity 'medium', cooldownMinutes 5
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- configurationPolicy` → FAIL (invalid type currently stored silently).

- [ ] **Step 3: Implement** — replace the body of `case 'alert_rule'` in `decomposeInlineSettings` with:

```typescript
    case 'alert_rule': {
      const parsed = alertRuleInlineSettingsSchema.parse(s);
      if (parsed.items.length > 0) {
        await tx.insert(configPolicyAlertRules).values(
          parsed.items.map((item, idx) => ({
            featureLinkId: linkId,
            name: item.name,
            severity: item.severity,
            conditions: item.conditions,
            cooldownMinutes: item.cooldownMinutes,
            autoResolve: item.autoResolve,
            autoResolveConditions: item.autoResolveConditions ?? null,
            titleTemplate: item.titleTemplate ?? '{{ruleName}} triggered on {{deviceName}}',
            messageTemplate: item.messageTemplate ?? '{{ruleName}} condition met',
            sortOrder: item.sortOrder ?? idx,
          }))
        );
      }
      break;
    }
```

Add `alertRuleInlineSettingsSchema` to the existing `@breeze/shared` validator import at the top of the file (next to `monitoringInlineSettingsSchema`).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @breeze/api test -- configurationPolicy` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(config-policy): validate alert_rule inline settings on write"`

---

### Task 3: Stop the `monitoring` decompose/assemble from touching alert rules

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` — `case 'monitoring'` in `decomposeInlineSettings` (~line 541) and in `assembleInlineSettings` (~line 1030)
- Test: `apps/api/src/services/configurationPolicy.test.ts`

**Interfaces:**
- Consumes: barrier-enforcing `monitoringInlineSettingsSchema` from Task 1 (non-empty `alertRules`/`eventLogAlerts` now throw at `.parse`).
- Produces: monitoring decompose writes ONLY `configPolicyMonitoringSettings` + `configPolicyMonitoringWatches`; monitoring assemble returns `{ checkIntervalSeconds, watches }` (no `eventLogAlerts`, no `alertRules` keys); `alert_rule` assemble returns event-log rows as ordinary items (conditions passthrough already handles this — verify, don't rewrite).

- [ ] **Step 1: Write the failing tests**

```typescript
it('monitoring decompose no longer inserts config_policy_alert_rules rows', async () => {
  await addFeatureLink(policyId, {
    featureType: 'monitoring',
    inlineSettings: { checkIntervalSeconds: 60, watches: [{ watchType: 'service', name: 'MSSQLSERVER' }] },
  }, auth);
  // assert configPolicyAlertRules insert mock was NOT called
});

it('monitoring decompose rejects legacy non-empty alertRules payloads', async () => {
  await expect(addFeatureLink(policyId, {
    featureType: 'monitoring',
    inlineSettings: { alertRules: [{ name: 'x', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }] }] },
  }, auth)).rejects.toThrow(/moved to the Alerts feature/);
});

it('monitoring assemble returns only interval and watches', async () => {
  const settings = await assembleInlineSettings(monitoringLinkId, 'monitoring');
  expect(Object.keys(settings!).sort()).toEqual(['checkIntervalSeconds', 'watches']);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- configurationPolicy` → FAIL.

- [ ] **Step 3: Implement**
  - In `decomposeInlineSettings` `case 'monitoring'`: delete the two blocks commented `// Insert event log alert rules (only enabled ones)` and `// Insert metric/status/custom alert rules` (the schema barrier from Task 1 makes non-empty inputs unreachable anyway — the deletion is so the code matches the model).
  - In `assembleInlineSettings` `case 'monitoring'`: delete the `configPolicyAlertRules` select, the `eventLogAlerts` mapping block, and the `metricAlertRules` mapping block; return only `{ checkIntervalSeconds: settingsRow.checkIntervalSeconds, watches: [...] }` (keep the existing watches mapping verbatim).
  - Confirm `assembleInlineSettings` `case 'alert_rule'` maps rows generically (name/severity/conditions/cooldown/autoResolve/templates/sortOrder) — event-log rows round-trip through it with no special casing. If it currently omits any of those columns, add them.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @breeze/api test -- configurationPolicy` → PASS. Also `pnpm --filter @breeze/api test` (full unit suite) — `aiToolsConfigPolicy` tests may assert the old monitoring shape; update those assertions in the same commit.

- [ ] **Step 5: Commit** — `git commit -m "refactor(config-policy): monitoring feature owns only agent-side watches"`

---

### Task 4: Data migration — move rule rows to the `alert_rule` link in place

**Files:**
- Create: `apps/api/migrations/2026-07-30-alert-rule-ownership-consolidation.sql`
- Test: `apps/api/src/__tests__/integration/alertRuleOwnershipMigration.integration.test.ts` (new; integration config, real Postgres)

**Interfaces:**
- Consumes: nothing from other tasks (pure SQL, runs at boot before Task 6's code serves traffic).
- Produces: postcondition — zero rows in `config_policy_alert_rules` whose `feature_link_id` belongs to a `monitoring` feature link; both `inline_settings` mirrors rebuilt.

- [ ] **Step 1: Write the failing integration test** (pattern: existing `apps/api/src/__tests__/integration/*.integration.test.ts` suites; seed via raw SQL as the migration itself is raw SQL):

```typescript
// Seeds: one org-owned config policy with a monitoring feature link carrying
// 2 alert-rule rows (one metric, one event_log), one of which exactly duplicates
// a row already under an existing alert_rule link; plus one policy with a
// monitoring link and NO alert_rule link; plus an `alerts` row pointing at the
// duplicate rule id. Then re-runs the migration file via the autoMigrate runner
// (or executes the file's SQL directly) and asserts:
it('moves rule rows to the alert_rule link preserving ids', ...);       // same rule id, new feature_link_id
it('creates an alert_rule link when the policy has none', ...);
it('dedupes exact fingerprints and repoints alerts.config_policy_id', ...);
it('strips alertRules/eventLogAlerts from the monitoring inline_settings mirror', ...);
it('rebuilds the alert_rule inline_settings items mirror from normalized rows', ...);
it('is idempotent — second run changes zero rows', ...);
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts alertRuleOwnershipMigration` → FAIL (migration file absent).

- [ ] **Step 3: Write the migration**

```sql
-- 2026-07-30-alert-rule-ownership-consolidation.sql
-- Moves all server-evaluated alert rules from monitoring feature links to the
-- policy's alert_rule feature link (creating one where absent), dedupes exact
-- fingerprints, and rebuilds both inline_settings JSONB mirrors.
-- Rule row ids are preserved (alerts.config_policy_id references them).

-- 1. Ensure every policy that has monitoring-owned rules also has an alert_rule link.
DO $$
DECLARE n integer;
BEGIN
  WITH policies_needing_link AS (
    SELECT DISTINCT ml.config_policy_id
    FROM config_policy_feature_links ml
    JOIN config_policy_alert_rules r ON r.feature_link_id = ml.id
    WHERE ml.feature_type = 'monitoring'
      AND NOT EXISTS (
        SELECT 1 FROM config_policy_feature_links al
        WHERE al.config_policy_id = ml.config_policy_id
          AND al.feature_type = 'alert_rule'
      )
  )
  INSERT INTO config_policy_feature_links (id, config_policy_id, feature_type, feature_policy_id, inline_settings, created_at, updated_at)
  SELECT gen_random_uuid(), p.config_policy_id, 'alert_rule', NULL, '{"items": []}'::jsonb, now(), now()
  FROM policies_needing_link p
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'consolidation: created % alert_rule feature links', n; END IF;
END $$;

-- 2. Dedupe: a monitoring-owned rule whose exact fingerprint already exists under
--    the same policy's alert_rule link is deleted — after repointing any alerts
--    that reference it. Fingerprint = (name, severity, conditions, cooldown, autoResolve).
DO $$
DECLARE n integer; m integer;
BEGIN
  CREATE TEMP TABLE _dupe_rules ON COMMIT DROP AS
  SELECT src.id AS dupe_id, tgt.id AS keep_id
  FROM config_policy_alert_rules src
  JOIN config_policy_feature_links ml ON ml.id = src.feature_link_id AND ml.feature_type = 'monitoring'
  JOIN config_policy_feature_links al ON al.config_policy_id = ml.config_policy_id AND al.feature_type = 'alert_rule'
  JOIN config_policy_alert_rules tgt ON tgt.feature_link_id = al.id
    AND tgt.name = src.name
    AND tgt.severity = src.severity
    AND tgt.conditions = src.conditions
    AND tgt.cooldown_minutes = src.cooldown_minutes
    AND tgt.auto_resolve = src.auto_resolve;

  UPDATE alerts a SET config_policy_id = d.keep_id
  FROM _dupe_rules d WHERE a.config_policy_id = d.dupe_id;
  GET DIAGNOSTICS m = ROW_COUNT;

  DELETE FROM config_policy_alert_rules r USING _dupe_rules d WHERE r.id = d.dupe_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 OR m > 0 THEN
    RAISE WARNING 'consolidation: removed % duplicate rules, repointed % alerts', n, m;
  END IF;
END $$;

-- 3. Move remaining monitoring-owned rules in place (same-policy join; ids preserved).
DO $$
DECLARE n integer;
BEGIN
  UPDATE config_policy_alert_rules r
  SET feature_link_id = al.id, updated_at = now()
  FROM config_policy_feature_links ml,
       config_policy_feature_links al
  WHERE r.feature_link_id = ml.id
    AND ml.feature_type = 'monitoring'
    AND al.config_policy_id = ml.config_policy_id
    AND al.feature_type = 'alert_rule';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'consolidation: moved % alert rules to alert_rule links', n; END IF;
END $$;

-- 4. Rebuild mirrors.
--    Monitoring links: strip the migrated keys.
UPDATE config_policy_feature_links
SET inline_settings = (inline_settings - 'alertRules' - 'eventLogAlerts'), updated_at = now()
WHERE feature_type = 'monitoring'
  AND inline_settings IS NOT NULL
  AND (inline_settings ? 'alertRules' OR inline_settings ? 'eventLogAlerts');

--    Alert_rule links that received rows: rebuild items[] from normalized rows.
UPDATE config_policy_feature_links al
SET inline_settings = jsonb_build_object('items', COALESCE(sub.items, '[]'::jsonb)), updated_at = now()
FROM (
  SELECT feature_link_id, jsonb_agg(jsonb_build_object(
    'name', name, 'severity', severity, 'conditions', conditions,
    'cooldownMinutes', cooldown_minutes, 'autoResolve', auto_resolve,
    'autoResolveConditions', auto_resolve_conditions,
    'titleTemplate', title_template, 'messageTemplate', message_template,
    'sortOrder', sort_order
  ) ORDER BY sort_order, created_at) AS items
  FROM config_policy_alert_rules
  GROUP BY feature_link_id
) sub
WHERE sub.feature_link_id = al.id
  AND al.feature_type = 'alert_rule';

-- 5. Postcondition: no rules may remain under monitoring links.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM config_policy_alert_rules r
  JOIN config_policy_feature_links ml ON ml.id = r.feature_link_id
  WHERE ml.feature_type = 'monitoring';
  IF n > 0 THEN
    RAISE EXCEPTION 'consolidation postcondition failed: % rules still under monitoring links', n;
  END IF;
END $$;
```

> Note: check the actual column list of `config_policy_feature_links` in `apps/api/src/db/schema/configurationPolicies.ts` before finalizing step 1's INSERT (e.g. whether `updated_at` exists) and adjust. The `UNIQUE (config_policy_id, feature_type)` constraint makes `ON CONFLICT DO NOTHING` a true idempotency guard.

- [ ] **Step 4: Run to verify pass** — integration suite from Step 1 → PASS. Also run `apps/api/src/db/autoMigrate.test.ts` (ordering regression) and `pnpm db:check-drift`.

- [ ] **Step 5: Commit** — `git commit -m "feat(migrations): consolidate alert-rule ownership under alert_rule feature links"`

---

### Task 5: `migrateToConfigPolicies` script sweep

**Files:**
- Modify: `apps/api/src/scripts/migrateToConfigPolicies.ts` (it inserts `configPolicyAlertRules` rows — ensure any rows it creates hang off `alert_rule` links, never `monitoring`)

- [ ] **Step 1:** Read the script; if it already targets `alert_rule` links only, record that in the commit message and skip to Step 3.
- [ ] **Step 2:** If it writes rules under monitoring links, change the target link resolution to the policy's `alert_rule` link (create-if-absent, mirroring Task 4 semantics in TS).
- [ ] **Step 3:** Run its existing tests (`pnpm --filter @breeze/api test -- migrateToConfigPolicies`) and commit — `git commit -m "chore(scripts): legacy config-policy migrator writes rules to alert_rule links"`.

---

### Task 6: Resolver cutover (fixes cross-feature shadowing)

**Files:**
- Modify: `apps/api/src/services/featureConfigResolver.ts:270-273` (`resolveAlertRulesForDevice`)
- Test: `apps/api/src/services/featureConfigResolver.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4's postcondition (no rules under monitoring links).
- Produces: `resolveAlertRulesForDevice` unchanged signature; join filter becomes `eq(configPolicyFeatureLinks.featureType, 'alert_rule')`.

- [ ] **Step 1: Write the failing test** — a monitoring-link rule row (simulating pre-migration data) must NOT be returned; an alert_rule-link rule must be. Also add a regression test documenting the old shadowing bug: with rules only under `alert_rule` links, a device-level policy and a site-level policy resolve to the device-level policy's rules (winning-assignment semantics now operate within a single feature type).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- featureConfigResolver` → FAIL.

- [ ] **Step 3: Implement** — replace:

```typescript
        inArray(configPolicyFeatureLinks.featureType, ['alert_rule', 'monitoring'])
```

with:

```typescript
        // Server-evaluated rules live exclusively under alert_rule links since the
        // 2026-07-30 ownership consolidation migration.
        eq(configPolicyFeatureLinks.featureType, 'alert_rule')
```

(drop the now-unused `inArray` import if nothing else uses it).

- [ ] **Step 4: Run to verify pass** — resolver unit tests, then the alert-path suites: `pnpm --filter @breeze/api test -- alertService alertWorker`. Run the integration config suites touching alerts if present.

- [ ] **Step 5: Commit** — `git commit -m "fix(alerts): resolve rules from alert_rule links only (removes cross-feature shadowing)"`

---

### Task 7: Web UI — MonitoringTab slims down, AlertRuleTab gains event-log conditions

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts` (`FEATURE_META`)
- Test: co-located `MonitoringTab.test.tsx` / `AlertRuleTab.test.tsx` (extend or create, jsdom)

Per the standing rule, UI work stays in-session (not delegated to codex).

- [ ] **Step 1: MonitoringTab** — remove the "Event Log Alerts" section and the "Metric & Status Alert Rules" section (~line 907) plus their state, defaults (line ~148 `{type:'metric',...}`), and the condition-type option list (~line 71). Keep: check interval + watches editor. Where the removed sections sat, render a single pointer line: `Device thresholds and event log alerts are configured in the Alerts feature of this policy.` styled like existing inter-tab hints. The tab no longer sends `alertRules`/`eventLogAlerts` keys at all (satisfies the Task 1 barrier).
- [ ] **Step 2: AlertRuleTab** — remove `custom` from the condition type options (`AlertRuleTab.tsx:142-157`; it has no evaluator handler and never fires). Add `event_log` as a condition type with fields: category (`security|hardware|application|system`), level (`warning|error|critical`), optional source pattern, optional message pattern, count threshold (default 1), window minutes (default 15) — mirroring `eventLogConditionSchema` from Task 1. Reuse the existing condition-row editing pattern in the file.
- [ ] **Step 3: `FEATURE_META` in types.ts** — update labels/descriptions: `alert_rule` → label "Alerts", description "Server-evaluated alert rules: CPU/RAM/disk thresholds, offline detection, event log alerts"; `monitoring` → label "Service & Process Monitoring", description "Agent-side watches: service/process stop detection, auto-restart, resource limits per process".
- [ ] **Step 4: Tests** — jsdom tests asserting: MonitoringTab renders no metric-rule editor and never includes `alertRules` in its save payload; AlertRuleTab offers `metric`, `offline`, `event_log` and not `custom`; event_log condition round-trips through the form state. Run `pnpm --filter @breeze/web test -- MonitoringTab AlertRuleTab` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): consolidate alert rule editing into the Alerts feature tab"`

---

### Task 8: AI tool descriptions + docs

**Files:**
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts` — `manage_policy_feature_link` inline-settings shape docs: monitoring shape drops `eventLogAlerts`/`alertRules` (note the barrier error), alert_rule shape documents `items[].conditions` with the three supported types including the `event_log` fields.
- Modify: `apps/api/src/services/aiToolsFleet.ts` — sweep for monitoring-shape references (it reads `configPolicyMonitoringSettings`; verify no alert-rule coupling).
- Docs: run the **update-breeze-docs** skill for `apps/docs/` — add/refresh an "Alerts vs Monitoring" section: Alerts = server-evaluated thresholds/offline/event-log; Monitoring = agent-side service & process watches; note the one-policy-can-have-both model and that duplicating a threshold across policies at different levels resolves closest-wins.

- [ ] **Step 1:** Update both tool descriptions; run `pnpm --filter @breeze/api test -- aiTools` → PASS.
- [ ] **Step 2:** Invoke update-breeze-docs for the docs change.
- [ ] **Step 3:** Commit — `git commit -m "docs(config-policy): alerts vs monitoring boundary + AI tool shapes"`

---

### Task 9: Full verification pass

- [ ] `pnpm --filter @breeze/api test` and `pnpm --filter @breeze/web test` and `pnpm --filter @breeze/shared test` — all green.
- [ ] Integration suites (real Postgres, port 5433 per repo convention): the new migration suite, `rls-coverage.integration.test.ts`, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts` — no new tables/columns, so these must stay green untouched; a failure means the migration changed something it shouldn't have.
- [ ] Manual E2E on the wt-stack (worktree-stack skill): create a policy, add Alerts feature with a CPU>85 rule and an event-log rule, assign to an org, confirm the alert worker fires against a seeded device metric; confirm MonitoringTab saves watches without error; confirm a pre-migration-shaped policy (seed via SQL) renders correctly after boot.
- [ ] Because this PR may sit on a stacked branch: dispatch CI per branch (`gh workflow run CI --ref <branch>`) — integration suites don't run on PR jobs and stacked PRs get no CI at all.

---

## Explicitly Out of Scope — file as follow-up GitHub issues at kickoff

1. **Extended condition-type handler bugs** (graduate into Alerts tab only after these are fixed with dedicated tests): `bandwidth_high`/`disk_io_high` UI↔evaluator field mismatch (`networkDirection`/`diskDirection` vs `direction`) and the bytes-vs-bits 8× threshold error; `network_errors` summing cumulative interface counters (needs deltas); `patch_compliance` freshness guard; `cert_expiry` label (it checks the agent mTLS cert, not arbitrary site certs). No tests exist for any of the five handlers.
2. **`custom` condition type**: no registered handler — either implement or delete from schema/evaluator registry tolerance. UI exposure is removed by Task 7.
3. **Agent monitoring-config delivery gaps** (`apps/api/src/routes/agents/helpers.ts`): (a) zero watches returns `null` so stale watches can never be cleared on the agent (`helpers.ts:2012`, agent supports empty config at `monitor.go:269`); (b) **partner-wide monitoring policies are excluded by an org-only predicate and role/OS assignment filters are ignored** (`helpers.ts:1984`) — this is a Partner-Wide First violation (CLAUDE.md epic #2135) and likely warrants priority; (c) `alertSeverity` is not delivered to the agent and `alertOnStop`/consecutive-failure settings don't currently drive alert creation.
4. **Watch-generated alerts** use `service_stopped`/`process_stopped`/`process_cpu_high`/`process_memory_high` handler types server-side — audit how watch reports become alerts and whether severity flows through (relates to 3c).
