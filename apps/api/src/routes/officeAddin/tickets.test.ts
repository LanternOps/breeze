import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const NEW_TICKET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_TICKET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLOSED_TICKET_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PORTAL_USER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type AuthState = { accessibleOrgIds: string[] | null };

const { authRef, mockDb, hoisted } = vi.hoisted(() => ({
  authRef: { current: { accessibleOrgIds: null as string[] | null } as AuthState },
  mockDb: { select: vi.fn(), update: vi.fn(), transaction: vi.fn() },
  hoisted: {
    createTicket: vi.fn(),
    getPortalUserForValidation: vi.fn(),
    claimMessageLink: vi.fn(),
    findLinkByMessageId: vi.fn(),
    createConfirmedContact: vi.fn(),
    ticketThreadAnchor: vi.fn(),
    writeAuditEvent: vi.fn(),
  },
}));

vi.mock('../../middleware/officeAddinTechAuth', () => ({
  officeAddinTechAuthMiddleware: vi.fn(async (c: any, next: any) => {
    const accessibleOrgIds = authRef.current.accessibleOrgIds;
    c.set('officeAddinAuth', {
      userId: USER_ID,
      partnerId: PARTNER_ID,
      bindingId: 'binding-1',
      token: 'tok',
      user: { email: 'tech@partner.example', name: 'Tech Person' },
      accessibleOrgIds,
      partnerOrgAccess: accessibleOrgIds === null ? 'all' : 'selected',
      permissions: {},
      canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
      canAccessSite: () => true,
    });
    return next();
  }),
  requireAddinCapability: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../db', () => ({ db: mockDb }));

vi.mock('../../db/schema', () => ({
  tickets: {
    __table: 'tickets',
    id: 'tickets.id',
    orgId: 'tickets.org_id',
    partnerId: 'tickets.partner_id',
    internalNumber: 'tickets.internal_number',
    subject: 'tickets.subject',
    status: 'tickets.status',
    priority: 'tickets.priority',
    updatedAt: 'tickets.updated_at',
    submitterEmail: 'tickets.submitter_email',
    emailThreadKey: 'tickets.email_thread_key',
    emailMessageId: 'tickets.email_message_id',
    deletedAt: 'tickets.deleted_at',
  },
}));

vi.mock('../../services/ticketService', () => ({
  createTicket: hoisted.createTicket,
  getPortalUserForValidation: hoisted.getPortalUserForValidation,
  TicketServiceError: class TicketServiceError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
      this.name = 'TicketServiceError';
    }
  },
}));

vi.mock('../../services/ticketEmailLinks', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketEmailLinks')>(
    '../../services/ticketEmailLinks'
  );
  return {
    normalizeMessageId: actual.normalizeMessageId,
    claimMessageLink: hoisted.claimMessageLink,
    findLinkByMessageId: hoisted.findLinkByMessageId,
  };
});

vi.mock('../../services/officeAddin/addinContacts', () => ({
  createConfirmedContact: hoisted.createConfirmedContact,
}));

vi.mock('../../services/inboundEmail/outboundThreading', () => ({
  ticketThreadAnchor: hoisted.ticketThreadAnchor,
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: hoisted.writeAuditEvent,
}));

import { officeAddinTicketRoutes } from './tickets';

// --- db chain mock -----------------------------------------------------------
// `select(...).from(tickets).where(...).limit(1)` drains a queue of canned rows;
// `update(tickets).set(...).where(...)` records the SET payload.
let ticketSelectQueue: unknown[][] = [];
let updateSets: Record<string, unknown>[] = [];
// One entry per ticket SELECT, in order — the real drizzle condition object, so
// the presence/absence of the soft-delete predicate is inspectable.
let selectWhereArgs: string[] = [];

function primeDb() {
  mockDb.select.mockImplementation(
    ((_cols?: unknown) => ({
      from: () => ({
        where: (...args: unknown[]) => {
          selectWhereArgs.push(JSON.stringify(args));
          return { limit: () => Promise.resolve(ticketSelectQueue.shift() ?? []) };
        },
      }),
    })) as never
  );
  mockDb.update.mockImplementation(
    (() => ({
      set: (values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: () => Promise.resolve([]) };
      },
    })) as never
  );
  // Nested transaction == savepoint in production (drizzle postgres-js). Here it
  // just runs the callback so a thrown MessageClaimRaceError still propagates to
  // the route's catch — the ACTUAL rollback is proven in
  // __tests__/integration/ticketEmailLinksClaim.integration.test.ts.
  mockDb.transaction.mockImplementation((async (cb: (tx: unknown) => Promise<unknown>) => cb({})) as never);
}

function makeApp() {
  const app = new Hono();
  app.route('/', officeAddinTicketRoutes);
  return app;
}

function post(body: unknown) {
  return makeApp().request('/tickets/from-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const MSG_ID = '<abc-123@customer.example>';

const baseBody = {
  orgId: ORG_A,
  subject: 'Printer is on fire',
  description: 'Smoke everywhere.',
  from: { email: 'customer@acme.com', name: 'Customer Person' },
  internetMessageId: MSG_ID,
  requester: { kind: 'raw' as const },
};

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NEW_TICKET_ID,
    orgId: ORG_A,
    partnerId: PARTNER_ID,
    internalNumber: 'T-2026-0042',
    subject: 'Printer is on fire',
    status: 'new',
    priority: 'normal',
    updatedAt: new Date('2026-08-15T00:00:00Z'),
    submitterEmail: 'customer@acme.com',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { accessibleOrgIds: null };
  ticketSelectQueue = [];
  updateSets = [];
  selectWhereArgs = [];
  primeDb();
  hoisted.findLinkByMessageId.mockResolvedValue(null);
  hoisted.ticketThreadAnchor.mockReturnValue('<ticket-' + NEW_TICKET_ID + '@tickets.example.com>');
  hoisted.createTicket.mockResolvedValue(ticketRow());
  hoisted.claimMessageLink.mockResolvedValue({ created: true, link: { id: 'link-1' } });
});

describe('POST /tickets/from-email', () => {
  it('creates an email-source ticket, stamps threading, and claims the message id', async () => {
    const res = await post(baseBody);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.alreadyExisted).toBe(false);
    expect(body.ticket.id).toBe(NEW_TICKET_ID);
    expect(body.ticket.internalNumber).toBe('T-2026-0042');
    expect(body.ticket.matchesSubmitter).toBe(true);

    const [input, actor] = hoisted.createTicket.mock.calls[0]!;
    expect(input).toMatchObject({
      source: 'email',
      orgId: ORG_A,
      subject: 'Printer is on fire',
      description: 'Smoke everywhere.',
      submitterEmail: 'customer@acme.com',
      submitterName: 'Customer Person',
    });
    expect(input.submittedBy ?? null).toBeNull();
    expect(actor).toMatchObject({ userId: USER_ID, email: 'tech@partner.example' });

    // Threading stamp: the customer's own Message-ID + the generated anchor.
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toEqual({
      emailMessageId: MSG_ID,
      emailThreadKey: `<ticket-${NEW_TICKET_ID}@tickets.example.com>`,
    });

    expect(hoisted.claimMessageLink).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: NEW_TICKET_ID,
        orgId: ORG_A,
        partnerId: PARTNER_ID,
        messageId: MSG_ID,
        origin: 'addin_create',
        visibility: 'public',
        linkedBy: USER_ID,
      })
    );

    expect(hoisted.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'office_addin.ticket.created_from_email', resourceId: NEW_TICKET_ID })
    );
  });

  it('falls back to the customer Message-ID as the thread key when no inbound domain is configured', async () => {
    hoisted.ticketThreadAnchor.mockReturnValue(null);
    const res = await post(baseBody);
    expect(res.status).toBe(201);
    expect(updateSets[0]).toEqual({ emailMessageId: MSG_ID, emailThreadKey: MSG_ID });
  });

  it('replays idempotently: an already-linked message in the same org returns 200 with the original ticket', async () => {
    hoisted.findLinkByMessageId.mockResolvedValue({
      id: 'link-1',
      ticketId: OTHER_TICKET_ID,
      orgId: ORG_A,
      partnerId: PARTNER_ID,
      messageId: MSG_ID,
      origin: 'addin_create',
      visibility: 'public',
      linkedBy: USER_ID,
      commentId: null,
    });
    ticketSelectQueue.push([ticketRow({ id: OTHER_TICKET_ID, subject: 'Original' })]);

    const res = await post(baseBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyExisted).toBe(true);
    expect(body.ticket.id).toBe(OTHER_TICKET_ID);
    expect(hoisted.createTicket).not.toHaveBeenCalled();
    expect(hoisted.claimMessageLink).not.toHaveBeenCalled();
  });

  it('409s when the message is already linked to a ticket in a different org', async () => {
    hoisted.findLinkByMessageId.mockResolvedValue({
      id: 'link-1',
      ticketId: OTHER_TICKET_ID,
      orgId: ORG_B,
      partnerId: PARTNER_ID,
      messageId: MSG_ID,
      origin: 'inbound',
      visibility: 'public',
      linkedBy: null,
      commentId: null,
    });
    ticketSelectQueue.push([ticketRow({ id: OTHER_TICKET_ID, orgId: ORG_B, subject: 'Poller ticket' })]);

    const res = await post(baseBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('message_linked_elsewhere');
    expect(body.ticket.id).toBe(OTHER_TICKET_ID);
    expect(hoisted.createTicket).not.toHaveBeenCalled();
  });

  it('409s with no ticket body when the message is linked inside an org the technician cannot see', async () => {
    authRef.current = { accessibleOrgIds: [ORG_A] };
    hoisted.findLinkByMessageId.mockResolvedValue({
      id: 'link-1',
      ticketId: OTHER_TICKET_ID,
      orgId: ORG_B, // outside the grant
      partnerId: PARTNER_ID,
      messageId: MSG_ID,
      origin: 'inbound',
      visibility: 'public',
      linkedBy: null,
      commentId: null,
    });

    const res = await post(baseBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'message_linked_elsewhere', ticket: null });
    expect(mockDb.select).not.toHaveBeenCalled(); // never even loads the hidden ticket
  });

  it('losing the claim race rolls the created ticket back and returns the winner association', async () => {
    hoisted.claimMessageLink.mockResolvedValue({
      created: false,
      existing: {
        id: 'link-1',
        ticketId: OTHER_TICKET_ID,
        orgId: ORG_A,
        partnerId: PARTNER_ID,
        messageId: MSG_ID,
        origin: 'inbound',
        visibility: 'public',
        linkedBy: null,
        commentId: null,
      },
    });
    ticketSelectQueue.push([ticketRow({ id: OTHER_TICKET_ID, subject: 'Winner' })]);

    const res = await post(baseBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyExisted).toBe(true);
    expect(body.ticket.id).toBe(OTHER_TICKET_ID);
    // The create+claim ran inside a nested transaction (savepoint) so the throw
    // discards the losing ticket rather than the whole request.
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // No audit event for a ticket that no longer exists.
    expect(hoisted.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('creates a confirmed contact and sets it as the requester', async () => {
    hoisted.createConfirmedContact.mockResolvedValue({ portalUserId: PORTAL_USER_ID });
    const res = await post({
      ...baseBody,
      requester: { kind: 'create_contact', email: 'New.Person@acme.com', name: 'New Person' },
    });
    expect(res.status).toBe(201);
    expect(hoisted.createConfirmedContact).toHaveBeenCalledWith(ORG_A, {
      email: 'New.Person@acme.com',
      name: 'New Person',
    });
    expect(hoisted.createTicket.mock.calls[0]![0].submittedBy).toBe(PORTAL_USER_ID);
  });

  it('404s when the named portal-user requester belongs to another org', async () => {
    hoisted.getPortalUserForValidation.mockResolvedValue({
      id: PORTAL_USER_ID,
      orgId: ORG_B,
      name: 'Elsewhere',
      email: 'x@b.com',
    });
    const res = await post({ ...baseBody, requester: { kind: 'portal_user', id: PORTAL_USER_ID } });
    expect(res.status).toBe(404);
    expect(hoisted.createTicket).not.toHaveBeenCalled();
  });

  it('404s when the org is outside the technician accessible set', async () => {
    authRef.current = { accessibleOrgIds: [ORG_B] };
    const res = await post(baseBody);
    expect(res.status).toBe(404);
    expect(hoisted.createTicket).not.toHaveBeenCalled();
  });

  it('carries the closed ticket thread key and description prefix for a follow-up', async () => {
    ticketSelectQueue.push([
      ticketRow({
        id: CLOSED_TICKET_ID,
        status: 'closed',
        internalNumber: 'T-2026-0001',
        emailThreadKey: '<ticket-old@tickets.example.com>',
      }),
    ]);

    const res = await post({ ...baseBody, followUpOf: { ticketId: CLOSED_TICKET_ID } });
    expect(res.status).toBe(201);
    expect(hoisted.createTicket.mock.calls[0]![0].description).toBe(
      'Re: T-2026-0001 (continued)\n\nSmoke everywhere.'
    );
    expect(updateSets[0]).toEqual({
      emailMessageId: MSG_ID,
      emailThreadKey: '<ticket-old@tickets.example.com>',
    });
  });

  it('404s on a cross-org follow-up even when the technician can reach both orgs', async () => {
    authRef.current = { accessibleOrgIds: [ORG_A, ORG_B] };
    // Closed, reachable, same partner — but it lives in ORG_B while the new
    // ticket is requested in ORG_A. Carrying its thread key would hijack ORG_B's
    // thread onto an ORG_A ticket (findTicketInPartner matches partner-wide).
    ticketSelectQueue.push([
      ticketRow({
        id: CLOSED_TICKET_ID,
        orgId: ORG_B,
        status: 'closed',
        internalNumber: 'T-2026-0001',
        emailThreadKey: '<ticket-orgb@tickets.example.com>',
      }),
    ]);

    const res = await post({ ...baseBody, followUpOf: { ticketId: CLOSED_TICKET_ID } });
    expect(res.status).toBe(404);
    expect(hoisted.createTicket).not.toHaveBeenCalled();
  });

  it('excludes soft-deleted tickets from the follow-up lookup but not from the link fast path', async () => {
    ticketSelectQueue.push([
      ticketRow({ id: CLOSED_TICKET_ID, status: 'closed', emailThreadKey: '<old@x>' }),
    ]);
    await post({ ...baseBody, followUpOf: { ticketId: CLOSED_TICKET_ID } });
    // A deleted closed original must not spawn a continuation (threadMatcher.ts).
    expect(selectWhereArgs[0]).toContain('tickets.deleted_at');

    // The fast path must still resolve a link whose ticket was soft-deleted —
    // hiding it would mint a duplicate for an already-claimed message.
    selectWhereArgs = [];
    hoisted.findLinkByMessageId.mockResolvedValue({
      id: 'link-1',
      ticketId: OTHER_TICKET_ID,
      orgId: ORG_A,
      partnerId: PARTNER_ID,
      messageId: MSG_ID,
      origin: 'inbound',
      visibility: 'public',
      linkedBy: null,
      commentId: null,
    });
    ticketSelectQueue.push([ticketRow({ id: OTHER_TICKET_ID })]);
    const res = await post(baseBody);
    expect(res.status).toBe(200);
    expect(selectWhereArgs[0]).not.toContain('tickets.deleted_at');
  });

  it('400s when the follow-up target is not closed', async () => {
    ticketSelectQueue.push([ticketRow({ id: CLOSED_TICKET_ID, status: 'open' })]);
    const res = await post({ ...baseBody, followUpOf: { ticketId: CLOSED_TICKET_ID } });
    expect(res.status).toBe(400);
    expect(hoisted.createTicket).not.toHaveBeenCalled();
  });

  it('creates the ticket with no ledger row when the host supplies no internetMessageId', async () => {
    const res = await post({ ...baseBody, internetMessageId: null });
    expect(res.status).toBe(201);
    expect(hoisted.findLinkByMessageId).not.toHaveBeenCalled();
    expect(hoisted.claimMessageLink).not.toHaveBeenCalled();
    expect(updateSets[0]).toEqual({ emailMessageId: null, emailThreadKey: `<ticket-${NEW_TICKET_ID}@tickets.example.com>` });
  });

  it('400s on an invalid body', async () => {
    const res = await post({ ...baseBody, subject: '' });
    expect(res.status).toBe(400);
  });
});
