import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectResult, dbInsertMock, dbUpdateMock, dbDeleteMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as const,
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

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => selectResult()) })),
      })),
    })),
    insert: dbInsertMock,
    update: dbUpdateMock,
    delete: dbDeleteMock,
  },
}));

vi.mock('../db/schema', () => ({
  alertTemplates: {
    id: 'id', orgId: 'orgId', partnerId: 'partnerId', name: 'name', description: 'description',
    category: 'category', conditions: 'conditions', severity: 'severity', targets: 'targets',
    cooldownMinutes: 'cooldownMinutes', isBuiltIn: 'isBuiltIn', titleTemplate: 'titleTemplate',
    messageTemplate: 'messageTemplate', createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/alertConditions', () => ({ retiredConditionTypeError: vi.fn(() => null) }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: { ALERTS_WRITE: { resource: 'alerts', action: 'write' } },
}));
vi.mock('../utils/pagination', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
}));

import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { templateRoutes } from './alertTemplates/templates';

const TEMPLATE_ID = '55555555-5555-4555-8555-555555555555';

const PARTNER_ROW = {
  id: TEMPLATE_ID,
  orgId: null,
  partnerId: 'p-1',
  name: 'Offline devices',
  description: null,
  category: 'Availability',
  conditions: {},
  severity: 'high',
  targets: { scope: 'organization' },
  cooldownMinutes: 15,
  isBuiltIn: false,
};

function setPartnerOrgAccess(partnerOrgAccess: 'all' | 'selected') {
  authRef.current = {
    scope: 'partner',
    partnerId: 'p-1',
    partnerOrgAccess,
    orgId: null,
    accessibleOrgIds: [],
    canAccessOrg: () => false,
    user: { id: 'u-1', email: 'admin@example.com' },
  };
}

function makeApp() {
  const app = new Hono();
  app.route('/alert-templates', templateRoutes);
  return app;
}

function createRequest(app: Hono) {
  return app.request('/alert-templates/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Offline devices', severity: 'high', availability: 'partner' }),
  });
}

function patchRequest(app: Hono) {
  return app.request(`/alert-templates/templates/${TEMPLATE_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Long-offline devices' }),
  });
}

function deleteRequest(app: Hono) {
  return app.request(`/alert-templates/templates/${TEMPLATE_ID}`, { method: 'DELETE' });
}

describe('alert template partner-wide capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPartnerOrgAccess('all');
    selectResult.mockResolvedValue([PARTNER_ROW]);
    dbInsertMock.mockImplementation(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        returning: vi.fn(async () => [{ ...PARTNER_ROW, ...values }]),
      })),
    }));
    dbUpdateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...PARTNER_ROW, ...values }]) })),
      })),
    }));
    dbDeleteMock.mockImplementation(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
  });

  it('POST /templates with partner availability returns 403 for selected access', async () => {
    setPartnerOrgAccess('selected');

    const res = await createRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('POST /templates with partner availability succeeds for all access', async () => {
    const res = await createRequest(makeApp());

    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ orgId: null, partnerId: 'p-1' });
    expect(dbInsertMock).toHaveBeenCalledOnce();
  });

  it('PATCH /templates/:id returns 403 for selected access on a partner-wide row', async () => {
    setPartnerOrgAccess('selected');

    const res = await patchRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('PATCH /templates/:id succeeds for all access on the same partner-wide row', async () => {
    const res = await patchRequest(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('Long-offline devices');
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });

  it('DELETE /templates/:id returns 403 for selected access on a partner-wide row', async () => {
    setPartnerOrgAccess('selected');

    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });

  it('DELETE /templates/:id succeeds for all access on the same partner-wide row', async () => {
    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: TEMPLATE_ID, deleted: true } });
    expect(dbDeleteMock).toHaveBeenCalledOnce();
  });
});
