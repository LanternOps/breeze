/**
 * #8883 W5 T5.8 (Gate B1, spec §12 "Caller contexts") — every ticket-creating
 * caller context resolves the SAME partner-default business calendar AND the
 * SAME partner-wide routing rule, each on its own connection.
 *
 * resolveBusinessCalendar and evaluateRoutingRules read with explicit
 * partner_id / org_id filters on the CALLER's connection (no nested system
 * read), so every context must see partner-wide config through RLS:
 *   - staff partner token   breeze_has_partner_access (buildDbAccessContext)
 *   - org-scope token       <table>_partner_wide_select (currentPartnerId set)
 *   - org session           <table>_org_member_select (JWT partnerId = NULL)
 *   - Partner API           partnerScopedDbContext (partner access)
 *   - inbound email         system scope (the ingest transaction)
 *   - portal                the self-managed POST /tickets route: the
 *                           enable_tickets gate opens an org context WITH
 *                           currentPartnerId, driven through the real
 *                           middleware + route.
 * The org allowlist of an org_scoped partner-wide rule is read through
 * ticket_routing_rule_org_links_parent_visible_select in the org contexts: a
 * rule listing ANOTHER org fires for none of them.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  businessCalendarIntervals,
  businessCalendarRevisions,
  businessCalendars,
  portalUsers,
  ticketPrioritySettings,
  ticketRoutingRuleOrgLinks,
  ticketRoutingRules,
  tickets,
} from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';
import { partnerScopedDbContext } from '../../routes/partnerApi/dbContext';
import { portalTicketsEnabledMiddleware, ticketRoutes } from '../../routes/portal/tickets';
import { createTicket } from '../../services/ticketService';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function fixture() {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const sibling = (await createOrganization({ partnerId: partner.id }))!;
  const staff = await createUser({ partnerId: partner.id, email: `rr-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com` });
  return withSystemDbAccessContext(async () => {
    await db.insert(ticketPrioritySettings).values({ partnerId: partner.id, priority: 'normal', responseSlaMinutes: 60, resolutionSlaMinutes: 480 });
    const [cal] = await db.insert(businessCalendars).values({ partnerId: partner.id, orgId: null, name: 'Support hours', isPartnerDefault: true }).returning();
    const [rev] = await db.insert(businessCalendarRevisions).values({ calendarId: cal!.id, partnerId: partner.id, orgId: null, revision: 1, timezone: 'America/New_York' }).returning();
    await db.insert(businessCalendarIntervals).values([1, 2, 3, 4, 5].map((weekday) => ({
      revisionId: rev!.id, partnerId: partner.id, orgId: null, weekday, startMinute: 540, endMinute: 1020,
    })));
    const wide = { partnerId: partner.id, orgId: null };
    // Position 0: limited to the SIBLING org — must fire for none of the tickets below.
    const [siblingOnly] = await db.insert(ticketRoutingRules).values({ ...wide, name: 'Sibling only', position: 0, orgScoped: true, setPriority: 'low', addTags: ['sibling'] }).returning();
    await db.insert(ticketRoutingRuleOrgLinks).values({ ruleId: siblingOnly!.id, orgId: sibling.id });
    // Position 1: limited to the ticket org — the expected match everywhere.
    const [listed] = await db.insert(ticketRoutingRules).values({ ...wide, name: 'Listed org', position: 1, orgScoped: true, setPriority: 'urgent', addTags: ['routed'] }).returning();
    await db.insert(ticketRoutingRuleOrgLinks).values({ ruleId: listed!.id, orgId: org.id });
    // Position 2: every org — the catch-all, shadowed for the ticket org by "Listed org".
    const [everyOrg] = await db.insert(ticketRoutingRules).values({ ...wide, name: 'Every org', position: 2, setPriority: 'high' }).returning();
    return { partner, org, sibling, staff, revisionId: rev!.id, siblingOnlyId: siblingOnly!.id, listedId: listed!.id, everyOrgId: everyOrg!.id };
  });
}

async function stateOf(ticketId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ rev: tickets.slaCalendarRevisionId, rule: tickets.routingRuleId, priority: tickets.priority, tags: tickets.tags })
      .from(tickets).where(eq(tickets.id, ticketId)));
  return row!;
}

/** Exactly what authMiddleware opens for an organization-session JWT (partnerId: null). */
const orgSession = (orgId: string, userId: string): DbAccessContext =>
  buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId: null, userId });

/** An organization-scope token that carries its partner id (currentPartnerId set). */
const orgScopeToken = (orgId: string, partnerId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId,
});

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

describe('ticket create caller contexts (#8883 W5 T5.8, Gate B1)', () => {
  runDb('portal, inbound email, Partner API, staff partner token, org-scope token and org session resolve the same calendar AND routing rule', async () => {
    const f = await fixture();
    const actor = { kind: 'user' as const, userId: f.staff.id, name: 'Staff' };
    const created: Record<string, string> = {};

    const staffCtx = buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [f.org.id, f.sibling.id], partnerId: f.partner.id, userId: f.staff.id });
    created.staff = (await withDbAccessContext(staffCtx, () => createTicket({ orgId: f.org.id, subject: 'staff', source: 'manual' }, actor))).id;

    created.orgScopeToken = (await withDbAccessContext(orgScopeToken(f.org.id, f.partner.id), () =>
      createTicket({ orgId: f.org.id, subject: 'org token', source: 'api' }, { kind: 'system' } as never))).id;

    created.orgSession = (await withDbAccessContext(orgSession(f.org.id, f.staff.id), () =>
      createTicket({ orgId: f.org.id, subject: 'org session', source: 'manual' }, actor))).id;

    const apiCtx = partnerScopedDbContext({ partnerId: f.partner.id, accessibleOrgIds: [f.org.id] } as never);
    created.partnerApi = (await withDbAccessContext(apiCtx, () =>
      createTicket({ orgId: f.org.id, subject: 'partner api', source: 'api' }, { kind: 'system' } as never))).id;

    created.email = (await withSystemDbAccessContext(() =>
      createTicket({ orgId: f.org.id, subject: 'email', source: 'email', submitterEmail: 'sender@example.com', submitterName: 'Sender' }, { kind: 'system' } as never))).id;

    const [pu] = await withSystemDbAccessContext(() => db.insert(portalUsers).values({
      orgId: f.org.id, email: `portal-${Date.now()}@example.com`, name: 'Portal person', status: 'active',
    }).returning({ id: portalUsers.id, email: portalUsers.email }));
    const res = await portalApp({ id: pu!.id, orgId: f.org.id, email: pu!.email }, f.partner.id).request('/api/v1/portal/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
      // No priority: the customer did not choose one (T5.4), so the rule's applies.
      body: JSON.stringify({ subject: 'Printer broken', description: 'It makes a loud clicking noise now' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticket?: { id: string }; data?: { id: string } };
    created.portal = (body.ticket?.id ?? body.data?.id)!;
    expect(created.portal).toBeTruthy();

    const states: Record<string, unknown> = {};
    for (const [ctx, id] of Object.entries(created)) states[ctx] = await stateOf(id);
    const expected = { rev: f.revisionId, rule: f.listedId, priority: 'urgent', tags: ['routed'] };
    expect(states).toEqual({
      staff: expected, orgScopeToken: expected, orgSession: expected, partnerApi: expected, email: expected, portal: expected,
    });
  });

  runDb('a partner-wide rule whose org list names another org fires for none; an unlisted org gets the every-org rule', async () => {
    const f = await fixture();
    const actor = { kind: 'user' as const, userId: f.staff.id, name: 'Staff' };
    // Remove the rule listing the ticket org: now only "Sibling only" (not listed) and "Every org" remain ahead.
    await withSystemDbAccessContext(() => db.delete(ticketRoutingRules).where(eq(ticketRoutingRules.id, f.listedId)));
    const ids: Record<string, string> = {};
    ids.orgSession = (await withDbAccessContext(orgSession(f.org.id, f.staff.id), () =>
      createTicket({ orgId: f.org.id, subject: 'org session', source: 'manual' }, actor))).id;
    ids.orgScopeToken = (await withDbAccessContext(orgScopeToken(f.org.id, f.partner.id), () =>
      createTicket({ orgId: f.org.id, subject: 'org token', source: 'api' }, { kind: 'system' } as never))).id;
    ids.email = (await withSystemDbAccessContext(() =>
      createTicket({ orgId: f.org.id, subject: 'email', source: 'email', submitterEmail: 's@example.com' }, { kind: 'system' } as never))).id;
    for (const [ctx, id] of Object.entries(ids)) {
      expect((await stateOf(id)).rule, ctx).toBe(f.everyOrgId);
    }
    // The sibling itself does get its own rule (org session of the sibling).
    const siblingTicket = await withDbAccessContext(orgSession(f.sibling.id, f.staff.id), () =>
      createTicket({ orgId: f.sibling.id, subject: 'sibling', source: 'manual' }, actor));
    expect(await stateOf(siblingTicket.id)).toMatchObject({ rule: f.siblingOnlyId, priority: 'low' });
  });

  runDb('another partner sees none of these rules: its org session creates an unrouted ticket', async () => {
    await fixture();
    const other = (await createPartner())!;
    const otherOrg = (await createOrganization({ partnerId: other.id }))!;
    const otherStaff = await createUser({ partnerId: other.id, email: `rr-iso-${Date.now()}@example.com` });
    const t = await withDbAccessContext(orgSession(otherOrg.id, otherStaff.id), () =>
      createTicket({ orgId: otherOrg.id, subject: 'other partner', source: 'manual' }, { kind: 'user', userId: otherStaff.id, name: 'O' }));
    expect(await stateOf(t.id)).toMatchObject({ rule: null, priority: 'normal' });
  });

  // System scope (inbound email, workers) bypasses RLS, so the evaluator's own
  // partner filter is the ONLY guard there: another partner's ticket must not
  // pick up these rules.
  runDb("under system scope another partner's ticket never matches these partner-wide rules", async () => {
    await fixture();
    const other = (await createPartner())!;
    const otherOrg = (await createOrganization({ partnerId: other.id }))!;
    const t = await withSystemDbAccessContext(() =>
      createTicket({ orgId: otherOrg.id, subject: 'other partner email', source: 'email', submitterEmail: 'x@example.com' }, { kind: 'system' } as never));
    expect(await stateOf(t.id)).toMatchObject({ rule: null, priority: 'normal' });
  });

  runDb('fail closed end to end: once the only listed org is erased, its org_scoped rule fires for no org', async () => {
    const f = await fixture();
    const actor = { kind: 'user' as const, userId: f.staff.id, name: 'Staff' };
    // Drop the every-org catch-all so only the two org_scoped rules remain.
    await withSystemDbAccessContext(() => db.delete(ticketRoutingRules).where(eq(ticketRoutingRules.id, f.everyOrgId)));
    // Erase the sibling org: "Sibling only" loses its only link (cascade) and must not widen.
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM organizations WHERE id = ${f.sibling.id}`));
    const [linksLeft] = await withSystemDbAccessContext(() =>
      db.select({ n: sql<number>`count(*)::int` }).from(ticketRoutingRuleOrgLinks).where(eq(ticketRoutingRuleOrgLinks.ruleId, f.siblingOnlyId)));
    expect(linksLeft?.n).toBe(0);
    const third = (await createOrganization({ partnerId: f.partner.id }))!;
    for (const ctx of [orgSession(third.id, f.staff.id), buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [third.id], partnerId: f.partner.id, userId: f.staff.id })]) {
      const t = await withDbAccessContext(ctx, () => createTicket({ orgId: third.id, subject: 'third org', source: 'manual' }, actor));
      expect(await stateOf(t.id)).toMatchObject({ rule: null, priority: 'normal' });
    }
    const sysTicket = await withSystemDbAccessContext(() =>
      createTicket({ orgId: third.id, subject: 'third email', source: 'email', submitterEmail: 'y@example.com' }, { kind: 'system' } as never));
    expect(await stateOf(sysTicket.id)).toMatchObject({ rule: null });
  });
});
