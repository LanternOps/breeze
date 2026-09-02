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
    addTicketComment: vi.fn(),
    claimMessageLink: vi.fn(),
    findLinkByMessageId: vi.fn(),
    createConfirmedContact: vi.fn(),
    findPortalUserByEmail: vi.fn(),
    insertEmailAuthoredComment: vi.fn(),
    ticketThreadAnchor: vi.fn(),
    writeAuditEvent: vi.fn(),
    getOrgPolicy: vi.fn(),
    applyDlp: vi.fn(),
    draftTicketFromEmail: vi.fn(),
    recordUsage: vi.fn(),
    getAnthropicClientForPartner: vi.fn(),
    resolveWireModel: vi.fn<(resolved: unknown, model: string) => { model: string; catalogPricing?: unknown }>((_resolved: unknown, model: string) => ({ model })),
    anthropicClient: { messages: { create: vi.fn() } },
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

// runOutsideDbContext/withSystemDbAccessContext passthroughs exist because the
// real ticketEmailLinks module (importActual'd below for normalizeMessageId)
// imports them at module load.
vi.mock('../../db', () => ({
  db: mockDb,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

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
  partners: {
    __table: 'partners',
    id: 'partners.id',
    aiForOfficeEnabled: 'partners.ai_for_office_enabled',
  },
}));

vi.mock('../../services/aiCostTracker', () => ({
  recordUsage: hoisted.recordUsage,
}));

vi.mock('../../services/ticketService', async (importOriginal) => ({
  // Real mapper: the route delegates its toSummary to it, and it's pure.
  toAddinTicketSummary: (await importOriginal<typeof import('../../services/ticketService')>()).toAddinTicketSummary,
  createTicket: hoisted.createTicket,
  getPortalUserForValidation: hoisted.getPortalUserForValidation,
  addTicketComment: hoisted.addTicketComment,
  TicketServiceError: class TicketServiceError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
      this.name = 'TicketServiceError';
    }
  },
}));

vi.mock('../../services/inboundEmail/emailComments', () => ({
  insertEmailAuthoredComment: hoisted.insertEmailAuthoredComment,
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
  findPortalUserByEmail: hoisted.findPortalUserByEmail,
}));

vi.mock('../../services/inboundEmail/outboundThreading', () => ({
  ticketThreadAnchor: hoisted.ticketThreadAnchor,
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: hoisted.writeAuditEvent,
}));

vi.mock('../../services/clientAiPolicy', () => ({
  getOrgPolicy: hoisted.getOrgPolicy,
}));

vi.mock('../../services/clientAiDlp', () => ({
  applyDlp: hoisted.applyDlp,
}));

vi.mock('../../services/officeAddin/aiEmailDraft', async (importOriginal) => ({
  draftTicketFromEmail: hoisted.draftTicketFromEmail,
  // Real error class: the route's failure-path metering branches on instanceof.
  EmailDraftFailedError: (await importOriginal<typeof import('../../services/officeAddin/aiEmailDraft')>())
    .EmailDraftFailedError,
}));

vi.mock('../../services/aiAgent', () => ({
  resolveDefaultModel: () => 'claude-x',
}));

vi.mock('../../services/llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {
    constructor() {
      super('AI is unavailable for this partner.');
      this.name = 'LlmUnavailableError';
    }
  },
  getAnthropicClientForPartner: hoisted.getAnthropicClientForPartner,
  resolveWireModel: hoisted.resolveWireModel,
}));

import { officeAddinTicketRoutes } from './tickets';
import { EmailDraftFailedError } from '../../services/officeAddin/aiEmailDraft';
import { LlmUnavailableError } from '../../services/llm/llmConfigResolver';

// --- db chain mock -----------------------------------------------------------
// `select(...).from(tickets).where(...).limit(1)` drains a queue of canned rows;
// `update(tickets).set(...).where(...)` records the SET payload.
let ticketSelectQueue: unknown[][] = [];
let updateSets: Record<string, unknown>[] = [];
// One entry per ticket SELECT, in order — the real drizzle condition object, so
// the presence/absence of the soft-delete predicate is inspectable.
let selectWhereArgs: string[] = [];
// The draft route's entitlement lookup (`select({ enabled: partners.aiForOfficeEnabled })`)
// is answered from its own slot rather than the ticket queue, so it never
// consumes a canned ticket row and the ticket-route tests are unaffected.
let partnerAiEnabled = true;

function primeDb() {
  mockDb.select.mockImplementation(
    ((cols?: Record<string, unknown>) => ({
      from: () => ({
        where: (...args: unknown[]) => {
          if (cols && 'enabled' in cols) {
            return { limit: () => Promise.resolve(partnerAiEnabled ? [{ enabled: true }] : [{ enabled: false }]) };
          }
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
  // Mirrors ./index.ts: the router registers '/draft', '/from-email' and
  // '/:id/link-email' and is mounted under '/tickets', keeping the external
  // paths the tests exercise unchanged.
  app.route('/tickets', officeAddinTicketRoutes);
  return app;
}

function post(body: unknown) {
  return makeApp().request('/tickets/from-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postDraft(body: unknown) {
  return makeApp().request('/tickets/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postLink(ticketId: string, body: unknown) {
  return makeApp().request(`/tickets/${ticketId}/link-email`, {
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
  partnerAiEnabled = true;
  primeDb();
  hoisted.findLinkByMessageId.mockResolvedValue(null);
  hoisted.ticketThreadAnchor.mockReturnValue('<ticket-' + NEW_TICKET_ID + '@tickets.example.com>');
  hoisted.createTicket.mockResolvedValue(ticketRow());
  hoisted.claimMessageLink.mockResolvedValue({ created: true, link: { id: 'link-1' } });
  hoisted.findPortalUserByEmail.mockResolvedValue(null);
  hoisted.insertEmailAuthoredComment.mockResolvedValue({ commentId: 'comment-1' });
  hoisted.addTicketComment.mockResolvedValue({ comment: { id: 'comment-1' }, firstResponseStamped: false });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  hoisted.getAnthropicClientForPartner.mockImplementation(async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new LlmUnavailableError();
    return {
      client: hoisted.anthropicClient,
      resolved: {
        source: 'platform',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: 'claude-x',
      },
    };
  });
  hoisted.getOrgPolicy.mockResolvedValue({ dlpConfig: {} });
  hoisted.applyDlp.mockResolvedValue({ action: 'allow', text: 'redacted body', redactions: [] });
  hoisted.draftTicketFromEmail.mockResolvedValue({
    subject: 'Fix Outlook crash',
    summary: 'The customer reports Outlook crashes on launch.',
    suggestedTimeMinutes: 15,
    inputTokens: 100,
    outputTokens: 50,
  });
  hoisted.recordUsage.mockResolvedValue(undefined);
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

describe('POST /tickets/:id/link-email', () => {
  const linkBody = {
    visibility: 'public' as const,
    from: { email: 'customer@acme.com', name: 'Customer Person' },
    internetMessageId: MSG_ID,
    subject: 'Printer is on fire',
    bodyText: 'Smoke everywhere.',
  };

  it('links a public email: insertEmailAuthoredComment, no firstResponseAt stamp, ledger row', async () => {
    ticketSelectQueue.push([ticketRow()]); // loadTicket(NEW_TICKET_ID)
    hoisted.findPortalUserByEmail.mockResolvedValue({ id: PORTAL_USER_ID, name: 'Stored Name' });
    hoisted.insertEmailAuthoredComment.mockResolvedValue({ commentId: 'comment-42' });

    const res = await postLink(NEW_TICKET_ID, linkBody);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ linked: true, commentId: 'comment-42' });

    expect(hoisted.findPortalUserByEmail).toHaveBeenCalledWith(ORG_A, 'customer@acme.com');
    expect(hoisted.insertEmailAuthoredComment).toHaveBeenCalledWith({
      ticketId: NEW_TICKET_ID,
      orgId: ORG_A,
      senderPortalUserId: PORTAL_USER_ID,
      authorName: 'Stored Name', // stored portal-user name preferred over the spoofable display name
      content: `From: Customer Person <customer@acme.com>\nSubject: Printer is on fire\n\nSmoke everywhere.`,
    });

    // Public link must NEVER go through addTicketComment — no firstResponseAt stamp.
    expect(hoisted.addTicketComment).not.toHaveBeenCalled();

    expect(hoisted.claimMessageLink).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: NEW_TICKET_ID,
        orgId: ORG_A,
        partnerId: PARTNER_ID,
        messageId: MSG_ID,
        origin: 'addin_link',
        visibility: 'public',
        linkedBy: USER_ID,
        commentId: 'comment-42',
      })
    );
    expect(hoisted.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'office_addin.ticket.email_linked', resourceId: NEW_TICKET_ID })
    );
  });

  it('links an internal note via addTicketComment as a technician-authored comment', async () => {
    ticketSelectQueue.push([ticketRow()]);
    hoisted.addTicketComment.mockResolvedValue({ comment: { id: 'comment-99' }, firstResponseStamped: false });

    const res = await postLink(NEW_TICKET_ID, { ...linkBody, visibility: 'internal' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ linked: true, commentId: 'comment-99' });

    expect(hoisted.addTicketComment).toHaveBeenCalledWith(
      NEW_TICKET_ID,
      {
        content: `From: Customer Person <customer@acme.com>\nSubject: Printer is on fire\n\nSmoke everywhere.`,
        isPublic: false,
      },
      expect.objectContaining({ userId: USER_ID, email: 'tech@partner.example' })
    );
    expect(hoisted.insertEmailAuthoredComment).not.toHaveBeenCalled();

    expect(hoisted.claimMessageLink).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'internal', origin: 'addin_link', commentId: 'comment-99' })
    );
  });

  it('replays idempotently when the message is already linked to THIS ticket: 200, no second comment', async () => {
    hoisted.findLinkByMessageId.mockResolvedValue({
      id: 'link-1',
      ticketId: NEW_TICKET_ID,
      orgId: ORG_A,
      partnerId: PARTNER_ID,
      messageId: MSG_ID,
      origin: 'addin_link',
      visibility: 'public',
      linkedBy: USER_ID,
      commentId: 'comment-1',
    });
    ticketSelectQueue.push([ticketRow()]); // loadTicket(NEW_TICKET_ID)

    const res = await postLink(NEW_TICKET_ID, linkBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ linked: true, alreadyLinked: true, commentId: 'comment-1' });
    expect(hoisted.insertEmailAuthoredComment).not.toHaveBeenCalled();
    expect(hoisted.addTicketComment).not.toHaveBeenCalled();
    expect(hoisted.claimMessageLink).not.toHaveBeenCalled();
  });

  it('409s when the message is already linked to a DIFFERENT ticket', async () => {
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
    ticketSelectQueue.push([ticketRow()]); // loadTicket(NEW_TICKET_ID)
    ticketSelectQueue.push([ticketRow({ id: OTHER_TICKET_ID, subject: 'Other ticket' })]); // respondToLinkConflict's loadTicket

    const res = await postLink(NEW_TICKET_ID, linkBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('message_linked_elsewhere');
    expect(body.ticket.id).toBe(OTHER_TICKET_ID);
    expect(hoisted.insertEmailAuthoredComment).not.toHaveBeenCalled();
    expect(hoisted.addTicketComment).not.toHaveBeenCalled();
  });

  it('409s ticket_closed with NO comment inserted when the target ticket is closed', async () => {
    ticketSelectQueue.push([
      ticketRow({ status: 'closed', internalNumber: 'T-2026-0007', emailThreadKey: '<old@tickets.example.com>' }),
    ]);

    const res = await postLink(NEW_TICKET_ID, linkBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: 'ticket_closed',
      ticket: { id: NEW_TICKET_ID, internalNumber: 'T-2026-0007', emailThreadKey: '<old@tickets.example.com>' },
    });
    expect(hoisted.insertEmailAuthoredComment).not.toHaveBeenCalled();
    expect(hoisted.addTicketComment).not.toHaveBeenCalled();
    expect(hoisted.claimMessageLink).not.toHaveBeenCalled();
  });

  it('404s when the target ticket is soft-deleted', async () => {
    ticketSelectQueue.push([]); // loadTicket excludeDeleted finds nothing
    const res = await postLink(NEW_TICKET_ID, linkBody);
    expect(res.status).toBe(404);
    expect(selectWhereArgs[0]).toContain('tickets.deleted_at');
    expect(hoisted.insertEmailAuthoredComment).not.toHaveBeenCalled();
  });

  it('404s when the target ticket lives in an org the technician cannot access', async () => {
    authRef.current = { accessibleOrgIds: [ORG_B] };
    ticketSelectQueue.push([ticketRow({ orgId: ORG_A })]);
    const res = await postLink(NEW_TICKET_ID, linkBody);
    expect(res.status).toBe(404);
    expect(hoisted.insertEmailAuthoredComment).not.toHaveBeenCalled();
  });

  it('creates the comment with no ledger row when the host supplies no internetMessageId, 201', async () => {
    ticketSelectQueue.push([ticketRow()]);
    const res = await postLink(NEW_TICKET_ID, { ...linkBody, internetMessageId: null });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ linked: true, commentId: 'comment-1' });
    expect(hoisted.findLinkByMessageId).not.toHaveBeenCalled();
    expect(hoisted.claimMessageLink).not.toHaveBeenCalled();
  });

  it('400s on an invalid body', async () => {
    ticketSelectQueue.push([ticketRow()]);
    const res = await postLink(NEW_TICKET_ID, { ...linkBody, visibility: 'nope' });
    expect(res.status).toBe(400);
  });
});

const draftBody = {
  orgId: ORG_A,
  subject: 'Outlook will not open',
  bodyText: 'My Outlook crashes every time I open it.',
};

describe('POST /tickets/draft', () => {
  it('returns a draft on the happy path, sending the DLP-redacted text to the model', async () => {
    const res = await postDraft(draftBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toEqual({
      subject: 'Fix Outlook crash',
      summary: 'The customer reports Outlook crashes on launch.',
      suggestedTimeMinutes: 15,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(hoisted.draftTicketFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: draftBody.subject,
        bodyText: 'redacted body',
        model: 'claude-x',
        partnerId: PARTNER_ID,
        client: hoisted.anthropicClient,
      })
    );
    expect(hoisted.getAnthropicClientForPartner).toHaveBeenCalledTimes(1);
    // Usage accounting: sessionless (null session id), org-scoped, real token counts.
    expect(hoisted.recordUsage).toHaveBeenCalledWith(
      null,
      ORG_A,
      'claude-x',
      100,
      50,
      false,
      'platform',
      undefined,
    );
  });

  it('sends the WIRE model to the drafter and meters catalog traffic at revision rates', async () => {
    const CATALOG_PRICING = {
      catalogEntryId: 'entry-1',
      revisionId: 'rev-1',
      inputCentsPerM: 300,
      outputCentsPerM: 1500,
      cacheReadCentsPerM: 30,
      cacheWriteCentsPerM: 375,
    };
    // A catalog endpoint speaks its own model ids; the platform-logical id
    // 404s at the provider and the SDK's list pricing must be ignored.
    hoisted.resolveWireModel.mockReturnValueOnce({
      model: 'anthropic/claude-x',
      catalogPricing: CATALOG_PRICING,
    });

    const res = await postDraft(draftBody);

    expect(res.status).toBe(200);
    expect(hoisted.resolveWireModel).toHaveBeenCalledWith(expect.anything(), 'claude-x');
    expect(hoisted.draftTicketFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-x' }),
    );
    expect(hoisted.recordUsage).toHaveBeenCalledWith(
      null, ORG_A, 'claude-x', 100, 50, false, 'platform', CATALOG_PRICING,
    );
  });

  /**
   * The SECOND fail-closed gate on this route (#3922 W3 review round 2). The
   * client resolving fine says nothing about the MODEL: a pinned revision that
   * dropped (or never verified) the partner's default model makes
   * `resolveWireModel` throw, and without this branch the request would 500 —
   * or, worse in an earlier shape, reach the provider with an untranslated id.
   */
  it('503s when the pinned revision has no verified mapping for the model', async () => {
    hoisted.resolveWireModel.mockImplementationOnce(() => {
      throw new LlmUnavailableError();
    });

    const res = await postDraft(draftBody);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    // Fail CLOSED: nothing is sent to the provider and nothing is metered.
    expect(hoisted.draftTicketFromEmail).not.toHaveBeenCalled();
    expect(hoisted.recordUsage).not.toHaveBeenCalled();
  });

  it('403s when the partner has no AI-for-Office entitlement, before the key/DLP/model', async () => {
    partnerAiEnabled = false;
    const res = await postDraft(draftBody);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'ai_not_enabled' });
    expect(hoisted.applyDlp).not.toHaveBeenCalled();
    expect(hoisted.draftTicketFromEmail).not.toHaveBeenCalled();
    expect(hoisted.recordUsage).not.toHaveBeenCalled();
  });

  it('still returns the draft when usage accounting throws', async () => {
    hoisted.recordUsage.mockRejectedValue(new Error('meter down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postDraft(draftBody);
    expect(res.status).toBe(200);
    expect(errSpy).toHaveBeenCalledWith('[office-addin] draft usage accounting failed', expect.any(Error));
    errSpy.mockRestore();
  });

  it('404s when the technician cannot access the org', async () => {
    authRef.current = { accessibleOrgIds: [ORG_B] };
    const res = await postDraft(draftBody);
    expect(res.status).toBe(404);
    expect(hoisted.draftTicketFromEmail).not.toHaveBeenCalled();
  });

  it('503s when the platform config has no API key, without calling DLP or the model', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await postDraft(draftBody);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'ai_unavailable' });
    expect(hoisted.applyDlp).not.toHaveBeenCalled();
    expect(hoisted.draftTicketFromEmail).not.toHaveBeenCalled();
  });

  it('proceeds with a partner BYOK config when no platform API key exists', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    hoisted.getAnthropicClientForPartner.mockResolvedValueOnce({
      client: hoisted.anthropicClient,
      resolved: {
        source: 'partner',
        partnerId: PARTNER_ID,
        apiKey: 'partner-key',
        model: 'claude-partner-model',
        configId: 'config-1',
        configVersion: 1,
      },
    });

    const res = await postDraft(draftBody);

    expect(res.status).toBe(200);
    expect(hoisted.draftTicketFromEmail).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER_ID,
      model: 'claude-partner-model',
      client: hoisted.anthropicClient,
    }));
    expect(hoisted.getAnthropicClientForPartner).toHaveBeenCalledTimes(1);
  });

  it('503s before DLP when the partner LLM config is unavailable', async () => {
    hoisted.getAnthropicClientForPartner.mockRejectedValueOnce(new LlmUnavailableError());

    const res = await postDraft(draftBody);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(hoisted.applyDlp).not.toHaveBeenCalled();
    expect(hoisted.draftTicketFromEmail).not.toHaveBeenCalled();
  });

  it('keeps the platform-key draft path unchanged when the platform key is configured', async () => {
    const res = await postDraft(draftBody);

    expect(res.status).toBe(200);
    expect(hoisted.getAnthropicClientForPartner).toHaveBeenCalledTimes(1);
    expect(hoisted.getAnthropicClientForPartner).toHaveBeenCalledWith(PARTNER_ID, {
      surface: 'one_shot_email_draft',
      orgId: ORG_A,
    });
    expect(hoisted.draftTicketFromEmail).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER_ID,
      orgId: ORG_A,
      model: 'claude-x',
      client: hoisted.anthropicClient,
    }));
  });

  it('422s when DLP blocks the body, and never calls the model', async () => {
    hoisted.applyDlp.mockResolvedValue({ action: 'block', blockReason: 'dlp_blocked:creditCard', redactions: [] });
    const res = await postDraft(draftBody);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: 'dlp_blocked' });
    expect(hoisted.draftTicketFromEmail).not.toHaveBeenCalled();
  });

  it('503s when the model call throws, and logs it instead of swallowing', async () => {
    hoisted.draftTicketFromEmail.mockRejectedValue(new Error('model exploded'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postDraft(draftBody);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'ai_unavailable' });
    expect(errSpy).toHaveBeenCalledWith('[office-addin] draft failed', expect.any(Error));
    // A plain Error carries no token counts — nothing to meter.
    expect(hoisted.recordUsage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('meters the burned tokens when the draft fails with accumulated attempt spend', async () => {
    hoisted.draftTicketFromEmail.mockRejectedValue(
      new EmailDraftFailedError('Failed to draft ticket from email: attempt 1: nope; attempt 2: nope', 180, 90)
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postDraft(draftBody);
    expect(res.status).toBe(503);
    expect(hoisted.recordUsage).toHaveBeenCalledWith(
      null,
      ORG_A,
      'claude-x',
      180,
      90,
      false,
      'platform',
      undefined,
    );
    errSpy.mockRestore();
  });

  it('meters failed BYOK draft spend against the exact client source', async () => {
    hoisted.getAnthropicClientForPartner.mockResolvedValueOnce({
      client: hoisted.anthropicClient,
      resolved: {
        source: 'partner',
        partnerId: PARTNER_ID,
        apiKey: 'partner-key',
        model: 'claude-partner-model',
        configId: 'config-1',
        configVersion: 1,
      },
    });
    hoisted.draftTicketFromEmail.mockRejectedValue(
      new EmailDraftFailedError('Failed to draft ticket from email: attempt 1: nope', 18, 9),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postDraft(draftBody);

    expect(res.status).toBe(503);
    expect(hoisted.getAnthropicClientForPartner).toHaveBeenCalledTimes(1);
    expect(hoisted.recordUsage).toHaveBeenCalledWith(
      null,
      ORG_A,
      'claude-partner-model',
      18,
      9,
      false,
      'partner_key',
      undefined,
    );
    errSpy.mockRestore();
  });

  it('failure-path metering stays best-effort: a metering throw still returns the 503', async () => {
    hoisted.draftTicketFromEmail.mockRejectedValue(
      new EmailDraftFailedError('Failed to draft ticket from email: attempt 1: nope', 10, 5)
    );
    hoisted.recordUsage.mockRejectedValue(new Error('meter down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postDraft(draftBody);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(errSpy).toHaveBeenCalledWith('[office-addin] draft usage accounting failed', expect.any(Error));
    errSpy.mockRestore();
  });

  it('skips failure-path metering when the failed draft burned zero tokens', async () => {
    hoisted.draftTicketFromEmail.mockRejectedValue(
      new EmailDraftFailedError('Failed to draft ticket from email: attempt 1: api down', 0, 0)
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postDraft(draftBody);
    expect(res.status).toBe(503);
    expect(hoisted.recordUsage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('503s when the model call exceeds the timeout', async () => {
    vi.useFakeTimers();
    hoisted.draftTicketFromEmail.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ subject: 's', summary: 'x', suggestedTimeMinutes: 5, inputTokens: 0, outputTokens: 0 }), 30_000))
    );
    const resPromise = postDraft(draftBody);
    await vi.advanceTimersByTimeAsync(20_001);
    const res = await resPromise;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'ai_unavailable' });
    vi.useRealTimers();
  });

  it('400s on an invalid body', async () => {
    const res = await postDraft({ ...draftBody, orgId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});
