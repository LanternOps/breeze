import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { UserPermissions } from '../services/permissions';

/**
 * Route tests for the connection health customer-delivery setting (#8849 W5,
 * spec 2026-10-15 §6). Scope, permission and MFA middleware and
 * canManagePartnerWidePolicies stay REAL; only the DB, the audit sink, the
 * auth identity and the permission lookup are mocked.
 */

const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER = '99999999-9999-4999-8999-999999999999';
const ORG = '11111111-1111-4111-8111-111111111111';
const UNCOVERED_ORG = '44444444-4444-4444-8444-444444444444';
const USER_ID = '33333333-3333-4333-8333-333333333333';

let orgRows: Array<Record<string, unknown>> = [];
let partnerRows: Array<Record<string, unknown>> = [];
let updates: Array<{ table: string; set: Record<string, unknown> }> = [];
let updateReturning: Array<Record<string, unknown>> = [{ id: 'row' }];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: { __t: string }) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (table.__t === 'org' ? orgRows : partnerRows)),
        })),
      })),
    })),
    update: vi.fn((table: { __t: string }) => ({
      set: vi.fn((set: Record<string, unknown>) => {
        updates.push({ table: table.__t, set });
        return { where: vi.fn(() => ({ returning: vi.fn(async () => updateReturning) })) };
      }),
    })),
  },
}));
vi.mock('../db/schema', () => ({
  organizations: { __t: 'org', id: 'organizations.id', settings: 'organizations.settings', partnerId: 'organizations.partner_id' },
  partners: { __t: 'partner', id: 'partners.id', settings: 'partners.settings' },
}));
vi.mock('../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: (fn: () => unknown) => fn() }));

const auditLog: Array<Record<string, unknown>> = [];
vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async (p: Record<string, unknown>) => { auditLog.push(p); }),
}));

let currentAuth: Record<string, unknown> = {};
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', currentAuth);
      await next();
    },
  };
});

let currentPerms: UserPermissions | null = null;
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => currentPerms) };
});

import { PERMISSIONS } from '../services/permissions';
import { authMiddleware } from '../middleware/auth';
import { registerConnectionHealthSettingsRoutes } from './connectionHealthSettings';

function partnerAuth(over: Record<string, unknown> = {}): Record<string, unknown> {
  const accessible = (over.accessibleOrgIds as string[] | undefined) ?? [ORG];
  return {
    user: { id: USER_ID, email: 'admin@example.com' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    accessibleOrgIds: accessible,
    canAccessOrg: (id: string) => accessible.includes(id),
    token: { mfa: true, sid: 'sid-1' },
    ...over,
  };
}
const perms = (grants: Array<{ resource: string; action: string }>): UserPermissions =>
  ({ permissions: grants, partnerId: PARTNER, orgId: null, roleId: 'r', scope: 'partner' });
const block = (v: unknown) => ({ connectionHealth: { customerAdminsNotified: v }, other: 'kept' });

let app: Hono;
beforeEach(() => {
  vi.clearAllMocks();
  orgRows = [{ settings: {}, partnerId: PARTNER }];
  partnerRows = [{ settings: {} }];
  updates = [];
  updateReturning = [{ id: 'row' }];
  auditLog.length = 0;
  currentAuth = partnerAuth();
  currentPerms = perms([PERMISSIONS.ORGS_READ, PERMISSIONS.ORGS_WRITE]);
  app = new Hono();
  app.use('*', authMiddleware);
  registerConnectionHealthSettingsRoutes(app);
});

const get = (q = '') => app.request(`/settings${q}`);
const put = (path: string, body: unknown) =>
  app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const setSql = (i = 0) => new PgDialect().sqlToQuery(updates[i]!.set.settings as SQL);

describe('GET /settings', () => {
  it('partner default only: reports the stored value, the effective default and canManagePartner', async () => {
    partnerRows = [{ settings: block(true) }];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      partner: { customerAdminsNotified: true, enabled: true },
      org: null,
      canManagePartner: true,
      canManageOrg: false,
    });
  });

  it('with an org: inherited value + source, the override, and canManageOrg', async () => {
    partnerRows = [{ settings: block(true) }];
    orgRows = [{ settings: block(false), partnerId: PARTNER }];
    const body = await (await get(`?orgId=${ORG}`)).json();
    expect(body.org).toEqual({
      orgId: ORG,
      customerAdminsNotified: false,
      enabled: false,
      source: 'org',
      inheritedEnabled: true,
      inheritedSource: 'partner',
    });
    expect(body.canManageOrg).toBe(true);
  });

  it('nothing stored anywhere resolves off from the default', async () => {
    const body = await (await get(`?orgId=${ORG}`)).json();
    expect(body.partner).toEqual({ customerAdminsNotified: null, enabled: false });
    expect(body.org).toMatchObject({ customerAdminsNotified: null, enabled: false, source: 'default', inheritedSource: 'default' });
  });

  it('read-only for a selected-access partner user (no partner-wide writes), and without orgs:write or MFA', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    expect(await (await get(`?orgId=${ORG}`)).json()).toMatchObject({ canManagePartner: false, canManageOrg: true });
    currentAuth = partnerAuth();
    currentPerms = perms([PERMISSIONS.ORGS_READ]);
    expect(await (await get(`?orgId=${ORG}`)).json()).toMatchObject({ canManagePartner: false, canManageOrg: false });
    currentPerms = perms([PERMISSIONS.ORGS_READ, PERMISSIONS.ORGS_WRITE]);
    currentAuth = partnerAuth({ token: { mfa: false, sid: 's' } });
    const noMfa = await (await get(`?orgId=${ORG}`)).json();
    if (process.env.ENABLE_2FA !== 'false') expect(noMfa).toMatchObject({ canManagePartner: false, canManageOrg: false });
  });

  it('an org the caller cannot access is 403; an org of another partner is 404', async () => {
    expect((await get(`?orgId=${UNCOVERED_ORG}`)).status).toBe(403);
    orgRows = [{ settings: {}, partnerId: OTHER_PARTNER }];
    expect((await get(`?orgId=${ORG}`)).status).toBe(404);
    orgRows = [];
    expect((await get(`?orgId=${ORG}`)).status).toBe(404);
  });

  it('org scope is refused; a malformed orgId is 400', async () => {
    currentAuth = partnerAuth({ scope: 'organization', orgId: ORG });
    expect((await get()).status).toBe(403);
    currentAuth = partnerAuth();
    expect((await get('?orgId=nope')).status).toBe(400);
  });
});

describe('PUT /settings/partner', () => {
  it('writes only the one key, atomically, and audits it', async () => {
    const res = await put('/settings/partner', { customerAdminsNotified: true });
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('partner');
    const q = setSql();
    expect(q.sql).toContain('jsonb_set');
    expect(q.sql).toContain('customerAdminsNotified');
    expect(q.params).toContain(true);
    expect(auditLog[0]).toMatchObject({
      partnerId: PARTNER, orgId: null, action: 'connection_health.settings.updated',
      details: { level: 'partner', customerAdminsNotified: true },
    });
    expect(await res.json()).toEqual({ partner: { customerAdminsNotified: true, enabled: true } });
  });

  it('null clears the partner default (removes the key, back to off)', async () => {
    await put('/settings/partner', { customerAdminsNotified: null });
    const q = setSql();
    expect(q.sql).toContain("- 'customerAdminsNotified'");
    expect(q.sql).not.toContain('jsonb_build_object');
  });

  it('refuses selected-access partner users, org scope, missing orgs:write, and bad bodies', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    expect((await put('/settings/partner', { customerAdminsNotified: true })).status).toBe(403);
    currentAuth = partnerAuth({ scope: 'organization', orgId: ORG });
    expect((await put('/settings/partner', { customerAdminsNotified: true })).status).toBe(403);
    currentAuth = partnerAuth();
    currentPerms = perms([PERMISSIONS.ORGS_READ]);
    expect((await put('/settings/partner', { customerAdminsNotified: true })).status).toBe(403);
    currentPerms = perms([PERMISSIONS.ORGS_READ, PERMISSIONS.ORGS_WRITE]);
    expect((await put('/settings/partner', { customerAdminsNotified: 'yes' })).status).toBe(400);
    expect((await put('/settings/partner', { customerAdminsNotified: true, extra: 1 })).status).toBe(400);
    expect((await put('/settings/partner', {})).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('requires a satisfied MFA claim', async () => {
    if (process.env.ENABLE_2FA === 'false') return;
    currentAuth = partnerAuth({ token: { mfa: false, sid: 's' } });
    expect((await put('/settings/partner', { customerAdminsNotified: true })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });
});

describe('PUT /settings/orgs/:orgId', () => {
  it('writes the org override and audits it against the org', async () => {
    const res = await put(`/settings/orgs/${ORG}`, { customerAdminsNotified: false });
    expect(res.status).toBe(200);
    expect(updates[0]!.table).toBe('org');
    expect(setSql().params).toContain(false);
    expect(auditLog[0]).toMatchObject({
      orgId: ORG, action: 'connection_health.settings.updated',
      details: { level: 'organization', customerAdminsNotified: false },
    });
  });

  it('null means inherit: the override key is removed', async () => {
    await put(`/settings/orgs/${ORG}`, { customerAdminsNotified: null });
    expect(setSql().sql).toContain("- 'customerAdminsNotified'");
  });

  it('a selected-access partner user may set an org they cover, but not one they do not', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    expect((await put(`/settings/orgs/${ORG}`, { customerAdminsNotified: true })).status).toBe(200);
    expect((await put(`/settings/orgs/${UNCOVERED_ORG}`, { customerAdminsNotified: true })).status).toBe(403);
  });

  it('404 when the row is not visible (RLS) or belongs to another partner', async () => {
    updateReturning = [];
    expect((await put(`/settings/orgs/${ORG}`, { customerAdminsNotified: true })).status).toBe(404);
    expect(auditLog).toHaveLength(0);
  });

  it('org-scope callers (customer admins) cannot change it', async () => {
    currentAuth = partnerAuth({ scope: 'organization', orgId: ORG });
    expect((await put(`/settings/orgs/${ORG}`, { customerAdminsNotified: true })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });
});
