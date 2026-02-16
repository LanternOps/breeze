/**
 * AI Cost Tracker
 *
 * Tracks token usage and costs per message, enforces budget limits,
 * and provides usage summaries.
 */

import { db } from '../db';
import { aiSessions, aiCostUsage, aiBudgets } from '../db/schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';

// Cost per million tokens (in cents)
const MODEL_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-sonnet-4-5-20250929': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 100, outputPerMillion: 500 }
};

const DEFAULT_PRICING = { inputPerMillion: 300, outputPerMillion: 1500 };

export function calculateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round((inputCost + outputCost) * 100) / 100;
}

/**
 * Check if the org is within budget limits before sending a message.
 * Returns null if allowed, or an error message if blocked.
 */
export async function checkBudget(orgId: string): Promise<string | null> {
  const [budget] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  // No budget configured = no limits
  if (!budget) return null;
  if (!budget.enabled) return 'AI features are disabled for this organization';

  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Check daily budget
  if (budget.dailyBudgetCents) {
    const [dailyUsage] = await db
      .select({ totalCostCents: aiCostUsage.totalCostCents })
      .from(aiCostUsage)
      .where(
        and(
          eq(aiCostUsage.orgId, orgId),
          eq(aiCostUsage.period, 'daily'),
          eq(aiCostUsage.periodKey, dailyKey)
        )
      )
      .limit(1);

    if (dailyUsage && dailyUsage.totalCostCents >= budget.dailyBudgetCents) {
      return `Daily AI budget exceeded ($${(budget.dailyBudgetCents / 100).toFixed(2)})`;
    }
  }

  // Check monthly budget
  if (budget.monthlyBudgetCents) {
    const [monthlyUsage] = await db
      .select({ totalCostCents: aiCostUsage.totalCostCents })
      .from(aiCostUsage)
      .where(
        and(
          eq(aiCostUsage.orgId, orgId),
          eq(aiCostUsage.period, 'monthly'),
          eq(aiCostUsage.periodKey, monthlyKey)
        )
      )
      .limit(1);

    if (monthlyUsage && monthlyUsage.totalCostCents >= budget.monthlyBudgetCents) {
      return `Monthly AI budget exceeded ($${(budget.monthlyBudgetCents / 100).toFixed(2)})`;
    }
  }

  return null;
}

/**
 * Check rate limits for AI messages.
 * Returns null if allowed, or an error message if rate limited.
 */
export async function checkAiRateLimit(
  userId: string,
  orgId: string
): Promise<string | null> {
  const redis = getRedis();

  // Per-user rate limit: 20 messages/min
  const userResult = await rateLimiter(redis, `ai:msg:user:${userId}`, 20, 60);
  if (!userResult.allowed) {
    return `Rate limit exceeded. Try again at ${userResult.resetAt.toISOString()}`;
  }

  // Per-org rate limit: 200 messages/hour
  const orgResult = await rateLimiter(redis, `ai:msg:org:${orgId}`, 200, 3600);
  if (!orgResult.allowed) {
    return `Organization rate limit exceeded. Try again at ${orgResult.resetAt.toISOString()}`;
  }

  return null;
}

/**
 * Record token usage for a message and update aggregates.
 */
export async function recordUsage(
  sessionId: string,
  orgId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  isToolExecution: boolean
): Promise<void> {
  const costCents = calculateCostCents(model, inputTokens, outputTokens);
  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Run queries individually instead of in a transaction to avoid
  // SAVEPOINT errors with the postgres.js driver (postgres@3.4.8).
  // These are additive counters so partial failure is acceptable.
  try {
    await db
      .update(aiSessions)
      .set({
        totalInputTokens: sql`${aiSessions.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${aiSessions.totalOutputTokens} + ${outputTokens}`,
        totalCostCents: sql`${aiSessions.totalCostCents} + ${costCents}`,
        turnCount: sql`${aiSessions.turnCount} + 1`,
        lastActivityAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(aiSessions.id, sessionId));
  } catch (err) {
    console.error(`[AI] Failed to update session totals for session=${sessionId}, cost=${costCents}:`, err);
    throw err;
  }

  // Update daily/monthly aggregates
  for (const [period, periodKey] of [['daily', dailyKey], ['monthly', monthlyKey]] as const) {
    try {
      await db
        .insert(aiCostUsage)
        .values({
          orgId,
          period,
          periodKey,
          inputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount: 0,
          messageCount: 1,
          toolExecutionCount: isToolExecution ? 1 : 0
        })
        .onConflictDoUpdate({
          target: [aiCostUsage.orgId, aiCostUsage.period, aiCostUsage.periodKey],
          set: {
            inputTokens: sql`${aiCostUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${aiCostUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${aiCostUsage.totalCostCents} + ${costCents}`,
            messageCount: sql`${aiCostUsage.messageCount} + 1`,
            toolExecutionCount: isToolExecution
              ? sql`${aiCostUsage.toolExecutionCount} + 1`
              : aiCostUsage.toolExecutionCount,
            updatedAt: new Date()
          }
        });
    } catch (err) {
      console.error(`[AI] Failed to update ${period} aggregate for org=${orgId}, key=${periodKey}, cost=${costCents}:`, err);
      // Continue to attempt the other period
    }
  }

  // Cost anomaly detection (after counter updates)
  checkCostAnomalies(sessionId, orgId, costCents, dailyKey).catch(err => {
    console.error('[AI] Cost anomaly check failed:', err);
  });
}

/**
 * Record usage from the Claude Agent SDK result message.
 * The SDK provides total_cost_usd and per-model token breakdowns.
 */
export async function recordUsageFromSdkResult(
  sessionId: string,
  orgId: string,
  result: {
    total_cost_usd: number;
    usage: { input_tokens: number; output_tokens: number };
    num_turns: number;
  }
): Promise<void> {
  if (!orgId) {
    console.warn(`[AI] Skipping recordUsageFromSdkResult — empty orgId for session=${sessionId}`);
    return;
  }
  const costCents = Math.round(result.total_cost_usd * 100 * 100) / 100; // USD → cents, 2 decimal places
  const { input_tokens: inputTokens, output_tokens: outputTokens } = result.usage;
  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Update session totals
  try {
    await db
      .update(aiSessions)
      .set({
        totalInputTokens: sql`${aiSessions.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${aiSessions.totalOutputTokens} + ${outputTokens}`,
        totalCostCents: sql`${aiSessions.totalCostCents} + ${costCents}`,
        turnCount: sql`${aiSessions.turnCount} + ${result.num_turns}`,
        lastActivityAt: now,
        updatedAt: now
      })
      .where(eq(aiSessions.id, sessionId));
  } catch (err) {
    console.error(`[AI] Failed to update session totals (SDK) for session=${sessionId}:`, err);
    throw err;
  }

  // Update daily/monthly aggregates
  for (const [period, periodKey] of [['daily', dailyKey], ['monthly', monthlyKey]] as const) {
    try {
      await db
        .insert(aiCostUsage)
        .values({
          orgId,
          period,
          periodKey,
          inputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount: 0,
          messageCount: 1,
          toolExecutionCount: 0
        })
        .onConflictDoUpdate({
          target: [aiCostUsage.orgId, aiCostUsage.period, aiCostUsage.periodKey],
          set: {
            inputTokens: sql`${aiCostUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${aiCostUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${aiCostUsage.totalCostCents} + ${costCents}`,
            messageCount: sql`${aiCostUsage.messageCount} + 1`,
            updatedAt: now
          }
        });
    } catch (err) {
      console.error(`[AI] Failed to update ${period} aggregate (SDK) for org=${orgId}:`, err);
    }
  }

  // Cost anomaly detection
  checkCostAnomalies(sessionId, orgId, costCents, dailyKey).catch(err => {
    console.error('[AI] Cost anomaly check failed (SDK):', err);
  });
}

/**
 * Get the remaining monthly budget for an org in USD.
 * Returns null if no budget is configured (unlimited).
 */
export async function getRemainingBudgetUsd(orgId: string): Promise<number | null> {
  const [budget] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  if (!budget || !budget.monthlyBudgetCents) return null;

  const now = new Date();
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const [monthlyUsage] = await db
    .select({ totalCostCents: aiCostUsage.totalCostCents })
    .from(aiCostUsage)
    .where(
      and(
        eq(aiCostUsage.orgId, orgId),
        eq(aiCostUsage.period, 'monthly'),
        eq(aiCostUsage.periodKey, monthlyKey)
      )
    )
    .limit(1);

  const usedCents = monthlyUsage?.totalCostCents ?? 0;
  const remainingCents = Math.max(0, budget.monthlyBudgetCents - usedCents);
  return remainingCents / 100; // Convert cents to USD
}

/**
 * Check for cost anomalies after recording usage.
 * Logs warnings for sessions consuming too much budget.
 */
async function checkCostAnomalies(
  sessionId: string,
  orgId: string,
  costCents: number,
  dailyKey: string
): Promise<void> {
  const [budget] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  if (!budget || !budget.dailyBudgetCents) return;

  // Check if single session exceeds 10% of daily budget
  const [session] = await db
    .select({ totalCostCents: aiSessions.totalCostCents })
    .from(aiSessions)
    .where(eq(aiSessions.id, sessionId))
    .limit(1);

  if (session && session.totalCostCents > budget.dailyBudgetCents * 0.1) {
    console.warn(
      `[AI] Cost anomaly: session ${sessionId} has used ${session.totalCostCents} cents ` +
      `(>${Math.round(budget.dailyBudgetCents * 0.1)} cents = 10% of daily budget)`
    );
  }

  // Check if daily spend > 80% of budget
  const [dailyUsage] = await db
    .select({ totalCostCents: aiCostUsage.totalCostCents })
    .from(aiCostUsage)
    .where(
      and(
        eq(aiCostUsage.orgId, orgId),
        eq(aiCostUsage.period, 'daily'),
        eq(aiCostUsage.periodKey, dailyKey)
      )
    )
    .limit(1);

  if (dailyUsage && dailyUsage.totalCostCents > budget.dailyBudgetCents * 0.8) {
    console.warn(
      `[AI] Cost warning: org ${orgId} daily spend at ${dailyUsage.totalCostCents} cents ` +
      `(>${Math.round(budget.dailyBudgetCents * 0.8)} cents = 80% of daily budget)`
    );
  }
}

/**
 * Update the AI budget for an org.
 */
export async function updateBudget(orgId: string, settings: {
  enabled?: boolean;
  monthlyBudgetCents?: number | null;
  dailyBudgetCents?: number | null;
  maxTurnsPerSession?: number;
  messagesPerMinutePerUser?: number;
  messagesPerHourPerOrg?: number;
}): Promise<void> {
  const [existing] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  if (existing) {
    await db.update(aiBudgets).set({
      ...settings,
      updatedAt: new Date()
    }).where(eq(aiBudgets.orgId, orgId));
  } else {
    await db.insert(aiBudgets).values({
      orgId,
      enabled: settings.enabled ?? true,
      monthlyBudgetCents: settings.monthlyBudgetCents ?? null,
      dailyBudgetCents: settings.dailyBudgetCents ?? null,
      maxTurnsPerSession: settings.maxTurnsPerSession ?? 50,
      messagesPerMinutePerUser: settings.messagesPerMinutePerUser ?? 20,
      messagesPerHourPerOrg: settings.messagesPerHourPerOrg ?? 200
    });
  }
}

/**
 * Get session history for admin dashboard.
 */
export async function getSessionHistory(orgId: string, options: { limit?: number; offset?: number }): Promise<Array<{
  id: string;
  userId: string | null;
  title: string | null;
  model: string;
  turnCount: number;
  totalCostCents: number;
  status: string;
  createdAt: Date;
}>> {
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  return db
    .select({
      id: aiSessions.id,
      userId: aiSessions.userId,
      title: aiSessions.title,
      model: aiSessions.model,
      turnCount: aiSessions.turnCount,
      totalCostCents: aiSessions.totalCostCents,
      status: aiSessions.status,
      createdAt: aiSessions.createdAt
    })
    .from(aiSessions)
    .where(eq(aiSessions.orgId, orgId))
    .orderBy(desc(aiSessions.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get usage summary for an org.
 */
export async function getUsageSummary(orgId: string): Promise<{
  daily: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  monthly: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  budget: {
    enabled: boolean;
    monthlyBudgetCents: number | null;
    dailyBudgetCents: number | null;
    monthlyUsedCents: number;
    dailyUsedCents: number;
  } | null;
}> {
  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const [dailyUsage] = await db
    .select()
    .from(aiCostUsage)
    .where(and(eq(aiCostUsage.orgId, orgId), eq(aiCostUsage.period, 'daily'), eq(aiCostUsage.periodKey, dailyKey)))
    .limit(1);

  const [monthlyUsage] = await db
    .select()
    .from(aiCostUsage)
    .where(and(eq(aiCostUsage.orgId, orgId), eq(aiCostUsage.period, 'monthly'), eq(aiCostUsage.periodKey, monthlyKey)))
    .limit(1);

  const [budget] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  return {
    daily: {
      inputTokens: dailyUsage?.inputTokens ?? 0,
      outputTokens: dailyUsage?.outputTokens ?? 0,
      totalCostCents: dailyUsage?.totalCostCents ?? 0,
      messageCount: dailyUsage?.messageCount ?? 0
    },
    monthly: {
      inputTokens: monthlyUsage?.inputTokens ?? 0,
      outputTokens: monthlyUsage?.outputTokens ?? 0,
      totalCostCents: monthlyUsage?.totalCostCents ?? 0,
      messageCount: monthlyUsage?.messageCount ?? 0
    },
    budget: budget ? {
      enabled: budget.enabled,
      monthlyBudgetCents: budget.monthlyBudgetCents,
      dailyBudgetCents: budget.dailyBudgetCents,
      monthlyUsedCents: monthlyUsage?.totalCostCents ?? 0,
      dailyUsedCents: dailyUsage?.totalCostCents ?? 0
    } : null
  };
}
