/**
 * #3198 W01 — partner-owned report definitions through the report routes.
 *
 * A partner-owned definition (`org_id NULL`, `partner_id = P`,
 * `execution_scope_kind = 'partner_wide'`) is an aggregate over EVERY org of
 * the partner. The rules pinned here:
 *
 *  - Only a full-partner admin (`partnerOrgAccess = 'all'`) may create, read,
 *    list, update, delete, generate or touch its runs/recipients. The database
 *    cannot enforce that: `breeze_has_partner_access` is flat membership, so a
 *    'selected' partner user's RLS context DOES see the row. Every gate below
 *    is therefore app-layer, and each case feeds the route the partner-owned
 *    row as if RLS had returned it.
 *  - `partner_id` always comes from the caller's token, never from the body.
 *  - Org-scope tokens never get a `partner_id` predicate, even though they
 *    carry a partnerId.
 *  - #3198 W02: generating one runs the partner-scope generator (the W01
 *    refusal is gone); a business type also requires its underlying read
 *    permissions (ruling P8) on create, PUT and generate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURED_AT = new Date('2026-09-21T12:00:00.000Z');

const ALL_PERMISSIONS = [{ resource: '*', action: '*' }];
/** reports:* plus everything a business type needs EXCEPT invoices:read. */
const NO_INVOICES_PERMISSIONS = [
  { resource: 'reports', action: '*' },
  { resource: 'tickets', action: 'read' },
  { resource: 'time_entries', action: 'read' },
];

const state = vi.hoisted(() => ({
  auth: null as unknown,
  permissions: null as unknown,
  orgAuthority: null as unknown,
  partnerAuthority: null as unknown,
  authorityMap: new Map<string, unknown>(),
  rows: [] as Array<Record<string, unknown> | null>,
  wheres: [] as unknown[],
  inserts: [] as Array<{ values: Record<string, unknown> }>,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  deletes: [] as Array<{ where: unknown }>,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', state.auth);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  // The real requirePermission is what populates `permissions` (auth.ts:919).
  requirePermission: () => async (c: any, next: () => Promise<void>) => {
    c.set('permissions', state.permissions);
    await next();
  },
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../db', () => {
  const select = vi.fn((projection?: Record<string, unknown>) => {
    const next = state.rows.shift();
    const rows = next === null || next === undefined ? [] : [next];
    const projected = projection
      ? rows.map((source) => Object.fromEntries(Object.keys(projection).map((k) => [k, source[k]])))
      : rows;
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(projected).then(resolve, reject),
    };
    for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'offset', 'limit', 'for']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.where = vi.fn((condition: unknown) => {
      state.wheres.push(condition);
      return chain;
    });
    return chain;
  });

  const insert = vi.fn(() => {
    const entry = { values: {} as Record<string, unknown> };
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((values: Record<string, unknown>) => {
      entry.values = values;
      state.inserts.push(entry);
      return chain;
    });
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(async () => [{ id: REPORT_ID, ...entry.values }]);
    return chain;
  });

  const update = vi.fn(() => {
    const entry = { set: {} as Record<string, unknown>, where: undefined as unknown };
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((set: Record<string, unknown>) => {
      entry.set = set;
      return chain;
    });
    chain.where = vi.fn((where: unknown) => {
      entry.where = where;
      state.updates.push(entry);
      return chain;
    });
    chain.returning = vi.fn(async () => [{ id: REPORT_ID, orgId: null, partnerId: PARTNER_ID, name: 'x', ...entry.set }]);
    return chain;
  });

  const del = vi.fn(() => {
    const entry = { where: undefined as unknown };
    const chain: Record<string, unknown> = {};
    chain.where = vi.fn((where: unknown) => {
      entry.where = where;
      state.deletes.push(entry);
      return chain;
    });
    chain.returning = vi.fn(async () => [{ id: REPORT_ID, orgId: null, partnerId: PARTNER_ID, name: 'x' }]);
    return chain;
  });

  const handle = { select, insert, update, delete: del };
  return {
    db: {
      ...handle,
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(handle)),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../../services/reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportGenerationService')>();
  return {
    ...actual,
    generateReport: vi.fn(async () => ({ rows: [] })),
    previousBaselineFor: vi.fn(async () => undefined),
  };
});

// The partner org list is resolved by reportScope.ts against the DB; this
// suite's row queue is positional, so the scope is stubbed here and the real
// resolver is covered by reportScope.test.ts + generate.businessScope.test.ts.
vi.mock('../../services/reportScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportScope')>();
  return {
    ...actual,
    reportScopeFromAuthority: vi.fn(async (owner: { orgId?: string; partnerId?: string }) =>
      owner.partnerId !== undefined
        ? { kind: 'partner', partnerId: owner.partnerId, orgIds: [ORG_ID] }
        : { kind: 'organization', orgId: owner.orgId }),
  };
});

vi.mock('../../services/sensitiveReadAudit', () => ({ auditSensitiveRead: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveRequestReportAuthority: vi.fn(async () => state.orgAuthority),
    resolveRequestReportAuthorityMap: vi.fn(async () => state.authorityMap),
    resolveRequestPartnerReportAuthority: vi.fn(async () => state.partnerAuthority),
  };
});

import { coreRoutes } from './core';
import { runsRoutes } from './runs';
import { generateRoutes } from './generate';
import { recipientsRoutes } from './recipients';
import {
  partnerWideScope,
  resolveRequestPartnerReportAuthority,
  siteScopeFingerprint,
} from '../../services/siteScope';
import { generateReport, UnsupportedReportScopeError } from '../../services/reportGenerationService';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { writeRouteAudit } from '../../services/auditEvents';

function app(): Hono {
  // Same mount order as routes/reports/index.ts.
  const instance = new Hono();
  instance.route('/reports', generateRoutes);
  instance.route('/reports', runsRoutes);
  instance.route('/reports', recipientsRoutes);
  instance.route('/reports', coreRoutes);
  return instance;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function partnerAuth(partnerOrgAccess: 'all' | 'selected') {
  return {
    user: { id: USER_ID, email: 'tech@example.com' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    partnerOrgAccess,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
  };
}

/** Org tokens DO carry a partnerId — the point is that it is never used. */
function orgAuth() {
  return {
    user: { id: USER_ID, email: 'tech@example.com' },
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
  };
}

function partnerAuthorityResult() {
  const scope = partnerWideScope(PARTNER_ID);
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: USER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

function orgAuthorityResult() {
  const scope = { version: 1 as const, kind: 'unrestricted' as const, orgId: ORG_ID };
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: USER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

/** The row a partner-owned create persists. */
function partnerDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'AR aging',
    type: 'ar_aging',
    config: {},
    schedule: 'monthly',
    format: 'pdf',
    createdBy: USER_ID,
    executionScopeVersion: 1,
    executionScopeKind: 'partner_wide',
    executionScopeSiteIds: null,
    executionScopeUserId: USER_ID,
    executionScopeFingerprint: siteScopeFingerprint(partnerWideScope(PARTNER_ID)),
    executionScopeCapturedAt: CAPTURED_AT,
    executionScopePrincipalKind: 'user',
    portalSelfService: false,
    ...overrides,
  };
}

const dialect = new PgDialect();
function params(where: unknown): unknown[] {
  return dialect.sqlToQuery(where as SQL).params;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = partnerAuth('all');
  state.permissions = { permissions: ALL_PERMISSIONS };
  state.orgAuthority = orgAuthorityResult();
  state.partnerAuthority = partnerAuthorityResult();
  state.authorityMap = new Map([[ORG_ID, orgAuthorityResult()]]);
  state.rows = [];
  state.wheres = [];
  state.inserts = [];
  state.updates = [];
  state.deletes = [];
});

describe('POST /reports ownerScope=partner (#3198 W01)', () => {
  const body = { ownerScope: 'partner', name: 'AR aging', type: 'ar_aging', schedule: 'monthly', format: 'pdf' };

  it('403s an org-scope token', async () => {
    state.auth = orgAuth();
    const res = await app().request('/reports', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_scope_required' });
    expect(state.inserts).toHaveLength(0);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('403s a partner token whose partnerOrgAccess is selected', async () => {
    state.auth = partnerAuth('selected');
    const res = await app().request('/reports', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(state.inserts).toHaveLength(0);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('400s a type whose registry entry does not support partner scope', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ...body, type: 'device_inventory' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_report_scope', type: 'device_inventory' });
    expect(state.inserts).toHaveLength(0);
  });

  it('inserts partnerId from auth, orgId null, partner_wide scope columns', async () => {
    const res = await app().request('/reports', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

    expect(res.status).toBe(201);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'write');
    expect(state.inserts).toHaveLength(1);
    const values = state.inserts[0]!.values;
    expect(values.partnerId).toBe(PARTNER_ID);
    expect(values.orgId).toBeNull();
    expect(values.type).toBe('ar_aging');
    expect(values.executionScopeKind).toBe('partner_wide');
    expect(values.executionScopeUserId).toBe(USER_ID);
    expect(values.executionScopeSiteIds).toBeNull();
    expect(values.executionScopePrincipalKind).toBe('user');
    expect(values.executionScopeFingerprint).toBe(siteScopeFingerprint(partnerWideScope(PARTNER_ID)));
    expect(vi.mocked(writeRouteAudit).mock.calls[0]?.[1]).toMatchObject({
      orgId: null,
      action: 'report.create',
      details: { ownerScope: 'partner', partnerId: PARTNER_ID },
    });
  });

  it('ignores a client-supplied partnerId', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, partnerId: OTHER_PARTNER_ID }),
    });

    expect(res.status).toBe(201);
    expect(state.inserts[0]!.values.partnerId).toBe(PARTNER_ID);
    expect(state.inserts[0]!.values.orgId).toBeNull();
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'write');
  });

  // #3198 W02 (addendum B6): the partner arm of the ownerScope discriminated
  // union declares `orgId: z.never()`. W01 accepted-and-ignored it; a caller
  // who believes they aimed a partner report at one org now gets a 400.
  it('400s a partner-owned create that carries an orgId', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, orgId: ORG_ID }),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { details: { fieldErrors: Record<string, unknown> } }).details.fieldErrors)
      .toHaveProperty('orgId');
    expect(state.inserts).toHaveLength(0);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('403s when the live partner authority is refused', async () => {
    state.partnerAuthority = { ok: false, reason: 'partner_access_not_all' };
    const res = await app().request('/reports', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Report scope is not authorized', reason: 'partner_access_not_all' });
    expect(state.inserts).toHaveLength(0);
  });

  // #3198 W02 (ruling P8): reports:write is not enough to schedule AR by email.
  it('403s Insufficient permissions for ar_aging without invoices:read — both owner arms, no insert', async () => {
    state.permissions = { permissions: NO_INVOICES_PERMISSIONS };
    const partnerRes = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
    });
    expect(partnerRes.status).toBe(403);
    expect(await partnerRes.json()).toEqual({ error: 'Insufficient permissions' });

    const orgRes = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'AR', type: 'ar_aging', orgId: ORG_ID }),
    });
    expect(orgRes.status).toBe(403);
    expect(await orgRes.json()).toEqual({ error: 'Insufficient permissions' });

    expect(state.inserts).toHaveLength(0);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();

    // Positive control: the same caller may still create a legacy type.
    const legacy = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Inventory', type: 'device_inventory', orgId: ORG_ID }),
    });
    expect(legacy.status).toBe(201);
  });

  it('an ownerScope-less create still inserts an org-owned row (unchanged default)', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Inventory', type: 'device_inventory', orgId: ORG_ID }),
    });

    expect(res.status).toBe(201);
    expect(state.inserts[0]!.values.orgId).toBe(ORG_ID);
    expect(state.inserts[0]!.values).not.toHaveProperty('partnerId');
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });
});

describe('PUT /reports/:id on a partner-owned definition', () => {
  it('rejects ownerScope in the body (schema omits it)', async () => {
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ ownerScope: 'organization', name: 'Renamed' }),
    });

    expect(res.status).toBe(400);
    expect(state.wheres).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('production path: a selected-access partner user gets 404 — the metadata read excludes partner-owned rows', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [null];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.status).toBe(404);
    expect(params(state.wheres[0])).not.toContain(PARTNER_ID);
    expect(state.updates).toHaveLength(0);
  });

  it('defense in depth: 403s a selected-access partner user if the metadata read ever returned the row', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(state.updates).toHaveLength(0);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('refuses orgId in the body — ownership is immutable', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed', orgId: ORG_ID }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'report_ownership_immutable' });
    expect(state.updates).toHaveLength(0);
  });

  // #3198 W02 (ruling P8): a PUT can redirect `config.emailRecipients`, so a
  // caller who could not create the report cannot edit it either.
  it('403s Insufficient permissions on an ar_aging row without invoices:read, before any write', async () => {
    state.permissions = { permissions: NO_INVOICES_PERMISSIONS };
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ config: { emailRecipients: ['me@example.com'] } }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
    expect(state.updates).toHaveLength(0);
  });

  it('positive control: the same caller may still edit a device_inventory row', async () => {
    state.permissions = { permissions: NO_INVOICES_PERMISSIONS };
    const orgRow = partnerDefinition({
      type: 'device_inventory', orgId: ORG_ID, partnerId: null, executionScopeKind: 'unrestricted',
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: ORG_ID }),
    });
    state.auth = orgAuth();
    state.rows = [orgRow, orgRow];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });

  it('updates through the partner axis for a full-access partner admin', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'write');
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set.name).toBe('Renamed');
    const bound = params(state.updates[0]!.where);
    expect(bound).toContain(PARTNER_ID);
    expect(bound).toContain('partner_wide');
  });
});

/**
 * #3198 W02 (ruling P15). The PUT body carries no `type`, so the route
 * validates `config` against the STORED row's type. The positive control
 * (a foreign key on device_inventory passes through) proves it is the stored
 * type selecting the schema, not a blanket union of every type's keys.
 */
describe('PUT /reports/:id validates config against the stored row\'s type', () => {
  function orgDefinition(type: string) {
    return partnerDefinition({
      type,
      orgId: ORG_ID,
      partnerId: null,
      executionScopeKind: 'unrestricted',
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: ORG_ID }),
    });
  }
  beforeEach(() => {
    state.auth = orgAuth();
  });

  it('400s a value the stored type rejects, and updates nothing', async () => {
    state.rows = [orgDefinition('vulnerability_management'), orgDefinition('vulnerability_management')];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ config: { topN: 9999 } }),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { details: { fieldErrors: Record<string, unknown> } }).details.fieldErrors)
      .toHaveProperty(['config.topN']);
    expect(state.updates).toHaveLength(0);
  });

  it('stores only the keys the caller sent — no defaults frozen into the row', async () => {
    state.rows = [orgDefinition('vulnerability_management'), orgDefinition('vulnerability_management')];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ config: { topN: 10, builderType: 'vulns' } }),
    });

    expect(res.status).toBe(200);
    expect(state.updates[0]!.set.config).toEqual({ topN: 10, builderType: 'vulns' });
  });

  it('positive control: the same key on a device_inventory row passes through unvalidated', async () => {
    state.rows = [orgDefinition('device_inventory'), orgDefinition('device_inventory')];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ config: { topN: 9999 } }),
    });

    expect(res.status).toBe(200);
    expect(state.updates[0]!.set.config).toEqual({ topN: 9999 });
  });

  it('a `type` key inside the body config cannot pick a different schema', async () => {
    state.rows = [orgDefinition('vulnerability_management'), orgDefinition('vulnerability_management')];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ config: { type: 'device_inventory', topN: 9999 } }),
    });

    expect(res.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });
});

describe('POST /reports validates config against body.type (#3198 W02, ruling P15)', () => {
  beforeEach(() => {
    state.auth = orgAuth();
  });

  it('400s a value the type rejects', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Vulns', type: 'vulnerability_management', config: { topN: 9999 } }),
    });

    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it('passes a foreign type\'s key through on another type (strip-nothing)', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Inventory', type: 'device_inventory', config: { topN: 9999 } }),
    });

    expect(res.status).toBe(201);
    expect(state.inserts[0]!.values.config).toEqual({ topN: 9999 });
  });

  it('never persists a client-sent `config.type` (the row\'s own `type` column is the only type)', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Inventory', type: 'device_inventory', config: { type: 'ar_aging', columns: ['hostname'] } }),
    });

    expect(res.status).toBe(201);
    expect(state.inserts[0]!.values.config).toEqual({ columns: ['hostname'] });
    expect(state.inserts[0]!.values.type).toBe('device_inventory');
  });
});

describe('PUT /reports/:id config hygiene (#3198 W02 Task 13)', () => {
  it('never persists a client-sent `config.type` on PUT', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ config: { type: 'device_inventory', groupBy: 'currency' } }),
    });

    expect(res.status).toBe(200);
    expect(state.updates[0]!.set.config).toEqual({ groupBy: 'currency' });
  });

  it('400s a PUT on a partner-owned ar_aging row whose config the stored type rejects, updating nothing', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ config: { groupBy: 'technician', asOf: '2026-02-30' } }),
    });

    expect(res.status).toBe(400);
    const fieldErrors = (await res.json() as { details: { fieldErrors: Record<string, unknown> } }).details.fieldErrors;
    expect(fieldErrors).toHaveProperty(['config.groupBy']);
    expect(fieldErrors).toHaveProperty(['config.asOf']);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'write');
    expect(state.updates).toHaveLength(0);
  });
});

describe('DELETE /reports/:id on a partner-owned definition', () => {
  it('defense in depth: 403s a selected-access partner user if the metadata read ever returned the row', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(state.deletes).toHaveLength(0);
  });

  it('deletes through the partner axis for a full-access partner admin', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'delete');
    const reportDelete = state.deletes.at(-1)!;
    expect(params(reportDelete.where)).toContain(PARTNER_ID);
  });
});

describe('GET /reports list for partner scope', () => {
  it('includes partner-owned rows only when partnerOrgAccess is all', async () => {
    state.rows = [{ count: 0 }, null];
    const all = await app().request('/reports');
    expect(all.status).toBe(200);
    expect(params(state.wheres[0])).toContain(PARTNER_ID);
    expect(params(state.wheres[0])).toContain('partner_wide');

    state.auth = partnerAuth('selected');
    state.wheres = [];
    state.rows = [{ count: 0 }, null];
    const selected = await app().request('/reports');
    expect(selected.status).toBe(200);
    expect(params(state.wheres[0])).not.toContain(PARTNER_ID);
    expect(params(state.wheres[0])).toContain(ORG_ID);
  });

  it('excludes partner-owned rows when an explicit orgId is requested', async () => {
    state.rows = [{ count: 0 }, null];
    const res = await app().request(`/reports?orgId=${ORG_ID}`);

    expect(res.status).toBe(200);
    expect(params(state.wheres[0])).not.toContain(PARTNER_ID);
  });

  it('never adds a partner_id predicate for org scope', async () => {
    state.auth = orgAuth();
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports');

    expect(res.status).toBe(200);
    expect(params(state.wheres[0])).not.toContain(PARTNER_ID);
    expect(params(state.wheres[0])).not.toContain('partner_wide');
    expect(params(state.wheres[0])).toContain(ORG_ID);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });
});

// #3198 W02 (addendum B7, ruling P9): a system-scope (platform admin) list
// also sees partner-owned rows, but only with a well-formed partner_wide
// envelope on a row that actually has a partner owner.
function systemAuth() {
  return {
    user: { id: USER_ID, email: 'admin@example.com' },
    scope: 'system',
    orgId: null,
    partnerId: null,
    accessibleOrgIds: null,
    canAccessOrg: () => true,
  };
}

function sqlText(where: unknown): string {
  return dialect.sqlToQuery(where as SQL).sql;
}

describe('system-scope lists include partner-owned rows (B7)', () => {
  it('GET /reports adds a partner_wide arm bound to a non-null partner_id', async () => {
    state.auth = systemAuth();
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports');

    expect(res.status).toBe(200);
    expect(params(state.wheres[0])).toContain('partner_wide');
    expect(params(state.wheres[0])).toContain('unrestricted');
    expect(sqlText(state.wheres[0])).toContain('"reports"."partner_id" is not null');
  });

  it('GET /reports/templates stays org-owned only for a system caller', async () => {
    state.auth = systemAuth();
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports/templates');

    expect(res.status).toBe(200);
    expect(params(state.wheres[0])).not.toContain('partner_wide');
  });

  it('GET /reports/runs adds the partner_wide arm on the run envelope', async () => {
    state.auth = systemAuth();
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports/runs');

    expect(res.status).toBe(200);
    expect(params(state.wheres[0])).toContain('partner_wide');
    expect(sqlText(state.wheres[0])).toContain('"reports"."partner_id" is not null');
    expect(sqlText(state.wheres[0])).toContain('"report_runs"."execution_scope_kind"');
  });
});

describe('GET /reports/:id on a partner-owned definition', () => {
  it('404s a selected-access partner user', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}`);

    expect(res.status).toBe(404);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('reads it, with partner-axis run scope, for a full-access partner admin', async () => {
    state.rows = [partnerDefinition(), partnerDefinition(), null];
    const res = await app().request(`/reports/${REPORT_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.partnerId).toBe(PARTNER_ID);
    expect(body.orgId).toBeNull();
    const runsWhere = params(state.wheres.at(-1));
    expect(runsWhere).toContain('partner_wide');
  });
});

describe('POST /reports/:id/generate on a partner-owned definition', () => {
  it('generates under a partner scope, stamping a partner_wide run (#3198 W02)', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'completed' });
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'read');
    expect(state.inserts).toHaveLength(1);
    const run = state.inserts[0]!.values;
    expect(run.executionScopeKind).toBe('partner_wide');
    expect(run.executionScopeSiteIds).toBeNull();
    expect(run.executionScopeUserId).toBe(USER_ID);
    expect(run.executionScopeFingerprint).toBe(siteScopeFingerprint(partnerWideScope(PARTNER_ID)));
    const [type, scope, , authority] = vi.mocked(generateReport).mock.calls[0]!;
    expect(type).toBe('ar_aging');
    expect(scope).toEqual({ kind: 'partner', partnerId: PARTNER_ID, orgIds: [ORG_ID] });
    expect((authority as { scope: { kind: string } }).scope.kind).toBe('partner_wide');
    // A partner-owned run has no org to attribute and must not borrow one.
    expect(vi.mocked(writeRouteAudit).mock.calls[0]?.[1]).toMatchObject({
      orgId: null,
      action: 'report.generate',
      details: { reportId: REPORT_ID, partnerId: PARTNER_ID },
    });
    expect(state.updates.at(-1)?.set).toEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('a platform admin (system token) generates it through the platform partner authority', async () => {
    state.auth = {
      user: { id: USER_ID, email: 'admin@example.com' },
      scope: 'system',
      orgId: null,
      partnerId: null,
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    };
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'read');
    expect(vi.mocked(generateReport).mock.calls[0]?.[1]).toMatchObject({ kind: 'partner', partnerId: PARTNER_ID });
  });

  it('403s Insufficient permissions without invoices:read, before any run row', async () => {
    state.permissions = { permissions: NO_INVOICES_PERMISSIONS };
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
    expect(state.inserts).toHaveLength(0);
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('403s when the stored envelope does not intersect the live partner authority', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    state.partnerAuthority = { ok: false, reason: 'permission_removed' };
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    // getReportWithOwnerCheck resolves the same authority first, so a demoted
    // caller cannot even see the definition.
    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
  });

  it('refuses a stored partner-scope config carrying an org selector (preflight), before any run row', async () => {
    const withSelector = partnerDefinition({ config: { orgIds: [ORG_ID] } });
    state.rows = [withSelector, withSelector];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(state.inserts).toHaveLength(0);
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('an org-only type stored under the partner axis still records the stable unsupported_report_scope code', async () => {
    const orgOnly = partnerDefinition({ type: 'device_inventory' });
    state.rows = [orgOnly, orgOnly];
    vi.mocked(generateReport).mockRejectedValueOnce(new UnsupportedReportScopeError('device_inventory', 'partner'));
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unsupported_report_scope', type: 'device_inventory' });
    expect(state.updates.at(-1)?.set).toEqual(expect.objectContaining({
      status: 'failed',
      errorMessage: 'unsupported_report_scope',
    }));
  });

  it('404s a selected-access partner user', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
  });
});

describe('POST /reports/:id/generate on an org-owned business-type definition', () => {
  it('400s unsupported_report_scope and records the stable code (not err.message) on the failed run', async () => {
    state.auth = orgAuth();
    const orgDefinition = partnerDefinition({
      orgId: ORG_ID,
      partnerId: null,
      executionScopeKind: 'unrestricted',
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: ORG_ID }),
    });
    state.rows = [orgDefinition, orgDefinition, orgDefinition, orgDefinition];
    vi.mocked(generateReport).mockRejectedValueOnce(new UnsupportedReportScopeError('ar_aging', 'organization'));

    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_report_scope', type: 'ar_aging', runId: REPORT_ID });
    expect(state.updates.at(-1)?.set).toEqual(expect.objectContaining({
      status: 'failed',
      errorMessage: 'unsupported_report_scope',
    }));
  });
});

describe('POST /reports/generate (ad-hoc) ownerScope=partner', () => {
  it('403s an org-scope token', async () => {
    state.auth = orgAuth();
    const res = await app().request('/reports/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ownerScope: 'partner', type: 'ar_aging' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_scope_required' });
  });

  it('403s a selected-access partner user', async () => {
    state.auth = partnerAuth('selected');
    const res = await app().request('/reports/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ownerScope: 'partner', type: 'ar_aging' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  });

  it('generates a partner-scope report for a full-access partner admin (#3198 W02)', async () => {
    const res = await app().request('/reports/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ownerScope: 'partner', type: 'ar_aging' }),
    });
    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'read');
    expect(vi.mocked(generateReport).mock.calls[0]?.[1])
      .toEqual({ kind: 'partner', partnerId: PARTNER_ID, orgIds: [ORG_ID] });
  });

  it('still 400s unsupported_report_scope for a type with no partner-scope generator', async () => {
    const res = await app().request('/reports/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ownerScope: 'partner', type: 'device_inventory' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_report_scope', type: 'device_inventory' });
    expect(generateReport).not.toHaveBeenCalled();
  });
});

describe('runs of a partner-owned definition', () => {
  function partnerRun(overrides: Record<string, unknown> = {}) {
    return {
      ...partnerDefinition(),
      id: RUN_ID,
      reportId: REPORT_ID,
      status: 'completed',
      result: { rows: [{ a: 1 }] },
      reportType: 'ar_aging',
      reportName: 'AR aging',
      reportFormat: 'csv',
      ...overrides,
    };
  }

  it('GET /runs/:id 404s a selected-access partner user', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerRun(), partnerRun()];
    const res = await app().request(`/reports/runs/${RUN_ID}`);

    expect(res.status).toBe(404);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('GET /runs/:id reads through the partner axis for a full-access partner admin', async () => {
    state.rows = [partnerRun(), partnerRun()];
    const res = await app().request(`/reports/runs/${RUN_ID}`);

    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'read');
    const detailWhere = params(state.wheres.at(-1));
    expect(detailWhere).toContain(PARTNER_ID);
    expect(detailWhere).toContain('partner_wide');
  });

  it('GET /runs/:id/download 404s a selected-access partner user', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerRun(), partnerRun()];
    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(404);
  });

  it('GET /runs/:id/download serves a full-access partner admin', async () => {
    state.rows = [partnerRun(), partnerRun()];
    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'export');
  });

  it('GET /runs lists partner-owned runs only when partnerOrgAccess is all', async () => {
    state.rows = [{ count: 0 }, null];
    await app().request('/reports/runs');
    expect(params(state.wheres[0])).toContain(PARTNER_ID);

    state.auth = partnerAuth('selected');
    state.wheres = [];
    state.rows = [{ count: 0 }, null];
    await app().request('/reports/runs');
    expect(params(state.wheres[0])).not.toContain(PARTNER_ID);
  });

  it('GET /runs never adds a partner_id predicate for org scope', async () => {
    state.auth = orgAuth();
    state.rows = [{ count: 0 }, null];
    await app().request('/reports/runs');
    expect(params(state.wheres[0])).not.toContain(PARTNER_ID);
    expect(params(state.wheres[0])).not.toContain('partner_wide');
  });

  it('POST /runs/:id/attachments/from-artifact refuses a partner-owned run with 409', async () => {
    state.rows = [partnerRun()];
    const res = await app().request(`/reports/runs/${RUN_ID}/attachments/from-artifact`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ handle: '77777777-7777-4777-8777-777777777777' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'partner_owned_report' });
    expect(state.updates).toHaveLength(0);
  });
});

describe('recipients of a partner-owned definition', () => {
  it('POST /:id/recipients answers 409 partner_owned_report', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/recipients`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ contactId: '88888888-8888-4888-8888-888888888888' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'partner_owned_report' });
    expect(state.inserts).toHaveLength(0);
  });

  it('POST /:id/recipients/convert answers 409 partner_owned_report', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/recipients/convert`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'a@example.com' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'partner_owned_report' });
    expect(state.inserts).toHaveLength(0);
  });

  it('GET /:id/recipients stays readable and empty', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/recipients`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('GET /:id/recipients 404s a selected-access partner user', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/recipients`);

    expect(res.status).toBe(404);
  });
});

describe('GET /reports/templates never lists partner-owned definitions (#3198 W01)', () => {
  it('omits the partner branch even for a full-access partner admin', async () => {
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports/templates');

    expect(res.status).toBe(200);
    const where = dialect.sqlToQuery(state.wheres[0] as SQL);
    expect(where.params).not.toContain(PARTNER_ID);
    expect(where.params).not.toContain('partner_wide');
    expect(where.sql).not.toContain('partner_id');
    expect(where.params).toContain(ORG_ID);
  });

  it('the ordinary list still includes it for the same caller (positive control)', async () => {
    state.rows = [{ count: 0 }, null];
    await app().request('/reports');
    expect(params(state.wheres[0])).toContain(PARTNER_ID);
  });
});

describe('audit records for partner-owned rows carry the partner id (#3198 W01)', () => {
  it('run download audit includes details.partnerId', async () => {
    const { auditSensitiveRead } = await import('../../services/sensitiveReadAudit');
    const run = {
      ...partnerDefinition(), id: RUN_ID, reportId: REPORT_ID, status: 'completed',
      result: { rows: [{ a: 1 }] }, reportType: 'ar_aging', reportName: 'AR aging', reportFormat: 'csv',
    };
    state.rows = [run, run];
    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(200);
    expect(vi.mocked(auditSensitiveRead).mock.calls[0]?.[1]).toMatchObject({
      action: 'report.run.download', orgId: null, partnerId: PARTNER_ID,
    });
  });

  it('reauthorize audit includes details.partnerId', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/reauthorize`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(vi.mocked(writeRouteAudit).mock.calls.at(-1)?.[1]).toMatchObject({
      orgId: null,
      action: 'report.reauthorize',
      details: { partnerId: PARTNER_ID },
    });
  });
});
