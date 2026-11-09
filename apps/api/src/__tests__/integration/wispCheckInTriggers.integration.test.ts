/**
 * Wisp event check-ins W04 (#11493, #10410 wave A) — services/wisp/checkIns.ts
 * fire paths for EVENT rows against real Postgres (forced RLS): the trigger
 * subject reads (checkInTriggers.ts loadTriggerSubject, one per kind), firing
 * at scheduling when the event already happened, the bus-event fast path, the
 * tick reconcile, the deadline job, the fire claim, the event / deadline race,
 * and the cancel reasons (Review Focus 4: a subject deleted or moved outside
 * the ceiling is cancelled, never fired on stale data).
 *
 * BullMQ is replaced by the wake.ts helper mocks; push dispatch and the
 * throttle are stubbed. The live grant ceiling is a stub (`h.ceiling`), so the
 * subject's org / site against `orgIds` is what decides reach; the real
 * resolveGrantCeiling is pinned by its own suites. Everything else is real.
 *
 * Prerequisites: pnpm test-stack up
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, scriptExecutions, scripts, userNotifications, wispCheckIns, wispGrantRevisions, wispGrants, wispThreadPosts } from '../../db/schema';
import type { BreezeEvent } from '../../services/eventBus';
import { GrantInactiveError, type GrantCeiling } from '../../services/wisp/grantAuthority';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  enqueueCheckIn: vi.fn(),
  removeCheckInJob: vi.fn(),
  isCheckInJobLive: vi.fn(),
  resolveGrantCeiling: vi.fn(),
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
vi.mock('../../config/env', async (orig) => ({
  ...(await orig<typeof import('../../config/env')>()),
  wispEnabled: () => h.wispEnabled(),
}));

import { notifyUser } from '../../services/wisp/notifyUser';
import { getOrCreateThread } from '../../services/wisp/threads';
import {
  claimCheckInFire,
  createCheckIn,
  fireCheckIn,
  handleCheckInTriggerEvent,
  reconcileCheckInTriggers,
  _resetCheckInTriggerSweepForTests,
} from '../../services/wisp/checkIns';
import { loadTriggerSubject } from '../../services/wisp/checkInTriggers';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIN = 60_000;
const DAY = 86_400_000;
const INSTRUCTION = 'Pull the patch scan results for the device and report what is missing.';

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
  h.wispEnabled.mockReset();
  h.wispEnabled.mockReturnValue(true);
  _resetCheckInTriggerSweepForTests();
});

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[]) {
  return withSystemDbAccessContext(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: null, grantorUserId, status: 'active',
      expiresAt: new Date(Date.now() + 30 * DAY),
    }).returning({ id: wispGrants.id });
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: grant!.id, partnerId, revision: 1,
      ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds, siteIds: null, toolAllowlist: null, deniedTools: [] },
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, grant!.id));
    return { grantId: grant!.id, revisionId: revision!.id };
  });
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const outsideOrg = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const outsideSite = await createSite({ orgId: outsideOrg.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-trigger-${randomUUID()}@wisp.test` });
  const { grantId, revisionId } = await seedGrant(partner.id, user.id, [org.id]);
  const thread = await getOrCreateThread(grantId);
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const ceiling = {
    grantId, revisionId, partnerId: partner.id, grantorUserId: user.id, scopeOrgId: null, partnerWide: false,
    orgIds: new Set([org.id]), siteIds: null,
    permissionKeys: new Set(['ai_sessions:use', 'devices:read', 'scripts:read', 'ai_agents:read']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active',
  } as GrantCeiling;
  h.ceiling = ceiling;
  return { partner, org, outsideOrg, site, outsideSite, user, grantId, revisionId, thread, device, ceiling };
}
type Fx = Awaited<ReturnType<typeof seed>>;

/**
 * Revise the grant (a new current revision with `permissionKeys`) after
 * scheduling, and make the stubbed live ceiling that revision's. The
 * scheduling ceiling (`fx.ceiling`) is left as it was.
 */
async function reviseGrant(fx: Fx, permissionKeys: string[]) {
  const revisionId = await withSystemDbAccessContext(async () => {
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: fx.grantId, partnerId: fx.partner.id, revision: 2,
      ceilingSnapshot: { version: 1, permissionKeys, orgIds: [fx.org.id], siteIds: null, toolAllowlist: null, deniedTools: [] },
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, fx.grantId));
    return revision!.id;
  });
  h.ceiling = { ...fx.ceiling, revisionId, permissionKeys: new Set(permissionKeys) } as GrantCeiling;
  return revisionId;
}

const setDevice = (id: string, values: Partial<typeof devices.$inferInsert>) => withSystemDbAccessContext(() =>
  db.update(devices).set(values).where(eq(devices.id, id)));

async function scriptExecution(fx: Fx, status: typeof scriptExecutions.$inferInsert['status'], extra: Partial<typeof scriptExecutions.$inferInsert> = {}) {
  return withSystemDbAccessContext(async () => {
    // A library execution names its script (script_executions_library_source_chk).
    const [script] = await db.insert(scripts).values({
      orgId: fx.org.id, name: `scan-${randomUUID().slice(0, 8)}`, osTypes: ['windows'], language: 'powershell', content: 'Get-Date',
    }).returning({ id: scripts.id });
    const [row] = await db.insert(scriptExecutions).values({ scriptId: script!.id, deviceId: fx.device.id, orgId: fx.org.id, status, ...extra }).returning({ id: scriptExecutions.id });
    return row!.id;
  });
}

async function command(fx: Fx, status: string, extra: Partial<typeof deviceCommands.$inferInsert> = {}) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(deviceCommands).values({ deviceId: fx.device.id, type: 'patch_scan', status, ...extra }).returning({ id: deviceCommands.id });
    return row!.id;
  });
}

const schedule = (fx: Fx, now: Date, trigger: { kind: 'device_online' | 'script_finished' | 'command_finished' | 'run_settled'; subjectId: string }, o: { deadlineMs?: number } = {}) =>
  createCheckIn(fx.ceiling, {
    threadId: fx.thread.id,
    sessionId: randomUUID(),
    dueAt: new Date(now.getTime() + (o.deadlineMs ?? DAY)),
    instruction: INSTRUCTION,
    orgId: fx.org.id,
    context: null,
    trigger,
  }, now);

const scheduleTime = (fx: Fx, now: Date, dueInMs = 10 * MIN) => createCheckIn(fx.ceiling, {
  threadId: fx.thread.id, sessionId: null, dueAt: new Date(now.getTime() + dueInMs), instruction: INSTRUCTION, orgId: fx.org.id, context: null,
}, now);

const rowOf = (id: string) => withSystemDbAccessContext(async () =>
  (await db.select().from(wispCheckIns).where(eq(wispCheckIns.id, id)))[0]!);
const postsFor = (threadId: string) => withSystemDbAccessContext(() =>
  db.select().from(wispThreadPosts).where(eq(wispThreadPosts.threadId, threadId)));
const notificationsFor = (userId: string) => withSystemDbAccessContext(() =>
  db.select().from(userNotifications).where(eq(userNotifications.userId, userId)));
const backdate = (id: string, createdAt: Date, dueAt: Date) => withSystemDbAccessContext(() =>
  db.update(wispCheckIns).set({ createdAt, dueAt }).where(eq(wispCheckIns.id, id)));

function busEvent(type: BreezeEvent['type'], orgId: string, payload: Record<string, unknown>): BreezeEvent {
  return { id: randomUUID(), type, orgId, source: 'test', priority: 'normal', timestamp: new Date().toISOString(), payload } as unknown as BreezeEvent;
}

describe('loadTriggerSubject (real reads)', () => {
  runDb('device, script execution and device command: org, partner, site and state; a missing id is null', async () => {
    const fx = await seed();
    await setDevice(fx.device.id, { status: 'online' });
    expect(await loadTriggerSubject('device_online', fx.device.id)).toMatchObject({
      kind: 'device_online', orgId: fx.org.id, partnerId: fx.partner.id, siteId: fx.site.id, status: 'online',
    });
    const exec = await scriptExecution(fx, 'completed', { exitCode: 3, stdout: 'done', completedAt: new Date() });
    expect(await loadTriggerSubject('script_finished', exec)).toMatchObject({
      kind: 'script_finished', orgId: fx.org.id, partnerId: fx.partner.id, siteId: fx.site.id, status: 'completed', exitCode: 3, output: 'done',
    });
    const cmd = await command(fx, 'failed', { result: { exitCode: 1 }, completedAt: new Date() });
    expect(await loadTriggerSubject('command_finished', cmd)).toMatchObject({
      kind: 'command_finished', orgId: fx.org.id, partnerId: fx.partner.id, siteId: fx.site.id, status: 'failed', exitCode: 1,
    });
    for (const kind of ['device_online', 'script_finished', 'command_finished', 'run_settled'] as const) {
      expect(await loadTriggerSubject(kind, randomUUID()), kind).toBeNull();
    }
  });
});

describe('scheduling an event check-in', () => {
  runDb('writes trigger_kind / trigger_subject_id, due_at = the deadline, and enqueues the deadline job', async () => {
    const fx = await seed();
    const now = new Date();
    const row = await schedule(fx, now, { kind: 'device_online', subjectId: fx.device.id });
    expect(row).toMatchObject({ status: 'scheduled', triggerKind: 'device_online', triggerSubjectId: fx.device.id, fireReason: null });
    expect(row.dueAt.getTime() - row.createdAt.getTime()).toBe(DAY);
    expect(h.enqueueCheckIn).toHaveBeenCalledWith(row.id, DAY);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  runDb('an event that already happened fires at once (reason event) AFTER the insert and the enqueue; the row comes back fired', async () => {
    const fx = await seed();
    await setDevice(fx.device.id, { status: 'online' });
    const now = new Date();
    const row = await schedule(fx, now, { kind: 'device_online', subjectId: fx.device.id });
    expect(h.enqueueCheckIn).toHaveBeenCalledWith(row.id, DAY);
    expect(row).toMatchObject({ status: 'fired', fireReason: 'event' });
    const [post] = await postsFor(fx.thread.id);
    expect(post).toMatchObject({ kind: 'check_in', body: INSTRUCTION, dedupeKey: `wisp.check_in:${row.id}` });
    // Fired on the event path: the deadline job is removed.
    expect(h.removeCheckInJob).toHaveBeenCalledWith(row.id);
  });

  runDb('a time check-in is unchanged: trigger_kind time, no subject, nothing evaluated', async () => {
    const fx = await seed();
    const row = await scheduleTime(fx, new Date());
    expect(row).toMatchObject({ status: 'scheduled', triggerKind: 'time', triggerSubjectId: null });
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  runDb('the DB refuses an event row without a subject, and a time row with one', async () => {
    const fx = await seed();
    const row = await scheduleTime(fx, new Date());
    await expect(withSystemDbAccessContext(() => db.update(wispCheckIns).set({ triggerSubjectId: fx.device.id }).where(eq(wispCheckIns.id, row.id))))
      .rejects.toThrow();
    await expect(withSystemDbAccessContext(() => db.update(wispCheckIns).set({ triggerKind: 'device_online' }).where(eq(wispCheckIns.id, row.id))))
      .rejects.toThrow();
  });
});

describe('the event fast path (handleCheckInTriggerEvent)', () => {
  runDb('device.online for the subject fires it with reason event and removes the delayed job', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    await setDevice(fx.device.id, { status: 'online' });
    await handleCheckInTriggerEvent(busEvent('device.online', fx.org.id, { deviceId: fx.device.id, status: 'online' }));
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', fireReason: 'event' });
    expect(h.removeCheckInJob).toHaveBeenCalledWith(row.id);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyUser).mock.calls[0]![0]).toMatchObject({ kind: 'check_in', body: INSTRUCTION, checkIn: { id: row.id, orgId: fx.org.id } });
  });

  runDb('device.online for ANOTHER device fires nothing and resolves no ceiling', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    const other = await createDevice({ orgId: fx.org.id, siteId: fx.site.id });
    await setDevice(other.id, { status: 'online' });
    await handleCheckInTriggerEvent(busEvent('device.online', fx.org.id, { deviceId: other.id }));
    expect((await rowOf(row.id)).status).toBe('scheduled');
    expect(notifyUser).not.toHaveBeenCalled();
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  runDb('a stale event (the device went offline again before delivery) leaves the row scheduled: the state decides, not the event', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    await handleCheckInTriggerEvent(busEvent('device.online', fx.org.id, { deviceId: fx.device.id }));
    expect(await rowOf(row.id)).toMatchObject({ status: 'scheduled', fireReason: null });
    expect(notifyUser).not.toHaveBeenCalled();
  });

  runDb('script.completed / script.failed map to script_finished on executionId', async () => {
    const fx = await seed();
    const ok = await scriptExecution(fx, 'running');
    const bad = await scriptExecution(fx, 'running');
    const rOk = await schedule(fx, new Date(), { kind: 'script_finished', subjectId: ok });
    const rBad = await schedule(fx, new Date(), { kind: 'script_finished', subjectId: bad });
    await withSystemDbAccessContext(() => db.update(scriptExecutions).set({ status: 'completed', exitCode: 0, completedAt: new Date() }).where(eq(scriptExecutions.id, ok)));
    await withSystemDbAccessContext(() => db.update(scriptExecutions).set({ status: 'timeout', completedAt: new Date() }).where(eq(scriptExecutions.id, bad)));
    await handleCheckInTriggerEvent(busEvent('script.completed', fx.org.id, { executionId: ok, deviceId: fx.device.id }));
    expect((await rowOf(rOk.id)).status).toBe('fired');
    expect((await rowOf(rBad.id)).status).toBe('scheduled');
    await handleCheckInTriggerEvent(busEvent('script.failed', fx.org.id, { executionId: bad, deviceId: fx.device.id }));
    expect(await rowOf(rBad.id)).toMatchObject({ status: 'fired', fireReason: 'event' });
  });

  runDb('an event type it does not handle, or a payload without a usable subject id, does nothing', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    await setDevice(fx.device.id, { status: 'online' });
    await handleCheckInTriggerEvent(busEvent('device.offline', fx.org.id, { deviceId: fx.device.id }));
    await handleCheckInTriggerEvent(busEvent('device.online', fx.org.id, { deviceId: 'not-a-uuid' }));
    await handleCheckInTriggerEvent(busEvent('device.online', fx.org.id, {}));
    expect((await rowOf(row.id)).status).toBe('scheduled');
  });

  runDb('a grant revised to drop scripts:read after scheduling: the script finishing cancels with outside_ceiling, nothing delivered', async () => {
    const fx = await seed();
    const exec = await scriptExecution(fx, 'running');
    const row = await schedule(fx, new Date(), { kind: 'script_finished', subjectId: exec });
    expect(row.status).toBe('scheduled');
    const narrowed = await reviseGrant(fx, ['ai_sessions:use', 'devices:read', 'ai_agents:read']);
    await withSystemDbAccessContext(() => db.update(scriptExecutions).set({ status: 'completed', exitCode: 0, stdout: 'scan ok', completedAt: new Date() }).where(eq(scriptExecutions.id, exec)));
    await handleCheckInTriggerEvent(busEvent('script.completed', fx.org.id, { executionId: exec, deviceId: fx.device.id }));
    // The live revision decided, not the one pinned at scheduling.
    expect(h.resolveGrantCeiling).toHaveBeenLastCalledWith(fx.grantId, narrowed);
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'outside_ceiling', fireReason: null });
    expect(notifyUser).not.toHaveBeenCalled();
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
    expect(await notificationsFor(fx.user.id)).toHaveLength(0);
  });

  runDb('Review Focus 4: a device moved to an org outside the ceiling is cancelled with outside_ceiling, never fired', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    await setDevice(fx.device.id, { orgId: fx.outsideOrg.id, siteId: fx.outsideSite.id, status: 'online' });
    await handleCheckInTriggerEvent(busEvent('device.online', fx.outsideOrg.id, { deviceId: fx.device.id }));
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'outside_ceiling', fireReason: null });
    expect(notifyUser).not.toHaveBeenCalled();
  });
});

describe('the tick reconcile (reconcileCheckInTriggers)', () => {
  runDb('fires a command_finished row whose command completed before its deadline; ignores time rows and rows past due_at', async () => {
    const fx = await seed();
    const now = new Date();
    const cmd = await command(fx, 'sent');
    const row = await schedule(fx, now, { kind: 'command_finished', subjectId: cmd });
    const timeRow = await scheduleTime(fx, now);
    const pastCmd = await command(fx, 'sent');
    const past = await schedule(fx, new Date(now.getTime() - 2 * DAY), { kind: 'command_finished', subjectId: pastCmd });
    // Scheduled two days ago with a one-day deadline: due_at is in the past, the orphan reconcile owns it.
    await backdate(past.id, new Date(now.getTime() - 2 * DAY), new Date(now.getTime() - DAY));
    await withSystemDbAccessContext(() => db.update(deviceCommands).set({ status: 'completed', completedAt: now }).where(eq(deviceCommands.id, pastCmd)));

    expect(await reconcileCheckInTriggers(now)).toEqual({ fired: 0, cancelled: 0 });
    expect((await rowOf(row.id)).status).toBe('scheduled');

    await withSystemDbAccessContext(() => db.update(deviceCommands).set({ status: 'completed', completedAt: now }).where(eq(deviceCommands.id, cmd)));
    expect(await reconcileCheckInTriggers(now)).toEqual({ fired: 1, cancelled: 0 });
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', fireReason: 'event' });
    expect((await rowOf(timeRow.id)).status).toBe('scheduled');
    expect((await rowOf(past.id)).status).toBe('scheduled');
  });

  runDb('a grant revised to drop devices:read: a completed command cancels with outside_ceiling on the tick, nothing delivered', async () => {
    const fx = await seed();
    const now = new Date();
    const cmd = await command(fx, 'sent');
    const row = await schedule(fx, now, { kind: 'command_finished', subjectId: cmd });
    await reviseGrant(fx, ['ai_sessions:use', 'scripts:read', 'ai_agents:read']);
    await withSystemDbAccessContext(() => db.update(deviceCommands).set({ status: 'completed', completedAt: now }).where(eq(deviceCommands.id, cmd)));
    expect(await reconcileCheckInTriggers(now)).toEqual({ fired: 0, cancelled: 1 });
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'outside_ceiling', fireReason: null });
    expect(notifyUser).not.toHaveBeenCalled();
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('Review Focus 4: a deleted subject cancels with subject_deleted on the tick', async () => {
    const fx = await seed();
    const cmd = await command(fx, 'sent');
    const row = await schedule(fx, new Date(), { kind: 'command_finished', subjectId: cmd });
    await withSystemDbAccessContext(() => db.delete(deviceCommands).where(eq(deviceCommands.id, cmd)));
    expect(await reconcileCheckInTriggers(new Date())).toEqual({ fired: 0, cancelled: 1 });
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'subject_deleted' });
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });
});

describe('the deadline (the delayed job at due_at)', () => {
  runDb('a pending predicate posts "Did not happen by HH:MM UTC: <state line>. <instruction>" with fire_reason deadline', async () => {
    const fx = await seed();
    const now = new Date();
    const row = await schedule(fx, now, { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    const dueAt = row.dueAt;
    expect(await fireCheckIn(row.id, new Date(dueAt.getTime() + 1000))).toBe('fired');
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', fireReason: 'deadline' });
    const [post] = await postsFor(fx.thread.id);
    expect(post!.body).toBe(`Did not happen by ${dueAt.toISOString().slice(11, 16)} UTC: the device is still offline. ${INSTRUCTION}`);
    expect(h.removeCheckInJob).not.toHaveBeenCalled();
  });

  runDb('a predicate that holds at the deadline (the event was missed) fires as an event', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    // The bus event was lost and the tick has not run; the device is online when the deadline job runs.
    await setDevice(fx.device.id, { status: 'online' });
    expect(await fireCheckIn(row.id, new Date(row.dueAt.getTime() + 1000))).toBe('fired');
    expect(await rowOf(row.id)).toMatchObject({ fireReason: 'event' });
    expect((await postsFor(fx.thread.id))[0]!.body).toBe(INSTRUCTION);
  });

  runDb('a deadline job that runs before due_at (clock skew) fires nothing; the orphan reconcile retries it', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    expect(await fireCheckIn(row.id, new Date(row.dueAt.getTime() - 10 * MIN))).toBe('skipped');
    expect(await rowOf(row.id)).toMatchObject({ status: 'scheduled', fireReason: null });
  });

  runDb('a subject outside the ceiling at the deadline is cancelled, not reported as "did not happen"', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    await setDevice(fx.device.id, { orgId: fx.outsideOrg.id, siteId: fx.outsideSite.id });
    expect(await fireCheckIn(row.id, new Date(row.dueAt.getTime() + 1000))).toBe('cancelled');
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'outside_ceiling' });
    expect(notifyUser).not.toHaveBeenCalled();
  });

  runDb('a grant revised to drop devices:read is cancelled at the deadline with outside_ceiling, not reported as "did not happen"', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    await reviseGrant(fx, ['ai_sessions:use', 'scripts:read', 'ai_agents:read']);
    expect(await fireCheckIn(row.id, new Date(row.dueAt.getTime() + 1000))).toBe('cancelled');
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'outside_ceiling', fireReason: null });
    expect(notifyUser).not.toHaveBeenCalled();
    expect(await postsFor(fx.thread.id)).toHaveLength(0);
  });

  runDb('a grant no longer usable cancels with grant_inactive; the live ceiling refusing cancels the same way', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    await withSystemDbAccessContext(() => db.update(wispGrants).set({ status: 'paused', pausedReason: 'user_paused' } as never).where(eq(wispGrants.id, fx.grantId)));
    expect(await fireCheckIn(row.id, new Date(row.dueAt.getTime() + 1000))).toBe('cancelled');
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'grant_inactive' });

    const fy = await seed();
    const row2 = await schedule(fy, new Date(), { kind: 'device_online', subjectId: fy.device.id }, { deadlineMs: 30 * MIN });
    h.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError(fy.grantId, 'paused', 'grantor_access_lost'));
    expect(await fireCheckIn(row2.id, new Date(row2.dueAt.getTime() + 1000))).toBe('cancelled');
    expect(await rowOf(row2.id)).toMatchObject({ status: 'cancelled', cancelReason: 'grant_inactive' });
  });
});

describe('the fire claim and the event / deadline race', () => {
  runDb('claimCheckInFire: the first reason wins; the same reason may claim again (a retry), a different one may not', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    expect(await claimCheckInFire(row.id, 'event')).toBe(true);
    expect(await claimCheckInFire(row.id, 'deadline')).toBe(false);
    expect(await claimCheckInFire(row.id, 'event')).toBe(true);
    expect((await rowOf(row.id)).fireReason).toBe('event');
  });

  runDb('deadline first: an event arriving while the deadline post is being written is skipped — one notifyUser, the deadline body', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    const at = new Date(row.dueAt.getTime() + 1000);
    const real = vi.mocked(notifyUser).getMockImplementation()!;
    let eventOutcome: string | null = null;
    vi.mocked(notifyUser).mockImplementationOnce(async (p) => {
      await setDevice(fx.device.id, { status: 'online' });
      eventOutcome = await fireCheckIn(row.id, at, { path: 'event' });
      return real(p);
    });
    expect(await fireCheckIn(row.id, at)).toBe('fired');
    expect(eventOutcome).toBe('skipped');
    expect(notifyUser).toHaveBeenCalledTimes(1);
    const after = await rowOf(row.id);
    expect(after).toMatchObject({ status: 'fired', fireReason: 'deadline' });
    const posts = await postsFor(fx.thread.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body!.startsWith('Did not happen by ')).toBe(true);
  });

  runDb('event first: a deadline job reading the claimed row re-delivers the SAME event post (deduped) — one post, one notification', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    await setDevice(fx.device.id, { status: 'online' });
    const at = new Date(row.dueAt.getTime() + 1000);
    const real = vi.mocked(notifyUser).getMockImplementation()!;
    let jobOutcome: string | null = null;
    vi.mocked(notifyUser).mockImplementationOnce(async (p) => {
      await setDevice(fx.device.id, { status: 'offline' });
      jobOutcome = await fireCheckIn(row.id, at);
      return real(p);
    });
    expect(await fireCheckIn(row.id, at, { path: 'event' })).toBe('skipped');
    expect(jobOutcome).toBe('fired');
    for (const call of vi.mocked(notifyUser).mock.calls) expect(call[0].body).toBe(INSTRUCTION);
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', fireReason: 'event' });
    expect(await postsFor(fx.thread.id)).toHaveLength(1);
    expect(await notificationsFor(fx.user.id)).toHaveLength(1);
  });

  runDb('a claimed row left scheduled by a crash is re-fired with its claimed reason, whatever the state is now', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    // The event path claimed, then died before notifyUser; the device has gone offline since.
    expect(await claimCheckInFire(row.id, 'event')).toBe(true);
    expect(await reconcileCheckInTriggers(new Date())).toEqual({ fired: 1, cancelled: 0 });
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', fireReason: 'event' });
    expect((await postsFor(fx.thread.id))[0]!.body).toBe(INSTRUCTION);

    // A deadline claim is the job path's: the tick leaves it to the orphan reconcile.
    const row2 = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    expect(await claimCheckInFire(row2.id, 'deadline')).toBe(true);
    await setDevice(fx.device.id, { status: 'online' });
    expect(await fireCheckIn(row2.id, new Date(), { path: 'event' })).toBe('skipped');
    expect(await fireCheckIn(row2.id, new Date(row2.dueAt.getTime() + 1000))).toBe('fired');
    expect(await rowOf(row2.id)).toMatchObject({ status: 'fired', fireReason: 'deadline' });
  });

  runDb('a time row records fire_reason due; the event path never fires it', async () => {
    const fx = await seed();
    const row = await scheduleTime(fx, new Date());
    expect(await fireCheckIn(row.id, new Date(), { path: 'event' })).toBe('skipped');
    expect(await fireCheckIn(row.id)).toBe('fired');
    expect(await rowOf(row.id)).toMatchObject({ status: 'fired', fireReason: 'due' });
  });
});

describe('failures, Wisp off, and the edges (review follow-ups)', () => {
  runDb('Wisp off: the event fast path reads nothing and fires nothing', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    await setDevice(fx.device.id, { status: 'online' });
    h.wispEnabled.mockReturnValue(false);
    await handleCheckInTriggerEvent(busEvent('device.online', fx.org.id, { deviceId: fx.device.id }));
    expect((await rowOf(row.id)).status).toBe('scheduled');
    expect(notifyUser).not.toHaveBeenCalled();
  });

  runDb('Wisp off: a grant ceiling refusal at the deadline leaves the row scheduled instead of cancelling it', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    h.wispEnabled.mockReturnValue(false);
    h.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError(fx.grantId, 'paused', 'Wisp is disabled on this deployment', 'paused'));
    expect(await fireCheckIn(row.id, new Date(row.dueAt.getTime() + 1000))).toBe('skipped');
    expect(await rowOf(row.id)).toMatchObject({ status: 'scheduled', cancelReason: null, fireReason: null });
  });

  runDb('an event whose first row fails still fires the second, then throws so the delivery retries; the retry fires the first', async () => {
    const fx = await seed();
    const first = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    const second = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 60 * MIN });
    await setDevice(fx.device.id, { status: 'online' });
    vi.mocked(notifyUser).mockRejectedValueOnce(new Error('push down'));
    const event = busEvent('device.online', fx.org.id, { deviceId: fx.device.id });
    await expect(handleCheckInTriggerEvent(event)).rejects.toThrow('push down');
    // The first row (nearest deadline) failed after its claim; the second fired.
    expect(await rowOf(first.id)).toMatchObject({ status: 'scheduled', fireReason: 'event' });
    expect((await rowOf(second.id)).status).toBe('fired');
    await handleCheckInTriggerEvent(event);
    expect(await rowOf(first.id)).toMatchObject({ status: 'fired', fireReason: 'event' });
  });

  runDb('a failing row never stops the tick sweep: the rows behind it are still fired', async () => {
    const fx = await seed();
    const now = new Date();
    const cmds = [await command(fx, 'sent'), await command(fx, 'sent'), await command(fx, 'sent')];
    const rows = [];
    for (const [i, cmd] of cmds.entries()) rows.push(await schedule(fx, now, { kind: 'command_finished', subjectId: cmd }, { deadlineMs: (i + 1) * 30 * MIN }));
    for (const cmd of cmds) await withSystemDbAccessContext(() => db.update(deviceCommands).set({ status: 'completed', completedAt: now }).where(eq(deviceCommands.id, cmd)));
    vi.mocked(notifyUser).mockRejectedValueOnce(new Error('push down'));
    expect(await reconcileCheckInTriggers(now)).toEqual({ fired: 2, cancelled: 0 });
    expect((await rowOf(rows[0]!.id)).status).toBe('scheduled');
    expect((await rowOf(rows[1]!.id)).status).toBe('fired');
    expect((await rowOf(rows[2]!.id)).status).toBe('fired');
  });

  runDb('a full page hands the next tick a cursor, so rows beyond the first page are reached; a short page wraps to the top', async () => {
    const fx = await seed();
    const now = new Date();
    const cmds = [await command(fx, 'sent'), await command(fx, 'sent'), await command(fx, 'sent')];
    const rows = [];
    for (const [i, cmd] of cmds.entries()) rows.push(await schedule(fx, now, { kind: 'command_finished', subjectId: cmd }, { deadlineMs: (i + 1) * 30 * MIN }));
    // Page 1 (limit 2): the two nearest deadlines, still pending.
    expect(await reconcileCheckInTriggers(now, { limit: 2 })).toEqual({ fired: 0, cancelled: 0 });
    for (const cmd of cmds) await withSystemDbAccessContext(() => db.update(deviceCommands).set({ status: 'completed', completedAt: now }).where(eq(deviceCommands.id, cmd)));
    // Page 2 continues after the cursor: only the third row.
    expect(await reconcileCheckInTriggers(now, { limit: 2 })).toEqual({ fired: 1, cancelled: 0 });
    expect((await rowOf(rows[2]!.id)).status).toBe('fired');
    expect((await rowOf(rows[0]!.id)).status).toBe('scheduled');
    // That page was short, so the next one starts from the top again.
    expect(await reconcileCheckInTriggers(now, { limit: 2 })).toEqual({ fired: 2, cancelled: 0 });
  });

  runDb('a grant with no pinned revision is corrupt: cancelled grant_inactive; any other ceiling failure throws and leaves the row as it was', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    h.resolveGrantCeiling.mockRejectedValueOnce(new Error('db down'));
    await expect(fireCheckIn(row.id, new Date(row.dueAt.getTime() + 1000))).rejects.toThrow('db down');
    expect(await rowOf(row.id)).toMatchObject({ status: 'scheduled', fireReason: null, cancelReason: null });

    await withSystemDbAccessContext(() => db.update(wispGrants).set({ currentRevisionId: null }).where(eq(wispGrants.id, fx.grantId)));
    expect(await fireCheckIn(row.id, new Date(row.dueAt.getTime() + 1000))).toBe('cancelled');
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'grant_inactive' });
  });

  runDb("a device moved to another partner's org reads as deleted at fire time", async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    await setDevice(fx.device.id, { orgId: otherOrg.id, siteId: otherSite.id, status: 'online' });
    await handleCheckInTriggerEvent(busEvent('device.online', otherOrg.id, { deviceId: fx.device.id }));
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'subject_deleted' });
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  runDb('createCheckIn: a failing fire-at-schedule is reported, not thrown — the row comes back scheduled for the tick; an event row needs an org', async () => {
    const fx = await seed();
    await setDevice(fx.device.id, { status: 'online' });
    h.resolveGrantCeiling.mockRejectedValueOnce(new Error('db down'));
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    expect(row).toMatchObject({ status: 'scheduled', fireReason: null });
    expect(await reconcileCheckInTriggers(new Date())).toEqual({ fired: 1, cancelled: 0 });

    await expect(createCheckIn(fx.ceiling, {
      threadId: fx.thread.id, sessionId: null, dueAt: new Date(Date.now() + DAY), instruction: INSTRUCTION, orgId: null, context: null,
      trigger: { kind: 'device_online', subjectId: fx.device.id },
    })).rejects.toThrow(/needs its subject's org/);
  });

  runDb('the early-deadline tolerance: 59 s before due_at fires the deadline, 61 s before skips', async () => {
    const fx = await seed();
    const a = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id }, { deadlineMs: 30 * MIN });
    expect(await fireCheckIn(a.id, new Date(a.dueAt.getTime() - 61_000))).toBe('skipped');
    expect(await fireCheckIn(a.id, new Date(a.dueAt.getTime() - 59_000))).toBe('fired');
    expect(await rowOf(a.id)).toMatchObject({ fireReason: 'deadline' });
  });

  runDb('a delayed-job removal that throws after an event fire is reported; the fire still counts', async () => {
    const fx = await seed();
    const row = await schedule(fx, new Date(), { kind: 'device_online', subjectId: fx.device.id });
    await setDevice(fx.device.id, { status: 'online' });
    h.removeCheckInJob.mockRejectedValueOnce(new Error('redis down'));
    expect(await fireCheckIn(row.id, new Date(), { path: 'event' })).toBe('fired');
    expect((await rowOf(row.id)).status).toBe('fired');
  });
});
