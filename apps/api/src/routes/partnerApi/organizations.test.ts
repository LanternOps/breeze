import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = '44444444-4444-4444-8444-444444444444';
const SITE_B = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = new Date('2026-07-10T12:00:00.000Z');
const UPDATED_AT = new Date('2026-07-12T12:00:00.000Z');

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
  accessibleOrgIds: [] as string[],
}));

vi.mock('../../db', () => ({
  db: { select: mocks.select, execute: mocks.execute },
  hasDbAccessContext: () => true,
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerId: PARTNER_ID,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) => {
    const principal = c.get('partnerApiPrincipal');
    return required.every((scope) => principal.scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403);
  },
}));

import { partnerApiRoutes } from './index';
import { organizationExportEnvelopeSchema, siteExportEnvelopeSchema } from './schemas';

type QueryResult = unknown[] | Error;
let results: QueryResult[] = [];

function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return builder;
}

function org(id = ORG_ID, updatedAt = UPDATED_AT) {
  return { id, orgId: id, siteId: null, name: 'Acme', slug: 'acme', type: 'customer', createdAt: CREATED_AT, updatedAt };
}

function site(id: string, name: string) {
  return {
    id, orgId: ORG_ID, siteId: id, name,
    address: { addressLine1: '1 Main St', city: 'Denver', state: 'CO', postalCode: '80202', country: 'US', password: 'drop-me' },
    timezone: 'America/Denver',
    contact: { name: 'NOC', email: 'noc@example.com', phone: '+1-555-0100', authorization: 'drop-me' },
    createdAt: CREATED_AT, updatedAt: UPDATED_AT,
  };
}

function request(path: string, scope: string, apiKey = 'test-key') {
  return app.request(path, { headers: { 'X-API-Key': apiKey, 'X-Test-Scopes': scope } });
}

let app: Hono;

describe('partner organization and site exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    results = [];
    mocks.accessibleOrgIds = [ORG_ID];
    mocks.select.mockImplementation(() => query(results.shift() ?? []));
    mocks.execute.mockResolvedValue([{ snapshotAt: new Date() }]);
    app = new Hono();
    app.route('/partner-api', partnerApiRoutes);
  });

  it.each(['/organizations', '/sites'])('requires machine authentication for %s', async (path) => {
    expect((await request(`/partner-api${path}`, '', 'missing')).status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each([
    ['/organizations', 'sites:read'],
    ['/sites', 'organizations:read'],
  ])('requires the exact scope for %s', async (path, scope) => {
    expect((await request(`/partner-api${path}`, scope)).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each(['/organizations', '/sites'])('rejects invalid filters and cursors for %s', async (path) => {
    const scope = path === '/organizations' ? 'organizations:read' : 'sites:read';
    for (const suffix of ['?orgId=not-a-uuid', '?limit=0', '?updatedSince=yesterday', '?cursor=not-a-cursor']) {
      expect((await request(`/partner-api${path}${suffix}`, scope)).status).toBe(400);
    }
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each(['/organizations', '/sites'])('returns an empty schema-valid envelope for %s', async (path) => {
    results.push([]);
    const scope = path === '/organizations' ? 'organizations:read' : 'sites:read';
    const body = await (await request(`/partner-api${path}`, scope)).json();
    const schema = path === '/organizations' ? organizationExportEnvelopeSchema : siteExportEnvelopeSchema;
    expect(schema.parse(body)).toMatchObject({ schemaVersion: '1', data: [], hasMore: false, nextCursor: null });
  });

  it.each([
    ['/organizations', 'organizations:read'],
    ['/sites', 'sites:read'],
  ])('takes shared organization watermark locks before selecting %s', async (path, scope) => {
    results.push([]);
    expect((await request(`/partner-api${path}`, scope)).status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['/organizations', 'organizations:read'],
    ['/sites', 'sites:read'],
  ])('uses the database snapshot and rejects future updatedSince for empty %s traversal', async (path, scope) => {
    mocks.accessibleOrgIds = [];
    mocks.execute.mockResolvedValueOnce([{ snapshotAt: new Date('2026-07-14T12:00:00.000Z') }]);
    const response = await request(
      `/partner-api${path}?updatedSince=${encodeURIComponent('2026-07-14T12:00:00.001Z')}`,
      scope,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_partner_export_pagination' });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('exports only narrow organization mapping fields', async () => {
    results.push([{ ...org(), settings: { token: 'never' }, billingContact: { email: 'billing@example.com' } }]);
    const res = await request('/partner-api/organizations', 'organizations:read');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(organizationExportEnvelopeSchema.parse(body).data[0]).toMatchObject({
      id: ORG_ID, orgId: ORG_ID, siteId: null, name: 'Acme', slug: 'acme', type: 'customer',
    });
    expect(body.data[0]).not.toHaveProperty('settings');
    expect(body.data[0]).not.toHaveProperty('billingContact');
  });

  it('exports sites with normalized durable address/contact fields only', async () => {
    results.push([site(SITE_A, 'HQ')]);
    const body = await (await request('/partner-api/sites', 'sites:read')).json();
    const record = siteExportEnvelopeSchema.parse(body).data[0];
    expect(record).toMatchObject({
      id: SITE_A, orgId: ORG_ID, siteId: SITE_A, name: 'HQ', timezone: 'America/Denver',
      address: { line1: '1 Main St', city: 'Denver', region: 'CO', postalCode: '80202', country: 'US' },
      contact: { name: 'NOC', email: 'noc@example.com', phone: '+1-555-0100' },
    });
    expect(JSON.stringify(record)).not.toMatch(/password|authorization|drop-me/);
  });

  it('walks multiple pages while preserving snapshotAt', async () => {
    results.push([site(SITE_A, 'HQ'), site(SITE_B, 'Branch')]);
    const first = await (await request('/partner-api/sites?limit=1', 'sites:read')).json();
    expect(first).toMatchObject({ hasMore: true });
    expect(first.nextCursor).toEqual(expect.any(String));

    results.push([site(SITE_B, 'Branch')]);
    const second = await (await request(`/partner-api/sites?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, 'sites:read')).json();
    expect(second).toMatchObject({ hasMore: false, nextCursor: null, snapshotAt: first.snapshotAt });
    expect(second.data.map((row: any) => row.id)).toEqual([SITE_B]);
  });

  it('rejects a signed cursor when the organization filter is switched', async () => {
    results.push([site(SITE_A, 'HQ'), site(SITE_B, 'Branch')]);
    const first = await (await request(`/partner-api/sites?orgId=${ORG_ID}&limit=1`, 'sites:read')).json();
    expect(first.nextCursor).toEqual(expect.any(String));

    const switched = await request(
      `/partner-api/sites?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      'sites:read',
    );
    expect(switched.status).toBe(400);
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it('walks organization pages with the same stable snapshotAt', async () => {
    results.push([org(ORG_ID), org(OTHER_ORG_ID)]);
    const first = await (await request('/partner-api/organizations?limit=1', 'organizations:read')).json();
    expect(first).toMatchObject({ hasMore: true });
    results.push([org(OTHER_ORG_ID)]);
    const second = await (await request(
      `/partner-api/organizations?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      'organizations:read',
    )).json();
    expect(second).toMatchObject({ hasMore: false, snapshotAt: first.snapshotAt });
  });

  it('supports updatedSince and returns a stable incremental cursor', async () => {
    results.push([org()]);
    const since = '2026-07-11T12:00:00.000Z';
    const body = await (await request(`/partner-api/organizations?updatedSince=${encodeURIComponent(since)}`, 'organizations:read')).json();
    expect(organizationExportEnvelopeSchema.parse(body).data).toHaveLength(1);
    expect(body.snapshotAt).toEqual(expect.any(String));
  });

  it('supports updatedSince for sites', async () => {
    results.push([site(SITE_A, 'HQ')]);
    const since = '2026-07-11T12:00:00.000Z';
    const body = await (await request(`/partner-api/sites?updatedSince=${encodeURIComponent(since)}`, 'sites:read')).json();
    expect(siteExportEnvelopeSchema.parse(body).data).toHaveLength(1);
  });

  it.each([
    ['/organizations', 'organizations:read', OTHER_ORG_ID],
    ['/organizations', 'organizations:read', '66666666-6666-4666-8666-666666666666'],
    ['/sites', 'sites:read', OTHER_ORG_ID],
    ['/sites', 'sites:read', '66666666-6666-4666-8666-666666666666'],
  ])('fails closed for inaccessible or nonexistent org filter on %s', async (path, scope, orgId) => {
    expect((await request(`/partner-api${path}?orgId=${orgId}`, scope)).status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns a bounded server error when a query fails', async () => {
    results.push(new Error('postgresql://user:secret@internal-host/private'));
    const res = await request('/partner-api/organizations', 'organizations:read');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/secret|internal-host/);
  });

  it('returns the same bounded failure contract for a site query failure', async () => {
    results.push(new Error('private site query details'));
    const res = await request('/partner-api/sites', 'sites:read');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('private site query details');
  });
});
