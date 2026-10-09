import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { TicketServiceError } from '../../services/ticketService';
import { TicketExternalRefConflictError } from '../../services/ticketExternalRefs';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const TICKET_ID = '44444444-4444-4444-8444-444444444444';
const COMMENT_ID = '55555555-5555-4555-8555-555555555555';
const PRINCIPAL_ID = '66666666-6666-4666-8666-666666666666';
const KEY_ID = '77777777-7777-4777-8777-777777777777';
const USER_ID = '88888888-8888-4888-8888-888888888888';

const mocks = vi.hoisted(() => ({
  accessibleOrgIds: [] as string[],
  partnerContexts: [] as unknown[],
  select: vi.fn(),
  createTicket: vi.fn(),
  updateTicketFields: vi.fn(),
  changeTicketStatus: vi.fn(),
  assignTicket: vi.fn(),
  addTicketComment: vi.fn(),
  findIdempotencyReplay: vi.fn(),
  claimIdempotency: vi.fn(),
  linkIdempotencyResource: vi.fn(),
  upsertTicketExternalRef: vi.fn(),
  clearTicketExternalRef: vi.fn(),
  ticketExternalRefsFor: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: mocks.select },
  hasDbAccessContext: () => true,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (ctx: unknown, fn: () => unknown) => {
    mocks.partnerContexts.push(ctx);
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      name: 'PSA Bridge',
      rateLimit: 1000,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) => {
    const principal = c.get('partnerApiPrincipal');
    return required.every((scope) => principal.scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403);
  },
}));
vi.mock('../../services/ticketService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ticketService')>();
  return {
    ...actual,
    createTicket: mocks.createTicket,
    updateTicketFields: mocks.updateTicketFields,
    changeTicketStatus: mocks.changeTicketStatus,
    assignTicket: mocks.assignTicket,
    addTicketComment: mocks.addTicketComment,
  };
});
vi.mock('../../services/ticketExternalRefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ticketExternalRefs')>();
  return {
    ...actual,
    upsertTicketExternalRef: mocks.upsertTicketExternalRef,
    clearTicketExternalRef: mocks.clearTicketExternalRef,
    ticketExternalRefsFor: mocks.ticketExternalRefsFor,
  };
});
vi.mock('./idempotency', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./idempotency')>();
  return {
    ...actual,
    findIdempotencyReplay: mocks.findIdempotencyReplay,
    claimIdempotency: mocks.claimIdempotency,
    linkIdempotencyResource: mocks.linkIdempotencyResource,
  };
});

import { partnerApiRoutes } from './index';
import { partnerTicketCommentWriteResponseSchema, partnerTicketWriteResponseSchema } from './schemas';

type QueryResult = unknown[] | Error;
let selectResults: QueryResult[] = [];
function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => promise),
  };
  return builder;
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID, ticketNumber: 'ABC123', internalNumber: 'T-2026-0001',
    subject: 'Printer offline', description: null, category: null,
    status: 'new', statusId: null, priority: 'normal', source: 'api', workKind: 'support',
    categoryId: null, assignedTo: null, deviceId: null,
    requesterContactId: null, submittedBy: null, submitterName: null, submitterEmail: null,
    tags: [], customFields: null, externalTicketId: null, externalTicketUrl: null,
    dueDate: null, firstResponseAt: null, resolvedAt: null, closedAt: null,
    pendingReason: null, resolutionNote: null, responseSlaMinutes: null, resolutionSlaMinutes: null,
    slaBreachedAt: null, slaBreachReason: null, slaPausedAt: null, slaPausedMinutes: 0,
    emailMessageId: null, emailThreadKey: null, closedBy: null, deletedAt: null, deletedBy: null,
    createdAt: new Date('2026-09-26T12:00:00.000Z'), updatedAt: new Date('2026-09-26T12:00:00.000Z'),
    fieldProvenance: {}, partnerFeedXid: '900',
    ...overrides,
  };
}

// The feed projection getPartnerTicketOr404 selects (changeXid instead of partnerFeedXid).
function foundRow(overrides: Record<string, unknown> = {}) {
  const { partnerFeedXid, ...rest } = ticketRow(overrides);
  return { ...rest, changeXid: String(partnerFeedXid) };
}

function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID, ticketId: TICKET_ID, portalUserId: null, userId: null, authorName: 'PSA Bridge', authorType: 'internal',
    content: 'Mirrored note', isPublic: false, attachments: [], commentType: 'internal', oldValue: null, newValue: null,
    deletedAt: null, editedAt: null, createdAt: new Date('2026-09-26T12:05:00.000Z'),
    originPrincipalKind: 'service_principal', originPrincipalId: PRINCIPAL_ID,
    agentRunId: null, proposedByRunId: null,
    ...overrides,
  };
}

const ref = (externalId: string, externalUrl: string | null = null) => ({ ticketId: TICKET_ID, externalId, externalUrl });
const ACTOR = { kind: 'service_principal', principalId: PRINCIPAL_ID, keyId: KEY_ID, name: 'PSA Bridge' };

let app: Hono;
function send(path: string, method: string, body: unknown, extra: Record<string, string> = {}, scope = 'tickets:write') {
  return app.request(path, {
    method,
    headers: { 'X-API-Key': 'test-key', 'X-Test-Scopes': scope, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const createBody = { orgId: ORG_ID, subject: 'Printer offline', description: 'Floor 3', priority: 'high', externalTicketId: 'PSA-1' };

describe('partner tickets write surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    mocks.partnerContexts.length = 0;
    mocks.accessibleOrgIds = [ORG_ID, OTHER_ORG_ID];
    mocks.select.mockImplementation(() => query(selectResults.shift() ?? []));
    mocks.createTicket.mockResolvedValue(ticketRow({ priority: 'high', description: 'Floor 3' }));
    mocks.updateTicketFields.mockResolvedValue(ticketRow({ subject: 'Renamed' }));
    mocks.changeTicketStatus.mockResolvedValue(ticketRow({ status: 'resolved', resolutionNote: 'done' }));
    mocks.assignTicket.mockResolvedValue(ticketRow({ assignedTo: USER_ID, status: 'open' }));
    mocks.addTicketComment.mockResolvedValue({ comment: commentRow(), firstResponseStamped: false, attachments: [] });
    mocks.findIdempotencyReplay.mockResolvedValue({ kind: 'none' });
    mocks.claimIdempotency.mockResolvedValue({ id: 'claim-1' });
    mocks.linkIdempotencyResource.mockResolvedValue(undefined);
    mocks.upsertTicketExternalRef.mockImplementation(async (input: { externalId: string; externalUrl?: string | null }) => ref(input.externalId, input.externalUrl ?? null));
    mocks.clearTicketExternalRef.mockResolvedValue(undefined);
    mocks.ticketExternalRefsFor.mockResolvedValue(new Map());
    app = new Hono();
    app.route('/', partnerApiRoutes);
  });

  it('requires tickets:write on every route — tickets:read is not enough', async () => {
    expect((await send('/tickets', 'POST', createBody, {}, 'tickets:read')).status).toBe(403);
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { subject: 'x' }, {}, 'tickets:read')).status).toBe(403);
    expect((await send(`/tickets/${TICKET_ID}/status`, 'POST', { status: 'open' }, {}, 'tickets:read')).status).toBe(403);
    expect((await send(`/tickets/${TICKET_ID}/assign`, 'POST', { assigneeId: null }, {}, 'tickets:read')).status).toBe(403);
    expect((await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: 'x', isPublic: false }, {}, 'tickets:read')).status).toBe(403);
    expect(mocks.createTicket).not.toHaveBeenCalled();
  });

  it('POST /tickets creates through ticketService with source=api and a service_principal actor (principal id, not key id), in a partner context', async () => {
    const res = await send('/tickets', 'POST', { ...createBody, externalTicketUrl: 'https://psa.example/1' });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = partnerTicketWriteResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ id: TICKET_ID, orgId: ORG_ID });
    expect(body.data).toMatchObject({
      id: TICKET_ID, externalTicketId: 'PSA-1', externalTicketUrl: 'https://psa.example/1', priority: 'high', changeVersion: '900',
    });
    expect(body.idempotencyReplay).toBeUndefined();

    expect(mocks.createTicket).toHaveBeenCalledTimes(1);
    const [input, actor] = mocks.createTicket.mock.calls[0]!;
    expect(input).toMatchObject({ orgId: ORG_ID, subject: 'Printer offline', source: 'api' });
    // The external ref is this principal's row, never a tickets column.
    expect(input).not.toHaveProperty('externalTicketId');
    expect(input).not.toHaveProperty('externalTicketUrl');
    expect(input).not.toHaveProperty('formId');
    expect(actor).toEqual(ACTOR);
    // No orgId: the service reads the ref's org from the ticket row (#7490 review).
    expect(mocks.upsertTicketExternalRef).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID, partnerId: PARTNER_ID, ticketId: TICKET_ID,
      externalId: 'PSA-1', externalUrl: 'https://psa.example/1',
    });
    expect(mocks.partnerContexts).toEqual([expect.objectContaining({
      scope: 'partner', orgId: null, accessibleOrgIds: [ORG_ID, OTHER_ORG_ID], accessiblePartnerIds: [PARTNER_ID], userId: null,
    })]);
    // No idempotency header: no claim.
    expect(mocks.findIdempotencyReplay).not.toHaveBeenCalled();
    expect(mocks.claimIdempotency).not.toHaveBeenCalled();
  });

  it('POST /tickets without an external id writes no ref', async () => {
    const res = await send('/tickets', 'POST', { orgId: ORG_ID, subject: 'Plain' });
    expect(res.status).toBe(201);
    expect(mocks.upsertTicketExternalRef).not.toHaveBeenCalled();
    expect(partnerTicketWriteResponseSchema.parse(await res.json()).data?.externalTicketId).toBeNull();
  });

  it('POST /tickets accepts a dueDate with and without an idempotency key (the fingerprint survives zod\'s Date coercion)', async () => {
    const withDue = { ...createBody, dueDate: '2026-10-01T00:00:00.000Z' };
    const plain = await send('/tickets', 'POST', withDue);
    expect(plain.status, await plain.clone().text()).toBe(201);
    const keyed = await send('/tickets', 'POST', withDue, { 'X-Idempotency-Key': 'due-1' });
    expect(keyed.status, await keyed.clone().text()).toBe(201);
    expect(mocks.createTicket.mock.calls[0]![0]).toMatchObject({ dueDate: new Date('2026-10-01T00:00:00.000Z') });
    expect(mocks.findIdempotencyReplay).toHaveBeenCalledTimes(1);
  });

  it('POST /tickets refuses an org outside the principal set (403) and never accepts source/formId/submittedBy', async () => {
    expect((await send('/tickets', 'POST', { ...createBody, orgId: FOREIGN_ORG_ID })).status).toBe(403);
    expect((await send('/tickets', 'POST', { ...createBody, source: 'manual' })).status).toBe(400);
    expect((await send('/tickets', 'POST', { ...createBody, formId: TICKET_ID })).status).toBe(400);
    expect((await send('/tickets', 'POST', { ...createBody, submittedBy: USER_ID })).status).toBe(400);
    expect((await send('/tickets', 'POST', { orgId: ORG_ID })).status).toBe(400); // subject required
    expect((await send('/tickets', 'POST', { ...createBody, subject: 'bad\u0000subject' })).status).toBe(400);
    expect((await send('/tickets', 'POST', { ...createBody, externalTicketUrl: 'ftp://psa.example/1' })).status).toBe(400);
    expect(mocks.createTicket).not.toHaveBeenCalled();
  });

  it('POST /tickets with X-Idempotency-Key: claims before creating, links the ticket after, and replays a retry', async () => {
    const first = await send('/tickets', 'POST', createBody, { 'X-Idempotency-Key': 'psa-1' });
    expect(first.status).toBe(201);
    expect(mocks.findIdempotencyReplay).toHaveBeenCalledWith(expect.anything(), 'tickets.create', 'psa-1', expect.stringMatching(/^[a-f0-9]{64}$/));
    // A create claim has no ticket yet; the link binds it to the one created.
    expect(mocks.claimIdempotency).toHaveBeenCalledWith(expect.objectContaining({ route: 'tickets.create', key: 'psa-1', orgId: ORG_ID, ticketId: null }));
    expect(mocks.linkIdempotencyResource).toHaveBeenCalledWith('claim-1', TICKET_ID, TICKET_ID);
    // Order: claim, create, link.
    const order = [mocks.claimIdempotency, mocks.createTicket, mocks.linkIdempotencyResource].map((m) => m.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // Retry: answered from the claim, re-read through the partner-bound lookup
    // (with this principal's ref), no second create.
    mocks.findIdempotencyReplay.mockResolvedValueOnce({ kind: 'replay', resourceId: TICKET_ID });
    mocks.ticketExternalRefsFor.mockResolvedValueOnce(new Map([[TICKET_ID, ref('PSA-1')]]));
    selectResults = [[foundRow()]];
    const retry = await send('/tickets', 'POST', createBody, { 'X-Idempotency-Key': 'psa-1' });
    expect(retry.status).toBe(200);
    const body = partnerTicketWriteResponseSchema.parse(await retry.json());
    expect(body.idempotencyReplay).toBe(true);
    expect(body.data).toMatchObject({ id: TICKET_ID, externalTicketId: 'PSA-1' });
    expect(mocks.createTicket).toHaveBeenCalledTimes(1);
  });

  it('POST /tickets maps idempotency mismatch → 409, lost race → 409, a replay whose ticket is gone → 404, bad header → 400', async () => {
    mocks.findIdempotencyReplay.mockResolvedValueOnce({ kind: 'mismatch' });
    const reused = await send('/tickets', 'POST', createBody, { 'X-Idempotency-Key': 'psa-1' });
    expect(reused.status).toBe(409);
    expect((await reused.json()).code).toBe('partner_tickets_idempotency_key_reused');

    mocks.findIdempotencyReplay.mockResolvedValueOnce({ kind: 'none' });
    mocks.claimIdempotency.mockResolvedValueOnce(null);
    const raced = await send('/tickets', 'POST', createBody, { 'X-Idempotency-Key': 'psa-1' });
    expect(raced.status).toBe(409);
    expect((await raced.json()).code).toBe('partner_tickets_idempotency_in_flight');

    // The ticket the claim created has since been soft-deleted or moved out
    // of the principal's set: the partner-bound re-read finds nothing.
    mocks.findIdempotencyReplay.mockResolvedValueOnce({ kind: 'replay', resourceId: TICKET_ID });
    selectResults = [[]];
    const gone = await send('/tickets', 'POST', createBody, { 'X-Idempotency-Key': 'psa-1' });
    expect(gone.status).toBe(404);
    expect((await gone.json()).code).toBe('partner_ticket_not_found');

    const bad = await send('/tickets', 'POST', createBody, { 'X-Idempotency-Key': 'x'.repeat(129) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('partner_tickets_invalid_idempotency_key');
    expect(mocks.createTicket).not.toHaveBeenCalled();
  });

  it('passes a TicketServiceError through with its status and code, and maps the external-ref conflict to 409 EXTERNAL_ID_CONFLICT', async () => {
    mocks.createTicket.mockRejectedValueOnce(new TicketServiceError('Requester belongs to a different organization', 400, 'REQUESTER_WRONG_ORG'));
    const bad = await send('/tickets', 'POST', createBody);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Requester belongs to a different organization', code: 'REQUESTER_WRONG_ORG' });

    mocks.upsertTicketExternalRef.mockRejectedValueOnce(new TicketExternalRefConflictError({
      externalTicketId: 'PSA-1', existingTicketId: OTHER_ORG_ID, existingDeleted: true,
    }));
    const res = await send('/tickets', 'POST', createBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'External ticket id already in use for this integration',
      code: 'EXTERNAL_ID_CONFLICT',
      details: { externalTicketId: 'PSA-1', existingTicketId: OTHER_ORG_ID, existingDeleted: true },
    });
  });

  it('PATCH /tickets/:id authorizes the ticket first, rejects status/assignee/SLA keys and empty bodies', async () => {
    selectResults = [[]];
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { subject: 'x' })).status).toBe(404);
    expect(mocks.updateTicketFields).not.toHaveBeenCalled();

    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', {})).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { status: 'open' })).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { assigneeId: USER_ID })).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { responseSlaMinutes: 5 })).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { submittedBy: USER_ID })).status).toBe(400);

    selectResults = [[foundRow()]];
    const ok = await send(`/tickets/${TICKET_ID}`, 'PATCH', { subject: 'Renamed', tags: ['a'] });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(mocks.updateTicketFields).toHaveBeenCalledWith(TICKET_ID, { subject: 'Renamed', tags: ['a'] }, ACTOR);
    expect(mocks.upsertTicketExternalRef).not.toHaveBeenCalled();
    expect(partnerTicketWriteResponseSchema.parse(await ok.json()).data?.subject).toBe('Renamed');
  });

  it('PATCH /tickets/:id manages this principal\'s external ref: set, re-point keeping the url, url-only, clear', async () => {
    // Set (no fields to update → the service is not called).
    selectResults = [[foundRow()]];
    const set = await send(`/tickets/${TICKET_ID}`, 'PATCH', { externalTicketId: 'PSA-9', externalTicketUrl: 'https://psa.example/9' });
    expect(set.status, await set.clone().text()).toBe(200);
    expect(mocks.updateTicketFields).not.toHaveBeenCalled();
    expect(mocks.upsertTicketExternalRef).toHaveBeenCalledWith(expect.objectContaining({ ticketId: TICKET_ID, externalId: 'PSA-9', externalUrl: 'https://psa.example/9' }));
    expect(partnerTicketWriteResponseSchema.parse(await set.json()).data).toMatchObject({ externalTicketId: 'PSA-9', externalTicketUrl: 'https://psa.example/9' });

    // Re-point the id: the existing url is kept unless the request says otherwise.
    selectResults = [[foundRow()]];
    mocks.ticketExternalRefsFor.mockResolvedValueOnce(new Map([[TICKET_ID, ref('PSA-9', 'https://psa.example/9')]]));
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { externalTicketId: 'PSA-10' })).status).toBe(200);
    expect(mocks.upsertTicketExternalRef).toHaveBeenLastCalledWith(expect.objectContaining({ externalId: 'PSA-10', externalUrl: 'https://psa.example/9' }));

    // Url only: updates the url of the ref that exists…
    selectResults = [[foundRow()]];
    mocks.ticketExternalRefsFor.mockResolvedValueOnce(new Map([[TICKET_ID, ref('PSA-10', 'https://psa.example/9')]]));
    expect((await send(`/tickets/${TICKET_ID}`, 'PATCH', { subject: 'Renamed', externalTicketUrl: 'https://psa.example/10' })).status).toBe(200);
    expect(mocks.updateTicketFields).toHaveBeenCalledWith(TICKET_ID, { subject: 'Renamed' }, ACTOR);
    expect(mocks.upsertTicketExternalRef).toHaveBeenLastCalledWith(expect.objectContaining({ externalId: 'PSA-10', externalUrl: 'https://psa.example/10' }));
    // …and is a 400 when there is none to update.
    selectResults = [[foundRow()]];
    const noRef = await send(`/tickets/${TICKET_ID}`, 'PATCH', { externalTicketUrl: 'https://psa.example/11' });
    expect(noRef.status).toBe(400);
    expect((await noRef.json()).code).toBe('partner_tickets_external_url_without_id');

    // Clear.
    selectResults = [[foundRow()]];
    const cleared = await send(`/tickets/${TICKET_ID}`, 'PATCH', { externalTicketId: null });
    expect(cleared.status).toBe(200);
    expect(mocks.clearTicketExternalRef).toHaveBeenCalledWith(PRINCIPAL_ID, TICKET_ID);
    expect(partnerTicketWriteResponseSchema.parse(await cleared.json()).data?.externalTicketId).toBeNull();

    // A conflict on re-point is the same 409 as on create.
    selectResults = [[foundRow()]];
    mocks.upsertTicketExternalRef.mockRejectedValueOnce(new TicketExternalRefConflictError({ externalTicketId: 'PSA-1', existingTicketId: null, existingDeleted: null }));
    const conflict = await send(`/tickets/${TICKET_ID}`, 'PATCH', { externalTicketId: 'PSA-1' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).details).toEqual({ externalTicketId: 'PSA-1', existingTicketId: null, existingDeleted: null });
  });

  it('POST /tickets/:id/status enforces the shared coherence rules and never accepts aiDraftId', async () => {
    selectResults = [[foundRow()], [foundRow()], [foundRow()], [foundRow()]];
    expect((await send(`/tickets/${TICKET_ID}/status`, 'POST', { status: 'resolved' })).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}/status`, 'POST', { status: 'open', statusId: TICKET_ID })).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}/status`, 'POST', { status: 'resolved', resolutionNote: 'x', aiDraftId: TICKET_ID })).status).toBe(400);
    expect(mocks.changeTicketStatus).not.toHaveBeenCalled();

    mocks.ticketExternalRefsFor.mockResolvedValueOnce(new Map([[TICKET_ID, ref('PSA-1')]]));
    const ok = await send(`/tickets/${TICKET_ID}/status`, 'POST', { status: 'resolved', resolutionNote: 'done' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(mocks.changeTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      { status: 'resolved', statusId: undefined },
      { resolutionNote: 'done', pendingReason: undefined },
      ACTOR,
    );
    // The echoed record carries this principal's ref, like the feed.
    expect(partnerTicketWriteResponseSchema.parse(await ok.json()).data).toMatchObject({ status: 'resolved', externalTicketId: 'PSA-1' });
  });

  it('POST /tickets/:id/assign delegates to assignTicket (null unassigns)', async () => {
    selectResults = [[foundRow()], [foundRow()]];
    const ok = await send(`/tickets/${TICKET_ID}/assign`, 'POST', { assigneeId: USER_ID });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(mocks.assignTicket).toHaveBeenCalledWith(TICKET_ID, USER_ID, ACTOR);
    expect(partnerTicketWriteResponseSchema.parse(await ok.json()).data?.assigneeId).toBe(USER_ID);

    const clear = await send(`/tickets/${TICKET_ID}/assign`, 'POST', { assigneeId: null });
    expect(clear.status).toBe(200);
    expect(mocks.assignTicket).toHaveBeenLastCalledWith(TICKET_ID, null, expect.anything());
    expect((await send(`/tickets/${TICKET_ID}/assign`, 'POST', {})).status).toBe(400);
  });

  it('POST /tickets/:id/comments requires an explicit isPublic, authorizes before idempotency, binds the claim to the ticket, and replays', async () => {
    selectResults = [[foundRow()]];
    expect((await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: 'note' })).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: '', isPublic: true })).status).toBe(400);
    expect((await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: 'x', isPublic: true, attachmentIds: [] })).status).toBe(400);

    // Unknown/foreign ticket: 404 and the idempotency state is never consulted.
    selectResults = [[]];
    const missing = await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: 'note', isPublic: false }, { 'X-Idempotency-Key': 'c-1' });
    expect(missing.status).toBe(404);
    expect(mocks.findIdempotencyReplay).not.toHaveBeenCalled();

    selectResults = [[foundRow()]];
    const ok = await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: 'Mirrored note', isPublic: false }, { 'X-Idempotency-Key': 'c-1' });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const body = partnerTicketCommentWriteResponseSchema.parse(await ok.json());
    expect(body).toMatchObject({ id: COMMENT_ID, ticketId: TICKET_ID, orgId: ORG_ID });
    expect(body.data).toMatchObject({ originPrincipalKind: 'service_principal', originPrincipalId: PRINCIPAL_ID, authorName: 'PSA Bridge', isPublic: false });
    expect(mocks.addTicketComment).toHaveBeenCalledWith(TICKET_ID, { content: 'Mirrored note', isPublic: false }, ACTOR);
    // The comment claim is bound to the path ticket at claim time; the link only adds the comment.
    expect(mocks.claimIdempotency).toHaveBeenCalledWith(expect.objectContaining({ route: 'tickets.comment', key: 'c-1', orgId: ORG_ID, ticketId: TICKET_ID }));
    expect(mocks.linkIdempotencyResource).toHaveBeenCalledWith('claim-1', COMMENT_ID, undefined);
    // The fingerprint folds the path ticket in: the same body on another ticket is another fingerprint.
    const fingerprintFor = (call: number) => mocks.findIdempotencyReplay.mock.calls[call]![3] as string;
    selectResults = [[foundRow({ id: OTHER_ORG_ID, orgId: ORG_ID })]];
    await send(`/tickets/${OTHER_ORG_ID}/comments`, 'POST', { content: 'Mirrored note', isPublic: false }, { 'X-Idempotency-Key': 'c-1' });
    expect(fingerprintFor(1)).not.toBe(fingerprintFor(0));

    // Replay re-reads the comment.
    mocks.findIdempotencyReplay.mockResolvedValueOnce({ kind: 'replay', resourceId: COMMENT_ID });
    selectResults = [[foundRow()], [commentRow()]];
    const retry = await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: 'Mirrored note', isPublic: false }, { 'X-Idempotency-Key': 'c-1' });
    expect(retry.status).toBe(200);
    expect(partnerTicketCommentWriteResponseSchema.parse(await retry.json()).idempotencyReplay).toBe(true);
    expect(mocks.addTicketComment).toHaveBeenCalledTimes(2);

    // A linked comment on another ticket cannot happen (ticket-bound claim +
    // fingerprint); finding one is corrupt state, not a client error.
    mocks.findIdempotencyReplay.mockResolvedValueOnce({ kind: 'replay', resourceId: COMMENT_ID });
    selectResults = [[foundRow()], [commentRow({ ticketId: OTHER_ORG_ID })]];
    const wrongTicket = await send(`/tickets/${TICKET_ID}/comments`, 'POST', { content: 'Mirrored note', isPublic: false }, { 'X-Idempotency-Key': 'c-1' });
    expect(wrongTicket.status).toBe(500);
  });

  it('withholds the echoed record (data null + blocked) when a written field carries a credential, but still returns the ids', async () => {
    mocks.createTicket.mockResolvedValueOnce(ticketRow({
      description: 'admin creds: AKIAIOSFODNN7EXAMPLE aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    }));
    const res = await send('/tickets', 'POST', { orgId: ORG_ID, subject: 'creds', description: 'x' });
    expect(res.status).toBe(201);
    const body = partnerTicketWriteResponseSchema.parse(await res.json());
    expect(body.data).toBeNull();
    expect(body.id).toBe(TICKET_ID);
    expect(body.blocked).toEqual([expect.objectContaining({ id: TICKET_ID, resource: 'tickets' })]);
    expect(JSON.stringify(body)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
