import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  dbSelectMock,
  dbInsertMock,
  dbDeleteMock,
  writeRouteAuditMock,
  getOrgPolicyMock,
} = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbDeleteMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  getOrgPolicyMock: vi.fn(),
}));

// Accessible org for the partner-scoped test auth context. Literal because
// vi.mock factories are hoisted.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
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

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, delete: dbDeleteMock },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/clientAiPolicy', () => ({ getOrgPolicy: getOrgPolicyMock }));

import { clientAiAdminRoutes } from './admin';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666'; // not accessible
const TID = '6f4f4f4f-1111-4222-8333-444455556666';

const MAPPING_ROW = {
  id: 'a1a1a1a1-1111-4222-8333-444455556666',
  orgId: ORG_ID,
  entraTenantId: TID,
  createdAt: new Date(),
  updatedAt: new Date(),
  aiForOfficeEnabled: true,
};

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows)) })),
    })),
  };
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai/admin', clientAiAdminRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  dbSelectMock.mockImplementation(() => selectChain([MAPPING_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([MAPPING_ROW])),
      })),
    })),
  }));
  dbDeleteMock.mockImplementation(() => ({
    where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([MAPPING_ROW])) })),
  }));
});

describe('client-ai admin — tenant mapping', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`);
    expect(res.status).toBe(401);
  });

  it('404s when the caller partner has AI for Office disabled', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ aiForOfficeEnabled: false }]));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });

  it('404s for an org outside the caller scope (no existence oracle)', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/orgs/${OTHER_ORG_ID}/tenant-mapping`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });

  it('GET returns the mapping when present', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mapping).toMatchObject({ orgId: ORG_ID, entraTenantId: TID });
  });

  it('GET returns mapping: null when absent', async () => {
    // First db.select is the partner entitlement gate; second is the mapping lookup.
    dbSelectMock
      .mockImplementationOnce(() => selectChain([{ aiForOfficeEnabled: true }]))
      .mockImplementationOnce(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mapping).toBeNull();
  });

  it('PUT rejects a non-GUID tenant id with 400', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ entraTenantId: 'contoso.onmicrosoft.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT upserts the mapping and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ entraTenantId: TID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mapping).toMatchObject({ entraTenantId: TID });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'client_ai.tenant_mapping.upsert',
        resourceType: 'client_ai_tenant_mapping',
      })
    );
  });

  it('PUT maps a tenant-uniqueness violation to 409 tenant_already_mapped', async () => {
    dbInsertMock.mockImplementation(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.reject(Object.assign(new Error('duplicate'), { cause: { code: '23505' } }))
          ),
        })),
      })),
    }));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ entraTenantId: TID }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'tenant_already_mapped' });
  });

  it('DELETE removes the mapping and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'DELETE',
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mapping).toBeNull();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.tenant_mapping.delete' })
    );
  });
});

describe('client-ai admin — policy', () => {
  it('GET returns the effective policy (defaults when no row)', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: false,
      userAccess: 'all',
      selectedUserIds: [],
      allowedProviders: ['anthropic'],
      allowedModels: [],
      writeMode: 'readwrite',
      dlpConfig: {},
      dailyBudgetCents: null,
      monthlyBudgetCents: null,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: {},
    });
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toMatchObject({ enabled: false, allowedProviders: ['anthropic'] });
  });

  it('PUT rejects unknown fields (strict schema)', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ enabled: true, surprise: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT upserts provided knobs only and audits the changed keys', async () => {
    getOrgPolicyMock.mockResolvedValue({ orgId: ORG_ID, enabled: true });
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ enabled: true, writeMode: 'readonly', dailyBudgetCents: 500 }),
    });
    expect(res.status).toBe(200);
    expect(dbInsertMock).toHaveBeenCalled();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.policy.update',
        details: expect.objectContaining({
          changedKeys: expect.arrayContaining(['enabled', 'writeMode', 'dailyBudgetCents']),
        }),
      })
    );
  });

  it('PUT persists writeApproval and audits it as a changed key', async () => {
    getOrgPolicyMock.mockResolvedValue({ orgId: ORG_ID, enabled: true });
    const valuesMock = vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([MAPPING_ROW])),
      })),
    }));
    dbInsertMock.mockImplementation(() => ({ values: valuesMock }));

    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ writeApproval: 'allow_auto' }),
    });

    expect(res.status).toBe(200);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ writeApproval: 'allow_auto' })
    );
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          changedKeys: expect.arrayContaining(['writeApproval']),
        }),
      })
    );
  });

  it('PUT rejects an invalid writeApproval value (400)', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ writeApproval: 'force_auto' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s policy routes for an inaccessible org', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${OTHER_ORG_ID}/policy`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});
