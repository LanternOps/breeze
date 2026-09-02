import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, orgLookup, crudMocks, importMocks, auditSpy, gateState } = vi.hoisted(() => ({
  authRef: { current: null as Record<string, unknown> | null },
  orgLookup: vi.fn(),
  // Functional permission/MFA gates, copied from routes/orgs.test.ts:265-271.
  // A pass-through stub would let an "org scope is admitted" assertion pass on
  // a route that had no gate at all.
  gateState: { granted: true, denied: new Set<string>(), mfaSatisfied: true },
  crudMocks: {
    listContacts: vi.fn(),
    countContacts: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
    findContactScope: vi.fn(),
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
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!gateState.granted || gateState.denied.has(`${resource}:${action}`)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  },
  requireMfa: () => async (c: any, next: any) => {
    if (!gateState.mfaSatisfied) return c.json({ error: 'MFA required' }, 403);
    return next();
  },
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
  countContacts: (...a: unknown[]) => crudMocks.countContacts(...a),
  createContact: (...a: unknown[]) => crudMocks.createContact(...a),
  updateContact: (...a: unknown[]) => crudMocks.updateContact(...a),
  deleteContact: (...a: unknown[]) => crudMocks.deleteContact(...a),
  findContactScope: (...a: unknown[]) => crudMocks.findContactScope(...a),
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
const BARRED_SITE = '2b2b2b2b-2222-4222-8222-222222222222';
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
  // Site axis. `undefined` is an unrestricted caller (partner/system scope, or
  // an org user with no sub-org restriction) — the shape authMiddleware builds.
  allowedSiteIds: undefined as string[] | undefined,
  canAccessSite: undefined as ((siteId: string | null | undefined) => boolean) | undefined,
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
  gateState.granted = true;
  gateState.denied.clear();
  gateState.mfaSatisfied = true;
  orgLookup.mockResolvedValue([{ id: ORG }]);
  crudMocks.countContacts.mockResolvedValue(0);
});

describe('permission and MFA gating', () => {
  const writeRequests: Array<[string, string, RequestInit]> = [
    ['POST /organizations/:id/contacts', `/organizations/${ORG}/contacts`, json({ name: 'Jane' })],
    ['PATCH /contacts/:contactId', `/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH')],
    ['DELETE /contacts/:contactId', `/contacts/${CONTACT}`, { method: 'DELETE' }],
    ['POST /contacts/import/preview', '/contacts/import/preview', json({ rows: [{ organizationId: ORG, name: 'Jane' }] })],
    ['POST /contacts/import', '/contacts/import', json({ rows: [{ organizationId: ORG, name: 'Jane' }] })],
  ];

  it.each(writeRequests)('403s %s without organizations:write', async (_label, path, init) => {
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
    gateState.denied.add('organizations:write');
    const res = await makeApp().request(path, init);
    expect(res.status).toBe(403);
    expect(crudMocks.createContact).not.toHaveBeenCalled();
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
    expect(crudMocks.deleteContact).not.toHaveBeenCalled();
    expect(importMocks.previewContactImport).not.toHaveBeenCalled();
    expect(importMocks.commitContactImport).not.toHaveBeenCalled();
  });

  it('403s GET /organizations/:id/contacts without organizations:read', async () => {
    gateState.denied.add('organizations:read');
    const res = await makeApp().request(`/organizations/${ORG}/contacts`);
    expect(res.status).toBe(403);
    expect(crudMocks.listContacts).not.toHaveBeenCalled();
  });

  it.each(writeRequests)('403s %s when MFA is not satisfied', async (_label, path, init) => {
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
    gateState.mfaSatisfied = false;
    const res = await makeApp().request(path, init);
    expect(res.status).toBe(403);
    expect(crudMocks.createContact).not.toHaveBeenCalled();
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
    expect(crudMocks.deleteContact).not.toHaveBeenCalled();
    expect(importMocks.commitContactImport).not.toHaveBeenCalled();
  });

  it('admits an org-scoped caller holding organizations:read on GET', async () => {
    // The RULING: the gate stays ORGS_READ / ORGS_WRITE + MFA per spec §4. An
    // org user WITH the grants is admitted; one without gets an honest 403.
    setAuth({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
    crudMocks.listContacts.mockResolvedValue([CONTACT_ROW]);
    const res = await makeApp().request(`/organizations/${ORG}/contacts`);
    expect(res.status).toBe(200);
  });

  it('admits an org-scoped caller holding organizations:write on POST', async () => {
    setAuth({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
    crudMocks.createContact.mockResolvedValue(CONTACT_ROW);
    const res = await makeApp().request(`/organizations/${ORG}/contacts`, json({ name: 'Jane Ops' }));
    expect(res.status).toBe(201);
  });
});

describe('site confinement', () => {
  // `allowedSiteIds` is app-layer only: RLS on `contacts` is the ORG axis, so a
  // sub-org-restricted user would otherwise read and write every sibling site's
  // contacts. Org-level contacts (site_id IS NULL) stay reachable — the site
  // gate confines a caller WITHIN an org, it does not remove their org reach.
  function setConfined(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
    setAuth({
      scope: 'organization',
      orgId: ORG,
      accessibleOrgIds: [ORG],
      allowedSiteIds: [SITE],
      canAccessSite: (siteId) => siteId === SITE,
      ...overrides,
    });
  }

  it('hands the list the caller site allowlist so it can intersect', async () => {
    setConfined();
    crudMocks.listContacts.mockResolvedValue([]);
    const res = await makeApp().request(`/organizations/${ORG}/contacts`);
    expect(res.status).toBe(200);
    expect(crudMocks.listContacts.mock.calls[0]![2]).toMatchObject({ allowedSiteIds: [SITE] });
  });

  it('passes an EMPTY allowlist through, leaving only org-level contacts', async () => {
    setConfined({ allowedSiteIds: [], canAccessSite: () => false });
    crudMocks.listContacts.mockResolvedValue([]);
    await makeApp().request(`/organizations/${ORG}/contacts`);
    // An empty array must reach the service as an empty array — degrading it to
    // "no filter" would hand a caller who can reach no site every site's rows.
    expect(crudMocks.listContacts.mock.calls[0]![2]).toMatchObject({ allowedSiteIds: [] });
  });

  it('sends no site filter at all for an unrestricted caller', async () => {
    crudMocks.listContacts.mockResolvedValue([]);
    await makeApp().request(`/organizations/${ORG}/contacts`);
    expect(crudMocks.listContacts.mock.calls[0]![2]).not.toHaveProperty('allowedSiteIds');
  });

  it('403s a ?siteId= filter naming a barred site', async () => {
    // Matches the sibling PATCH /orgs/sites/:id, which answers a barred site
    // with 403 "Access to this site denied" rather than an empty result.
    setConfined();
    const res = await makeApp().request(`/organizations/${ORG}/contacts?siteId=${BARRED_SITE}`);
    expect(res.status).toBe(403);
    expect(crudMocks.listContacts).not.toHaveBeenCalled();
  });

  it('allows a ?siteId= filter naming an allowed site, and siteId=none', async () => {
    setConfined();
    crudMocks.listContacts.mockResolvedValue([]);
    expect((await makeApp().request(`/organizations/${ORG}/contacts?siteId=${SITE}`)).status).toBe(200);
    expect((await makeApp().request(`/organizations/${ORG}/contacts?siteId=none`)).status).toBe(200);
  });

  it('403s a create pinned to a barred site before any write', async () => {
    setConfined();
    const res = await makeApp().request(
      `/organizations/${ORG}/contacts`, json({ name: 'Jane', siteId: BARRED_SITE }),
    );
    expect(res.status).toBe(403);
    expect(crudMocks.createContact).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('still creates an org-level contact for a site-confined caller', async () => {
    setConfined();
    crudMocks.createContact.mockResolvedValue(CONTACT_ROW);
    const res = await makeApp().request(`/organizations/${ORG}/contacts`, json({ name: 'Jane Ops' }));
    expect(res.status).toBe(201);
  });

  it('404s a PATCH on a contact pinned to a barred site, disclosing nothing', async () => {
    setConfined();
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: BARRED_SITE });
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
  });

  it('403s a PATCH moving a reachable contact ONTO a barred site', async () => {
    setConfined();
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: SITE });
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ siteId: BARRED_SITE }, 'PATCH'));
    expect(res.status).toBe(403);
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
  });

  it('allows a PATCH that leaves the contact inside the allowed site', async () => {
    setConfined();
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: SITE });
    crudMocks.updateContact.mockResolvedValue({ ...CONTACT_ROW, siteId: SITE, title: 'CFO' });
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(200);
  });

  it('404s a DELETE on a contact pinned to a barred site', async () => {
    setConfined();
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: BARRED_SITE });
    const res = await makeApp().request(`/contacts/${CONTACT}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(crudMocks.deleteContact).not.toHaveBeenCalled();
  });

  it('leaves an org-level contact writable by a site-confined caller', async () => {
    setConfined();
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
    crudMocks.deleteContact.mockResolvedValue(CONTACT_ROW);
    expect((await makeApp().request(`/contacts/${CONTACT}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('hands the importer the caller site allowlist alongside the org allowlist', async () => {
    setConfined();
    importMocks.commitContactImport.mockResolvedValue({ imported: [], updated: [], skipped: [], errors: [] });
    await makeApp().request('/contacts/import', json({ rows: [{ organizationId: ORG, name: 'Jane' }] }));
    expect(importMocks.commitContactImport.mock.calls[0]![1]).toEqual({
      partnerId: PARTNER, accessibleOrgIds: [ORG], allowedSiteIds: [SITE],
    });
  });
});

describe('GET /organizations/:id/contacts', () => {
  it('returns the org contacts in the paged envelope GET /orgs/sites uses', async () => {
    crudMocks.listContacts.mockResolvedValue([CONTACT_ROW]);
    crudMocks.countContacts.mockResolvedValue(1);
    const res = await makeApp().request(`/organizations/${ORG}/contacts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [CONTACT_ROW],
      pagination: { page: 1, limit: 50, total: 1 },
    });
  });

  it('honours page and limit, and reports the unpaged total', async () => {
    crudMocks.listContacts.mockResolvedValue([]);
    crudMocks.countContacts.mockResolvedValue(137);
    const res = await makeApp().request(`/organizations/${ORG}/contacts?page=3&limit=25`);

    expect(await res.json()).toMatchObject({ pagination: { page: 3, limit: 25, total: 137 } });
    // The service takes the window, so the handler cannot silently return the
    // whole table while reporting a page.
    expect(crudMocks.listContacts.mock.calls[0]![3]).toEqual({ limit: 25, offset: 50 });
    // The count runs against the SAME filters, never a bare org count.
    expect(crudMocks.countContacts.mock.calls[0]![2]).toEqual(crudMocks.listContacts.mock.calls[0]![2]);
  });

  it('clamps limit to the shared 100 cap and floors page at 1', async () => {
    crudMocks.listContacts.mockResolvedValue([]);
    await makeApp().request(`/organizations/${ORG}/contacts?page=0&limit=5000`);
    expect(crudMocks.listContacts.mock.calls[0]![3]).toEqual({ limit: 100, offset: 0 });
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
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
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
    expect(crudMocks.findContactScope).not.toHaveBeenCalled();
  });

  it('404s when the contact does not exist', async () => {
    crudMocks.findContactScope.mockResolvedValue(null);
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
  });

  it('404s when the contact belongs to an organization the caller cannot reach', async () => {
    crudMocks.findContactScope.mockResolvedValue({ orgId: OTHER_ORG, siteId: null });
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({ title: 'CFO' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('400s an empty patch', async () => {
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
    const res = await makeApp().request(`/contacts/${CONTACT}`, json({}, 'PATCH'));
    expect(res.status).toBe(400);
    expect(crudMocks.updateContact).not.toHaveBeenCalled();
  });
});

describe('DELETE /contacts/:contactId', () => {
  it('deletes the contact and audits it', async () => {
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
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
    crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
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
      partnerId: PARTNER, accessibleOrgIds: [ORG], allowedSiteIds: null,
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
      partnerId: PARTNER, accessibleOrgIds: [ORG], allowedSiteIds: null,
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
      partnerId: PARTNER, accessibleOrgIds: [ORG], allowedSiteIds: null,
    });
    expect(importMocks.commitContactImport.mock.calls[0]![2]).toEqual({ userId: 'u-1' });
  });

  it('rejects a batch over the 1000-row cap', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ organizationId: ORG, name: `Person ${i}` }));
    const res = await makeApp().request('/contacts/import', json({ rows }));
    expect(res.status).toBe(400);
    expect(importMocks.commitContactImport).not.toHaveBeenCalled();
  });

  it('400s a fuzzy acknowledgement that names no contact', async () => {
    // An `email-match`/`name-match` acknowledgement without expectedContactId
    // says "yes, apply this match" without saying to WHOM — so a match that
    // moved between preview and commit would be applied to a stranger.
    for (const expectedAnnotation of ['email-match', 'name-match']) {
      const res = await makeApp().request('/contacts/import', json({
        rows: [{ organizationId: ORG, name: 'Jane', expectedAnnotation }],
      }));
      expect(res.status).toBe(400);
    }
    expect(importMocks.commitContactImport).not.toHaveBeenCalled();
  });

  it('accepts a pinned fuzzy acknowledgement, and an unpinned `create` one', async () => {
    importMocks.commitContactImport.mockResolvedValue({ imported: [], updated: [], skipped: [], errors: [] });
    const pinned = await makeApp().request('/contacts/import', json({
      rows: [{ organizationId: ORG, name: 'Jane', expectedAnnotation: 'email-match', expectedContactId: CONTACT }],
    }));
    expect(pinned.status).toBe(200);

    const created = await makeApp().request('/contacts/import', json({
      rows: [{ organizationId: ORG, name: 'Jane', expectedAnnotation: 'create' }],
    }));
    expect(created.status).toBe(200);
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
