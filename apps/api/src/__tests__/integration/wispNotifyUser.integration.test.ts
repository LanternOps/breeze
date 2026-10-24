/**
 * Wisp W06a Task 12 — notifyUser against real Postgres (forced RLS, breeze_app):
 *   - from ANOTHER user's request context it still writes the grantor's
 *     in-app row (the runOutsideDbContext(withSystemDbAccessContext) wrap —
 *     without it the cross-user insert is 42501);
 *   - Review Focus 2: a second call inside one backoff window is a no-op, and a
 *     delivered-but-uncounted nudge is counted on the retry (crash recovery);
 *   - quiet hours / urgent-capable break-through and prefs on real rows;
 * plus real-SQL smoke for the W06 readers that unit tests only mock:
 * listActivity (keyset), selectDigestCandidates and the morning-brief sweep.
 *
 * Prerequisites: pnpm test-stack up
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  mobileDevices,
  userNotifications,
  wispConcernRecipients,
  wispGrantRevisions,
  wispGrants,
  wispNudgePreferences,
  wispPartnerNudgeSettings,
} from '../../db/schema';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import { createOrganization, createPartner, createUser } from './db-utils';

const h = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../../services/expoPush', async (orig) => ({
  ...(await orig<typeof import('../../services/expoPush')>()),
  dispatchPushToTokens: h.dispatch,
}));
vi.mock('../../services/notificationThrottle', () => ({
  checkNotificationThrottle: vi.fn(async () => ({ allowed: true, currentCount: 1, windowExpiresAt: 0 })),
}));

import { recordNudge, upsertConcern } from '../../services/wisp/concerns';
import { listActivity } from '../../services/wisp/activity';
import { runMorningBriefs } from '../../services/wisp/brief';
import { selectDigestCandidates } from '../../services/wisp/nudgeDigest';
import { notifyUser, type NudgePayload } from '../../services/wisp/notifyUser';
import { mobileDeepLink } from '../../services/wisp/nudgeLinks';
import { getOrCreateThread } from '../../services/wisp/threads';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const QUIET = { start: '00:00', end: '23:59', enabled: true };

beforeEach(() => {
  h.dispatch.mockReset();
  h.dispatch.mockImplementation(async (tokens: unknown[]) => ({ tokensFound: tokens.length, dispatched: tokens.length, errors: 0 }));
});
afterEach(() => { vi.unstubAllEnvs(); });

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[], o: { status?: 'active' | 'paused'; pausedReason?: string } = {}) {
  return withSystemDbAccessContext(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: null, grantorUserId, status: o.status ?? 'active',
      ...(o.pausedReason ? { pausedReason: o.pausedReason as never, pausedAt: new Date() } : {}),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
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
  const userA = await createUser({ partnerId: partner.id, email: `wisp-notify-a-${randomUUID()}@wisp.test` });
  const userB = await createUser({ partnerId: partner.id, email: `wisp-notify-b-${randomUUID()}@wisp.test` });
  const grantId = await seedGrant(partner.id, userA.id, [org.id]);
  const thread = await getOrCreateThread(grantId);
  const ctxB: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: userB.id,
  };
  const concern = async (severity: 'info' | 'low' | 'medium' | 'high' = 'medium') => (await upsertConcern({
    partnerId: partner.id, orgId: org.id, subject: { kind: 'ticket', id: randomUUID() },
    summary: `Ticket waiting ${randomUUID().slice(0, 4)}`, severity, evidence: {}, raisedByGrantId: grantId,
  })).id;
  const device = (quietHours: unknown = null) => withSystemDbAccessContext(() => db.insert(mobileDevices).values({
    userId: userA.id, deviceId: `dev-${randomUUID()}`, platform: 'ios', apnsToken: `apns-${randomUUID()}`, quietHours,
  }));
  const payload = (concernId: string | null, o: Partial<NudgePayload> = {}): NudgePayload => ({
    userId: userA.id, category: 'wisp_nudge', kind: concernId ? 'concern' : 'digest', title: 'Wisp: ticket stale', body: 'Call the customer',
    deepLink: mobileDeepLink(thread.id, concernId), concernId, threadId: thread.id, grantId, ...o,
  });
  const ceiling: GrantCeiling = {
    grantId, revisionId: randomUUID(), partnerId: partner.id, grantorUserId: userA.id, scopeOrgId: null, partnerWide: false,
    orgIds: new Set([org.id]), siteIds: null, permissionKeys: new Set(['ai_sessions:use']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active',
  } as GrantCeiling;
  return { partner, org, userA, userB, grantId, thread, ctxB, concern, device, payload, ceiling };
}

const notificationsFor = (userId: string) => withSystemDbAccessContext(() =>
  db.select().from(userNotifications).where(eq(userNotifications.userId, userId)));
const recipient = (concernId: string, grantId: string) => withSystemDbAccessContext(async () => (await db.select()
  .from(wispConcernRecipients)
  .where(and(eq(wispConcernRecipients.concernId, concernId), eq(wispConcernRecipients.grantId, grantId))))[0]);

describe('notifyUser — real DB', () => {
  runDb('from another user\'s request context it writes the grantor\'s in-app row and counts the nudge', async () => {
    const fx = await seed();
    await fx.device();
    const c = await fx.concern();
    const out = await withDbAccessContext(fx.ctxB, () => notifyUser(fx.payload(c, { approvalIntentId: null })));
    expect(out).toEqual({ inApp: true, pushed: 1, suppressed: null });
    const rows = await notificationsFor(fx.userA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'ai', link: `/ai/wisp/thread/${fx.thread.id}#concern=${c}`, orgId: fx.org.id });
    expect(rows[0]!.metadata).toMatchObject({ wispThreadId: fx.thread.id, concernId: c, grantId: fx.grantId, deepLink: fx.payload(c).deepLink });
    expect((await recipient(c, fx.grantId))!.nudgeCount).toBe(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  runDb('Review Focus 2: a second call in the same window is backoff; an uncounted delivery is counted on retry', async () => {
    const fx = await seed();
    const c = await fx.concern();
    expect((await notifyUser(fx.payload(c))).inApp).toBe(true);
    await expect(notifyUser(fx.payload(c))).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'backoff' });
    expect(await notificationsFor(fx.userA.id)).toHaveLength(1);

    // Simulate an attempt that delivered and died before counting: put the
    // recipient back to its pre-delivery state; the retry hits the dedupe key.
    await withSystemDbAccessContext(() => db.update(wispConcernRecipients)
      .set({ nudgeCount: 0, nextEligibleNudgeAt: null, lastNudgedAt: null })
      .where(and(eq(wispConcernRecipients.concernId, c), eq(wispConcernRecipients.grantId, fx.grantId))));
    await expect(notifyUser(fx.payload(c))).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'backoff' });
    expect(await notificationsFor(fx.userA.id)).toHaveLength(1);
    const r = await recipient(c, fx.grantId);
    expect(r!.nudgeCount).toBe(1);
    expect(r!.nextEligibleNudgeAt!.getTime()).toBeGreaterThan(Date.now());
  });

  runDb('quiet hours on real rows; urgent-capable + urgent_only breaks through', async () => {
    const fx = await seed();
    await fx.device(QUIET);
    const first = await fx.concern('high');
    await expect(notifyUser(fx.payload(first))).resolves.toEqual({ inApp: true, pushed: 0, suppressed: 'quiet_hours' });
    expect(h.dispatch).not.toHaveBeenCalled();

    await withSystemDbAccessContext(async () => {
      await db.insert(wispPartnerNudgeSettings).values({ partnerId: fx.partner.id, urgentCapableSeverities: ['high'] });
      await db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, quietOverride: 'urgent_only' });
    });
    const second = await fx.concern('high');
    await expect(notifyUser(fx.payload(second))).resolves.toEqual({ inApp: true, pushed: 1, suppressed: null });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  runDb('both channels off → prefs, no row, no push', async () => {
    const fx = await seed();
    await fx.device();
    await withSystemDbAccessContext(() => db.insert(wispNudgePreferences)
      .values({ userId: fx.userA.id, partnerId: fx.partner.id, channels: { inApp: false, push: false } }));
    const c = await fx.concern();
    await expect(notifyUser(fx.payload(c))).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'prefs' });
    expect(await notificationsFor(fx.userA.id)).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  runDb('a payload whose grant is not the thread\'s grant throws and writes nothing', async () => {
    const fx = await seed();
    const c = await fx.concern();
    await expect(notifyUser(fx.payload(c, { grantId: randomUUID() }))).rejects.toThrow(/another grant/);
    expect(await notificationsFor(fx.userA.id)).toHaveLength(0);
  });
});

describe('W06 readers — real SQL', () => {
  runDb('listActivity returns the nudge and the concern under the ceiling and pages with the keyset cursor', async () => {
    const fx = await seed();
    const c = await fx.concern();
    await notifyUser(fx.payload(c));
    const all = await listActivity(fx.ceiling, { limit: 50, threadId: fx.thread.id });
    const kinds = all.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(expect.arrayContaining(['concern', 'nudge']));
    const page1 = await listActivity(fx.ceiling, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listActivity(fx.ceiling, { limit: 50, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).not.toContain(page1.items[0]!.id);
    expect(page1.items.length + page2.items.length).toBe(all.items.length);

    // Another org outside the ceiling reads nothing.
    const outside = await listActivity({ ...fx.ceiling, orgIds: new Set([randomUUID()]) } as GrantCeiling, { limit: 50 });
    expect(outside.items.filter((i) => i.kind === 'concern')).toHaveLength(0);
  });

  runDb('selectDigestCandidates finds a grant with two digest-only concerns', async () => {
    const fx = await seed();
    const [c1, c2] = [await fx.concern(), await fx.concern()];
    for (const c of [c1, c2]) {
      await recordNudge(c, fx.grantId, new Date(Date.now() - 3 * 3_600_000));
      await recordNudge(c, fx.grantId, new Date(Date.now() - 2 * 3_600_000));
    }
    const candidates = (await selectDigestCandidates(new Date())).filter((x) => x.grantId === fx.grantId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.threadId).toBe(fx.thread.id);
    expect(candidates[0]!.concerns.map((x) => x.id).sort()).toEqual([c1, c2].sort());
  });

  runDb('the morning-brief sweep sends a system-paused grant its one-line brief, keyed on the local date', async () => {
    vi.stubEnv('IS_HOSTED', 'true');
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, email: `wisp-brief-${randomUUID()}@wisp.test` });
    const grantId = await seedGrant(partner.id, user.id, [org.id], { status: 'paused', pausedReason: 'budget_exhausted' });
    const now = new Date();
    now.setUTCHours(23, 0, 0, 0); // after the default 08:00 UTC brief time
    await runMorningBriefs(now);
    const thread = await getOrCreateThread(grantId);
    const rows = await notificationsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Wisp is paused', dedupeKey: `wisp.brief:${thread.id}:${now.toISOString().slice(0, 10)}` });
    // A second sweep the same day sends nothing more.
    await runMorningBriefs(new Date(now.getTime() + 15 * 60_000));
    expect(await notificationsFor(user.id)).toHaveLength(1);
  });
});
