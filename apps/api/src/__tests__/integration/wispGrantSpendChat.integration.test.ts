/**
 * #10414 (spec §4, Option 2) — the Wisp grant meter counts chat, against real
 * Postgres. `budget.test.ts` mocks the DB, so the SQL semantics of the three
 * spend lines live here:
 *
 *  - background: the grant's runs by `queued_at`, plus grant-keyed sessionless
 *    overhead rows (`wisp_thread_summary:<grant>`) by `created_at`;
 *  - chat: invocations on a session carrying `wisp_grant_id = <grant>` that are
 *    not a run's own (`agent_run_id IS NULL`), by `created_at` (settlement day).
 *
 * The clock is fixed (Review Focus 1): the UTC-midnight flake in
 * wispTriageEngine.integration.test.ts comes from using the real clock.
 *
 * Placement is load-bearing: `src/__tests__/integration/**` +
 * `.integration.test.ts` puts it in the blocking Integration Tests job.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, aiSessions, wispGrantRevisions, wispGrants } from '../../db/schema';
import { aiInvocations } from '../../db/schema/aiInvocations';
import { createOrganization, createPartner, createUser } from './db-utils';
import { buildWispOverview } from '../../services/wisp/adminOverview';
import {
  chargeableUnderGrant,
  spendBreakdownUnderGrant,
  spendSummary,
  spentUnderGrant,
  summaryRefineSourceRef,
} from '../../services/wisp/budget';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const NOW = new Date('2027-02-01T12:00:00.000Z');

interface GrantRef { grantId: string; revisionId: string }

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[]): Promise<GrantRef> {
  return asSystem(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: null, grantorUserId, status: 'active',
      expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: grant!.id, partnerId, revision: 1,
      ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds, siteIds: null, toolAllowlist: null, deniedTools: [] },
      factorProof: { method: 'step_up', verifiedAt: NOW.toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, grant!.id));
    return { grantId: grant!.id, revisionId: revision!.id };
  });
}

const insertSession = (orgId: string, userId: string, grant: GrantRef | null) =>
  asSystem(async () => {
    const [row] = await db.insert(aiSessions).values({
      orgId, userId, model: 'claude-sonnet-5-5',
      ...(grant ? { wispGrantId: grant.grantId, wispGrantRevisionId: grant.revisionId } : {}),
    }).returning({ id: aiSessions.id });
    return row!.id;
  });

async function seedAgent(partnerId: string, createdBy: string): Promise<string> {
  const [agent] = await asSystem(() => db.insert(aiAgents).values({
    partnerId, orgId: null, kind: 'triage', name: 'Wisp Triage', enabled: true, mode: 'shadow', model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy,
  } as never).returning({ id: aiAgents.id }));
  return agent!.id;
}

async function seedRun(agentId: string, orgId: string, g: GrantRef, costCents: number, queuedAt: Date): Promise<string> {
  const [row] = await asSystem(() => db.insert(aiAgentRuns).values({
    agentId, orgId, triggerKind: 'schedule', dedupeKey: `seed:${randomUUID()}`, modeAtStart: 'shadow',
    policySnapshot: {} as never, profile: 'assessment', status: 'completed', costCents,
    queuedAt, startedAt: queuedAt, finishedAt: new Date(queuedAt.getTime() + 60_000),
    grantId: g.grantId, grantRevisionId: g.revisionId,
  } as never).returning({ id: aiAgentRuns.id }));
  return row!.id;
}

const insertInvocation = (row: {
  orgId: string; costCents: number; createdAt: Date;
  sessionId?: string | null; agentRunId?: string | null; sourceRef?: string | null;
}) =>
  asSystem(() => db.insert(aiInvocations).values({
    orgId: row.orgId, surface: 'chat', fundingSource: 'platform', requestedModel: 'm', servedModel: 'm',
    sessionId: row.sessionId ?? null, agentRunId: row.agentRunId ?? null, sourceRef: row.sourceRef ?? null,
    costCents: row.costCents, rateSnapshot: {}, createdAt: row.createdAt,
  }));

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-spend-${randomUUID()}@wisp.test` });
  // One live grant per grantor and scope (wisp_grants_one_live_per_scope_uq), so H has its own grantor.
  const other = await createUser({ partnerId: partner.id, email: `wisp-spend-h-${randomUUID()}@wisp.test` });
  const g = await seedGrant(partner.id, user.id, [org.id]);
  const h = await seedGrant(partner.id, other.id, [org.id]);
  const s = await insertSession(org.id, user.id, g); // Wisp session on G
  const p = await insertSession(org.id, user.id, null); // plain chat, same user
  const sh = await insertSession(org.id, other.id, h); // Wisp session on H
  const agentId = await seedAgent(partner.id, user.id);
  return { partnerId: partner.id, orgId: org.id, userId: user.id, g, h, s, p, sh, agentId };
}

describe('#10414 the Wisp grant meter counts chat', () => {
  it('splits background (runs + grant overhead) from chat (Wisp-session invocations that are not a run\'s own)', async () => {
    const f = await seed();
    const r = await seedRun(f.agentId, f.orgId, f.g, 25, new Date('2027-02-01T09:00:00.000Z'));

    // Chat: an invocation on S with no run.
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, costCents: 1.4, createdAt: NOW });
    // A run's own call on S is not chat: R's cost_cents already counts it as background.
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, agentRunId: r, costCents: 50, createdAt: NOW });
    // Grant overhead: a sessionless summary, counted once, as background.
    await insertInvocation({ orgId: f.orgId, sourceRef: summaryRefineSourceRef(f.g.grantId), costCents: 2.25, createdAt: NOW });
    // Not G's spend: plain chat by the same user, and chat on another grant's session.
    await insertInvocation({ orgId: f.orgId, sessionId: f.p, costCents: 70, createdAt: NOW });
    await insertInvocation({ orgId: f.orgId, sessionId: f.sh, costCents: 80, createdAt: NOW });
    // Unpriced shadow call (cost NULL) on S adds nothing.
    await asSystem(() => db.insert(aiInvocations).values({
      orgId: f.orgId, surface: 'chat', fundingSource: 'platform', requestedModel: 'm', servedModel: 'm',
      sessionId: f.s, costCents: null, rateSnapshot: null, createdAt: NOW,
    }));

    // runs 25 + ceil(2.25 + 1.4) = 29; chat = ceil(1.4) = 2.
    await expect(spendBreakdownUnderGrant(f.g.grantId, NOW))
      .resolves.toEqual({ backgroundCents: 27, chatCents: 2, totalCents: 29 });
    expect(await spentUnderGrant(f.g.grantId, NOW)).toBe(29);
    // H sees only its own session's chat.
    await expect(spendBreakdownUnderGrant(f.h.grantId, NOW))
      .resolves.toEqual({ backgroundCents: 0, chatCents: 80, totalCents: 80 });

    const summary = await spendSummary(f.g.grantId, NOW);
    expect(summary.spentTodayCents).toBe(29);
  });

  it('chat alone can exhaust the budget for background admission', async () => {
    const f = await seed();
    await asSystem(() => db.update(wispGrants).set({ budgetCentsPerDay: 100 }).where(eq(wispGrants.id, f.g.grantId)));
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, costCents: 75.5, createdAt: NOW });

    await expect(chargeableUnderGrant(f.g.grantId, 24, NOW)).resolves.toEqual({ ok: true });
    await expect(chargeableUnderGrant(f.g.grantId, 25, NOW)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
  });

  it('Review Focus 1: chat is charged to its settlement day, a run to its queued day', async () => {
    const f = await seed();
    const lateRun = await seedRun(f.agentId, f.orgId, f.g, 10, new Date('2027-02-01T23:59:50.000Z'));
    // Chat settled 30 s after midnight belongs to 02-02.
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, costCents: 5, createdAt: new Date('2027-02-02T00:00:30.000Z') });
    // The late run's own call settling after midnight is the run's (02-01), never 02-02 chat.
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, agentRunId: lateRun, costCents: 9, createdAt: new Date('2027-02-02T00:00:10.000Z') });

    await expect(spendBreakdownUnderGrant(f.g.grantId, NOW))
      .resolves.toEqual({ backgroundCents: 10, chatCents: 0, totalCents: 10 });
    await expect(spendBreakdownUnderGrant(f.g.grantId, new Date('2027-02-02T00:01:00.000Z')))
      .resolves.toEqual({ backgroundCents: 0, chatCents: 5, totalCents: 5 });
  });

  it('the admin overview\'s "exhausted" matches chargeableUnderGrant, with the same lines excluded', async () => {
    const f = await seed();
    await asSystem(() => db.update(wispGrants).set({ budgetCentsPerDay: 100 }).where(eq(wispGrants.id, f.g.grantId)));
    await asSystem(() => db.update(wispGrants).set({ budgetCentsPerDay: 1000 }).where(eq(wispGrants.id, f.h.grantId)));
    const r = await seedRun(f.agentId, f.orgId, f.g, 20, new Date('2027-02-01T08:00:00.000Z'));
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, costCents: 59.5, createdAt: NOW }); // chat
    // None of these are G's chat: a run's own call, plain chat, another grant's chat.
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, agentRunId: r, costCents: 50, createdAt: NOW });
    await insertInvocation({ orgId: f.orgId, sessionId: f.p, costCents: 70, createdAt: NOW });
    await insertInvocation({ orgId: f.orgId, sessionId: f.sh, costCents: 80, createdAt: NOW });

    const exhaustedToday = async () =>
      (await asSystem(() => buildWispOverview(NOW))).find((row) => row.partnerId === f.partnerId)?.budgetExhaustedGrantsToday;

    // 20 + ceil(59.5) = 80 of 100: admitted, and not exhausted on the overview.
    await expect(chargeableUnderGrant(f.g.grantId, 1, NOW)).resolves.toEqual({ ok: true });
    expect(await exhaustedToday()).toBe(0);

    // A summary (overhead) of 0.25 and 19.25 more chat: 20 + ceil(59.5 + 0.25 + 19.25) = 99, still under.
    await insertInvocation({ orgId: f.orgId, sourceRef: summaryRefineSourceRef(f.g.grantId), costCents: 0.25, createdAt: NOW });
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, costCents: 19.25, createdAt: NOW });
    await expect(chargeableUnderGrant(f.g.grantId, 1, NOW)).resolves.toEqual({ ok: true });
    expect(await exhaustedToday()).toBe(0);

    // 0.01 more chat rounds the shared ledger line up to 80: 100 of 100, refused and exhausted on both.
    await insertInvocation({ orgId: f.orgId, sessionId: f.s, costCents: 0.01, createdAt: NOW });
    await expect(chargeableUnderGrant(f.g.grantId, 1, NOW)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
    expect(await exhaustedToday()).toBe(1);
  });
});
