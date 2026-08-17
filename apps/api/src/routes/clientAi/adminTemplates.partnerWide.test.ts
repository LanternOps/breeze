import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authRef,
  selectResult,
  dbInsertMock,
  dbUpdateMock,
  dbDeleteMock,
} = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as 'partner' | 'organization' | 'system',
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null | undefined,
      orgId: null as string | null,
      accessibleOrgIds: [] as string[],
      canAccessOrg: (_orgId: string) => false,
      user: { id: 'u-1', email: 'admin@example.com' },
    },
  },
  selectResult: vi.fn(),
  dbInsertMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  dbDeleteMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  }),
  requirePermission: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, any> = {};
      for (const method of ['from', 'leftJoin', 'where', 'limit', 'orderBy']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(selectResult()).then(resolve, reject);
      return chain;
    }),
    insert: dbInsertMock,
    update: dbUpdateMock,
    delete: dbDeleteMock,
  },
}));

vi.mock('../../db/schema/clientAi', () => ({
  clientAiPromptTemplates: {
    id: 'id', orgId: 'orgId', partnerId: 'partnerId', name: 'name', description: 'description',
    promptBody: 'promptBody', category: 'category', hosts: 'hosts', createdAt: 'createdAt',
    updatedAt: 'updatedAt', createdBy: 'createdBy',
  },
}));
vi.mock('../../db/schema/orgs', () => ({ organizations: { id: 'id', name: 'name' } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

import { authMiddleware } from '../../middleware/auth';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { clientAiAdminTemplateRoutes } from './adminTemplates';

const TEMPLATE_ID = '77777777-7777-4777-8777-777777777777';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

const PARTNER_ROW = {
  id: TEMPLATE_ID,
  orgId: null,
  partnerId: 'p-1',
  orgName: null,
  name: 'Quarterly summary',
  description: null,
  promptBody: 'Summarize the quarter.',
  category: 'finance',
  hosts: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function setPartnerAuth(partnerOrgAccess: 'all' | 'selected') {
  authRef.current = {
    scope: 'partner',
    partnerId: 'p-1',
    partnerOrgAccess,
    orgId: null,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    user: { id: 'u-1', email: 'admin@example.com' },
  };
}

function setOrgAuth() {
  authRef.current = {
    scope: 'organization',
    partnerId: null,
    partnerOrgAccess: undefined,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    user: { id: 'u-2', email: 'org-admin@example.com' },
  };
}

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminTemplateRoutes);
  return app;
}

const HEADERS = { 'Content-Type': 'application/json' };

function createRequest(app: Hono) {
  return app.request('/client-ai/admin/templates', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ name: 'Quarterly summary', promptBody: 'Summarize the quarter.' }),
  });
}

function updateRequest(app: Hono) {
  return app.request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ name: 'Updated summary' }),
  });
}

function deleteRequest(app: Hono) {
  return app.request(`/client-ai/admin/templates/${TEMPLATE_ID}`, { method: 'DELETE' });
}

describe('client AI admin template partner-wide capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPartnerAuth('all');
    selectResult.mockResolvedValue([PARTNER_ROW]);
    dbInsertMock.mockImplementation(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        returning: vi.fn(async () => [{ ...PARTNER_ROW, ...values }]),
      })),
    }));
    dbUpdateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ ...PARTNER_ROW, ...values }]),
        })),
      })),
    }));
    dbDeleteMock.mockImplementation(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [PARTNER_ROW]) })),
    }));
  });

  it('POST /templates without orgId returns 403 for selected access', async () => {
    setPartnerAuth('selected');

    const res = await createRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('POST /templates without orgId succeeds for all access', async () => {
    const res = await createRequest(makeApp());

    expect(res.status).toBe(201);
    expect((await res.json()).template).toMatchObject({ orgId: null, partnerId: 'p-1' });
    expect(dbInsertMock).toHaveBeenCalledOnce();
  });

  it('PUT /templates/:id returns 403 for selected access on a partner-wide row', async () => {
    setPartnerAuth('selected');

    const res = await updateRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('PUT /templates/:id succeeds for all access on the same partner-wide row', async () => {
    const res = await updateRequest(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).template.name).toBe('Updated summary');
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });

  it('DELETE /templates/:id returns 403 for selected access on a partner-wide row', async () => {
    setPartnerAuth('selected');

    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });

  it('DELETE /templates/:id succeeds for all access on the same partner-wide row', async () => {
    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(dbDeleteMock).toHaveBeenCalledOnce();
  });

  it('keeps an org-owned row writable by its organization caller', async () => {
    const orgRow = { ...PARTNER_ROW, orgId: ORG_ID, partnerId: null };
    setOrgAuth();
    selectResult.mockResolvedValue([orgRow]);
    dbUpdateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...orgRow, ...values }]) })),
      })),
    }));
    dbDeleteMock.mockImplementation(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [orgRow]) })),
    }));

    const putRes = await updateRequest(makeApp());
    const deleteRes = await deleteRequest(makeApp());

    expect(putRes.status).toBe(200);
    expect(deleteRes.status).toBe(200);
    expect(dbUpdateMock).toHaveBeenCalledOnce();
    expect(dbDeleteMock).toHaveBeenCalledOnce();
  });
});
