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
 * only answers. Background admissions skip (the floor tick, event assessments,
 * the first look, specialist launches, model-written summaries), the
 * deterministic digest path keeps running, and the grantor is told once per
 * window (`notifyBudgetExhaustedOnce`).
 *
 * #10390: the spend is the grant's runs plus its model-written session summaries.
 * A summary is not a run (no agent, no policy snapshot, nothing to trace), so it
 * is read from the billing ledger by a grant-keyed `source_ref`, in the window its
 * row was created.
 *
 * #10414 (docs/superpowers/specs/ai-mcp/2026-11-06-wisp-chat-grant-followups-spec.md
 * §4, Option 2): chat counts and warns; a chat TURN is never refused here.
 * A chat line is an invocation on a session carrying this grant
 * (`ai_sessions.wisp_grant_id`) that is not a run's own call
 * (`agent_run_id IS NULL`), charged to the UTC day it settled (`created_at`).
 * Chat spend can exhaust the budget, which stops BACKGROUND admission only. A
 * specialist requested from chat (`launch_specialist`) is background work and
 * is refused like any other launch; the chat turn carries on. Every caller of
 * `chargeableUnderGrant` is classified in budget.chatNeverBlocks.contract.test.ts.
 * The org AI budget stays chat's hard stop.
 *
 * Every grant / run read runs in SYSTEM context: callers are workers and the
 * thread route, which have already established the grant id they hold.
 *
 * Import discipline: grants.ts imports WISP_BUDGET_DEFAULT_BY_PLAN from here,
 * so this module imports only TYPES from grants.ts (no runtime cycle).
 */
import { and, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { PartnerPlan, WispLimits } from '@breeze/shared';
import { db } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiInvocations } from '../../db/schema/aiInvocations';
import { wispGrants } from '../../db/schema/wisp';
import { getEntitlements } from '../entitlements';
import { deliverInApp } from './deliver';
import { inSystemContext } from './grantAuthority';
import type { GrantSettingsBounds } from './grants';
import { getOrCreateThread } from './threads';
import { incWispBudgetExhausted } from '../wispMetrics';

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

/** The `ai_invocations.source_ref` prefix of a model-written session summary; the grant id follows it. */
export const SUMMARY_REFINE_SOURCE_REF_PREFIX = 'wisp_thread_summary:';

/** The `ai_invocations.source_ref` prefix of a turn-end standing-instruction extraction (#10428); the grant id follows it. */
export const INSTRUCTION_EXTRACT_SOURCE_REF_PREFIX = 'wisp_instruction_extract:';

/** The ledger ref that charges a model-written session summary to its grant's daily budget. */
export function summaryRefineSourceRef(grantId: string): string {
  return `${SUMMARY_REFINE_SOURCE_REF_PREFIX}${grantId}`;
}

/**
 * The closed list of `ai_invocations.source_ref` prefixes whose sessionless,
 * grant-keyed rows are charged to the grant's BACKGROUND line (the grant id
 * follows the prefix). A sessionless model call this feature adds registers
 * its prefix here; anything not listed is not grant spend.
 */
export const GRANT_OVERHEAD_SOURCE_REF_PREFIXES: readonly string[] = [
  SUMMARY_REFINE_SOURCE_REF_PREFIX,
  // #10428 (W05): the turn-end standing-instruction extractor (instructionExtractor.ts).
  INSTRUCTION_EXTRACT_SOURCE_REF_PREFIX,
];

/** Every overhead ledger ref for one grant, one per registered prefix. */
export function grantOverheadSourceRefs(grantId: string): string[] {
  return GRANT_OVERHEAD_SOURCE_REF_PREFIXES.map((prefix) => `${prefix}${grantId}`);
}

/** One UTC day of a grant's spend, in whole cents: `backgroundCents + chatCents === totalCents`. */
export type GrantSpendBreakdown = { backgroundCents: number; chatCents: number; totalCents: number };

/** The ledger holds `numeric(20, 6)` cents; adding in integer micro-cents keeps the one rounding exact. */
const MICRO_PER_CENT = 1_000_000;
const toMicroCents = (cents: number): number => Math.round(cents * MICRO_PER_CENT);

/**
 * Combine the three raw spend lines into whole cents. Runs are already whole
 * cents; overhead and chat are ledger fractions summed raw and rounded up ONCE
 * together (a budget never rounds in the spender's favour, and never rounds
 * twice). Chat gets its own rounded-up line, capped at what the rounding left
 * after runs, so the two lines always add back to the total.
 */
export function combineSpendLines(input: { runsCents: number; overheadRaw: number; chatRaw: number }): GrantSpendBreakdown {
  const overheadMicro = Math.max(0, toMicroCents(input.overheadRaw));
  const chatMicro = Math.max(0, toMicroCents(input.chatRaw));
  const ledgerCents = Math.ceil((overheadMicro + chatMicro) / MICRO_PER_CENT);
  const totalCents = input.runsCents + ledgerCents;
  const chatCents = Math.min(Math.ceil(chatMicro / MICRO_PER_CENT), ledgerCents);
  return { backgroundCents: totalCents - chatCents, chatCents, totalCents };
}

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

/**
 * What the grant spent in the UTC day `now` falls in, by line:
 *  - background: its runs QUEUED that day (excluding skipped ones), plus its
 *    grant-keyed overhead rows (`GRANT_OVERHEAD_SOURCE_REF_PREFIXES`) settled
 *    that day;
 *  - chat: invocations on its Wisp sessions that are not a run's own call,
 *    settled that day.
 * Outstanding reservations are not counted, for any line.
 */
export async function spendBreakdownUnderGrant(grantId: string, now: Date = new Date()): Promise<GrantSpendBreakdown> {
  const { start, end } = utcDayWindow(now);
  const { runs, overhead, chat } = await inSystemContext(async () => {
    const runRows = await db
      .select({ total: sql<string | number | null>`coalesce(sum(${aiAgentRuns.costCents}), 0)::bigint` })
      .from(aiAgentRuns)
      .where(and(
        eq(aiAgentRuns.grantId, grantId),
        gte(aiAgentRuns.queuedAt, start),
        lt(aiAgentRuns.queuedAt, end),
        ne(aiAgentRuns.status, 'skipped'),
      ));
    const overheadRows = await db
      .select({ total: sql<string | number | null>`coalesce(sum(${aiInvocations.costCents}), 0)` })
      .from(aiInvocations)
      .where(and(
        // The ledger is the busiest table: the partner's orgs let ai_invocations_org_created_idx
        // serve this, instead of reading a day of every tenant's rows on each budget check.
        sql`${aiInvocations.orgId} IN (SELECT o.id FROM organizations o JOIN wisp_grants g ON g.partner_id = o.partner_id WHERE g.id = ${grantId}::uuid)`,
        inArray(aiInvocations.sourceRef, grantOverheadSourceRefs(grantId)),
        gte(aiInvocations.createdAt, start),
        lt(aiInvocations.createdAt, end),
      ));
    const chatRows = await db
      .select({ total: sql<string | number | null>`coalesce(sum(${aiInvocations.costCents}), 0)` })
      .from(aiInvocations)
      .where(and(
        // Scoped through the grant's sessions, not the org index: a grant has few sessions.
        // ANY(ARRAY(...)) makes the session lookup an InitPlan (ai_sessions_wisp_grant_idx)
        // whose ids probe ai_invocations_session_idx; a plain IN (...) semi-join can be
        // planned invocations-first on skewed stats and walk the whole session index.
        sql`${aiInvocations.sessionId} = ANY(ARRAY(SELECT s.id FROM ai_sessions s WHERE s.wisp_grant_id = ${grantId}::uuid))`,
        // A run's own calls are already in its cost_cents (the background line).
        isNull(aiInvocations.agentRunId),
        gte(aiInvocations.createdAt, start),
        lt(aiInvocations.createdAt, end),
      ));
    return { runs: runRows[0], overhead: overheadRows[0], chat: chatRows[0] };
  });
  return combineSpendLines({
    runsCents: Number(runs?.total ?? 0),
    overheadRaw: Number(overhead?.total ?? 0),
    chatRaw: Number(chat?.total ?? 0),
  });
}

/** The grant's total spend today in whole cents (`spendBreakdownUnderGrant(...).totalCents`). */
export async function spentUnderGrant(grantId: string, now: Date = new Date()): Promise<number> {
  return (await spendBreakdownUnderGrant(grantId, now)).totalCents;
}

/** Both reads under ONE system context (the inner inSystemContext calls run in place). */
function grantAndSpend(grantId: string, now: Date): Promise<{ grant: GrantBudgetRow; spend: GrantSpendBreakdown }> {
  return inSystemContext(async () => {
    const grant = await loadGrantBudget(grantId);
    return { grant, spend: await spendBreakdownUnderGrant(grantId, now) };
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
  const { grant, spend } = await grantAndSpend(grantId, now);
  if (spend.totalCents + estimateCents <= grant.budgetCentsPerDay) return { ok: true };
  incWispBudgetExhausted();
  return { ok: false, reason: 'budget_exhausted' };
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
    // The grant stays `active` (see the file header): background checks skip until the UTC day rolls over
    // and chat keeps working, so never say the grant is "paused" — the header and this copy must agree (#10145, #10414).
    title: "Wisp is over today's budget: background checks resume at 00:00 UTC",
    body: 'Chat keeps working. Raise the budget from the thread header to resume background checks sooner.',
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
): Promise<{ spentTodayCents: number; backgroundCents: number; chatCents: number; budgetCentsPerDay: number; budgetResetsAt: Date }> {
  const { grant, spend } = await grantAndSpend(grantId, now);
  return { spentTodayCents: spend.totalCents, backgroundCents: spend.backgroundCents, chatCents: spend.chatCents, budgetCentsPerDay: grant.budgetCentsPerDay, budgetResetsAt: utcDayWindow(now).end };
}
