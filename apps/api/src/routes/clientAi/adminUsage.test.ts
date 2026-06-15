import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, writeRouteAuditMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
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

vi.mock('../../db', () => ({ db: { select: dbSelectMock } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { clientAiAdminUsageRoutes } from './adminUsage';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';

const USAGE_ROWS = [
  {
    periodKey: '2026-05',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'beefbeef-1111-4222-8333-444455556666',
    userEmail: 'finance.user@contoso.com',
    inputTokens: 10000,
    outputTokens: 2000,
    totalCostCents: 150.4,
    sessionCount: 4,
    messageCount: 40,
  },
  {
    periodKey: '2026-06',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'cafecafe-1111-4222-8333-444455556666',
    userEmail: 'ap.clerk@contoso.com',
    inputTokens: 5000,
    outputTokens: 1000,
    totalCostCents: 75.1,
    sessionCount: 2,
    messageCount: 18,
  },
];

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
  app.route('/client-ai/admin', clientAiAdminUsageRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token' };

beforeEach(() => {
  vi.clearAllMocks();
  dbSelectMock.mockImplementation(() => chain(USAGE_ROWS));
});

describe('GET /client-ai/admin/usage', () => {
  it('400s a missing/invalid month range', async () => {
    expect((await buildApp().request('/client-ai/admin/usage', { headers: AUTHED })).status).toBe(400);
    expect(
      (
        await buildApp().request('/client-ai/admin/usage?from=2026-06-01&to=2026-06', {
          headers: AUTHED,
        })
      ).status
    ).toBe(400);
  });

  it('returns per-user rows and computed totals', async () => {
    const res = await buildApp().request(
      '/client-ai/admin/usage?from=2026-05&to=2026-06',
      { headers: AUTHED }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      month: '2026-05',
      orgName: 'Contoso Accounting',
      userEmail: 'finance.user@contoso.com',
      costCents: 150.4,
    });
    expect(body.totals).toMatchObject({
      messageCount: 58,
      sessionCount: 6,
      inputTokens: 15000,
      outputTokens: 3000,
      costCents: 225.5,
    });
  });

  it('404s an orgId outside the caller scope', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/usage?from=2026-05&to=2026-06&orgId=${OTHER_ORG_ID}`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /client-ai/admin/usage.csv', () => {
  it('streams text/csv with the pinned column order and audits the export', async () => {
    const res = await buildApp().request(
      '/client-ai/admin/usage.csv?from=2026-05&to=2026-06',
      { headers: AUTHED }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('client-ai-usage-2026-05-to-2026-06.csv');
    const text = await res.text();
    const lines = text.split('\n');
    expect(lines[0]).toBe('month,org_name,user_email,messages,sessions,input_tokens,output_tokens,cost_cents');
    expect(lines[1]).toContain('"2026-05"');
    expect(lines[1]).toContain('"finance.user@contoso.com"');
    expect(lines).toHaveLength(3);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.usage.export',
        details: expect.objectContaining({ rowCount: 2, from: '2026-05', to: '2026-06' }),
      })
    );
  });

  it('CSV cells are formula-neutralized (spreadsheetExport)', async () => {
    dbSelectMock.mockImplementation(() =>
      chain([{ ...USAGE_ROWS[0], userEmail: '=HYPERLINK("evil")' }])
    );
    const res = await buildApp().request(
      '/client-ai/admin/usage.csv?from=2026-05&to=2026-06',
      { headers: AUTHED }
    );
    const text = await res.text();
    expect(text).toContain(`"'=HYPERLINK(""evil"")"`);
  });
});
