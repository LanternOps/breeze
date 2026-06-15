/**
 * AI for Office — per-user metering buckets (spec §8).
 *
 * client_ai_usage (Plan 1 migration; RLS shape 1) mirrors the ai_cost_usage
 * daily/monthly bucket pattern PLUS a client_user_id dimension so the MSP can
 * invoice per end-user. recordClientUsage runs ALONGSIDE the org-level
 * recordUsageFromSdkResult (which keeps partner billing-credit deduction and
 * ai_cost_usage flowing unchanged) — wired via ActiveSession.recordExtraUsage.
 *
 * Budget semantics (spec §4/§7): org daily/monthly caps live in
 * client_ai_org_policies; spend is the SUM of this table's org buckets across
 * users. Upserts mirror aiCostTracker.ts:297-325 (no transaction — additive
 * counters, partial failure acceptable).
 *
 * Callers must be inside a DB access context that can see the org's rows
 * (request path: clientAiAuthMiddleware org scope; background path: the
 * recordExtraUsage closure opens its own org-scoped context).
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { clientAiUsage } from '../db/schema/clientAi';
import type { ClientAiOrgPolicy } from './clientAiPolicy';

export function clientUsageDailyKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

export function clientUsageMonthlyKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface ClientUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  costCents?: number;
  messageCount?: number;
  sessionCount?: number;
}

export async function recordClientUsage(
  orgId: string,
  clientUserId: string,
  delta: ClientUsageDelta,
): Promise<void> {
  const now = new Date();
  const inputTokens = delta.inputTokens ?? 0;
  const outputTokens = delta.outputTokens ?? 0;
  const costCents = delta.costCents ?? 0;
  const messageCount = delta.messageCount ?? 0;
  const sessionCount = delta.sessionCount ?? 0;

  for (const [period, periodKey] of [
    ['daily', clientUsageDailyKey(now)],
    ['monthly', clientUsageMonthlyKey(now)],
  ] as const) {
    try {
      await db
        .insert(clientAiUsage)
        .values({
          orgId,
          clientUserId,
          period,
          periodKey,
          inputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount,
          messageCount,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            clientAiUsage.orgId,
            clientAiUsage.clientUserId,
            clientAiUsage.period,
            clientAiUsage.periodKey,
          ],
          set: {
            inputTokens: sql`${clientAiUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${clientAiUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${clientAiUsage.totalCostCents} + ${costCents}`,
            sessionCount: sql`${clientAiUsage.sessionCount} + ${sessionCount}`,
            messageCount: sql`${clientAiUsage.messageCount} + ${messageCount}`,
            updatedAt: now,
          },
        });
    } catch (err) {
      console.error(
        `[client-ai] Failed to update ${period} usage bucket for org=${orgId}, user=${clientUserId}:`,
        err,
      );
      // Continue to attempt the other period (aiCostTracker convention).
    }
  }
}

/** Org-wide spend for a bucket: SUM across all the org's client users. */
export async function getOrgPeriodCostCents(
  orgId: string,
  period: 'daily' | 'monthly',
  periodKey: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${clientAiUsage.totalCostCents}), 0)` })
    .from(clientAiUsage)
    .where(
      and(
        eq(clientAiUsage.orgId, orgId),
        eq(clientAiUsage.period, period),
        eq(clientAiUsage.periodKey, periodKey),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Pre-flight org budget gate (spec §4). Returns a user-readable rejection
 * reason or null. NULL budget = unlimited (no DB read for that period).
 */
export async function checkClientBudget(policy: ClientAiOrgPolicy): Promise<string | null> {
  const now = new Date();

  if (policy.dailyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'daily', clientUsageDailyKey(now));
    if (spent >= policy.dailyBudgetCents) {
      return `Daily AI budget for your organization has been reached ($${(policy.dailyBudgetCents / 100).toFixed(2)}). Try again tomorrow or contact your IT provider.`;
    }
  }

  if (policy.monthlyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'monthly', clientUsageMonthlyKey(now));
    if (spent >= policy.monthlyBudgetCents) {
      return `Monthly AI budget for your organization has been reached ($${(policy.monthlyBudgetCents / 100).toFixed(2)}). Contact your IT provider to raise it.`;
    }
  }

  return null;
}

/**
 * Remaining budget in USD for the SDK's maxBudgetUsd hard stop — the tighter
 * of the configured daily/monthly remainders. undefined = unlimited.
 */
export async function getRemainingClientBudgetUsd(
  policy: ClientAiOrgPolicy,
): Promise<number | undefined> {
  const now = new Date();
  const remainders: number[] = [];

  if (policy.dailyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'daily', clientUsageDailyKey(now));
    remainders.push(Math.max(0, policy.dailyBudgetCents - spent));
  }
  if (policy.monthlyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'monthly', clientUsageMonthlyKey(now));
    remainders.push(Math.max(0, policy.monthlyBudgetCents - spent));
  }

  if (remainders.length === 0) return undefined;
  return Math.min(...remainders) / 100;
}
