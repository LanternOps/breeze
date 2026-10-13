import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * #4617 W03 staff approval routes. The W02 decision services do NO permission
 * or org check of their own (cancel / re-ask / on-behalf), so every route here
 * must enforce its permission AND the caller's org + site access itself. These
 * tests pin, per route: the permission (403 without it), the scope, cross-org
 * denial (another org's request → 404) and site-axis denial (the scoped ticket
 * helper hides it → 404), and that a refused call never reaches the service.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TICKET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TICKET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQ_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQ_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENTRY_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENTRY_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const { authRef, svc, summary, emit, audit, timeAudit, dbRows, ticketsById, sp } = vi.hoisted(() => ({
  // Savepoint model: `depth` > 0 while inside withDbTransaction; `rolledBack`
  // counts savepoints that ended in a throw (their writes are undone).
  sp: { depth: 0, rolledBack: 0, serviceDepths: [] as number[] },
  authRef: { current: null as any },
  svc: {
    decideApprovalRequest: vi.fn(),
    cancelApprovalRequest: vi.fn(),
    reaskApprovalRequest: vi.fn(),
    writeOffHeldEntry: vi.fn(),
    createStaffApprovalRequest: vi.fn(),
  },
  summary: vi.fn(),
  emit: vi.fn(async (_e: unknown) => undefined),
  audit: vi.fn(),
  timeAudit: vi.fn(),
  dbRows: new Map<string, Record<string, unknown>>(),
  ticketsById: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Forbidden scope' }, 403);
    await next();
  },
  // Real-shaped gate: denies when the stub auth lacks the named grant, so a
  // dropped or swapped requirePermission(...) reds a test below.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms: string[] = c.get('auth').perms ?? [];
    if (!perms.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    c.set('permissions', { perms });
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => { await next(); },
}));

// The scoped ticket helper is the org + site gate (its own suite pins partner
// org-allowlist and site-axis semantics). Here it is modelled faithfully
// enough to prove the routes consult it: org axis via accessibleOrgIds, site
// axis via a per-caller hidden list.
vi.mock('./tickets', () => ({
  getScopedTicketOr404: vi.fn(async (auth: any, id: string) => {
    const t = ticketsById.get(id);
    if (!t) return null;
    if (auth.scope === 'partner' && !(auth.accessibleOrgIds ?? []).includes(t.orgId)) return null;
    if ((auth.siteHiddenTickets ?? []).includes(id)) return null;
    return t;
  }),
}));

vi.mock('../../db', () => ({
  withDbTransaction: async (fn: () => Promise<unknown>) => {
    sp.depth += 1;
    try { return await fn(); } catch (e) { sp.rolledBack += 1; throw e; } finally { sp.depth -= 1; }
  },
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const key = table?.__name;
            const id = dbRows.get('__next:' + key) as unknown as string | undefined;
            const row = id ? dbRows.get(id) : undefined;
            return row ? [row] : [];
          }),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  ticketApprovalRequests: { __name: 'requests', id: 'id', ticketId: 'ticketId', orgId: 'orgId' },
  timeEntries: { __name: 'entries', id: 'id', ticketId: 'ticketId', orgId: 'orgId' },
  organizations: { __name: 'orgs', id: 'id', partnerId: 'partnerId' },
}));

vi.mock('../../services/ticketApproval/decisions', async () => {
  class ApprovalDecisionError extends Error {
    constructor(message: string, public status: number, public code: string) { super(message); }
  }
  return {
    ApprovalDecisionError,
    decideApprovalRequest: (...a: unknown[]) => { sp.serviceDepths.push(sp.depth); return svc.decideApprovalRequest(...a); },
    cancelApprovalRequest: (...a: unknown[]) => { sp.serviceDepths.push(sp.depth); return svc.cancelApprovalRequest(...a); },
    reaskApprovalRequest: (...a: unknown[]) => { sp.serviceDepths.push(sp.depth); return svc.reaskApprovalRequest(...a); },
    writeOffHeldEntry: (...a: unknown[]) => { sp.serviceDepths.push(sp.depth); return svc.writeOffHeldEntry(...a); },
    createStaffApprovalRequest: (...a: unknown[]) => { sp.serviceDepths.push(sp.depth); return svc.createStaffApprovalRequest(...a); },
  };
});
vi.mock('../../services/ticketApproval/summary', () => ({ getTicketApprovalSummary: (...a: unknown[]) => summary(...a) }));
vi.mock('../../services/ticketEvents', () => ({ emitTicketEvent: (e: unknown) => emit(e) }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: (...a: unknown[]) => audit(...a) }));
vi.mock('../../services/orgCurrencyCore', () => ({
  OrgCurrencyServiceError: class extends Error {
    constructor(message: string, public status: number, public code?: string) { super(message); }
  },
}));
vi.mock('../timeEntries/timeEntries', () => ({
  timeEntryAuditCollector: (c: any) => {
    const auth = c.get('auth');
    const mutations: unknown[] = [];
    return {
      actor: {
        userId: auth.user.id, name: auth.user.name, accessibleOrgIds: auth.accessibleOrgIds,
        manageBilling: (auth.perms ?? []).includes('time_entries:manage_billing') && auth.principalKind !== 'api_key',
        recordAuditMutation: (m: unknown) => mutations.push(m),
      },
      mutations,
    };
  },
  writeSimpleTimeEntryAudits: (...a: unknown[]) => timeAudit(...a),
}));

import { ticketApprovalRoutes } from './approvals';
import { ApprovalDecisionError } from '../../services/ticketApproval/decisions';

const ALL = ['tickets:read', 'tickets:write', 'tickets:record_approval', 'time_entries:manage_billing'];

function auth(over: Record<string, unknown> = {}) {
  return {
    scope: 'partner', partnerId: 'p-1', orgId: null,
    user: { id: 'u-staff', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
    accessibleOrgIds: [ORG_A], canAccessOrg: (id: string) => id === ORG_A,
    perms: ALL, ...over,
  };
}

function app() {
  const a = new Hono();
  a.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: 'internal' }, 500);
  });
  return a.route('/', ticketApprovalRoutes);
}

const post = (body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const DECIDE = { decision: 'approved', revision: 2, method: 'email', reference: 'Email 12 Oct', signerName: 'Pat Customer', signerEmail: 'Pat@Example.com' };
const EVENT = { type: 'ticket.approval_decided', ticketId: TICKET_A, orgId: ORG_A };

function peekRequest(id: string) { dbRows.set('__next:requests', id as never); }
function peekEntry(id: string) { dbRows.set('__next:entries', id as never); }

beforeEach(() => {
  vi.clearAllMocks();
  dbRows.clear();
  ticketsById.clear();
  sp.depth = 0; sp.rolledBack = 0; sp.serviceDepths.length = 0;
  ticketsById.set(TICKET_A, { id: TICKET_A, orgId: ORG_A, partnerId: 'p-1', deviceId: null });
  ticketsById.set(TICKET_B, { id: TICKET_B, orgId: ORG_B, partnerId: 'p-1', deviceId: null });
  dbRows.set(REQ_A, { ticketId: TICKET_A, orgId: ORG_A });
  dbRows.set(REQ_B, { ticketId: TICKET_B, orgId: ORG_B });
  dbRows.set(ENTRY_A, { ticketId: TICKET_A, orgId: ORG_A });
  dbRows.set(ENTRY_B, { ticketId: TICKET_B, orgId: ORG_B });
  authRef.current = auth();
  summary.mockResolvedValue({ requests: [] });
  svc.decideApprovalRequest.mockResolvedValue({ released: ['e1'], stillHeld: [], events: [EVENT] });
  svc.cancelApprovalRequest.mockResolvedValue({ released: [], stillHeld: ['e1'], events: [EVENT] });
  svc.reaskApprovalRequest.mockResolvedValue({ newRequestId: REQ_B, events: [EVENT] });
  svc.writeOffHeldEntry.mockResolvedValue(undefined);
  svc.createStaffApprovalRequest.mockResolvedValue({ requestId: REQ_A, events: [EVENT] });
});

// ── GET /tickets/:id/approval-summary ────────────────────────────────────
describe('GET /tickets/:id/approval-summary (tickets:read)', () => {
  it('returns the summary for a visible ticket', async () => {
    const res = await app().request(`/tickets/${TICKET_A}/approval-summary`);
    expect(res.status).toBe(200);
    expect(summary).toHaveBeenCalledWith(expect.anything(), { ticketId: TICKET_A, partnerId: 'p-1', orgId: ORG_A });
  });
  it('403 without tickets:read', async () => {
    authRef.current = auth({ perms: ['tickets:write'] });
    expect((await app().request(`/tickets/${TICKET_A}/approval-summary`)).status).toBe(403);
    expect(summary).not.toHaveBeenCalled();
  });
  it('403 for organization scope (time entries are not visible there)', async () => {
    authRef.current = auth({ scope: 'organization', orgId: ORG_A });
    expect((await app().request(`/tickets/${TICKET_A}/approval-summary`)).status).toBe(403);
  });
  it('404 for another org\'s ticket', async () => {
    expect((await app().request(`/tickets/${TICKET_B}/approval-summary`)).status).toBe(404);
    expect(summary).not.toHaveBeenCalled();
  });
  it('404 for a ticket outside the caller\'s sites', async () => {
    authRef.current = auth({ siteHiddenTickets: [TICKET_A] });
    expect((await app().request(`/tickets/${TICKET_A}/approval-summary`)).status).toBe(404);
  });
});

// ── POST /tickets/:id/approval-requests ──────────────────────────────────
describe('POST /tickets/:id/approval-requests (tickets:write)', () => {
  it('creates a staff request as the session user and emits the returned events', async () => {
    const res = await app().request(`/tickets/${TICKET_A}/approval-requests`, post({ trigger: 'budget', extensionMinutes: 60 }));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ requestId: REQ_A });
    expect(svc.createStaffApprovalRequest).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ ticketId: TICKET_A, userId: 'u-staff', trigger: 'budget', extensionMinutes: 60 }));
    expect(emit).toHaveBeenCalledWith(EVENT);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ticket.approval_request.create', orgId: ORG_A }));
  });
  it('403 without tickets:write', async () => {
    authRef.current = auth({ perms: ['tickets:read', 'tickets:record_approval'] });
    expect((await app().request(`/tickets/${TICKET_A}/approval-requests`, post({ trigger: 'budget', extensionMinutes: 60 }))).status).toBe(403);
    expect(svc.createStaffApprovalRequest).not.toHaveBeenCalled();
  });
  it('404 for another org\'s ticket', async () => {
    expect((await app().request(`/tickets/${TICKET_B}/approval-requests`, post({ trigger: 'budget', extensionMinutes: 60 }))).status).toBe(404);
    expect(svc.createStaffApprovalRequest).not.toHaveBeenCalled();
  });
  it('404 for a ticket outside the caller\'s sites', async () => {
    authRef.current = auth({ siteHiddenTickets: [TICKET_A] });
    expect((await app().request(`/tickets/${TICKET_A}/approval-requests`, post({ trigger: 'budget', extensionMinutes: 60 }))).status).toBe(404);
  });
  it('maps a service 409 to its code', async () => {
    svc.createStaffApprovalRequest.mockRejectedValue(new ApprovalDecisionError('already', 409, 'REQUEST_ALREADY_PENDING'));
    const res = await app().request(`/tickets/${TICKET_A}/approval-requests`, post({ trigger: 'budget', extensionMinutes: 60 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already', code: 'REQUEST_ALREADY_PENDING' });
  });
});

// ── cancel / re-ask ──────────────────────────────────────────────────────
describe.each([
  { name: 'cancel', path: 'cancel', fn: 'cancelApprovalRequest' as const, body: {} },
  { name: 'reask', path: 'reask', fn: 'reaskApprovalRequest' as const, body: { message: 'Please review' } },
])('POST /ticket-approval-requests/:id/$name (tickets:write)', ({ path, fn, body }) => {
  it('runs the service as the session user', async () => {
    const res = await app().request(`/ticket-approval-requests/${REQ_A}/${path}`, post(body));
    peekRequest(REQ_A);
    expect(res.status).toBe(404); // no peek configured yet → not found
    const ok = await app().request(`/ticket-approval-requests/${REQ_A}/${path}`, post(body));
    expect(ok.status).toBe(200);
    expect(svc[fn]).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestId: REQ_A, userId: 'u-staff' }));
    expect(emit).toHaveBeenCalledWith(EVENT);
  });
  it('403 without tickets:write (record_approval alone is not enough)', async () => {
    peekRequest(REQ_A);
    authRef.current = auth({ perms: ['tickets:read', 'tickets:record_approval'] });
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/${path}`, post(body))).status).toBe(403);
    expect(svc[fn]).not.toHaveBeenCalled();
  });
  it('404 for another org\'s request', async () => {
    peekRequest(REQ_B);
    expect((await app().request(`/ticket-approval-requests/${REQ_B}/${path}`, post(body))).status).toBe(404);
    expect(svc[fn]).not.toHaveBeenCalled();
  });
  it('404 for a request on a ticket outside the caller\'s sites', async () => {
    peekRequest(REQ_A);
    authRef.current = auth({ siteHiddenTickets: [TICKET_A] });
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/${path}`, post(body))).status).toBe(404);
    expect(svc[fn]).not.toHaveBeenCalled();
  });
  it('403 for organization scope', async () => {
    peekRequest(REQ_A);
    authRef.current = auth({ scope: 'organization', orgId: ORG_A });
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/${path}`, post(body))).status).toBe(403);
  });
});

// ── decide-on-behalf ─────────────────────────────────────────────────────
describe('POST /ticket-approval-requests/:id/decide-on-behalf (tickets:record_approval)', () => {
  beforeEach(() => peekRequest(REQ_A));

  it('records the STAFF user as the actor; signer fields are attestation only', async () => {
    const res = await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post(DECIDE));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ released: ['e1'], stillHeld: [] });
    const args = svc.decideApprovalRequest.mock.calls[0]![1];
    expect(args).toEqual({
      requestId: REQ_A, decision: 'approved', revision: 2, note: undefined,
      actor: { kind: 'on_behalf', userId: 'u-staff', method: 'email', reference: 'Email 12 Oct', signerName: 'Pat Customer', signerEmail: 'Pat@Example.com' },
    });
    expect(emit).toHaveBeenCalledWith(EVENT);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket.approval_request.decide_on_behalf', orgId: ORG_A, resourceId: REQ_A,
      details: expect.objectContaining({ decision: 'approved', method: 'email', reference: 'Email 12 Oct', revision: 2 }),
    }));
  });
  it('403 without tickets:record_approval', async () => {
    authRef.current = auth({ perms: ['tickets:read'] });
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post(DECIDE))).status).toBe(403);
    expect(svc.decideApprovalRequest).not.toHaveBeenCalled();
  });
  it('403 for a caller holding tickets:write but not tickets:record_approval', async () => {
    authRef.current = auth({ perms: ['tickets:read', 'tickets:write', 'tickets:manage'] });
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post(DECIDE))).status).toBe(403);
    expect(svc.decideApprovalRequest).not.toHaveBeenCalled();
  });
  it('400 with a blank reference, before the service', async () => {
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post({ ...DECIDE, reference: '   ' }))).status).toBe(400);
    expect(svc.decideApprovalRequest).not.toHaveBeenCalled();
  });
  it('400 when the body tries to name the actor', async () => {
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post({ ...DECIDE, userId: 'u-other' }))).status).toBe(400);
  });
  it('404 for another org\'s request (org B token on org A request, mirrored)', async () => {
    peekRequest(REQ_B);
    expect((await app().request(`/ticket-approval-requests/${REQ_B}/decide-on-behalf`, post(DECIDE))).status).toBe(404);
    authRef.current = auth({ accessibleOrgIds: [ORG_B], canAccessOrg: (id: string) => id === ORG_B });
    peekRequest(REQ_A);
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post(DECIDE))).status).toBe(404);
    expect(svc.decideApprovalRequest).not.toHaveBeenCalled();
  });
  it('404 for a request on a ticket outside the caller\'s sites', async () => {
    authRef.current = auth({ siteHiddenTickets: [TICKET_A] });
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post(DECIDE))).status).toBe(404);
  });
  it.each(['REQUEST_NOT_PENDING', 'REQUEST_CHANGED', 'REQUEST_EXPIRED'] as const)('passes 409 %s through with its code', async (code) => {
    svc.decideApprovalRequest.mockRejectedValue(new ApprovalDecisionError('nope', 409, code));
    const res = await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post(DECIDE));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(code);
    expect(emit).not.toHaveBeenCalled();
  });
  it('rolls back (throws) when the ticket is no longer visible after the decision (moved mid-flight)', async () => {
    svc.decideApprovalRequest.mockImplementation(async () => {
      ticketsById.set(TICKET_A, { id: TICKET_A, orgId: ORG_B, partnerId: 'p-1', deviceId: null });
      return { released: [], stillHeld: [], events: [EVENT] };
    });
    const res = await app().request(`/ticket-approval-requests/${REQ_A}/decide-on-behalf`, post(DECIDE));
    expect(res.status).toBe(404);
    expect(emit).not.toHaveBeenCalled();
  });
});

// ── write-off-held ───────────────────────────────────────────────────────
describe('POST /time-entries/:id/write-off-held (time_entries:manage_billing)', () => {
  beforeEach(() => peekEntry(ENTRY_A));

  it('writes off through the service with the audit collector, then persists the audit', async () => {
    const res = await app().request(`/time-entries/${ENTRY_A}/write-off-held`, post());
    expect(res.status).toBe(200);
    expect(svc.writeOffHeldEntry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entryId: ENTRY_A, actor: expect.objectContaining({ userId: 'u-staff', manageBilling: true }),
    }));
    expect(timeAudit).toHaveBeenCalled();
  });
  it('403 without time_entries:manage_billing', async () => {
    authRef.current = auth({ perms: ['tickets:read', 'tickets:write', 'tickets:record_approval'] });
    expect((await app().request(`/time-entries/${ENTRY_A}/write-off-held`, post())).status).toBe(403);
    expect(svc.writeOffHeldEntry).not.toHaveBeenCalled();
  });
  it('403 for a non-interactive principal even with the grant', async () => {
    authRef.current = auth({ principalKind: 'api_key' });
    expect((await app().request(`/time-entries/${ENTRY_A}/write-off-held`, post())).status).toBe(403);
    expect(svc.writeOffHeldEntry).not.toHaveBeenCalled();
  });
  it('404 for another org\'s entry', async () => {
    peekEntry(ENTRY_B);
    expect((await app().request(`/time-entries/${ENTRY_B}/write-off-held`, post())).status).toBe(404);
    expect(svc.writeOffHeldEntry).not.toHaveBeenCalled();
  });
  it('404 for an entry on a ticket outside the caller\'s sites', async () => {
    authRef.current = auth({ siteHiddenTickets: [TICKET_A] });
    expect((await app().request(`/time-entries/${ENTRY_A}/write-off-held`, post())).status).toBe(404);
  });
  it('404 for an entry with no ticket', async () => {
    dbRows.set(ENTRY_A, { ticketId: null, orgId: ORG_A });
    expect((await app().request(`/time-entries/${ENTRY_A}/write-off-held`, post())).status).toBe(404);
  });
  it('maps ENTRY_NOT_RESOLVABLE to 409', async () => {
    svc.writeOffHeldEntry.mockRejectedValue(new ApprovalDecisionError('pending', 409, 'ENTRY_NOT_RESOLVABLE'));
    const res = await app().request(`/time-entries/${ENTRY_A}/write-off-held`, post());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ENTRY_NOT_RESOLVABLE');
  });
});

// ── review round: savepoint rollback, mapping, org mismatch, partner fallback ──
const MUTATIONS = [
  { name: 'create', url: `/tickets/${TICKET_A}/approval-requests`, body: { trigger: 'budget', extensionMinutes: 60 }, fn: 'createStaffApprovalRequest' as const, peek: () => {} },
  { name: 'cancel', url: `/ticket-approval-requests/${REQ_A}/cancel`, body: {}, fn: 'cancelApprovalRequest' as const, peek: () => peekRequest(REQ_A) },
  { name: 'reask', url: `/ticket-approval-requests/${REQ_A}/reask`, body: {}, fn: 'reaskApprovalRequest' as const, peek: () => peekRequest(REQ_A) },
  { name: 'decide-on-behalf', url: `/ticket-approval-requests/${REQ_A}/decide-on-behalf`, body: DECIDE, fn: 'decideApprovalRequest' as const, peek: () => peekRequest(REQ_A) },
  { name: 'write-off', url: `/time-entries/${ENTRY_A}/write-off-held`, body: {}, fn: 'writeOffHeldEntry' as const, peek: () => peekEntry(ENTRY_A) },
];

describe.each(MUTATIONS)('$name — transactional post-check', ({ url, body, fn, peek }) => {
  beforeEach(() => peek());

  it('runs the service inside a savepoint', async () => {
    expect((await app().request(url, post(body))).status).toBeLessThan(300);
    expect(sp.serviceDepths).toEqual([1]);
    expect(sp.rolledBack).toBe(0);
  });

  it('rolls the savepoint back, answers 404 and emits/audits nothing when the ticket left the caller\'s reach mid-flight', async () => {
    const original = svc[fn].getMockImplementation();
    svc[fn].mockImplementation(async (...a: unknown[]) => {
      ticketsById.set(TICKET_A, { id: TICKET_A, orgId: ORG_B, partnerId: 'p-1', deviceId: null });
      return original ? (original as (...x: unknown[]) => unknown)(...a) : undefined;
    });
    const res = await app().request(url, post(body));
    expect(res.status).toBe(404);
    expect(sp.rolledBack).toBe(1);
    expect(emit).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(timeAudit).not.toHaveBeenCalled();
  });

  it('maps a service 409 with its code, rolls back, and emits nothing', async () => {
    svc[fn].mockRejectedValue(new ApprovalDecisionError('conflict', 409, 'REQUEST_NOT_PENDING'));
    const res = await app().request(url, post(body));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', code: 'REQUEST_NOT_PENDING' });
    expect(sp.rolledBack).toBe(1);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('request/entry whose org differs from its ticket\'s org', () => {
  it.each(MUTATIONS.filter((m) => m.name !== 'create'))('$name answers 404 without calling the service', async ({ url, body, fn, peek }) => {
    dbRows.set(REQ_A, { ticketId: TICKET_A, orgId: ORG_B });
    dbRows.set(ENTRY_A, { ticketId: TICKET_A, orgId: ORG_B });
    peek();
    expect((await app().request(url, post(body))).status).toBe(404);
    expect(svc[fn]).not.toHaveBeenCalled();
  });
});

describe('approval-summary partner resolution', () => {
  it('falls back to the org\'s partner for a ticket with a null partnerId (system scope)', async () => {
    authRef.current = auth({ scope: 'system', partnerId: null });
    ticketsById.set(TICKET_A, { id: TICKET_A, orgId: ORG_A, partnerId: null, deviceId: null });
    dbRows.set('org-row', { partnerId: 'p-9' });
    dbRows.set('__next:orgs', 'org-row' as never);
    expect((await app().request(`/tickets/${TICKET_A}/approval-summary`)).status).toBe(200);
    expect(summary).toHaveBeenCalledWith(expect.anything(), { ticketId: TICKET_A, partnerId: 'p-9', orgId: ORG_A });
  });
  it('404s when neither the ticket nor its org has a partner', async () => {
    authRef.current = auth({ scope: 'system', partnerId: null });
    ticketsById.set(TICKET_A, { id: TICKET_A, orgId: ORG_A, partnerId: null, deviceId: null });
    expect((await app().request(`/tickets/${TICKET_A}/approval-summary`)).status).toBe(404);
    expect(summary).not.toHaveBeenCalled();
  });
});

describe('OrgCurrencyServiceError mapping', () => {
  it('maps ORG_NOT_FOUND to 404', async () => {
    const { OrgCurrencyServiceError } = await import('../../services/orgCurrencyCore');
    peekRequest(REQ_A);
    svc.cancelApprovalRequest.mockRejectedValue(new (OrgCurrencyServiceError as any)('gone', 404, 'ORG_NOT_FOUND'));
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/cancel`, post())).status).toBe(404);
  });
  it('does not disguise an unexpected org-currency error as 404', async () => {
    const { OrgCurrencyServiceError } = await import('../../services/orgCurrencyCore');
    peekRequest(REQ_A);
    svc.cancelApprovalRequest.mockRejectedValue(new (OrgCurrencyServiceError as any)('boom', 500, undefined));
    expect((await app().request(`/ticket-approval-requests/${REQ_A}/cancel`, post())).status).toBe(500);
  });
});
