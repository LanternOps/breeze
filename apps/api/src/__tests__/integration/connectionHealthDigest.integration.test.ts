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

  beforeEach(async () => {
    sendEmail.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('APP_ENCRYPTION_KEY', 'integration-digest-secret-0123456789');
    vi.stubEnv('DASHBOARD_URL', 'https://app.example.test');
    const partner = await createPartner();
    P = partner.id;
    // Isolate from other partners left by earlier tests in this file.
    await asSystem(() => db.delete(connectionHealthIncidents));

    const fullRole = await createRole({ scope: 'partner', partnerId: P, name: 'digest-full' });
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

    await asSystem(() => db.insert(connectionHealthIncidents).values({
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
    }));
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
});
