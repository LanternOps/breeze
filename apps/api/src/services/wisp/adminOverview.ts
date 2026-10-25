/**
 * Wisp W07 Task 9 (#10141) — the platform-admin Wisp overview behind
 * `/admin/wisp` (routes/admin/wisp.ts, web WispAdminPage.tsx).
 *
 * Read-only and cross-tenant by design: the CALLER wraps every function here in
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))`, exactly as
 * routes/admin/aiToolUsage.ts does. It reads counts and grant metadata only —
 * never ceiling snapshots, run transcripts or concern evidence.
 *
 * "Today" is the UTC day `now` falls in (`utcDayWindow`, the same window the
 * per-grant budget is charged against in budget.ts).
 */
import { and, eq, gte, inArray, isNotNull, like, lt, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { partners } from '../../db/schema/orgs';
import { users } from '../../db/schema/users';
import { wispGrants, type WispGrantStatus } from '../../db/schema/wisp';
import { wispConcerns } from '../../db/schema/wispConcerns';
import { utcDayWindow } from './budget';

export interface WispPartnerOverviewRow {
  partnerId: string;
  partnerName: string;
  plan: string;
  /** status `active` and not yet past `expires_at` */
  activeGrants: number;
  /** status `paused`, keyed by `paused_reason` (`unknown` when unset) */
  pausedGrants: Record<string, number>;
  /** `assessment`-profile runs under the partner's grants queued today */
  assessmentsToday: number;
  /**
   * Specialist work the W07 coordinator admitted today: runs plus Operator
   * tasks keyed `wisp-specialist-<requestId>` (specialistLaunchers). Refused
   * requests and still-pending approval cards leave no row and are not counted.
   */
  specialistRequestsToday: number;
  /** `wisp_concerns` rows with status `open` */
  openConcerns: number;
  /** live (active/paused) grants whose spend today reached `budget_cents_per_day` */
  budgetExhaustedGrantsToday: number;
}

export interface WispGrantAdminRow {
  id: string;
  /** NULL = partner-wide grant */
  orgId: string | null;
  grantorUserId: string;
  grantorName: string | null;
  status: WispGrantStatus;
  pausedReason: string | null;
  expiresAt: string;
  budgetCentsPerDay: number;
  floorTickMinutes: number;
  currentRevisionId: string | null;
  assessmentsToday: number;
}

/**
 * Every coordinator admission is keyed `specialistDedupeKey(requestId)` =
 * `wisp-specialist-<requestId>` (specialistLaunchers.ts) — the run's
 * `dedupe_key` or the task's `client_idempotency_key`. Kept literal so this
 * read-only module does not import the launchers; adminOverview.test.ts pins it
 * to specialistDedupeKey.
 */
export const SPECIALIST_KEY_PATTERN = 'wisp-specialist-%';

const toCount = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function buildWispOverview(now: Date = new Date()): Promise<WispPartnerOverviewRow[]> {
  const grants = await db
    .select({
      id: wispGrants.id,
      partnerId: wispGrants.partnerId,
      status: wispGrants.status,
      pausedReason: wispGrants.pausedReason,
      expiresAt: wispGrants.expiresAt,
      budgetCentsPerDay: wispGrants.budgetCentsPerDay,
    })
    .from(wispGrants);
  if (grants.length === 0) return [];

  const partnerIds = [...new Set(grants.map((g) => g.partnerId))];
  const { start, end } = utcDayWindow(now);

  const partnerRows = await db
    .select({ id: partners.id, name: partners.name, plan: partners.plan })
    .from(partners)
    .where(inArray(partners.id, partnerIds));

  // One pass over today's grant runs. `spentCents` mirrors budget.ts
  // spentUnderGrant (skipped runs excluded) so "exhausted" here means the same
  // thing chargeableUnderGrant refuses on.
  const runRows = await db
    .select({
      grantId: aiAgentRuns.grantId,
      assessments: sql<number>`count(*) filter (where ${eq(aiAgentRuns.profile, 'assessment')})::int`,
      specialistRuns: sql<number>`count(*) filter (where ${like(aiAgentRuns.dedupeKey, SPECIALIST_KEY_PATTERN)})::int`,
      spentCents: sql<string | number>`coalesce(sum(${aiAgentRuns.costCents}) filter (where ${ne(aiAgentRuns.status, 'skipped')}), 0)::bigint`,
    })
    .from(aiAgentRuns)
    .where(and(
      isNotNull(aiAgentRuns.grantId),
      gte(aiAgentRuns.queuedAt, start),
      lt(aiAgentRuns.queuedAt, end),
    ))
    .groupBy(aiAgentRuns.grantId);

  const taskRows = await db
    .select({ grantId: aiOperatorTasks.grantId, n: sql<number>`count(*)::int` })
    .from(aiOperatorTasks)
    .where(and(
      isNotNull(aiOperatorTasks.grantId),
      like(aiOperatorTasks.clientIdempotencyKey, SPECIALIST_KEY_PATTERN),
      gte(aiOperatorTasks.createdAt, start),
      lt(aiOperatorTasks.createdAt, end),
    ))
    .groupBy(aiOperatorTasks.grantId);

  const concernRows = await db
    .select({ partnerId: wispConcerns.partnerId, n: sql<number>`count(*)::int` })
    .from(wispConcerns)
    .where(and(eq(wispConcerns.status, 'open'), inArray(wispConcerns.partnerId, partnerIds)))
    .groupBy(wispConcerns.partnerId);

  const runsByGrant = new Map(runRows.map((r) => [r.grantId, r]));
  const tasksByGrant = new Map(taskRows.map((r) => [r.grantId, toCount(r.n)]));
  const concernsByPartner = new Map(concernRows.map((r) => [r.partnerId, toCount(r.n)]));
  const partnerById = new Map(partnerRows.map((p) => [p.id, p]));

  const rows = new Map<string, WispPartnerOverviewRow>();
  for (const partnerId of partnerIds) {
    const p = partnerById.get(partnerId);
    rows.set(partnerId, {
      partnerId,
      partnerName: p?.name ?? partnerId,
      plan: p?.plan ?? 'unknown',
      activeGrants: 0,
      pausedGrants: {},
      assessmentsToday: 0,
      specialistRequestsToday: 0,
      openConcerns: concernsByPartner.get(partnerId) ?? 0,
      budgetExhaustedGrantsToday: 0,
    });
  }

  for (const g of grants) {
    const row = rows.get(g.partnerId)!;
    if (g.status === 'active' && g.expiresAt.getTime() > now.getTime()) row.activeGrants += 1;
    if (g.status === 'paused') {
      const reason = g.pausedReason ?? 'unknown';
      row.pausedGrants[reason] = (row.pausedGrants[reason] ?? 0) + 1;
    }
    const runs = runsByGrant.get(g.id);
    row.assessmentsToday += toCount(runs?.assessments);
    row.specialistRequestsToday += toCount(runs?.specialistRuns) + (tasksByGrant.get(g.id) ?? 0);
    const live = g.status === 'active' || g.status === 'paused';
    if (live && runs && toCount(runs.spentCents) >= g.budgetCentsPerDay) row.budgetExhaustedGrantsToday += 1;
  }

  return [...rows.values()].sort((a, b) => a.partnerName.localeCompare(b.partnerName));
}

export async function listGrantsForPartner(partnerId: string, now: Date = new Date()): Promise<WispGrantAdminRow[]> {
  const grants = await db
    .select({
      id: wispGrants.id,
      orgId: wispGrants.orgId,
      grantorUserId: wispGrants.grantorUserId,
      grantorName: users.name,
      status: wispGrants.status,
      pausedReason: wispGrants.pausedReason,
      expiresAt: wispGrants.expiresAt,
      budgetCentsPerDay: wispGrants.budgetCentsPerDay,
      floorTickMinutes: wispGrants.floorTickMinutes,
      currentRevisionId: wispGrants.currentRevisionId,
    })
    .from(wispGrants)
    .leftJoin(users, eq(users.id, wispGrants.grantorUserId))
    .where(eq(wispGrants.partnerId, partnerId))
    .orderBy(wispGrants.createdAt);
  if (grants.length === 0) return [];

  const { start, end } = utcDayWindow(now);
  const runRows = await db
    .select({ grantId: aiAgentRuns.grantId, n: sql<number>`count(*)::int` })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.profile, 'assessment'),
      inArray(aiAgentRuns.grantId, grants.map((g) => g.id)),
      gte(aiAgentRuns.queuedAt, start),
      lt(aiAgentRuns.queuedAt, end),
    ))
    .groupBy(aiAgentRuns.grantId);
  const assessmentsByGrant = new Map(runRows.map((r) => [r.grantId, toCount(r.n)]));

  return grants.map((g) => ({
    id: g.id,
    orgId: g.orgId ?? null,
    grantorUserId: g.grantorUserId,
    grantorName: g.grantorName ?? null,
    status: g.status,
    pausedReason: g.pausedReason ?? null,
    expiresAt: g.expiresAt.toISOString(),
    budgetCentsPerDay: g.budgetCentsPerDay,
    floorTickMinutes: g.floorTickMinutes,
    currentRevisionId: g.currentRevisionId ?? null,
    assessmentsToday: assessmentsByGrant.get(g.id) ?? 0,
  }));
}
