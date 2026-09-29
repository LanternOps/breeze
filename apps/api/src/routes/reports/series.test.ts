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
  requirePermission: () => async (c: any, next: () => Promise<void>) => { c.set('permissions', state.permissions); await next(); },
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

describe('series write gate (partner scope + org_access=all)', () => {
  it.each([['organization token', orgAuth()], ["'selected' partner user", partnerAuth('selected')]])(
    'refuses a %s with 403 series_write_denied and never reaches the store',
    async (_label, auth) => {
      state.auth = auth;
      const list = await app().request('/reports/series');
      expect(list.status).toBe(403);
      expect(await list.json()).toMatchObject({ error: 'series_write_denied' });
      const create = await post('/reports/series', createBody());
      expect(create.status).toBe(403);
      expect(store.listSeries).not.toHaveBeenCalled();
      expect(store.createSeries).not.toHaveBeenCalled();
    },
  );
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
