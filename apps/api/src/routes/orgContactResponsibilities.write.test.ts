import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, gateState, svc, crudMocks, auditSpy, dbRows } = vi.hoisted(() => ({
  authRef: { current: null as Record<string, unknown> | null },
  gateState: { granted: true, denied: new Set<string>(), mfaSatisfied: true },
  svc: { set: vi.fn(), list: vi.fn() },
  crudMocks: { findContactScope: vi.fn() },
  auditSpy: vi.fn(),
  dbRows: { current: [] as unknown[] },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
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

vi.mock('../db', () => ({ db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => dbRows.current) })) })) })) } }));
vi.mock('../db/schema', () => ({
  organizations: { id: 'id', deletedAt: 'deletedAt' },
  contacts: {}, devices: {}, sites: {},
}));

vi.mock('../services/contacts/crud', () => ({
  ContactValidationError: class ContactValidationError extends Error {
    constructor(message: string, public readonly code: string) { super(message); }
  },
  listContacts: vi.fn(), countContacts: vi.fn(), createContact: vi.fn(), updateContact: vi.fn(), deleteContact: vi.fn(),
  findContactScope: (...a: unknown[]) => crudMocks.findContactScope(...a),
}));
vi.mock('../services/contacts/import', () => ({ previewContactImport: vi.fn(), commitContactImport: vi.fn() }));
vi.mock('../services/contacts/responsibilities', () => ({
  ResponsibilityValidationError: class ResponsibilityValidationError extends Error {
    readonly status = 400;
    constructor(message: string, public readonly code: string) { super(message); }
  },
  resolveContactResponsibility: vi.fn(),
  setContactResponsibilities: (...a: unknown[]) => svc.set(...a),
  listContactResponsibilities: (...a: unknown[]) => svc.list(...a),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: (...a: unknown[]) => auditSpy(...a) }));

import { authMiddleware } from '../middleware/auth';
import { registerOrgContactsRoutes } from './orgContacts';
import { registerOrgContactResponsibilitiesRoutes } from './orgContactResponsibilities';
import { ResponsibilityValidationError } from '../services/contacts/responsibilities';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '1e1e1e1e-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const GROUP = '44444444-4444-4444-8444-444444444444';
const CONTACT = '33333333-3333-4333-8333-333333333333';

const BASE_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess', email: 't@msp.example' },
  partnerId: 'aaaaaaaa-1111-4111-8111-111111111111',
  orgId: null,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  allowedSiteIds: undefined as string[] | undefined,
  canAccessSite: undefined as ((s: string | null | undefined) => boolean) | undefined,
};

function app() {
  const a = new Hono();
  a.use('*', authMiddleware as any);
  registerOrgContactsRoutes(a);
  registerOrgContactResponsibilitiesRoutes(a);
  return a;
}
const put = (body: unknown) => app().request(`/contacts/${CONTACT}/responsibilities`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const org = { scope: { type: 'organization' } };

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { ...BASE_AUTH };
  gateState.granted = true; gateState.denied = new Set(); gateState.mfaSatisfied = true;
  crudMocks.findContactScope.mockResolvedValue({ orgId: ORG, siteId: null });
  svc.set.mockResolvedValue(undefined);
  svc.list.mockResolvedValue([]);
});

describe('GET /contacts/:contactId/responsibilities', () => {
  it('returns the configured set with typed scopes', async () => {
    svc.list.mockResolvedValue([
      { role: 'admin', isPrimary: true, siteId: null, deviceGroupId: null },
      { role: 'technical', isPrimary: false, siteId: SITE, deviceGroupId: null },
      { role: 'escalation', isPrimary: false, siteId: null, deviceGroupId: GROUP },
    ]);
    const res = await app().request(`/contacts/${CONTACT}/responsibilities`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ responsibilities: [
      { role: 'admin', scope: { type: 'organization' }, isPrimary: true },
      { role: 'technical', scope: { type: 'site', siteId: SITE }, isPrimary: false },
      { role: 'escalation', scope: { type: 'device_group', deviceGroupId: GROUP }, isPrimary: false },
    ] });
    expect(svc.list).toHaveBeenCalledWith(expect.anything(), { contactId: CONTACT, orgId: ORG });
  });

  it('hides rows at Sites a site-confined caller cannot reach', async () => {
    const OTHER_SITE = '00000000-0000-4000-8000-0000000000a9';
    authRef.current = { ...BASE_AUTH, allowedSiteIds: [SITE], canAccessSite: (s: string | null | undefined) => s === SITE };
    svc.list.mockResolvedValue([
      { role: 'technical', isPrimary: false, siteId: SITE, deviceGroupId: null },
      { role: 'technical', isPrimary: false, siteId: OTHER_SITE, deviceGroupId: null },
    ]);
    const res = await app().request(`/contacts/${CONTACT}/responsibilities`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ responsibilities: [
      { role: 'technical', scope: { type: 'site', siteId: SITE }, isPrimary: false },
    ] });
  });

  it('403s without organizations:read', async () => {
    gateState.denied.add('organizations:read');
    expect((await app().request(`/contacts/${CONTACT}/responsibilities`)).status).toBe(403);
  });

  it('404s a contact of another organization', async () => {
    crudMocks.findContactScope.mockResolvedValue({ orgId: OTHER_ORG, siteId: null });
    expect((await app().request(`/contacts/${CONTACT}/responsibilities`)).status).toBe(404);
  });
});

describe('PUT /contacts/:contactId/responsibilities', () => {
  it('replaces the set and returns the current one', async () => {
    svc.list.mockResolvedValue([{ role: 'admin', isPrimary: false, siteId: null, deviceGroupId: null }]);
    const res = await put({ responsibilities: [
      { role: 'admin', ...org },
      { role: 'technical', scope: { type: 'site', siteId: SITE } },
    ] });
    expect(res.status).toBe(200);
    expect((await res.json() as any).responsibilities).toHaveLength(1);
    expect(svc.set).toHaveBeenCalledWith(expect.anything(), {
      contactId: CONTACT, orgId: ORG,
      responsibilities: [
        { role: 'admin', scope: { type: 'organization' } },
        { role: 'technical', scope: { type: 'site', siteId: SITE } },
      ],
    });
  });

  it('accepts an empty set', async () => {
    expect((await put({ responsibilities: [] })).status).toBe(200);
    expect(svc.set.mock.calls[0]![1].responsibilities).toEqual([]);
  });

  it('audits counts only, with no PII', async () => {
    await put({ responsibilities: [{ role: 'admin', ...org }, { role: 'technical', scope: { type: 'site', siteId: SITE } }] });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0]![1];
    expect(event.details).toEqual({
      changedFields: ['responsibilities'], count: 2,
      byRole: { admin: 1, technical: 1 }, byScope: { organization: 1, site: 1 },
    });
    expect(JSON.stringify(event.details)).not.toContain(SITE);
  });

  it('400s a Site and a Device Group in one scope', async () => {
    const res = await put({ responsibilities: [{ role: 'admin', scope: { type: 'site', siteId: SITE, deviceGroupId: GROUP } }] });
    expect(res.status).toBe(400);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid role', { responsibilities: [{ role: 'emperor', ...org }] }],
    ['invalid scope type', { responsibilities: [{ role: 'admin', scope: { type: 'region' } }] }],
    ['non-uuid siteId', { responsibilities: [{ role: 'admin', scope: { type: 'site', siteId: 'nope' } }] }],
    ['extra key', { responsibilities: [{ role: 'admin', ...org, extra: 1 }] }],
    ['over 200 entries', { responsibilities: Array.from({ length: 201 }, () => ({ role: 'admin', ...org })) }],
  ])('400s %s without calling the service', async (_l, body) => {
    expect((await put(body)).status).toBe(400);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it.each([
    ['site-not-in-org', 'Site from another org'],
    ['device-group-not-in-org', 'Device Group from another org'],
    ['duplicate-assignment', 'duplicate'],
  ])('maps service refusal %s to 400 {error, code}', async (code, message) => {
    svc.set.mockRejectedValue(new ResponsibilityValidationError(message, code as never));
    const res = await put({ responsibilities: [{ role: 'admin', ...org }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message, code });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('404s when the contact vanished mid-write', async () => {
    svc.set.mockRejectedValue(new ResponsibilityValidationError('gone', 'contact-not-in-org'));
    expect((await put({ responsibilities: [] })).status).toBe(404);
  });

  it('rethrows unexpected errors', async () => {
    svc.set.mockRejectedValue(new Error('boom'));
    expect((await put({ responsibilities: [] })).status).toBe(500);
  });

  it('404s a contact of another organization and never writes', async () => {
    crudMocks.findContactScope.mockResolvedValue({ orgId: OTHER_ORG, siteId: null });
    expect((await put({ responsibilities: [] })).status).toBe(404);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('403s without organizations:write', async () => {
    gateState.denied.add('organizations:write');
    expect((await put({ responsibilities: [] })).status).toBe(403);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('403s when MFA is not satisfied', async () => {
    gateState.mfaSatisfied = false;
    expect((await put({ responsibilities: [] })).status).toBe(403);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('403s a caller confined to sites', async () => {
    authRef.current = { ...BASE_AUTH, allowedSiteIds: [SITE], canAccessSite: (s: string | null | undefined) => s === SITE };
    expect((await put({ responsibilities: [] })).status).toBe(403);
    expect(svc.set).not.toHaveBeenCalled();
  });
});
