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
