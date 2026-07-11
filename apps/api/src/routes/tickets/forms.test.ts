import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbRowsMock, insertReturningMock, updateReturningMock, deleteWhereMock, listForOrgMock, writeRouteAuditMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as string,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1'] as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  dbRowsMock: vi.fn(),
  insertReturningMock: vi.fn(),
  updateReturningMock: vi.fn(),
  deleteWhereMock: vi.fn(),
  listForOrgMock: vi.fn(),
  writeRouteAuditMock: vi.fn()
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/ticketFormService', () => ({ listTicketFormsForOrg: listForOrgMock }));
vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return { ...actual, assertCategoryInPartner: vi.fn().mockResolvedValue({ id: 'cat-1', partnerId: 'p-1' }) };
});
// partnerWideAccess is PURE — use the real implementation so gate tests are honest.

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
  requireMfa: () => async (_c: any, next: any) => next()
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(dbRowsMock()), {
          orderBy: vi.fn(() => dbRowsMock()),
          limit: vi.fn(() => dbRowsMock())
        }))
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => insertReturningMock()) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => updateReturningMock()) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn((...a) => { deleteWhereMock(...a); return Promise.resolve(); } ) }))
  }
}));

import { ticketFormRoutes } from './forms';

function makeApp() {
  const app = new Hono();
  app.route('/', ticketFormRoutes);
  return app;
}

const ORG_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const validBody = {
  name: 'New user onboarding',
  fields: [{ key: 'affected_user', label: 'Affected user', type: 'text', required: true }]
};

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { ...authRef.current, scope: 'partner', partnerId: 'p-1', partnerOrgAccess: 'all', orgId: null, canAccessOrg: () => true };
});

describe('POST /ticket-forms', () => {
  it('creates an org-owned form by default', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-1', orgId: ORG_ID, partnerId: null, ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization', orgId: ORG_ID })
    });
    expect(res.status).toBe(201);
    expect(writeRouteAuditMock).toHaveBeenCalled();
  });

  it('creates a partner-wide form with org_id NULL and token-derived partner', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(201);
  });

  it('403s partner-wide create without full partner org access', async () => {
    authRef.current = { ...authRef.current, partnerOrgAccess: 'selected' };
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(403);
  });

  it('400s invalid field definitions', async () => {
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', orgId: ORG_ID, fields: [{ key: 'BAD KEY', label: 'x', type: 'text', required: false }] })
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /ticket-forms/available', () => {
  it('403s when the caller cannot access the org', async () => {
    authRef.current = { ...authRef.current, canAccessOrg: () => false };
    const res = await makeApp().request(`/ticket-forms/available?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns resolved forms from the system-context service', async () => {
    dbRowsMock.mockResolvedValue([{ id: ORG_ID, partnerId: 'p-1' }]); // org lookup
    listForOrgMock.mockResolvedValue([{ id: 'f-1', name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/available?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(listForOrgMock).toHaveBeenCalledWith({ id: ORG_ID, partnerId: 'p-1' });
  });
});

describe('PUT/DELETE partner-wide gating', () => {
  // /ticket-forms/:id validates the param as a guid (matching the real
  // tickets.ts / ticketResponseTemplates.ts / softwarePolicies.ts convention —
  // ticket_forms.id is a uuid primary key), so the fixture id below must be a
  // real guid, not the shorthand 'f-2' style used in the response-body fixtures.
  const FORM_ID = '9a8b7c6d-1111-4222-8333-444455556666';

  it('403s update of a partner-wide form without the capability', async () => {
    authRef.current = { ...authRef.current, partnerOrgAccess: 'selected' };
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: null, partnerId: 'p-1', version: 1, fields: [] }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' })
    });
    expect(res.status).toBe(403);
  });

  it('403s delete of a partner-wide form without the capability', async () => {
    authRef.current = { ...authRef.current, partnerOrgAccess: 'selected' };
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: null, partnerId: 'p-1', version: 1, fields: [], name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it('updates an org-owned form and bumps version when fields change', async () => {
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_ID, partnerId: null, version: 1, fields: [] }]);
    updateReturningMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_ID, partnerId: null, version: 2, fields: validBody.fields, name: 'renamed' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed', fields: validBody.fields })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.version).toBe(2);
    expect(writeRouteAuditMock).toHaveBeenCalled();
  });

  it('404s when the form does not exist', async () => {
    dbRowsMock.mockResolvedValue([]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' })
    });
    expect(res.status).toBe(404);
  });

  it('deletes an org-owned form', async () => {
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_ID, partnerId: null, version: 1, fields: [], name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(deleteWhereMock).toHaveBeenCalled();
    expect(writeRouteAuditMock).toHaveBeenCalled();
  });
});
