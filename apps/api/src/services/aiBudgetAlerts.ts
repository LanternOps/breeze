/**
 * #4388 — pre-cap AI budget alerts.
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-01-ai-budget-threshold-alerts-design.md §4
 */

import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getEffectiveAiBudget } from './effectiveSettings';
import { getLlmBillingSourceForOrg } from './llm/llmConfigResolver';
import { captureException } from './sentry';

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
 *
 * Task 8 (later wave) enqueues delivery after each inserted row — that call
 * belongs right after `created.push(...)` below.
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
