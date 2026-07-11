import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  authRef,
  dbRowsMock,
  insertReturningMock,
  insertValuesMock,
  updateReturningMock,
  updateSetMock,
  deleteWhereMock,
  listForOrgMock,
  syncOrgLinksMock,
  getOrgLinkMapMock,
  writeRouteAuditMock,
  selectWhereArgs
} = vi.hoisted(() => ({
  /** Every db.select()...where(...) arg, so tests can assert fetch conditions. */
  selectWhereArgs: [] as unknown[],
  /** Captures db.insert().values(arg) so tests can assert the persisted owner axis. */
  insertValuesMock: vi.fn(),
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
  syncOrgLinksMock: vi.fn(),
  getOrgLinkMapMock: vi.fn(),
  writeRouteAuditMock: vi.fn()
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/ticketFormService', async () => {
  // Keep the real TicketFormError class (forms.ts does `instanceof` checks
  // against it) while mocking the two functions under test.
  const actual = await vi.importActual<typeof import('../../services/ticketFormService')>('../../services/ticketFormService');
  return {
    ...actual,
    listTicketFormsForOrg: listForOrgMock,
    syncTicketFormOrgLinks: syncOrgLinksMock,
    getTicketFormOrgLinkMap: getOrgLinkMapMock
  };
});
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
    insert: vi.fn(() => ({ values: vi.fn((v: unknown) => { insertValuesMock(v); return { returning: vi.fn(() => insertReturningMock()) }; }) })),
    update: vi.fn(() => ({ set: vi.fn((setArg: unknown) => { updateSetMock(setArg); return { where: vi.fn(() => ({ returning: vi.fn(() => updateReturningMock()) })) }; }) })),
    delete: vi.fn(() => ({ where: vi.fn((...a) => { deleteWhereMock(...a); return Promise.resolve(); } ) }))
  }
}));

import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ticketFormRoutes } from './forms';
import { assertCategoryInPartner, TicketServiceError } from '../../services/ticketService';
import { TicketFormError } from '../../services/ticketFormService';

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
  syncOrgLinksMock.mockResolvedValue(undefined);
  getOrgLinkMapMock.mockResolvedValue(new Map());
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
    // Persisted owner axis: org-owned row carries the org id and a NULL partner.
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, partnerId: null }));
  });

  it('creates a partner-wide form with org_id NULL and token-derived partner', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(201);
    // Partner-wide row: NULL org, partner derived from the caller's OWN token.
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, partnerId: 'p-1' }));
  });

  it('403s partner-wide create without full partner org access', async () => {
    authRef.current = { ...authRef.current, partnerOrgAccess: 'selected' };
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(403);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('403s ownerScope=partner when the token carries no partnerId', async () => {
    authRef.current = { ...authRef.current, partnerId: null };
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(403);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('400s a partner token that supplies no orgId for an org-owned form', async () => {
    // Partner scope, org ownership, but no orgId to attach the form to.
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization' })
    });
    expect(res.status).toBe(400);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('400s a partner token whose requested orgId is inaccessible', async () => {
    authRef.current = { ...authRef.current, canAccessOrg: () => false };
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization', orgId: ORG_ID })
    });
    expect(res.status).toBe(400);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('403s an org-scoped token whose requested orgId does not match its own org', async () => {
    const OTHER_ORG = '11112222-3333-4444-8555-666677778888';
    authRef.current = { ...authRef.current, scope: 'organization', partnerId: null, orgId: ORG_ID, canAccessOrg: () => true };
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization', orgId: OTHER_ORG })
    });
    expect(res.status).toBe(403);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('org-scoped token with no orgId defaults the form to its own org', async () => {
    authRef.current = { ...authRef.current, scope: 'organization', partnerId: null, orgId: ORG_ID, canAccessOrg: () => true };
    insertReturningMock.mockResolvedValue([{ id: 'f-9', orgId: ORG_ID, partnerId: null, ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization' })
    });
    expect(res.status).toBe(201);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, partnerId: null }));
  });

  it('400s and inserts nothing when the category guard rejects the category', async () => {
    const CAT_ID = '22223333-4444-4555-8666-777788889999';
    // resolveEffectivePartnerId does an org→partner lookup for an org-owned form.
    dbRowsMock.mockResolvedValue([{ partnerId: 'p-1' }]);
    vi.mocked(assertCategoryInPartner).mockRejectedValueOnce(new TicketServiceError('Category must belong to the same partner as the form', 400));
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization', orgId: ORG_ID, categoryId: CAT_ID })
    });
    expect(res.status).toBe(400);
    expect(insertValuesMock).not.toHaveBeenCalled();
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

describe('POST /ticket-forms — visibleOrgIds', () => {
  const ORG_A = '11112222-3333-4444-8555-666677778888';
  const ORG_B = '22223333-4444-4555-8666-777788889999';

  it('creates a partner-wide form and syncs links with the token-derived partner + the array as-is', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner', visibleOrgIds: [ORG_A, ORG_B] })
    });
    expect(res.status).toBe(201);
    expect(syncOrgLinksMock).toHaveBeenCalledWith('f-2', [ORG_A, ORG_B], 'p-1');
    const body = await res.json();
    expect(body.data.visibleOrgIds).toEqual([ORG_A, ORG_B]);
  });

  it('normalizes an empty visibleOrgIds array to null before syncing', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner', visibleOrgIds: [] })
    });
    expect(res.status).toBe(201);
    expect(syncOrgLinksMock).toHaveBeenCalledWith('f-2', null, 'p-1');
    const body = await res.json();
    expect(body.data.visibleOrgIds).toBeNull();
  });

  it('partner-wide create with no visibleOrgIds still syncs (no-op) with null and reports null', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(201);
    expect(syncOrgLinksMock).toHaveBeenCalledWith('f-2', null, 'p-1');
    const body = await res.json();
    expect(body.data.visibleOrgIds).toBeNull();
  });

  it('400s an org-owned create that supplies visibleOrgIds, before any insert or sync', async () => {
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization', orgId: ORG_A, visibleOrgIds: [ORG_B] })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('visibleOrgIds is only valid on partner-wide forms');
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(syncOrgLinksMock).not.toHaveBeenCalled();
  });

  it('400s a default-ownerScope (org-owned) create that supplies visibleOrgIds', async () => {
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, orgId: ORG_A, visibleOrgIds: [ORG_B] })
    });
    expect(res.status).toBe(400);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('rolls back (deletes) the just-created form when the sync rejects, and surfaces its 400', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', ...validBody }]);
    syncOrgLinksMock.mockRejectedValueOnce(
      new TicketFormError('visibleOrgIds must reference organizations of the owning partner', 400)
    );
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner', visibleOrgIds: [ORG_A] })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('visibleOrgIds must reference organizations of the owning partner');
    // The form row inserted above must be deleted — no orphaned half-created form.
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /ticket-forms/available', () => {
  it('403s when the caller cannot access the org, before any db read', async () => {
    authRef.current = { ...authRef.current, canAccessOrg: () => false };
    const res = await makeApp().request(`/ticket-forms/available?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
    // Access check runs BEFORE any fetch — no org lookup / form read may leak.
    expect(selectWhereArgs.length).toBe(0);
    expect(listForOrgMock).not.toHaveBeenCalled();
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

describe('PUT /ticket-forms/:id — visibleOrgIds', () => {
  const FORM_ID = '9a8b7c6d-1111-4222-8333-444455556666';
  const ORG_A = '11112222-3333-4444-8555-666677778888';
  const ORG_B = '22223333-4444-4555-8666-777788889999';

  function partnerWideRow() {
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: null, partnerId: 'p-1', version: 1, fields: [], name: 'Onboarding' }]);
  }

  it('undefined (key omitted): links untouched — sync never called', async () => {
    partnerWideRow();
    updateReturningMock.mockResolvedValue([{ id: FORM_ID, orgId: null, partnerId: 'p-1', version: 1, fields: [], name: 'renamed' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' })
    });
    expect(res.status).toBe(200);
    expect(syncOrgLinksMock).not.toHaveBeenCalled();
    const setArg = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('visibleOrgIds' in setArg).toBe(false);
    expect('version' in setArg).toBe(false);
  });

  it('null: clears the allowlist via sync, does not bump version, and never reaches .set()', async () => {
    partnerWideRow();
    updateReturningMock.mockResolvedValue([{ id: FORM_ID, orgId: null, partnerId: 'p-1', version: 1, fields: [], name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibleOrgIds: null })
    });
    expect(res.status).toBe(200);
    expect(syncOrgLinksMock).toHaveBeenCalledWith(FORM_ID, null, 'p-1');
    const setArg = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('visibleOrgIds' in setArg).toBe(false);
    expect('version' in setArg).toBe(false);
  });

  it('[] (empty array): normalized to null before syncing, same as explicit null', async () => {
    partnerWideRow();
    updateReturningMock.mockResolvedValue([{ id: FORM_ID, orgId: null, partnerId: 'p-1', version: 1, fields: [], name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibleOrgIds: [] })
    });
    expect(res.status).toBe(200);
    expect(syncOrgLinksMock).toHaveBeenCalledWith(FORM_ID, null, 'p-1');
  });

  it('non-empty array: replaces the allowlist via sync with the array as-is, .set() never sees the key', async () => {
    partnerWideRow();
    updateReturningMock.mockResolvedValue([{ id: FORM_ID, orgId: null, partnerId: 'p-1', version: 1, fields: [], name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibleOrgIds: [ORG_A, ORG_B] })
    });
    expect(res.status).toBe(200);
    expect(syncOrgLinksMock).toHaveBeenCalledWith(FORM_ID, [ORG_A, ORG_B], 'p-1');
    const setArg = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('visibleOrgIds' in setArg).toBe(false);
  });

  it('400s an update of an org-owned row that supplies visibleOrgIds, before any sync or column update', async () => {
    dbRowsMock.mockResolvedValue([{ id: FORM_ID, orgId: ORG_A, partnerId: null, version: 1, fields: [], name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibleOrgIds: [ORG_B] })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('visibleOrgIds is only valid on partner-wide forms');
    expect(syncOrgLinksMock).not.toHaveBeenCalled();
    expect(updateReturningMock).not.toHaveBeenCalled();
  });

  it('sync failure aborts before the column update runs (form left completely unmodified) and surfaces the 400', async () => {
    partnerWideRow();
    syncOrgLinksMock.mockRejectedValueOnce(
      new TicketFormError('visibleOrgIds must reference organizations of the owning partner', 400)
    );
    const res = await makeApp().request(`/ticket-forms/${FORM_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed', visibleOrgIds: [ORG_A] })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('visibleOrgIds must reference organizations of the owning partner');
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(updateReturningMock).not.toHaveBeenCalled();
  });
});

describe('GET /ticket-forms — management list', () => {
  it('carries visibleOrgIds from getTicketFormOrgLinkMap (present when links exist, null otherwise)', async () => {
    dbRowsMock.mockResolvedValue([
      { id: 'f-1', orgId: null, partnerId: 'p-1', name: 'All-orgs form' },
      { id: 'f-2', orgId: null, partnerId: 'p-1', name: 'Limited form' }
    ]);
    getOrgLinkMapMock.mockResolvedValue(new Map([['f-2', ['org-a', 'org-b']]]));
    const res = await makeApp().request('/ticket-forms');
    expect(res.status).toBe(200);
    expect(getOrgLinkMapMock).toHaveBeenCalledWith(['f-1', 'f-2']);
    const body = await res.json();
    expect(body.data.find((f: { id: string }) => f.id === 'f-1').visibleOrgIds).toBeNull();
    expect(body.data.find((f: { id: string }) => f.id === 'f-2').visibleOrgIds).toEqual(['org-a', 'org-b']);
  });
});

describe('GET /ticket-forms/available — does not carry visibleOrgIds', () => {
  it('does not call getTicketFormOrgLinkMap; the picker payload is unmodified from the service result', async () => {
    dbRowsMock.mockResolvedValue([{ id: ORG_ID, partnerId: 'p-1' }]); // org lookup
    listForOrgMock.mockResolvedValue([{ id: 'f-1', name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/available?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(getOrgLinkMapMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data).toEqual([{ id: 'f-1', name: 'Onboarding' }]);
  });
});
