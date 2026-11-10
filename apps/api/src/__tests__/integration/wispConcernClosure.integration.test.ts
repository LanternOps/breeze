/**
 * #11427 — Wisp concerns close, against real Postgres (forced RLS, breeze_app):
 *   - `resolveConcernsForAlert` resolves the live concerns of the ALERT'S ORG
 *     whose evidence names the alert (alertId or rebootAlertId), outcome
 *     `alert_resolved`; another org's concern naming the same alert id, and an
 *     unrelated concern, stay open; a second call resolves nothing;
 *   - resolving a concern that was nudged writes exactly ONE `nudge_resolved`
 *     post + notification on the nudged thread (the widened CHECK admits the
 *     kind); a second resolve, or a repeated follow-up, writes none; a concern
 *     that was never nudged gets no follow-up.
 *
 * Prerequisites: pnpm test-stack up
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { userNotifications, wispConcerns, wispGrantRevisions, wispGrants, wispThreadPosts } from '../../db/schema';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';

vi.mock('../../services/expoPush', async (orig) => ({
  ...(await orig<typeof import('../../services/expoPush')>()),
  dispatchPushToTokens: vi.fn(async () => ({ tokensFound: 0, dispatched: 0, errors: 0 })),
}));
vi.mock('../../services/notificationThrottle', () => ({
  checkNotificationThrottle: vi.fn(async () => ({ allowed: true, currentCount: 1, windowExpiresAt: 0 })),
}));

import { dismissConcern, resolveConcern, resolveConcernsForAlert, upsertConcern } from '../../services/wisp/concerns';
import { notifyUser } from '../../services/wisp/notifyUser';
import { notifyNudgeResolved } from '../../services/wisp/nudgeResolved';
import { mobileDeepLink } from '../../services/wisp/nudgeLinks';
import { getOrCreateThread } from '../../services/wisp/threads';

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); });

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[]) {
  return withSystemDbAccessContext(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: null, grantorUserId, status: 'active', expiresAt: new Date(Date.now() + 30 * 86_400_000),
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

async function seed(o: { grantorHasStanding?: boolean } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-closure-${randomUUID()}@wisp.test` });
  if (o.grantorHasStanding !== false) {
    // The grant's LIVE ceiling needs the grantor to still hold ai_sessions:use in the partner.
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: 'ai_sessions', action: 'use' }]);
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
  }
  const grantId = await seedGrant(partner.id, user.id, [org.id, otherOrg.id]);
  const thread = await getOrCreateThread(grantId);
  /** Another person with their own grant + thread over the same orgs. */
  const addGrantor = async () => {
    const other = await createUser({ partnerId: partner.id, email: `wisp-closure-${randomUUID()}@wisp.test` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: 'ai_sessions', action: 'use' }]);
    await assignUserToPartner(other.id, partner.id, role.id, 'all');
    const otherGrantId = await seedGrant(partner.id, other.id, [org.id, otherOrg.id]);
    return { user: other, grantId: otherGrantId, thread: await getOrCreateThread(otherGrantId) };
  };
  const concern = async (orgId: string, evidence: Record<string, unknown> = {}, summary = 'SAM23 has a pending reboot') =>
    (await upsertConcern({
      partnerId: partner.id, orgId, subject: { kind: 'device', id: randomUUID() },
      summary, severity: 'medium', evidence, raisedByGrantId: grantId,
    })).id;
  return { partner, org, otherOrg, user, grantId, thread, concern, addGrantor };
}

type Recipient = { user: { id: string }; grantId: string; thread: { id: string } };

/** The nudge Wisp sent this recipient about concern `c`. */
async function nudge(r: Recipient, c: string) {
  const res = await notifyUser({
    userId: r.user.id, category: 'wisp_nudge', kind: 'concern', title: 'Wisp: SAM23 has a pending reboot',
    body: 'Schedule a restart of SAM23', deepLink: mobileDeepLink(r.thread.id, c), concernId: c,
    threadId: r.thread.id, grantId: r.grantId,
  });
  expect(res.inApp).toBe(true);
}

const concernRow = (id: string) => withSystemDbAccessContext(async () =>
  (await db.select().from(wispConcerns).where(eq(wispConcerns.id, id)))[0]!);
const postsOf = (threadId: string, kind: 'nudge' | 'nudge_resolved') => withSystemDbAccessContext(() =>
  db.select().from(wispThreadPosts).where(and(eq(wispThreadPosts.threadId, threadId), eq(wispThreadPosts.kind, kind))));
const notificationsKeyed = (userId: string, dedupeKey: string) => withSystemDbAccessContext(() =>
  db.select().from(userNotifications).where(and(eq(userNotifications.userId, userId), eq(userNotifications.dedupeKey, dedupeKey))));

describe('resolveConcernsForAlert — real DB (#11427)', () => {
  runDb("resolves only the alert's org's live concerns that name it, and is idempotent", async () => {
    const fx = await seed();
    const alertId = randomUUID();
    const byAlertId = await fx.concern(fx.org.id, { alertId });
    const byRebootAlertId = await fx.concern(fx.org.id, { rebootAlertId: alertId });
    const unrelated = await fx.concern(fx.org.id, { alertId: randomUUID() });
    const otherOrgSameAlert = await fx.concern(fx.otherOrg.id, { alertId });

    await expect(resolveConcernsForAlert(alertId, fx.org.id)).resolves.toEqual({ resolved: 2 });

    expect(await concernRow(byAlertId)).toMatchObject({ status: 'resolved', outcome: 'alert_resolved', resolvedByUserId: null });
    expect(await concernRow(byRebootAlertId)).toMatchObject({ status: 'resolved', outcome: 'alert_resolved' });
    expect((await concernRow(unrelated)).status).toBe('open');
    expect((await concernRow(otherOrgSameAlert)).status).toBe('open');

    await expect(resolveConcernsForAlert(alertId, fx.org.id)).resolves.toEqual({ resolved: 0 });
  });
});

describe('nudge_resolved follow-up — real DB (#11427)', () => {
  runDb('resolving a nudged concern writes exactly one nudge_resolved post + notification; repeats write none', async () => {
    const fx = await seed();
    const c = await fx.concern(fx.org.id);
    // The nudge Wisp sent ("Schedule a restart of SAM23").
    const nudged = await notifyUser({
      userId: fx.user.id, category: 'wisp_nudge', kind: 'concern', title: 'Wisp: SAM23 has a pending reboot',
      body: 'Schedule a restart of SAM23', deepLink: mobileDeepLink(fx.thread.id, c), concernId: c,
      threadId: fx.thread.id, grantId: fx.grantId,
    });
    expect(nudged.inApp).toBe(true);
    expect(await postsOf(fx.thread.id, 'nudge')).toHaveLength(1);

    await expect(resolveConcern(c, {}, 'The pending-reboot alert resolved at 12:10Z, so the device restarted.'))
      .resolves.toEqual({ resolved: true, remembered: false });

    const followUps = await postsOf(fx.thread.id, 'nudge_resolved');
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({
      concernId: c, orgId: fx.org.id, grantId: fx.grantId, partnerId: fx.partner.id,
      dedupeKey: `wisp.nudge_resolved:${c}`, link: `/ai/wisp/thread/${fx.thread.id}#concern=${c}`,
      title: 'Resolved: SAM23 has a pending reboot',
      body: 'SAM23 has a pending reboot — the pending-reboot alert resolved at 12:10Z, so the device restarted; no action needed.',
    });
    const notes = await notificationsKeyed(fx.user.id, `wisp.nudge_resolved:${c}`);
    expect(notes).toHaveLength(1);
    expect(followUps[0]!.notificationId).toBe(notes[0]!.id);

    // A second resolve is a no-op, and a repeated follow-up hits the dedupe key.
    await expect(resolveConcern(c, {}, 'again')).resolves.toEqual({ resolved: false, remembered: false });
    await expect(notifyNudgeResolved(c)).resolves.toEqual({ recipients: 1, sent: 0 });
    expect(await postsOf(fx.thread.id, 'nudge_resolved')).toHaveLength(1);
    expect(await notificationsKeyed(fx.user.id, `wisp.nudge_resolved:${c}`)).toHaveLength(1);
  });

  runDb('an alert resolve closes a nudged concern and follows up once, with the alert outcome in words', async () => {
    const fx = await seed();
    const alertId = randomUUID();
    const c = await fx.concern(fx.org.id, { rebootAlertId: alertId });
    await notifyUser({
      userId: fx.user.id, category: 'wisp_nudge', kind: 'concern', title: 'Wisp: SAM23 has a pending reboot',
      body: 'Schedule a restart of SAM23', deepLink: mobileDeepLink(fx.thread.id, c), concernId: c,
      threadId: fx.thread.id, grantId: fx.grantId,
    });
    await expect(resolveConcernsForAlert(alertId, fx.org.id)).resolves.toEqual({ resolved: 1 });
    const followUps = await postsOf(fx.thread.id, 'nudge_resolved');
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.body).toBe('SAM23 has a pending reboot — the alert behind it resolved; no action needed.');
  });

  runDb("a grantor who lost standing since the nudge (no live ceiling) gets no follow-up about the org", async () => {
    const fx = await seed({ grantorHasStanding: false });
    const c = await fx.concern(fx.org.id);
    await notifyUser({
      userId: fx.user.id, category: 'wisp_nudge', kind: 'concern', title: 'Wisp: SAM23 has a pending reboot',
      body: 'Schedule a restart of SAM23', deepLink: mobileDeepLink(fx.thread.id, c), concernId: c,
      threadId: fx.thread.id, grantId: fx.grantId,
    });
    await expect(resolveConcern(c, {}, 'fixed')).resolves.toEqual({ resolved: true, remembered: false });
    expect(await postsOf(fx.thread.id, 'nudge_resolved')).toHaveLength(0);
  });

  runDb('two people nudged, two concurrent resolves: exactly one follow-up post + notification each', async () => {
    const fx = await seed();
    const b = await fx.addGrantor();
    const c = await fx.concern(fx.org.id);
    await nudge(fx, c);
    await nudge(b, c);

    const results = await Promise.all([
      resolveConcern(c, {}, 'The device restarted on its own.'),
      resolveConcernsForAlert(randomUUID(), fx.org.id).then(() => resolveConcern(c, {}, 'alert_resolved')),
    ]);
    expect(results.filter((r) => r.resolved)).toHaveLength(1);

    for (const r of [fx, b]) {
      expect(await postsOf(r.thread.id, 'nudge_resolved')).toHaveLength(1);
      expect(await notificationsKeyed(r.user.id, `wisp.nudge_resolved:${c}`)).toHaveLength(1);
    }
  });

  runDb('skips the person who resolved it themselves and a recipient who dismissed it; tells the rest', async () => {
    const fx = await seed();
    const b = await fx.addGrantor();
    const d = await fx.addGrantor();
    const c = await fx.concern(fx.org.id);
    for (const r of [fx, b, d]) await nudge(r, c);
    // B says "not interested"; the concern stays live while others have not.
    await dismissConcern(c, { grantId: b.grantId, userId: b.user.id });
    expect((await concernRow(c)).status).toBe('open');

    await expect(resolveConcern(c, { userId: fx.user.id }, 'Restarted it myself.')).resolves.toEqual({ resolved: true, remembered: false });

    expect(await postsOf(fx.thread.id, 'nudge_resolved')).toHaveLength(0);
    expect(await postsOf(b.thread.id, 'nudge_resolved')).toHaveLength(0);
    const told = await postsOf(d.thread.id, 'nudge_resolved');
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toBe('SAM23 has a pending reboot — restarted it myself; no action needed.');
  });

  runDb('a concern that was never nudged gets no follow-up', async () => {
    const fx = await seed();
    const c = await fx.concern(fx.org.id);
    await expect(resolveConcern(c, {}, 'fixed')).resolves.toEqual({ resolved: true, remembered: false });
    expect(await postsOf(fx.thread.id, 'nudge_resolved')).toHaveLength(0);
    expect(await notificationsKeyed(fx.user.id, `wisp.nudge_resolved:${c}`)).toHaveLength(0);
  });
});
