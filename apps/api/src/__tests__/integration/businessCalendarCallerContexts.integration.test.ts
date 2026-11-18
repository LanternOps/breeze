/**
 * #8973 W4 Gate B1 — every ticket-creating caller context resolves the SAME
 * partner-default business calendar, on its own connection.
 *
 * resolveBusinessCalendar reads with explicit partner_id / org_id filters on
 * the CALLER's connection (no nested system read), so each context must see a
 * partner-wide calendar through RLS:
 *   - staff partner token  breeze_has_partner_access (buildDbAccessContext)
 *   - org-scope token      partner-wide SELECT branch (currentPartnerId)
 *   - Partner API          partnerScopedDbContext (partner access)
 *   - inbound email        system scope (the ingest transaction)
 *   - portal               the self-managed POST /tickets route: the
 *                          enable_tickets gate opens an org context WITH
 *                          currentPartnerId, driven here through the real
 *                          middleware + route.
 * Organization-session JWTs carry no partner id, so org sessions read the
 * partner's calendars through the org-member branch instead; that branch never
 * reaches another partner's rows.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  businessCalendarIntervals,
  businessCalendarRevisions,
  businessCalendars,
  orgTicketSettings,
  portalUsers,
  ticketPrioritySettings,
  tickets,
} from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';
import { partnerScopedDbContext } from '../../routes/partnerApi/dbContext';
import { portalTicketsEnabledMiddleware, ticketRoutes } from '../../routes/portal/tickets';
import { addTicketComment, changeTicketStatus, createTicket } from '../../services/ticketService';
import { addBusinessMinutes } from '@breeze/shared';
import { resolveBusinessCalendar } from '../../services/businessCalendars/resolve';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedPartnerDefault(partnerId: string, opts: { isDefault?: boolean; name?: string } = {}) {
  return withSystemDbAccessContext(async () => {
    const [cal] = await db.insert(businessCalendars).values({
      partnerId, orgId: null, name: opts.name ?? 'Support hours', isPartnerDefault: opts.isDefault ?? true,
    }).returning();
    const [rev] = await db.insert(businessCalendarRevisions).values({
      calendarId: cal!.id, partnerId, orgId: null, revision: 1, timezone: 'America/New_York',
    }).returning();
    await db.insert(businessCalendarIntervals).values([1, 2, 3, 4, 5].map((weekday) => ({
      revisionId: rev!.id, partnerId, orgId: null, weekday, startMinute: 540, endMinute: 1020,
    })));
    return { calendarId: cal!.id, revisionId: rev!.id };
  });
}

const NY_WEEKDAYS = {
  timezone: 'America/New_York',
  intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday: weekday as 1, startMinute: 540, endMinute: 1020 })),
};

async function fixture() {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const staff = await createUser({ partnerId: partner.id, email: `bc-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com` });
  await withSystemDbAccessContext(() => db.insert(ticketPrioritySettings).values({
    partnerId: partner.id, priority: 'normal', responseSlaMinutes: 60, resolutionSlaMinutes: 480,
  }));
  const cal = await seedPartnerDefault(partner.id);
  return { partner, org, staff, cal };
}

async function snapshotOf(ticketId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ rev: tickets.slaCalendarRevisionId, due: tickets.responseDueAt, created: tickets.createdAt })
      .from(tickets).where(eq(tickets.id, ticketId)));
  return row!;
}

/** Exactly what authMiddleware opens for an organization-scope JWT (partnerId: null). */
function orgSession(orgId: string, userId: string): DbAccessContext {
  return buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId: null, userId });
}

/** The portal stack as portalAuthMiddleware leaves it, self-managed routes included. */
function portalApp(user: { id: string; orgId: string; email: string }, partnerId: string) {
  const portal = new Hono();
  portal.use('/tickets/*', async (c, next) => {
    c.set('portalAuth', {
      user: { ...user, name: 'Portal person', contactId: null, receiveNotifications: true, status: 'active' },
      partnerId, token: 't', authMethod: 'bearer', timezone: 'UTC',
    } as never);
    if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) return next();
    const generic: DbAccessContext = {
      scope: 'organization', orgId: user.orgId, accessibleOrgIds: [user.orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null,
    };
    return withDbAccessContext(generic, () => next());
  });
  portal.use('/tickets/*', portalTicketsEnabledMiddleware);
  portal.route('/', ticketRoutes);
  return new Hono().route('/api/v1/portal', portal);
}

describe('business calendar caller contexts (#8973 W4, Gate B1)', () => {
  runDb('portal, inbound email, Partner API, staff partner token and org-scope token snapshot the same revision', async () => {
    const { partner, org, staff, cal } = await fixture();
    const snapshots: Record<string, string | null> = {};

    // Staff partner token.
    const staffCtx = buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [org.id], partnerId: partner.id, userId: staff.id });
    const staffTicket = await withDbAccessContext(staffCtx, () =>
      createTicket({ orgId: org.id, subject: 'staff', source: 'manual' }, { kind: 'user', userId: staff.id, name: 'Staff' }));
    snapshots.staff = (await snapshotOf(staffTicket.id)).rev;

    // Org-scope session: organization JWTs deliberately carry partnerId = null
    // (middleware/auth.ts), so currentPartnerId is NULL and the partner-wide
    // SELECT branch never matches — the org-member read branch is what lets it
    // see its own partner's calendars.
    const orgCtx = orgSession(org.id, staff.id);
    const orgTicket = await withDbAccessContext(orgCtx, () =>
      createTicket({ orgId: org.id, subject: 'org token', source: 'manual' }, { kind: 'user', userId: staff.id, name: 'Staff' }));
    snapshots.org = (await snapshotOf(orgTicket.id)).rev;

    // Partner API write context.
    const apiCtx = partnerScopedDbContext({ partnerId: partner.id, accessibleOrgIds: [org.id] } as never);
    const apiTicket = await withDbAccessContext(apiCtx, () =>
      createTicket({ orgId: org.id, subject: 'partner api', source: 'api' }, { kind: 'system' } as never));
    snapshots.partnerApi = (await snapshotOf(apiTicket.id)).rev;

    // Inbound email: the ingest transaction is system-scoped.
    const emailTicket = await withSystemDbAccessContext(() =>
      createTicket({ orgId: org.id, subject: 'email', source: 'email', submitterEmail: 'sender@example.com', submitterName: 'Sender' }, { kind: 'system' } as never));
    snapshots.email = (await snapshotOf(emailTicket.id)).rev;

    // Portal, through the real self-managed route.
    const [pu] = await withSystemDbAccessContext(() => db.insert(portalUsers).values({
      orgId: org.id, email: `portal-${Date.now()}@example.com`, name: 'Portal person', status: 'active',
    }).returning({ id: portalUsers.id, email: portalUsers.email }));
    const res = await portalApp({ id: pu!.id, orgId: org.id, email: pu!.email }, partner.id).request('/api/v1/portal/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
      body: JSON.stringify({ subject: 'Printer broken', description: 'It makes a loud clicking noise now', priority: 'normal' }),
    });
    expect(res.status).toBe(201);
    const portalTicketId = ((await res.json()) as { ticket?: { id: string }; data?: { id: string } });
    const pid = portalTicketId.ticket?.id ?? portalTicketId.data?.id;
    expect(pid).toBeTruthy();
    snapshots.portal = (await snapshotOf(pid!)).rev;

    expect(snapshots).toEqual({
      staff: cal.revisionId, org: cal.revisionId, partnerApi: cal.revisionId, email: cal.revisionId, portal: cal.revisionId,
    });

    // The deadline is business time on every path: exactly what the shared
    // calculator gives on the snapshotted Mon–Fri 09:00–17:00 New York hours.
    for (const id of [staffTicket.id, orgTicket.id, apiTicket.id, emailTicket.id, pid!]) {
      const s = await snapshotOf(id);
      expect(s.due, id).toEqual(addBusinessMinutes(NY_WEEKDAYS, [], s.created, 60));
    }
  });

  // The SLA write points re-read the snapshot on every change. An org-scope
  // session (currentPartnerId NULL) must be able to read a PARTNER-WIDE
  // revision, or a first response / pause end would fail the write.
  runDb('an org-scope session can answer and resume a ticket on a partner-wide calendar', async () => {
    const { org, staff, cal } = await fixture();
    const ctx = orgSession(org.id, staff.id);
    const actor = { kind: 'user' as const, userId: staff.id, name: 'Staff' };
    const ticket = await withDbAccessContext(ctx, () => createTicket({ orgId: org.id, subject: 'org session', source: 'manual' }, actor));
    expect((await snapshotOf(ticket.id)).rev).toBe(cal.revisionId);

    await withDbAccessContext(ctx, () => addTicketComment(ticket.id, { content: 'On it', isPublic: true }, actor));
    await withDbAccessContext(ctx, () => changeTicketStatus(ticket.id, { status: 'pending' }, {}, actor));
    await withDbAccessContext(ctx, () => changeTicketStatus(ticket.id, { status: 'open' }, {}, actor));

    const [row] = await withSystemDbAccessContext(() => db.select().from(tickets).where(eq(tickets.id, ticket.id)));
    expect(row?.firstResponseAt).not.toBeNull();
    expect(row?.slaPausedAt).toBeNull();
    expect(row?.slaCalendarRevisionId).toBe(cal.revisionId);
  });

  runDb('isolation: another partner (partner or org session) sees nothing of a partner-wide calendar', async () => {
    const { cal } = await fixture();
    const other = (await createPartner())!;
    const otherOrg = (await createOrganization({ partnerId: other.id }))!;
    const reads = async (ctx: DbAccessContext) => withDbAccessContext(ctx, async () => [
      (await db.select().from(businessCalendars).where(eq(businessCalendars.id, cal.calendarId))).length,
      (await db.select().from(businessCalendarRevisions).where(eq(businessCalendarRevisions.calendarId, cal.calendarId))).length,
      (await db.select().from(businessCalendarIntervals).where(eq(businessCalendarIntervals.revisionId, cal.revisionId))).length,
    ]);
    expect(await reads(orgSession(otherOrg.id, (await createUser({ partnerId: other.id, email: `iso-${Date.now()}@example.com` })).id))).toEqual([0, 0, 0]);
    expect(await reads(buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [otherOrg.id], partnerId: other.id, userId: null }))).toEqual([0, 0, 0]);
    expect(await reads({ scope: 'organization', orgId: otherOrg.id, accessibleOrgIds: [otherOrg.id], accessiblePartnerIds: [], userId: null, currentPartnerId: other.id })).toEqual([0, 0, 0]);
  });

  // The org-member read branch (<table>_org_member_select) is keyed on org
  // access, not on the currentPartnerId claim: a session with access to an
  // org of the owning partner reads its partner-wide calendars — including
  // the generic portal context — and a session of another partner's org
  // never does.
  runDb('the org-member branch: own partner resolves, another partner never does', async () => {
    const { partner, org, cal } = await fixture();
    const other = (await createPartner())!;
    const otherOrg = (await createOrganization({ partnerId: other.id }))!;
    const portalCtx = (orgId: string): DbAccessContext => ({
      scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null,
    });
    const own = await withDbAccessContext(portalCtx(org.id), () => resolveBusinessCalendar(db, { partnerId: partner.id, orgId: org.id }));
    expect(own).toEqual({ source: 'partner', calendarId: cal.calendarId, revisionId: cal.revisionId });
    // Even naming the other partner explicitly finds nothing: RLS hides the rows.
    const foreign = await withDbAccessContext(portalCtx(otherOrg.id), () => resolveBusinessCalendar(db, { partnerId: partner.id, orgId: otherOrg.id }));
    expect(foreign.source).toBe('none');
  });

  runDb('resolution order: an org override wins; an archived override falls through to the partner default; none when there is no default', async () => {
    const { partner, org, cal } = await fixture();
    const other = await seedPartnerDefault(partner.id, { isDefault: false, name: 'Night shift' });
    const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
    const resolve = () => sys(() => resolveBusinessCalendar(db, { partnerId: partner.id, orgId: org.id }));

    expect(await resolve()).toEqual({ source: 'partner', calendarId: cal.calendarId, revisionId: cal.revisionId });

    await sys(() => db.insert(orgTicketSettings).values({ orgId: org.id, businessCalendarId: other.calendarId }));
    expect(await resolve()).toEqual({ source: 'org', calendarId: other.calendarId, revisionId: other.revisionId });

    await sys(() => db.update(businessCalendars).set({ archivedAt: new Date() }).where(eq(businessCalendars.id, other.calendarId)));
    expect(await resolve()).toEqual({ source: 'partner', calendarId: cal.calendarId, revisionId: cal.revisionId });

    await sys(() => db.update(businessCalendars).set({ isPartnerDefault: false }).where(eq(businessCalendars.id, cal.calendarId)));
    expect(await resolve()).toEqual({ source: 'none', calendarId: null, revisionId: null });
  });

  runDb('the current revision is the highest one: an hours edit applies to new tickets only', async () => {
    const { partner, org, staff, cal } = await fixture();
    const staffCtx = buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [org.id], partnerId: partner.id, userId: staff.id });
    const before = await withDbAccessContext(staffCtx, () =>
      createTicket({ orgId: org.id, subject: 'before', source: 'manual' }, { kind: 'user', userId: staff.id, name: 'Staff' }));
    const [rev2] = await withSystemDbAccessContext(() => db.insert(businessCalendarRevisions).values({
      calendarId: cal.calendarId, partnerId: partner.id, orgId: null, revision: 2, timezone: 'Europe/London',
    }).returning());
    await withSystemDbAccessContext(() => db.insert(businessCalendarIntervals).values({
      revisionId: rev2!.id, partnerId: partner.id, orgId: null, weekday: 1, startMinute: 0, endMinute: 1440,
    }));
    const after = await withDbAccessContext(staffCtx, () =>
      createTicket({ orgId: org.id, subject: 'after', source: 'manual' }, { kind: 'user', userId: staff.id, name: 'Staff' }));
    expect((await snapshotOf(before.id)).rev).toBe(cal.revisionId);
    expect((await snapshotOf(after.id)).rev).toBe(rev2!.id);
  });
});
