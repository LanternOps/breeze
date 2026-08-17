import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectResult, insertResult, updateResult, dbInsertMock, dbUpdateMock, dbDeleteMock } =
  vi.hoisted(() => ({
    authRef: {
      current: {
        scope: 'partner' as 'partner' | 'organization' | 'system',
        partnerId: 'p-1' as string | null,
        partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null | undefined,
        orgId: null as string | null,
        accessibleOrgIds: [] as string[] | null,
        canAccessOrg: (_orgId: string): boolean => false,
        user: { id: 'u-1', email: 'admin@example.com' },
      },
    },
    selectResult: vi.fn(),
    insertResult: vi.fn(),
    updateResult: vi.fn(),
    dbInsertMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    dbDeleteMock: vi.fn(),
  }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
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
  customFieldDefinitions: {
    id: 'id', orgId: 'orgId', partnerId: 'partnerId', name: 'name', fieldKey: 'fieldKey',
    type: 'type', options: 'options', required: 'required', defaultValue: 'defaultValue',
    deviceTypes: 'deviceTypes', createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
}));

import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { customFieldRoutes } from './customFields';

const FIELD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

function makeField(overrides: Record<string, unknown> = {}) {
  return {
    id: FIELD_ID,
    orgId: null,
    partnerId: 'p-1',
    name: 'Serial Number',
    fieldKey: 'serial_number',
    type: 'text',
    options: null,
    required: false,
    defaultValue: null,
    deviceTypes: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

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
  app.route('/custom-fields', customFieldRoutes);
  return app;
}

function createRequest(app: Hono) {
  return app.request('/custom-fields', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Serial Number', fieldKey: 'serial_number', type: 'text' }),
  });
}

function patchRequest(app: Hono) {
  return app.request(`/custom-fields/${FIELD_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Asset Serial' }),
  });
}

function deleteRequest(app: Hono) {
  return app.request(`/custom-fields/${FIELD_ID}`, { method: 'DELETE' });
}

describe('custom fields partner-wide capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPartnerAuth('all');
    selectResult.mockResolvedValue([makeField()]);
    insertResult.mockResolvedValue([makeField()]);
    updateResult.mockResolvedValue([makeField({ name: 'Asset Serial' })]);
    dbInsertMock.mockImplementation(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => insertResult()) })),
    }));
    dbUpdateMock.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => updateResult()) })),
      })),
    }));
    dbDeleteMock.mockImplementation(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
  });

  it('POST / without orgId returns 403 for selected partner access', async () => {
    setPartnerAuth('selected');

    const res = await createRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('POST / without orgId succeeds for all partner access', async () => {
    const res = await createRequest(makeApp());

    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ orgId: null, partnerId: 'p-1' });
    expect(dbInsertMock).toHaveBeenCalledOnce();
  });

  it('PATCH /:id returns 403 for selected access on a partner-wide row', async () => {
    setPartnerAuth('selected');

    const res = await patchRequest(makeApp());

    expect(res.status).toBe(403);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('PATCH /:id succeeds for all access on the same partner-wide row', async () => {
    const res = await patchRequest(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('Asset Serial');
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });

  it('DELETE /:id returns 403 for selected access on a partner-wide row', async () => {
    setPartnerAuth('selected');

    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(403);
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });

  it('DELETE /:id succeeds for all access on the same partner-wide row', async () => {
    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe(FIELD_ID);
    expect(dbDeleteMock).toHaveBeenCalledOnce();
  });

  it('keeps an org-owned row editable by its organization caller', async () => {
    setOrgAuth();
    selectResult.mockResolvedValue([makeField({ orgId: ORG_ID, partnerId: null })]);
    updateResult.mockResolvedValue([makeField({ orgId: ORG_ID, partnerId: null, name: 'Asset Serial' })]);

    const res = await patchRequest(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ orgId: ORG_ID, name: 'Asset Serial' });
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });
});
