/**
 * W07 (#3901): the push fan-out's tenant boundary, proven against real Postgres.
 *
 * The worker runs inside withSystemDbAccessContext (RLS bypassed), so isolation
 * here is entirely app-layer: the partner filter compiled into
 * anySlaSubscribersQuery plus the per-user permission re-check in
 * isAuthorisedForTicket. Push transport is mocked (no APNs in CI); the durable
 * observable is user_notifications.
 *
 * Prerequisites: a live test database (`pnpm test-stack up`, or
 * docker compose -f docker-compose.test.yml up -d).
 */
import './setup';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../services/apns', async (orig) => ({
  ...(await orig<typeof import('../../services/apns')>()),
  isApnsConfigured: () => true,
}));
// vi.hoisted, not a plain const: vi.mock factories are hoisted above every
// top-level binding, so a bare `const dispatch` here dies with
// "Cannot access 'dispatch' before initialization" the moment the worker
// imports expoPush.
const dispatch = vi.hoisted(() => vi.fn(async () => ({ tokensFound: 1, dispatched: 1, errors: 0 })));
vi.mock('../../services/expoPush', async (orig) => ({
  ...(await orig<typeof import('../../services/expoPush')>()),
  dispatchPushToTokens: dispatch,
}));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));

import { db, withSystemDbAccessContext } from '../../db';
import { mobileDevices, ticketPushPreferences, tickets, userNotifications } from '../../db/schema';
import { handleTicketEvent } from '../../jobs/ticketNotifyWorker';
import { ANY_SUBSCRIBER_CAP, listAnySlaSubscribers } from '../../services/ticketPush';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

/**
 * A user who actually passes the fan-out gate: a membership AND a role that
 * really holds `tickets:read` through the permissions catalog that
 * getUserPermissions resolves at runtime.
 *
 * `createUser({ withMembership: true })` is NOT enough — the role it builds has
 * zero permissions (db-utils createRole only inserts a `roles` row); grants live
 * in the separate grantRolePermissions. A withMembership user is therefore
 * filtered out of every fan-out, and the "obvious fix" (relaxing the expectation
 * to `[]`) would be a vacuously green test. Pass `perms: []` to build the
 * negative control: identical shape, no tickets:read.
 */
async function makeUser(opts: {
  partnerId: string;
  orgId?: string | null;
  perms?: Array<{ resource: string; action: string }>;
  orgAccess?: 'all' | 'selected' | 'none';
}) {
  const perms = opts.perms ?? [{ resource: 'tickets', action: 'read' }];
  const user = await createUser({
    partnerId: opts.partnerId,
    orgId: opts.orgId ?? null,
    email: `${uniq('fanout')}@example.com`,
  });
  if (opts.orgId) {
    const role = await createRole({ scope: 'organization', orgId: opts.orgId, partnerId: opts.partnerId });
    if (perms.length) await grantRolePermissions(role.id, perms);
    await assignUserToOrganization(user.id, opts.orgId, role.id);
  } else {
    const role = await createRole({ scope: 'partner', partnerId: opts.partnerId });
    if (perms.length) await grantRolePermissions(role.id, perms);
    await assignUserToPartner(user.id, opts.partnerId, role.id, opts.orgAccess ?? 'all');
  }
  return user;
}

async function seed() {
  const p1 = await createPartner();
  const p2 = await createPartner();
  const orgA = await createOrganization({ partnerId: p1.id });
  const orgB = await createOrganization({ partnerId: p1.id });

  // Partner-wide, tickets:read, orgAccess 'all' — the ticket's assignee.
  const owner = await makeUser({ partnerId: p1.id });
  // Org-scoped to orgA (the ticket's org) — must receive.
  const anyA = await makeUser({ partnerId: p1.id, orgId: orgA.id });
  // Org-scoped to orgB — must NOT receive (canAccessOrg false).
  const anyB = await makeUser({ partnerId: p1.id, orgId: orgB.id });
  // Another partner entirely — must NOT receive (SQL partner filter).
  const foreign = await makeUser({ partnerId: p2.id });
  // NEGATIVE CONTROL: right partner, opted into 'any', but NO tickets:read.
  // Without this user, a run where the permission grant silently failed would
  // still look "correct" — everyone excluded, for the wrong reason.
  const noPerm = await makeUser({ partnerId: p1.id, perms: [] });

  await withSystemDbAccessContext(async () => {
    for (const u of [anyA, anyB, foreign, noPerm]) {
      await db.insert(ticketPushPreferences).values({ userId: u.id, slaScope: 'any' });
      await db.insert(mobileDevices).values({
        userId: u.id,
        deviceId: uniq('dev'),
        platform: 'ios',
        apnsToken: `tok-${u.id}`,
      });
    }
    await db.insert(mobileDevices).values({
      userId: owner.id,
      deviceId: uniq('dev'),
      platform: 'ios',
      apnsToken: `tok-${owner.id}`,
    });
  });

  // ticket_number is NOT NULL with no default; status is the ticket_status enum.
  // No `as never` cast — that cast is exactly what would hide a missing column.
  const [ticket] = await withSystemDbAccessContext(() =>
    db
      .insert(tickets)
      .values({
        orgId: orgA.id,
        partnerId: p1.id,
        ticketNumber: uniq('TKT'),
        internalNumber: 'T-2026-0042',
        subject: 'Printer',
        status: 'open',
        assignedTo: owner.id,
      })
      .returning());

  return { p1, p2, orgA, orgB, owner, anyA, anyB, foreign, noPerm, ticket: ticket! };
}

const rowsFor = (ticketId: string) =>
  withSystemDbAccessContext(() =>
    db
      .select({ userId: userNotifications.userId, dedupeKey: userNotifications.dedupeKey })
      .from(userNotifications)
      .where(eq(userNotifications.link, `/tickets#${ticketId}`)));

describe('ticket push fan-out — tenant boundary', () => {
  beforeEach(() => dispatch.mockClear());

  /**
   * The SQL partner filter, isolated.
   *
   * Mutation-tested: deleting `eq(users.partnerId, partnerId)` from
   * anySlaSubscribersQuery leaves the end-to-end fan-out tests below GREEN,
   * because two later layers (assertSamePartner, then isAuthorisedForTicket —
   * which cannot resolve permissions for a user with no membership in this
   * partner) independently exclude the foreign subscriber. Defence in depth is
   * the right design, but it means no end-to-end assertion pins the SQL clause.
   * This test does: it calls the discovery query directly, so dropping the
   * filter turns it red on its own.
   */
  runDb('listAnySlaSubscribers never returns a subscriber from another partner', async () => {
    const fx = await seed();
    const { users: subs } = await withSystemDbAccessContext(() => listAnySlaSubscribers(fx.p1.id));
    const ids = subs.map((s) => s.userId);
    // Positive control: the query really does find this partner's opted-in users,
    // so an empty result can never read as "isolation works".
    expect(ids).toContain(fx.anyA.id);
    expect(ids).toContain(fx.anyB.id);
    expect(ids).not.toContain(fx.foreign.id);
  });

  runDb(
    "cross-partner 'any' opt-in receives nothing; org-scoped user receives only own-org breaches",
    async () => {
      const fx = await seed();
      await handleTicketEvent({
        type: 'ticket.sla_breached',
        ticketId: fx.ticket.id,
        orgId: fx.orgA.id,
        partnerId: fx.p1.id,
        actorUserId: null,
        eventId: 'e1',
        payload: { target: 'response', internalNumber: null, subject: 'Printer', assigneeId: fx.owner.id },
      });
      const ids = (await rowsFor(fx.ticket.id)).map((r) => r.userId).sort();

      // BOTH halves must fire. The positive half proves the permission grant
      // actually resolved (an empty `ids` is a broken fixture, not a pass); the
      // negative half proves the boundary discriminates.
      expect(ids).toContain(fx.owner.id);
      expect(ids).toContain(fx.anyA.id);
      expect(ids).not.toContain(fx.anyB.id); // orgB — canAccessOrg false
      expect(ids).not.toContain(fx.foreign.id); // partner 2 — SQL partner filter
      expect(ids).not.toContain(fx.noPerm.id); // no tickets:read
      expect(ids).toEqual([fx.owner.id, fx.anyA.id].sort());
      expect(dispatch).toHaveBeenCalledTimes(2);
    },
  );

  runDb('replaying the same breach yields no second row and no second push', async () => {
    const fx = await seed();
    const ev = {
      type: 'ticket.sla_breached' as const,
      ticketId: fx.ticket.id,
      orgId: fx.orgA.id,
      partnerId: fx.p1.id,
      actorUserId: null,
      eventId: 'e1',
      payload: {
        target: 'resolution' as const,
        internalNumber: null,
        subject: 'Printer',
        assigneeId: fx.owner.id,
      },
    };
    await handleTicketEvent(ev);
    dispatch.mockClear();
    await handleTicketEvent(ev);
    expect(dispatch).not.toHaveBeenCalled();
    const rows = await rowsFor(fx.ticket.id);
    expect(rows.filter((r) => r.userId === fx.owner.id)).toHaveLength(1);
  });

  runDb('A→B→A reassignment pushes twice; a retry of one event does not', async () => {
    const fx = await seed();
    const assign = (eventId: string) =>
      handleTicketEvent({
        type: 'ticket.assigned',
        ticketId: fx.ticket.id,
        orgId: fx.orgA.id,
        partnerId: fx.p1.id,
        actorUserId: fx.anyB.id,
        eventId,
        payload: { assigneeId: fx.owner.id },
      });
    await assign('e-a1');
    await assign('e-a1');
    await assign('e-a2');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  /**
   * The cap, proven with a small injected value instead of 505 real users.
   *
   * The plan's original shape seeded ANY_SUBSCRIBER_CAP + 5 users, each with a
   * role and a permission grant; that is ~2000 serial statements and blows the
   * 30s integration timeout (it did, twice). The plan's own fallback applies:
   * make the cap injectable rather than delete the test — it is a
   * tenant-blast-radius control. listAnySlaSubscribers takes `cap` for exactly
   * this; the worker never passes it, so production stays at
   * ANY_SUBSCRIBER_CAP, which ticketPush.sql.test.ts pins into the compiled
   * LIMIT.
   */
  runDb('the any-SLA subscriber list truncates at the cap, lowest user id first', async () => {
    const fx = await seed();
    const CAP = 2;
    // seed() already opted 4 users in (anyA, anyB, foreign, noPerm); three of
    // them are in p1, which is > CAP.
    const { users: subs, truncated } = await withSystemDbAccessContext(() =>
      listAnySlaSubscribers(fx.p1.id, CAP));

    expect(truncated).toBe(true);
    expect(subs).toHaveLength(CAP);
    // Deterministic truncation: ordered by user id, so the same partner always
    // loses the same tail rather than a random subset per run.
    const ids = subs.map((s) => s.userId);
    expect(ids).toEqual([...ids].sort());
    // Positive control: an uncapped call returns strictly more than the capped one.
    const { users: all, truncated: allTruncated } = await withSystemDbAccessContext(() =>
      listAnySlaSubscribers(fx.p1.id));
    expect(all.length).toBeGreaterThan(CAP);
    expect(allTruncated).toBe(false);
  });

  /**
   * REGRESSION (#4281 review): `getUserPushTargets`' device filter
   * (notifications_enabled = true AND status = 'active') was pinned by NOTHING
   * — the unit suite's chainable db mock ignores the WHERE and every fixture
   * here took the column defaults. Tokens are deliberately left populated on
   * the blocked/opted-out rows so this pins the QUERY, not the revoke route's
   * token clearing.
   */
  runDb('a blocked device and a notifications-off device never receive a ticket push', async () => {
    const fx = await seed();
    await withSystemDbAccessContext(async () => {
      await db.insert(mobileDevices).values({
        userId: fx.owner.id,
        deviceId: uniq('dev-blocked'),
        platform: 'ios',
        apnsToken: `tok-blocked-${fx.owner.id}`,
        status: 'blocked',
      });
      await db.insert(mobileDevices).values({
        userId: fx.owner.id,
        deviceId: uniq('dev-muted'),
        platform: 'ios',
        apnsToken: `tok-muted-${fx.owner.id}`,
        notificationsEnabled: false,
      });
    });

    await handleTicketEvent({
      type: 'ticket.assigned',
      ticketId: fx.ticket.id,
      orgId: fx.orgA.id,
      partnerId: fx.p1.id,
      actorUserId: fx.anyB.id,
      eventId: 'e-devfilter',
      payload: { assigneeId: fx.owner.id },
    });

    const calls = dispatch.mock.calls as unknown as Array<[{ token: string }[]]>;
    const sent = calls.flatMap((c) => c[0].map((t) => t.token));
    // Positive control: the active, notifications-enabled handset DID receive it,
    // so an empty `sent` can never read as "the filter works".
    expect(sent).toContain(`tok-${fx.owner.id}`);
    expect(sent).not.toContain(`tok-blocked-${fx.owner.id}`);
    expect(sent).not.toContain(`tok-muted-${fx.owner.id}`);
  });

  runDb('the owner is notified from the assignee branch, never via the capped list', async () => {
    const fx = await seed();
    await handleTicketEvent({
      type: 'ticket.sla_breached',
      ticketId: fx.ticket.id,
      orgId: fx.orgA.id,
      partnerId: fx.p1.id,
      actorUserId: null,
      eventId: 'e-cap',
      payload: { target: 'response', internalNumber: null, subject: 'Printer', assigneeId: fx.owner.id },
    });
    const rows = await rowsFor(fx.ticket.id);
    // The owner has no ticket_push_preferences row at all, so they can never
    // appear in listAnySlaSubscribers — they are reached only because they are
    // the assignee. That is what keeps the cap from ever dropping the owner.
    expect(rows.some((r) => r.userId === fx.owner.id)).toBe(true);
  });
});
