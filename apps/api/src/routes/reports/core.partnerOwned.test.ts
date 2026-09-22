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
 *  - Generating one answers 400 unsupported_report_scope this wave.
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

const state = vi.hoisted(() => ({
  auth: null as unknown,
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
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
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
    chain.returning = vi.fn(async () => [{ id: REPORT_ID, name: 'x', ...entry.set }]);
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
import { generateReport } from '../../services/reportGenerationService';
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

  it('400s a type not in PARTNER_SCOPE_REPORT_TYPES', async () => {
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
      body: JSON.stringify({ ...body, partnerId: OTHER_PARTNER_ID, orgId: ORG_ID }),
    });

    expect(res.status).toBe(201);
    expect(state.inserts[0]!.values.partnerId).toBe(PARTNER_ID);
    expect(state.inserts[0]!.values.orgId).toBeNull();
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'write');
  });

  it('403s when the live partner authority is refused', async () => {
    state.partnerAuthority = { ok: false, reason: 'partner_access_not_all' };
    const res = await app().request('/reports', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Report scope is not authorized', reason: 'partner_access_not_all' });
    expect(state.inserts).toHaveLength(0);
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

  it('403s a selected-access partner user even though RLS would show the row', async () => {
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

describe('DELETE /reports/:id on a partner-owned definition', () => {
  it('403s a selected-access partner user', async () => {
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
  it('400s unsupported_report_scope and creates no run', async () => {
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_report_scope', type: 'ar_aging' });
    expect(state.inserts).toHaveLength(0);
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('404s a selected-access partner user', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [partnerDefinition(), partnerDefinition()];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
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

  it('400s unsupported_report_scope for a full-access partner admin', async () => {
    const res = await app().request('/reports/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ownerScope: 'partner', type: 'ar_aging' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_report_scope', type: 'ar_aging' });
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
