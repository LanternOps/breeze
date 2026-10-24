/**
 * Wisp W05b Task 13 (#9917, feature #9906) — the triage engine end to end
 * against real Postgres and the test Redis (BullMQ):
 *
 *   - ceiling isolation: an org-A grant never sees org-B concerns through
 *     listConcernsForCeiling, and an org-A assessment's context (digest +
 *     openConcerns) never carries org-B rows;
 *   - budget: an exhausted UTC-day budget admits nothing, tells the grantor
 *     once, records the event deterministically, never pauses the grant
 *     (spec §9); a run queued YESTERDAY is not charged to today (Review
 *     Focus 4); the floor tick is suspended for an exhausted grant;
 *   - a grant that reaches an org only through a site restriction is refused
 *     (`grant_org_site_restricted`);
 *   - flag off: the tick and the wake subscriber do nothing;
 *   - real admission (profile assessment, grant pinned, triage agent) and its
 *     `no_effective_agent` sibling; the 60 s debounce coalesces;
 *   - a paused grant's watches stop and the partner admin is told once
 *     across two ticks (Review Focus 1);
 *   - the reaper resolves a concern whose ticket was deleted (Review Focus 3).
 *
 * The run enqueuer (agent-run BullMQ queue) is stubbed with
 * registerAgentRunEnqueuer and publishEvent is mocked, as the other
 * admission suites do; the `wisp-wake` queue is REAL and obliterated around
 * every test.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  organizationUsers,
  tickets,
  userNotifications,
  wispConcerns,
  wispGrantRevisions,
  wispGrants,
  wispWatches,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import type { BreezeEvent } from '../../services/eventBus';
import { registerAgentRunEnqueuer } from '../../services/aiAgents/runService';
import { enqueueAssessment, loadAssessmentContext } from '../../services/wisp/assessment';
import { listConcernsForCeiling, upsertConcern } from '../../services/wisp/concerns';
import { resolveGrantCeiling, type GrantCeiling } from '../../services/wisp/grantAuthority';
import { pauseGrant } from '../../services/wisp/grants';
import { createWatch } from '../../services/wisp/watches';
import {
  closeWispWakeQueue,
  getWispWakeQueue,
  handleWispWakeEvent,
  requestAssessment,
  wakeJobId,
} from '../../services/wisp/wake';
import { processWakeTick } from '../../jobs/wispWakeScheduler';
import { runWispConcernRetention } from '../../jobs/wispConcernRetention';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

// Admission resolves the triage agent's model; the platform default needs a key.
usePlatformAiKeyPlaceholder();

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const DAY_MS = 86_400_000;

function enableWisp() {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
}

let enqueuedRunIds: string[] = [];

beforeEach(async () => {
  enableWisp();
  publishEventMock.mockClear();
  enqueuedRunIds = [];
  registerAgentRunEnqueuer(async (runId) => {
    enqueuedRunIds.push(runId);
    return { enqueued: true, jobId: `agent-run:${runId}` };
  });
  await getWispWakeQueue().obliterate({ force: true });
});

afterEach(async () => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
  await getWispWakeQueue().obliterate({ force: true }).catch(() => {});
});

afterAll(async () => {
  await closeWispWakeQueue();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Tenant {
  partnerId: string;
  orgA: string;
  orgB: string;
  grantorId: string;
  adminId: string;
}

/**
 * Partner with orgs A and B; a live grantor (ai_sessions:use + tickets:read,
 * org_access all) and a partner admin. tickets:read lets the digest's tickets
 * section load (each digest section is gated on the grantor's permission).
 */
async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-triage-grantor-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: 'ai_sessions', action: 'use' }, { resource: 'tickets', action: 'read' }]);
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');
  const admin = await createUser({ partnerId: partner.id, email: `wisp-triage-admin-${randomUUID()}@wisp.test` });
  const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await assignUserToPartner(admin.id, partner.id, adminRole.id, 'all');
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, grantorId: grantor.id, adminId: admin.id };
}

/** A grant + revision 1 + pointer in system scope (the W02/W05a fixture path). */
async function seedGrant(t: Tenant, opts: { scopeOrgId?: string | null; orgIds: string[]; budgetCentsPerDay?: number }) {
  const scopeOrgId = opts.scopeOrgId ?? null;
  const snapshot: WispCeilingSnapshot = {
    version: 1, permissionKeys: ['ai_sessions:use', 'tickets:read'], orgIds: opts.orgIds, siteIds: null,
    toolAllowlist: null, deniedTools: [], partnerWide: scopeOrgId === null,
  };
  return asSystem(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: t.partnerId, orgId: scopeOrgId, grantorUserId: t.grantorId, status: 'active',
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      ...(opts.budgetCentsPerDay !== undefined ? { budgetCentsPerDay: opts.budgetCentsPerDay } : {}),
    }).returning({ id: wispGrants.id });
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: t.partnerId, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });
}

/** An enabled partner-wide triage agent (aiAgentSchedulesPartnerRls / wispGrantsRls insert shape). */
async function seedTriageAgent(t: Tenant): Promise<string> {
  const [agent] = await asSystem(() => db.insert(aiAgents).values({
    partnerId: t.partnerId, orgId: null, kind: 'triage', name: 'Wisp Triage', enabled: true, mode: 'shadow', model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy: t.adminId,
  } as never).returning({ id: aiAgents.id }));
  return agent!.id;
}

/** A finished assessment run under the grant, queued at `queuedAt`, that cost `costCents`. */
async function seedSpentRun(agentId: string, orgId: string, g: { grantId: string; revisionId: string }, costCents: number, queuedAt: Date) {
  await asSystem(() => db.insert(aiAgentRuns).values({
    agentId, orgId, triggerKind: 'schedule', dedupeKey: `seed:${randomUUID()}`, modeAtStart: 'shadow',
    policySnapshot: {} as never, profile: 'assessment', status: 'completed', costCents,
    queuedAt, startedAt: queuedAt, finishedAt: new Date(queuedAt.getTime() + 60_000),
    grantId: g.grantId, grantRevisionId: g.revisionId,
  } as never));
}

async function seedTicket(t: Tenant, orgId: string, subject: string): Promise<string> {
  const [row] = await asSystem(() => db.insert(tickets).values({
    orgId, partnerId: t.partnerId, subject, source: 'manual' as const, priority: 'normal' as const,
    ticketNumber: `WISP-TRI-${randomUUID().slice(0, 12)}`,
  }).returning({ id: tickets.id }));
  return row!.id;
}

const runsOfGrant = (grantId: string) =>
  asSystem(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.grantId, grantId)));

const noticesByKey = (userId: string, dedupeKey: string) =>
  asSystem(() => db.select().from(userNotifications)
    .where(and(eq(userNotifications.userId, userId), eq(userNotifications.dedupeKey, dedupeKey))));

const noticesByPrefix = async (userId: string, prefix: string) =>
  (await asSystem(() => db.select().from(userNotifications).where(eq(userNotifications.userId, userId))))
    .filter((n) => (n.dedupeKey ?? '').startsWith(prefix));

const readGrant = async (grantId: string) => {
  const [row] = await asSystem(() => db.select().from(wispGrants).where(eq(wispGrants.id, grantId)));
  return row!;
};

async function tableCount(table: typeof wispConcerns | typeof aiAgentRuns | typeof userNotifications | typeof wispWatches): Promise<number> {
  const [row] = await asSystem(() => db.select({ n: count() }).from(table));
  return Number(row?.n ?? 0);
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function alertEvent(orgId: string, alertId: string): BreezeEvent {
  return {
    id: `evt-${randomUUID()}`,
    type: 'alert.triggered',
    orgId,
    source: 'test',
    priority: 'normal',
    payload: { alertId },
    metadata: { timestamp: new Date().toISOString() },
  } as BreezeEvent;
}

// ---------------------------------------------------------------------------

describe('ceiling isolation', () => {
  it('a grant scoped to org A never sees org B concerns (listConcernsForCeiling) or org B rows in an org-A assessment context', async () => {
    const t = await seedTenant();
    const g = await seedGrant(t, { scopeOrgId: t.orgA, orgIds: [t.orgA] });
    const ceiling = await resolveGrantCeiling(g.grantId, g.revisionId);
    expect([...ceiling.orgIds]).toEqual([t.orgA]);

    const ticketA = await seedTicket(t, t.orgA, 'Printer offline in the front office');
    const ticketB = await seedTicket(t, t.orgB, 'VPN drops every hour');
    const concernA = await upsertConcern({
      partnerId: t.partnerId, orgId: t.orgA, subject: { kind: 'ticket', id: ticketA },
      summary: 'A waiting', severity: 'medium', evidence: {},
    });
    const concernB = await upsertConcern({
      partnerId: t.partnerId, orgId: t.orgB, subject: { kind: 'ticket', id: ticketB },
      summary: 'B waiting', severity: 'high', evidence: {},
    });

    const listed = (await listConcernsForCeiling(ceiling)).map((c) => c.id);
    expect(listed).toContain(concernA.id);
    expect(listed).not.toContain(concernB.id);
    expect(await listConcernsForCeiling(ceiling, { orgId: t.orgB })).toEqual([]);

    const ctx = await loadAssessmentContext({
      id: randomUUID(),
      orgId: t.orgA,
      grantId: g.grantId,
      grantRevisionId: g.revisionId,
      triggerRef: { wisp: { grantId: g.grantId, grantRevisionId: g.revisionId, reason: { kind: 'tick' }, watermark: null } },
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.openConcerns.map((c) => c.id)).toEqual([concernA.id]);
    const digestTickets = ctx!.digest.tickets.map((x) => x.id);
    expect(digestTickets).toContain(ticketA);
    expect(digestTickets).not.toContain(ticketB);
    expect(JSON.stringify(ctx)).not.toContain(ticketB);
    expect(JSON.stringify(ctx)).not.toContain(concernB.id);

    // The same grant cannot be pointed at org B: no context at all.
    expect(await loadAssessmentContext({
      id: randomUUID(),
      orgId: t.orgB,
      grantId: g.grantId,
      grantRevisionId: g.revisionId,
      triggerRef: { wisp: { grantId: g.grantId, grantRevisionId: g.revisionId, reason: { kind: 'tick' }, watermark: null } },
    })).toBeNull();
  });

  it('an org the grant reaches only through a site restriction is refused (grant_org_site_restricted); a whole org is admitted', async () => {
    const t = await seedTenant();
    const agentId = await seedTriageAgent(t);
    const g = await seedGrant(t, { orgIds: [t.orgA, t.orgB] });

    // The grantor's org-A membership (AI-capable) binds org A to one site.
    const siteA = await createSite({ orgId: t.orgA });
    const orgRole = await createRole({ scope: 'organization', orgId: t.orgA });
    await grantRolePermissions(orgRole.id, [{ resource: 'ai_sessions', action: 'use' }]);
    await assignUserToOrganization(t.grantorId, t.orgA, orgRole.id);
    await getTestDb().update(organizationUsers).set({ siteIds: [siteA.id] })
      .where(and(eq(organizationUsers.userId, t.grantorId), eq(organizationUsers.orgId, t.orgA)));

    const ceiling = await resolveGrantCeiling(g.grantId, g.revisionId);
    expect(ceiling.orgIds.has(t.orgA)).toBe(true);
    expect(ceiling.orgTerms.get(t.orgA)?.siteIds).not.toBeNull();

    expect(await enqueueAssessment({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'tick' } }))
      .toEqual({ skipped: 'grant_org_site_restricted' });
    expect((await runsOfGrant(g.grantId)).filter((r) => r.orgId === t.orgA)).toEqual([]);

    // Control: org B is reached whole, so the same grant is admitted there.
    const admitted = await enqueueAssessment({ grantId: g.grantId, orgId: t.orgB, reason: { kind: 'tick' } });
    expect(admitted).toHaveProperty('runId');
    const runs = await runsOfGrant(g.grantId);
    expect(runs.map((r) => r.orgId)).toEqual([t.orgB]);
    expect(runs[0]!.agentId).toBe(agentId);
  });
});

describe('budget (UTC day, queued_at)', () => {
  it('an exhausted budget admits zero runs across 3 attempts: grantor told once, deterministic low concern once, grant stays active', async () => {
    const t = await seedTenant();
    const agentId = await seedTriageAgent(t);
    const g = await seedGrant(t, { orgIds: [t.orgA], budgetCentsPerDay: 200 });
    const now = new Date();
    await seedSpentRun(agentId, t.orgA, g, 120, new Date(now.getTime() - 60_000));
    await seedSpentRun(agentId, t.orgA, g, 80, new Date(now.getTime() - 30_000));
    expect(await runsOfGrant(g.grantId)).toHaveLength(2);

    const alertId = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      const result = await enqueueAssessment({
        grantId: g.grantId, orgId: t.orgA,
        reason: { kind: 'event', eventType: 'alert.triggered', eventId: `evt-${i}` },
        subject: { kind: 'alert', id: alertId },
      });
      expect(result).toEqual({ skipped: 'budget_exhausted' });
    }

    expect(await runsOfGrant(g.grantId)).toHaveLength(2);
    expect(enqueuedRunIds).toEqual([]);
    expect(await noticesByKey(t.grantorId, `wisp-budget-${g.grantId}-${utcDayKey(new Date())}`)).toHaveLength(1);
    expect(await noticesByPrefix(t.grantorId, 'wisp-budget-')).toHaveLength(1);
    // The day's single digest notice for the deterministic path.
    expect(await noticesByPrefix(t.grantorId, 'wisp-digest-')).toHaveLength(1);

    const concerns = await asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.partnerId, t.partnerId)));
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toMatchObject({
      orgId: t.orgA, subjectKind: 'alert', subjectId: alertId, severity: 'low', status: 'open', raisedByGrantId: g.grantId,
    });

    expect(await readGrant(g.grantId)).toMatchObject({ status: 'active', pausedReason: null });
  });

  it('a run queued yesterday (UTC) for the whole budget is not charged to today: admission proceeds', async () => {
    const t = await seedTenant();
    const agentId = await seedTriageAgent(t);
    const g = await seedGrant(t, { orgIds: [t.orgA], budgetCentsPerDay: 200 });
    const todayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    await seedSpentRun(agentId, t.orgA, g, 200, new Date(todayStart - 60_000)); // 23:59 yesterday

    const result = await enqueueAssessment({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'tick' } });
    expect(result).not.toEqual({ skipped: 'budget_exhausted' });
    expect(result).toHaveProperty('runId');
    expect(await noticesByPrefix(t.grantorId, 'wisp-budget-')).toHaveLength(0);

    // Control: the same spend queued today does exhaust it.
    await seedSpentRun(agentId, t.orgA, g, 200, new Date());
    expect(await enqueueAssessment({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'tick' } }))
      .toEqual({ skipped: 'budget_exhausted' });
  });

  it('the floor tick is suspended for an exhausted grant: no assess job, one grantor notice over two ticks, grant stays active', async () => {
    const t = await seedTenant();
    const agentId = await seedTriageAgent(t);
    const g = await seedGrant(t, { orgIds: [t.orgA], budgetCentsPerDay: 100 });
    await seedSpentRun(agentId, t.orgA, g, 100, new Date(Date.now() - 60_000));
    const queue = getWispWakeQueue();

    const first = await processWakeTick(new Date());
    expect(first.grantsTicked).toBe(0);
    expect(await queue.getJob(wakeJobId(g.grantId, t.orgA))).toBeUndefined();
    expect((await readGrant(g.grantId)).lastFloorTickAt).not.toBeNull();

    // Make the grant due again; the second check must not tell the grantor twice.
    await asSystem(() => db.update(wispGrants).set({ lastFloorTickAt: null }).where(eq(wispGrants.id, g.grantId)));
    const second = await processWakeTick(new Date());
    expect(second.grantsTicked).toBe(0);
    expect(await queue.getJob(wakeJobId(g.grantId, t.orgA))).toBeUndefined();
    expect(await noticesByPrefix(t.grantorId, 'wisp-budget-')).toHaveLength(1);
    expect(await readGrant(g.grantId)).toMatchObject({ status: 'active', pausedReason: null });

    // Control: with budget headroom the same due grant IS ticked.
    await asSystem(() => db.update(wispGrants).set({ lastFloorTickAt: null, budgetCentsPerDay: 1000 }).where(eq(wispGrants.id, g.grantId)));
    const funded = await processWakeTick(new Date());
    expect(funded.grantsTicked).toBe(1);
    expect(await queue.getJob(wakeJobId(g.grantId, t.orgA))).toBeDefined();
  });
});

describe('flag off', () => {
  it('processWakeTick returns zeros and handleWispWakeEvent touches no table and queues nothing', async () => {
    const t = await seedTenant();
    await seedTriageAgent(t);
    const g = await seedGrant(t, { orgIds: [t.orgA] });
    const ceiling = await resolveGrantCeiling(g.grantId, g.revisionId);
    const past = new Date(Date.now() - DAY_MS);
    const watch = await createWatch(ceiling, { orgId: t.orgA, kind: 'ticket_waiting', params: {}, cadenceMinutes: 60 }, past);

    vi.stubEnv('BREEZE_WISP_ENABLED', 'false');
    const before = {
      concerns: await tableCount(wispConcerns),
      runs: await tableCount(aiAgentRuns),
      notices: await tableCount(userNotifications),
    };

    expect(await processWakeTick(new Date())).toEqual({
      grantsTicked: 0, watchesFired: 0, staleTicketsPublished: 0, watchesStopped: 0,
      grantsPaused: 0, grantsResumed: 0, ticketClustersOpened: 0, incidentsOpened: 0,
    });
    await handleWispWakeEvent(alertEvent(t.orgA, randomUUID()));

    const queue = getWispWakeQueue();
    expect(await queue.getJob(wakeJobId(g.grantId, t.orgA))).toBeUndefined();
    expect(await queue.count()).toBe(0);
    expect({
      concerns: await tableCount(wispConcerns),
      runs: await tableCount(aiAgentRuns),
      notices: await tableCount(userNotifications),
    }).toEqual(before);
    const grant = await readGrant(g.grantId);
    expect(grant.lastFloorTickAt).toBeNull();
    const [w] = await asSystem(() => db.select().from(wispWatches).where(eq(wispWatches.id, watch.id)));
    expect(w!.lastRanAt).toBeNull();
    expect(w!.nextDueAt.getTime()).toBe(new Date(watch.nextDueAt).getTime());

    // Control: flag on, the same event queues one assess job for (grant, org A).
    vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
    await handleWispWakeEvent(alertEvent(t.orgA, randomUUID()));
    expect(await queue.getJob(wakeJobId(g.grantId, t.orgA))).toBeDefined();
  });
});

describe('real admission (flag on)', () => {
  it('enqueueAssessment admits a run with profile assessment, grant pinned, the triage agent, accepted by ai_agent_runs_profile_chk', async () => {
    const t = await seedTenant();
    const agentId = await seedTriageAgent(t);
    const g = await seedGrant(t, { orgIds: [t.orgA, t.orgB] });

    const result = await enqueueAssessment({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'onboarding' } });
    if (!('runId' in result)) throw new Error(`expected admission, got skip ${result.skipped}`);

    const [row] = await asSystem(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, result.runId)));
    expect(row).toMatchObject({
      orgId: t.orgA, agentId, profile: 'assessment', triggerKind: 'schedule',
      grantId: g.grantId, grantRevisionId: g.revisionId, deviceId: null,
    });
    expect(row!.triggerRef).toMatchObject({
      wisp: { grantId: g.grantId, grantRevisionId: g.revisionId, reason: { kind: 'onboarding' }, watermark: null },
    });
    const [agent] = await asSystem(() => db.select({ kind: aiAgents.kind }).from(aiAgents).where(eq(aiAgents.id, row!.agentId)));
    expect(agent!.kind).toBe('triage');
    expect(enqueuedRunIds).toEqual([result.runId]);
  });

  it('with no enabled triage agent: { skipped: no_effective_agent } and no run', async () => {
    const t = await seedTenant();
    const g = await seedGrant(t, { orgIds: [t.orgA] });
    expect(await enqueueAssessment({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'tick' } }))
      .toEqual({ skipped: 'no_effective_agent' });
    expect(await runsOfGrant(g.grantId)).toEqual([]);
  });

  it('two requestAssessment calls for one (grant, org) inside 60 s → queued, then coalesced (one delayed job)', async () => {
    const t = await seedTenant();
    const g = await seedGrant(t, { orgIds: [t.orgA, t.orgB] });
    const queue = getWispWakeQueue();

    expect(await requestAssessment({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'tick' } })).toBe('queued');
    expect(await requestAssessment({
      grantId: g.grantId, orgId: t.orgA, reason: { kind: 'event', eventType: 'alert.triggered', eventId: 'e-2' },
    })).toBe('coalesced');
    // Another org is its own window.
    expect(await requestAssessment({ grantId: g.grantId, orgId: t.orgB, reason: { kind: 'tick' } })).toBe('queued');

    const job = await queue.getJob(wakeJobId(g.grantId, t.orgA));
    expect(job).toBeDefined();
    expect(await job!.getState()).toBe('delayed');
    // The first request's data is kept.
    expect(job!.data).toMatchObject({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'tick' } });
    expect(await queue.getDelayedCount()).toBe(2);
  });
});

describe('paused grant', () => {
  it('the next tick stops its watches; the partner admin orphan notice exists once after two ticks', async () => {
    const t = await seedTenant();
    const g = await seedGrant(t, { orgIds: [t.orgA] });
    const ceiling: GrantCeiling = await resolveGrantCeiling(g.grantId, g.revisionId);
    const w1 = await createWatch(ceiling, { orgId: t.orgA, kind: 'backup_health', params: {}, cadenceMinutes: 60 });
    const w2 = await createWatch(ceiling, { orgId: null, kind: 'ticket_cluster', params: {}, cadenceMinutes: 60 });

    await pauseGrant(g.grantId, 'grantor_suspended');
    expect(await readGrant(g.grantId)).toMatchObject({ status: 'paused', pausedReason: 'grantor_suspended' });

    // One clock for both ticks: W05a's orphan notice is deduped per grant per UTC day.
    const now = new Date();
    const first = await processWakeTick(now);
    expect(first.watchesStopped).toBe(2);
    const second = await processWakeTick(new Date(now.getTime() + 1_000));
    expect(second.watchesStopped).toBe(0);

    const rows = await asSystem(() => db.select().from(wispWatches).where(eq(wispWatches.grantId, g.grantId)));
    expect(rows.map((r) => r.id).sort()).toEqual([w1.id, w2.id].sort());
    for (const r of rows) expect(r).toMatchObject({ status: 'stopped', stoppedReason: 'paused' });

    expect(await noticesByKey(t.adminId, `wisp-watches-orphaned-${g.grantId}-${now.toISOString().slice(0, 10)}`)).toHaveLength(1);
    // A paused grant is never floor-ticked and gets no assessment.
    expect(await getWispWakeQueue().getJob(wakeJobId(g.grantId, t.orgA))).toBeUndefined();
    expect(await enqueueAssessment({ grantId: g.grantId, orgId: t.orgA, reason: { kind: 'tick' } }))
      .toEqual({ skipped: 'grant_inactive' });
    expect(await runsOfGrant(g.grantId)).toEqual([]);
  });
});

describe('concern retention reaper', () => {
  it('a live ticket concern whose ticket row is deleted is resolved subject_gone; one whose ticket remains stays open', async () => {
    const t = await seedTenant();
    const goneTicket = await seedTicket(t, t.orgA, 'Old laptop will not boot');
    const keptTicket = await seedTicket(t, t.orgA, 'Shared drive is slow');
    const gone = await upsertConcern({
      partnerId: t.partnerId, orgId: t.orgA, subject: { kind: 'ticket', id: goneTicket },
      summary: 'Waiting 3 days', severity: 'medium', evidence: {},
    });
    const kept = await upsertConcern({
      partnerId: t.partnerId, orgId: t.orgA, subject: { kind: 'ticket', id: keptTicket },
      summary: 'Waiting 2 days', severity: 'medium', evidence: {},
    });

    await asSystem(() => db.delete(tickets).where(eq(tickets.id, goneTicket)));
    const result = await runWispConcernRetention(new Date());
    expect(result.subjectGone).toBe(1);

    const [goneRow] = await asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.id, gone.id)));
    expect(goneRow).toMatchObject({ status: 'resolved', outcome: 'subject_gone' });
    const [keptRow] = await asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.id, kept.id)));
    expect(keptRow!.status).toBe('open');
  });
});
