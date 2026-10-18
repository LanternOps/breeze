/**
 * Connection health W3 (#8847) against real Postgres + RLS as breeze_app:
 *  - user_email_optouts / connection_health_digest_deliveries are Shape 6:
 *    a user sees and writes only their own rows; system scope sees all; a peer
 *    cannot read, update or forge; user delete cascades both.
 *  - the opt-out resolver is idempotent and a no-op for a deleted user;
 *  - the ledger claim is at most once per (user, local date);
 *  - runDigest end to end: one email, ledger `sent`, a second run sends
 *    nothing, an opted-out user gets nothing, and a recipient who loses the
 *    view permission drops out at send time.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  connectionHealthDigestDeliveries as ledger,
  connectionHealthIncidents,
  partnerUsers,
  userEmailOptouts,
  users,
} from '../../db/schema';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock('../../services/email', async (orig) => ({
  ...(await orig<typeof import('../../services/email')>()),
  getEmailService: () => ({ sendEmail }),
}));

import { clearEmailOptOut, isOptedOut, setEmailOptOut } from '../../services/emailOptouts';
import { claimDelivery, expireStaleClaims, markDeliverySent } from '../../services/connectionHealth/digestStore';
import { runDigest } from '../../services/connectionHealth/digest';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const TOPIC = 'connection_health_digest' as const;
// Friday 2026-10-16, 08:09 UTC.
const NOW = new Date('2026-10-16T08:09:00Z');
let seq = 0;
const email = () => `digest-${Date.now()}-${++seq}@example.com`;

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

async function seedPair() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const userA = await createUser({ partnerId: partner.id, email: email() });
  const userB = await createUser({ partnerId: partner.id, email: email() });
  const ctx = (userId: string): DbAccessContext => ({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId,
  });
  return { partner, org, userA, userB, ctxA: ctx(userA.id), ctxB: ctx(userB.id) };
}

describe('user_email_optouts + digest ledger RLS (Shape 6)', () => {
  runDb('a user reads and writes only their own opt-out', async () => {
    const fx = await seedPair();
    await withDbAccessContext(fx.ctxA, () => setEmailOptOut(fx.userA.id, TOPIC, 'settings'));
    expect(await withDbAccessContext(fx.ctxA, () => isOptedOut(fx.userA.id, TOPIC))).toBe(true);
    // The peer cannot see it…
    expect(await withDbAccessContext(fx.ctxB, () => isOptedOut(fx.userA.id, TOPIC))).toBe(false);
    // …cannot delete it…
    await withDbAccessContext(fx.ctxB, () => clearEmailOptOut(fx.userA.id, TOPIC));
    expect(await asSystem(() => isOptedOut(fx.userA.id, TOPIC))).toBe(true);
    // …and cannot forge one for A (WITH CHECK → 42501).
    await expectSqlState(
      () => withDbAccessContext(fx.ctxB, () => db.insert(userEmailOptouts).values({ userId: fx.userA.id, topic: TOPIC, source: 'settings' })),
      '42501',
    );
    expect(await asSystem(() => isOptedOut(fx.userB.id, TOPIC))).toBe(false);
  });

  runDb('a user cannot read or forge another user\'s ledger rows; system sees all', async () => {
    const fx = await seedPair();
    await asSystem(() => db.insert(ledger).values({ userId: fx.userA.id, digestDate: '2026-10-16', status: 'skipped_empty', claimedAt: NOW }));
    const peer = await withDbAccessContext(fx.ctxB, () => db.select().from(ledger).where(eq(ledger.userId, fx.userA.id)));
    expect(peer).toHaveLength(0);
    const own = await withDbAccessContext(fx.ctxA, () => db.select().from(ledger).where(eq(ledger.userId, fx.userA.id)));
    expect(own).toHaveLength(1);
    await expectSqlState(
      () => withDbAccessContext(fx.ctxB, () => db.insert(ledger).values({ userId: fx.userA.id, digestDate: '2026-10-17', status: 'skipped_empty', claimedAt: NOW })),
      '42501',
    );
  });

  runDb('opt-out writes are idempotent; a deleted user is a no-op; clear re-subscribes', async () => {
    const fx = await seedPair();
    expect(await asSystem(() => setEmailOptOut(fx.userA.id, TOPIC, 'one_click'))).toEqual({ userExists: true });
    expect(await asSystem(() => setEmailOptOut(fx.userA.id, TOPIC, 'one_click'))).toEqual({ userExists: true });
    const rows = await asSystem(() => db.select().from(userEmailOptouts).where(eq(userEmailOptouts.userId, fx.userA.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('one_click');
    expect(await asSystem(() => setEmailOptOut('00000000-0000-4000-8000-0000000000ff', TOPIC, 'one_click'))).toEqual({ userExists: false });
    await asSystem(() => clearEmailOptOut(fx.userA.id, TOPIC));
    expect(await asSystem(() => isOptedOut(fx.userA.id, TOPIC))).toBe(false);
  });

  runDb('the CHECKs reject an unknown topic and a sent row without sent_at', async () => {
    const fx = await seedPair();
    await expectSqlState(
      () => asSystem(() => db.insert(userEmailOptouts).values({ userId: fx.userA.id, topic: 'marketing', source: 'settings' })),
      '23514',
    );
    await expectSqlState(
      () => asSystem(() => db.insert(ledger).values({ userId: fx.userA.id, digestDate: '2026-10-16', status: 'sent', claimedAt: NOW })),
      '23514',
    );
  });

  runDb('the claim is at most once per (user, date); stale claims expire to failed', async () => {
    const fx = await seedPair();
    const first = await asSystem(() => claimDelivery(fx.userA.id, '2026-10-16', [], NOW));
    expect(first).toBeTruthy();
    expect(await asSystem(() => claimDelivery(fx.userA.id, '2026-10-16', [], NOW))).toBeNull();
    expect(await asSystem(() => expireStaleClaims(new Date(NOW.getTime() + 3600_001)))).toBeGreaterThanOrEqual(1);
    const [row] = await asSystem(() => db.select().from(ledger).where(eq(ledger.id, first!)));
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('claim expired');
    // A failed row is never flipped to sent by a late marker.
    await asSystem(() => markDeliverySent(first!, NOW));
    const [after] = await asSystem(() => db.select().from(ledger).where(eq(ledger.id, first!)));
    expect(after!.status).toBe('failed');
  });

  runDb('deleting the user cascades both tables', async () => {
    const fx = await seedPair();
    await asSystem(() => setEmailOptOut(fx.userB.id, TOPIC, 'settings'));
    await asSystem(() => claimDelivery(fx.userB.id, '2026-10-16', [], NOW));
    await asSystem(() => db.delete(users).where(eq(users.id, fx.userB.id)));
    expect(await asSystem(() => db.select().from(userEmailOptouts).where(eq(userEmailOptouts.userId, fx.userB.id)))).toHaveLength(0);
    expect(await asSystem(() => db.select().from(ledger).where(eq(ledger.userId, fx.userB.id)))).toHaveLength(0);
  });
});

describe('runDigest end to end (real DB, fake email provider)', () => {
  let P: string;
  let admin: { id: string; email: string };
  let writerOnly: { id: string; email: string };
  let fullRoleId: string;
  let incidentId: string;

  beforeEach(async () => {
    sendEmail.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('APP_ENCRYPTION_KEY', 'integration-digest-secret-0123456789');
    vi.stubEnv('DASHBOARD_URL', 'https://app.example.test');
    const partner = await createPartner();
    P = partner.id;
    // Isolate from other partners left by earlier tests in this file.
    await asSystem(() => db.delete(connectionHealthIncidents));

    const fullRole = await createRole({ scope: 'partner', partnerId: P, name: 'digest-full' });
    fullRoleId = fullRole.id;
    await grantRolePermissions(fullRole.id, [
      { resource: 'organizations', action: 'read' },
      { resource: 'organizations', action: 'write' },
    ]);
    const writeOnlyRole = await createRole({ scope: 'partner', partnerId: P, name: 'digest-write-only' });
    await grantRolePermissions(writeOnlyRole.id, [{ resource: 'organizations', action: 'write' }]);

    admin = await createUser({ partnerId: P, email: email() });
    await assignUserToPartner(admin.id, P, fullRole.id, 'all');
    writerOnly = await createUser({ partnerId: P, email: email() });
    await assignUserToPartner(writerOnly.id, P, writeOnlyRole.id, 'all');

    const [inc] = await asSystem(() => db.insert(connectionHealthIncidents).values({
      partnerId: P,
      sourceKind: 'huntress',
      sourceId: `huntress-${Date.now()}`,
      condition: 'sync_failed',
      severity: 'transient',
      detail: 'Sync failed: upstream 502',
      displayName: 'Huntress',
      fixHref: '/integrations#huntress',
      viewPermission: 'organizations:read',
      repairPermission: 'organizations:write',
      firstFailedAt: new Date('2026-10-15T09:00:00Z'),
      openedAt: new Date('2026-10-15T09:30:00Z'),
      lastObservedAt: new Date('2026-10-16T08:00:00Z'),
    }).returning({ id: connectionHealthIncidents.id }));
    incidentId = inc!.id;
  });

  const sentTo = () => sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to);

  runDb('sends one digest with RFC 8058 headers, records it, and a second run sends nothing', async () => {
    const first = await runDigest(NOW);
    expect(first.sent).toBe(1);
    // The write-only user holds the repair but not the view permission: dropped at send time.
    expect(sentTo()).toEqual([admin.email]);
    const msg = sendEmail.mock.calls[0]![0] as { headers: Record<string, string>; purpose: string; html: string };
    expect(msg.purpose).toBe('staff.connection_health_digest');
    expect(msg.headers['List-Unsubscribe']).toMatch(/^<https:\/\/app\.example\.test\/api\/v1\/email\/unsubscribe\?t=/);
    expect(msg.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msg.html).toContain('Sync failed: upstream 502');

    const [row] = await asSystem(() => db.select().from(ledger).where(and(eq(ledger.userId, admin.id), eq(ledger.digestDate, '2026-10-16'))));
    expect(row!.status).toBe('sent');
    expect(row!.sentAt).toBeInstanceOf(Date);
    expect(row!.incidentIds).toHaveLength(1);

    sendEmail.mockClear();
    const second = await runDigest(new Date(NOW.getTime() + 3600_000)); // 09:09, still in the window
    expect(sendEmail).not.toHaveBeenCalled();
    expect(second.alreadyHandled).toBeGreaterThanOrEqual(1);
  });

  runDb('an opted-out user gets nothing', async () => {
    await asSystem(() => setEmailOptOut(admin.id, TOPIC, 'one_click'));
    const r = await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.optedOut).toBe(1);
  });

  runDb('a user whose org access drops to none is excluded at send time', async () => {
    await asSystem(() => db.update(partnerUsers).set({ orgAccess: 'none' }).where(eq(partnerUsers.userId, admin.id)));
    await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  runDb('a suspended partner is not digested', async () => {
    const { partners } = await import('../../db/schema');
    await asSystem(() => db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, P)));
    const r = await runDigest(NOW);
    expect(r.partners).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  runDb('restored flow: a recovery the user was told about appears in the next day\'s digest only', async () => {
    expect((await runDigest(NOW)).sent).toBe(1);
    // sent_at is stamped with the wall clock; pin it to the simulated send time.
    await asSystem(() => db.update(ledger).set({ sentAt: new Date(NOW.getTime() + 60_000) }).where(eq(ledger.userId, admin.id)));
    await asSystem(() => db.update(connectionHealthIncidents)
      .set({ resolvedAt: new Date('2026-10-16T15:00:00Z'), resolution: 'recovered' })
      .where(eq(connectionHealthIncidents.id, incidentId)));
    sendEmail.mockClear();
    // Saturday 08:09 UTC.
    const day2 = await runDigest(new Date('2026-10-17T08:09:00Z'));
    expect(day2.sent).toBe(1);
    const msg = sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string };
    expect(msg.to).toBe(admin.email);
    expect(msg.subject).toBe('Connection health: 1 connection restored');
    expect(msg.text).toContain('Restored since your last digest');
    // Day 3: already reported as restored — nothing new to say.
    sendEmail.mockClear();
    const day3 = await runDigest(new Date('2026-10-18T08:09:00Z'));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(day3.skippedEmpty).toBe(1);
    const [skipRow] = await asSystem(() => db.select().from(ledger)
      .where(and(eq(ledger.userId, admin.id), eq(ledger.digestDate, '2026-10-18'))));
    expect(skipRow!.status).toBe('skipped_empty');
  });

  runDb('a retired incident never produces a restored line', async () => {
    expect((await runDigest(NOW)).sent).toBe(1);
    await asSystem(() => db.update(connectionHealthIncidents)
      .set({ resolvedAt: new Date('2026-10-16T15:00:00Z'), resolution: 'retired' })
      .where(eq(connectionHealthIncidents.id, incidentId)));
    sendEmail.mockClear();
    await runDigest(new Date('2026-10-17T08:09:00Z'));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  runDb('an existing claimed or failed row for today blocks any send (crash-after-claim stays at most once)', async () => {
    await asSystem(() => db.insert(ledger).values({ userId: admin.id, digestDate: '2026-10-16', status: 'claimed', claimedAt: NOW }));
    const r = await runDigest(new Date('2026-10-16T09:09:00Z'));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.alreadyHandled).toBe(1);
    await asSystem(() => db.update(ledger).set({ status: 'failed', error: 'x' }).where(eq(ledger.userId, admin.id)));
    await runDigest(new Date('2026-10-16T10:09:00Z'));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  runDb('a skipped_empty row blocks the later catch-up hours too', async () => {
    const { insertSkippedEmpty } = await import('../../services/connectionHealth/digestStore');
    expect(await asSystem(() => insertSkippedEmpty(admin.id, '2026-10-16', NOW))).toBe(true);
    expect(await asSystem(() => insertSkippedEmpty(admin.id, '2026-10-16', NOW))).toBe(false);
    expect(await asSystem(() => claimDelivery(admin.id, '2026-10-16', [], NOW))).toBeNull();
    await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  runDb('a disabled user gets nothing', async () => {
    await asSystem(() => db.update(users).set({ status: 'disabled' }).where(eq(users.id, admin.id)));
    await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  runDb('a deleted partner, or one whose only incident is retired, is not a candidate', async () => {
    const { loadCandidatePartners } = await import('../../services/connectionHealth/digestStore');
    const since = new Date(NOW.getTime() - 30 * 86_400_000);
    const ids = async () => (await asSystem(() => loadCandidatePartners(since))).map((p) => p.id);
    expect(await ids()).toContain(P);
    await asSystem(() => db.update(connectionHealthIncidents)
      .set({ resolvedAt: new Date('2026-10-15T12:00:00Z'), resolution: 'retired' })
      .where(eq(connectionHealthIncidents.id, incidentId)));
    expect(await ids()).not.toContain(P);
    await asSystem(() => db.update(connectionHealthIncidents)
      .set({ resolution: 'recovered' })
      .where(eq(connectionHealthIncidents.id, incidentId)));
    expect(await ids()).toContain(P);
    const { partners } = await import('../../db/schema');
    await asSystem(() => db.update(partners).set({ deletedAt: new Date() }).where(eq(partners.id, P)));
    expect(await ids()).not.toContain(P);
  });

  runDb('org incidents: a selected-access user hears only about covered orgs (org name joined)', async () => {
    const orgA = await createOrganization({ partnerId: P, name: 'Covered Dental' });
    const orgB = await createOrganization({ partnerId: P, name: 'Other Clinic' });
    const selected = await createUser({ partnerId: P, email: email() });
    const pu = await assignUserToPartner(selected.id, P, fullRoleId, 'selected');
    await asSystem(() => db.update(partnerUsers).set({ orgIds: [orgA.id] }).where(eq(partnerUsers.id, pu.id)));
    await asSystem(() => db.delete(connectionHealthIncidents).where(eq(connectionHealthIncidents.id, incidentId)));
    for (const [org, name] of [[orgA, 'DNS filter'], [orgB, 'M365']] as const) {
      await asSystem(() => db.insert(connectionHealthIncidents).values({
        partnerId: P, orgId: org.id, sourceKind: 'dns_filter', sourceId: `src-${org.id}`,
        condition: 'sync_failed', severity: 'transient', displayName: name, fixHref: '/dns-security',
        viewPermission: 'organizations:read', repairPermission: 'organizations:write',
        firstFailedAt: new Date('2026-10-15T09:00:00Z'), openedAt: new Date('2026-10-15T09:30:00Z'),
        lastObservedAt: NOW,
      }));
    }
    await runDigest(NOW);
    const bySelected = sendEmail.mock.calls.find((c) => (c[0] as { to: string }).to === selected.email)![0] as { html: string };
    expect(bySelected.html).toContain('Covered Dental');
    expect(bySelected.html).not.toContain('Other Clinic');
    const byAdmin = sendEmail.mock.calls.find((c) => (c[0] as { to: string }).to === admin.email)![0] as { html: string };
    expect(byAdmin.html).toContain('Covered Dental');
    expect(byAdmin.html).toContain('Other Clinic');
  });

  runDb('owner path: the grant owner gets their own link without the view permission; an owner from another partner does not', async () => {
    const owner = await createUser({ partnerId: P, email: email() });
    const outsider = (await createPartner()).id;
    const strayOwner = await createUser({ partnerId: outsider, email: email() });
    await asSystem(() => db.delete(connectionHealthIncidents).where(eq(connectionHealthIncidents.id, incidentId)));
    for (const ownerId of [owner.id, strayOwner.id]) {
      await asSystem(() => db.insert(connectionHealthIncidents).values({
        partnerId: P, ownerUserId: ownerId, sourceKind: 'oauth_grant', sourceId: `grant-${ownerId}`,
        condition: 'grant_revoked_reuse', severity: 'permanent', displayName: 'Example Agent (OAuth app)',
        fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps',
        viewPermission: 'connected_apps:read', repairPermission: 'connected_apps:manage',
        firstFailedAt: new Date('2026-10-15T09:00:00Z'), openedAt: new Date('2026-10-15T09:30:00Z'),
        lastObservedAt: NOW,
      }));
    }
    await runDigest(NOW);
    const to = sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(to).toContain(owner.email);
    expect(to).not.toContain(strayOwner.email);
    const msg = sendEmail.mock.calls.find((c) => (c[0] as { to: string }).to === owner.email)![0] as { html: string };
    expect(msg.html).toContain('https://app.example.test/account/connected-apps');
  });

  runDb('ledger retention deletes only rows past the cutoff, in batches', async () => {
    const { deleteOldDeliveries } = await import('../../services/connectionHealth/digestStore');
    await asSystem(() => db.insert(ledger).values([
      { userId: admin.id, digestDate: '2026-07-01', status: 'skipped_empty', claimedAt: NOW },
      { userId: admin.id, digestDate: '2026-07-02', status: 'skipped_empty', claimedAt: NOW },
      { userId: admin.id, digestDate: '2026-10-10', status: 'skipped_empty', claimedAt: NOW },
    ]));
    expect(await asSystem(() => deleteOldDeliveries('2026-07-18', 1))).toBe(1);
    expect(await asSystem(() => deleteOldDeliveries('2026-07-18', 1000))).toBe(1);
    expect(await asSystem(() => deleteOldDeliveries('2026-07-18', 1000))).toBe(0);
    const left = await asSystem(() => db.select({ d: ledger.digestDate }).from(ledger).where(eq(ledger.userId, admin.id)));
    expect(left.map((r) => r.d)).toEqual(['2026-10-10']);
  });

  runDb('markDeliveryFailed truncates the error and never touches a sent row', async () => {
    const { markDeliveryFailed } = await import('../../services/connectionHealth/digestStore');
    const id = await asSystem(() => claimDelivery(admin.id, '2026-10-16', [], NOW));
    await asSystem(() => markDeliveryFailed(id!, 'x'.repeat(2000)));
    const [failedRow] = await asSystem(() => db.select().from(ledger).where(eq(ledger.id, id!)));
    expect(failedRow!.status).toBe('failed');
    expect(failedRow!.error!.length).toBe(500);
    const sentId = await asSystem(() => claimDelivery(admin.id, '2026-10-17', [], NOW));
    await asSystem(() => markDeliverySent(sentId!, NOW));
    await asSystem(() => markDeliveryFailed(sentId!, 'late'));
    const [sentRow] = await asSystem(() => db.select().from(ledger).where(eq(ledger.id, sentId!)));
    expect(sentRow!.status).toBe('sent');
  });
});
