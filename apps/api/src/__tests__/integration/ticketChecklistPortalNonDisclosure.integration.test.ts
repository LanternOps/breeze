/**
 * The standing proof that internal ticket-checklist state (steps,
 * instructions, and the internal seeding comment) never reaches the customer
 * portal (#5808 W03, spec §5). Marker strings, not key names, are used
 * throughout so a renamed field or column cannot slip past these assertions
 * by accident.
 *
 * Runs through the REAL Hono app + postgres.js driver (breeze_app pool), the
 * same shape as portal-routes-rls.integration.test.ts and
 * portalServiceRls.integration.test.ts — this suite defines its own local
 * `seedPortalUser` / `loginPortal`, matching the convention that there is no
 * shared exported helper for these.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  portalBranding,
  portalUsers,
  serviceDeliverables,
  serviceDeliverableOccurrences,
  ticketChecklistItems,
  ticketChecklistTemplateItems,
  ticketChecklistTemplates,
  ticketComments,
} from '../../db/schema';
import { hashPassword } from '../../services/password';
import { createOrganization, createIntegrationTestClient, createPartner } from './db-utils';
import { portalRoutes } from '../../routes/portal';
import { ticketsRoutes } from '../../routes/tickets';
import { runDeliverableSweep } from '../../jobs/deliverableWorker';
import { applyTicketStatusChange } from '../../services/serviceDeliverableService';

const SECRET_STEP = 'ZZZ-INTERNAL-STEP-MARKER';
const SECRET_INSTRUCTIONS = 'ZZZ-INTERNAL-INSTRUCTIONS-MARKER';
const PORTAL_PASSWORD = 'PortalPass123!';
const AS_OF = new Date('2026-10-25T05:18:00Z');

const system = <T>(fn: () => Promise<T>, label = 'ticketChecklistPortalNonDisclosure.integration'): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

function buildPortalApp(): Hono {
  const app = new Hono();
  app.route('/portal', portalRoutes);
  return app;
}

async function seedPortalUser(orgId: string): Promise<{ id: string; email: string }> {
  const admin = getTestDb();
  const email = `portal-nondisclosure-${randomUUID()}@example.test`;
  const passwordHash = await hashPassword(PORTAL_PASSWORD);
  const [portalUser] = await admin
    .insert(portalUsers)
    .values({ orgId, email, name: 'Portal Customer', passwordHash, status: 'active' })
    .returning();
  return { id: portalUser!.id, email: portalUser!.email };
}

async function loginPortal(app: Hono, email: string, orgId: string): Promise<string> {
  const res = await app.request('/portal/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PORTAL_PASSWORD, orgId }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accessToken).toBeTruthy();
  return body.accessToken as string;
}

/**
 * Seeds a deliverable wired to a checklist template + internal instructions,
 * then sweeps it open so the ticket carries a real SECRET_STEP checklist item
 * and a real SECRET_INSTRUCTIONS internal comment — exactly what W03 seeds in
 * production. `artifactRequired: false` so a later `applyTicketStatusChange`
 * (the narrative-path test) can reach `delivered` directly without a separate
 * evidence-upload step.
 */
async function seedDeliverableWithChecklist(orgId: string) {
  const admin = getTestDb();
  await admin.insert(portalBranding).values({ orgId, enableService: true, enableDocuments: true, enableReports: true });
  const [template] = await admin
    .insert(ticketChecklistTemplates)
    .values({ orgId, name: `Runbook ${randomUUID()}` })
    .returning({ id: ticketChecklistTemplates.id });
  await admin.insert(ticketChecklistTemplateItems).values({ templateId: template!.id, orgId, label: SECRET_STEP, sortOrder: 0 });
  const [deliverable] = await admin
    .insert(serviceDeliverables)
    .values({
      orgId, name: `Nondisclosure deliverable ${randomUUID()}`, cadence: 'monthly',
      // effectiveFrom must be in the PAST relative to the real wall clock, not
      // relative to AS_OF: the sweep is driven by AS_OF, but the portal read
      // model filters on `lte(effectiveFrom, today)` using the actual current
      // date (serviceReadModel.ts:222). A future effectiveFrom makes the
      // deliverable invisible to the portal, which would make every negative
      // assertion here pass against an EMPTY payload.
      anchorDueDate: '2026-10-31', effectiveFrom: '2020-01-01', portalVisible: true, artifactRequired: false,
      checklistTemplateId: template!.id, instructions: SECRET_INSTRUCTIONS,
    })
    .returning({ id: serviceDeliverables.id });

  const res = await runDeliverableSweep(AS_OF);
  expect(res.opened).toBeGreaterThanOrEqual(1);
  const [occ] = await admin
    .select()
    .from(serviceDeliverableOccurrences)
    .where(eq(serviceDeliverableOccurrences.deliverableId, deliverable!.id));
  expect(occ!.ticketId).not.toBeNull();
  return { deliverableId: deliverable!.id, ticketId: occ!.ticketId!, occurrenceId: occ!.id };
}

describe('ticket checklist portal non-disclosure (#5808 W03)', () => {
  it('GET /portal/service carries neither marker nor an instructions/checklist key', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedDeliverableWithChecklist(org.id);
    const portalUser = await seedPortalUser(org.id);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, org.id);

    const res = await app.request('/portal/service', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Positive control FIRST: a payload that does not actually contain the
    // deliverable would satisfy every `not.toContain` below vacuously.
    expect(JSON.parse(text).groups.flatMap((g: { deliverables: unknown[] }) => g.deliverables))
      .not.toHaveLength(0);
    expect(text).not.toContain(SECRET_STEP);
    expect(text).not.toContain(SECRET_INSTRUCTIONS);
    expect(text).not.toContain('"instructions"');
    expect(text).not.toContain('"checklist"');
    expect(text).not.toContain('"checklistTemplateId"');
  });

  it('GET /portal/service/:deliverableId/occurrences carries neither marker nor an instructions/checklist key', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { deliverableId } = await seedDeliverableWithChecklist(org.id);
    const portalUser = await seedPortalUser(org.id);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, org.id);

    const res = await app.request(`/portal/service/${deliverableId}/occurrences`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).occurrences).not.toHaveLength(0);   // positive control
    expect(text).not.toContain(SECRET_STEP);
    expect(text).not.toContain(SECRET_INSTRUCTIONS);
    expect(text).not.toContain('"instructions"');
    expect(text).not.toContain('"checklist"');
    expect(text).not.toContain('"checklistTemplateId"');
  });

  it('portal ticket detail on an ORDINARY support ticket never exposes its MANUAL checklist', async () => {
    // The surface most likely to be forgotten: the portal DOES expose support
    // tickets, and this checks the route's own query never selects
    // ticket_checklist_items at all (routes/portal/tickets.ts) — there is no
    // filter to bypass here because there is no column wired to leak through.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const portalUser = await seedPortalUser(org.id);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, org.id);
    const authed = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

    const createRes = await authed('/portal/tickets', {
      method: 'POST',
      body: JSON.stringify({ subject: 'Printer offline', description: 'Cannot print from the front desk', priority: 'high' }),
    });
    expect(createRes.status).toBe(201);
    const ticketId = (await createRes.json()).ticket.id as string;

    // A technician's MANUAL checklist step on this (portal-visible) ticket.
    await getTestDb().insert(ticketChecklistItems).values({
      orgId: org.id, ticketId, label: SECRET_STEP, position: 0, source: 'manual',
    });

    const detailRes = await authed(`/portal/tickets/${ticketId}`);
    expect(detailRes.status).toBe(200);
    const text = await detailRes.text();
    expect(text).not.toContain(SECRET_STEP);
    expect(text).not.toContain('"checklist"');
  });

  it("the comment feed hides an internal (is_public=false) comment shaped exactly like the sweep's instructions note", async () => {
    // NOTE ON MECHANISM: a deliverable-sweep-created ticket is never itself
    // portal-visible — routes/portal/tickets.ts's `portalTicketOwnership`
    // filters on `submitted_by` / `requester_contact_id`, and a
    // system-created deliverable ticket has neither, so it 404s on this route
    // for an UNRELATED reason (ownership, not comment visibility) and testing
    // that exact row here would prove nothing about the leak this test cares
    // about. Instead this inserts a comment row shaped EXACTLY like
    // openOneOccurrence's real instructions comment (commentType 'internal',
    // authorType 'system', originPrincipalKind 'system', isPublic false) onto
    // a ticket the portal user actually owns, which exercises the real
    // mechanism that would protect it if such a ticket WERE portal-visible:
    // the ticket detail route's `eq(ticketComments.isPublic, true)` filter.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const portalUser = await seedPortalUser(org.id);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, org.id);
    const authed = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

    const createRes = await authed('/portal/tickets', {
      method: 'POST',
      body: JSON.stringify({ subject: 'Slow wifi', description: 'The office wifi has been slow all week', priority: 'normal' }),
    });
    expect(createRes.status).toBe(201);
    const ticketId = (await createRes.json()).ticket.id as string;

    await getTestDb().insert(ticketComments).values({
      ticketId, userId: null, authorName: 'Breeze', authorType: 'system', commentType: 'internal',
      content: `Internal instructions for this deliverable:\n\n${SECRET_INSTRUCTIONS}`,
      isPublic: false, originPrincipalKind: 'system',
    });
    // Positive control: a PUBLIC comment on the same ticket DOES appear, so an
    // empty/broken query could not pass the negative assertion vacuously.
    await getTestDb().insert(ticketComments).values({
      ticketId, userId: null, authorName: 'Front Desk', authorType: 'user', commentType: 'comment',
      content: 'A visible reply', isPublic: true, originPrincipalKind: 'user',
    });

    const detailRes = await authed(`/portal/tickets/${ticketId}`);
    expect(detailRes.status).toBe(200);
    const body = await detailRes.json();
    const contents: string[] = body.ticket.comments.map((c: { content: string }) => c.content);
    expect(contents).toContain('A visible reply');
    expect(contents.some((c) => c.includes(SECRET_INSTRUCTIONS))).toBe(false);
    expect(JSON.stringify(body)).not.toContain(SECRET_INSTRUCTIONS);
  });

  it('the narrative path: resolutionNote lands in deliveryNote verbatim, published as `note` on BOTH portal surfaces, no marker, no smuggled progress counter', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { deliverableId, ticketId, occurrenceId } = await seedDeliverableWithChecklist(org.id);

    await system(() =>
      applyTicketStatusChange({
        ticketId, orgId: org.id, to: 'resolved', actorUserId: null,
        resolutionNote: 'Reviewed and clean.',
      }));

    const [occRow] = await getTestDb()
      .select({ deliveryNote: serviceDeliverableOccurrences.deliveryNote, status: serviceDeliverableOccurrences.status })
      .from(serviceDeliverableOccurrences)
      .where(eq(serviceDeliverableOccurrences.id, occurrenceId));
    expect(occRow!.status).toBe('delivered');
    expect(occRow!.deliveryNote).toBe('Reviewed and clean.');
    expect(occRow!.deliveryNote).not.toContain(SECRET_INSTRUCTIONS);
    expect(occRow!.deliveryNote).not.toMatch(/\d+\s*\/\s*\d+/); // no smuggled "2/3" checklist-progress counter

    const portalUser = await seedPortalUser(org.id);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, org.id);

    const overviewRes = await app.request('/portal/service', { headers: { Authorization: `Bearer ${token}` } });
    expect(overviewRes.status).toBe(200);
    const overview = await overviewRes.json();
    // No optional chaining on the way in: a mis-navigated DTO path would
    // otherwise yield undefined and quietly satisfy the negative assertions.
    const portalDeliverables = overview.groups.flatMap((g: { deliverables: Array<{ id: string; lastDelivered: { note: string | null } | null }> }) => g.deliverables);
    const published = portalDeliverables.find((d: { id: string }) => d.id === deliverableId);
    expect(published).toBeDefined();
    expect(published.lastDelivered).not.toBeNull();
    expect(published.lastDelivered.note).toBe('Reviewed and clean.');
    expect(JSON.stringify(overview)).not.toContain(SECRET_INSTRUCTIONS);
    expect(published.lastDelivered.note).not.toMatch(/\d+\s*\/\s*\d+/);

    const occRes = await app.request(`/portal/service/${deliverableId}/occurrences`, { headers: { Authorization: `Bearer ${token}` } });
    expect(occRes.status).toBe(200);
    const occDto = await occRes.json();
    const matching = occDto.occurrences.find((o: { id: string }) => o.id === occurrenceId);
    expect(matching).toBeDefined();
    expect(matching.note).toBe('Reviewed and clean.');
    expect(matching.note).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it('an ORG-scoped token cannot reach the MSP checklist routes at all (requireScope("partner","system"))', async () => {
    // ticketChecklistRoutes (routes/tickets/checklist.ts) gates every route —
    // read, add, patch, delete, apply-template, reorder — behind
    // `requireScope('partner', 'system')`, which runs BEFORE the ticket lookup
    // and BEFORE requirePermission, so even a well-formed but non-existent
    // ticket id 403s rather than 404ing.
    const app = new Hono();
    app.route('/tickets', ticketsRoutes);
    const client = await createIntegrationTestClient(app, { scope: 'organization' });

    const res = await client.get(`/tickets/${randomUUID()}/checklist`);
    expect(res.status).toBe(403);
  });
});
