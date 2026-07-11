import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbRowsMock, insertReturningMock, updateReturningMock, updateSetMock, deleteWhereMock, listForOrgMock, writeRouteAuditMock, selectWhereArgs } = vi.hoisted(() => ({
  /** Every db.select()...where(...) arg, so tests can assert fetch conditions. */
  selectWhereArgs: [] as unknown[],
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as string,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1'] as string[] | null,
      orgCondition: (() => undefined) as () => unknown,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  dbRowsMock: vi.fn(),
  insertReturningMock: vi.fn(),
  updateReturningMock: vi.fn(),
  /** Captures every db.update().set(arg) so tests can assert null pass-through. */
  updateSetMock: vi.fn(),
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
        where: vi.fn((...args: unknown[]) => {
          selectWhereArgs.push(...args);
          return Object.assign(Promise.resolve(dbRowsMock()), {
            orderBy: vi.fn(() => dbRowsMock()),
            limit: vi.fn(() => dbRowsMock())
          });
        })
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => insertReturningMock()) })) })),
    update: vi.fn(() => ({ set: vi.fn((setArg: unknown) => { updateSetMock(setArg); return { where: vi.fn(() => ({ returning: vi.fn(() => updateReturningMock()) })) }; }) })),
    delete: vi.fn(() => ({ where: vi.fn((...a) => { deleteWhereMock(...a); return Promise.resolve(); } ) }))
  }
}));

import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ticketFormRoutes } from './forms';

/** Render a captured Drizzle condition to a SQL string for shape assertions. */
function renderSql(condition: unknown): string {
  return new PgDialect().sqlToQuery(condition as SQL).sql;
}

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
  selectWhereArgs.length = 0;
  authRef.current = { ...authRef.current, scope: 'partner', partnerId: 'p-1', partnerOrgAccess: 'all', orgId: null, orgCondition: () => undefined, canAccessOrg: () => true };
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

  it('accepts explicit null to clear an optional field, passing it through to the update set', async () => {
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_ID, partnerId: null, version: 1, fields: [] }]);
    updateReturningMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_ID, partnerId: null, version: 1, fields: [], name: 'Onboarding', description: null }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: null })
    });
    expect(res.status).toBe(200);
    const setArg = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toBeTruthy();
    expect('description' in setArg).toBe(true);
    expect(setArg.description).toBeNull();
    // description is cosmetic — no version bump, and null must not trip the
    // category revalidation (clearing a category needs no partner check).
    expect('version' in setArg).toBe(false);
  });

  it('PUT of only { name } does not materialize create-defaults into the update set', async () => {
    // Regression for the .partial()+.default() bug: a partial PUT must NOT carry
    // defaultTags/showInPortal/isActive/sortOrder, or every edit would reset the
    // API-set values for fields the web editor never sends.
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_ID, partnerId: null, version: 1, fields: [] }]);
    updateReturningMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_ID, partnerId: null, version: 1, fields: [], name: 'renamed' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' })
    });
    expect(res.status).toBe(200);
    const setArg = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toBeTruthy();
    expect('defaultTags' in setArg).toBe(false);
    expect('showInPortal' in setArg).toBe(false);
    expect('isActive' in setArg).toBe(false);
    expect('sortOrder' in setArg).toBe(false);
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

describe('PUT/DELETE app-layer tenant scoping on the row fetch', () => {
  // App-layer defense-in-depth (mirrors getPolicyWithAccess in
  // softwarePolicies.ts): the mutation-target fetch must AND the caller's
  // access condition into the WHERE, not rely on RLS alone. A row outside the
  // caller's tenancy then 404s before any gate or mutation runs.
  const FORM_ID = '9a8b7c6d-1111-4222-8333-444455556666';

  function orgScopedAuth() {
    authRef.current = {
      ...authRef.current,
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      // Real SQL condition (the raw marker survives into the rendered query)
      // standing in for the org-scope eq(orgId, ...) the middleware builds.
      orgCondition: () => sql.raw(`org_scope_marker = org_scope_marker`) as SQL
    };
  }

  it('PUT 404s a foreign row: fetch WHERE is composed with the access condition', async () => {
    orgScopedAuth();
    dbRowsMock.mockResolvedValue([]); // scoped fetch misses the foreign row
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' })
    });
    expect(res.status).toBe(404);
    expect(updateReturningMock).not.toHaveBeenCalled();
    expect(selectWhereArgs.length).toBeGreaterThan(0);
    const rendered = renderSql(selectWhereArgs[0]);
    expect(rendered).toContain('org_scope_marker'); // access condition present
    expect(rendered).toContain('and');              // composed, not bare id eq
  });

  it('DELETE 404s a foreign row: fetch WHERE is composed with the access condition', async () => {
    orgScopedAuth();
    dbRowsMock.mockResolvedValue([]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(deleteWhereMock).not.toHaveBeenCalled();
    expect(selectWhereArgs.length).toBeGreaterThan(0);
    const rendered = renderSql(selectWhereArgs[0]);
    expect(rendered).toContain('org_scope_marker');
    expect(rendered).toContain('and');
  });
});
