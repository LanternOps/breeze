---
title: Pre-cap AI budget alerts — implementation plan
issue: LanternOps/breeze#4388
spec: docs/superpowers/specs/ai-mcp/2026-09-01-ai-budget-threshold-alerts-design.md
tracking_issue: LanternOps/breeze#4388
date: 2026-09-01
---

# Pre-cap AI Budget Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn partner admins in-app and by email when an org crosses 50/80/95/100 % of its daily or monthly AI budget, and when the partner's hosted AI credit wallet runs low, before the existing hard stop fires.

**Architecture:** Wave 1 adds a per-org/partner-inheritable `alertThresholdPercents` setting and an inline evaluator that writes one durable `ai_budget_alert_events` row per crossing (highest rung only, monotonic per period). Wave 2 delivers each event through a BullMQ worker: in-app `user_notifications` (dedupe key = event id), one transactional email to partner-side `billing:manage` holders, an event-bus publish, and a 15-minute reconcile job. Wave 3 surfaces thresholds and fired markers in the API and the two budget settings pages. Wave 4 (breeze-billing repo) measures credit consumption against a persisted replenishment baseline, evaluates inside `deductCredits`, and emails `partners.billingEmail`; the API then surfaces the credit balance.

**Tech Stack:** Hono + Drizzle + Postgres (RLS shape 1), BullMQ, Vitest, React + react-i18next, breeze-billing (node-cron, postgres.js, boot-time DDL).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-01-ai-budget-threshold-alerts-design.md` — read §4 (wave 1–3 design), §5 (credits), §6 (edge cases) before starting any task.

## Global Constraints

- New migration filename must sort **after** `apps/api/migrations/2026-09-27-technician-ticket-write-permissions.sql` (the newest committed file as of 2026-09-01 — re-check with `ls apps/api/migrations/*.sql | sort | tail -1` before creating). Use `2026-09-28-ai-budget-alert-events.sql`. Idempotent; no inner `BEGIN/COMMIT`.
- Every new `org_id` table/column: RLS policy in the same migration, plus registration in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, and `orgMergeRegistry` (task 1). Adding a column to `ai_budgets` also requires an export-policy update.
- Default ladder `[50, 80, 95]`; rung `100` always implicit; validator range 1–99, max 5 entries; empty array = pre-cap warnings off.
- Recipients = active users holding `billing:manage` (wildcard-aware) who are org members or partner users covering the org. Never `organizations:write`.
- Email policy: monthly rungs and any 100 % rung → in-app + email; daily 50/80/95 → in-app only.
- In-app notification `link` must be a single-leading-slash relative path (CHECK constraint `user_notifications_link_relative_chk`). Use `/settings/ai-usage`.
- Web strings go into **all eight** `apps/web/src/locales/*/settings.json` files (`localeParity.test.ts`). Emails are English only.
- Cost aggregates are `real` (float): compute `pct = Math.floor((usedCents * 100) / capCents)`; treat `capCents` null/undefined/≤ 0 as "no cap" (mirrors enforcement's truthiness).
- Run one test file as `cd apps/api && npx vitest run <path>` (never `pnpm ... test -- --run`). Integration suites: `npx vitest run --config vitest.integration.config.ts <path>` with a live DB.
- Commit after every task; each wave is one PR with `Closes #<wave sub-issue>` in the body, branch `feature/4388-ai-budget-alerts/wave-<subissue#>`.

## Waves

| Wave | Deliverable | PR scope |
|---|---|---|
| W01 (#4389, branch `feature/4388-ai-budget-alerts/wave-4389`) | Schema + config + evaluator (tasks 1–5) | breeze |
| W02 (#4390, branch `feature/4388-ai-budget-alerts/wave-4390`) | Recipients + email + delivery worker + partner fan-out (tasks 6–9) | breeze |
| W03 (#4391, branch `feature/4388-ai-budget-alerts/wave-4391`) | `/ai/usage` alerts block + effective-budget fix + web settings UI (tasks 10–12) | breeze |
| W04 (#4392, branch `feature/4388-ai-budget-alerts/wave-4392`) | Credit low-balance alerts (tasks 13–17 in breeze-billing) + API/web credit surface (task 18) | breeze-billing + breeze |

## File Structure

**Create (breeze):**
- `apps/api/migrations/2026-09-28-ai-budget-alert-events.sql` — column + table + RLS.
- `apps/api/src/services/aiBudgetAlerts.ts` — pure rung math + `evaluateAiBudgetThresholds(orgId)` (creates event rows, hands ids to the delivery queue).
- `apps/api/src/services/aiBudgetAlerts.test.ts`
- `apps/api/src/services/usersWithPermission.ts` — `resolveUsersWithPermissionForOrg(orgId, permission)` (generalised from `resolveIntentApprovers`).
- `apps/api/src/services/usersWithPermission.test.ts`
- `apps/api/src/services/aiBudgetAlertEmail.ts` — `describeAiBudgetAlert` (title/message) + `buildAiBudgetAlertEmail` (subject/html/text).
- `apps/api/src/services/aiBudgetAlertEmail.test.ts`
- `apps/api/src/jobs/aiBudgetAlertDelivery.ts` — queue, `deliverAiBudgetAlert(eventId)`, reconcile + partner fan-out job types, worker init/shutdown.
- `apps/api/src/jobs/aiBudgetAlertDelivery.test.ts`
- `apps/api/src/__tests__/integration/aiBudgetAlerts.integration.test.ts` — concurrency + RLS forge.
- `apps/web/src/components/settings/AiBudgetThresholdsInput.tsx` — shared chip input used by both settings pages.
- `apps/web/src/components/settings/AiBudgetThresholdsInput.test.tsx`
- `e2e-tests/tests/ai-budget-alerts.spec.ts`

**Modify (breeze):**
- `apps/api/src/db/schema/ai.ts` — `aiBudgets.alertThresholdPercents`, new `aiBudgetAlertEvents`.
- `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` — registrations.
- `apps/api/src/services/effectiveSettings.ts` — field + default.
- `packages/shared/src/types/index.ts:668-676` — `InheritableAiBudgetSettings.alertThresholdPercents`.
- `apps/api/src/routes/ai.ts:1076-1118` — validator, post-save evaluation, `/ai/usage` response.
- `apps/api/src/routes/orgs.ts:684-693, 846-1007` — validator, partner fan-out enqueue.
- `apps/api/src/services/aiCostTracker.ts:1105-1163, 1168-1199, 1274-1346` — evaluator hook, `updateBudget` type, `getUsageSummary`.
- `apps/api/src/services/actionIntents/intentApprovers.ts:64-145` — delegate to the shared resolver.
- `apps/api/src/services/eventBus.ts:170-180, 653-660` — new event type.
- `apps/api/src/services/workerRegistry.ts:109-116` — register worker.
- `apps/web/src/components/settings/PartnerAiBudgetsTab.tsx`, `AiUsagePage.tsx`, `apps/web/src/locales/*/settings.json`.

**Create/modify (breeze-billing, `/Users/toddhebebrand/breeze-billing`):**
- `src/db/ensureSchema.ts` — `CREDIT_ALERT_DDL` group.
- `src/services/creditService.ts` — clamp fix, `rebaselineCreditEpoch`, evaluator hook.
- `src/services/creditAlerts.ts` (+ `.test.ts`) — rung claim + email.
- `src/templates/creditsLow.ts` (revise), `src/templates/creditsExhausted.ts` (new).
- `src/jobs/creditAlertRepair.ts`, `src/index.ts` — hourly cron.

---

## Wave 1 — schema, config, evaluator

### Task 1: Migration, Drizzle schema, and the four registrations

**Files:**
- Create: `apps/api/migrations/2026-09-28-ai-budget-alert-events.sql`
- Modify: `apps/api/src/db/schema/ai.ts:1, 167-180`
- Modify: `apps/api/src/services/tenantCascade.ts:97-98`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:68-69`
- Modify: `apps/api/src/services/orgMergeRegistry.ts:247, 261`
- Test: `apps/api/src/services/tenantCascade.integration.test.ts`, `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (existing contract suites)

**Interfaces:**
- Produces: Drizzle tables `aiBudgetAlertEvents` (columns below) and `aiBudgets.alertThresholdPercents: number[] | null`.

- [ ] **Step 1: Confirm the migration sorts last**

Run: `ls apps/api/migrations/*.sql | sort | tail -1`
Expected: `.../2026-09-27-technician-ticket-write-permissions.sql`. If a newer file exists, name yours one day after it.

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-09-28-ai-budget-alert-events.sql
-- #4388 Pre-cap AI budget alerts (spec: docs/superpowers/specs/ai-mcp/2026-09-01-ai-budget-threshold-alerts-design.md §4.1, §4.3)

-- 1. Per-org threshold ladder. NULL = inherit the default (50,80,95); '{}' = pre-cap warnings off.
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS alert_threshold_pcts integer[];

-- 2. One row per (org, period, period_key, rung) crossing. Durable outbox for delivery.
CREATE TABLE IF NOT EXISTS ai_budget_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL CONSTRAINT ai_budget_alert_events_period_chk CHECK (period IN ('daily', 'monthly')),
  period_key varchar(10) NOT NULL,
  threshold_pct smallint NOT NULL CONSTRAINT ai_budget_alert_events_pct_chk CHECK (threshold_pct BETWEEN 1 AND 100),
  cap_cents integer NOT NULL,
  used_cents integer NOT NULL,
  billing_source text NOT NULL CONSTRAINT ai_budget_alert_events_source_chk CHECK (billing_source IN ('platform', 'partner_key')),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_delivery_error text,
  recipient_count integer
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_budget_alert_events_org_period_rung_uidx
  ON ai_budget_alert_events (org_id, period, period_key, threshold_pct);
CREATE INDEX IF NOT EXISTS ai_budget_alert_events_undelivered_idx
  ON ai_budget_alert_events (created_at)
  WHERE delivered_at IS NULL;

-- 3. RLS shape 1 (direct NOT NULL org_id). breeze_has_org_access already grants
-- system scope, so no separate system branch (same idiom as ticket_drafts,
-- 2026-09-25-ai-agents-ticket-triage.sql).
ALTER TABLE ai_budget_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budget_alert_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_budget_alert_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_budget_alert_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_budget_alert_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_budget_alert_events;

CREATE POLICY breeze_org_isolation_select ON ai_budget_alert_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_budget_alert_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_budget_alert_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_budget_alert_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_budget_alert_events TO breeze_app;
```

- [ ] **Step 3: Add the Drizzle schema**

In `apps/api/src/db/schema/ai.ts`, extend the import on line 1 to include `smallint` and `sql`:

```ts
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, real, smallint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
```

Add to `aiBudgets` (after `approvalMode`, line 177):

```ts
  // #4388 — pre-cap alert ladder. NULL = inherit default [50,80,95]; [] = off.
  // Property name must equal the partner-JSONB key so the AI_BUDGET_FIELDS
  // merge loop in effectiveSettings.ts reads both sides with one name.
  alertThresholdPercents: integer('alert_threshold_pcts').array(),
```

Add after the `aiBudgets` table (after line 180):

```ts
// ============================================
// AI Budget Alert Events (#4388) — durable outbox, one row per threshold
// crossing per (org, period, period_key). RLS shape 1.
// ============================================

export const aiBudgetAlertEvents = pgTable('ai_budget_alert_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  period: text('period', { enum: ['daily', 'monthly'] }).notNull(),
  periodKey: varchar('period_key', { length: 10 }).notNull(),
  thresholdPct: smallint('threshold_pct').notNull(),
  capCents: integer('cap_cents').notNull(),
  usedCents: integer('used_cents').notNull(),
  billingSource: text('billing_source', { enum: ['platform', 'partner_key'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveryAttempts: integer('delivery_attempts').notNull().default(0),
  lastDeliveryError: text('last_delivery_error'),
  recipientCount: integer('recipient_count'),
}, (table) => ({
  orgPeriodRungIdx: uniqueIndex('ai_budget_alert_events_org_period_rung_uidx')
    .on(table.orgId, table.period, table.periodKey, table.thresholdPct),
  undeliveredIdx: index('ai_budget_alert_events_undelivered_idx')
    .on(table.createdAt)
    .where(sql`${table.deliveredAt} IS NULL`),
}));
```

Confirm `apps/api/src/db/schema/index.ts` re-exports `./ai` (it does for `aiBudgets`; no change needed unless exports are enumerated by name — check with `grep -n "from './ai'" apps/api/src/db/schema/index.ts`).

- [ ] **Step 4: Register in the cascade, export-policy, and merge registries**

`apps/api/src/services/tenantCascade.ts` — insert into `CORE_ORG_CASCADE_DELETE_ORDER` in `localeCompare` order. `'ai_budget_alert_events'` sorts **before** `'ai_budgets'` (underscore before letters under `localeCompare`; the test asserts the exact order, so run it):

```ts
  'ai_budget_alert_events',
  'ai_budgets',
  'ai_cost_usage',
```

`apps/api/src/services/tenantExportPolicyRegistry.ts` — replace the `"ai_budgets"` entry and add the new table (keep the file's alphabetical order):

```ts
  "ai_budget_alert_events": tablePolicy("org_id", {"included":["id","org_id","period","period_key","threshold_pct","cap_cents","used_cents","billing_source","created_at","delivered_at","delivery_attempts","last_delivery_error","recipient_count"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "ai_budgets": tablePolicy("org_id", {"included":["id","org_id","enabled","monthly_budget_cents","daily_budget_cents","max_turns_per_session","messages_per_minute_per_user","messages_per_hour_per_org","approval_mode","alert_threshold_pcts","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["allowed_models"]}),
```

`apps/api/src/services/orgMergeRegistry.ts` — add next to `ai_cost_usage` (line 261):

```ts
  ai_budget_alert_events: { kind: 'repoint-dedupe', key: ['period', 'period_key', 'threshold_pct'] }, // verified: ai_budget_alert_events_org_period_rung_uidx (org_id, period, period_key, threshold_pct)
```

- [ ] **Step 5: Apply the migration locally and run the contract suites**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
pnpm db:check-drift
cd apps/api
npx vitest run src/db/autoMigrate.test.ts
npx vitest run --config vitest.integration.config.ts src/services/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
npx vitest run src/services/orgMergeRegistry
```

Expected: all green. If `tenantCascade` reports an ordering violation, move `'ai_budget_alert_events'` to the position it names.

- [ ] **Step 6: Verify RLS as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
  "INSERT INTO ai_budget_alert_events (org_id, period, period_key, threshold_pct, cap_cents, used_cents, billing_source) VALUES ('00000000-0000-0000-0000-000000000001','monthly','2026-09',80,10000,8000,'platform');"
```

Expected: `ERROR: new row violates row-level security policy for table "ai_budget_alert_events"`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-09-28-ai-budget-alert-events.sql apps/api/src/db/schema/ai.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(ai): ai_budget_alert_events table + ai_budgets.alert_threshold_pcts (#4388 W01)"
```

---

### Task 2: Effective-settings field

**Files:**
- Modify: `apps/api/src/services/effectiveSettings.ts:31-59`
- Test: `apps/api/src/services/effectiveSettings.test.ts` (exists; add cases — if it does not, create it with the mock shape used by `aiCostTracker.test.ts`)

**Interfaces:**
- Produces: `EffectiveAiBudget.alertThresholdPercents: number[]` (never null after merge; default `[50, 80, 95]`), and `getEffectiveSettings(...).locked` contains `'aiBudgets.alertThresholdPercents'` when the partner sets it.
- Exports: `export const DEFAULT_AI_ALERT_THRESHOLD_PERCENTS = [50, 80, 95] as const;`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/effectiveSettings.test.ts` (follow the file's existing `vi.mock('../db', ...)` chain shape for `organizations` → `partners` → `aiBudgets` selects):

```ts
describe('getEffectiveAiBudget alertThresholdPercents (#4388)', () => {
  it('defaults to [50,80,95] when neither org row nor partner sets it', async () => {
    mockOrg({ partnerId: 'p1' });
    mockPartnerSettings({});
    mockOrgBudgetRow({ alertThresholdPercents: null });
    const budget = await getEffectiveAiBudget('org1');
    expect(budget.alertThresholdPercents).toEqual([50, 80, 95]);
  });

  it('keeps an explicit empty array (warnings off) instead of falling back to the default', async () => {
    mockOrg({ partnerId: 'p1' });
    mockPartnerSettings({});
    mockOrgBudgetRow({ alertThresholdPercents: [] });
    const budget = await getEffectiveAiBudget('org1');
    expect(budget.alertThresholdPercents).toEqual([]);
  });

  it('partner JSONB overrides the org row and locks the field', async () => {
    mockOrg({ partnerId: 'p1' });
    mockPartnerSettings({ aiBudgets: { alertThresholdPercents: [90] } });
    mockOrgBudgetRow({ alertThresholdPercents: [50] });
    const { effective, locked } = await getEffectiveSettings('org1');
    expect((effective.aiBudgets as Record<string, unknown>).alertThresholdPercents).toEqual([90]);
    expect(locked).toContain('aiBudgets.alertThresholdPercents');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/effectiveSettings.test.ts`
Expected: FAIL — `alertThresholdPercents` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/api/src/services/effectiveSettings.ts`:

```ts
export const DEFAULT_AI_ALERT_THRESHOLD_PERCENTS: readonly number[] = Object.freeze([50, 80, 95]);

interface EffectiveAiBudget {
  enabled: boolean;
  monthlyBudgetCents: number | null;
  dailyBudgetCents: number | null;
  maxTurnsPerSession: number;
  messagesPerMinutePerUser: number;
  messagesPerHourPerOrg: number;
  approvalMode: string;
  /** #4388 — pre-cap alert rungs (1–99). Empty = pre-cap warnings off; 100 is always implicit. */
  alertThresholdPercents: number[];
}

const AI_BUDGET_DEFAULTS: EffectiveAiBudget = {
  enabled: true,
  monthlyBudgetCents: null,
  dailyBudgetCents: null,
  maxTurnsPerSession: 50,
  messagesPerMinutePerUser: 20,
  messagesPerHourPerOrg: 200,
  approvalMode: 'per_step',
  alertThresholdPercents: [...DEFAULT_AI_ALERT_THRESHOLD_PERCENTS],
};

const AI_BUDGET_FIELDS = [
  'enabled',
  'monthlyBudgetCents',
  'dailyBudgetCents',
  'maxTurnsPerSession',
  'messagesPerMinutePerUser',
  'messagesPerHourPerOrg',
  'approvalMode',
  'alertThresholdPercents',
] as const;
```

Export the `EffectiveAiBudget` type if it is not already exported (`export interface EffectiveAiBudget`). Both merge loops (`getEffectiveSettings` lines 185-201 and `getEffectiveAiBudget` lines 329-349) already iterate `AI_BUDGET_FIELDS` and copy any non-null value, so an empty array survives; no loop change needed.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/effectiveSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/effectiveSettings.ts apps/api/src/services/effectiveSettings.test.ts
git commit -m "feat(ai): alertThresholdPercents in effective AI budget (#4388 W01)"
```

---

### Task 3: Validators, shared type, `updateBudget`

**Files:**
- Modify: `packages/shared/src/types/index.ts:668-676`
- Modify: `apps/api/src/routes/ai.ts:1081-1089`
- Modify: `apps/api/src/routes/orgs.ts:684-693`
- Modify: `apps/api/src/services/aiCostTracker.ts:1168-1199`
- Create: `apps/api/src/services/aiBudgetAlerts.ts` (only `normalizeAlertThresholds` in this task; task 4 fills the rest)
- Test: `apps/api/src/services/aiBudgetAlerts.test.ts`, `apps/api/src/routes/ai.test.ts` (add a PUT /budget case)

**Interfaces:**
- Produces: `normalizeAlertThresholds(input: number[]): number[]` — sorted ascending, deduplicated, integers 1–99 only (throws `RangeError` otherwise). `updateBudget(orgId, { alertThresholdPercents?: number[] | null })`.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/api/src/services/aiBudgetAlerts.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: vi.fn(), DEFAULT_AI_ALERT_THRESHOLD_PERCENTS: [50, 80, 95] }));
vi.mock('./llm/llmConfigResolver', () => ({ getLlmBillingSourceForOrg: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { normalizeAlertThresholds } from './aiBudgetAlerts';

describe('normalizeAlertThresholds', () => {
  it('sorts and dedupes', () => {
    expect(normalizeAlertThresholds([95, 50, 80, 50])).toEqual([50, 80, 95]);
  });
  it('accepts an empty ladder', () => {
    expect(normalizeAlertThresholds([])).toEqual([]);
  });
  it.each([[0], [100], [50.5], [-1]])('rejects %s', (bad) => {
    expect(() => normalizeAlertThresholds([bad])).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiBudgetAlerts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the normaliser and wire the validators**

Create `apps/api/src/services/aiBudgetAlerts.ts`:

```ts
/**
 * #4388 — pre-cap AI budget alerts.
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-01-ai-budget-threshold-alerts-design.md §4
 */

export const MAX_ALERT_THRESHOLDS = 5;

/** Sorted, unique, integer rungs in 1..99. Throws RangeError on anything else. */
export function normalizeAlertThresholds(input: readonly number[]): number[] {
  const out = [...new Set(input)].sort((a, b) => a - b);
  for (const n of out) {
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      throw new RangeError(`alert threshold must be an integer between 1 and 99, got ${n}`);
    }
  }
  if (out.length > MAX_ALERT_THRESHOLDS) {
    throw new RangeError(`at most ${MAX_ALERT_THRESHOLDS} alert thresholds`);
  }
  return out;
}
```

`packages/shared/src/types/index.ts` — add to `InheritableAiBudgetSettings`:

```ts
  /** #4388 — pre-cap alert rungs (1–99). Empty = off. Omit = inherit. */
  alertThresholdPercents?: number[];
```

`apps/api/src/routes/ai.ts` PUT /budget zod object — add:

```ts
    alertThresholdPercents: z.array(z.number().int().min(1).max(99)).max(5).nullable().optional(),
```

and before `await updateBudget(orgId, body);` normalise:

```ts
    const normalized = body.alertThresholdPercents == null
      ? body
      : { ...body, alertThresholdPercents: normalizeAlertThresholds(body.alertThresholdPercents) };
    await updateBudget(orgId, normalized);
```

(import `normalizeAlertThresholds` from `'../services/aiBudgetAlerts'`).

`apps/api/src/routes/orgs.ts` partner `aiBudgets` zod object — add:

```ts
    alertThresholdPercents: z.array(z.number().int().min(1).max(99)).max(5).optional(),
```

`apps/api/src/services/aiCostTracker.ts` `updateBudget` settings type — add `alertThresholdPercents?: number[] | null;`. The `update` branch spreads `settings`, so nothing else changes; in the `insert` branch add `alertThresholdPercents: settings.alertThresholdPercents ?? null,`.

- [ ] **Step 4: Add a route test**

In `apps/api/src/routes/ai.test.ts`, next to the existing PUT /budget cases (search for `'/budget'`), add:

```ts
  it('rejects an alert threshold outside 1..99', async () => {
    const res = await app.request('/ai/budget', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ alertThresholdPercents: [50, 100] }),
    });
    expect(res.status).toBe(400);
  });

  it('stores normalised alert thresholds', async () => {
    const res = await app.request('/ai/budget', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ alertThresholdPercents: [95, 50, 50] }),
    });
    expect(res.status).toBe(200);
    expect(updateBudgetMock).toHaveBeenCalledWith('org1', expect.objectContaining({ alertThresholdPercents: [50, 95] }));
  });
```

Adapt `authHeaders` / `updateBudgetMock` to the names that file already uses for its PUT /budget tests.

- [ ] **Step 5: Run tests and typecheck**

```bash
cd apps/api && npx vitest run src/services/aiBudgetAlerts.test.ts src/routes/ai.test.ts && npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/index.ts apps/api/src/routes/ai.ts apps/api/src/routes/orgs.ts apps/api/src/services/aiCostTracker.ts apps/api/src/services/aiBudgetAlerts.ts apps/api/src/services/aiBudgetAlerts.test.ts apps/api/src/routes/ai.test.ts
git commit -m "feat(ai): validate + persist alertThresholdPercents (#4388 W01)"
```

---

### Task 4: Evaluator — rung math and durable event creation

**Files:**
- Modify: `apps/api/src/services/aiBudgetAlerts.ts`
- Test: `apps/api/src/services/aiBudgetAlerts.test.ts`

**Interfaces:**
- Produces:
  - `computeBudgetPct(usedCents: number, capCents: number | null | undefined): number | null` — `null` when no cap.
  - `pickRung(pct: number, ladder: readonly number[]): number | null` — highest of `ladder ∪ {100}` that is `<= pct`.
  - `periodKeysFor(now: Date): { daily: string; monthly: string }` (UTC, same format as `aiCostTracker`).
  - `evaluateAiBudgetThresholds(orgId: string, now?: Date): Promise<CreatedAlertEvent[]>` where `CreatedAlertEvent = { id: string; period: 'daily' | 'monthly'; thresholdPct: number }`. Opens its own system DB context (safe from any ambient context via `runOutsideDbContext`). Task 7 adds the enqueue call inside it.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/aiBudgetAlerts.test.ts`:

```ts
import { computeBudgetPct, pickRung, periodKeysFor, evaluateAiBudgetThresholds } from './aiBudgetAlerts';
import { getEffectiveAiBudget } from './effectiveSettings';
import { getLlmBillingSourceForOrg } from './llm/llmConfigResolver';
import { db } from '../db';

describe('computeBudgetPct', () => {
  it('floors', () => expect(computeBudgetPct(7999, 10000)).toBe(79));
  it('hits the boundary exactly', () => expect(computeBudgetPct(8000, 10000)).toBe(80));
  it('handles real-typed cents', () => expect(computeBudgetPct(7999.6, 10000)).toBe(79));
  it.each([[null], [undefined], [0], [-5]])('returns null for cap %s', (cap) => {
    expect(computeBudgetPct(500, cap as number | null | undefined)).toBeNull();
  });
  it('is not capped at 100', () => expect(computeBudgetPct(12000, 10000)).toBe(120));
});

describe('pickRung', () => {
  it('returns the highest rung at or below pct', () => expect(pickRung(96, [50, 80, 95])).toBe(95));
  it('returns null below the lowest rung', () => expect(pickRung(49, [50, 80, 95])).toBeNull());
  it('always includes 100', () => expect(pickRung(100, [])).toBe(100));
  it('returns 100 when over budget', () => expect(pickRung(120, [50])).toBe(100));
});

describe('periodKeysFor', () => {
  it('uses UTC', () => {
    expect(periodKeysFor(new Date('2026-09-30T23:30:00Z'))).toEqual({ daily: '2026-09-30', monthly: '2026-09' });
    expect(periodKeysFor(new Date('2026-10-01T00:30:00Z'))).toEqual({ daily: '2026-10-01', monthly: '2026-10' });
  });
});

describe('evaluateAiBudgetThresholds', () => {
  const executed: string[] = [];
  beforeEach(() => {
    executed.length = 0;
    (db as Record<string, unknown>).execute = vi.fn(async (q: { queryChunks?: unknown } & { toString(): string }) => {
      executed.push(JSON.stringify(q));
      return [{ id: 'evt-1' }];
    });
    (db as Record<string, unknown>).transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
    vi.mocked(getLlmBillingSourceForOrg).mockResolvedValue('platform');
  });

  it('does nothing when AI is disabled', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ enabled: false, monthlyBudgetCents: 10000, dailyBudgetCents: null, alertThresholdPercents: [50, 80, 95] } as never);
    await expect(evaluateAiBudgetThresholds('org1')).resolves.toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('skips periods with no cap and inserts the highest crossed rung for capped ones', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ enabled: true, monthlyBudgetCents: 10000, dailyBudgetCents: null, alertThresholdPercents: [50, 80, 95] } as never);
    // first execute = usage read, second = insert
    vi.mocked(db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ total_cost_cents: 9600 }])
      .mockResolvedValueOnce([{ id: 'evt-1' }]);
    const created = await evaluateAiBudgetThresholds('org1');
    expect(created).toEqual([{ id: 'evt-1', period: 'monthly', thresholdPct: 95 }]);
    expect(executed.join('\n')).toContain('threshold_pct >=');
    expect(executed.join('\n')).toContain('ON CONFLICT');
  });

  it('returns nothing when the insert is suppressed (rung already fired)', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ enabled: true, monthlyBudgetCents: 10000, dailyBudgetCents: null, alertThresholdPercents: [50, 80, 95] } as never);
    vi.mocked(db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ total_cost_cents: 8100 }])
      .mockResolvedValueOnce([]);
    await expect(evaluateAiBudgetThresholds('org1')).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiBudgetAlerts.test.ts`
Expected: FAIL — the four functions are not exported.

- [ ] **Step 3: Implement**

Append to `apps/api/src/services/aiBudgetAlerts.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getEffectiveAiBudget } from './effectiveSettings';
import { getLlmBillingSourceForOrg } from './llm/llmConfigResolver';
import { captureException } from './sentry';

export type AiBudgetPeriod = 'daily' | 'monthly';
export interface CreatedAlertEvent { id: string; period: AiBudgetPeriod; thresholdPct: number }

/** Percent of cap consumed, floored. null when the period has no positive cap (matches enforcement's truthiness). */
export function computeBudgetPct(usedCents: number, capCents: number | null | undefined): number | null {
  if (!capCents || capCents <= 0) return null;
  return Math.floor((usedCents * 100) / capCents);
}

/** Highest rung of `ladder ∪ {100}` that pct has reached, or null. */
export function pickRung(pct: number, ladder: readonly number[]): number | null {
  let best: number | null = null;
  for (const rung of [...ladder, 100]) {
    if (rung <= pct && (best === null || rung > best)) best = rung;
  }
  return best;
}

export function periodKeysFor(now: Date): { daily: string; monthly: string } {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return { daily: `${y}-${m}-${d}`, monthly: `${y}-${m}` };
}

/**
 * Evaluate both ladders for one org and persist one event per newly crossed
 * rung (highest only; monotonic per period — see spec §4.2). Never throws
 * into the caller: the recorder path is fire-and-forget and must not fail a turn.
 */
export async function evaluateAiBudgetThresholds(orgId: string, now = new Date()): Promise<CreatedAlertEvent[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const budget = await getEffectiveAiBudget(orgId);
    if (!budget.enabled) return [];
    const ladder = budget.alertThresholdPercents;
    const keys = periodKeysFor(now);
    const billingSource = await getLlmBillingSourceForOrg(orgId);
    const created: CreatedAlertEvent[] = [];

    const periods: Array<{ period: AiBudgetPeriod; key: string; cap: number | null }> = [
      { period: 'daily', key: keys.daily, cap: budget.dailyBudgetCents },
      { period: 'monthly', key: keys.monthly, cap: budget.monthlyBudgetCents },
    ];

    for (const { period, key, cap } of periods) {
      if (!cap || cap <= 0) continue;
      const usage = await db.execute<{ total_cost_cents: number }>(sql`
        SELECT total_cost_cents FROM ai_cost_usage
        WHERE org_id = ${orgId}::uuid AND period = ${period} AND period_key = ${key}
        LIMIT 1
      `);
      const used = Number(usage[0]?.total_cost_cents ?? 0);
      const pct = computeBudgetPct(used, cap);
      if (pct === null) continue;
      const rung = pickRung(pct, ladder);
      if (rung === null) continue;

      // Advisory lock per (org, period) serialises concurrent recorders so two
      // turns landing together cannot insert two different rungs in a burst.
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-budget-alert:${orgId}:${period}`}))`);
        return tx.execute<{ id: string }>(sql`
          INSERT INTO ai_budget_alert_events (org_id, period, period_key, threshold_pct, cap_cents, used_cents, billing_source)
          SELECT ${orgId}::uuid, ${period}, ${key}, ${rung}, ${Math.round(cap)}, ${Math.round(used)}, ${billingSource}
          WHERE NOT EXISTS (
            SELECT 1 FROM ai_budget_alert_events e
            WHERE e.org_id = ${orgId}::uuid AND e.period = ${period} AND e.period_key = ${key}
              AND e.threshold_pct >= ${rung}
          )
          ON CONFLICT (org_id, period, period_key, threshold_pct) DO NOTHING
          RETURNING id
        `);
      });
      const id = inserted[0]?.id;
      if (id) created.push({ id, period, thresholdPct: rung });
    }
    return created;
  })).catch((err: unknown) => {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, { orgId, service: 'aiBudgetAlerts' });
    console.error(`[AI] budget threshold evaluation failed for org=${orgId}:`, err instanceof Error ? err.message : err);
    return [];
  });
}
```

`db.execute` with the postgres-js driver returns a bare array-like `RowList` — index it directly (`result[0]`, `for (const r of result)`), never `.rows` (see `services/exchangeRateService.ts:303` for the idiom).

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiBudgetAlerts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiBudgetAlerts.ts apps/api/src/services/aiBudgetAlerts.test.ts
git commit -m "feat(ai): budget threshold evaluator with durable event rows (#4388 W01)"
```

---

### Task 5: Hook the evaluator into recording and the budget route; integration test

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts:1105-1163` (`checkCostAnomalies`)
- Modify: `apps/api/src/routes/ai.ts` (PUT /budget handler)
- Create: `apps/api/src/__tests__/integration/aiBudgetAlerts.integration.test.ts`
- Test: `apps/api/src/services/aiCostTracker.test.ts` (add one assertion)

**Interfaces:**
- Consumes: `evaluateAiBudgetThresholds(orgId)` from task 4.

- [ ] **Step 1: Write the failing unit assertion**

In `apps/api/src/services/aiCostTracker.test.ts`, add near the existing `recordUsage` tests (mock the new module at the top with the file's other mocks):

```ts
vi.mock('./aiBudgetAlerts', () => ({ evaluateAiBudgetThresholds: vi.fn().mockResolvedValue([]) }));
// ...
  it('evaluates budget thresholds after recording usage (#4388)', async () => {
    await recordUsage(/* the same args the neighbouring recordUsage test passes */);
    await new Promise((r) => setImmediate(r)); // fire-and-forget settles
    expect(evaluateAiBudgetThresholds).toHaveBeenCalledWith('org1');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiCostTracker.test.ts`
Expected: the new case FAILS (not called).

- [ ] **Step 3: Replace the daily-80 % console.warn**

In `checkCostAnomalies` (`aiCostTracker.ts:1105-1163`), keep the per-session 10 % warning and delete the block that reads `dailyUsage` and warns at 80 %. Add at the end of the function body (inside the `withSystemDbAccessContext` callback, after the session check):

```ts
    // #4388 — the 80 %-of-daily console.warn this replaced never reached a
    // user. Durable rung evaluation for both ladders lives in aiBudgetAlerts.
    await evaluateAiBudgetThresholds(orgId);
```

Import: `import { evaluateAiBudgetThresholds } from './aiBudgetAlerts';`. Note `checkCostAnomalies` early-returns when `!budget || !budget.dailyBudgetCents` (raw org row) — move the evaluator call **above** that early return so monthly-only and partner-locked budgets are evaluated:

```ts
  return withSystemDbAccessContext(async () => {
    await evaluateAiBudgetThresholds(orgId);

    const [budget] = await db.select().from(aiBudgets).where(eq(aiBudgets.orgId, orgId)).limit(1);
    if (!budget || !budget.dailyBudgetCents) return;
    // ... existing per-session 10 % check unchanged ...
  });
```

- [ ] **Step 4: Evaluate after PUT /budget**

In `apps/api/src/routes/ai.ts` PUT /budget handler, after `await updateBudget(orgId, normalized);`:

```ts
    // A lowered cap or a new rung must fire now, not on the next turn (spec §4.2 #2).
    void evaluateAiBudgetThresholds(orgId);
```

(import from `'../services/aiBudgetAlerts'`; the evaluator already wraps itself in `runOutsideDbContext`, so calling it from a request is safe).

- [ ] **Step 5: Write the integration test**

Create `apps/api/src/__tests__/integration/aiBudgetAlerts.integration.test.ts`, following the setup helpers of the neighbouring `*.integration.test.ts` files (partner + org fixtures, `withSystemDbAccessContext`, `breeze_app` forge helper):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { evaluateAiBudgetThresholds } from '../../services/aiBudgetAlerts';
import { updateBudget } from '../../services/aiCostTracker';
// use this directory's fixture helpers for createPartner/createOrg/cleanup

describe('ai_budget_alert_events (#4388)', () => {
  let orgId: string;
  beforeAll(async () => { /* create partner + org via fixtures; orgId = ... */ });
  afterAll(async () => { /* cleanup via fixtures */ });

  async function setMonthlyUsage(cents: number) {
    const key = new Date().toISOString().slice(0, 7);
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ai_cost_usage (org_id, period, period_key, total_cost_cents)
      VALUES (${orgId}::uuid, 'monthly', ${key}, ${cents})
      ON CONFLICT (org_id, period, period_key) DO UPDATE SET total_cost_cents = EXCLUDED.total_cost_cents
    `));
  }

  it('fires the highest rung once under concurrent evaluation, then stays monotonic', async () => {
    await withSystemDbAccessContext(() => updateBudget(orgId, { monthlyBudgetCents: 10000 }));
    await setMonthlyUsage(9600);
    const results = await Promise.all([evaluateAiBudgetThresholds(orgId), evaluateAiBudgetThresholds(orgId)]);
    expect(results.flat()).toHaveLength(1);
    expect(results.flat()[0]).toMatchObject({ period: 'monthly', thresholdPct: 95 });

    // raising the cap drops pct to 48 — no new (lower) rung may fire
    await withSystemDbAccessContext(() => updateBudget(orgId, { monthlyBudgetCents: 20000 }));
    expect(await evaluateAiBudgetThresholds(orgId)).toEqual([]);

    // crossing 100 fires exactly one more
    await setMonthlyUsage(20000);
    expect(await evaluateAiBudgetThresholds(orgId)).toMatchObject([{ thresholdPct: 100 }]);
  });

  it('rejects a cross-tenant insert as breeze_app', async () => {
    // use the directory's existing "forge as another org" helper; expect SQLSTATE 42501
  });
});
```

- [ ] **Step 6: Run everything for the wave**

```bash
cd apps/api
npx vitest run src/services/aiCostTracker.test.ts src/services/aiBudgetAlerts.test.ts src/routes/ai.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiBudgetAlerts.integration.test.ts
npx tsc --noEmit -p tsconfig.json
pnpm lint
```

Expected: all PASS; confirm the integration file actually ran (file count ≥ 1 in the summary).

- [ ] **Step 7: Commit and open the W01 PR**

```bash
git add -A apps/api/src
git commit -m "feat(ai): evaluate budget rungs on record + budget save; integration test (#4388 W01)"
```

PR body: summary of spec §4.1–4.3, the registration checklist ticked, `Closes #<W01 sub-issue>`. Stop at the open PR (no merge).

---

## Wave 2 — recipients, email, delivery worker

### Task 6: Generalised permission-holder resolver

**Files:**
- Create: `apps/api/src/services/usersWithPermission.ts`
- Create: `apps/api/src/services/usersWithPermission.test.ts`
- Modify: `apps/api/src/services/actionIntents/intentApprovers.ts:64-145`
- Test: `apps/api/src/services/actionIntents/intentApprovers.test.ts` (must stay green unchanged)

**Interfaces:**
- Produces: `resolveUsersWithPermissionForOrg(orgId: string, permission: { resource: string; action: string }): Promise<string[]>` — same semantics as today's `resolveIntentApprovers` but parameterised; `resolveIntentApprovers(orgId)` becomes `resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.APPROVALS_DECIDE)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/usersWithPermission.test.ts` by copying the mock scaffolding from `apps/api/src/services/actionIntents/intentApprovers.test.ts` (it mocks `../../db` select chains for `rolePermissions`, `organizations`, `organizationUsers`, `partnerUsers`). Cases:

```ts
import { PERMISSIONS } from '@breeze/shared';
import { resolveUsersWithPermissionForOrg } from './usersWithPermission';

describe('resolveUsersWithPermissionForOrg', () => {
  it('matches wildcard grants (*:*) for billing:manage', async () => {
    mockGrantingRoles([{ roleId: 'r-super' }]);            // role_permissions rows joined on resource IN ('billing','*') AND action IN ('manage','*')
    mockOrg({ partnerId: 'p1' });
    mockOrgMembers([]);
    mockPartnerMembers([{ userId: 'u-admin', orgAccess: 'all', orgIds: null }]);
    await expect(resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE)).resolves.toEqual(['u-admin']);
  });

  it('excludes partner users whose selected org list does not cover the org', async () => {
    mockGrantingRoles([{ roleId: 'r1' }]);
    mockOrg({ partnerId: 'p1' });
    mockOrgMembers([]);
    mockPartnerMembers([{ userId: 'u-other', orgAccess: 'selected', orgIds: ['org2'] }]);
    await expect(resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE)).resolves.toEqual([]);
  });

  it('returns [] when no role grants the permission', async () => {
    mockGrantingRoles([]);
    await expect(resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE)).resolves.toEqual([]);
  });

  it('renders the permission pair into the role query', async () => {
    mockGrantingRoles([]);
    await resolveUsersWithPermissionForOrg('org1', PERMISSIONS.BILLING_MANAGE);
    expect(renderedWhere(0)).toContain('billing');
    expect(renderedWhere(0)).toContain('manage');
  });
});
```

Use the same "render the where clause to SQL" helper the intentApprovers test uses (assert compiled SQL, not object identity).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/usersWithPermission.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement by extracting**

Create `apps/api/src/services/usersWithPermission.ts` with the body of `resolveIntentApprovers` (lines 64-145, quoted in the file header of this plan's spec §2) with two edits: the signature takes `permission`, and the two `inArray` calls use `permission.resource` / `permission.action`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { organizations, organizationUsers, partnerUsers, permissions, rolePermissions, users } from '../db/schema';

export interface PermissionPair { resource: string; action: string }

/**
 * Distinct active user ids that hold `permission` for `orgId`: org members whose
 * role grants it, plus partner users of the owning partner whose org access
 * covers the org. Wildcard-aware ('*' resource/action), mirrors hasPermission().
 * Opens its own system DB context — callable from any ambient context.
 */
export async function resolveUsersWithPermissionForOrg(orgId: string, permission: PermissionPair): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const grantingRoles = await db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(and(
        inArray(permissions.resource, [permission.resource, '*']),
        inArray(permissions.action, [permission.action, '*']),
      ));
    const grantingRoleIds = [...new Set(grantingRoles.map((r) => r.roleId))];
    if (grantingRoleIds.length === 0) return [];

    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const out = new Set<string>();

    const orgMembers = await db
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .innerJoin(users, eq(users.id, organizationUsers.userId))
      .where(and(eq(organizationUsers.orgId, orgId), inArray(organizationUsers.roleId, grantingRoleIds), eq(users.status, 'active')));
    for (const m of orgMembers) out.add(m.userId);

    if (org?.partnerId) {
      const partnerMembers = await db
        .select({ userId: partnerUsers.userId, orgAccess: partnerUsers.orgAccess, orgIds: partnerUsers.orgIds })
        .from(partnerUsers)
        .innerJoin(users, eq(users.id, partnerUsers.userId))
        .where(and(eq(partnerUsers.partnerId, org.partnerId), inArray(partnerUsers.roleId, grantingRoleIds), eq(users.status, 'active')));
      for (const m of partnerMembers) {
        if (m.orgAccess === 'all' || (m.orgAccess === 'selected' && m.orgIds?.includes(orgId))) out.add(m.userId);
      }
    }
    return [...out];
  });
}
```

Then reduce `resolveIntentApprovers` to:

```ts
export async function resolveIntentApprovers(orgId: string): Promise<string[]> {
  return resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.APPROVALS_DECIDE);
}
```

Keep its doc comment; delete the now-unused imports. The existing `intentApprovers.test.ts` mocks `../../db` — because the shared resolver imports `../db` from `services/`, that test's `vi.mock('../../db')` path still resolves to the same module, so it should stay green; if it mocks by relative path that no longer matches, update the mock path, not the assertions.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/usersWithPermission.test.ts src/services/actionIntents/intentApprovers.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/usersWithPermission.ts apps/api/src/services/usersWithPermission.test.ts apps/api/src/services/actionIntents/intentApprovers.ts
git commit -m "refactor(permissions): resolveUsersWithPermissionForOrg shared resolver (#4388 W02)"
```

---

### Task 7: Copy — in-app text and email template

**Files:**
- Create: `apps/api/src/services/aiBudgetAlertEmail.ts`
- Create: `apps/api/src/services/aiBudgetAlertEmail.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AiBudgetAlertContext {
    orgName: string; period: 'daily' | 'monthly'; periodKey: string; thresholdPct: number;
    capCents: number; usedCents: number; billingSource: 'platform' | 'partner_key'; usagePath: string; appBaseUrl: string;
  }
  export function describeAiBudgetAlert(ctx: AiBudgetAlertContext): { title: string; message: string }
  export function buildAiBudgetAlertEmail(ctx: AiBudgetAlertContext): { subject: string; html: string; text: string }
  export function periodResetLabel(period: 'daily' | 'monthly', periodKey: string): string  // e.g. "1 Oct 2026 00:00 UTC"
  export function shouldEmail(period: 'daily' | 'monthly', thresholdPct: number): boolean   // spec §4.5
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildAiBudgetAlertEmail, describeAiBudgetAlert, periodResetLabel, shouldEmail } from './aiBudgetAlertEmail';

const base = { orgName: 'Acme <Corp>', period: 'monthly' as const, periodKey: '2026-09', thresholdPct: 80, capCents: 10000, usedCents: 8123, billingSource: 'platform' as const, usagePath: '/settings/ai-usage', appBaseUrl: 'https://app.example.com' };

describe('describeAiBudgetAlert', () => {
  it('names the rung, org and period', () => {
    expect(describeAiBudgetAlert(base).title).toBe('AI budget at 80% — Acme <Corp> (monthly)');
    expect(describeAiBudgetAlert(base).message).toContain('$81.23 of $100.00');
  });
  it('uses cap-reached wording at 100', () => {
    const d = describeAiBudgetAlert({ ...base, thresholdPct: 100, usedCents: 10000 });
    expect(d.title).toBe('AI budget reached — Acme <Corp> (monthly)');
    expect(d.message).toContain('paused');
  });
});

describe('buildAiBudgetAlertEmail', () => {
  it('escapes the org name and links to the usage page', () => {
    const e = buildAiBudgetAlertEmail(base);
    expect(e.html).toContain('Acme &lt;Corp&gt;');
    expect(e.html).not.toContain('Acme <Corp>');
    expect(e.html).toContain('https://app.example.com/settings/ai-usage');
    expect(e.text).toContain('$81.23 of $100.00');
  });
  it('states the billing destination', () => {
    expect(buildAiBudgetAlertEmail(base).text).toContain('Breeze AI credits');
    expect(buildAiBudgetAlertEmail({ ...base, billingSource: 'partner_key' }).text).toContain('your Anthropic API key');
  });
});

describe('periodResetLabel', () => {
  it('monthly resets on the first of next month UTC', () => expect(periodResetLabel('monthly', '2026-09')).toBe('1 Oct 2026 00:00 UTC'));
  it('daily resets next UTC midnight', () => expect(periodResetLabel('daily', '2026-09-30')).toBe('1 Oct 2026 00:00 UTC'));
});

describe('shouldEmail', () => {
  it.each([['monthly', 50, true], ['monthly', 100, true], ['daily', 80, false], ['daily', 100, true]] as const)('%s %s → %s', (p, r, want) => {
    expect(shouldEmail(p, r)).toBe(want);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiBudgetAlertEmail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { escapeHtml, renderButton, renderLayout, renderParagraph } from './emailLayout';

export interface AiBudgetAlertContext {
  orgName: string;
  period: 'daily' | 'monthly';
  periodKey: string;
  thresholdPct: number;
  capCents: number;
  usedCents: number;
  billingSource: 'platform' | 'partner_key';
  usagePath: string;
  appBaseUrl: string;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function periodResetLabel(period: 'daily' | 'monthly', periodKey: string): string {
  const [y, m, d] = periodKey.split('-').map(Number);
  const next = period === 'monthly' ? new Date(Date.UTC(y, m, 1)) : new Date(Date.UTC(y, m - 1, d + 1));
  const day = next.getUTCDate();
  const mon = next.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${day} ${mon} ${next.getUTCFullYear()} 00:00 UTC`;
}

/** Spec §4.5: daily pre-cap rungs are in-app only. */
export function shouldEmail(period: 'daily' | 'monthly', thresholdPct: number): boolean {
  return period === 'monthly' || thresholdPct >= 100;
}

function billedTo(source: AiBudgetAlertContext['billingSource']): string {
  return source === 'partner_key' ? 'Billed to your Anthropic API key.' : 'Billed to Breeze AI credits.';
}

export function describeAiBudgetAlert(ctx: AiBudgetAlertContext): { title: string; message: string } {
  const reached = ctx.thresholdPct >= 100;
  const title = reached
    ? `AI budget reached — ${ctx.orgName} (${ctx.period})`
    : `AI budget at ${ctx.thresholdPct}% — ${ctx.orgName} (${ctx.period})`;
  const spend = `${usd(ctx.usedCents)} of ${usd(ctx.capCents)} used this ${ctx.period === 'daily' ? 'day' : 'month'}; resets ${periodResetLabel(ctx.period, ctx.periodKey)}.`;
  const message = reached
    ? `${spend} AI features are paused for this organization until the period resets or the cap is raised. ${billedTo(ctx.billingSource)}`
    : `${spend} ${billedTo(ctx.billingSource)}`;
  return { title, message };
}

export function buildAiBudgetAlertEmail(ctx: AiBudgetAlertContext): { subject: string; html: string; text: string } {
  const { title, message } = describeAiBudgetAlert(ctx);
  const url = `${ctx.appBaseUrl}${ctx.usagePath}`;
  const text = [title, '', message, '', `Review usage and budget: ${url}`].join('\n');
  const body = [
    renderParagraph(escapeHtml(message)),
    renderButton('Review AI usage', url),
    renderParagraph('You receive this because you can manage billing for this organization in Breeze.', { muted: true, marginTop: 16 }),
  ].join('\n');
  const html = renderLayout({ title, preheader: message.slice(0, 120), heading: escapeHtml(title), body });
  return { subject: title, html, text };
}
```

Confirm `renderParagraph` and `renderLayout` option names against `services/emailLayout.ts:20-104` before relying on them; adjust if a signature differs.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiBudgetAlertEmail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiBudgetAlertEmail.ts apps/api/src/services/aiBudgetAlertEmail.test.ts
git commit -m "feat(ai): budget alert copy + email template (#4388 W02)"
```

---

### Task 8: Delivery worker, reconcile, partner fan-out, event bus type

**Files:**
- Create: `apps/api/src/jobs/aiBudgetAlertDelivery.ts`
- Create: `apps/api/src/jobs/aiBudgetAlertDelivery.test.ts`
- Modify: `apps/api/src/services/eventBus.ts:170-180, 653-660`
- Modify: `apps/api/src/services/workerRegistry.ts:109-116`
- Modify: `apps/api/src/services/aiBudgetAlerts.ts` (enqueue after insert)

**Interfaces:**
- Consumes: `describeAiBudgetAlert`, `buildAiBudgetAlertEmail`, `shouldEmail` (task 7); `resolveUsersWithPermissionForOrg` (task 6); `createNotification` (`services/userNotifications.ts`); `getEmailService()` (`services/email.ts`); `publishEvent` (`services/eventBus.ts`).
- Produces:
  ```ts
  export type AiBudgetAlertJobData =
    | { type: 'deliver'; eventId: string }
    | { type: 'reconcile' }
    | { type: 'evaluate-partner'; partnerId: string };
  export function enqueueAiBudgetAlertDelivery(eventId: string): Promise<void>      // jobId `deliver-${eventId}`
  export function enqueueAiBudgetEvaluationForPartner(partnerId: string): Promise<void>
  export async function deliverAiBudgetAlert(eventId: string): Promise<{ recipients: number; emailed: boolean }>
  export async function reconcileUndeliveredAiBudgetAlerts(): Promise<number>
  export async function initializeAiBudgetAlertWorker(): Promise<void>
  export async function shutdownAiBudgetAlertWorker(): Promise<void>
  ```
  Event type `'ai.budget.threshold_crossed'` / `EVENT_TYPES.AI_BUDGET_THRESHOLD_CROSSED`.

- [ ] **Step 1: Write the failing worker tests**

Create `apps/api/src/jobs/aiBudgetAlertDelivery.test.ts` (mock shape from `jobs/pamJobs.test.ts:1-30`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createNotification: vi.fn(),
  resolveUsers: vi.fn(),
  sendEmail: vi.fn(),
  getEmailService: vi.fn(),
  publishEvent: vi.fn(),
}));

vi.mock('bullmq', () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock('../db', () => ({
  db: { execute: mocks.execute },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/userNotifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('../services/usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: mocks.resolveUsers }));
vi.mock('../services/email', () => ({ getEmailService: mocks.getEmailService }));
vi.mock('../services/eventBus', () => ({ publishEvent: mocks.publishEvent, EVENT_TYPES: { AI_BUDGET_THRESHOLD_CROSSED: 'ai.budget.threshold_crossed' } }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/c2cM365', () => ({ getFrontendBaseUrl: () => 'https://app.example.com' }));

import { deliverAiBudgetAlert } from './aiBudgetAlertDelivery';

const event = { id: 'evt-1', org_id: 'org1', org_name: 'Acme', period: 'monthly', period_key: '2026-09', threshold_pct: 80, cap_cents: 10000, used_cents: 8100, billing_source: 'platform', delivered_at: null };

describe('deliverAiBudgetAlert', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.execute.mockResolvedValueOnce([event]); // load event + org
    mocks.execute.mockResolvedValue([]);          // mark delivered
    mocks.resolveUsers.mockResolvedValue(['u1', 'u2']);
    mocks.getEmailService.mockReturnValue({ sendEmail: mocks.sendEmail });
    mocks.createNotification.mockResolvedValue('n1');
    mocks.execute.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('FROM users')) return [{ email: 'a@x.io' }, { email: 'b@x.io' }];
      return [];
    });
  });

  it('notifies every recipient with the event id as dedupe key, sends one email, publishes, marks delivered', async () => {
    mocks.execute.mockResolvedValueOnce([event]);
    const result = await deliverAiBudgetAlert('evt-1');
    expect(result).toEqual({ recipients: 2, emailed: true });
    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', orgId: 'org1', type: 'ai', dedupeKey: 'ai-budget-alert:evt-1', link: '/settings/ai-usage', priority: 'normal' }));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].to).toEqual(['a@x.io', 'b@x.io']);
    expect(mocks.publishEvent).toHaveBeenCalledWith('ai.budget.threshold_crossed', 'org1', expect.objectContaining({ thresholdPct: 80 }), 'ai-budget-alerts');
    expect(JSON.stringify(mocks.execute.mock.calls.at(-1))).toContain('delivered_at');
  });

  it('skips email for daily pre-cap rungs and when no email service is configured', async () => {
    mocks.execute.mockResolvedValueOnce([{ ...event, period: 'daily', period_key: '2026-09-30' }]);
    await expect(deliverAiBudgetAlert('evt-1')).resolves.toEqual({ recipients: 2, emailed: false });
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    vi.resetAllMocks();
    mocks.resolveUsers.mockResolvedValue(['u1']);
    mocks.getEmailService.mockReturnValue(null);
    mocks.execute.mockResolvedValueOnce([event]).mockResolvedValue([]);
    await expect(deliverAiBudgetAlert('evt-1')).resolves.toEqual({ recipients: 1, emailed: false });
  });

  it('marks priority high at 95 and above', async () => {
    mocks.execute.mockResolvedValueOnce([{ ...event, threshold_pct: 95 }]);
    await deliverAiBudgetAlert('evt-1');
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high' }));
  });

  it('is a no-op for an already delivered event', async () => {
    mocks.execute.mockReset();
    mocks.execute.mockResolvedValueOnce([{ ...event, delivered_at: new Date().toISOString() }]);
    await expect(deliverAiBudgetAlert('evt-1')).resolves.toEqual({ recipients: 0, emailed: false });
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('records the failure and rethrows so BullMQ retries', async () => {
    mocks.execute.mockResolvedValueOnce([event]);
    mocks.sendEmail.mockRejectedValue(new Error('smtp down'));
    await expect(deliverAiBudgetAlert('evt-1')).rejects.toThrow('smtp down');
    expect(JSON.stringify(mocks.execute.mock.calls.at(-1))).toContain('delivery_attempts');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/jobs/aiBudgetAlertDelivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the event type**

`apps/api/src/services/eventBus.ts` — in the `EventType` union after `'ai.agent.run.skipped'`:

```ts
  // #4388 — an org crossed an AI budget rung; org-level, no device/site.
  | 'ai.budget.threshold_crossed'
```

and in `EVENT_TYPES` after `AI_AGENT_RUN_SKIPPED`:

```ts
  AI_BUDGET_THRESHOLD_CROSSED: 'ai.budget.threshold_crossed' as const,
```

- [ ] **Step 4: Implement the job module**

```ts
// apps/api/src/jobs/aiBudgetAlertDelivery.ts
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException, captureMessage } from '../services/sentry';
import { createNotification } from '../services/userNotifications';
import { resolveUsersWithPermissionForOrg } from '../services/usersWithPermission';
import { getEmailService } from '../services/email';
import { EVENT_TYPES, publishEvent } from '../services/eventBus';
import { buildAiBudgetAlertEmail, describeAiBudgetAlert, shouldEmail } from '../services/aiBudgetAlertEmail';
import { evaluateAiBudgetThresholds } from '../services/aiBudgetAlerts';
import { attachWorkerObservability } from './workerObservability';
import { PERMISSIONS } from '@breeze/shared';
import { getFrontendBaseUrl } from '../services/c2cM365';

export const AI_BUDGET_ALERT_QUEUE = 'ai-budget-alert-delivery';
const USAGE_PATH = '/settings/ai-usage';
const MAX_ATTEMPTS = 5;

export type AiBudgetAlertJobData =
  | { type: 'deliver'; eventId: string }
  | { type: 'reconcile' }
  | { type: 'evaluate-partner'; partnerId: string };

let queue: Queue<AiBudgetAlertJobData> | null = null;
let worker: Worker<AiBudgetAlertJobData> | null = null;

export function getAiBudgetAlertQueue(): Queue<AiBudgetAlertJobData> {
  if (!queue) queue = new Queue<AiBudgetAlertJobData>(AI_BUDGET_ALERT_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function enqueueAiBudgetAlertDelivery(eventId: string): Promise<void> {
  await getAiBudgetAlertQueue().add('deliver', { type: 'deliver', eventId }, {
    jobId: `deliver-${eventId}`,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  });
}

export async function enqueueAiBudgetEvaluationForPartner(partnerId: string): Promise<void> {
  await getAiBudgetAlertQueue().add('evaluate-partner', { type: 'evaluate-partner', partnerId }, {
    jobId: `evaluate-partner-${partnerId}-${Date.now()}`,
    attempts: 3,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  });
}

type EventRow = {
  id: string; org_id: string; org_name: string; period: 'daily' | 'monthly'; period_key: string;
  threshold_pct: number; cap_cents: number; used_cents: number; billing_source: 'platform' | 'partner_key'; delivered_at: string | null;
};

// DASHBOARD_URL || PUBLIC_APP_URL || http://localhost:4321 — the helper every other
// absolute web link in the API already uses (services/c2cM365.ts:79).
const appBaseUrl = getFrontendBaseUrl;

/** Exported for tests. Idempotent: in-app writes dedupe on the event id, and a delivered row short-circuits. */
export async function deliverAiBudgetAlert(eventId: string): Promise<{ recipients: number; emailed: boolean }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const loaded = await db.execute<EventRow>(sql`
      SELECT e.id, e.org_id, o.name AS org_name, e.period, e.period_key, e.threshold_pct, e.cap_cents, e.used_cents, e.billing_source, e.delivered_at
      FROM ai_budget_alert_events e
      JOIN organizations o ON o.id = e.org_id
      WHERE e.id = ${eventId}::uuid
    `);
    const event = loaded[0];
    if (!event) {
      // Org deleted (FK cascade) or never existed — nothing to deliver.
      return { recipients: 0, emailed: false };
    }
    if (event.delivered_at) return { recipients: 0, emailed: false };

    try {
      const ctx = {
        orgName: event.org_name, period: event.period, periodKey: event.period_key, thresholdPct: Number(event.threshold_pct),
        capCents: Number(event.cap_cents), usedCents: Number(event.used_cents), billingSource: event.billing_source,
        usagePath: USAGE_PATH, appBaseUrl: appBaseUrl(),
      };
      const { title, message } = describeAiBudgetAlert(ctx);
      const userIds = await resolveUsersWithPermissionForOrg(event.org_id, PERMISSIONS.BILLING_MANAGE);

      if (userIds.length === 0) {
        captureMessage('AI budget alert has no recipients', { eventCode: 'ai_budget_alert_no_recipients', tags: { org_id: event.org_id } });
      }

      for (const userId of userIds) {
        await createNotification({
          userId, orgId: event.org_id, type: 'ai', title, message, link: USAGE_PATH,
          priority: ctx.thresholdPct >= 95 ? 'high' : 'normal',
          metadata: { eventId: event.id, period: event.period, periodKey: event.period_key, thresholdPct: ctx.thresholdPct },
          dedupeKey: `ai-budget-alert:${event.id}`,
        });
      }

      let emailed = false;
      const emailService = getEmailService();
      if (emailService && userIds.length > 0 && shouldEmail(event.period, ctx.thresholdPct)) {
        const rows = await db.execute<{ email: string }>(sql`
          SELECT email FROM users WHERE id IN (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND email IS NOT NULL
        `);
        const to = rows.map((r) => r.email);
        if (to.length > 0) {
          const email = buildAiBudgetAlertEmail(ctx);
          await emailService.sendEmail({ to, subject: email.subject, html: email.html, text: email.text });
          emailed = true;
        }
      }

      await publishEvent(EVENT_TYPES.AI_BUDGET_THRESHOLD_CROSSED, event.org_id, {
        eventId: event.id, period: event.period, periodKey: event.period_key, thresholdPct: ctx.thresholdPct,
        capCents: ctx.capCents, usedCents: ctx.usedCents, billingSource: event.billing_source,
      }, 'ai-budget-alerts');

      await db.execute(sql`
        UPDATE ai_budget_alert_events
        SET delivered_at = now(), recipient_count = ${userIds.length}, delivery_attempts = delivery_attempts + 1, last_delivery_error = NULL
        WHERE id = ${eventId}::uuid
      `);
      return { recipients: userIds.length, emailed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.execute(sql`
        UPDATE ai_budget_alert_events
        SET delivery_attempts = delivery_attempts + 1, last_delivery_error = ${msg.slice(0, 500)}
        WHERE id = ${eventId}::uuid
      `).catch(() => undefined);
      captureException(err instanceof Error ? err : new Error(msg), undefined, { service: 'aiBudgetAlertDelivery', eventId });
      throw err;
    }
  }));
}

/** Re-enqueue events that were inserted but never delivered (crash between insert and enqueue, or exhausted retries older than 2 minutes). */
export async function reconcileUndeliveredAiBudgetAlerts(): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM ai_budget_alert_events
    WHERE delivered_at IS NULL AND delivery_attempts < ${MAX_ATTEMPTS} AND created_at < now() - interval '2 minutes'
    ORDER BY created_at
    LIMIT 500
  `)));
  for (const row of rows) await enqueueAiBudgetAlertDelivery(row.id);
  return rows.length;
}

async function evaluatePartnerOrgs(partnerId: string): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM organizations WHERE partner_id = ${partnerId}::uuid AND deleted_at IS NULL
  `)));
  for (const row of rows) await evaluateAiBudgetThresholds(row.id);
  return rows.length;
}

async function processJob(job: Job<AiBudgetAlertJobData>): Promise<unknown> {
  switch (job.data.type) {
    case 'deliver': return deliverAiBudgetAlert(job.data.eventId);
    case 'reconcile': return reconcileUndeliveredAiBudgetAlerts();
    case 'evaluate-partner': return evaluatePartnerOrgs(job.data.partnerId);
  }
}

export async function initializeAiBudgetAlertWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker<AiBudgetAlertJobData>(AI_BUDGET_ALERT_QUEUE, processJob, { connection: getBullMQConnection(), concurrency: 2 });
  attachWorkerObservability(worker, AI_BUDGET_ALERT_QUEUE);
  // Sub-hourly, so it lives outside scheduleRegistry (coarse >= hourly only);
  // offset minutes keep it off the :00/:15/:30/:45 pile-ups.
  await getAiBudgetAlertQueue().add('reconcile', { type: 'reconcile' }, {
    jobId: 'ai-budget-alert-reconcile',
    repeat: { pattern: '7,22,37,52 * * * *' },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export async function shutdownAiBudgetAlertWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
```

Check `organizations.deleted_at` exists (`grep -n deletedAt apps/api/src/db/schema/orgs.ts`); drop that predicate if it does not. `attachWorkerObservability(worker, name, options?)` is verified against `jobs/workerObservability.ts:201`. The worker test already mocks `../services/c2cM365` for the base URL.

Register in `apps/api/src/services/workerRegistry.ts` next to `metricAnomaliesWorker`:

```ts
  {
    name: 'aiBudgetAlertDeliveryWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiBudgetAlertDelivery');
      return { init: m.initializeAiBudgetAlertWorker, shutdown: m.shutdownAiBudgetAlertWorker };
    },
  },
```

Wire the enqueue into the evaluator — in `services/aiBudgetAlerts.ts` after `if (id) created.push(...)`:

```ts
      if (id) {
        created.push({ id, period, thresholdPct: rung });
        // Lazy import breaks the jobs → services → jobs cycle.
        const { enqueueAiBudgetAlertDelivery } = await import('../jobs/aiBudgetAlertDelivery');
        await enqueueAiBudgetAlertDelivery(id).catch((err: unknown) => {
          // The reconcile job picks up any row left undelivered.
          console.error(`[AI] budget alert enqueue failed for event ${id}:`, err instanceof Error ? err.message : err);
        });
      }
```

Add `vi.mock('../jobs/aiBudgetAlertDelivery', () => ({ enqueueAiBudgetAlertDelivery: vi.fn() }))` to `aiBudgetAlerts.test.ts` and assert it is called with `'evt-1'` in the "inserts the highest crossed rung" case.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && npx vitest run src/jobs/aiBudgetAlertDelivery.test.ts src/services/aiBudgetAlerts.test.ts src/services/workerRegistry && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/aiBudgetAlertDelivery.ts apps/api/src/jobs/aiBudgetAlertDelivery.test.ts apps/api/src/services/eventBus.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/aiBudgetAlerts.ts apps/api/src/services/aiBudgetAlerts.test.ts
git commit -m "feat(ai): budget alert delivery worker — in-app, email, event bus, reconcile (#4388 W02)"
```

---

### Task 9: Partner-settings fan-out hook + wave smoke

**Files:**
- Modify: `apps/api/src/routes/orgs.ts` (PATCH `/partners/me` handler, after the `db.update(partners)` at ~line 1003)
- Test: `apps/api/src/routes/orgs.test.ts` (add one case)

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/orgs.test.ts`, near the existing PATCH `/partners/me` tests, mock `../jobs/aiBudgetAlertDelivery` and assert:

```ts
vi.mock('../jobs/aiBudgetAlertDelivery', () => ({ enqueueAiBudgetEvaluationForPartner: vi.fn().mockResolvedValue(undefined) }));
// ...
  it('enqueues a partner-wide budget re-evaluation when aiBudgets change (#4388)', async () => {
    const res = await app.request('/orgs/partners/me', {
      method: 'PATCH', headers: partnerAuthHeaders,
      body: JSON.stringify({ settings: { aiBudgets: { monthlyBudgetCents: 5000 } } }),
    });
    expect(res.status).toBe(200);
    expect(enqueueAiBudgetEvaluationForPartner).toHaveBeenCalledWith('partner1');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/orgs.test.ts`
Expected: the new case FAILS.

- [ ] **Step 3: Implement**

After the partner row update succeeds in the PATCH `/partners/me` handler:

```ts
  if (body.settings?.aiBudgets !== undefined) {
    // Caps or rungs changed fleet-wide: re-evaluate every org off-request (spec §4.2 #3).
    void enqueueAiBudgetEvaluationForPartner(auth.partnerId as string).catch((err: unknown) => {
      console.error('[orgs] aiBudgets fan-out enqueue failed:', err instanceof Error ? err.message : err);
    });
  }
```

Import from `'../jobs/aiBudgetAlertDelivery'`.

- [ ] **Step 4: Run the wave's tests and lint**

```bash
cd apps/api
npx vitest run src/routes/orgs.test.ts src/routes/ai.test.ts src/services/usersWithPermission.test.ts src/services/aiBudgetAlertEmail.test.ts src/jobs/aiBudgetAlertDelivery.test.ts src/services/aiBudgetAlerts.test.ts src/services/actionIntents/intentApprovers.test.ts
npx tsc --noEmit -p tsconfig.json
pnpm lint
```

Then a manual smoke on the worktree stack (`worktree-stack` skill): set a $1 monthly cap on a seeded org via the AI usage page, run one AI chat turn, confirm a bell notification appears for the partner admin and the `ai_budget_alert_events` row has `delivered_at` set.

- [ ] **Step 5: Commit and open the W02 PR**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(ai): re-evaluate budget rungs after partner-wide budget change (#4388 W02)"
```

PR body: spec §4.4–4.6, note the new worker + repeat job, `Closes #<W02 sub-issue>`. Stop at the open PR.

---

## Wave 3 — API surface and web UI

### Task 10: `/ai/usage` — effective budget + `alerts` block

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts:1274-1346` (`getUsageSummary`)
- Test: `apps/api/src/services/aiCostTracker.test.ts`

**Interfaces:**
- Produces, on `GET /ai/usage`: `budget` now reflects `getEffectiveAiBudget` (partner-overridden) values and includes `alertThresholdPercents: number[]`; new top-level
  ```ts
  alerts: { fired: Array<{ period: 'daily' | 'monthly'; periodKey: string; thresholdPct: number; createdAt: string; deliveredAt: string | null }> }
  ```
  for the current daily and monthly period keys only.

- [ ] **Step 1: Write the failing tests**

```ts
  it('returns the EFFECTIVE budget (partner override wins) and the threshold ladder (#4388)', async () => {
    mockEffectiveBudget({ enabled: true, monthlyBudgetCents: 5000, dailyBudgetCents: null, approvalMode: 'per_step', alertThresholdPercents: [50, 80, 95] });
    mockOrgBudgetRow({ monthlyBudgetCents: 99999 });
    const summary = await getUsageSummary('org1');
    expect(summary.budget?.monthlyBudgetCents).toBe(5000);
    expect(summary.budget?.alertThresholdPercents).toEqual([50, 80, 95]);
  });

  it('lists rungs fired in the current periods', async () => {
    mockFiredEvents([{ period: 'monthly', period_key: currentMonthKey(), threshold_pct: 80, created_at: '2026-09-03T10:00:00Z', delivered_at: '2026-09-03T10:00:05Z' }]);
    const summary = await getUsageSummary('org1');
    expect(summary.alerts.fired).toEqual([{ period: 'monthly', periodKey: currentMonthKey(), thresholdPct: 80, createdAt: '2026-09-03T10:00:00Z', deliveredAt: '2026-09-03T10:00:05Z' }]);
  });
```

Use the file's existing mock helpers for the `ai_cost_usage`/`ai_budgets` select chains; add a `db.execute` mock for the events query.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiCostTracker.test.ts`
Expected: the two new cases FAIL.

- [ ] **Step 3: Implement**

In `getUsageSummary`: replace the raw `aiBudgets` select with `const budget = await withSystemDbAccessContext(() => getEffectiveAiBudget(orgId));` (same self-context rationale as `checkBudgetDetailed`), make `budget` non-null in the return type (`enabled`, cents, `approvalMode`, plus `alertThresholdPercents: budget.alertThresholdPercents`), and add:

```ts
  const fired = await db.execute<{ period: 'daily' | 'monthly'; period_key: string; threshold_pct: number; created_at: string; delivered_at: string | null }>(sql`
    SELECT period, period_key, threshold_pct, created_at, delivered_at
    FROM ai_budget_alert_events
    WHERE org_id = ${orgId}::uuid
      AND ((period = 'daily' AND period_key = ${dailyKey}) OR (period = 'monthly' AND period_key = ${monthlyKey}))
    ORDER BY created_at
  `);
  // ...
    alerts: {
      fired: fired.map((r) => ({ period: r.period, periodKey: r.period_key, thresholdPct: Number(r.threshold_pct), createdAt: new Date(r.created_at).toISOString(), deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null })),
    },
```

Update the `Promise<{...}>` return type accordingly. Check `apps/web/src/components/ai/AiCostIndicator.tsx` and `AiUsagePage.tsx` still type-check against a non-null `budget` (they already guard with `?.`).

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiCostTracker.test.ts src/routes/ai.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiCostTracker.ts apps/api/src/services/aiCostTracker.test.ts
git commit -m "feat(ai): /ai/usage returns effective budget, ladder and fired rungs (#4388 W03)"
```

---

### Task 11: Shared threshold input + both settings pages + locales

**Files:**
- Create: `apps/web/src/components/settings/AiBudgetThresholdsInput.tsx`
- Create: `apps/web/src/components/settings/AiBudgetThresholdsInput.test.tsx`
- Modify: `apps/web/src/components/settings/PartnerAiBudgetsTab.tsx:36-118`
- Modify: `apps/web/src/components/settings/AiUsagePage.tsx:96-108, 137-167, 200-215, 274-289`
- Modify: `apps/web/src/locales/{en,de-DE,fr-FR,fr-CA,pt-BR,it-IT,es-419,tr-TR}/settings.json` (`partnerAiBudgets` and `aiUsagePage` blocks)

**Interfaces:**
- Produces: `<AiBudgetThresholdsInput value={number[] | undefined} onChange={(v: number[] | undefined) => void} disabled?: boolean placeholder?: string testId?: string />` — comma/space separated integers 1–99, max 5; shows chips; `undefined` = inherit.

- [ ] **Step 1: Write the failing component test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiBudgetThresholdsInput from './AiBudgetThresholdsInput';

describe('AiBudgetThresholdsInput', () => {
  it('renders current rungs as chips and emits a normalised list on blur', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50, 80]} onChange={onChange} testId="thresholds" />);
    expect(screen.getByText('50%')).toBeInTheDocument();
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '95, 50, 80' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith([50, 80, 95]);
  });

  it('rejects values outside 1..99 with an inline error and does not emit', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('thresholds-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits undefined (inherit) when cleared', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50]} onChange={onChange} testId="thresholds" />);
    fireEvent.change(screen.getByTestId('thresholds-input'), { target: { value: '' } });
    fireEvent.blur(screen.getByTestId('thresholds-input'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/settings/AiBudgetThresholdsInput.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the input**

```tsx
// apps/web/src/components/settings/AiBudgetThresholdsInput.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  value: number[] | undefined;
  onChange: (value: number[] | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  testId?: string;
};

export function parseThresholds(raw: string): { ok: true; value: number[] | undefined } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const parts = trimmed.split(/[\s,]+/).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 99)) return { ok: false };
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (uniq.length > 5) return { ok: false };
  return { ok: true, value: uniq };
}

export default function AiBudgetThresholdsInput({ value, onChange, disabled, placeholder, testId = 'ai-budget-thresholds' }: Props) {
  const { t } = useTranslation('settings');
  const [text, setText] = useState(value?.join(', ') ?? '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(value?.join(', ') ?? ''); }, [value]);

  const commit = () => {
    const parsed = parseThresholds(text);
    if (!parsed.ok) { setInvalid(true); return; }
    setInvalid(false);
    onChange(parsed.value);
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {(value ?? []).map((v) => (
          <span key={v} className="rounded-full bg-muted px-2 py-0.5 text-xs">{v}%</span>
        ))}
      </div>
      <input
        type="text"
        inputMode="numeric"
        data-testid={`${testId}-input`}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      />
      {invalid && (
        <p data-testid={`${testId}-error`} className="text-xs text-red-600">{t('aiBudgetThresholds.invalid')}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire both pages**

`PartnerAiBudgetsTab.tsx` — add inside the `grid` after the messages-per-hour block:

```tsx
            <div className="space-y-2 sm:col-span-2">
              <label className="text-sm font-medium">{t('partnerAiBudgets.alertThresholds')}</label>
              <AiBudgetThresholdsInput
                value={data.alertThresholdPercents}
                onChange={(v) => set({ alertThresholdPercents: v })}
                placeholder={t('partnerAiBudgets.notSet')}
                testId="partner-ai-budget-thresholds"
              />
              <p className="text-xs text-muted-foreground">{t('partnerAiBudgets.alertThresholdsHelp')}</p>
            </div>
```

`AiUsagePage.tsx`:
- add `alertThresholdPercents: number[] | undefined` to the `budget` state (initialise from `data.budget.alertThresholdPercents` in `fetchData`) and `'alertThresholdPercents'` to `budgetFields`;
- in `handleSaveBudget` add `if (!isLocked('alertThresholdPercents')) payload.alertThresholdPercents = budget.alertThresholdPercents ?? null;`;
- render below the daily budget input:

```tsx
          <label className="block">
            <span className="text-sm text-muted-foreground">{t('aiUsagePage.alertThresholds')}</span>
            <AiBudgetThresholdsInput
              value={budget.alertThresholdPercents}
              onChange={(v) => setBudget({ ...budget, alertThresholdPercents: v })}
              disabled={isLocked('alertThresholdPercents')}
              placeholder="50, 80, 95"
              testId="ai-budget-thresholds"
            />
            {isLocked('alertThresholdPercents') && (
              <span className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 italic">
                <Lock className="h-3 w-3" /> {t('aiUsagePage.managedByPartner')}</span>
            )}
            <span className="mt-1 block text-xs text-muted-foreground">{t('aiUsagePage.alertThresholdsHelp')}</span>
          </label>
```

- fired markers under the stat cards (uses `usage.alerts.fired` from task 10):

```tsx
      {usage?.alerts?.fired?.length ? (
        <p data-testid="ai-budget-fired-rungs" className="text-xs text-muted-foreground">
          {usage.alerts.fired.map((f) => t('aiUsagePage.firedRung', { pct: f.thresholdPct, period: f.period, date: new Date(f.createdAt).toLocaleDateString() })).join(' · ')}
        </p>
      ) : null}
```

Add `alerts?: { fired: Array<{ period: string; periodKey: string; thresholdPct: number; createdAt: string; deliveredAt: string | null }> }` and `budget.alertThresholdPercents?: number[]` to the page's `usage` type.

- [ ] **Step 5: Locale keys (all eight files)**

`en/settings.json` — in `partnerAiBudgets`:

```json
    "alertThresholds": "Warn at (% of budget)",
    "alertThresholdsHelp": "Partner admins with billing access get an in-app alert at each rung and an email for monthly and cap-reached alerts. Leave empty to inherit 50, 80, 95.",
```

new top-level block:

```json
  "aiBudgetThresholds": {
    "invalid": "Enter up to five whole numbers between 1 and 99, separated by commas."
  },
```

in `aiUsagePage`:

```json
    "alertThresholds": "Warn at (% of budget)",
    "alertThresholdsHelp": "Alerts go to partner admins with billing access. 100% (cap reached) is always sent.",
    "firedRung": "{{pct}}% {{period}} alert sent {{date}}",
```

Add the same keys with translated values to the other seven locale files (machine translation is acceptable; keep the `{{pct}}`, `{{period}}`, `{{date}}` placeholders verbatim).

- [ ] **Step 6: Run web tests and typecheck**

```bash
cd apps/web
npx vitest run src/components/settings/AiBudgetThresholdsInput.test.tsx src/lib/i18n/localeParity.test.ts src/components/settings
npx astro check 2>&1 | tail -5
```

Expected: PASS, no new type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/AiBudgetThresholdsInput.tsx apps/web/src/components/settings/AiBudgetThresholdsInput.test.tsx apps/web/src/components/settings/PartnerAiBudgetsTab.tsx apps/web/src/components/settings/AiUsagePage.tsx apps/web/src/locales
git commit -m "feat(web): AI budget alert threshold settings + fired-rung markers (#4388 W03)"
```

---

### Task 12: Playwright spec, docs, open W03 PR

**Files:**
- Create: `e2e-tests/tests/ai-budget-alerts.spec.ts`
- Modify: `apps/docs/` AI usage / budgets page (find with `grep -rln "AI budget" apps/docs/src`)

- [ ] **Step 1: Write the Playwright spec** (Page Object conventions from `e2e-tests/README.md`; `data-testid` only)

```ts
import { test, expect } from '@playwright/test';
import { loginAsPartnerAdmin } from '../pages/auth';

test('org AI budget thresholds round-trip and show a fired rung', async ({ page }) => {
  await loginAsPartnerAdmin(page);
  await page.goto('/settings/ai-usage');
  const input = page.getByTestId('ai-budget-thresholds-input');
  await input.fill('60, 90');
  await input.blur();
  await page.getByTestId('ai-budget-save').click();
  await page.reload();
  await expect(page.getByTestId('ai-budget-thresholds-input')).toHaveValue('60, 90');
});
```

Add `data-testid="ai-budget-save"` to the save button in `AiUsagePage.tsx` if it lacks one. The fired-rung assertion needs a seeded event; add a helper in the e2e seed that inserts an `ai_budget_alert_events` row for the seeded org, then assert `page.getByTestId('ai-budget-fired-rungs')` contains `80%`.

- [ ] **Step 2: Run it against the worktree stack**

```bash
cd e2e-tests && pnpm test -- ai-budget-alerts
```

Expected: PASS.

- [ ] **Step 3: Docs**

Update the AI usage/budgets page under `apps/docs/` with a "Budget alerts" section: default rungs, who is notified, email policy, partner lock. Use the `update-breeze-docs` skill conventions.

- [ ] **Step 4: Commit and open the W03 PR**

```bash
git add e2e-tests/tests/ai-budget-alerts.spec.ts apps/docs apps/web/src/components/settings/AiUsagePage.tsx
git commit -m "test(e2e)+docs: AI budget alert thresholds (#4388 W03)"
```

PR body: spec §4.8–4.9, screenshots of both settings pages, `Closes #<W03 sub-issue>`. Stop at the open PR.

---

## Wave 4 — partner credit low-balance alerts (breeze-billing) + API surface

All tasks 13–17 run in `/Users/toddhebebrand/breeze-billing` (`npm test` = `vitest run`, `npm run typecheck`). There is **no CI** — paste the local test output into the PR. Task 18 is in the breeze repo.

### Task 13: Boot-time DDL for the credit-alert columns

**Files:**
- Modify: `src/db/ensureSchema.ts`
- Test: `src/db/ensureSchema.test.ts` (statement-shape tests exist for the other groups)

**Interfaces:**
- Produces columns on `billing_credit_balances`: `epoch_baseline integer NOT NULL DEFAULT 0`, `epoch_started_at timestamptz`, `notified_threshold_pcts integer[] NOT NULL DEFAULT '{}'`.

- [ ] **Step 1: Write the failing test**

```ts
import { CREDIT_ALERT_DDL } from './ensureSchema.js';

describe('CREDIT_ALERT_DDL', () => {
  it('adds the three alert columns idempotently', () => {
    const joined = CREDIT_ALERT_DDL.join('\n');
    expect(joined).toContain('ADD COLUMN IF NOT EXISTS epoch_baseline integer NOT NULL DEFAULT 0');
    expect(joined).toContain('ADD COLUMN IF NOT EXISTS epoch_started_at timestamptz');
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS notified_threshold_pcts integer[] NOT NULL DEFAULT '{}'");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- src/db/ensureSchema.test.ts` → FAIL (export missing).

- [ ] **Step 3: Implement**

```ts
/** #4388 credit low-balance alerts — boot survives a failure here (feature, not a dependency). */
export const CREDIT_ALERT_DDL: ReadonlyArray<string> = [
  `ALTER TABLE billing_credit_balances ADD COLUMN IF NOT EXISTS epoch_baseline integer NOT NULL DEFAULT 0`,
  `ALTER TABLE billing_credit_balances ADD COLUMN IF NOT EXISTS epoch_started_at timestamptz`,
  `ALTER TABLE billing_credit_balances ADD COLUMN IF NOT EXISTS notified_threshold_pcts integer[] NOT NULL DEFAULT '{}'`,
  // Backfill: existing wallets start an epoch at their current balance so the
  // first alert is measured from "now", not from a zero baseline.
  `UPDATE billing_credit_balances
     SET epoch_baseline = included_balance + purchased_balance, epoch_started_at = now()
   WHERE epoch_started_at IS NULL`,
];
```

Run it in `ensureSchema()` with the SIGNUP_RISK failure policy (log + continue). Add the Drizzle columns to `billingCreditBalances` in `src/db/schema/billing.ts`:

```ts
  epochBaseline: integer('epoch_baseline').notNull().default(0),
  epochStartedAt: timestamp('epoch_started_at', { withTimezone: true }),
  notifiedThresholdPcts: integer('notified_threshold_pcts').array().notNull().default([]),
```

- [ ] **Step 4: Run tests** — `npm test -- src/db/ensureSchema.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(credits): epoch baseline + notified rung columns (#4388 W04)"`.

---

### Task 14: Fix `deductCredits` over-deduction

**Files:**
- Modify: `src/services/creditService.ts:113-136`
- Test: `src/services/creditService.test.ts` (create if absent, following `staleAccountCleanup.test.ts`'s `vi.mock('../db/index.js')` shape; capture the SQL template passed to `pg`)

- [ ] **Step 1: Write the failing test**

```ts
it('never subtracts more purchased credits than remain', async () => {
  const sqlText = await captureDeductSql({ includedBalance: 0, purchasedBalance: 10 }, 25);
  expect(sqlText).toMatch(/LEAST\(\s*GREATEST\(0,\s*\$?\d* ?- included_balance\),\s*purchased_balance\)/);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- src/services/creditService.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in the CTE:

```sql
    deduction AS (
      SELECT
        LEAST(${creditsToDeduct}, included_balance) AS from_included,
        LEAST(GREATEST(0, ${creditsToDeduct} - included_balance), purchased_balance) AS from_purchased
      FROM current
    ),
```

`RETURNING d.from_included + d.from_purchased AS deducted` already reports the true amount, so the ledger row records the clamped value.

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** — `git commit -am "fix(credits): clamp purchased deduction at zero (#4388 W04)"`.

---

### Task 15: Replenishment epoch

**Files:**
- Modify: `src/services/creditService.ts` (`getOrCreateBalance`, `addPurchasedCredits`, `resetIncludedCredits`)
- Test: `src/services/creditService.test.ts`

**Interfaces:**
- Produces: `rebaselineCreditEpoch(partnerId: string): Promise<void>` — sets `epoch_baseline = included + purchased`, `epoch_started_at = now()`, and keeps only rungs `<= current pct` (which is 0 right after a full reset, so the array empties; after a small top-up higher rungs re-arm while lower stay claimed).

- [ ] **Step 1: Write the failing tests**

```ts
describe('rebaselineCreditEpoch', () => {
  it('runs one UPDATE that recomputes the baseline and prunes rungs above the new pct', async () => {
    const sqlText = await captureRebaselineSql('p1');
    expect(sqlText).toContain('epoch_baseline = included_balance + purchased_balance');
    expect(sqlText).toContain('epoch_started_at = now()');
    expect(sqlText).toMatch(/notified_threshold_pcts\s*=\s*ARRAY\(SELECT r FROM unnest\(notified_threshold_pcts\) r WHERE r <= 0\)/);
  });
});
it('resetIncludedCredits rebaselines', async () => { /* spy rebaselineCreditEpoch called with partnerId */ });
it('addPurchasedCredits rebaselines', async () => { /* same */ });
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

```ts
/**
 * Start a new consumption epoch at the current balance (called after every
 * replenishment). Percent-consumed is measured from this baseline, so the
 * ladder re-arms; rungs at or below the post-replenishment pct (always 0 here,
 * since consumed = 0 at baseline) are kept — the WHERE keeps the statement
 * correct if a future caller rebaselines mid-consumption.
 */
export async function rebaselineCreditEpoch(partnerId: string): Promise<void> {
  const pg = getPgClient();
  await pg`
    UPDATE billing_credit_balances
    SET epoch_baseline = included_balance + purchased_balance,
        epoch_started_at = now(),
        notified_threshold_pcts = ARRAY(SELECT r FROM unnest(notified_threshold_pcts) r WHERE r <= 0),
        updated_at = NOW()
    WHERE partner_id = ${partnerId}::uuid
  `;
}
```

Call it at the end of `resetIncludedCredits` and `addPurchasedCredits`, and in `getOrCreateBalance` right after a successful insert (`created`). Any other balance-raising path (grep `purchased_balance = purchased_balance +` and `included_balance =`) gets the same call.

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git commit -am "feat(credits): replenishment epoch baseline (#4388 W04)"`.

---

### Task 16: Credit alert evaluator + templates

**Files:**
- Create: `src/services/creditAlerts.ts`, `src/services/creditAlerts.test.ts`
- Modify: `src/templates/creditsLow.ts`; Create: `src/templates/creditsExhausted.ts`
- Modify: `src/services/creditService.ts` (`deductCredits` tail)

**Interfaces:**
- Produces: `evaluateCreditAlerts(partnerId: string): Promise<{ rung: number | null; emailed: boolean }>`; `CREDIT_ALERT_LADDER = [50, 80, 95, 100]`; `creditsLowEmail({ partnerName, used, total, remaining, pct, daysLeft, buyUrl })`; `creditsExhaustedEmail({ partnerName, buyUrl })`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('evaluateCreditAlerts', () => {
  it('does nothing when the epoch baseline is 0', async () => { /* balance {epochBaseline:0} → rung null, no email */ });
  it('claims the highest crossed rung atomically and emails billingEmail', async () => {
    // balance: baseline 1000, remaining 150 → pct 85 → rung 80; claim UPDATE ... WHERE NOT (80 = ANY(notified_threshold_pcts)) RETURNING
    // assert sendEmail called once with to = partner.billingEmail and subject containing '85%'
  });
  it('sends the exhausted template at 100', async () => { /* remaining 0 → subject 'AI credits exhausted' */ });
  it('does not email when the rung is already claimed', async () => { /* UPDATE returns no row → no sendEmail */ });
  it('un-claims the rung when the email fails', async () => { /* sendEmail rejects → array_remove UPDATE issued, error swallowed, emailed:false */ });
  it('skips partners without billingEmail', async () => {});
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/services/creditAlerts.ts
import { eq } from 'drizzle-orm';
import { getDb, getPgClient } from '../db/index.js';
import { billingCreditBalances, billingCreditTransactions } from '../db/schema/billing.js';
import { partners } from '../db/schema/breeze.js';
import { getConfig } from '../config/validate.js';
import { sendEmail } from './email.js';
import { creditsLowEmail } from '../templates/creditsLow.js';
import { creditsExhaustedEmail } from '../templates/creditsExhausted.js';

export const CREDIT_ALERT_LADDER = [50, 80, 95, 100] as const;

export function pickCreditRung(pct: number): number | null {
  let best: number | null = null;
  for (const r of CREDIT_ALERT_LADDER) if (r <= pct && (best === null || r > best)) best = r;
  return best;
}

/** Credits consumed per day over the last 7 days of usage transactions; null when no usage. */
async function burnPerDay(partnerId: string): Promise<number | null> {
  const pg = getPgClient();
  const [row] = await pg<{ used: number | null }[]>`
    SELECT -SUM(amount)::int AS used FROM billing_credit_transactions
    WHERE partner_id = ${partnerId}::uuid AND type = 'usage' AND created_at > now() - interval '7 days'
  `;
  return row?.used && row.used > 0 ? row.used / 7 : null;
}

export async function evaluateCreditAlerts(partnerId: string): Promise<{ rung: number | null; emailed: boolean }> {
  const db = getDb();
  const pg = getPgClient();
  const [balance] = await db.select().from(billingCreditBalances).where(eq(billingCreditBalances.partnerId, partnerId)).limit(1);
  if (!balance || balance.epochBaseline <= 0) return { rung: null, emailed: false };

  const remaining = balance.includedBalance + balance.purchasedBalance;
  const used = Math.max(0, balance.epochBaseline - remaining);
  const pct = Math.floor((used * 100) / balance.epochBaseline);
  const rung = pickCreditRung(pct);
  if (rung === null) return { rung: null, emailed: false };

  // Atomic claim: highest rung only, monotonic within the epoch.
  const claimed = await pg<{ partner_id: string }[]>`
    UPDATE billing_credit_balances
    SET notified_threshold_pcts = (SELECT ARRAY(SELECT DISTINCT r FROM unnest(notified_threshold_pcts || ${rung}::int) r ORDER BY r)),
        updated_at = NOW()
    WHERE partner_id = ${partnerId}::uuid
      AND NOT EXISTS (SELECT 1 FROM unnest(notified_threshold_pcts) r WHERE r >= ${rung})
    RETURNING partner_id
  `;
  if (claimed.length === 0) return { rung, emailed: false };

  const [partner] = await db.select({ name: partners.name, billingEmail: partners.billingEmail }).from(partners).where(eq(partners.id, partnerId)).limit(1);
  if (!partner?.billingEmail) return { rung, emailed: false };

  const buyUrl = `${getConfig().APP_BASE_URL}/billing/credits`;
  const burn = await burnPerDay(partnerId);
  const email = rung >= 100
    ? creditsExhaustedEmail({ partnerName: partner.name, buyUrl })
    : creditsLowEmail({ partnerName: partner.name, used, total: balance.epochBaseline, remaining, pct, daysLeft: burn ? Math.floor(remaining / burn) : null, buyUrl });

  try {
    await sendEmail({ to: partner.billingEmail, ...email });
    return { rung, emailed: true };
  } catch (err) {
    console.error(`[CreditAlerts] email failed for partner ${partnerId}: ${err instanceof Error ? err.message : String(err)}`);
    await pg`UPDATE billing_credit_balances SET notified_threshold_pcts = array_remove(notified_threshold_pcts, ${rung}::int) WHERE partner_id = ${partnerId}::uuid`;
    return { rung, emailed: false };
  }
}
```

Templates:

```ts
// src/templates/creditsLow.ts
import { baseLayout, escapeHtml } from './base.js';
export function creditsLowEmail(data: { partnerName: string; used: number; total: number; remaining: number; pct: number; daysLeft: number | null; buyUrl: string }): { subject: string; html: string } {
  const runway = data.daysLeft === null ? '' : ` At the last week's usage that is roughly ${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'} of AI usage.`;
  return {
    subject: `AI credits at ${data.pct}% — ${data.remaining.toLocaleString()} credits left`,
    html: baseLayout(`
      <h2 style="margin:0 0 16px;font-size:20px">AI Credits Running Low</h2>
      <p>Hi ${escapeHtml(data.partnerName)},</p>
      <p>You've used <strong>${data.used.toLocaleString()}</strong> of the <strong>${data.total.toLocaleString()}</strong> AI credits available since your last top-up or monthly reset (${data.pct}%). <strong>${data.remaining.toLocaleString()}</strong> remain.${escapeHtml(runway)}</p>
      <p>When credits reach zero, AI features pause for all of your organizations until you purchase more.</p>
    `, data.buyUrl, 'Buy More Credits'),
  };
}
```

```ts
// src/templates/creditsExhausted.ts
import { baseLayout, escapeHtml } from './base.js';
export function creditsExhaustedEmail(data: { partnerName: string; buyUrl: string }): { subject: string; html: string } {
  return {
    subject: 'AI credits exhausted — AI features are paused',
    html: baseLayout(`
      <h2 style="margin:0 0 16px;font-size:20px">AI Credits Exhausted</h2>
      <p>Hi ${escapeHtml(data.partnerName)},</p>
      <p>Your Breeze AI credit balance has reached zero. AI features are paused for all of your organizations until credits are added.</p>
    `, data.buyUrl, 'Buy More Credits'),
  };
}
```

Hook in `deductCredits`, after the ledger insert and before `return`:

```ts
  void evaluateCreditAlerts(partnerId).catch((err) => {
    console.error(`[CreditAlerts] evaluation failed for partner ${partnerId}: ${err instanceof Error ? err.message : String(err)}`);
  });
```

(import lazily or place `creditAlerts.ts` below `creditService.ts` in the import graph — `creditAlerts` must not import `creditService`.)

- [ ] **Step 4: Run tests** — `npm test && npm run typecheck` → PASS. **Step 5: Commit** — `git commit -am "feat(credits): low-balance + exhausted alerts on deduction (#4388 W04)"`.

---

### Task 17: Hourly repair cron

**Files:**
- Create: `src/jobs/creditAlertRepair.ts`, `src/jobs/creditAlertRepair.test.ts`
- Modify: `src/index.ts:114-160`

- [ ] **Step 1: Write the failing test** — `repairCreditAlerts()` calls `evaluateCreditAlerts` once per `billing_credit_balances` row with `epoch_baseline > 0`, continues past a throwing partner, returns the count evaluated.

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/jobs/creditAlertRepair.ts
import { gt } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { billingCreditBalances } from '../db/schema/billing.js';
import { evaluateCreditAlerts } from '../services/creditAlerts.js';

/** Catches rungs whose inline evaluation or email failed, and wallets that stopped deducting. */
export async function repairCreditAlerts(): Promise<number> {
  const db = getDb();
  const rows = await db.select({ partnerId: billingCreditBalances.partnerId }).from(billingCreditBalances).where(gt(billingCreditBalances.epochBaseline, 0));
  let n = 0;
  for (const row of rows) {
    try { await evaluateCreditAlerts(row.partnerId); n++; }
    catch (err) { console.error(`[CreditAlertRepair] partner ${row.partnerId}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  console.log(`[CreditAlertRepair] evaluated ${n} wallets`);
  return n;
}
```

`src/index.ts` — after the AI usage reporter block:

```ts
cron.schedule('45 * * * *', async () => {
  console.log('[Cron] Running credit alert repair...');
  await repairCreditAlerts().catch((err) => {
    console.error('[Cron] creditAlertRepair failed:', err instanceof Error ? err.message : err);
  });
});
```

- [ ] **Step 4: Run all billing tests** — `npm test && npm run typecheck` → PASS; paste the summary into the PR.

- [ ] **Step 5: Commit and open the breeze-billing PR** — `git commit -am "feat(credits): hourly credit alert repair cron (#4388 W04)"`. PR body links spec §5 and lists the manual deploy steps (both regions, `docker compose build billing && up -d billing`). Stop at the open PR.

---

### Task 18: API + web credit surface (breeze repo)

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts:146-237, 1274-1346`
- Modify: `apps/web/src/components/settings/AiUsagePage.tsx` (stat card), `apps/web/src/components/ai/AiCostIndicator.tsx:109-150`
- Test: `apps/api/src/services/aiCostTracker.test.ts`, `apps/web/src/components/ai/AiCostIndicator.test.tsx` (create if absent)

**Interfaces:**
- Produces on `GET /ai/usage`: `credits: { remaining: number; includedBalance: number; purchasedBalance: number; fetchedAt: string } | null` — `null` when no billing service, when `billedTo === 'partner_key'`, or when nothing is cached yet.

- [ ] **Step 1: Write the failing tests**

```ts
  it('caches the last credit balance per partner for /ai/usage (#4388)', async () => {
    // checkBillingCreditsDetailed resolves {allowed:true, remainingCredits:1240, includedBalance:0, purchasedBalance:1240, plan:'pro'}
    await checkBillingCreditsDetailed('org1', 'platform');
    expect(redisSet).toHaveBeenCalledWith('ai:credits:partner1', expect.stringContaining('"remaining":1240'), 'EX', 60);
  });
  it('returns credits null for BYOK orgs and when uncached', async () => { /* billedTo partner_key → null; redis get null → null */ });
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

In `checkBillingCreditsDetailed`, after parsing `data` (before the `allowed` checks):

```ts
    void getRedis().set(`ai:credits:${org.partnerId}`, JSON.stringify({
      remaining: data.remainingCredits, includedBalance: data.includedBalance ?? 0, purchasedBalance: data.purchasedBalance ?? 0, fetchedAt: new Date().toISOString(),
    }), 'EX', 60).catch(() => undefined);
```

(extend the `data` type with the two optional balance fields). In `getUsageSummary`:

```ts
  let credits: { remaining: number; includedBalance: number; purchasedBalance: number; fetchedAt: string } | null = null;
  if (billedTo === 'platform') {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const raw = org?.partnerId ? await getRedis().get(`ai:credits:${org.partnerId}`).catch(() => null) : null;
    if (raw) credits = JSON.parse(raw);
  }
```

and add `credits` to the return object and type.

Web: `AiUsagePage.tsx` — a fifth `StatCard` (`label={t('aiUsagePage.creditsRemaining')}`, value `usage.credits.remaining.toLocaleString()`) rendered only when `usage?.credits`; `AiCostIndicator.tsx` — append ` · {credits} credits` to `costDisplay` when `usage.credits`. Locale key `aiUsagePage.creditsRemaining: "Breeze AI credits remaining"` in all eight files.

- [ ] **Step 4: Run tests**

```bash
cd apps/api && npx vitest run src/services/aiCostTracker.test.ts && npx tsc --noEmit -p tsconfig.json
cd ../web && npx vitest run src/components/ai src/lib/i18n/localeParity.test.ts
```

- [ ] **Step 5: Commit and open the W04 (breeze side) PR**

```bash
git add apps/api/src/services/aiCostTracker.ts apps/api/src/services/aiCostTracker.test.ts apps/web/src
git commit -m "feat(ai): surface partner credit balance on /ai/usage and the usage page (#4388 W04)"
```

PR body notes it is safe to merge before the billing deploy (fields already present in the billing response). `Closes #<W04 sub-issue>`. Stop at the open PR.

---

## Self-review (done 2026-09-01)

- **Spec coverage:** §4.1 → tasks 1–3; §4.2 → 4, 5, 9; §4.3 → 1; §4.4 → 8; §4.5 → 7 (`shouldEmail`); §4.6 → 6; §4.7 → 7; §4.8 → 10; §4.9 → 11; §4.10 → 5, 12; §5.1 → 13, 15; §5.2 → 14, 16, 17; §5.3 → 18; §6 self-hosted/BYOK → 8 (`getEmailService()` null path), 18 (`credits: null`); §7 rollout → PR bodies in tasks 17–18.
- **Placeholders:** none; the two `/* ... */` fixture comments in task 5's integration test and task 16's test names point at existing helpers the executor must reuse, not at unwritten logic.
- **Type consistency:** `evaluateAiBudgetThresholds` (tasks 4, 5, 8, 9), `resolveUsersWithPermissionForOrg` (6, 8), `describeAiBudgetAlert` / `buildAiBudgetAlertEmail` / `shouldEmail` (7, 8), `enqueueAiBudgetAlertDelivery` / `enqueueAiBudgetEvaluationForPartner` (8, 9), `alertThresholdPercents` everywhere (Drizzle property, JSONB key, zod, shared type, web state), `rebaselineCreditEpoch` / `evaluateCreditAlerts` (15, 16, 17).
