import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, dbInsertMock, dbUpdateMock, dbDeleteMock, writeRouteAuditMock, authState } =
  vi.hoisted(() => ({
    dbSelectMock: vi.fn(),
    dbInsertMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    dbDeleteMock: vi.fn(),
    writeRouteAuditMock: vi.fn(),
    authState: {
      scope: 'partner' as string,
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666' as string | null,
    },
  }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      orgId: authState.scope === 'organization' ? '0c0c0c0c-1111-4222-8333-444455556666' : null,
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

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock, delete: dbDeleteMock },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { clientAiAdminTemplateRoutes } from './adminTemplates';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';
const PARTNER_ID = 'f0f0f0f0-1111-4222-8333-444455556666';
const TEMPLATE_ID = '7e7e7e7e-1111-4222-8333-444455556666';

const PARTNER_ROW = {
  id: TEMPLATE_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  orgName: null,
  name: 'Quarterly variance walkthrough',
  description: null,
  promptBody: 'Explain the variance between the selected columns.',
  category: 'finance',
  createdAt: new Date(),
  updatedAt: new Date(),
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
  app.route('/client-ai/admin', clientAiAdminTemplateRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.partnerId = PARTNER_ID;
  dbSelectMock.mockImplementation(() => chain([PARTNER_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn((v: Record<string, unknown>) => ({
      returning: vi.fn(() => Promise.resolve([{ ...PARTNER_ROW, ...v }])),
    })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn((v: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ ...PARTNER_ROW, ...v }])),
      })),
    })),
  }));
  dbDeleteMock.mockImplementation(() => ({
    where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([PARTNER_ROW])) })),
  }));
});

describe('GET /client-ai/admin/templates', () => {
  it('lists all RLS-visible templates with orgName', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ id: TEMPLATE_ID, partnerId: PARTNER_ID, orgId: null });
  });

  it('404s an orgId filter outside the caller scope', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/templates?orgId=${OTHER_ORG_ID}`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /client-ai/admin/templates', () => {
  it('creates a partner-wide row when orgId is null and audits', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'New', promptBody: 'Body', orgId: null }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template).toMatchObject({ orgId: null, partnerId: PARTNER_ID });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.template.create',
        resourceType: 'client_ai_prompt_template',
        details: expect.objectContaining({ scope: 'partner' }),
      })
    );
  });

  it('creates an org-scoped row when orgId is provided', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'Org one', promptBody: 'Body', orgId: ORG_ID }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).template).toMatchObject({ orgId: ORG_ID, partnerId: null });
  });

  it('stores a host subset and canonicalizes "all hosts" to null', async () => {
    const subset = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'Deck', promptBody: 'B', orgId: null, hosts: ['powerpoint', 'word'] }),
    });
    expect((await subset.json()).template.hosts).toEqual(['powerpoint', 'word']);

    const all = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({
        name: 'Everywhere',
        promptBody: 'B',
        orgId: null,
        hosts: ['excel', 'word', 'powerpoint', 'outlook'],
      }),
    });
    expect((await all.json()).template.hosts).toBeNull(); // all four ⇒ all apps
  });

  it('404s an org-scoped create for an inaccessible org', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'X', promptBody: 'Y', orgId: OTHER_ORG_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('403s a partner-wide create from organization scope (clean error, not RLS 42501)', async () => {
    authState.scope = 'organization';
    authState.partnerId = null;
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'X', promptBody: 'Y', orgId: null }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_scope_required' });
  });

  it('400s a strict-schema violation', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'X', promptBody: 'Y', surprise: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /client-ai/admin/templates/:id', () => {
  it('updates fields on an existing row and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).template.name).toBe('Renamed');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.template.update', resourceId: TEMPLATE_ID })
    );
  });

  it('404s a missing row', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /client-ai/admin/templates/:id', () => {
  it('deletes and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'DELETE',
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.template.delete', resourceId: TEMPLATE_ID })
    );
  });

  it('404s when nothing was deleted', async () => {
    dbDeleteMock.mockImplementation(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
    }));
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'DELETE',
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});
