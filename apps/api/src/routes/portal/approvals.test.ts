import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Call-order log: proves the decision runs inside its own system context that
// has CLOSED (committed) before any event is queued.
const { order } = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('../../db', () => ({
  db: { __db: true },
  runOutsideDbContext: <T>(fn: () => T): T => { order.push('outside:enter'); const r = fn(); return r; },
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => {
    order.push('system:enter');
    try { return await fn(); } finally { order.push('system:exit'); }
  },
}));

const { listMock, findMock } = vi.hoisted(() => ({ listMock: vi.fn(), findMock: vi.fn() }));
vi.mock('../../services/ticketApproval/portal', () => ({
  listPortalApprovals: listMock,
  findPortalApproval: findMock,
}));

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock('../../services/ticketApproval/decisions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ticketApproval/decisions')>();
  return { ...actual, decideApprovalRequest: decideMock };
});

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock('../../services/ticketEvents', () => ({ emitTicketEvent: emitMock }));

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));
vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return { ...actual, writePortalAudit: auditMock };
});

vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => '203.0.113.7' }));

import { portalApprovalRoutes } from './approvals';
import { ApprovalDecisionError } from '../../services/ticketApproval/decisions';
import { CSRF_HEADER_NAME, PORTAL_CSRF_COOKIE_NAME } from './schemas';

const SESSION_ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PORTAL_USER = '44444444-4444-4444-8444-444444444444';
const REQ = '11111111-1111-4111-8111-111111111111';
const TICKET = '55555555-5555-4555-8555-555555555555';
const CSRF = 'csrf-token-abc';

function buildApp(o: { authMethod?: 'cookie' | 'bearer'; email?: string } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: PORTAL_USER, orgId: SESSION_ORG, email: o.email ?? 'Approver@Example.test', name: 'Avery Approver',
        contactId: null, receiveNotifications: true, status: 'active',
      },
      token: 't',
      authMethod: o.authMethod ?? 'cookie',
      timezone: 'UTC',
    });
    await next();
  });
  app.route('/', portalApprovalRoutes);
  return app;
}

const view = (over: Record<string, unknown> = {}) => ({
  id: REQ, ticketId: TICKET, ticketNumber: 'T-1042', ticketSubject: 'Printer down', trigger: 'budget',
  status: 'pending', revision: 3, role: 'approver', canDecide: true, ...over,
});

function post(path: string, body: unknown, o: { csrf?: boolean; app?: Hono } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'UA/1.0' };
  if (o.csrf !== false) {
    headers[CSRF_HEADER_NAME] = CSRF;
    headers.cookie = `${PORTAL_CSRF_COOKIE_NAME}=${CSRF}`;
  }
  return (o.app ?? buildApp()).request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

const decidedEvent = {
  type: 'ticket.approval_decided', ticketId: TICKET, orgId: SESSION_ORG, partnerId: 'p1', actorUserId: null,
  payload: { requestId: REQ, trigger: 'budget', status: 'approved' },
};

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  emitMock.mockImplementation(async () => { order.push('emit'); });
});

describe('GET /approvals', () => {
  it('lists only for the session org and the session email — request selectors are ignored', async () => {
    listMock.mockResolvedValue([view()]);
    const res = await buildApp().request(
      `/approvals?orgId=${OTHER_ORG}&email=someone@else.test`,
      { headers: { 'X-Org-Id': OTHER_ORG } },
    );
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith({ __db: true }, { orgId: SESSION_ORG, email: 'Approver@Example.test', pendingOnly: false });
    expect((await res.json()).data).toEqual([view()]);
  });

  it('?status=pending asks the service for pending requests only', async () => {
    listMock.mockResolvedValue([]);
    await buildApp().request('/approvals?status=pending');
    expect(listMock).toHaveBeenCalledWith({ __db: true }, { orgId: SESSION_ORG, email: 'Approver@Example.test', pendingOnly: true });
  });

  it('rejects an unknown status filter', async () => {
    const res = await buildApp().request('/approvals?status=approved');
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('POST /approvals/:id/approve|deny', () => {
  const body = { revision: 3, signerName: 'Avery Approver', note: 'Go ahead' };

  it('an approver decides as the SESSION portal user, in a committed system context, then emits', async () => {
    findMock.mockResolvedValue(view());
    decideMock.mockImplementation(async () => { order.push('decide'); return { released: ['e1'], stillHeld: [], events: [decidedEvent] }; });

    const res = await post(`/approvals/${REQ}/approve`, body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'approved', releasedEntryCount: 1, stillHeldEntryCount: 0 } });
    expect(findMock).toHaveBeenCalledWith({ __db: true }, { orgId: SESSION_ORG, requestId: REQ, email: 'Approver@Example.test' });
    expect(decideMock).toHaveBeenCalledWith({ __db: true }, {
      requestId: REQ, decision: 'approved', revision: 3, note: 'Go ahead',
      actor: { kind: 'customer', portalUserId: PORTAL_USER, signerName: 'Avery Approver', ip: '203.0.113.7', userAgent: 'UA/1.0' },
    });
    // The system transaction closed before the event was queued: a decision
    // that rolls back can never have emitted.
    expect(order).toEqual(['outside:enter', 'system:enter', 'decide', 'system:exit', 'emit']);
    expect(emitMock).toHaveBeenCalledWith(decidedEvent);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: SESSION_ORG, actorType: 'user', actorId: PORTAL_USER, action: 'portal.ticket_approval.approve',
      resourceType: 'ticket_approval_request', resourceId: REQ,
      details: expect.objectContaining({ ticketId: TICKET, revision: 3 }),
    }));
  });

  it('deny passes decision "denied"', async () => {
    findMock.mockResolvedValue(view());
    decideMock.mockResolvedValue({ released: [], stillHeld: ['e1', 'e2'], events: [] });
    const res = await post(`/approvals/${REQ}/deny`, { revision: 3, signerName: 'Avery' });
    expect(res.status).toBe(200);
    expect(decideMock.mock.calls[0]![1]).toMatchObject({ decision: 'denied', revision: 3 });
    expect(decideMock.mock.calls[0]![1].note).toBeUndefined();
  });

  it('a request in another org (or one the user is not a recipient of) is 404 and decides nothing', async () => {
    findMock.mockResolvedValue(null);
    const res = await post(`/approvals/${REQ}/approve`, body);
    expect(res.status).toBe(404);
    expect(decideMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('a notify-only recipient is 403 NOT_AN_APPROVER and decides nothing', async () => {
    findMock.mockResolvedValue(view({ role: 'notify', canDecide: false }));
    const res = await post(`/approvals/${REQ}/approve`, body);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_AN_APPROVER');
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('a stale revision is 409 REQUEST_CHANGED and emits nothing', async () => {
    findMock.mockResolvedValue(view());
    decideMock.mockRejectedValue(new ApprovalDecisionError('changed', 409, 'REQUEST_CHANGED'));
    const res = await post(`/approvals/${REQ}/approve`, { ...body, revision: 2 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REQUEST_CHANGED');
    expect(emitMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each([
    ['REQUEST_NOT_PENDING', 409], ['REQUEST_EXPIRED', 409], ['NOT_AN_APPROVER', 403],
  ] as const)('maps the service refusal %s to %i', async (code, status) => {
    findMock.mockResolvedValue(view());
    decideMock.mockRejectedValue(new ApprovalDecisionError('no', status, code));
    const res = await post(`/approvals/${REQ}/approve`, body);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it('an unexpected failure inside the decision emits nothing', async () => {
    findMock.mockResolvedValue(view());
    decideMock.mockRejectedValue(new Error('boom'));
    const app = buildApp();
    app.onError((_err, c) => c.json({ error: 'internal' }, 500));
    const res = await post(`/approvals/${REQ}/approve`, body, { app });
    expect(res.status).toBe(500);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it.each([
    ['email', { email: 'boss@example.test' }],
    ['approverEmail', { approverEmail: 'boss@example.test' }],
    ['userId', { userId: '00000000-0000-4000-8000-000000000000' }],
    ['portalUserId', { portalUserId: '00000000-0000-4000-8000-000000000000' }],
  ])('a body carrying an identity field (%s) is rejected 400 and never reaches the service', async (_name, extra) => {
    findMock.mockResolvedValue(view());
    const res = await post(`/approvals/${REQ}/approve`, { ...body, ...extra });
    expect(res.status).toBe(400);
    expect(findMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing revision', { signerName: 'A' }],
    ['blank signer', { revision: 1, signerName: '   ' }],
    ['non-integer revision', { revision: 1.5, signerName: 'A' }],
  ])('rejects an invalid body (%s)', async (_n, b) => {
    const res = await post(`/approvals/${REQ}/approve`, b);
    expect(res.status).toBe(400);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('a cookie session without the CSRF token is 403 and decides nothing', async () => {
    findMock.mockResolvedValue(view());
    const res = await post(`/approvals/${REQ}/approve`, body, { csrf: false });
    expect(res.status).toBe(403);
    expect(findMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('a non-JSON body is refused 415 before the service', async () => {
    const res = await buildApp().request(`/approvals/${REQ}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', [CSRF_HEADER_NAME]: CSRF, cookie: `${PORTAL_CSRF_COOKIE_NAME}=${CSRF}` },
      body: 'revision=1&signerName=A',
    });
    expect(res.status).toBe(415);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('a malformed id is 400', async () => {
    const res = await post('/approvals/not-a-uuid/approve', body);
    expect(res.status).toBe(400);
    expect(findMock).not.toHaveBeenCalled();
  });
});
