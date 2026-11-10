/**
 * Wisp run-mode check-ins W07 (#11496, #10410 wave B) —
 * services/wisp/checkInRuns.ts against real Postgres (forced RLS): the
 * run-mode columns and CHECKs, the per-thread cap counting `running`, firing
 * a run check-in (one admission per check-in, recovered on a retry; the
 * revision pin; the degraded post), and posting the settled run's result
 * (once, from the run loop or the tick's reconcile).
 *
 * The admission boundary (`enqueueAssessment`) is a stub that writes the
 * ai_agent_runs row a real admission would (same org + dedupe key), so the
 * recovery and the post read real rows; enqueueAssessment's own gates are
 * pinned by services/wisp/assessment.test.ts. BullMQ is replaced by the wake
 * helper mocks; push dispatch and the throttle are stubbed. The live grant
 * ceiling is a stub (`h.ceiling`). Everything else is real.
 *
 * Prerequisites: pnpm test-stack up
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, devices, wispCheckIns, wispGrantRevisions, wispGrants, wispThreadPosts } from '../../db/schema';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  enqueueCheckIn: vi.fn(),
  removeCheckInJob: vi.fn(),
  isCheckInJobLive: vi.fn(),
  resolveGrantCeiling: vi.fn(),
  enqueueAssessment: vi.fn(),
  wispEnabled: vi.fn(() => true),
  ceiling: null as unknown,
}));
vi.mock('../../services/expoPush', async (orig) => ({
  ...(await orig<typeof import('../../services/expoPush')>()),
  dispatchPushToTokens: h.dispatch,
}));
vi.mock('../../services/notificationThrottle', () => ({
  checkNotificationThrottle: vi.fn(async () => ({ allowed: true, currentCount: 1, windowExpiresAt: 0 })),
}));
vi.mock('../../services/wisp/wake', async (orig) => ({
  ...(await orig<typeof import('../../services/wisp/wake')>()),
  enqueueCheckIn: h.enqueueCheckIn,
  removeCheckInJob: h.removeCheckInJob,
  isCheckInJobLive: h.isCheckInJobLive,
}));
vi.mock('../../services/wisp/notifyUser', async (orig) => {
  const real = await orig<typeof import('../../services/wisp/notifyUser')>();
  return { ...real, notifyUser: vi.fn(real.notifyUser) };
});
vi.mock('../../services/wisp/grantAuthority', async (orig) => ({
  ...(await orig<typeof import('../../services/wisp/grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
}));
vi.mock('../../services/wisp/assessment', async (orig) => ({
  ...(await orig<typeof import('../../services/wisp/assessment')>()),
  enqueueAssessment: h.enqueueAssessment,
}));
vi.mock('../../config/env', async (orig) => ({
  ...(await orig<typeof import('../../config/env')>()),
  wispEnabled: () => h.wispEnabled(),
}));

import { notifyUser } from '../../services/wisp/notifyUser';
import { getOrCreateThread } from '../../services/wisp/threads';
import {
  _resetCheckInTriggerSweepForTests,
  CheckInLimitReachedError,
  cancelCheckIn,
  createCheckIn,
  fireCheckIn,
  listCheckIns,
  reconcileCheckInTriggers,
} from '../../services/wisp/checkIns';
import { checkInRunDedupeKey, postCheckInRunResult, reconcileRunningCheckIns } from '../../services/wisp/checkInRuns';
import { CHECK_IN_RUN_NOT_DONE_LINE, loadFiredCheckIns, renderCheckInBlock } from '../../services/wisp/checkInTurn';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIN = 60_000;
const DAY = 86_400_000;
const INSTRUCTION = 'Check whether the patch scan on WS-01 finished and report the missing updates.';

beforeEach(() => {
  vi.mocked(notifyUser).mockClear();
  h.dispatch.mockReset();
  h.dispatch.mockImplementation(async (tokens: unknown[]) => ({ tokensFound: tokens.length, dispatched: tokens.length, errors: 0 }));
  h.enqueueCheckIn.mockReset();
  h.enqueueCheckIn.mockResolvedValue(undefined);
  h.removeCheckInJob.mockReset();
  h.removeCheckInJob.mockResolvedValue(true);
  h.isCheckInJobLive.mockReset();
  h.isCheckInJobLive.mockResolvedValue(false);
  h.resolveGrantCeiling.mockReset();
  h.resolveGrantCeiling.mockImplementation(async () => h.ceiling);
  h.enqueueAssessment.mockReset();
  h.wispEnabled.mockReset();
  h.wispEnabled.mockReturnValue(true);
});

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-run-${randomUUID()}@wisp.test` });
  const { grantId, revisionId, agentId } = await withSystemDbAccessContext(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: user.id, status: 'active',
      expiresAt: new Date(Date.now() + 30 * DAY),
    }).returning({ id: wispGrants.id });
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: grant!.id, partnerId: partner.id, revision: 1,
      ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds: [org.id], siteIds: null, toolAllowlist: null, deniedTools: [] },
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, grant!.id));
    const [agent] = await db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'triage', name: 'Triage', enabled: true, mode: 'shadow',
      toolAllowlist: [], protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {}, triggers: {}, recipients: { userIds: [], roleIds: [] }, createdBy: user.id,
    }).returning({ id: aiAgents.id });
    return { grantId: grant!.id, revisionId: revision!.id, agentId: agent!.id };
  });
  const thread = await getOrCreateThread(grantId);
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const ceiling = {
    grantId, revisionId, partnerId: partner.id, grantorUserId: user.id, scopeOrgId: null, partnerWide: false,
    orgIds: new Set([org.id]), siteIds: null,
    permissionKeys: new Set(['ai_sessions:use', 'devices:read', 'scripts:read', 'ai_agents:read']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active',
  } as GrantCeiling;
  h.ceiling = ceiling;
  return { partner, org, site, user, grantId, revisionId, agentId, thread, device, ceiling };
}
type Fx = Awaited<ReturnType<typeof seed>>;

/** The ai_agent_runs row an admission writes for a check-in (org + dedupe key), in `status`. */
async function insertRun(fx: Fx, checkInId: string, o: { status?: string; summary?: string | null; dedupeKey?: string } = {}) {
  return withSystemDbAccessContext(async () => {
    const [run] = await db.insert(aiAgentRuns).values({
      agentId: fx.agentId,
      orgId: fx.org.id,
      deviceId: null,
      triggerKind: 'schedule',
      dedupeKey: o.dedupeKey ?? checkInRunDedupeKey(checkInId),
      modeAtStart: 'shadow',
      policySnapshot: { effective: { enabled: true, mode: 'shadow', toolAllowlist: [], protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] }, limits: {}, triggers: {} } } as never,
      profile: 'assessment',
      grantId: fx.grantId,
      grantRevisionId: fx.revisionId,
      triggerRef: { wisp: { grantId: fx.grantId, grantRevisionId: fx.revisionId, reason: { kind: 'check_in', checkInId, instruction: INSTRUCTION, evidence: null }, watermark: null } },
      status: (o.status ?? 'queued') as never,
      summary: o.summary ?? null,
    }).returning({ id: aiAgentRuns.id });
    return run!.id;
  });
}

/** The stub admission: writes the run row a real admission would and returns its id. */
function admitting(fx: Fx) {
  h.enqueueAssessment.mockImplementation(async (input: { reason: { checkInId: string } }) => ({ runId: await insertRun(fx, input.reason.checkInId) }));
}

const scheduleRun = (fx: Fx, now: Date, o: { dueInMs?: number; context?: { subject: { kind: 'device'; id: string } } | null; trigger?: { kind: 'device_online'; subjectId: string } } = {}) =>
  createCheckIn(fx.ceiling, {
    threadId: fx.thread.id,
    sessionId: randomUUID(),
    dueAt: new Date(now.getTime() + (o.dueInMs ?? (o.trigger ? DAY : 10 * MIN))),
    instruction: INSTRUCTION,
    orgId: fx.org.id,
    context: o.context ?? null,
    trigger: o.trigger ?? null,
    mode: 'run',
  }, now);

const rowOf = (id: string) => withSystemDbAccessContext(async () =>
  (await db.select().from(wispCheckIns).where(eq(wispCheckIns.id, id)))[0]!);
const postsFor = (threadId: string) => withSystemDbAccessContext(() =>
  db.select().from(wispThreadPosts).where(eq(wispThreadPosts.threadId, threadId)));
const runsFor = (fx: Fx, checkInId: string) => withSystemDbAccessContext(() =>
  db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, fx.org.id), eq(aiAgentRuns.dedupeKey, checkInRunDedupeKey(checkInId)))));
const setRun = (runId: string, values: Partial<typeof aiAgentRuns.$inferInsert>) => withSystemDbAccessContext(() =>
  db.update(aiAgentRuns).set(values).where(eq(aiAgentRuns.id, runId)));
/** Due now: the window CHECK bounds due_at by created_at, so both move back. */
const makeDue = (id: string, now: Date) => withSystemDbAccessContext(() =>
  db.update(wispCheckIns).set({ createdAt: new Date(now.getTime() - 20 * MIN), dueAt: new Date(now.getTime() - MIN) }).where(eq(wispCheckIns.id, id)));

async function firedRunning(fx: Fx) {
  const now = new Date();
  admitting(fx);
  const row = await scheduleRun(fx, now);
  await makeDue(row.id, now);
  expect(await fireCheckIn(row.id, now)).toBe('running');
  const after = await rowOf(row.id);
  return { row: after, runId: after.runId! };
}

describe('run-mode columns and the cap', () => {
  runDb('a run check-in stores its mode and the scheduling revision; a notify one records the revision too', async () => {
    const fx = await seed();
    const run = await scheduleRun(fx, new Date());
    expect(run).toMatchObject({ mode: 'run', grantRevisionId: fx.revisionId, runId: null, status: 'scheduled' });
    const notify = await createCheckIn(fx.ceiling, {
      threadId: fx.thread.id, sessionId: null, dueAt: new Date(Date.now() + 10 * MIN), instruction: INSTRUCTION, orgId: null, context: null,
    });
    expect(notify).toMatchObject({ mode: 'notify', grantRevisionId: fx.revisionId });
  });

  runDb('the service and the DB both refuse a run check-in with no org; the DB refuses running without a run', async () => {
    const fx = await seed();
    await expect(createCheckIn(fx.ceiling, {
      threadId: fx.thread.id, sessionId: null, dueAt: new Date(Date.now() + 10 * MIN), instruction: INSTRUCTION, orgId: null, context: null, mode: 'run',
    })).rejects.toThrow(/needs an org/);
    const row = await scheduleRun(fx, new Date());
    await expect(withSystemDbAccessContext(() => db.update(wispCheckIns).set({ orgId: null }).where(eq(wispCheckIns.id, row.id)))).rejects.toThrow();
    await expect(withSystemDbAccessContext(() => db.update(wispCheckIns).set({ status: 'running' }).where(eq(wispCheckIns.id, row.id)))).rejects.toThrow();
    await expect(withSystemDbAccessContext(() => db.update(wispCheckIns).set({ mode: 'notify', runId: randomUUID() }).where(eq(wispCheckIns.id, row.id)))).rejects.toThrow();
  });

  runDb('the 5-per-thread cap counts running rows: 4 scheduled + 1 running refuses the 6th', async () => {
    const fx = await seed();
    await firedRunning(fx);
    for (let i = 0; i < 4; i += 1) await scheduleRun(fx, new Date());
    await expect(scheduleRun(fx, new Date())).rejects.toBeInstanceOf(CheckInLimitReachedError);
  });

  runDb('list shows a running row; cancel ends it', async () => {
    const fx = await seed();
    const { row } = await firedRunning(fx);
    expect((await listCheckIns(fx.grantId, { limit: 10 })).map((r) => r.id)).toContain(row.id);
    expect(await cancelCheckIn(fx.grantId, row.id)).toMatchObject({ status: 'cancelled' });
  });
});

describe('firing a run check-in', () => {
  runDb('admits exactly one run with wisp-check-in-<id>, pinned to the scheduling revision; the row is running and nothing is posted', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    expect(h.enqueueAssessment).toHaveBeenCalledTimes(1);
    expect(h.enqueueAssessment).toHaveBeenCalledWith({
      grantId: fx.grantId,
      orgId: fx.org.id,
      reason: { kind: 'check_in', checkInId: row.id, instruction: INSTRUCTION, evidence: null },
      dedupeKey: `wisp-check-in-${row.id}`,
      requireRevisionId: fx.revisionId,
    });
    expect(row).toMatchObject({ status: 'running', runId, fireReason: 'due' });
    expect(row.firedAt).not.toBeNull();
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  runDb('a retry of the fire job after the admission committed finds the same run: still running, no second ai_agent_runs row', async () => {
    const fx = await seed();
    const now = new Date();
    // The first attempt admits, then dies before the compare-and-set.
    h.enqueueAssessment.mockImplementationOnce(async (input: { reason: { checkInId: string } }) => {
      await insertRun(fx, input.reason.checkInId);
      throw new Error('worker lost');
    });
    const row = await scheduleRun(fx, now);
    await makeDue(row.id, now);
    await expect(fireCheckIn(row.id, now)).rejects.toThrow('worker lost');
    expect((await rowOf(row.id)).status).toBe('scheduled');

    // The BullMQ retry.
    expect(await fireCheckIn(row.id, now)).toBe('running');
    const runs = await runsFor(fx, row.id);
    expect(runs).toHaveLength(1);
    expect(await rowOf(row.id)).toMatchObject({ status: 'running', runId: runs[0]!.id });
    expect(h.enqueueAssessment).toHaveBeenCalledTimes(1);
    // A later delivery of the same job changes nothing.
    expect(await fireCheckIn(row.id, now)).toBe('skipped');
    expect(await runsFor(fx, row.id)).toHaveLength(1);
  });

  runDb('a retry after a degrade post landed but its flip failed degrades again: no run, the post stands', async () => {
    const fx = await seed();
    const now = new Date();
    h.enqueueAssessment.mockResolvedValueOnce({ skipped: 'budget_exhausted' });
    const row = await scheduleRun(fx, now);
    await makeDue(row.id, now);
    expect(await fireCheckIn(row.id, now)).toBe('fired');
    // Simulate the flip having failed: the row is back to scheduled (claimed), the post exists.
    await withSystemDbAccessContext(() => db.update(wispCheckIns).set({ status: 'scheduled', firedAt: null }).where(eq(wispCheckIns.id, row.id)));
    admitting(fx);
    expect(await fireCheckIn(row.id, now)).toBe('fired');
    expect(h.enqueueAssessment).toHaveBeenCalledTimes(1);
    expect(await runsFor(fx, row.id)).toHaveLength(0);
    expect(await postsFor(fx.thread.id)).toHaveLength(1);
  });

  runDb('a retry after the admission committed keeps the run even if the grant was revised in between', async () => {
    const fx = await seed();
    const now = new Date();
    h.enqueueAssessment.mockImplementationOnce(async (input: { reason: { checkInId: string } }) => {
      await insertRun(fx, input.reason.checkInId);
      throw new Error('worker lost');
    });
    const row = await scheduleRun(fx, now);
    await makeDue(row.id, now);
    await expect(fireCheckIn(row.id, now)).rejects.toThrow('worker lost');
    await withSystemDbAccessContext(async () => {
      const [revision] = await db.insert(wispGrantRevisions).values({
        grantId: fx.grantId, partnerId: fx.partner.id, revision: 2,
        ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds: [fx.org.id], siteIds: null, toolAllowlist: null, deniedTools: [] },
        factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
      }).returning({ id: wispGrantRevisions.id });
      await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, fx.grantId));
    });
    expect(await fireCheckIn(row.id, now)).toBe('running');
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('an admission that reports duplicate (a racing fire) is recovered by its dedupe key', async () => {
    const fx = await seed();
    const now = new Date();
    h.enqueueAssessment.mockImplementationOnce(async (input: { reason: { checkInId: string } }) => {
      await insertRun(fx, input.reason.checkInId);
      return { skipped: 'duplicate' };
    });
    const row = await scheduleRun(fx, now);
    await makeDue(row.id, now);
    expect(await fireCheckIn(row.id, now)).toBe('running');
    expect((await rowOf(row.id)).runId).toBe((await runsFor(fx, row.id))[0]!.id);
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('budget exhausted: the Phase 1 post says so and asks to run it now; the row is fired with no run', async () => {
    const fx = await seed();
    const now = new Date('2026-11-09T23:59:50.000Z');
    h.enqueueAssessment.mockResolvedValue({ skipped: 'budget_exhausted' });
    const row = await scheduleRun(fx, new Date());
    await makeDue(row.id, new Date());
    expect(await fireCheckIn(row.id, now)).toBe('fired');
    const [post] = await postsFor(fx.thread.id);
    expect(post).toMatchObject({
      kind: 'check_in',
      body: `I couldn't check on my own: today's budget is spent. Run it now? ${INSTRUCTION}`,
      dedupeKey: `wisp.check_in:${row.id}`,
    });
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', runId: null, firedAt: now });
  });

  runDb('a revision that lands between the fire-path check and admission (grant_revision_changed) posts the grant-changed degrade', async () => {
    const fx = await seed();
    h.enqueueAssessment.mockResolvedValue({ skipped: 'grant_revision_changed' });
    const row = await scheduleRun(fx, new Date());
    await makeDue(row.id, new Date());
    expect(await fireCheckIn(row.id, new Date())).toBe('fired');
    expect((await postsFor(fx.thread.id))[0]!.body).toBe(
      `I couldn't check on my own: the grant changed since this was scheduled. Run it now? ${INSTRUCTION}`,
    );
    expect(await runsFor(fx, row.id)).toHaveLength(0);
  });

  runDb('an event run check-in fired later by the tick admits once, with the evidence; a second sweep admits nothing', async () => {
    const fx = await seed();
    admitting(fx);
    const row = await scheduleRun(fx, new Date(), { trigger: { kind: 'device_online', subjectId: fx.device.id } });
    expect(row.status).toBe('scheduled');
    await withSystemDbAccessContext(() => db.update(devices).set({ status: 'online', lastSeenAt: new Date() }).where(eq(devices.id, fx.device.id)));
    _resetCheckInTriggerSweepForTests();
    expect(await reconcileCheckInTriggers(new Date())).toMatchObject({ fired: 1 });
    expect(await rowOf(row.id)).toMatchObject({ status: 'running', fireReason: 'event' });
    const call = h.enqueueAssessment.mock.calls[0]![0] as { reason: { evidence: Record<string, unknown> }; dedupeKey: string };
    expect(call.dedupeKey).toBe(`wisp-check-in-${row.id}`);
    expect(call.reason.evidence).toMatchObject({ kind: 'device_online', status: 'online' });
    _resetCheckInTriggerSweepForTests();
    await reconcileCheckInTriggers(new Date());
    expect(h.enqueueAssessment).toHaveBeenCalledTimes(1);
    expect(await runsFor(fx, row.id)).toHaveLength(1);
  });

  runDb('any other admission skip posts "the check could not start"', async () => {
    const fx = await seed();
    h.enqueueAssessment.mockResolvedValue({ skipped: 'no_effective_agent' });
    const row = await scheduleRun(fx, new Date());
    await makeDue(row.id, new Date());
    expect(await fireCheckIn(row.id, new Date())).toBe('fired');
    expect((await postsFor(fx.thread.id))[0]!.body).toBe(`I couldn't check on my own: the check could not start. Run it now? ${INSTRUCTION}`);
  });

  runDb('a revoked grant cancels with grant_inactive and admits nothing', async () => {
    const fx = await seed();
    const row = await scheduleRun(fx, new Date());
    await makeDue(row.id, new Date());
    await withSystemDbAccessContext(() => db.update(wispGrants).set({ status: 'revoked', revokedAt: new Date() }).where(eq(wispGrants.id, fx.grantId)));
    expect(await fireCheckIn(row.id, new Date())).toBe('cancelled');
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'grant_inactive' });
    expect(h.enqueueAssessment).not.toHaveBeenCalled();
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('a grant revised since scheduling admits nothing and posts the degrade', async () => {
    const fx = await seed();
    const row = await scheduleRun(fx, new Date());
    await makeDue(row.id, new Date());
    await withSystemDbAccessContext(async () => {
      const [revision] = await db.insert(wispGrantRevisions).values({
        grantId: fx.grantId, partnerId: fx.partner.id, revision: 2,
        ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use', '*:*'], orgIds: [fx.org.id], siteIds: null, toolAllowlist: null, deniedTools: [] },
        factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
      }).returning({ id: wispGrantRevisions.id });
      await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, fx.grantId));
    });
    expect(await fireCheckIn(row.id, new Date())).toBe('fired');
    expect(h.enqueueAssessment).not.toHaveBeenCalled();
    expect((await postsFor(fx.thread.id))[0]!.body).toBe(
      `I couldn't check on my own: the grant changed since this was scheduled. Run it now? ${INSTRUCTION}`,
    );
  });

  runDb('a context device that was deleted posts "nothing to check" and admits nothing', async () => {
    const fx = await seed();
    const row = await scheduleRun(fx, new Date(), { context: { subject: { kind: 'device', id: fx.device.id } } });
    await makeDue(row.id, new Date());
    await withSystemDbAccessContext(() => db.delete(devices).where(eq(devices.id, fx.device.id)));
    expect(await fireCheckIn(row.id, new Date())).toBe('fired');
    expect(h.enqueueAssessment).not.toHaveBeenCalled();
    expect((await postsFor(fx.thread.id))[0]!.body).toBe('The device was deleted; nothing to check.');
  });

  runDb('an event run check-in whose event already happened admits at scheduling, with the evidence', async () => {
    const fx = await seed();
    admitting(fx);
    await withSystemDbAccessContext(() => db.update(devices).set({ status: 'online', lastSeenAt: new Date() }).where(eq(devices.id, fx.device.id)));
    const row = await scheduleRun(fx, new Date(), { trigger: { kind: 'device_online', subjectId: fx.device.id } });
    expect(row.status).toBe('running');
    const call = h.enqueueAssessment.mock.calls[0]![0] as { reason: { evidence: Record<string, unknown> } };
    expect(call.reason.evidence).toMatchObject({ kind: 'device_online', status: 'online' });
    // Admitted ahead of its deadline: the deadline job is removed.
    expect(h.removeCheckInJob).toHaveBeenCalledWith(row.id);
  });

  runDb('a running row is never prepended to a turn', async () => {
    const fx = await seed();
    const { row } = await firedRunning(fx);
    const fired = await withSystemDbAccessContext(() => loadFiredCheckIns(fx.grantId, fx.user.id));
    expect(fired.map((f) => f.id)).not.toContain(row.id);
  });
});

describe('posting the settled run', () => {
  runDb('a completed run posts its summary once, links the run, and the row is consumed', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    await setRun(runId, { status: 'completed', summary: 'The scan finished: KB5031 and KB5032 are missing.', finishedAt: new Date() });
    expect(await postCheckInRunResult(runId)).toBe('posted');
    expect(await postCheckInRunResult(runId)).toBe('already');
    const posts = await postsFor(fx.thread.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      kind: 'check_in',
      title: `Checked: ${INSTRUCTION.slice(0, 80)}`,
      body: 'The scan finished: KB5031 and KB5032 are missing.',
      link: `/ai-agents/runs/${runId}`,
      dedupeKey: `wisp.check_in:${row.id}`,
    });
    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(1);
    expect(await rowOf(row.id)).toMatchObject({ status: 'consumed' });
    // Consumed: nothing left for the next turn.
    expect(await withSystemDbAccessContext(() => loadFiredCheckIns(fx.grantId, fx.user.id))).toEqual([]);
  });

  runDb('a run awaiting approval posts its summary with the waiting note, once, and is consumed', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    await setRun(runId, { status: 'awaiting_approval', summary: 'WS-01 is missing KB5031; I proposed installing it.', finishedAt: new Date() });
    expect(await postCheckInRunResult(runId)).toBe('posted');
    expect((await postsFor(fx.thread.id))[0]!.body).toBe(
      'WS-01 is missing KB5031; I proposed installing it. A step I proposed is waiting for your approval.',
    );
    expect((await rowOf(row.id)).status).toBe('consumed');
    // The run later completing (after approval) posts nothing more.
    await setRun(runId, { status: 'completed' });
    expect(await postCheckInRunResult(runId)).toBe('already');
    expect(await postsFor(fx.thread.id)).toHaveLength(1);
  });

  runDb('the finalizer and the reconcile racing end with one post', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    await setRun(runId, { status: 'completed', summary: 'All clear.', finishedAt: new Date() });
    const [direct, swept] = await Promise.all([postCheckInRunResult(runId), reconcileRunningCheckIns(new Date())]);
    expect(await postsFor(fx.thread.id)).toHaveLength(1);
    expect((await rowOf(row.id)).status).toBe('consumed');
    // At most one of the two reports a post (the notifyUser dedupe and the
    // flip's compare-and-set can each be won by a different caller).
    expect(Number(direct === 'posted') + swept.posted).toBeLessThanOrEqual(1);
    expect(vi.mocked(notifyUser).mock.calls.length).toBeLessThanOrEqual(2);
  });

  runDb('a failed run posts "didn\'t finish" and asks to run it now; the row is fired and its next turn says so', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    await setRun(runId, { status: 'failed', errorCode: 'wall_clock_exceeded', finishedAt: new Date() });
    expect(await postCheckInRunResult(runId)).toBe('posted');
    expect((await postsFor(fx.thread.id))[0]!.body).toBe(`My check didn't finish (failed). Run it now? ${INSTRUCTION}`);
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', runId });
    const fired = await withSystemDbAccessContext(() => loadFiredCheckIns(fx.grantId, fx.user.id));
    expect(fired.map((f) => f.id)).toEqual([row.id]);
    expect(renderCheckInBlock(fired)).toContain(CHECK_IN_RUN_NOT_DONE_LINE);
  });

  runDb('a run that has not settled, or any other assessment run, posts nothing', async () => {
    const fx = await seed();
    const { runId } = await firedRunning(fx);
    expect(await postCheckInRunResult(runId)).toBe('not_settled');
    const other = await insertRun(fx, randomUUID(), { status: 'completed', dedupeKey: `wisp-assess-${randomUUID()}` });
    expect(await postCheckInRunResult(other)).toBe('not_check_in');
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('a check-in the user cancelled while its run ran never posts', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    await cancelCheckIn(fx.grantId, row.id);
    await setRun(runId, { status: 'completed', summary: 'Done.', finishedAt: new Date() });
    expect(await postCheckInRunResult(runId)).toBe('already');
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('a grant revoked before the post cancels the row (grant_inactive) and posts nothing', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    await setRun(runId, { status: 'completed', summary: 'Done.', finishedAt: new Date() });
    await withSystemDbAccessContext(() => db.update(wispGrants).set({ status: 'revoked', revokedAt: new Date() }).where(eq(wispGrants.id, fx.grantId)));
    expect(await postCheckInRunResult(runId)).toBe('cancelled');
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'grant_inactive' });
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('an org no longer readable on the thread cancels the row (outside_ceiling)', async () => {
    const fx = await seed();
    const { row, runId } = await firedRunning(fx);
    await setRun(runId, { status: 'completed', summary: 'Done.', finishedAt: new Date() });
    h.ceiling = { ...fx.ceiling, orgIds: new Set([randomUUID()]) } as GrantCeiling;
    expect(await postCheckInRunResult(runId)).toBe('cancelled');
    expect((await rowOf(row.id)).cancelReason).toBe('outside_ceiling');
  });

  runDb('a run stuck unsettled for over a day, or one that is gone, is closed out by the tick as did-not-finish', async () => {
    const fx = await seed();
    const stuck = await firedRunning(fx);
    const gone = await firedRunning(fx);
    const fresh = await firedRunning(fx);
    const longAgo = new Date(Date.now() - 25 * 3_600_000);
    await withSystemDbAccessContext(async () => {
      await db.update(wispCheckIns).set({ firedAt: longAgo }).where(eq(wispCheckIns.id, stuck.row.id));
      await db.update(wispCheckIns).set({ runId: randomUUID() }).where(eq(wispCheckIns.id, gone.row.id));
    });
    expect(await reconcileRunningCheckIns(new Date())).toEqual({ posted: 2 });
    const bodies = (await postsFor(fx.thread.id)).map((p) => p.body).sort();
    expect(bodies).toEqual([
      `My check didn't finish (queued). Run it now? ${INSTRUCTION}`,
      `My check didn't finish (unavailable). Run it now? ${INSTRUCTION}`,
    ]);
    expect((await rowOf(stuck.row.id)).status).toBe('fired');
    expect((await rowOf(gone.row.id)).status).toBe('fired');
    expect((await rowOf(fresh.row.id)).status).toBe('running');
  });

  runDb('the tick reconcile posts settled runs and leaves running ones alone; Wisp off does nothing', async () => {
    const fx = await seed();
    const a = await firedRunning(fx);
    const b = await firedRunning(fx);
    await setRun(a.runId, { status: 'skipped', errorCode: 'grant_inactive', finishedAt: new Date() });
    h.wispEnabled.mockReturnValue(false);
    expect(await reconcileRunningCheckIns(new Date())).toEqual({ posted: 0 });
    h.wispEnabled.mockReturnValue(true);
    expect(await reconcileRunningCheckIns(new Date())).toEqual({ posted: 1 });
    expect((await postsFor(fx.thread.id)).map((p) => p.body)).toEqual([`My check didn't finish (skipped). Run it now? ${INSTRUCTION}`]);
    expect((await rowOf(b.row.id)).status).toBe('running');
  });
});
