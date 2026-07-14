import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_A = '55555555-5555-4555-8555-555555555555';
const DEVICE_B = '66666666-6666-4666-8666-666666666666';
const GROUP_ID = '77777777-7777-4777-8777-777777777777';
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
import { deviceExportEnvelopeSchema } from './schemas';

type QueryResult = unknown[] | Error;
let results: QueryResult[] = [];
function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder), leftJoin: vi.fn(() => builder), innerJoin: vi.fn(() => builder),
    where: vi.fn(() => builder), orderBy: vi.fn(() => builder), limit: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return builder;
}

function device(id = DEVICE_A) {
  return {
    id, orgId: ORG_ID, siteId: SITE_ID, hostname: id === DEVICE_A ? 'hv-01' : 'app-01',
    displayName: 'Primary host', agentId: `agent-${id.slice(0, 8)}`, osType: 'windows',
    deviceRole: 'server', isVirtual: false, virtualizationPlatform: null,
    osVersion: 'Windows Server 2025 Datacenter', osBuild: '26100', architecture: 'amd64',
    enrolledAt: new Date('2026-01-01T00:00:00.000Z'), linkGroupId: null, linkGroupRole: null,
    tags: ['production'], customFields: { assetTag: 'ASSET-001', password: 'drop-me' },
    serialNumber: 'SER-001', manufacturer: 'Dell', model: 'PowerEdge',
    createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    groupIds: [GROUP_ID], groupCount: 1,
    status: 'online', lastSeenAt: new Date(), agentTokenHash: 'never-export',
    managementPosture: { health: 'healthy' }, desktopAccess: { token: 'never' },
  };
}

function request(path: string, scope = 'devices:read', apiKey = 'test-key') {
  return app.request(path, { headers: { 'X-API-Key': apiKey, 'X-Test-Scopes': scope } });
}

let app: Hono;
describe('partner foundational device export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    results = [];
    mocks.accessibleOrgIds = [ORG_ID];
    mocks.select.mockImplementation(() => query(results.shift() ?? []));
    mocks.execute.mockResolvedValue([{ snapshotAt: new Date() }]);
    app = new Hono();
    app.route('/partner-api', partnerApiRoutes);
  });

  it('requires authentication and exact devices scope', async () => {
    expect((await request('/partner-api/devices', '', 'missing')).status).toBe(401);
    expect((await request('/partner-api/devices', 'sites:read')).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('rejects invalid filters and cursors before querying', async () => {
    for (const suffix of ['?orgId=nope', '?siteId=nope', '?limit=-1', '?updatedSince=2026-07-12', '?cursor=bad']) {
      expect((await request(`/partner-api/devices${suffix}`)).status).toBe(400);
    }
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns an empty schema-valid envelope', async () => {
    results.push([]);
    const body = await (await request('/partner-api/devices')).json();
    expect(deviceExportEnvelopeSchema.parse(body)).toMatchObject({ data: [], hasMore: false, nextCursor: null });
  });

  it('takes shared organization watermark locks before selecting devices', async () => {
    results.push([]);
    expect((await request('/partner-api/devices')).status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]!);
  });

  it('uses the database snapshot and rejects future updatedSince for an empty traversal', async () => {
    mocks.accessibleOrgIds = [];
    mocks.execute.mockResolvedValueOnce([{ snapshotAt: new Date('2026-07-14T12:00:00.000Z') }]);
    const response = await request(
      `/partner-api/devices?updatedSince=${encodeURIComponent('2026-07-14T12:00:00.001Z')}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_partner_export_pagination' });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('maps a future database watermark to the structured pagination error', async () => {
    mocks.execute.mockResolvedValueOnce([{ snapshotAt: new Date('2026-07-14T12:00:00.000Z') }]);
    const response = await request(
      `/partner-api/devices?updatedSince=${encodeURIComponent('2026-07-14T12:00:00.001Z')}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_partner_export_pagination' });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('exports a strict reconstruction DTO and group identifiers', async () => {
    results.push([device()]);
    const body = await (await request('/partner-api/devices')).json();
    const record = deviceExportEnvelopeSchema.parse(body).data[0];
    expect(record).toMatchObject({
      id: DEVICE_A, orgId: ORG_ID, siteId: SITE_ID, hostname: 'hv-01', displayName: 'Primary host',
      type: { os: 'windows', role: 'server', virtual: false, virtualizationPlatform: null },
      operatingSystem: { edition: 'Windows Server 2025 Datacenter', build: '26100', architecture: 'amd64' },
      hardwareIdentity: { serialNumber: 'SER-001', manufacturer: 'Dell', model: 'PowerEdge' },
      stableIdentifiers: { assetTag: 'ASSET-001', inventoryId: null, externalId: null },
      tags: ['production'], groupIds: [GROUP_ID],
      groupMembership: { total: 1, included: 1, complete: true, reason: null },
    });
  });

  it('projects no monitoring, secret, patch, alert, command, vulnerability, or remote fields', async () => {
    results.push([device()]);
    const body = await (await request('/partner-api/devices')).json();
    const serialized = JSON.stringify(body.data[0]).toLowerCase();
    for (const forbidden of [
      'status', 'online', 'offline', 'lastseen', 'heartbeat', 'health', 'alert', 'patch',
      'vulnerabil', 'token', 'command', 'desktopaccess', 'remote', 'uptime', 'managementposture',
    ]) expect(serialized).not.toContain(forbidden);

    const projection = mocks.select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(projection)).toEqual(expect.arrayContaining(['id', 'orgId', 'siteId', 'hostname', 'serialNumber', 'customFields']));
    for (const forbidden of ['status', 'lastSeenAt', 'agentTokenHash', 'managementPosture', 'desktopAccess']) {
      expect(projection).not.toHaveProperty(forbidden);
    }
  });

  it('fails closed when an allowlisted stable identifier contains secret-like material', async () => {
    results.push([{ ...device(), customFields: { assetTag: `sk-live-${'A1b2C3d4'.repeat(6)}` } }]);
    const body = await (await request('/partner-api/devices')).json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({
      resource: 'devices', id: DEVICE_A, orgId: ORG_ID, reason: 'secret_detected',
    })]);
    expect(JSON.stringify(body)).not.toContain('sk-live-');
  });

  it('walks multiple pages with one snapshot', async () => {
    results.push([device(DEVICE_A), device(DEVICE_B)]);
    const first = await (await request('/partner-api/devices?limit=1')).json();
    expect(first).toMatchObject({ hasMore: true });
    results.push([device(DEVICE_B)]);
    const second = await (await request(`/partner-api/devices?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second).toMatchObject({ hasMore: false, snapshotAt: first.snapshotAt });
    expect(second.data[0].id).toBe(DEVICE_B);
  });

  it('rejects a signed cursor when orgId or siteId is switched', async () => {
    results.push([device(DEVICE_A), device(DEVICE_B)]);
    const first = await (await request(
      `/partner-api/devices?orgId=${ORG_ID}&siteId=${SITE_ID}&limit=1`,
    )).json();
    expect(first.nextCursor).toEqual(expect.any(String));

    expect((await request(
      `/partner-api/devices?orgId=${ORG_ID}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    )).status).toBe(400);
    expect((await request(
      `/partner-api/devices?siteId=${SITE_ID}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    )).status).toBe(400);
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it('supports updatedSince and site/org filters for accessible data', async () => {
    results.push([device()]);
    const queryString = new URLSearchParams({ orgId: ORG_ID, siteId: SITE_ID, updatedSince: '2026-07-11T12:00:00.000Z' });
    const res = await request(`/partner-api/devices?${queryString}`);
    expect(res.status).toBe(200);
    expect(deviceExportEnvelopeSchema.parse(await res.json()).data).toHaveLength(1);
  });

  it('bounds high-cardinality memberships with deterministic completeness metadata', async () => {
    const groupIds = Array.from({ length: 500 }, (_, index) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    results.push([{ ...device(), groupIds, groupCount: 501 }]);
    const body = await (await request('/partner-api/devices')).json();
    const record = deviceExportEnvelopeSchema.parse(body).data[0];
    expect(record).toBeDefined();
    if (!record) throw new Error('expected one exported device');
    expect(record.groupIds).toEqual(groupIds);
    expect(record.groupMembership).toEqual({
      total: 501, included: 500, complete: false, reason: 'membership_limit_exceeded',
    });
  });

  it.each([OTHER_ORG_ID, '88888888-8888-4888-8888-888888888888'])('fails closed for inaccessible/nonexistent org filter %s', async (orgId) => {
    expect((await request(`/partner-api/devices?orgId=${orgId}`)).status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking query failures', async () => {
    results.push(new Error('secret database internals'));
    const res = await request('/partner-api/devices');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret database internals');
  });

  it('rejects an implementation response that violates its strict schema', () => {
    const invalid = {
      schemaVersion: '1', snapshotAt: new Date().toISOString(), nextCursor: null, hasMore: false,
      data: [{ ...device(), sourceUpdatedAt: UPDATED_AT.toISOString(), revision: 'a'.repeat(64), password: 'bad' }],
    };
    expect(deviceExportEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });
});
