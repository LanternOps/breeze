/**
 * manage_tickets: ticket types and ticket-to-ticket links (#8596, feature
 * #8592 W04).
 *
 * The link actions are thin adapters over services/ticketLinkService.ts (its
 * guards are proved against real Postgres in
 * __tests__/integration/ticketLinkService.integration.test.ts). What is pinned
 * here is the adapter's own job, the same one routes/tickets/links.ts does:
 * BOTH tickets resolve through the caller's org + site + exact-device scope
 * before the service runs (an out-of-scope ticket is "not found" and nothing
 * is written), the list uses the route's counterpart scope, service refusals
 * reach the model as typed errors, and the actor is passed through so an
 * ai_agent principal is recorded as itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { selectQueue, whereCalls, selectCols } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  whereCalls: [] as unknown[][],
  selectCols: [] as unknown[],
}));

vi.mock('../db', () => {
  const select = vi.fn((cols?: unknown) => {
    selectCols.push(cols);
    const rows = selectQueue.shift() ?? [];
    const node: Record<string, unknown> = {};
    const pass = () => node;
    Object.assign(node, {
      from: pass, leftJoin: pass, innerJoin: pass, orderBy: pass, limit: pass, offset: pass,
      where: (...args: unknown[]) => { whereCalls.push(args); return node; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
    });
    return node;
  });
  return {
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    db: { select, insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  };
});

vi.mock('./ticketChecklistService', () => ({
  listChecklist: vi.fn(async () => ({ done: 0, total: 0, items: [] })),
}));

const svc = vi.hoisted(() => ({
  listTicketLinks: vi.fn(),
  addTicketLink: vi.fn(),
  removeTicketLink: vi.fn(),
  getTicketLinkForTicket: vi.fn(),
  findTicketIdByNumber: vi.fn(),
}));
vi.mock('./ticketLinkService', async () => {
  const actual = await vi.importActual<typeof import('./ticketLinkService')>('./ticketLinkService');
  return { ...actual, ...svc };
});

const ticketSvc = vi.hoisted(() => ({
  createTicket: vi.fn(),
  updateTicketFields: vi.fn(),
  applyAiFieldUpdates: vi.fn(),
}));
vi.mock('./ticketService', async () => {
  const actual = await vi.importActual<typeof import('./ticketService')>('./ticketService');
  return { ...actual, ...ticketSvc };
});

// Site/device axis of a by-id ticket load: a ticket whose device is in
// OUT_OF_SCOPE_DEVICES is invisible. The counterpart list predicate is a
// sentinel so the test can see the action hands the route's predicate over.
const OUT_OF_SCOPE_DEVICES = new Set(['dev-forbidden']);
vi.mock('../routes/tickets/siteScope', async () => {
  const actual = await vi.importActual<typeof import('../routes/tickets/siteScope')>('../routes/tickets/siteScope');
  return {
    ...actual,
    deviceInSiteScope: vi.fn(async (_auth: unknown, deviceId: string) => !OUT_OF_SCOPE_DEVICES.has(deviceId)),
    ticketCounterpartScopeCondition: vi.fn(() => 'COUNTERPART_SCOPE'),
  };
});

import { registerTicketingTools } from './aiToolsTicketing';
import { TicketLinkError } from './ticketLinkService';
import { ticketCounterpartScopeCondition } from '../routes/tickets/siteScope';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG = 'org-1';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const L1 = '33333333-3333-4333-8333-333333333333';

function tool(): AiTool {
  const reg = new Map<string, AiTool>();
  registerTicketingTools(reg);
  return reg.get('manage_tickets')!;
}
const run = async (input: Record<string, unknown>, auth: AuthContext = humanAuth()) =>
  JSON.parse(await tool().handler(input, auth)) as Record<string, any>;

function humanAuth(over: Record<string, unknown> = {}): AuthContext {
  return {
    user: { id: 'user-1', email: 'tech@example.test', name: 'Tess Tech', isPlatformAdmin: false },
    principal: { kind: 'user_session' },
    partnerId: null, orgId: ORG, scope: 'organization', accessibleOrgIds: [ORG],
    orgCondition: () => undefined, canAccessOrg: (id: string) => id === ORG,
    ...over,
  } as unknown as AuthContext;
}
function agentAuth(): AuthContext {
  return humanAuth({
    user: { id: 'agent-1', email: '', name: 'Triage Agent', isPlatformAdmin: false },
    principal: { kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' },
  });
}

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, orgId: ORG, deviceId: null, partnerId: 'p-1', deletedAt: null, ...over });
const VIEW = {
  id: L1, direction: 'outgoing', linkType: 'caused_by', label: 'caused_by',
  other: { id: B, ticketNumber: 'T-2', subject: 'Root cause', status: 'open', ticketType: 'problem', deleted: false },
  createdAt: '2026-10-13T00:00:00.000Z',
};

const dialect = new PgDialect();
const compiledWheres = () => whereCalls.map((args) => dialect.sqlToQuery(args[0] as never));

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereCalls.length = 0;
  selectCols.length = 0;
});

// ── 4.2 read surface ──────────────────────────────────────────────────────────

describe('manage_tickets list: ticketType filter and column', () => {
  it('returns ticketType on every row', async () => {
    selectQueue.push([{ id: A, ticketType: 'problem' }]);
    const out = await run({ action: 'list' });
    expect(selectCols[0]).toHaveProperty('ticketType');
    expect(out.tickets[0].ticketType).toBe('problem');
  });

  it('a single type filters with equality', async () => {
    selectQueue.push([]);
    await run({ action: 'list', ticketType: 'problem' });
    const q = compiledWheres()[0]!;
    expect(q.sql).toMatch(/"tickets"\."ticket_type" = \$\d/);
    expect(q.params).toContain('problem');
  });

  it('an array of types filters with IN', async () => {
    selectQueue.push([]);
    await run({ action: 'list', ticketType: ['incident', 'change'] });
    const q = compiledWheres()[0]!;
    expect(q.sql).toMatch(/"tickets"\."ticket_type" in \(\$\d, \$\d\)/);
    expect(q.params).toEqual(expect.arrayContaining(['incident', 'change']));
  });

  it('an unknown type is refused before any query', async () => {
    const out = await run({ action: 'list', ticketType: ['incident', 'bogus'] });
    expect(out.error).toMatch(/ticketType/);
    expect(selectCols).toHaveLength(0);
  });
});

describe('manage_tickets list_links', () => {
  it('requires ticketId', async () => {
    expect((await run({ action: 'list_links' })).error).toMatch(/ticketId is required/);
  });

  it('returns the service view, filtered by the same counterpart scope as GET /tickets/:id/links', async () => {
    selectQueue.push([row(A)]);
    svc.listTicketLinks.mockResolvedValue([VIEW]);
    const auth = humanAuth({ allowedSiteIds: ['site-a'] });
    const out = await run({ action: 'list_links', ticketId: A }, auth);
    expect(out).toEqual({ links: [VIEW] });
    expect(ticketCounterpartScopeCondition).toHaveBeenCalledWith(auth);
    expect(svc.listTicketLinks).toHaveBeenCalledWith(A, { counterpartFilter: 'COUNTERPART_SCOPE' });
  });

  it('a ticket outside the caller scope is not found and the service is never asked', async () => {
    selectQueue.push([row(A, { deviceId: 'dev-forbidden' })]);
    const out = await run({ action: 'list_links', ticketId: A });
    expect(out.error).toBe('Ticket not found');
    expect(svc.listTicketLinks).not.toHaveBeenCalled();
  });
});

// ── 4.3 write surface ─────────────────────────────────────────────────────────

describe('manage_tickets link_ticket', () => {
  it('validates its inputs before any lookup', async () => {
    expect((await run({ action: 'link_ticket', targetTicketId: B, linkType: 'related' })).error).toMatch(/ticketId is required/);
    expect((await run({ action: 'link_ticket', ticketId: A, linkType: 'related' })).error).toMatch(/targetTicketId or targetTicketNumber/);
    expect((await run({ action: 'link_ticket', ticketId: A, targetTicketId: B, targetTicketNumber: 'T-2', linkType: 'related' })).error)
      .toMatch(/targetTicketId or targetTicketNumber/);
    expect((await run({ action: 'link_ticket', ticketId: A, targetTicketId: B, linkType: 'blocks' })).error).toMatch(/linkType/);
    expect(selectCols).toHaveLength(0);
    expect(svc.addTicketLink).not.toHaveBeenCalled();
  });

  it('links two in-scope tickets, passing the human actor', async () => {
    selectQueue.push([row(A)], [row(B)]);
    svc.addTicketLink.mockResolvedValue(VIEW);
    const out = await run({ action: 'link_ticket', ticketId: A, targetTicketId: B, linkType: 'caused_by' });
    expect(out).toEqual({ link: VIEW });
    expect(svc.addTicketLink).toHaveBeenCalledWith(
      { source: { id: A, orgId: ORG }, target: { id: B, orgId: ORG }, linkType: 'caused_by' },
      expect.objectContaining({ kind: 'user', userId: 'user-1' }),
    );
  });

  it('an ai_agent principal is recorded as itself (ai_agent actor, no users id)', async () => {
    selectQueue.push([row(A)], [row(B)]);
    svc.addTicketLink.mockResolvedValue(VIEW);
    await run({ action: 'link_ticket', ticketId: A, targetTicketId: B, linkType: 'related' }, agentAuth());
    expect(svc.addTicketLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' }),
    );
  });

  it('a target outside the caller scope is "not found" and nothing is written', async () => {
    selectQueue.push([row(A)], [row(B, { deviceId: 'dev-forbidden' })]);
    const out = await run({ action: 'link_ticket', ticketId: A, targetTicketId: B, linkType: 'related' });
    expect(out.error).toBe('Ticket not found');
    expect(svc.addTicketLink).not.toHaveBeenCalled();
  });

  it('a source outside the caller scope is "not found" and the target is never looked up', async () => {
    selectQueue.push([row(A, { deviceId: 'dev-forbidden' })]);
    const out = await run({ action: 'link_ticket', ticketId: A, targetTicketId: B, linkType: 'related' });
    expect(out.error).toBe('Ticket not found');
    expect(selectCols).toHaveLength(1);
    expect(svc.addTicketLink).not.toHaveBeenCalled();
  });

  it('resolves targetTicketNumber inside the SOURCE ticket org, then scope-checks it', async () => {
    selectQueue.push([row(A)], [row(B)]);
    svc.findTicketIdByNumber.mockResolvedValue(B);
    svc.addTicketLink.mockResolvedValue(VIEW);
    await run({ action: 'link_ticket', ticketId: A, targetTicketNumber: 'T-2', linkType: 'resolves' });
    expect(svc.findTicketIdByNumber).toHaveBeenCalledWith(ORG, 'T-2');
    expect(svc.addTicketLink).toHaveBeenCalledWith(
      expect.objectContaining({ target: { id: B, orgId: ORG } }), expect.anything(),
    );
  });

  it('an unknown ticket number is "not found"', async () => {
    selectQueue.push([row(A)]);
    svc.findTicketIdByNumber.mockResolvedValue(null);
    const out = await run({ action: 'link_ticket', ticketId: A, targetTicketNumber: 'T-404', linkType: 'related' });
    expect(out.error).toBe('Ticket not found');
    expect(svc.addTicketLink).not.toHaveBeenCalled();
  });

  it.each([
    ['LINK_CYCLE', 'This link would create a cycle'],
    ['CROSS_ORG', 'Tickets can only be linked within one organization'],
    ['LINK_LIMIT', 'A ticket can have at most 50 links'],
    ['SOURCE_ALREADY_DUPLICATE', 'This ticket is already marked as a duplicate of another ticket'],
  ] as const)('service refusal %s reaches the model as a typed tool error', async (code, message) => {
    selectQueue.push([row(A)], [row(B)]);
    svc.addTicketLink.mockRejectedValue(new TicketLinkError(code, message));
    const out = await run({ action: 'link_ticket', ticketId: A, targetTicketId: B, linkType: 'caused_by' });
    expect(out).toEqual({ error: message, code });
    // No `success` key: the SDK classifier would otherwise log it as a success.
    expect(out).not.toHaveProperty('success');
  });
});

describe('manage_tickets unlink_ticket', () => {
  it('validates its inputs', async () => {
    expect((await run({ action: 'unlink_ticket', linkId: L1 })).error).toMatch(/ticketId is required/);
    expect((await run({ action: 'unlink_ticket', ticketId: A })).error).toMatch(/linkId is required/);
    expect(svc.removeTicketLink).not.toHaveBeenCalled();
  });

  it('removes a link whose counterpart the caller can see', async () => {
    selectQueue.push([row(A)], [row(B)]);
    svc.getTicketLinkForTicket.mockResolvedValue({ id: L1, otherTicketId: B });
    const out = await run({ action: 'unlink_ticket', ticketId: A, linkId: L1 }, agentAuth());
    expect(out).toEqual({ unlinked: true });
    expect(svc.getTicketLinkForTicket).toHaveBeenCalledWith(A, L1);
    expect(svc.removeTicketLink).toHaveBeenCalledWith(A, L1, expect.objectContaining({ kind: 'ai_agent', agentId: 'agent-1' }));
  });

  it('a link to a soft-deleted counterpart is removable (#8679): the counterpart load includes deleted rows', async () => {
    selectQueue.push([row(A)], [row(B, { deletedAt: new Date() })]);
    svc.getTicketLinkForTicket.mockResolvedValue({ id: L1, otherTicketId: B });
    expect(await run({ action: 'unlink_ticket', ticketId: A, linkId: L1 })).toEqual({ unlinked: true });
    const [sourceLoad, counterpartLoad] = compiledWheres();
    expect(sourceLoad!.sql).toMatch(/"tickets"\."deleted_at" is null/);
    expect(counterpartLoad!.sql).not.toMatch(/deleted_at/);
  });

  it('a link that is not on this ticket, or whose counterpart is out of scope, is "Link not found"', async () => {
    selectQueue.push([row(A)]);
    svc.getTicketLinkForTicket.mockResolvedValue(null);
    expect((await run({ action: 'unlink_ticket', ticketId: A, linkId: L1 })).error).toBe('Link not found');

    selectQueue.push([row(A)], [row(B, { deviceId: 'dev-forbidden' })]);
    svc.getTicketLinkForTicket.mockResolvedValue({ id: L1, otherTicketId: B });
    expect((await run({ action: 'unlink_ticket', ticketId: A, linkId: L1 })).error).toBe('Link not found');
    expect(svc.removeTicketLink).not.toHaveBeenCalled();
  });

  it('a ticket outside the caller scope is "not found" and the link is never looked up', async () => {
    selectQueue.push([row(A, { deviceId: 'dev-forbidden' })]);
    expect((await run({ action: 'unlink_ticket', ticketId: A, linkId: L1 })).error).toBe('Ticket not found');
    expect(svc.getTicketLinkForTicket).not.toHaveBeenCalled();
  });
});

describe('manage_tickets ticketType on create and update_fields', () => {
  it('create passes a valid ticketType to the service', async () => {
    ticketSvc.createTicket.mockResolvedValue({ id: A, ticketType: 'service_request' });
    await run({ action: 'create', orgId: ORG, subject: 'New laptop', ticketType: 'service_request' });
    expect(ticketSvc.createTicket).toHaveBeenCalledWith(expect.objectContaining({ ticketType: 'service_request', source: 'ai' }), expect.anything());
  });

  it('create without ticketType leaves the service default in charge', async () => {
    ticketSvc.createTicket.mockResolvedValue({ id: A });
    await run({ action: 'create', orgId: ORG, subject: 'Printer down' });
    expect(ticketSvc.createTicket.mock.calls[0]![0]).not.toHaveProperty('ticketType');
  });

  it('create refuses an unknown ticketType', async () => {
    const out = await run({ action: 'create', orgId: ORG, subject: 's', ticketType: 'bogus' });
    expect(out.error).toMatch(/ticketType/);
    expect(ticketSvc.createTicket).not.toHaveBeenCalled();
  });

  it('update_fields accepts fields.ticketType', async () => {
    selectQueue.push([row(A)]);
    ticketSvc.updateTicketFields.mockResolvedValue({ id: A, ticketType: 'problem' });
    await run({ action: 'update_fields', ticketId: A, fields: { ticketType: 'problem' } });
    expect(ticketSvc.updateTicketFields).toHaveBeenCalledWith(A, { ticketType: 'problem' }, expect.anything());
  });

  it('update_fields refuses an unknown fields.ticketType', async () => {
    const out = await run({ action: 'update_fields', ticketId: A, fields: { ticketType: 'bogus' } });
    expect(out.error).toMatch(/fields\.ticketType/);
    expect(ticketSvc.updateTicketFields).not.toHaveBeenCalled();
  });

  it('an ai_agent principal cannot reclassify through update_fields (category and priority only)', async () => {
    selectQueue.push([row(A)]);
    const out = await run({ action: 'update_fields', ticketId: A, fields: { ticketType: 'problem' } }, agentAuth());
    expect(out.error).toMatch(/categoryId and priority/);
    expect(ticketSvc.applyAiFieldUpdates).not.toHaveBeenCalled();
    expect(ticketSvc.updateTicketFields).not.toHaveBeenCalled();
  });
});
