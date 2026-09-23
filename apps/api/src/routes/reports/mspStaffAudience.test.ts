/**
 * #3198 W02, ruling F1 — the three business report types (audience
 * 'msp_staff') are internal to the MSP (spec §2). An ORGANIZATION-scope caller
 * (customer user, org API/MCP key) never creates, generates, or sees one:
 *
 *  - create / ad-hoc generate → 403 `Insufficient permissions` (the P8 body);
 *  - every by-id read or mutation → the row is hidden: the tenant predicate
 *    carries `reports.type NOT IN (<msp_staff types>)`, and if that predicate
 *    ever regressed the loaders refuse the row anyway (defense in depth);
 *  - every list → the same NOT IN predicate.
 *
 * Partner-scope callers (positive controls) are unaffected. The mocked db
 * returns whatever row is queued regardless of the WHERE, so each "hidden"
 * case asserts BOTH the predicate text and the belt-level refusal.
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
import {
  generateReport,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
} from '../../services/reportGenerationService';
import { ReportScopeMismatchError, reportScopeFromAuthority } from '../../services/reportScope';
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

/**
 * Params bound to the `reports.org_id IN (…)` org arm specifically. A bare
 * `params(where)` contains ORG_ID through the run-scope predicate too
 * (`reports.org_id = $n AND <envelope>`), so it cannot tell whether the org
 * arm survived (#3198 W02 B2 — proven by dropping the arm: bare toContain
 * stayed green).
 */
function orgArmParams(where: unknown): unknown[] {
  const { sql: text, params: bound } = dialect.sqlToQuery(where as SQL);
  const arm = /"reports"\."org_id" in \(([^)]*)\)/.exec(text);
  if (!arm) return [];
  return arm[1]!.split(',').map((p) => bound[Number(p.trim().slice(1)) - 1]);
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

function orgDefinition(type: string, overrides: Record<string, unknown> = {}) {
  return partnerDefinition({
    type,
    orgId: ORG_ID,
    partnerId: null,
    executionScopeKind: 'unrestricted',
    executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: ORG_ID }),
    ...overrides,
  });
}

function orgRun(type: string) {
  return {
    ...orgDefinition(type),
    id: RUN_ID,
    reportId: REPORT_ID,
    status: 'completed',
    result: { rows: [{ a: 1 }] },
    reportType: type,
    reportName: 'x',
    reportFormat: 'csv',
  };
}

const BUSINESS = ['ar_aging', 'technician_time_billability', 'ticket_sla_attainment'] as const;

/** True when `where` carries `reports.type NOT IN (…)` binding every business type. */
function excludesBusinessTypes(where: unknown): boolean {
  const { sql: text, params: bound } = dialect.sqlToQuery(where as SQL);
  const arm = /"reports"\."type" not in \(([^)]*)\)/.exec(text);
  if (!arm) return false;
  const values = arm[1]!.split(',').map((p) => bound[Number(p.trim().slice(1)) - 1]);
  return BUSINESS.every((t) => values.includes(t));
}

const DENIED = { error: 'Insufficient permissions' };

describe('writes and generates refuse msp_staff types to an org-scope caller (403)', () => {
  beforeEach(() => { state.auth = orgAuth(); });

  it.each(BUSINESS)('POST /reports %s → 403, no insert, no authority lookup', async (type) => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'x', type, schedule: 'monthly', format: 'pdf' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
    expect(state.inserts).toHaveLength(0);
  });

  it('positive control: the org caller may still create a device_inventory report', async () => {
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'x', type: 'device_inventory', schedule: 'monthly', format: 'pdf' }),
    });
    expect(res.status).toBe(201);
  });

  it('positive control: a partner caller may create an org-owned ar_aging report', async () => {
    state.auth = partnerAuth('selected');
    const res = await app().request('/reports', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'x', type: 'ar_aging', orgId: ORG_ID, schedule: 'monthly', format: 'pdf' }),
    });
    expect(res.status).toBe(201);
  });

  it.each(BUSINESS)('POST /reports/generate %s → 403 before any generation', async (type) => {
    const res = await app().request('/reports/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ type, format: 'csv' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('positive control: a partner caller may run ar_aging ad hoc for one of its orgs', async () => {
    state.auth = partnerAuth('selected');
    const res = await app().request('/reports/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ type: 'ar_aging', orgId: ORG_ID, format: 'csv' }),
    });
    expect(res.status).toBe(200);
    expect(generateReport).toHaveBeenCalled();
  });
});

describe('by-id mutations hide msp_staff rows from an org-scope caller', () => {
  beforeEach(() => { state.auth = orgAuth(); });

  it('PUT: the metadata read excludes business types; a leaked row still 403s, no update', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'renamed' }),
    });
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
    expect(state.updates).toHaveLength(0);
  });

  it('POST /:id/reauthorize: excluded by the metadata read; a leaked row still 403s, no update', async () => {
    state.rows = [orgDefinition('technician_time_billability'), orgDefinition('technician_time_billability')];
    const res = await app().request(`/reports/${REPORT_ID}/reauthorize`, { method: 'POST' });
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
    expect(res.status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it('DELETE: excluded by the metadata read; a leaked row still 403s, nothing deleted', async () => {
    state.rows = [orgDefinition('ticket_sla_attainment'), orgDefinition('ticket_sla_attainment')];
    const res = await app().request(`/reports/${REPORT_ID}`, { method: 'DELETE' });
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
    expect(res.status).toBe(403);
    expect(state.deletes).toHaveLength(0);
  });

  it('POST /:id/generate: excluded by the loader; a leaked row answers 404, no run row', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
    expect(generateReport).not.toHaveBeenCalled();
  });

  it.each(['/recipients', '/recipients/convert'])('POST /:id%s answers 404 on a leaked row', async (path) => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}${path}`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ contactId: '77777777-7777-4777-8777-777777777777', email: 'a@example.com' }),
    });
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
  });

  it('positive control: PUT on a device_inventory row still updates, and the same predicate is present', async () => {
    state.rows = [orgDefinition('device_inventory'), orgDefinition('device_inventory')];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });
});

describe('reads hide msp_staff rows from an org-scope caller', () => {
  beforeEach(() => { state.auth = orgAuth(); });

  it('GET /reports lists with the exclusion', async () => {
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports');
    expect(res.status).toBe(200);
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
  });

  it('GET /reports/templates lists with the exclusion', async () => {
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports/templates');
    expect(res.status).toBe(200);
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
  });

  it('GET /reports/:id: excluded by the metadata read; a leaked row answers 404', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}`);
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
    expect(res.status).toBe(404);
  });

  it('GET /reports/:id/recipients answers 404 on a leaked row', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}/recipients`);
    expect(res.status).toBe(404);
  });

  it('GET /reports/runs lists with the exclusion', async () => {
    state.rows = [{ count: 0 }, null];
    const res = await app().request('/reports/runs');
    expect(res.status).toBe(200);
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
  });

  it.each(['', '/download'])('GET /reports/runs/:id%s: excluded; a leaked run answers 404', async (suffix) => {
    state.rows = [orgRun('ar_aging'), orgRun('ar_aging')];
    const res = await app().request(`/reports/runs/${RUN_ID}${suffix}`);
    expect(excludesBusinessTypes(state.wheres[0])).toBe(true);
    expect(res.status).toBe(404);
  });

  it('positive control: GET /reports/runs/:id serves an org device_inventory run', async () => {
    state.rows = [orgRun('device_inventory'), orgRun('device_inventory')];
    const res = await app().request(`/reports/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
  });
});

describe('partner and system callers get no audience predicate', () => {
  it.each([
    ['partner (selected)', () => partnerAuth('selected')],
    ['partner (all)', () => partnerAuth('all')],
  ])('%s: GET /reports, /reports/runs carry no business-type exclusion', async (_label, make) => {
    state.auth = make();
    state.rows = [{ count: 0 }, null];
    await app().request('/reports');
    expect(excludesBusinessTypes(state.wheres[0])).toBe(false);
    state.wheres = [];
    state.rows = [{ count: 0 }, null];
    await app().request('/reports/runs');
    expect(excludesBusinessTypes(state.wheres[0])).toBe(false);
  });

  it('a partner caller reads an org-owned ar_aging run (positive control)', async () => {
    state.auth = partnerAuth('selected');
    state.rows = [orgRun('ar_aging'), orgRun('ar_aging')];
    const res = await app().request(`/reports/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
  });
});

/** Every type bound in any `reports.type NOT IN (…)` arm of `where`. */
function notInTypes(where: unknown): string[] {
  const { sql: text, params: bound } = dialect.sqlToQuery(where as SQL);
  const out: string[] = [];
  for (const arm of text.matchAll(/"reports"\."type" not in \(([^)]*)\)/g)) {
    for (const p of arm[1]!.split(',')) out.push(String(bound[Number(p.trim().slice(1)) - 1]));
  }
  return out;
}

/**
 * Ruling P8b (#3198 W02 fix round) — the per-type permission gate (P8)
 * extends to READS, on every scope. A partner user holding reports:* but not
 * invoices:read never sees an ar_aging definition or run: by-id reads and
 * by-id writes answer 404 (the row is hidden, not refused — same as F1's
 * org-scope reads), and both lists exclude the type. The mocked db returns the
 * queued row regardless of WHERE, so each case asserts BOTH the SQL filter
 * and the loader's belt-level refusal.
 */
describe('ruling P8b: a caller lacking a business type\'s read permission never sees it', () => {
  beforeEach(() => {
    state.auth = partnerAuth('selected');
    state.permissions = { permissions: NO_INVOICES_PERMISSIONS };
  });

  it('GET /reports/:id → 404; the metadata read excludes ar_aging only', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging'), null];
    const res = await app().request(`/reports/${REPORT_ID}`);
    expect(notInTypes(state.wheres[0])).toEqual(['ar_aging']);
    expect(res.status).toBe(404);
  });

  it('GET /reports/:id/recipients → 404', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}/recipients`);
    expect(notInTypes(state.wheres[0])).toEqual(['ar_aging']);
    expect(res.status).toBe(404);
  });

  it.each(['', '/download'])('GET /reports/runs/:id%s → 404', async (suffix) => {
    state.rows = [orgRun('ar_aging'), orgRun('ar_aging')];
    const res = await app().request(`/reports/runs/${RUN_ID}${suffix}`);
    expect(notInTypes(state.wheres[0])).toEqual(['ar_aging']);
    expect(res.status).toBe(404);
  });

  it('DELETE /reports/:id → 404, nothing deleted', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}`, { method: 'DELETE' });
    expect(notInTypes(state.wheres[0])).toEqual(['ar_aging']);
    expect(res.status).toBe(404);
    expect(state.deletes).toHaveLength(0);
  });

  it('PUT /reports/:id → 404 (hidden, not 403), no update', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it('POST /reports/:id/generate → 404, no run row', async () => {
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging')];
    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
    expect(generateReport).not.toHaveBeenCalled();
  });

  it.each(['/reports', '/reports/templates', '/reports/runs'])('GET %s excludes ar_aging only', async (path) => {
    state.rows = [{ count: 0 }, null];
    const res = await app().request(path);
    expect(res.status).toBe(200);
    expect(notInTypes(state.wheres[0])).toEqual(['ar_aging']);
  });

  it('partner (all) and system callers are filtered too', async () => {
    for (const auth of [partnerAuth('all'), { ...partnerAuth('all'), scope: 'system', partnerId: null }]) {
      state.auth = auth;
      state.wheres = [];
      state.rows = [{ count: 0 }, null];
      await app().request('/reports');
      expect(notInTypes(state.wheres[0])).toEqual(['ar_aging']);
      state.wheres = [];
      state.rows = [{ count: 0 }, null];
      await app().request('/reports/runs');
      expect(notInTypes(state.wheres[0])).toEqual(['ar_aging']);
    }
  });

  it('positive control: holding invoices:read, the same definition and run are served, lists unfiltered', async () => {
    state.permissions = { permissions: ALL_PERMISSIONS };
    state.rows = [orgDefinition('ar_aging'), orgDefinition('ar_aging'), null];
    expect((await app().request(`/reports/${REPORT_ID}`)).status).toBe(200);
    state.rows = [orgRun('ar_aging'), orgRun('ar_aging')];
    expect((await app().request(`/reports/runs/${RUN_ID}`)).status).toBe(200);
    state.wheres = [];
    state.rows = [{ count: 0 }, null];
    await app().request('/reports');
    expect(notInTypes(state.wheres[0])).toEqual([]);
  });

  it('positive control: a legacy type is served without invoices:read', async () => {
    state.rows = [orgDefinition('device_inventory'), orgDefinition('device_inventory'), null];
    expect((await app().request(`/reports/${REPORT_ID}`)).status).toBe(200);
    state.rows = [orgRun('device_inventory'), orgRun('device_inventory')];
    expect((await app().request(`/reports/runs/${RUN_ID}`)).status).toBe(200);
  });

  it('SLA types stay visible to a caller holding tickets + time_entries read', async () => {
    state.rows = [orgRun('technician_time_billability'), orgRun('technician_time_billability')];
    expect((await app().request(`/reports/runs/${RUN_ID}`)).status).toBe(200);
  });
});
