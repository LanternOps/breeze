import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, orgLookup, crudMocks, importMocks, auditSpy } = vi.hoisted(() => ({
  authRef: { current: null as Record<string, unknown> | null },
  orgLookup: vi.fn(),
  crudMocks: {
    listContacts: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
    findContactOrgId: vi.fn(),
  },
  importMocks: {
    previewContactImport: vi.fn(),
    commitContactImport: vi.fn(),
  },
  auditSpy: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => orgLookup()) })),
      })),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  organizations: { id: 'id', deletedAt: 'deletedAt' },
}));

vi.mock('../services/contacts/crud', () => ({
  ContactValidationError: class ContactValidationError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
      this.name = 'ContactValidationError';
    }
  },
  listContacts: (...a: unknown[]) => crudMocks.listContacts(...a),
  createContact: (...a: unknown[]) => crudMocks.createContact(...a),
  updateContact: (...a: unknown[]) => crudMocks.updateContact(...a),
  deleteContact: (...a: unknown[]) => crudMocks.deleteContact(...a),
  findContactOrgId: (...a: unknown[]) => crudMocks.findContactOrgId(...a),
}));

vi.mock('../services/contacts/import', () => ({
  previewContactImport: (...a: unknown[]) => importMocks.previewContactImport(...a),
  commitContactImport: (...a: unknown[]) => importMocks.commitContactImport(...a),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...a: unknown[]) => auditSpy(...a),
}));

import { authMiddleware } from '../middleware/auth';
import { registerOrgContactsRoutes } from './orgContacts';
import { ContactValidationError } from '../services/contacts/crud';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '1e1e1e1e-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const PARTNER = 'aaaaaaaa-1111-4111-8111-111111111111';

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: PARTNER as string | null,
  orgId: null as string | null,
  accessibleOrgIds: [ORG] as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: ((id: string) => id === ORG) as (id: string) => boolean,
};

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgContactsRoutes(app);
  return app;
}

function setAuth(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
  authRef.current = { ...DEFAULT_AUTH, ...overrides };
}

const CONTACT_ROW = {
  id: CONTACT,
  orgId: ORG,
  siteId: null,
  name: 'Jane Ops',
  email: 'jane@acme.example',
  phone: null,
  mobile: null,
  title: 'Controller',
  roles: ['billing'],
  isPrimary: true,
  notes: null,
};

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  setAuth();
  orgLookup.mockResolvedValue([{ id: ORG }]);
});

describe('GET /organizations/:id/contacts', () => {
  it('returns the org contacts', async () => {
    crudMocks.listContacts.mockResolvedValue([CONTACT_ROW]);
    const res = await makeApp().request(`/organizations/${ORG}/contacts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [CONTACT_ROW] });
  });

  it('passes the siteId and role filters through to the service', async () => {
    crudMocks.listContacts.mockResolvedValue([]);
    await makeApp().request(`/organizations/${ORG}/contacts?siteId=${SITE}&role=billing`);
    expect(crudMocks.listContacts.mock.calls[0]![1]).toBe(ORG);
    expect(crudMocks.listContacts.mock.calls[0]![2]).toEqual({ siteId: SITE, role: 'billing' });
  });

  it('reads siteId=none as "org-level contacts only"', async () => {
    crudMocks.listContacts.mockResolvedValue([]);
    await makeApp().request(`/organizations/${ORG}/contacts?siteId=none`);
    expect(crudMocks.listContacts.mock.calls[0]![2]).toEqual({ siteId: null });
  });

  it('404s for an organization the caller cannot reach', async () => {
    const res = await makeApp().request(`/organizations/${OTHER_ORG}/contacts`);
    expect(res.status).toBe(404);
    expect(crudMocks.listContacts).not.toHaveBeenCalled();
  });

  it('404s for a malformed organization id without touching the database', async () => {
    const res = await makeApp().request('/organizations/not-a-uuid/contacts');
    expect(res.status).toBe(404);
    expect(orgLookup).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    authRef.current = null;
    expect((await makeApp().request(`/organizations/${ORG}/contacts`)).status).toBe(401);
  });
});

describe('POST /organizations/:id/contacts', () => {
  it('creates the contact and audits it', async () => {
    crudMocks.createContact.mockResolvedValue(CONTACT_ROW);
    const res = await makeApp().request(
      `/organizations/${ORG}/contacts`,
      json({ name: 'Jane Ops', email: 'jane@acme.example', roles: ['billing'], isPrimary: true }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: CONTACT_ROW });
    expect(crudMocks.createContact.mock.calls[0]![1]).toMatchObject({
      orgId: ORG, name: 'Jane Ops', email: 'jane@acme.example', isPrimary: true,
    });
    expect(crudMocks.createContact.mock.calls[0]![2]).toEqual({ userId: 'u-1' });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![1]).toMatchObject({
      orgId: ORG, action: 'contact.create', resourceType: 'contact', resourceId: CONTACT,
    });
  });

  it('400s a body with no identifying field', async () => {
    const res = await makeApp().request(`/organizations/${ORG}/contacts`, json({ title: 'Nobody' }));
    expect(res.status).toBe(400);
    expect(crudMocks.createContact).not.toHaveBeenCalled();
  });

  it('400s an unknown role', async () => {
    const res = await makeApp().request(
      `/organizations/${ORG}/contacts`, json({ name: 'Jane', roles: ['owner'] }),
    );
    expect(res.status).toBe(400);
    expect(crudMocks.createContact).not.toHaveBeenCalled();
  });

  it('maps a service validation refusal to 400, not 500', async () => {
    crudMocks.createContact.mockRejectedValue(
      new ContactValidationError('Site does not belong to this organization', 'site-not-in-org'),
    );
    const res = await makeApp().request(
      `/organizations/${ORG}/contacts`, json({ name: 'Jane', siteId: SITE }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Site does not belong to this organization' });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('404s for an organization the caller cannot reach', async () => {
    const res = await makeApp().request(`/organizations/${OTHER_ORG}/contacts`, json({ name: 'Jane' }));
    expect(res.status).toBe(404);
    expect(crudMocks.createContact).not.toHaveBeenCalled();
  });
});

describe('PATCH /contacts/:contactId', () => {
  it('updates the contact and audits the changed fields', async () => {
    crudMocks.findContactOrgId.mockResolvedValue(ORG);
    crudMocks.updateContact.mockResolvedValue({ ...CONTACT_ROW, title: 'CFO' });

    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { title: 'CFO' } });
    expect(crudMocks.updateContact.mock.calls[0]!.slice(1, 4)).toEqual([CONTACT, ORG, { title: 'CFO' }]);
    expect(auditSpy.mock.calls[0]![1]).toMatchObject({
      orgId: ORG, action: 'contact.update', resourceType: 'contact', resourceId: CONTACT,
      details: { changedFields: ['title'] },
    });
  });

  it('404s a malformed contact id without touching the database', async () => {
    const res = await makeApp().request('/contacts/not-a-uuid', json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(crudMocks.findContactOrgId).not.toHaveBeenCalled();
  });

  it('404s when the contact does not exist', async () => {
    crudMocks.findContactOrgId.mockResolvedValue(null);
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
  });

  it('404s when the contact belongs to an organization the caller cannot reach', async () => {
    crudMocks.findContactOrgId.mockResolvedValue(OTHER_ORG);
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('400s an empty patch', async () => {
    crudMocks.findContactOrgId.mockResolvedValue(ORG);
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({}, 'PATCH'));
    expect(res.status).toBe(400);
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
  });
});

describe('DELETE /contacts/:contactId', () => {
  it('deletes the contact and audits it', async () => {
    crudMocks.findContactOrgId.mockResolvedValue(ORG);
    crudMocks.deleteContact.mockResolvedValue(CONTACT_ROW);

    const res = await makeApp().request(`/contacts/${CONTACT}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditSpy.mock.calls[0]![1]).toMatchObject({
      orgId: ORG, action: 'contact.delete', resourceType: 'contact',
      resourceId: CONTACT, resourceName: 'Jane Ops',
    });
  });

  it('404s and audits nothing when the contact is already gone', async () => {
    crudMocks.findContactOrgId.mockResolvedValue(ORG);
    crudMocks.deleteContact.mockResolvedValue(null);
    const res = await makeApp().request(`/contacts/${CONTACT}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe('POST /contacts/import/preview', () => {
  it('annotates the rows without writing', async () => {
    importMocks.previewContactImport.mockResolvedValue([{ index: 0, annotation: 'create' }]);
    const res = await makeApp().request(
      '/contacts/import/preview', json({ rows: [{ organizationId: ORG, name: 'Jane' }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ index: 0, annotation: 'create' }] });
    // The importer writes in a system DB context, so the caller's own org
    // allowlist has to travel with the request or nothing bounds the writes.
    expect(importMocks.previewContactImport.mock.calls[0]![1]).toEqual({
      partnerId: PARTNER, accessibleOrgIds: [ORG],
    });
  });

  it('rejects a batch over the 1000-row cap', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ organizationId: ORG, name: `Person ${i}` }));
    const res = await makeApp().request('/contacts/import/preview', json({ rows }));
    expect(res.status).toBe(400);
    expect(importMocks.previewContactImport).not.toHaveBeenCalled();
  });

  it('accepts a batch at exactly the cap', async () => {
    importMocks.previewContactImport.mockResolvedValue([]);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ organizationId: ORG, name: `Person ${i}` }));
    const res = await makeApp().request('/contacts/import/preview', json({ rows }));
    expect(res.status).toBe(200);
  });

  it('rejects an import row with no identifying field', async () => {
    const res = await makeApp().request(
      '/contacts/import/preview', json({ rows: [{ organizationId: ORG, title: 'Nobody' }] }),
    );
    expect(res.status).toBe(400);
  });

  it('admits an organization-scoped token, bounded to its own org', async () => {
    // Spec S4 gates these on all three scopes. Admitting org scope is safe
    // because accessibleOrgIds is that one org, which is what bounds the
    // system-context writes.
    setAuth({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
    importMocks.previewContactImport.mockResolvedValue([]);
    const res = await makeApp().request(
      '/contacts/import/preview', json({ rows: [{ organizationId: ORG, name: 'Jane' }] }),
    );
    expect(res.status).toBe(200);
    expect(importMocks.previewContactImport.mock.calls[0]![1]).toEqual({
      partnerId: PARTNER, accessibleOrgIds: [ORG],
    });
  });

  it('403s an organization-scoped token trying to redirect the import to another partner', async () => {
    setAuth({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
    const res = await makeApp().request('/contacts/import/preview', json({
      partnerId: 'bbbbbbbb-1111-4111-8111-111111111111',
      rows: [{ organizationId: ORG, name: 'Jane' }],
    }));
    expect(res.status).toBe(403);
    expect(importMocks.previewContactImport).not.toHaveBeenCalled();
  });
});

describe('POST /contacts/import', () => {
  const summary = {
    imported: [{ index: 0, organizationId: ORG, contactId: CONTACT, name: 'Jane Ops', createdLink: false }],
    updated: [],
    skipped: [],
    errors: [{ index: 1, error: 'No organization named "Nowhere"', code: 'org-not-found' }],
  };

  it('returns HTTP 200 with the four-bucket summary even when rows failed', async () => {
    importMocks.commitContactImport.mockResolvedValue(summary);
    const res = await makeApp().request('/contacts/import', json({
      rows: [{ organizationId: ORG, name: 'Jane Ops' }, { organization: 'Nowhere', name: 'Nobody' }],
    }));

    // runAction treats a `success: false` body as a hard failure, so a partial
    // import must never report one.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(summary);
    expect(body).not.toHaveProperty('success');
  });

  it('audits every contact the commit created or updated', async () => {
    importMocks.commitContactImport.mockResolvedValue({
      imported: [{ index: 0, organizationId: ORG, contactId: CONTACT, name: 'Jane Ops', createdLink: true }],
      updated: [{ index: 1, organizationId: ORG, contactId: CONTACT, name: 'Sam Site', createdLink: false }],
      skipped: [{ index: 2, organizationId: ORG, contactId: CONTACT, reason: 'already_linked' }],
      errors: [],
    });
    await makeApp().request('/contacts/import', json({
      rows: [
        { organizationId: ORG, name: 'Jane Ops' },
        { organizationId: ORG, name: 'Sam Site' },
        { organizationId: ORG, name: 'Skipped' },
      ],
    }));

    const actions = auditSpy.mock.calls.map((call) => (call[1] as { action: string }).action);
    expect(actions).toEqual(['contact.create', 'contact.update']);
    expect(auditSpy.mock.calls[0]![1]).toMatchObject({
      orgId: ORG, resourceType: 'contact', resourceId: CONTACT,
      details: { source: 'contact_import' },
    });
  });

  it('passes the actor and the caller org reach through to the service', async () => {
    importMocks.commitContactImport.mockResolvedValue({ imported: [], updated: [], skipped: [], errors: [] });
    await makeApp().request('/contacts/import', json({ rows: [{ organizationId: ORG, name: 'Jane' }] }));
    expect(importMocks.commitContactImport.mock.calls[0]![1]).toEqual({
      partnerId: PARTNER, accessibleOrgIds: [ORG],
    });
    expect(importMocks.commitContactImport.mock.calls[0]![2]).toEqual({ userId: 'u-1' });
  });

  it('rejects a batch over the 1000-row cap', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ organizationId: ORG, name: `Person ${i}` }));
    const res = await makeApp().request('/contacts/import', json({ rows }));
    expect(res.status).toBe(400);
    expect(importMocks.commitContactImport).not.toHaveBeenCalled();
  });

  it('400s a system-scope caller with no partner to resolve names within', async () => {
    setAuth({ scope: 'system', partnerId: null, accessibleOrgIds: null, canAccessOrg: () => true });
    const res = await makeApp().request('/contacts/import', json({ rows: [{ organizationId: ORG, name: 'Jane' }] }));
    expect(res.status).toBe(400);
    expect(importMocks.commitContactImport).not.toHaveBeenCalled();
  });

  it('an org-scoped token importing rows for ANOTHER org gets org-not-found and writes nothing', async () => {
    // The route hands the service the caller's single-org allowlist; the
    // service refuses every row outside it. Asserted end to end: the context
    // the route builds is what bounds the write.
    setAuth({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
    importMocks.commitContactImport.mockImplementation(async (rows: any, ctx: any) => {
      const reach: string[] | null = ctx.accessibleOrgIds;
      const errors = rows
        .map((row: any, index: number) => ({ row, index }))
        .filter(({ row }: any) => reach !== null && !reach.includes(row.organizationId))
        .map(({ index }: any) => ({ index, error: 'No such organization under this partner', code: 'org-not-found' }));
      return { imported: [], updated: [], skipped: [], errors };
    });

    const res = await makeApp().request('/contacts/import', json({
      rows: [{ organizationId: OTHER_ORG, name: 'Mallory' }, { organizationId: ORG, name: 'Jane' }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([
      { index: 0, error: 'No such organization under this partner', code: 'org-not-found' },
    ]);
    expect(body.imported).toEqual([]);
    // Nothing was created or updated, so nothing is audited.
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('403s a partner caller asking to import into a different partner', async () => {
    const res = await makeApp().request('/contacts/import', json({
      partnerId: 'bbbbbbbb-1111-4111-8111-111111111111',
      rows: [{ organizationId: ORG, name: 'Jane' }],
    }));
    expect(res.status).toBe(403);
    expect(importMocks.commitContactImport).not.toHaveBeenCalled();
  });
});
