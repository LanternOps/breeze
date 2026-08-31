import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authRef, getScopedTicketOr404Mock, listActiveTicketDraftsMock, sendTicketDraftMock, discardTicketDraftMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1'] as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  getScopedTicketOr404Mock: vi.fn(),
  listActiveTicketDraftsMock: vi.fn(),
  sendTicketDraftMock: vi.fn(),
  discardTicketDraftMock: vi.fn(),
}));

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: (await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth')).siteAccessCheck,
}));

vi.mock('./tickets', async () => {
  const actual = await vi.importActual<typeof import('./tickets')>('./tickets');
  return {
    ...actual,
    getScopedTicketOr404: getScopedTicketOr404Mock,
  };
});

vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return {
    ...actual,
    listActiveTicketDrafts: listActiveTicketDraftsMock,
    sendTicketDraft: sendTicketDraftMock,
    discardTicketDraft: discardTicketDraftMock,
  };
});

// getScopedTicketOr404 is mocked directly above, so the underlying db chain it
// would otherwise hit never runs in these tests — this stub only needs to
// satisfy module resolution for the other files pulled in transitively.
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

import { ticketsRoutes } from './index';
import { TicketServiceError } from '../../services/ticketService';

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const DRAFT_ID = 'aaaaaaaa-1111-4222-8333-444455556666';

const STUB_TICKET = { id: TICKET_ID, orgId: 'org-1', partnerId: 'p-1', deviceId: null, subject: 'Printer' };

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function resetAuth() {
  vi.clearAllMocks();
  authRef.current = {
    scope: 'partner',
    user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
    partnerId: 'p-1',
    orgId: null,
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: (_id: string) => true,
  };
}

describe('GET /tickets/:id/ai-drafts', () => {
  beforeEach(resetAuth);

  it('returns the active drafts for an in-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    const drafts = [{ id: DRAFT_ID, kind: 'reply', content: 'Hi there', createdAt: new Date(), runId: null }];
    listActiveTicketDraftsMock.mockResolvedValue(drafts);

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(listActiveTicketDraftsMock).toHaveBeenCalledWith(TICKET_ID);
  });

  it('404s when the ticket is out of scope', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts`);

    expect(res.status).toBe(404);
    expect(listActiveTicketDraftsMock).not.toHaveBeenCalled();
  });

  it('403s when an organization-scoped caller carries no orgId', async () => {
    authRef.current = { ...authRef.current, scope: 'organization', orgId: null };

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts`);

    expect(res.status).toBe(403);
    expect(getScopedTicketOr404Mock).not.toHaveBeenCalled();
  });
});

describe('POST /tickets/:id/ai-drafts/:draftId/send', () => {
  beforeEach(resetAuth);

  it('sends the draft and returns the new comment', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    sendTicketDraftMock.mockResolvedValue({ comment: { id: 'c-1' }, firstResponseStamped: true });

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'c-1' });
    expect(sendTicketDraftMock).toHaveBeenCalledWith(
      TICKET_ID,
      DRAFT_ID,
      undefined,
      expect.objectContaining({ userId: 'u-1' }),
    );
  });

  it('passes an edited content override through to the service', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    sendTicketDraftMock.mockResolvedValue({ comment: { id: 'c-1' }, firstResponseStamped: false });

    await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ content: 'Edited reply body' }),
    });

    expect(sendTicketDraftMock).toHaveBeenCalledWith(TICKET_ID, DRAFT_ID, 'Edited reply body', expect.anything());
  });

  it('404s when the ticket is out of scope, without calling the service', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(sendTicketDraftMock).not.toHaveBeenCalled();
  });

  it('409s when the service rejects a resolution_note-kind draft', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    sendTicketDraftMock.mockRejectedValue(new TicketServiceError('Only reply drafts can be sent', 409));

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
  });

  it('409s on a concurrent double-send', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    sendTicketDraftMock.mockRejectedValue(new TicketServiceError('Draft is no longer active', 409));

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
  });
});

describe('POST /tickets/:id/ai-drafts/:draftId/discard', () => {
  beforeEach(resetAuth);

  it('discards an active draft', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    discardTicketDraftMock.mockResolvedValue({ id: DRAFT_ID });

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/discard`, {
      method: 'POST',
      headers: jsonHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: DRAFT_ID });
    expect(discardTicketDraftMock).toHaveBeenCalledWith(TICKET_ID, DRAFT_ID);
  });

  it('404s when the draft does not exist', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    discardTicketDraftMock.mockRejectedValue(new TicketServiceError('Draft not found', 404));

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/discard`, {
      method: 'POST',
      headers: jsonHeaders(),
    });

    expect(res.status).toBe(404);
  });

  it('409s when the draft is no longer active', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    discardTicketDraftMock.mockRejectedValue(new TicketServiceError('Draft is no longer active', 409));

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/discard`, {
      method: 'POST',
      headers: jsonHeaders(),
    });

    expect(res.status).toBe(409);
  });

  it('404s when the ticket is out of scope, without calling the service', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);

    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-drafts/${DRAFT_ID}/discard`, {
      method: 'POST',
      headers: jsonHeaders(),
    });

    expect(res.status).toBe(404);
    expect(discardTicketDraftMock).not.toHaveBeenCalled();
  });
});
