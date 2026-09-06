/**
 * Real-Postgres integration proof for the pre-cap AI budget alert evaluator
 * (#4388). `evaluateAiBudgetThresholds` is unit-tested against a mocked DB in
 * `services/aiBudgetAlerts.test.ts`; this suite proves the parts a mock
 * cannot: the per-(org, period) advisory-lock + `NOT EXISTS` monotonic guard
 * actually serialises concurrent callers to one inserted row, a raised cap
 * genuinely suppresses a lower rung, and `ai_budget_alert_events`'s RLS shape
 * 1 policies reject a forged cross-org insert as `breeze_app`.
 *
 * Fixtures are re-seeded per test (not in `beforeAll`): the integration
 * setup's global `beforeEach` truncates tenant tables (including
 * `organizations`, which cascades to `ai_budgets` / `ai_cost_usage` /
 * `ai_budget_alert_events`) before every `it`, so a `beforeAll`-seeded org
 * would already be gone by the time the first test runs.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { aiBudgetAlertEvents } from '../../db/schema';
import { evaluateAiBudgetThresholds } from '../../services/aiBudgetAlerts';
import { updateBudget } from '../../services/aiCostTracker';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

/** Seeds via the superuser test client (db-utils), so no RLS context is needed here. */
async function seedOrg(): Promise<string> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return org.id;
}

async function eventRows(orgId: string) {
  return withSystemDbAccessContext(() =>
    db
      .select({ period: aiBudgetAlertEvents.period, thresholdPct: aiBudgetAlertEvents.thresholdPct })
      .from(aiBudgetAlertEvents)
      .where(eq(aiBudgetAlertEvents.orgId, orgId))
  );
}

async function setMonthlyUsage(orgId: string, cents: number) {
  const key = new Date().toISOString().slice(0, 7);
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO ai_cost_usage (org_id, period, period_key, total_cost_cents)
    VALUES (${orgId}::uuid, 'monthly', ${key}, ${cents})
    ON CONFLICT (org_id, period, period_key) DO UPDATE SET total_cost_cents = EXCLUDED.total_cost_cents
  `));
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string; message?: string } }).cause
      ?? (error as { code?: string; message?: string });
  }
}

describe('ai_budget_alert_events (#4388)', () => {
  runDb('fires the highest rung once under concurrent evaluation, then stays monotonic', async () => {
    const orgId = await seedOrg();
    await withSystemDbAccessContext(() => updateBudget(orgId, { monthlyBudgetCents: 10000 }));
    await setMonthlyUsage(orgId, 9600); // 96% of a $100 cap

    const results = await Promise.all([
      evaluateAiBudgetThresholds(orgId),
      evaluateAiBudgetThresholds(orgId),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(results.flat()[0]).toMatchObject({ period: 'monthly', thresholdPct: 95 });

    const rowsAfterRung95 = await eventRows(orgId);
    expect(rowsAfterRung95).toHaveLength(1);
    expect(rowsAfterRung95[0]).toMatchObject({ period: 'monthly', thresholdPct: 95 });

    // Raising the cap drops pct to 48 — no new (lower) rung may fire, and the
    // monotonic guard must leave the row count unchanged.
    await withSystemDbAccessContext(() => updateBudget(orgId, { monthlyBudgetCents: 20000 }));
    expect(await evaluateAiBudgetThresholds(orgId)).toEqual([]);
    expect(await eventRows(orgId)).toHaveLength(1);

    // Crossing 100% fires exactly one more row (rung 100).
    await setMonthlyUsage(orgId, 20000);
    expect(await evaluateAiBudgetThresholds(orgId)).toMatchObject([{ period: 'monthly', thresholdPct: 100 }]);

    const finalRows = await eventRows(orgId);
    expect(finalRows).toHaveLength(2);
    expect(finalRows.map((r) => r.thresholdPct).sort((a, b) => a - b)).toEqual([95, 100]);
  });

  runDb('rejects a forged cross-org insert into ai_budget_alert_events as breeze_app', async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();

    const forged = await causeOf(() => withDbAccessContext(orgContext(orgA), () => db.execute(sql`
      INSERT INTO ai_budget_alert_events (
        org_id, period, period_key, threshold_pct, cap_cents, used_cents, billing_source
      ) VALUES (
        ${orgB}::uuid, 'monthly', '2026-09', 50, 10000, 5000, 'platform'
      )
    `)));

    expect(forged?.code).toBe('42501');
    expect(forged?.message).toMatch(
      /new row violates row-level security policy for table "ai_budget_alert_events"/
    );

    const visibleToOrgA = await withDbAccessContext(orgContext(orgA), () => db.execute(sql`
      SELECT id FROM ai_budget_alert_events WHERE org_id = ${orgB}::uuid
    `));
    expect(visibleToOrgA).toHaveLength(0);
  });
});
