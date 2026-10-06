import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL_ID = '66666666-6666-4666-8666-666666666666';
const TICKET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TICKET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMENT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COMMENT_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
  accessibleOrgIds: [] as string[],
  findTicketIdByExternalRef: vi.fn(),
  ticketExternalRefsFor: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: { select: mocks.select, execute: mocks.execute },
  hasDbAccessContext: () => true,
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../services/ticketExternalRefs', () => ({
  findTicketIdByExternalRef: mocks.findTicketIdByExternalRef,
  ticketExternalRefsFor: mocks.ticketExternalRefsFor,
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: PRINCIPAL_ID,
      partnerId: PARTNER_ID,
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

import { partnerApiRoutes } from './index';
import {
  partnerTicketCommentListSchema,
  partnerTicketFeedEnvelopeSchema,
  partnerTicketIdListSchema,
  partnerTicketRecordResponseSchema,
} from './schemas';
import { PgDialect } from 'drizzle-orm/pg-core';

type QueryResult = unknown[] | Error;
let selectResults: QueryResult[] = [];
let whereArgs: unknown[] = [];
function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    where: vi.fn((arg: unknown) => { whereArgs.push(arg); return builder; }),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => promise),
  };
  return builder;
}

function whereSql(index: number): string {
  return new PgDialect().sqlToQuery(whereArgs[index] as any).sql.toLowerCase();
}

function ticketRow(id: string, changeXid: string, overrides: Record<string, unknown> = {}) {
  return {
    id, orgId: ORG_ID, ticketNumber: 'ABC123', internalNumber: 'T-2026-0001',
    subject: 'Printer offline', description: 'The accounting printer is offline',
    status: 'open', statusId: null, priority: 'normal', source: 'api', workKind: 'support',
    categoryId: null, assignedTo: null, deviceId: null,
    requesterContactId: null, submittedBy: null, submitterName: 'Jane', submitterEmail: 'jane@example.com',
    tags: ['printer'],
    dueDate: null, firstResponseAt: null, resolvedAt: null, closedAt: null,
    pendingReason: null, resolutionNote: null, responseSlaMinutes: 60, resolutionSlaMinutes: 480,
    slaBreachedAt: null, slaBreachReason: null, deletedAt: null,
    createdAt: new Date('2026-09-26T12:00:00.000Z'), updatedAt: new Date('2026-09-26T12:30:00.000Z'),
    changeXid,
    ...overrides,
  };
}

function commentRow(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id, ticketId: TICKET_A, portalUserId: null, userId: null, authorName: 'PSA Bridge', authorType: 'internal',
    content: 'Mirrored note', isPublic: true, attachments: [], commentType: 'comment', oldValue: null, newValue: null,
    deletedAt: null, editedAt: null, createdAt: new Date(createdAt), createdAtKey: createdAt.replace('T', ' ').replace('Z', ''),
    originPrincipalKind: 'service_principal', originPrincipalId: PRINCIPAL_ID,
    agentRunId: null, proposedByRunId: null,
    ...overrides,
  };
}

function request(path: string, scope = 'tickets:read') {
  return app.request(path, { headers: { 'X-API-Key': 'test-key', 'X-Test-Scopes': scope } });
}

let app: Hono;
describe('partner tickets read surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    whereArgs = [];
    mocks.accessibleOrgIds = [ORG_ID, OTHER_ORG_ID];
    mocks.select.mockImplementation(() => query(selectResults.shift() ?? []));
    mocks.execute.mockResolvedValue([{ horizon: '1000', xmax: '1005', epoch: '7688900532099108902:1:16384:24601' }]);
    mocks.ticketExternalRefsFor.mockResolvedValue(new Map());
    mocks.findTicketIdByExternalRef.mockResolvedValue(null);
    app = new Hono();
    app.route('/', partnerApiRoutes);
  });

  it('requires tickets:read — alerts:read and tickets:write are not enough', async () => {
    expect((await request('/tickets', 'alerts:read')).status).toBe(403);
    expect((await request('/tickets', 'tickets:write')).status).toBe(403);
    expect((await request('/tickets/ids', 'devices:read')).status).toBe(403);
    expect((await request(`/tickets/${TICKET_A}`, 'devices:read')).status).toBe(403);
    expect((await request(`/tickets/${TICKET_A}/comments`, 'devices:read')).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('full sync: typed records with THIS principal\'s external ref, no custom_fields/field_provenance, checkpoint on the last page', async () => {
    selectResults = [[ticketRow(TICKET_A, '900')]];
    mocks.ticketExternalRefsFor.mockResolvedValue(new Map([[TICKET_A, { ticketId: TICKET_A, externalId: 'PSA-1', externalUrl: 'https://psa.example/1' }]]));
    const res = await request('/tickets');
    expect(res.status).toBe(200);
    const body = partnerTicketFeedEnvelopeSchema.parse(await res.json());
    expect(body.mode).toBe('full');
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.checkpoint).toEqual(expect.any(String));
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: TICKET_A, orgId: ORG_ID, ticketNumber: 'ABC123', internalNumber: 'T-2026-0001',
      subject: 'Printer offline', status: 'open', priority: 'normal', source: 'api',
      requester: { contactId: null, portalUserId: null, name: 'Jane', email: 'jane@example.com' },
      externalTicketId: 'PSA-1', externalTicketUrl: 'https://psa.example/1', changeVersion: '900',
      createdAt: '2026-09-26T12:00:00.000Z', updatedAt: '2026-09-26T12:30:00.000Z',
    });
    expect(body.data[0]).not.toHaveProperty('customFields');
    expect(body.data[0]).not.toHaveProperty('fieldProvenance');
    expect(mocks.ticketExternalRefsFor).toHaveBeenCalledWith(PRINCIPAL_ID, [TICKET_A]);
    // Scope predicates: partner, org set, xid window. Soft-deleted rows are
    // NOT filtered out — they become tombstones.
    const where = whereSql(0);
    expect(where).toContain('"partner_id" =');
    expect(where).not.toContain('"deleted_at" is null');
    expect(where).toContain('"partner_feed_xid" <');
  });

  it('delivers a soft-deleted ticket as a tombstone (no fields beyond ids/deletedAt) and never looks up its ref', async () => {
    selectResults = [[
      ticketRow(TICKET_A, '900', { deletedAt: new Date('2026-09-27T08:00:00.000Z'), description: 'SECRET' }),
      ticketRow(TICKET_B, '950'),
    ]];
    const body = partnerTicketFeedEnvelopeSchema.parse(await (await request('/tickets')).json());
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      id: TICKET_A, orgId: ORG_ID, removed: true, reason: 'deleted', deletedAt: '2026-09-27T08:00:00.000Z', changeVersion: '900',
    });
    expect(JSON.stringify(body.data[0])).not.toContain('SECRET');
    expect(body.data[1]).toMatchObject({ id: TICKET_B, subject: 'Printer offline' });
    expect(mocks.ticketExternalRefsFor).toHaveBeenCalledWith(PRINCIPAL_ID, [TICKET_B]);
  });

  it('applies the filters, resolves externalId through the principal\'s refs, and binds them into the checkpoint', async () => {
    selectResults = [[ticketRow(TICKET_A, '900')]];
    mocks.findTicketIdByExternalRef.mockResolvedValueOnce(TICKET_A);
    const res = await request(`/tickets?status=open,new&priority=urgent&externalId=PSA-1&assigneeId=${OTHER_ORG_ID}`);
    expect(res.status).toBe(200);
    const body = partnerTicketFeedEnvelopeSchema.parse(await res.json());
    expect(mocks.findTicketIdByExternalRef).toHaveBeenCalledWith(PRINCIPAL_ID, 'PSA-1');
    const where = whereSql(0);
    expect(where).toContain('"status" in');
    expect(where).toContain('"priority" in');
    expect(where).toContain('"assigned_to" =');
    expect(where).toContain('"tickets"."id" =');

    // An externalId this principal does not know returns an empty page — no query at all.
    mocks.select.mockClear();
    mocks.findTicketIdByExternalRef.mockResolvedValueOnce(null);
    const miss = partnerTicketFeedEnvelopeSchema.parse(await (await request('/tickets?externalId=PSA-none')).json());
    expect(miss.data).toEqual([]);
    expect(mocks.select).not.toHaveBeenCalled();

    // The checkpoint is bound to the exact filter set: replaying it against a
    // different filter set is a 400, never a silent partial sync.
    selectResults = [[]];
    const replay = await request(`/tickets?status=open&since=${encodeURIComponent(body.checkpoint!)}`);
    expect(replay.status).toBe(400);
    expect((await replay.json()).code).toBe('invalid_partner_tickets_token');
  });

  it('pages with a signed cursor and rejects since+cursor together', async () => {
    selectResults = [[ticketRow(TICKET_A, '900'), ticketRow(TICKET_B, '950')]];
    const first = partnerTicketFeedEnvelopeSchema.parse(await (await request('/tickets?limit=1')).json());
    expect(first.hasMore).toBe(true);
    expect(first.checkpoint).toBeNull();
    expect(first.data.map((r) => r.id)).toEqual([TICKET_A]);

    selectResults = [[ticketRow(TICKET_B, '950')]];
    const second = partnerTicketFeedEnvelopeSchema.parse(
      await (await request(`/tickets?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json(),
    );
    expect(second.data.map((r) => r.id)).toEqual([TICKET_B]);
    expect(second.hasMore).toBe(false);
    expect(second.checkpoint).toEqual(expect.any(String));
    expect(whereSql(1)).toContain('> (');

    const both = await request(`/tickets?since=${encodeURIComponent(second.checkpoint!)}&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(both.status).toBe(400);
  });

  it('an org outside the principal set is a 404, and an unknown query key a 400', async () => {
    expect((await request(`/tickets?orgId=${FOREIGN_ORG_ID}`)).status).toBe(404);
    expect((await request('/tickets?deleted=only')).status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('truncates oversized free text and withholds a record whose text carries a credential', async () => {
    const long = 'The printer on floor 3 is offline again, please advise. '.repeat(400);
    selectResults = [[
      ticketRow(TICKET_A, '900', { description: long }),
      ticketRow(TICKET_B, '950', { description: 'here is the admin login: AKIAIOSFODNN7EXAMPLE aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }),
    ]];
    const body = partnerTicketFeedEnvelopeSchema.parse(await (await request('/tickets')).json());
    const a = body.data.find((r) => r.id === TICKET_A) as { description?: string } | undefined;
    expect(a).toBeDefined();
    expect(a!.description!.length).toBeLessThanOrEqual(12_000);
    expect(a!.description!.endsWith('…')).toBe(true);
    expect(body.data.find((r) => r.id === TICKET_B)).toBeUndefined();
    expect(body.blocked).toEqual([expect.objectContaining({ id: TICKET_B, orgId: ORG_ID, resource: 'tickets', reason: 'secret_detected' })]);
    expect(JSON.stringify(body)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('GET /tickets/ids lists live ids in the set, keyset-paged, for reconciliation', async () => {
    selectResults = [[
      { id: TICKET_A, orgId: ORG_ID, changeXid: '900' },
      { id: TICKET_B, orgId: OTHER_ORG_ID, changeXid: '950' },
    ]];
    const first = partnerTicketIdListSchema.parse(await (await request('/tickets/ids?limit=1')).json());
    expect(first.data).toEqual([{ id: TICKET_A, orgId: ORG_ID, changeVersion: '900' }]);
    expect(first.hasMore).toBe(true);
    expect(whereSql(0)).toContain('"deleted_at" is null');
    expect(whereSql(0)).toContain('"partner_id" =');

    selectResults = [[{ id: TICKET_B, orgId: OTHER_ORG_ID, changeXid: '950' }]];
    const second = partnerTicketIdListSchema.parse(await (await request(`/tickets/ids?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    expect(second.data.map((r) => r.id)).toEqual([TICKET_B]);
    expect(second.hasMore).toBe(false);
    expect(whereSql(1)).toContain('"tickets"."id" >');

    // The cursor is bound to the org set / filter: a different orgId is a 400.
    expect((await request(`/tickets/ids?orgId=${ORG_ID}&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
    expect((await request(`/tickets/ids?orgId=${FOREIGN_ORG_ID}`)).status).toBe(404);
  });

  it('GET /tickets/:id returns one record with the principal\'s ref and 404s for unknown, foreign or deleted tickets', async () => {
    selectResults = [[ticketRow(TICKET_A, '900')]];
    mocks.ticketExternalRefsFor.mockResolvedValue(new Map([[TICKET_A, { ticketId: TICKET_A, externalId: 'PSA-1', externalUrl: null }]]));
    const res = await request(`/tickets/${TICKET_A}`);
    expect(res.status).toBe(200);
    const body = partnerTicketRecordResponseSchema.parse(await res.json());
    expect(body.data.id).toBe(TICKET_A);
    expect(body.data.externalTicketId).toBe('PSA-1');
    expect(whereSql(0)).toContain('"partner_id" =');
    expect(whereSql(0)).toContain('"deleted_at" is null');

    selectResults = [[]];
    expect((await request(`/tickets/${TICKET_B}`)).status).toBe(404);
    expect((await request('/tickets/not-a-uuid')).status).toBe(404);
  });

  it('GET /tickets/:id/comments pages in creation order with a keyset cursor, surfaces edits and deletes, after authorizing the ticket', async () => {
    selectResults = [
      [ticketRow(TICKET_A, '900')],
      [
        commentRow(COMMENT_A, '2026-09-26T12:00:00.000Z', { editedAt: new Date('2026-09-26T12:10:00.000Z'), content: 'edited' }),
        commentRow(COMMENT_B, '2026-09-26T12:05:00.000Z', { deletedAt: new Date('2026-09-26T12:20:00.000Z'), content: 'SECRET' }),
      ],
    ];
    const first = partnerTicketCommentListSchema.parse(await (await request(`/tickets/${TICKET_A}/comments?limit=1`)).json());
    expect(first.ticketId).toBe(TICKET_A);
    expect(first.data.map((c) => c.id)).toEqual([COMMENT_A]);
    expect(first.data[0]).toMatchObject({
      orgId: ORG_ID, authorName: 'PSA Bridge', originPrincipalKind: 'service_principal', originPrincipalId: PRINCIPAL_ID,
      isPublic: true, createdAt: '2026-09-26T12:00:00.000Z', editedAt: '2026-09-26T12:10:00.000Z',
    });
    expect(first.data[0]).not.toHaveProperty('userId');
    expect(first.data[0]).not.toHaveProperty('attachments');
    expect(first.hasMore).toBe(true);
    // Deleted comments are NOT filtered: they come back as tombstones.
    expect(whereSql(1)).not.toContain('"deleted_at" is null');

    selectResults = [[ticketRow(TICKET_A, '900')], [commentRow(COMMENT_B, '2026-09-26T12:05:00.000Z', { deletedAt: new Date('2026-09-26T12:20:00.000Z'), content: 'SECRET' })]];
    const second = partnerTicketCommentListSchema.parse(
      await (await request(`/tickets/${TICKET_A}/comments?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json(),
    );
    expect(second.data).toEqual([{
      id: COMMENT_B, ticketId: TICKET_A, orgId: ORG_ID, removed: true,
      deletedAt: '2026-09-26T12:20:00.000Z', createdAt: '2026-09-26T12:05:00.000Z',
    }]);
    expect(JSON.stringify(second)).not.toContain('SECRET');
    expect(second.hasMore).toBe(false);

    // The cursor is bound to the ticket: replaying it on another ticket is a 400.
    selectResults = [[ticketRow(TICKET_B, '901')]];
    const replay = await request(`/tickets/${TICKET_B}/comments?cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(replay.status).toBe(400);

    // A foreign/unknown ticket is a 404 before the cursor is even decoded.
    selectResults = [[]];
    const foreign = await request(`/tickets/${TICKET_B}/comments?cursor=garbage`);
    expect(foreign.status).toBe(404);
  });
});
