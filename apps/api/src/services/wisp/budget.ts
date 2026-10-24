/**
 * Wisp W05 — per-grant daily budget (Wisp design §9, §16; w00 `budget.ts`,
 * A6, A22, A32).
 *
 * The window is the UTC day. A run is charged to the day it was QUEUED
 * (`ai_agent_runs.queued_at`), never the day it finished: a run admitted at
 * 23:59 under budget cannot be refused retroactively, and the new day starts
 * at zero (W05 Review Focus 4). Skipped runs never spent anything and are
 * excluded.
 *
 * An exhausted budget does NOT pause the grant (w00): `chargeableUnderGrant`
 * only answers; assessments skip, the deterministic digest path keeps
 * running, and the grantor is told once per window
 * (`notifyBudgetExhaustedOnce`).
 *
 * Every grant / run read runs in SYSTEM context: callers are workers and the
 * thread route, which have already established the grant id they hold.
 *
 * Import discipline: grants.ts imports WISP_BUDGET_DEFAULT_BY_PLAN from here,
 * so this module imports only TYPES from grants.ts (no runtime cycle).
 */
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { PartnerPlan, WispLimits } from '@breeze/shared';
import { db } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { wispGrants } from '../../db/schema/wisp';
import { getEntitlements } from '../entitlements';
import { deliverInApp } from './deliver';
import { inSystemContext } from './grantAuthority';
import type { GrantSettingsBounds } from './grants';
import { getOrCreateThread } from './threads';

/**
 * Spec §16 default `budget_cents_per_day` for a new grant. Plans below pro
 * have Wisp disabled by default, so their value is reachable only through a
 * manual entitlement; they get the entry tier's 200.
 */
export const WISP_BUDGET_DEFAULT_BY_PLAN: Record<PartnerPlan, number> = {
  free: 200,
  starter: 200,
  community: 200,
  pro: 200,
  enterprise: 500,
  unlimited: 1000,
};

/** Spec §9: a partner admin may raise a grant's budget to 5× the plan default (≤ the plan ceiling). */
const BUDGET_RAISE_MULTIPLIER = 5;
/** The DB CHECK floor on `floor_tick_minutes`; entitlement limits can only raise it. */
const MIN_FLOOR_TICK_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The grant id a budget call was given does not exist. Never read as "ok" or "exhausted". */
export class GrantNotFoundForBudgetError extends Error {
  readonly code = 'grant_not_found' as const;
  constructor(public readonly grantId: string) {
    super(`Wisp grant ${grantId} not found for a budget check.`);
    this.name = 'GrantNotFoundForBudgetError';
  }
}

/**
 * The UTC day `now` falls in: [start, end), `end` = next UTC midnight
 * (exclusive). `key` is 'YYYY-MM-DD', the same derivation as
 * aiCostTracker's daily period key.
 */
export function utcDayWindow(now: Date): { start: Date; end: Date; key: string } {
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  // UTC has no DST: every UTC day is exactly 24 h.
  return { start: new Date(startMs), end: new Date(startMs + DAY_MS), key };
}

/** The partner's plan bounds for PATCH /wisp/grants/:id/settings (w00 A6). */
export async function grantSettingsBounds(partnerId: string): Promise<GrantSettingsBounds> {
  const { plan, entitlements } = await getEntitlements(partnerId);
  // Stored limits are schema-checked on read by the resolver; null = none declared.
  const limits = entitlements.wisp.limits as WispLimits | null;
  const raiseCap = BUDGET_RAISE_MULTIPLIER * WISP_BUDGET_DEFAULT_BY_PLAN[plan];
  return {
    budgetCentsPerDayMax: Math.min(raiseCap, limits?.budgetCentsPerDayCeiling ?? Number.POSITIVE_INFINITY),
    minFloorTickMinutes: Math.max(MIN_FLOOR_TICK_MINUTES, limits?.minFloorTickMinutes ?? MIN_FLOOR_TICK_MINUTES),
  };
}

type GrantBudgetRow = { id: string; partnerId: string; orgId: string | null; grantorUserId: string; budgetCentsPerDay: number };

async function loadGrantBudget(grantId: string): Promise<GrantBudgetRow> {
  const [row] = await inSystemContext(() =>
    db
      .select({
        id: wispGrants.id,
        partnerId: wispGrants.partnerId,
        orgId: wispGrants.orgId,
        grantorUserId: wispGrants.grantorUserId,
        budgetCentsPerDay: wispGrants.budgetCentsPerDay,
      })
      .from(wispGrants)
      .where(eq(wispGrants.id, grantId))
      .limit(1),
  );
  if (!row) throw new GrantNotFoundForBudgetError(grantId);
  return { ...row, orgId: row.orgId ?? null };
}

/** SUM(cost_cents) of the grant's runs QUEUED in the UTC day `now` falls in, excluding skipped runs. */
export async function spentUnderGrant(grantId: string, now: Date = new Date()): Promise<number> {
  const { start, end } = utcDayWindow(now);
  const [row] = await inSystemContext(() =>
    db
      .select({ total: sql<string | number | null>`coalesce(sum(${aiAgentRuns.costCents}), 0)::bigint` })
      .from(aiAgentRuns)
      .where(and(
        eq(aiAgentRuns.grantId, grantId),
        gte(aiAgentRuns.queuedAt, start),
        lt(aiAgentRuns.queuedAt, end),
        ne(aiAgentRuns.status, 'skipped'),
      )),
  );
  return Number(row?.total ?? 0);
}

/** Both reads under ONE system context (the inner inSystemContext calls run in place). */
function grantAndSpend(grantId: string, now: Date): Promise<{ grant: GrantBudgetRow; spent: number }> {
  return inSystemContext(async () => {
    const grant = await loadGrantBudget(grantId);
    return { grant, spent: await spentUnderGrant(grantId, now) };
  });
}

/**
 * May a run estimated at `estimateCents` be admitted under the grant today?
 * ok iff spent + estimate ≤ budget_cents_per_day. Never pauses the grant.
 */
export async function chargeableUnderGrant(
  grantId: string,
  estimateCents: number,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: 'budget_exhausted' }> {
  if (!Number.isFinite(estimateCents) || estimateCents < 0) {
    throw new RangeError(`estimateCents must be a non-negative finite number (got ${estimateCents}).`);
  }
  const { grant, spent } = await grantAndSpend(grantId, now);
  return spent + estimateCents <= grant.budgetCentsPerDay ? { ok: true } : { ok: false, reason: 'budget_exhausted' };
}

/**
 * Tell the grantor, once per UTC window, that the budget is spent (spec §9
 * "told once, with a one-tap raise"): the link lands on the grant's thread
 * page, whose header carries the budget control. Returns whether a notice
 * was written (false when this window's dedupe key already exists).
 */
export async function notifyBudgetExhaustedOnce(grantId: string, now: Date = new Date()): Promise<boolean> {
  const grant = await loadGrantBudget(grantId);
  const window = utcDayWindow(now);
  const thread = await getOrCreateThread(grantId);
  const link = `/ai/wisp/thread/${thread.id}`;
  const { created } = await deliverInApp({
    userId: grant.grantorUserId,
    orgId: grant.orgId,
    title: 'Wisp paused for today — budget reached',
    body: 'Raise the daily budget from the thread header to resume.',
    link,
    threadId: thread.id,
    grantId,
    deepLink: link,
    dedupeKey: `wisp-budget-${grantId}-${window.key}`,
  });
  return created;
}

/** The spend meter (w00 A32): today's spend, the budget, and when the window resets. */
export async function spendSummary(
  grantId: string,
  now: Date = new Date(),
): Promise<{ spentTodayCents: number; budgetCentsPerDay: number; budgetResetsAt: Date }> {
  const { grant, spent: spentTodayCents } = await grantAndSpend(grantId, now);
  return { spentTodayCents, budgetCentsPerDay: grant.budgetCentsPerDay, budgetResetsAt: utcDayWindow(now).end };
}
