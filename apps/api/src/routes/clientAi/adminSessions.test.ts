import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, dbUpdateMock, writeRouteAuditMock, orgConditionMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  orgConditionMock: vi.fn(() => ({ __scope: 'caller-orgs' })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      canAccessOrg: (id: string) => id === '0c0c0c0c-1111-4222-8333-444455556666',
      orgCondition: orgConditionMock,
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({ db: { select: dbSelectMock, update: dbUpdateMock } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { clientAiAdminSessionRoutes, countRedactions } from './adminSessions';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';
const SESSION_ID = '5e5e5e5e-1111-4222-8333-444455556666';
const CLIENT_USER_ID = 'beefbeef-1111-4222-8333-444455556666';

const SESSION_ROW = {
  id: SESSION_ID,
  orgId: ORG_ID,
  orgName: 'Contoso Accounting',
  clientUserId: CLIENT_USER_ID,
  userEmail: 'finance.user@contoso.com',
  title: 'Q3 budget review',
  model: 'claude-sonnet-4-5-20250929',
  status: 'closed',
  type: 'excel_client',
  turnCount: 6,
  totalCostCents: 12.5,
  totalInputTokens: 4000,
  totalOutputTokens: 900,
  flaggedAt: null,
  flaggedBy: null,
  flagReason: null,
  createdAt: new Date('2026-06-10T09:00:00Z'),
  lastActivityAt: new Date('2026-06-10T09:20:00Z'),
};

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminSessionRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
});

describe('GET /client-ai/admin/sessions', () => {
  it('returns rows + pagination (query 1 = rows, query 2 = count)', async () => {
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      return call === 1 ? chain([SESSION_ROW]) : chain([{ n: 1 }]);
    });
    const res = await buildApp().request('/client-ai/admin/sessions?flagged=false', {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      id: SESSION_ID,
      orgName: 'Contoso Accounting',
      userEmail: 'finance.user@contoso.com',
      turnCount: 6,
      totalCostCents: 12.5,
    });
    expect(body.data[0].startedAt).toBeDefined();
    expect(body.pagination).toMatchObject({ total: 1, limit: 50, offset: 0 });
  });

  it('scopes the unfiltered list to the caller at the app layer (defense-in-depth)', async () => {
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      return call === 1 ? chain([SESSION_ROW]) : chain([{ n: 1 }]);
    });
    const res = await buildApp().request('/client-ai/admin/sessions', { headers: AUTHED });
    expect(res.status).toBe(200);
    // With no orgId param, the list MUST restrict to the caller's accessible orgs
    // at the app layer (agreeing with forced RLS) via auth.orgCondition(aiSessions.orgId).
    expect(orgConditionMock).toHaveBeenCalled();
  });

  it('404s an orgId filter outside the caller scope (no existence oracle)', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/sessions?orgId=${OTHER_ORG_ID}`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });

  it('400s an unparsable date filter', async () => {
    const res = await buildApp().request('/client-ai/admin/sessions?from=not-a-date', {
      headers: AUTHED,
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /client-ai/admin/sessions/:id', () => {
  it('returns transcript with redaction counts and tool trail', async () => {
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      if (call === 1) return chain([SESSION_ROW]);
      if (call === 2)
        return chain([
          {
            id: 'm1',
            role: 'user',
            content: 'Card [REDACTED:creditCard] and [REDACTED:creditCard], ssn [REDACTED:ssn]',
            contentBlocks: null,
            toolName: null,
            toolInput: null,
            toolOutput: null,
            createdAt: new Date(),
          },
        ]);
      return chain([
        {
          id: 't1',
          toolName: 'write_range',
          toolInput: { range: 'B2:B4' },
          status: 'completed',
          approvedBy: null,
          approvedAt: new Date(),
          errorMessage: null,
          durationMs: 240,
          createdAt: new Date(),
          completedAt: new Date(),
        },
      ]);
    });
    const res = await buildApp().request(`/client-ai/admin/sessions/${SESSION_ID}`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe(SESSION_ID);
    expect(body.messages[0].redactionCounts).toEqual({ creditCard: 2, ssn: 1 });
    expect(body.toolExecutions[0].toolName).toBe('write_range');
  });

  it('404s when the session does not exist / is not excel_client', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(`/client-ai/admin/sessions/${SESSION_ID}`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });

  it('404s a session in an inaccessible org (belt-and-braces over RLS)', async () => {
    dbSelectMock.mockImplementation(() => chain([{ ...SESSION_ROW, orgId: OTHER_ORG_ID }]));
    const res = await buildApp().request(`/client-ai/admin/sessions/${SESSION_ID}`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});

describe('flag / unflag', () => {
  it('POST flags with a reason and audits', async () => {
    dbSelectMock.mockImplementation(() => chain([SESSION_ROW]));
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'POST', headers: AUTHED, body: JSON.stringify({ reason: 'PII concern' }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(dbUpdateMock).toHaveBeenCalled();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'client_ai.session.flag',
        resourceType: 'ai_session',
        resourceId: SESSION_ID,
      })
    );
  });

  it('POST accepts an empty body', async () => {
    dbSelectMock.mockImplementation(() => chain([SESSION_ROW]));
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'POST', headers: AUTHED }
    );
    expect(res.status).toBe(200);
  });

  it('DELETE unflags and audits', async () => {
    dbSelectMock.mockImplementation(() =>
      chain([{ ...SESSION_ROW, flaggedAt: new Date(), flagReason: 'old' }])
    );
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'DELETE', headers: AUTHED }
    );
    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.session.unflag' })
    );
  });

  it('404s flagging a missing session', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'POST', headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });
});

describe('countRedactions', () => {
  it('counts markers per type and tolerates null', () => {
    expect(countRedactions(null)).toEqual({});
    expect(countRedactions('[REDACTED:iban] x [REDACTED:iban] [REDACTED:apiKey]')).toEqual({
      iban: 2,
      apiKey: 1,
    });
  });
});
