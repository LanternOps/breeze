/**
 * Wisp check-in timers W02 (#10993, feature #10991) — services/wisp/checkIns.ts
 * against real Postgres (forced RLS, breeze_app): create (window, per-thread
 * cap, enqueue after the context closes), cancel, the fire path through
 * notifyUser (one post + one notification, compare-and-set, cancel racing
 * fire) and the orphan reconcile.
 *
 * BullMQ is replaced by the wake.ts helper mocks (enqueue / remove / live);
 * push dispatch and the throttle are stubbed. Everything else is real.
 *
 * Prerequisites: pnpm test-stack up
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { userNotifications, wispCheckIns, wispGrantRevisions, wispGrants, wispThreadPosts } from '../../db/schema';
import { CeilingViolationError, type GrantCeiling } from '../../services/wisp/grantAuthority';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  enqueueCheckIn: vi.fn(),
  removeCheckInJob: vi.fn(),
  isCheckInJobLive: vi.fn(),
  /**
   * The DB access scope open when each enqueue ran (#1105: never the service's
   * own system context; null = none, the caller's scope when called from one).
   */
  enqueueCtx: [] as Array<string | null>,
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

import { notifyUser } from '../../services/wisp/notifyUser';
import { getOrCreateThread } from '../../services/wisp/threads';
import {
  CHECK_IN_RECONCILE_MAX_FAILURES,
  CheckInLimitReachedError,
  CheckInWindowError,
  cancelCheckIn,
  createCheckIn,
  fireCheckIn,
  listCheckIns,
  reconcileOrphanCheckIns,
  threadForGrant,
  toCheckInDto,
} from '../../services/wisp/checkIns';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIN = 60_000;
const DAY = 86_400_000;

beforeEach(() => {
  vi.mocked(notifyUser).mockClear();
  h.dispatch.mockReset();
  h.dispatch.mockImplementation(async (tokens: unknown[]) => ({ tokensFound: tokens.length, dispatched: tokens.length, errors: 0 }));
  h.enqueueCtx = [];
  h.enqueueCheckIn.mockReset();
  h.enqueueCheckIn.mockImplementation(async () => { h.enqueueCtx.push(getCurrentDbAccessContext()?.scope ?? null); });
  h.removeCheckInJob.mockReset();
  h.removeCheckInJob.mockResolvedValue(true);
  h.isCheckInJobLive.mockReset();
  h.isCheckInJobLive.mockResolvedValue(false);
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
    return grant!.id;
  });
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-checkin-${randomUUID()}@wisp.test` });
  const grantId = await seedGrant(partner.id, user.id, [org.id]);
  const thread = await getOrCreateThread(grantId);
  const ceiling = {
    grantId, revisionId: randomUUID(), partnerId: partner.id, grantorUserId: user.id, scopeOrgId: null, partnerWide: false,
    orgIds: new Set([org.id]), siteIds: null, permissionKeys: new Set(['ai_sessions:use']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active',
  } as GrantCeiling;
  return { partner, org, user, grantId, thread, ceiling };
}

type Fx = Awaited<ReturnType<typeof seed>>;

const create = (fx: Fx, now: Date, o: { dueInMs?: number; instruction?: string; orgId?: string | null } = {}) =>
  createCheckIn(fx.ceiling, {
    threadId: fx.thread.id,
    sessionId: randomUUID(),
    dueAt: new Date(now.getTime() + (o.dueInMs ?? 10 * MIN)),
    instruction: o.instruction ?? 'Verify no msiexec processes remain on the device; if clear, rerun the memory report.',
    orgId: o.orgId === undefined ? fx.org.id : o.orgId,
    context: { subject: { kind: 'device', id: randomUUID() } },
  }, now);

const rowOf = (id: string) => withSystemDbAccessContext(async () =>
  (await db.select().from(wispCheckIns).where(eq(wispCheckIns.id, id)))[0]);
const postsFor = (threadId: string) => withSystemDbAccessContext(() =>
  db.select().from(wispThreadPosts).where(eq(wispThreadPosts.threadId, threadId)));
const notificationsFor = (userId: string) => withSystemDbAccessContext(() =>
  db.select().from(userNotifications).where(eq(userNotifications.userId, userId)));

/** Rewind a row's created_at / due_at (a check-in scheduled in the past and now overdue). */
const backdate = (id: string, createdAt: Date, dueAt: Date) => withSystemDbAccessContext(() =>
  db.update(wispCheckIns).set({ createdAt, dueAt }).where(eq(wispCheckIns.id, id)));

describe('createCheckIn', () => {
  runDb('inserts scheduled with job_id wisp-check-in-<id> and enqueues with delay dueAt − now, outside any DB context', async () => {
    const fx = await seed();
    const now = new Date();
    const row = await create(fx, now, { dueInMs: 10 * MIN });
    expect(row).toMatchObject({
      status: 'scheduled', jobId: `wisp-check-in-${row.id}`, threadId: fx.thread.id, grantId: fx.grantId,
      partnerId: fx.partner.id, orgId: fx.org.id, userId: fx.user.id,
    });
    expect(row.createdAt.getTime()).toBe(now.getTime());
    expect(h.enqueueCheckIn).toHaveBeenCalledWith(row.id, 10 * MIN);
    expect(h.enqueueCtx).toEqual([null]);
    expect((await rowOf(row.id))!.status).toBe('scheduled');
  });

  runDb('from a request context of the grantor it still writes (system context) and enqueues after that context closed', async () => {
    const fx = await seed();
    const ctx: DbAccessContext = {
      scope: 'organization', orgId: fx.org.id, accessibleOrgIds: [fx.org.id], accessiblePartnerIds: [],
      userId: fx.user.id, currentPartnerId: fx.partner.id,
    };
    const row = await withDbAccessContext(ctx, () => create(fx, new Date(), { orgId: null }));
    expect((await rowOf(row.id))!.orgId).toBeNull();
    // Back in the caller's own scope, not inside the service's system context.
    expect(h.enqueueCtx).toEqual(['organization']);
  });

  runDb('refuses a 6th scheduled row on the thread (CheckInLimitReachedError), but a cancelled row frees a slot', async () => {
    const fx = await seed();
    const now = new Date();
    const rows = [];
    for (let i = 0; i < 5; i += 1) rows.push(await create(fx, now));
    await expect(create(fx, now)).rejects.toBeInstanceOf(CheckInLimitReachedError);
    expect(h.enqueueCheckIn).toHaveBeenCalledTimes(5);
    expect(await cancelCheckIn(fx.grantId, rows[0]!.id, now)).not.toBeNull();
    await expect(create(fx, now)).resolves.toMatchObject({ status: 'scheduled' });
  });

  runDb('refuses 59 s and 7 days + 1 s (CheckInWindowError) and writes nothing', async () => {
    const fx = await seed();
    const now = new Date();
    await expect(create(fx, now, { dueInMs: 59_000 })).rejects.toBeInstanceOf(CheckInWindowError);
    await expect(create(fx, now, { dueInMs: 7 * DAY + 1000 })).rejects.toBeInstanceOf(CheckInWindowError);
    // The bounds themselves are inside the window (the DB CHECK agrees).
    await expect(create(fx, now, { dueInMs: MIN })).resolves.toMatchObject({ status: 'scheduled' });
    await expect(create(fx, now, { dueInMs: 7 * DAY })).resolves.toMatchObject({ status: 'scheduled' });
    expect(h.enqueueCheckIn).toHaveBeenCalledTimes(2);
  });

  runDb('refuses an org outside the ceiling, an inactive grant and another grant\'s thread', async () => {
    const fx = await seed();
    const other = await seed();
    const now = new Date();
    await expect(create(fx, now, { orgId: other.org.id })).rejects.toMatchObject({ name: CeilingViolationError.name, code: 'org' });
    await expect(createCheckIn({ ...fx.ceiling, status: 'paused' } as GrantCeiling, {
      threadId: fx.thread.id, sessionId: null, dueAt: new Date(now.getTime() + 10 * MIN), instruction: 'x', orgId: null, context: null,
    }, now)).rejects.toMatchObject({ code: 'inactive' });
    await expect(createCheckIn({ ...fx.ceiling, status: 'paused' } as GrantCeiling, {
      threadId: fx.thread.id, sessionId: null, dueAt: new Date(now.getTime() + 10 * MIN), instruction: 'x', orgId: null, context: null,
    }, now)).rejects.toBeInstanceOf(CeilingViolationError);
    await expect(createCheckIn(fx.ceiling, {
      threadId: other.thread.id, sessionId: null, dueAt: new Date(now.getTime() + 10 * MIN), instruction: 'x', orgId: null, context: null,
    }, now)).rejects.toThrow(/thread/);
    expect(h.enqueueCheckIn).not.toHaveBeenCalled();
    const rows = await withSystemDbAccessContext(() => db.select().from(wispCheckIns).where(eq(wispCheckIns.grantId, fx.grantId)));
    expect(rows).toHaveLength(0);
  });

  runDb('the per-thread cap holds under 6 concurrent creates: exactly 5 succeed', async () => {
    const fx = await seed();
    const now = new Date();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => create(fx, now)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(5);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(CheckInLimitReachedError);
    expect(h.enqueueCheckIn).toHaveBeenCalledTimes(5);
  });

  runDb('refuses a whitespace-only or 1001-code-point instruction; 1000 code points is accepted', async () => {
    const fx = await seed();
    const now = new Date();
    await expect(create(fx, now, { instruction: '   ' })).rejects.toBeInstanceOf(RangeError);
    await expect(create(fx, now, { instruction: '🙂'.repeat(1001) })).rejects.toBeInstanceOf(RangeError);
    expect(h.enqueueCheckIn).not.toHaveBeenCalled();
    await expect(create(fx, now, { instruction: '🙂'.repeat(1000) })).resolves.toMatchObject({ status: 'scheduled' });
  });

  runDb('an enqueue failure still returns the row (reconcile fires it later)', async () => {
    const fx = await seed();
    h.enqueueCheckIn.mockRejectedValue(new Error('redis down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const row = await create(fx, new Date());
      expect((await rowOf(row.id))!.status).toBe('scheduled');
    } finally {
      err.mockRestore();
    }
  });

  runDb('threadForGrant returns the grant\'s thread; listCheckIns returns scheduled + fired, due_at ascending', async () => {
    const fx = await seed();
    // W07: the focus org rides along (a run check-in may assess it).
    expect(await threadForGrant(fx.grantId)).toEqual({ id: fx.thread.id, partnerId: fx.partner.id, focusOrgId: null });
    expect(await threadForGrant(randomUUID())).toBeNull();
    const now = new Date();
    const late = await create(fx, now, { dueInMs: 60 * MIN });
    const early = await create(fx, now, { dueInMs: 5 * MIN });
    const gone = await create(fx, now, { dueInMs: 20 * MIN });
    await cancelCheckIn(fx.grantId, gone.id, now);
    expect((await listCheckIns(fx.grantId, { limit: 10 })).map((r) => r.id)).toEqual([early.id, late.id]);
    expect((await listCheckIns(fx.grantId, { limit: 1 })).map((r) => r.id)).toEqual([early.id]);
    const dto = toCheckInDto(early);
    expect(dto).toMatchObject({ id: early.id, threadId: fx.thread.id, status: 'scheduled', firedAt: null, subject: { kind: 'device' } });
    expect(dto.dueAt).toBe(early.dueAt.toISOString());
  });
});

describe('fireCheckIn', () => {
  runDb('writes one check_in post + one notification and flips to fired', async () => {
    const fx = await seed();
    const row = await create(fx, new Date());
    const firedAt = new Date();
    expect(await fireCheckIn(row.id, firedAt)).toBe('fired');

    const after = (await rowOf(row.id))!;
    expect(after.status).toBe('fired');
    expect(after.firedAt!.getTime()).toBe(firedAt.getTime());

    const posts = await postsFor(fx.thread.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      kind: 'check_in', orgId: fx.org.id, dedupeKey: `wisp.check_in:${row.id}`,
      link: `/ai/wisp/thread/${fx.thread.id}#checkin=${row.id}`, body: row.instruction,
    });
    expect(posts[0]!.title.startsWith('Check-in due: ')).toBe(true);
    const notes = await notificationsFor(fx.user.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ dedupeKey: `wisp.check_in:${row.id}`, orgId: fx.org.id });
    expect(posts[0]!.notificationId).toBe(notes[0]!.id);
  });

  runDb('a partner-level check-in (org null) fires with a null-org post and notification', async () => {
    const fx = await seed();
    const row = await create(fx, new Date(), { orgId: null });
    expect(await fireCheckIn(row.id)).toBe('fired');
    const [post] = await postsFor(fx.thread.id);
    expect(post).toMatchObject({ kind: 'check_in', orgId: null });
    const [note] = await notificationsFor(fx.user.id);
    expect(note).toMatchObject({ dedupeKey: `wisp.check_in:${row.id}`, orgId: null });
  });

  runDb('a revoked grant cancels; so does a row whose grantor or thread no longer matches its grant', async () => {
    // revoked
    const a = await seed();
    const ra = await create(a, new Date());
    await withSystemDbAccessContext(() => db.update(wispGrants)
      .set({ status: 'revoked', revokedAt: new Date() } as never).where(eq(wispGrants.id, a.grantId)));
    expect(await fireCheckIn(ra.id)).toBe('cancelled');

    // grantor mismatch: the row names another user of the same partner
    const b = await seed();
    const stranger = await createUser({ partnerId: b.partner.id, email: `wisp-checkin-x-${randomUUID()}@wisp.test` });
    const rb = await create(b, new Date());
    await withSystemDbAccessContext(() => db.update(wispCheckIns).set({ userId: stranger.id }).where(eq(wispCheckIns.id, rb.id)));
    expect(await fireCheckIn(rb.id)).toBe('cancelled');

    // thread mismatch: the row's thread belongs to another grant of the same partner
    const c = await seed();
    const otherGrantor = await createUser({ partnerId: c.partner.id, email: `wisp-checkin-y-${randomUUID()}@wisp.test` });
    const otherGrant = await seedGrant(c.partner.id, otherGrantor.id, [c.org.id]);
    const otherThread = await getOrCreateThread(otherGrant);
    const rc = await create(c, new Date());
    await withSystemDbAccessContext(() => db.update(wispCheckIns).set({ threadId: otherThread.id }).where(eq(wispCheckIns.id, rc.id)));
    expect(await fireCheckIn(rc.id)).toBe('cancelled');

    // W04 (#11493): each cancel records why.
    for (const [fx, id, reason] of [[a, ra.id, 'grant_inactive'], [b, rb.id, 'grantor_changed'], [c, rc.id, 'thread_mismatch']] as const) {
      expect(await rowOf(id)).toMatchObject({ status: 'cancelled', cancelReason: reason, fireReason: null });
      expect(await postsFor(fx.thread.id)).toHaveLength(0);
    }
    expect(await postsFor(otherThread.id)).toHaveLength(0);
    expect(vi.mocked(notifyUser)).not.toHaveBeenCalled();
  });

  runDb('the title is "Check-in due: " + the first 80 code points of the instruction', async () => {
    const fx = await seed();
    const instruction = '🙂'.repeat(100);
    const row = await create(fx, new Date(), { instruction });
    await fireCheckIn(row.id);
    const [post] = await postsFor(fx.thread.id);
    expect(post!.title).toBe(`Check-in due: ${'🙂'.repeat(80)}`);
    expect(post!.body).toBe(instruction);
  });

  runDb('a second fireCheckIn is skipped and writes nothing', async () => {
    const fx = await seed();
    const row = await create(fx, new Date());
    expect(await fireCheckIn(row.id)).toBe('fired');
    expect(await fireCheckIn(row.id)).toBe('skipped');
    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(1);
    expect(await postsFor(fx.thread.id)).toHaveLength(1);
    expect(await notificationsFor(fx.user.id)).toHaveLength(1);
  });

  runDb('a retry after notifyUser succeeded but the flip did not (crash) writes no second post and still flips', async () => {
    const fx = await seed();
    const row = await create(fx, new Date());
    await notifyUser({
      userId: fx.user.id, category: 'wisp_nudge', kind: 'check_in', title: 'Check-in due: x', body: row.instruction,
      deepLink: `breeze://wisp/thread/${fx.thread.id}`, concernId: null, threadId: fx.thread.id, grantId: fx.grantId,
      checkIn: { id: row.id, orgId: row.orgId },
    });
    expect(await fireCheckIn(row.id)).toBe('fired');
    expect(await postsFor(fx.thread.id)).toHaveLength(1);
    expect(await notificationsFor(fx.user.id)).toHaveLength(1);
  });

  runDb('a notifyUser throw propagates (BullMQ retries) and leaves the row scheduled', async () => {
    const fx = await seed();
    const row = await create(fx, new Date());
    vi.mocked(notifyUser).mockRejectedValueOnce(new Error('db blip'));
    await expect(fireCheckIn(row.id)).rejects.toThrow('db blip');
    expect((await rowOf(row.id))!.status).toBe('scheduled');
    expect(await fireCheckIn(row.id)).toBe('fired');
  });

  runDb('a paused grant cancels instead of notifying; so does an expired one', async () => {
    for (const patch of [{ status: 'paused' as const, pausedReason: 'user_paused' as const, pausedAt: new Date() }, { expiresAt: new Date(Date.now() - 1000) }]) {
      const fx = await seed();
      const row = await create(fx, new Date());
      await withSystemDbAccessContext(() => db.update(wispGrants).set(patch as never).where(eq(wispGrants.id, fx.grantId)));
      expect(await fireCheckIn(row.id)).toBe('cancelled');
      const after = (await rowOf(row.id))!;
      expect(after.status).toBe('cancelled');
      expect(after.cancelledAt).not.toBeNull();
      expect(await postsFor(fx.thread.id)).toHaveLength(0);
    }
    expect(vi.mocked(notifyUser)).not.toHaveBeenCalled();
  });

  runDb('a missing row is skipped', async () => {
    expect(await fireCheckIn(randomUUID())).toBe('skipped');
  });

  runDb('Review Focus 5: a cancel that lands after notifyUser leaves the row cancelled and fireCheckIn returns skipped', async () => {
    const fx = await seed();
    const row = await create(fx, new Date());
    const real = vi.mocked(notifyUser).getMockImplementation()!;
    vi.mocked(notifyUser).mockImplementationOnce(async (p) => {
      const out = await real(p);
      expect(await cancelCheckIn(fx.grantId, row.id)).not.toBeNull();
      return out;
    });
    expect(await fireCheckIn(row.id)).toBe('skipped');
    const after = (await rowOf(row.id))!;
    expect(after.status).toBe('cancelled');
    expect(after.firedAt).toBeNull();
    // The post may already exist; nothing is ever prepended from a cancelled row.
    expect(await postsFor(fx.thread.id)).toHaveLength(1);
  });
});

describe('cancelCheckIn', () => {
  runDb('a scheduled row → cancelled and its job removed outside any DB context', async () => {
    const fx = await seed();
    const row = await create(fx, new Date());
    let ctxOpen: boolean | null = null;
    h.removeCheckInJob.mockImplementation(async () => { ctxOpen = Boolean(getCurrentDbAccessContext()); return true; });
    const out = await cancelCheckIn(fx.grantId, row.id);
    expect(out).toMatchObject({ id: row.id, status: 'cancelled' });
    expect(out!.cancelledAt).not.toBeNull();
    expect(h.removeCheckInJob).toHaveBeenCalledWith(row.id);
    expect(ctxOpen).toBe(false);
  });

  runDb('a fired row → cancelled; a consumed or already-cancelled row → null', async () => {
    const fx = await seed();
    const fired = await create(fx, new Date());
    await fireCheckIn(fired.id);
    expect(await cancelCheckIn(fx.grantId, fired.id)).toMatchObject({ status: 'cancelled' });
    expect(await cancelCheckIn(fx.grantId, fired.id)).toBeNull();

    const consumed = await create(fx, new Date());
    await fireCheckIn(consumed.id);
    await withSystemDbAccessContext(() => db.update(wispCheckIns)
      .set({ status: 'consumed', consumedAt: new Date() }).where(eq(wispCheckIns.id, consumed.id)));
    expect(await cancelCheckIn(fx.grantId, consumed.id)).toBeNull();
    expect((await rowOf(consumed.id))!.status).toBe('consumed');
  });

  runDb('under another grant → null and the row is untouched', async () => {
    const fx = await seed();
    const other = await seed();
    const row = await create(fx, new Date());
    expect(await cancelCheckIn(other.grantId, row.id)).toBeNull();
    expect((await rowOf(row.id))!.status).toBe('scheduled');
    expect(h.removeCheckInJob).not.toHaveBeenCalled();
  });

  runDb('a job-removal failure still returns the cancelled row', async () => {
    const fx = await seed();
    const row = await create(fx, new Date());
    h.removeCheckInJob.mockRejectedValue(new Error('redis down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cancelCheckIn(fx.grantId, row.id)).toMatchObject({ status: 'cancelled' });
    } finally {
      err.mockRestore();
    }
  });
});

describe('reconcileOrphanCheckIns', () => {
  runDb('re-enqueues a scheduled row 3 min overdue with no live job; leaves one with a live job and one 1 min overdue', async () => {
    const fx = await seed();
    const now = new Date();
    const orphan = await create(fx, now);
    const live = await create(fx, now);
    const fresh = await create(fx, now);
    const fired = await create(fx, now);
    await backdate(orphan.id, new Date(now.getTime() - 13 * MIN), new Date(now.getTime() - 3 * MIN));
    await backdate(live.id, new Date(now.getTime() - 13 * MIN), new Date(now.getTime() - 3 * MIN));
    await backdate(fresh.id, new Date(now.getTime() - 11 * MIN), new Date(now.getTime() - 1 * MIN));
    await backdate(fired.id, new Date(now.getTime() - 13 * MIN), new Date(now.getTime() - 3 * MIN));
    await fireCheckIn(fired.id);
    h.enqueueCheckIn.mockClear();
    h.enqueueCtx = [];
    h.isCheckInJobLive.mockImplementation(async (id: string) => id === live.id);

    const r = await reconcileOrphanCheckIns(now);
    const enqueued = h.enqueueCheckIn.mock.calls.map((c) => c[0]);
    // Other suites' rows may share the table; assert on this fixture's rows only.
    expect(enqueued).toContain(orphan.id);
    expect(enqueued).not.toContain(live.id);
    expect(enqueued).not.toContain(fresh.id);
    expect(enqueued).not.toContain(fired.id);
    expect(h.enqueueCheckIn).toHaveBeenCalledWith(orphan.id, 0);
    expect(r.refired).toBe(enqueued.length);
    expect(h.enqueueCtx.every((scope) => scope === null)).toBe(true);
  });

  runDb('a sweep that keeps failing (Redis down) stops after CHECK_IN_RECONCILE_MAX_FAILURES rows', async () => {
    const fx = await seed();
    const other = await seed();
    const now = new Date();
    for (const f of [fx, other]) {
      for (let i = 0; i < 4; i += 1) {
        const row = await create(f, now);
        await backdate(row.id, new Date(now.getTime() - 20 * MIN), new Date(now.getTime() - 10 * MIN));
      }
    }
    h.enqueueCheckIn.mockClear();
    h.isCheckInJobLive.mockRejectedValue(new Error('redis down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(reconcileOrphanCheckIns(now)).resolves.toEqual({ refired: 0 });
    } finally {
      err.mockRestore();
    }
    expect(h.isCheckInJobLive).toHaveBeenCalledTimes(CHECK_IN_RECONCILE_MAX_FAILURES);
    expect(h.enqueueCheckIn).not.toHaveBeenCalled();
  });

  runDb('a per-row failure is reported and the sweep carries on', async () => {
    const fx = await seed();
    const now = new Date();
    const a = await create(fx, now);
    const b = await create(fx, now);
    await backdate(a.id, new Date(now.getTime() - 20 * MIN), new Date(now.getTime() - 10 * MIN));
    await backdate(b.id, new Date(now.getTime() - 19 * MIN), new Date(now.getTime() - 9 * MIN));
    h.enqueueCheckIn.mockClear();
    h.isCheckInJobLive.mockImplementation(async (id: string) => {
      if (id === a.id) throw new Error('redis blip');
      return false;
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await reconcileOrphanCheckIns(now);
    } finally {
      err.mockRestore();
    }
    const enqueued = h.enqueueCheckIn.mock.calls.map((c) => c[0]);
    expect(enqueued).not.toContain(a.id);
    expect(enqueued).toContain(b.id);
  });
});

describe('next-turn consumption (W04 #10995, services/wisp/checkInTurn.ts)', () => {
  /** The grantor's own request context, as POST /ai/sessions/:id/messages opens it. */
  const grantorCtx = (fx: Fx): DbAccessContext => ({
    scope: 'organization', orgId: fx.org.id, accessibleOrgIds: [fx.org.id], accessiblePartnerIds: [],
    userId: fx.user.id, currentPartnerId: fx.partner.id,
  });

  /** Create and fire `n` check-ins, fired one minute apart (oldest first), staying under the scheduled cap. */
  async function fired(fx: Fx, n: number, base: Date): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = await create(fx, new Date(), { instruction: `check ${i}` });
      expect(await fireCheckIn(row.id, new Date(base.getTime() + i * MIN))).toBe('fired');
      ids.push(row.id);
    }
    return ids;
  }

  runDb('the grantor reads only the grant\'s fired rows, oldest fired first, at most 5; consuming leaves the rest for the next turn', async () => {
    const fx = await seed();
    const base = new Date(Date.now() - 60 * MIN);
    // Fired out of order: the 6th is older than all the others.
    const ids = await fired(fx, 5, base);
    const oldest = (await fired(fx, 1, new Date(base.getTime() - 10 * MIN)))[0]!;
    const stillScheduled = await create(fx, new Date());
    const cancelled = (await fired(fx, 1, base))[0]!;
    await cancelCheckIn(fx.grantId, cancelled);
    // Another grant of the same partner (another grantor) has its own fired row.
    const other = await seed();
    await fired(other, 1, base);

    const { loadFiredCheckIns, markCheckInsConsumed } = await import('../../services/wisp/checkInTurn');
    const first = await withDbAccessContext(grantorCtx(fx), () => loadFiredCheckIns(fx.grantId, fx.user.id));
    expect(first.map((r) => r.id)).toEqual([oldest, ...ids.slice(0, 4)]);
    expect(first[0]!.instruction).toBe('check 0');
    expect(first[0]!.firedAt).toBeInstanceOf(Date);

    const consumedAt = new Date();
    expect(await withDbAccessContext(grantorCtx(fx), () =>
      markCheckInsConsumed({ grantId: fx.grantId, ids: first.map((r) => r.id) }, consumedAt))).toBe(5);
    for (const row of first) {
      const after = (await rowOf(row.id))!;
      expect(after.status).toBe('consumed');
      expect(after.consumedAt!.getTime()).toBe(consumedAt.getTime());
    }

    const second = await withDbAccessContext(grantorCtx(fx), () => loadFiredCheckIns(fx.grantId, fx.user.id));
    expect(second.map((r) => r.id)).toEqual([ids[4]]);
    expect((await rowOf(stillScheduled.id))!.status).toBe('scheduled');
    expect((await rowOf(cancelled))!.status).toBe('cancelled');
  });

  runDb('a row cancelled between the read and the consume stays cancelled', async () => {
    const fx = await seed();
    const [a, b] = await fired(fx, 2, new Date(Date.now() - 10 * MIN));
    const { loadFiredCheckIns, markCheckInsConsumed } = await import('../../services/wisp/checkInTurn');
    const read = await withDbAccessContext(grantorCtx(fx), () => loadFiredCheckIns(fx.grantId, fx.user.id));
    expect(read.map((r) => r.id)).toEqual([a, b]);
    await cancelCheckIn(fx.grantId, b!);
    expect(await withDbAccessContext(grantorCtx(fx), () =>
      markCheckInsConsumed({ grantId: fx.grantId, ids: [a!, b!] }))).toBe(1);
    expect((await rowOf(a!))!.status).toBe('consumed');
    expect((await rowOf(b!))!.status).toBe('cancelled');
  });

  runDb('another grant\'s id, another user, or a caller outside the row\'s org reads and consumes nothing', async () => {
    const fx = await seed();
    const [id] = await fired(fx, 1, new Date(Date.now() - 10 * MIN));
    const other = await seed();
    const { loadFiredCheckIns, markCheckInsConsumed } = await import('../../services/wisp/checkInTurn');

    // Keyed on the grant: the row's id under another grant flips nothing.
    expect(await withDbAccessContext(grantorCtx(other), () =>
      markCheckInsConsumed({ grantId: other.grantId, ids: [id!] }))).toBe(0);
    // Keyed on the grantor: the right grant with another user id reads nothing.
    expect(await withDbAccessContext(grantorCtx(fx), () => loadFiredCheckIns(fx.grantId, other.user.id))).toEqual([]);
    // RLS: a caller scoped to another org sees neither the row nor can it flip it.
    expect(await withDbAccessContext(grantorCtx(other), () => loadFiredCheckIns(fx.grantId, fx.user.id))).toEqual([]);
    expect(await withDbAccessContext(grantorCtx(other), () =>
      markCheckInsConsumed({ grantId: fx.grantId, ids: [id!] }))).toBe(0);

    expect((await rowOf(id!))!.status).toBe('fired');
  });
});
