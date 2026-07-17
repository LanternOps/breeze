import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_SITE_ID = '44444444-4444-4444-8444-444444444445';
const DEVICE_A = '55555555-5555-4555-8555-555555555555';
const DEVICE_B = '66666666-6666-4666-8666-666666666666';
const DEVICE_BATCH_A = '91111111-1111-4111-8111-111111111111';
const DEVICE_BATCH_B = '92222222-2222-4222-8222-222222222222';
const SITE_BATCH = '93333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date('2026-07-10T12:00:00.000Z');
const UPDATED_AT = new Date('2026-07-12T12:00:00.000Z');

const mocks = vi.hoisted(() => ({
  select: vi.fn(), execute: vi.fn(), accessibleOrgIds: [] as string[],
  projections: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../db', () => ({ db: { select: mocks.select, execute: mocks.execute }, hasDbAccessContext: () => true }));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', { partnerId: PARTNER_ID, accessibleOrgIds: mocks.accessibleOrgIds, scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean) });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) =>
    required.every((scope) => c.get('partnerApiPrincipal').scopes.includes(scope)) ? next() : c.json({ error: 'scope required' }, 403),
}));

import { partnerApiRoutes } from './index';

type QueryResult = unknown[] | Error;
let results: QueryResult[] = [];
function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = { from: vi.fn(() => builder), leftJoin: vi.fn(() => builder), innerJoin: vi.fn(() => builder), where: vi.fn(() => builder), orderBy: vi.fn(() => builder), limit: vi.fn(() => promise), then: promise.then.bind(promise) };
  return builder;
}

function row(id = DEVICE_A) {
  return {
    id: id === DEVICE_A ? DEVICE_BATCH_A : DEVICE_BATCH_B, subjectId: id, subjectType: 'device',
    orgId: ORG_ID, siteId: SITE_ID, createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    interfaceEdges: [{ interfaceId: '71111111-1111-4111-8111-111111111111', interfaceName: 'Ethernet' }],
    addressEdges: [
      { addressId: '72222222-2222-4222-8222-222222222222', interfaceId: '71111111-1111-4111-8111-111111111111', assignment: 'static' },
      { addressId: '73333333-3333-4333-8333-333333333333', interfaceId: '71111111-1111-4111-8111-111111111111', assignment: 'dhcp' },
    ],
    vmEdges: [{ vmId: '74444444-4444-4444-8444-444444444444' }],
    linkGroupId: '77777777-7777-4777-8777-777777777777', linkGroupRole: 'host',
    peerEdges: [{ deviceId: DEVICE_B, role: 'guest' }],
    eventClients: [{ id: '78888888-8888-4888-8888-888888888888', type: 'phone' }],
    edgeCount: 6,
  };
}

function siteRow() {
  return {
    id: SITE_BATCH, subjectId: SITE_ID, subjectType: 'site', orgId: ORG_ID, siteId: SITE_ID,
    createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    topologyEdges: [{ id: '75555555-5555-4555-8555-555555555555', sourceType: 'device', sourceId: DEVICE_A, targetType: 'discovered_asset', targetId: '76666666-6666-4666-8666-666666666666', connectionType: 'ethernet', interfaceName: 'Ethernet', vlan: 20 }],
    edgeCount: 2,
  };
}

let app: Hono;
function request(path: string, scope = 'inventory:read', apiKey = 'test-key') {
  return app.request(path, { headers: { 'X-API-Key': apiKey, 'X-Test-Scopes': scope } });
}


// The route stack derives cursor expiry from the mocked snapshot
// (2026-07-14T12:00Z + 24h) but decodePartnerExportCursor checks expiry
// against the wall clock. Pin Date (and only Date) so cursor round-trips
// stay inside the snapshot's validity window regardless of when the suite
// runs.
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-07-14T12:30:00.000Z'), toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('partner durable relationship export', () => {
  beforeEach(() => {
    vi.clearAllMocks(); results = []; mocks.accessibleOrgIds = [ORG_ID]; mocks.projections.length = 0;
    mocks.select.mockImplementation((projection: Record<string, unknown>) => {
      mocks.projections.push(projection);
      return query(results.shift() ?? []);
    });
    mocks.execute.mockResolvedValue([{ snapshotAt: new Date('2026-07-14T12:00:00.000Z') }]);
    app = new Hono().route('/partner-api', partnerApiRoutes);
  });

  it('requires authentication and exact inventory scope', async () => {
    expect((await request('/partner-api/device-relationships', '', 'missing')).status).toBe(401);
    expect((await request('/partner-api/device-relationships', 'devices:read')).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('rejects invalid filters/cursors and inaccessible organizations', async () => {
    for (const suffix of ['?orgId=nope', '?siteId=nope', '?limit=0', '?updatedSince=nope', '?cursor=bad']) {
      expect((await request(`/partner-api/device-relationships${suffix}`)).status).toBe(400);
    }
    expect((await request(`/partner-api/device-relationships?orgId=${OTHER_ORG_ID}`)).status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns an empty stable snapshot and takes the shared DB lock first', async () => {
    results.push([], []);
    const response = await request('/partner-api/device-relationships');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [], nextCursor: null, hasMore: false });
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]!);
  });

  it('emits deterministic stable edges for hierarchy, interfaces, addresses, Hyper-V, topology, VLAN, and link groups', async () => {
    results.push([row()]);
    results.push([siteRow()]);
    const body = await (await request('/partner-api/device-relationships')).json();
    const edges = body.data.flatMap((batch: any) => batch.edges);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'organization_site', from: { type: 'organization', id: ORG_ID }, to: { type: 'site', id: SITE_ID } }),
      expect.objectContaining({ type: 'site_device', from: { type: 'site', id: SITE_ID }, to: { type: 'device', id: DEVICE_A } }),
      expect.objectContaining({ type: 'device_interface', to: { type: 'interface', id: '71111111-1111-4111-8111-111111111111' } }),
      expect.objectContaining({ type: 'interface_address', metadata: { assignment: 'static', reservationEligible: true } }),
      expect.objectContaining({ type: 'interface_address', metadata: { assignment: 'dhcp', reservationEligible: false } }),
      expect.objectContaining({ type: 'hyperv_host_vm', to: { type: 'virtual_machine', id: '74444444-4444-4444-8444-444444444444' } }),
      expect.objectContaining({ type: 'network_topology', metadata: expect.objectContaining({ vlan: 20 }) }),
      expect.objectContaining({ type: 'device_link', to: { type: 'device', id: DEVICE_B } }),
    ]));
    expect(new Set(edges.map((edge: any) => edge.key)).size).toBe(edges.length);
    expect(JSON.stringify(body)).not.toMatch(/eventClients|78888888-8888-4888-8888-888888888888|phone/);
  });

  it('emits organization-to-site and site topology batches for an empty site', async () => {
    results.push([]);
    results.push([siteRow()]);
    const body = await (await request('/partner-api/device-relationships')).json();
    expect(body.data).toEqual([expect.objectContaining({
      subjectType: 'site', siteSubjectId: SITE_ID,
      edges: expect.arrayContaining([
        expect.objectContaining({ type: 'organization_site' }),
        expect.objectContaining({ type: 'network_topology' }),
      ]),
    })]);
  });

  it('uses stable edge keys independent of input order', async () => {
    const source = row();
    results.push([source]);
    results.push([siteRow()]);
    const first = await (await request('/partner-api/device-relationships')).json();
    results.push([{ ...source, interfaceEdges: [...source.interfaceEdges].reverse(), addressEdges: [...source.addressEdges].reverse() }]);
    results.push([siteRow()]);
    const second = await (await request('/partner-api/device-relationships')).json();
    expect(second.data).toEqual(first.data);
  });

  it('omits an address edge whose current interface endpoint is missing', async () => {
    const source = row();
    results.push([{
      ...source,
      addressEdges: [
        ...source.addressEdges,
        {
          addressId: '73333333-3333-4333-8333-333333333334',
          interfaceId: '70000000-0000-4000-8000-000000000000',
          assignment: 'static',
        },
      ],
      edgeCount: 6,
    }]);
    results.push([]);
    const response = await request('/partner-api/device-relationships');
    expect(response.status).toBe(200);
    const edges = (await response.json()).data[0].edges;
    expect(edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'interface_address',
        from: { type: 'interface', id: '70000000-0000-4000-8000-000000000000' },
      }),
    ]));
  });

  it('resolves topology endpoints in the same organization/site and link peers in the same organization', async () => {
    results.push([], []);
    expect((await request('/partner-api/device-relationships')).status).toBe(200);
    const dialect = new PgDialect();
    const deviceProjection = mocks.projections[0]!;
    const siteProjection = mocks.projections[1]!;

    const peerQuery = dialect.sqlToQuery(deviceProjection.peerEdges as SQL);
    expect(peerQuery.sql).toContain('p.org_id = "devices"."org_id"');
    expect(peerQuery.sql).not.toContain('p.site_id = "devices"."site_id"');

    const topologyQuery = dialect.sqlToQuery(siteProjection.topologyEdges as SQL);
    expect(topologyQuery.sql.match(/exists/gi)).toHaveLength(4);
    expect(topologyQuery.sql).toContain('endpoint_device.org_id = t.org_id');
    expect(topologyQuery.sql).toContain('endpoint_device.site_id = t.site_id');
    expect(topologyQuery.sql).toContain('endpoint_asset.org_id = t.org_id');
    expect(topologyQuery.sql).toContain('endpoint_asset.site_id = t.site_id');
    expect(topologyQuery.sql).toContain("'printer'");
  });

  it('limits discovered topology endpoints to the exact exported 500-item equipment set', async () => {
    results.push([], []);
    expect((await request('/partner-api/device-relationships')).status).toBe(200);
    const dialect = new PgDialect();
    for (const field of ['topologyEdges', 'edgeCount'] as const) {
      const query = dialect.sqlToQuery(mocks.projections[1]![field] as SQL);
      expect(query.params.filter((value) => value === 500)).toHaveLength(2);
      expect(query.sql.match(/ORDER BY endpoint_asset\.id LIMIT/gu)).toHaveLength(2);
    }
  });

  it('preserves a same-org device link when the peer is at another site', async () => {
    results.push([{
      ...row(),
      peerEdges: [{ deviceId: DEVICE_B, orgId: ORG_ID, siteId: OTHER_SITE_ID, role: 'guest' }],
      edgeCount: 6,
    }]);
    results.push([]);
    const response = await request('/partner-api/device-relationships');
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'device_link', to: { type: 'device', id: DEVICE_B } }),
    ]));
  });

  it('builds relationship child IDs from canonical JSON arrays through the text SQL overload', async () => {
    results.push([], []);
    expect((await request('/partner-api/device-relationships')).status).toBe(200);
    const projection = mocks.projections[0]!;
    const dialect = new PgDialect();
    for (const [field, namespace] of [
      ['interfaceEdges', 'interface'],
      ['addressEdges', 'address'],
      ['vmEdges', 'hyperv-vm'],
    ] as const) {
      const query = dialect.sqlToQuery(projection[field] as SQL);
      expect(query.sql).toContain('breeze_partner_export_stable_uuid');
      expect(query.sql).not.toContain('md5(');
      expect(query.sql).toContain('array_to_json(ARRAY[');
      expect(query.sql).not.toContain("|| ':' ||");
      expect(query.params).toContain(namespace);
      if (field === 'addressEdges') {
        expect(query.sql).toContain('JOIN LATERAL');
        expect(query.sql).toContain('current_interface.interface_name = a.interface_name');
        expect(query.sql).toContain('a.mac_address IS NOT NULL AND current_interface.mac_address = a.mac_address');
        expect(query.sql).toContain('resolved_interface.mac_address');
      }
    }
  });

  it('marks relation batches incomplete when their bounded source cardinality overflows', async () => {
    results.push([{ ...row(), edgeCount: 501 }]);
    results.push([]);
    const body = await (await request('/partner-api/device-relationships')).json();
    expect(body.data[0].collection).toMatchObject({ total: 501, complete: false, reason: 'collection_limit_exceeded' });
  });

  it('supports incremental multipage traversal with stable snapshots', async () => {
    results.push([row(DEVICE_A), row(DEVICE_B)]);
    results.push([]);
    const since = encodeURIComponent('2026-07-11T12:00:00.000Z');
    const first = await (await request(`/partner-api/device-relationships?updatedSince=${since}&limit=1`)).json();
    results.push([row(DEVICE_B)]);
    results.push([]);
    const second = await (await request(`/partner-api/device-relationships?updatedSince=${since}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second).toMatchObject({ hasMore: false, snapshotAt: first.snapshotAt });
    expect(second.data[0].deviceId).toBe(DEVICE_B);
  });

  it('returns a sanitized server error on query failure', async () => {
    results.push(new Error('postgresql://secret@internal-host/db'));
    const response = await request('/partner-api/device-relationships');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/secret|internal-host/);
  });
});
