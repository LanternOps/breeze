import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '44444444-4444-4444-8444-444444444444';

const state = vi.hoisted(() => ({
  auth: null as unknown,
  permissions: null as unknown,
  mfaSatisfied: true,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => { c.set('auth', state.auth); await next(); },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  // Enforces the (resource, action) each route asks for against state.permissions,
  // so a wrong or dropped permission changes the outcome.
  requirePermission: (resource: string, action: string) => async (c: any, next: () => Promise<void>) => {
    const granted = (state.permissions as { permissions: { resource: string; action: string }[] }).permissions;
    const ok = granted.some((p) => (p.resource === '*' || p.resource === resource) && (p.action === '*' || p.action === action));
    if (!ok) return c.json({ error: 'Permission denied' }, 403);
    c.set('permissions', state.permissions);
    await next();
  },
  hasSatisfiedMfa: () => state.mfaSatisfied,
}));
vi.mock('../../db', () => ({ db: { transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn('tx')) } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

const store = vi.hoisted(() => ({
  createSeries: vi.fn(),
  updateSeries: vi.fn(),
  replaceSeriesTargets: vi.fn(),
  transferSeriesOwner: vi.fn(),
  deleteSeries: vi.fn(),
  listSeries: vi.fn(),
  getSeriesDetail: vi.fn(),
  loadOwnSeries: vi.fn(),
  previewSeriesRecipients: vi.fn(),
  previewSavedSeriesRecipients: vi.fn(),
}));
vi.mock('../../services/reportSeries/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportSeries/store')>();
  return { ...actual, ...store };
});

import { reportSeriesRoutes } from './series';
import { writeRouteAudit } from '../../services/auditEvents';
import { SeriesAuthorityUnverifiableError } from '../../services/reportSeries/authority';
import { ReportSeriesError, seriesNotFound } from '../../services/reportSeries/errors';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const ALL = { permissions: [{ resource: '*', action: '*' }] };
const seriesRow = { id: SERIES_ID, partnerId: PARTNER_ID, name: 'Monthly summary', type: 'executive_summary', targetMode: 'all', revision: 1 };
const detail = { series: seriesRow, targets: [], orgs: [] };
const reconcile = { created: 1, updated: 0, archived: 0, unarchived: 0, blocked: [] };

function app() {
  const hono = new Hono();
  hono.route('/reports/series', reportSeriesRoutes);
  return hono;
}
function partnerAuth(partnerOrgAccess: 'all' | 'selected' = 'all') {
  return {
    user: { id: USER_ID, email: 'tech@example.com' }, scope: 'partner', orgId: null, partnerId: PARTNER_ID,
    partnerOrgAccess, accessibleOrgIds: [ORG_ID], canAccessOrg: (id: string) => id === ORG_ID, token: { mfa: true },
  };
}
function orgAuth() {
  return { ...partnerAuth(), scope: 'organization', orgId: ORG_ID, partnerOrgAccess: null };
}
const createBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  name: 'Monthly summary', type: 'executive_summary', schedule: 'monthly', ...overrides,
});
const post = (path: string, body: string) => app().request(path, { method: 'POST', headers: JSON_HEADERS, body });

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = partnerAuth();
  state.permissions = ALL;
  state.mfaSatisfied = true;
  store.createSeries.mockResolvedValue({ series: seriesRow, reconcile });
  store.updateSeries.mockResolvedValue({ series: { ...seriesRow, revision: 2 }, reconcile });
  store.replaceSeriesTargets.mockResolvedValue({ series: seriesRow, reconcile });
  store.transferSeriesOwner.mockResolvedValue({ series: seriesRow, previousOwnerUserId: USER_ID, reconcile });
  store.deleteSeries.mockResolvedValue({ series: seriesRow, archivedChildren: 3 });
  store.listSeries.mockResolvedValue([detail]);
  store.getSeriesDetail.mockResolvedValue(detail);
  store.loadOwnSeries.mockResolvedValue(seriesRow);
});

const SERIES_BODY = { name: 'x', type: 'executive_summary', schedule: 'monthly' };
const ROUTES: { name: string; method: string; path: string; body?: unknown; perm: [string, string] }[] = [
  { name: 'GET /', method: 'GET', path: '/reports/series', perm: ['reports', 'read'] },
  { name: 'POST /recipients/preview', method: 'POST', path: '/reports/series/recipients/preview', perm: ['reports', 'read'],
    body: { targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] } } },
  { name: 'POST /', method: 'POST', path: '/reports/series', perm: ['reports', 'write'], body: SERIES_BODY },
  { name: 'GET /:id', method: 'GET', path: `/reports/series/${SERIES_ID}`, perm: ['reports', 'read'] },
  { name: 'GET /:id/recipients/preview', method: 'GET', path: `/reports/series/${SERIES_ID}/recipients/preview`, perm: ['reports', 'read'] },
  { name: 'PATCH /:id', method: 'PATCH', path: `/reports/series/${SERIES_ID}`, perm: ['reports', 'write'], body: { name: 'y' } },
  { name: 'PUT /:id/targets', method: 'PUT', path: `/reports/series/${SERIES_ID}/targets`, perm: ['reports', 'write'], body: { targetMode: 'all', orgIds: [] } },
  { name: 'POST /:id/transfer-owner', method: 'POST', path: `/reports/series/${SERIES_ID}/transfer-owner`, perm: ['reports', 'write'],
    body: { ownerUserId: '66666666-6666-4666-8666-666666666666' } },
  { name: 'DELETE /:id', method: 'DELETE', path: `/reports/series/${SERIES_ID}`, perm: ['reports', 'delete'] },
];
const call = (r: (typeof ROUTES)[number]) => app().request(r.path, {
  method: r.method, headers: JSON_HEADERS, ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
});
const allStores = () => Object.values(store);

describe.each(ROUTES)('$name gates', (r) => {
  beforeEach(() => {
    store.previewSeriesRecipients.mockResolvedValue({});
    store.previewSavedSeriesRecipients.mockResolvedValue({});
  });

  it(`needs exactly ${r.perm.join(':')}: granted alone it passes, any other reports permission alone is 403 and never reaches the store`, async () => {
    state.permissions = { permissions: [{ resource: r.perm[0], action: r.perm[1] }] };
    expect((await call(r)).status).toBeLessThan(400);
    vi.clearAllMocks();
    for (const action of ['read', 'write', 'delete', 'export'].filter((a) => a !== r.perm[1])) {
      state.permissions = { permissions: [{ resource: 'reports', action }] };
      expect((await call(r)).status).toBe(403);
    }
    expect(allStores().every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it.each([['organization token', orgAuth()], ["'selected' partner user", partnerAuth('selected')]])(
    'refuses a %s with 403 series_write_denied before the store',
    async (_label, auth) => {
      state.auth = auth;
      const res = await call(r);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'series_write_denied' });
      expect(allStores().every((fn) => fn.mock.calls.length === 0)).toBe(true);
    },
  );
});

describe('mayAddDelivery on PATCH and PUT targets', () => {
  const patchCall = () => app().request(`/reports/series/${SERIES_ID}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: 'y' }) });
  const putCall = () => app().request(`/reports/series/${SERIES_ID}/targets`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ targetMode: 'all', orgIds: [] }),
  });
  const lastOptions = (fn: typeof store.updateSeries) => fn.mock.calls.at(-1)![4] ?? fn.mock.calls.at(-1)![3];

  it.each([
    ['PATCH', patchCall, store.updateSeries],
    ['PUT targets', putCall, store.replaceSeriesTargets],
  ])('%s: true only with reports:export AND MFA', async (_n, fire, fn) => {
    await fire();
    expect(lastOptions(fn)).toEqual({ mayAddDelivery: true });
    state.mfaSatisfied = false;
    await fire();
    expect(lastOptions(fn)).toEqual({ mayAddDelivery: false });
    state.mfaSatisfied = true;
    state.permissions = { permissions: [{ resource: 'reports', action: 'write' }] };
    await fire();
    expect(lastOptions(fn)).toEqual({ mayAddDelivery: false });
  });
});

describe('inaccessible target orgs never reach the store', () => {
  it('PUT /:id/targets', async () => {
    const res = await app().request(`/reports/series/${SERIES_ID}/targets`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ targetMode: 'selected', orgIds: [FOREIGN_ORG_ID] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_target_org_inaccessible', orgIds: [FOREIGN_ORG_ID] });
    expect(store.replaceSeriesTargets).not.toHaveBeenCalled();
  });

  it('POST /recipients/preview', async () => {
    const res = await post('/reports/series/recipients/preview', JSON.stringify({
      targetMode: 'selected', orgIds: [FOREIGN_ORG_ID], recipientRule: { primaryContact: true, roles: [] },
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_target_org_inaccessible', orgIds: [FOREIGN_ORG_ID] });
    expect(store.previewSeriesRecipients).not.toHaveBeenCalled();
  });
});

describe('audit entries', () => {
  it('update, targets.replace and delete audit with orgId null and the partner id', async () => {
    await app().request(`/reports/series/${SERIES_ID}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: 'y' }) });
    await app().request(`/reports/series/${SERIES_ID}/targets`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ targetMode: 'selected', orgIds: [ORG_ID] }),
    });
    await app().request(`/reports/series/${SERIES_ID}`, { method: 'DELETE' });
    const audits = vi.mocked(writeRouteAudit).mock.calls.map(([, e]) => e as Record<string, any>);
    const by = (a: string) => audits.find((e) => e.action === a)!;
    expect(by('report_series.update')).toMatchObject({ orgId: null, resourceType: 'report_series', resourceId: SERIES_ID,
      details: { partnerId: PARTNER_ID, changedFields: ['name'], reconcile } });
    expect(by('report_series.targets.replace')).toMatchObject({ orgId: null, resourceId: SERIES_ID,
      details: { partnerId: PARTNER_ID, targetMode: 'selected', orgCount: 1, reconcile } });
    expect(by('report_series.delete')).toMatchObject({ orgId: null, resourceId: SERIES_ID,
      details: { partnerId: PARTNER_ID, archivedChildren: 3 } });
  });
});

describe('POST /reports/series', () => {
  it('rejects a one_time schedule (series are recurring-only) with a standard 400', async () => {
    const res = await post('/reports/series', createBody({ schedule: 'one_time' }));
    expect(res.status).toBe(400);
    expect(store.createSeries).not.toHaveBeenCalled();
  });

  it('rejects a business type with series_type_unsupported', async () => {
    const res = await post('/reports/series', createBody({ type: 'ar_aging' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'series_type_unsupported', type: 'ar_aging' });
  });

  it('rejects an org-specific config with series_config_org_specific naming the key', async () => {
    const res = await post('/reports/series', createBody({ config: { filters: { siteIds: [ORG_ID] } } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_config_org_specific', key: 'filters.siteIds' });
  });

  it('refuses config.emailRecipients (internalCc is its one home)', async () => {
    const res = await post('/reports/series', createBody({ config: { emailRecipients: ['a@b.test'] } }));
    expect(res.status).toBe(400);
    expect(store.createSeries).not.toHaveBeenCalled();
  });

  it("refuses 'selected' with no orgs, and a body that names a partner", async () => {
    expect((await post('/reports/series', createBody({ targetMode: 'selected', orgIds: [] }))).status).toBe(400);
    expect((await post('/reports/series', createBody({ partnerId: PARTNER_ID }))).status).toBe(400);
    expect(store.createSeries).not.toHaveBeenCalled();
  });

  it('refuses a target org the caller cannot access', async () => {
    const res = await post('/reports/series', createBody({ targetMode: 'selected', orgIds: [FOREIGN_ORG_ID] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_target_org_inaccessible', orgIds: [FOREIGN_ORG_ID] });
  });

  it('creates: owner defaults to the caller, the delivery capability is server-derived, the answer is a SeriesDetail', async () => {
    const res = await post('/reports/series', createBody({ internalCc: ['noc@msp.test'] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(detail);
    const [input, auth, tx, options] = store.createSeries.mock.calls[0]!;
    expect(input).toMatchObject({ ownerUserId: USER_ID, targetMode: 'all', recipientRule: { primaryContact: true, roles: [] }, internalCc: ['noc@msp.test'] });
    expect((auth as { partnerId: string }).partnerId).toBe(PARTNER_ID);
    expect(tx).toBe('tx');
    expect(options).toEqual({ mayAddDelivery: true });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, action: 'report_series.create', resourceType: 'report_series', resourceId: SERIES_ID,
      details: expect.objectContaining({ partnerId: PARTNER_ID, reconcile }),
    }));
  });

  it('passes mayAddDelivery=false without MFA or without reports:export (the store decides if it matters)', async () => {
    state.mfaSatisfied = false;
    await post('/reports/series', createBody());
    expect(store.createSeries.mock.calls[0]![3]).toEqual({ mayAddDelivery: false });
    state.mfaSatisfied = true;
    state.permissions = { permissions: [{ resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' }] };
    await post('/reports/series', createBody());
    expect(store.createSeries.mock.calls[1]![3]).toEqual({ mayAddDelivery: false });
  });

  it('maps ReportSeriesError from the store (owner ineligible → 400 with its reason)', async () => {
    store.createSeries.mockRejectedValue(new ReportSeriesError('series_owner_ineligible', 400, { reason: 'partner_access_not_all' }));
    const res = await post('/reports/series', createBody());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_owner_ineligible', reason: 'partner_access_not_all' });
  });
});

describe('authority failures', () => {
  it('maps a transient authority lookup failure to 503 series_authority_unverifiable', async () => {
    store.createSeries.mockRejectedValue(new SeriesAuthorityUnverifiableError());
    const res = await post('/reports/series', createBody());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'series_authority_unverifiable' });
  });
});

describe('PATCH /reports/series/:id', () => {
  const patch = (body: Record<string, unknown>) =>
    app().request(`/reports/series/${SERIES_ID}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });

  it('refuses fields that are not shared definition fields (strict)', async () => {
    for (const body of [{ partnerId: PARTNER_ID }, { targetMode: 'selected' }, { type: 'compliance' }, { ownerUserId: USER_ID }]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(store.updateSeries).not.toHaveBeenCalled();
  });

  it('refuses a one_time schedule', async () => {
    expect((await patch({ schedule: 'one_time' })).status).toBe(400);
  });

  it('parses config against the STORED type and the series rules', async () => {
    const res = await patch({ config: { filters: { deviceIds: [ORG_ID] } } });
    expect(store.loadOwnSeries).toHaveBeenCalledWith(SERIES_ID, expect.anything());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_config_org_specific', key: 'filters.deviceIds' });
  });

  it('answers 404 series_not_found from the store', async () => {
    store.updateSeries.mockRejectedValue(seriesNotFound());
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'series_not_found' });
  });

  it('updates and answers the fresh SeriesDetail', async () => {
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(store.updateSeries.mock.calls[0]![1]).toEqual({ name: 'Renamed' });
  });
});

describe('other series routes', () => {
  it('GET / answers { data: SeriesDetail[] }', async () => {
    const res = await app().request('/reports/series');
    expect(await res.json()).toEqual({ data: [detail] });
  });

  it('GET /:id rejects a non-uuid id before the store', async () => {
    expect((await app().request('/reports/series/not-a-uuid')).status).toBe(400);
    expect(store.getSeriesDetail).not.toHaveBeenCalled();
  });

  it('PUT /:id/targets validates accessibility and answers the SeriesDetail', async () => {
    const res = await app().request(`/reports/series/${SERIES_ID}/targets`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ targetMode: 'selected', orgIds: [ORG_ID] }),
    });
    expect(res.status).toBe(200);
    expect(store.replaceSeriesTargets.mock.calls[0]![1]).toEqual({ targetMode: 'selected', orgIds: [ORG_ID] });
  });

  it('POST /:id/transfer-owner answers the SeriesDetail and audits both owners', async () => {
    const next = '66666666-6666-4666-8666-666666666666';
    const res = await post(`/reports/series/${SERIES_ID}/transfer-owner`, JSON.stringify({ ownerUserId: next }));
    expect(res.status).toBe(200);
    expect(store.transferSeriesOwner.mock.calls[0]![1]).toBe(next);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'report_series.owner.transfer',
      details: expect.objectContaining({ previousOwnerUserId: USER_ID, ownerUserId: next }),
    }));
  });

  it('DELETE /:id answers { success, archivedChildren }', async () => {
    const res = await app().request(`/reports/series/${SERIES_ID}`, { method: 'DELETE' });
    expect(await res.json()).toEqual({ success: true, archivedChildren: 3 });
  });

  it('POST /recipients/preview passes the unsaved form with seriesId null', async () => {
    store.previewSeriesRecipients.mockResolvedValue({ totalCustomerRecipients: 1, orgCount: 1, orgsWithoutCustomerRecipient: [] });
    const res = await post('/reports/series/recipients/preview', JSON.stringify({
      targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: ['billing'] },
    }));
    expect(res.status).toBe(200);
    expect(store.previewSeriesRecipients.mock.calls[0]![0]).toMatchObject({ seriesId: null, internalCc: [] });
  });
});

describe('mount order', () => {
  it('routes/reports/index.ts mounts /series before the core /:id routes', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src.indexOf("route('/series', reportSeriesRoutes)")).toBeGreaterThan(-1);
    expect(src.indexOf("route('/series', reportSeriesRoutes)")).toBeLessThan(src.indexOf("route('/', coreRoutes)"));
  });
});
