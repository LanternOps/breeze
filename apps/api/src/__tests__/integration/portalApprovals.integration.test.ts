/**
 * Customer work approval W04 (#4617 spec §6.2, Review Focus #2 and #5): the
 * real portal routes over real Postgres, under the portal's own DB context —
 * ORGANIZATION scope with no partner access, exactly what portalAuthMiddleware
 * opens — so RLS on ticket_approval_requests / tickets is enforced.
 *
 * Pinned here:
 * - a billing contact who does NOT own the ticket lists and decides the
 *   request, while GET /tickets/:id still answers 404 for them;
 * - a requester-only (notify) contact lists it but is refused 403;
 * - another org's portal user cannot see or decide it (404);
 * - the stored decider is the SESSION portal user, whatever the body says
 *   (an identity field in the body is rejected 400);
 * - a disabled portal user is refused by the service (403);
 * - a stale revision is 409 REQUEST_CHANGED and releases nothing.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));
const { emitTicketEventMock } = vi.hoisted(() => ({ emitTicketEventMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketEvents')>()),
  emitTicketEvent: emitTicketEventMock,
}));

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { portalUsers, tickets } from '../../db/schema';
import * as timeSvc from '../../services/timeEntryService';
import { portalApprovalRoutes } from '../../routes/portal/approvals';
import { ticketRoutes } from '../../routes/portal/tickets';
import {
  actor, addContact, ctx, insertSettledEntry, readEntry, readRequest, seedApprovalFixture, type ApprovalFixture,
} from './ticketApprovalFixtures';

const RUN = !!process.env.DATABASE_URL;
const ago = (min: number) => new Date(Date.now() - min * 60_000);

type PortalUser = { id: string; orgId: string; email: string; name: string; contactId: string | null };

async function portalUser(orgId: string, email: string, o: { status?: string; contactId?: string | null } = {}): Promise<PortalUser> {
  const [u] = await withSystemDbAccessContext(() => db.insert(portalUsers).values({
    orgId, email, name: 'Portal person', status: o.status ?? 'active', contactId: o.contactId ?? null,
  }).returning({ id: portalUsers.id }));
  return { id: u!.id, orgId, email, name: 'Portal person', contactId: o.contactId ?? null };
}

/** The portal stack as portalAuthMiddleware leaves it: the session user + an org-only DB context. */
function portalApp(user: PortalUser) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { ...user, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', timezone: 'UTC',
    } as never);
    const portalCtx: DbAccessContext = {
      scope: 'organization', orgId: user.orgId, accessibleOrgIds: [user.orgId], accessiblePartnerIds: [], userId: null,
    };
    await withDbAccessContext(portalCtx, () => next());
  });
  app.route('/', ticketRoutes);
  app.route('/', portalApprovalRoutes);
  return app;
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'vitest' }, body: JSON.stringify(body) });

/**
 * A pending budget request on f.ticketId with a held 30-minute entry. The
 * ticket was opened by `requester@` (submitter email), not by the billing
 * contact `boss@`, who is the approver.
 */
async function pendingRequest(f: ApprovalFixture) {
  await addContact(f, 'boss@example.test', [{ role: 'billing' }]);
  await withSystemDbAccessContext(() => db.update(tickets).set({ submitterEmail: 'Requester@Example.test' }).where(eq(tickets.id, f.ticketId)));
  await insertSettledEntry(f, 120); // budget 120 consumed
  const held = await withDbAccessContext(ctx(f), () => timeSvc.createTimeEntry({
    ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true,
  }, actor(f)));
  expect(held.approvalHold).not.toBeNull();
  const requestId = held.approvalHold!.requestId;
  const req = await readRequest(requestId);
  expect(req.approverEmails).toEqual(['boss@example.test']);
  expect(req.notifyEmails).toEqual(['requester@example.test']);
  return { requestId, heldEntryId: held.id, revision: req.revision };
}

describe.runIf(RUN)('portal approvals (real routes, portal org scope)', () => {
  it('a billing contact who does not own the ticket lists and decides it; the ticket thread stays 404 for them', async () => {
    emitTicketEventMock.mockClear();
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    const { requestId, heldEntryId, revision } = await pendingRequest(f);
    const boss = await portalUser(f.orgId, 'Boss@Example.test'); // case differs from the frozen list
    const app = portalApp(boss);

    const ticketRes = await app.request(`/tickets/${f.ticketId}`);
    expect(ticketRes.status).toBe(404);

    const list = await app.request('/approvals');
    expect(list.status).toBe(200);
    const { data } = await list.json() as { data: Array<Record<string, unknown>> };
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: requestId, ticketId: f.ticketId, role: 'approver', canDecide: true, revision, status: 'pending' });
    const raw = JSON.stringify(data);
    expect(raw).not.toContain('requester@example.test');
    expect(raw).not.toContain('approverEmails');
    expect(raw).not.toContain(f.userId);

    const decided = await post(app, `/approvals/${requestId}/approve`, { revision, signerName: 'Bo Boss', note: 'OK' });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toEqual({ data: { status: 'approved', releasedEntryCount: 1, stillHeldEntryCount: 0 } });

    expect(await readRequest(requestId)).toMatchObject({
      status: 'approved', decisionOrigin: 'customer', decidedByPortalUserId: boss.id, decidedByUserId: null,
      signerName: 'Bo Boss', signerEmail: 'boss@example.test', decidedRevision: revision, userAgent: 'vitest',
    });
    expect((await readEntry(heldEntryId)).billingStatus).toBe('not_billed');
    // Queued only after the decision committed.
    expect(emitTicketEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.approval_decided', payload: expect.objectContaining({ requestId, status: 'approved' }),
    }));
  });

  it('a requester (notify-only) lists the request without actions and is refused 403', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    const { requestId, heldEntryId, revision } = await pendingRequest(f);
    const requester = await portalUser(f.orgId, 'requester@example.test');
    const app = portalApp(requester);

    const { data } = await (await app.request('/approvals')).json() as { data: Array<Record<string, unknown>> };
    expect(data).toEqual([expect.objectContaining({ id: requestId, role: 'notify', canDecide: false })]);

    const res = await post(app, `/approvals/${requestId}/approve`, { revision, signerName: 'Req' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_AN_APPROVER');
    expect((await readRequest(requestId)).status).toBe('pending');
    expect((await readEntry(heldEntryId)).billingStatus).toBe('awaiting_approval');
  });

  it('an approver-named user in ANOTHER org sees nothing and gets 404', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    const { requestId, revision } = await pendingRequest(f);
    const outsider = await portalUser(f.otherOrgId, 'boss@example.test');
    const app = portalApp(outsider);
    expect((await (await app.request('/approvals')).json()).data).toEqual([]);
    const res = await post(app, `/approvals/${requestId}/approve`, { revision, signerName: 'Boss' });
    expect(res.status).toBe(404);
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('a body naming another identity is rejected 400 and cannot change the actor', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    const { requestId, revision } = await pendingRequest(f);
    const requester = await portalUser(f.orgId, 'requester@example.test');
    const app = portalApp(requester);
    for (const extra of [{ email: 'boss@example.test' }, { approverEmail: 'boss@example.test' }, { portalUserId: requester.id }]) {
      const res = await post(app, `/approvals/${requestId}/approve`, { revision, signerName: 'Boss', ...extra });
      expect(res.status).toBe(400);
    }
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('a disabled portal user is refused by the decision service even with an approver email', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    const { requestId, revision } = await pendingRequest(f);
    // The route trusts the session (portalAuthMiddleware already blocks inactive
    // users); this proves the service is a second, independent refusal.
    const disabled = await portalUser(f.orgId, 'boss@example.test', { status: 'disabled' });
    const res = await post(portalApp(disabled), `/approvals/${requestId}/approve`, { revision, signerName: 'Boss' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_AN_APPROVER');
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('a stale revision is 409 REQUEST_CHANGED, releases nothing and emits nothing', async () => {
    emitTicketEventMock.mockClear();
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    const { requestId, heldEntryId, revision } = await pendingRequest(f);
    // A second held entry joins the request and bumps its revision.
    await withDbAccessContext(ctx(f), () => timeSvc.createTimeEntry({
      ticketId: f.ticketId, startedAt: ago(15), endedAt: new Date(), isBillable: true,
    }, actor(f)));
    expect((await readRequest(requestId)).revision).toBe(revision + 1);
    emitTicketEventMock.mockClear();

    const boss = await portalUser(f.orgId, 'boss@example.test');
    const res = await post(portalApp(boss), `/approvals/${requestId}/approve`, { revision, signerName: 'Boss' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REQUEST_CHANGED');
    expect((await readRequest(requestId)).status).toBe('pending');
    expect((await readEntry(heldEntryId)).billingStatus).toBe('awaiting_approval');
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });
});
