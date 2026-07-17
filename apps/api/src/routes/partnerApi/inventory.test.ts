import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_A = '55555555-5555-4555-8555-555555555555';
const DEVICE_B = '66666666-6666-4666-8666-666666666666';
const DEVICE_BATCH_A = '81111111-1111-4111-8111-111111111111';
const DEVICE_BATCH_B = '82222222-2222-4222-8222-222222222222';
const SITE_BATCH = '83333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date('2026-07-10T12:00:00.000Z');
const UPDATED_AT = new Date('2026-07-12T12:00:00.000Z');

const mocks = vi.hoisted(() => ({
  select: vi.fn(), execute: vi.fn(), accessibleOrgIds: [] as string[],
  projections: [] as Array<Record<string, unknown>>,
  builders: [] as any[],
}));
vi.mock('../../db', () => ({
  db: { select: mocks.select, execute: mocks.execute }, hasDbAccessContext: () => true,
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerId: PARTNER_ID, accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) =>
    required.every((scope) => c.get('partnerApiPrincipal').scopes.includes(scope))
      ? next() : c.json({ error: 'scope required' }, 403),
}));

import { partnerApiRoutes } from './index';

type QueryResult = unknown[] | Error;
let results: QueryResult[] = [];
function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder), leftJoin: vi.fn(() => builder), innerJoin: vi.fn(() => builder),
    where: vi.fn(() => builder), orderBy: vi.fn(() => builder), limit: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  mocks.builders.push(builder);
  return builder;
}

function inventoryRow(id = DEVICE_A) {
  return {
    id: id === DEVICE_A ? DEVICE_BATCH_A : DEVICE_BATCH_B, subjectId: id, subjectType: 'device',
    orgId: ORG_ID, siteId: SITE_ID, createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    hardware: {
      cpuModel: 'Xeon Gold', cpuCores: 16, cpuThreads: 32, ramTotalMb: 65536,
      gpuModel: null, motherboardManufacturer: 'Dell', motherboardProduct: 'PowerEdge',
      motherboardVersion: '2', biosVersion: '1.4.2', providerToken: 'never-export',
    },
    disks: [{ id: '71111111-1111-4111-8111-111111111111', mountPoint: 'C:', device: 'Disk 0', fsType: 'NTFS', totalGb: 1000, usedGb: 900 }],
    diskCount: 1,
    interfaces: [
      { id: '72222222-2222-4222-8222-222222222222', name: 'Ethernet', macAddress: '00:11:22:33:44:55', primary: true },
      { id: '72222222-2222-4222-8222-222222222223', name: 'Wi-Fi', macAddress: '00:11:22:33:44:66', primary: false },
    ],
    interfaceCount: 2,
    addresses: [
      { id: '73333333-3333-4333-8333-333333333333', interfaceName: 'Ethernet', address: '10.0.0.10', family: 'ipv4', assignment: 'static', subnetMask: '255.255.255.0', gateway: '10.0.0.1', dnsServers: ['10.0.0.2'], active: true, firstSeenAt: '2026-01-01T00:00:00.000Z', deactivatedAt: null },
      { id: '74444444-4444-4444-8444-444444444444', interfaceName: 'Wi-Fi', address: '10.0.0.55', family: 'ipv4', assignment: 'dhcp', subnetMask: '255.255.255.0', gateway: '10.0.0.1', dnsServers: ['10.0.0.2'], active: true, firstSeenAt: '2026-01-02T00:00:00.000Z', deactivatedAt: null },
    ],
    addressCount: 2,
    warranty: { status: 'active', startsOn: '2025-01-01', endsOn: '2028-01-01', subscription: false, lastSyncError: 'secret-provider-error' },
    virtualMachines: [{ id: '75555555-5555-4555-8555-555555555555', externalId: 'vm-guid', name: 'APP01', generation: 2, memoryMb: 8192, processorCount: 4, rctEnabled: true, passthroughDisks: false, state: 'running', checkpoints: ['secret'] }],
    virtualMachineCount: 1,
  };
}

function siteInventoryRow() {
  return {
    id: SITE_BATCH, subjectId: SITE_ID, subjectType: 'site', orgId: ORG_ID, siteId: SITE_ID,
    createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    networkEquipment: [{ id: '76666666-6666-4666-8666-666666666666', type: 'switch', name: 'core-sw', address: '10.0.0.2', macAddress: '00:aa:bb:cc:dd:ee', manufacturer: 'Cisco', model: 'C9300', openPorts: [22] }],
    networkEquipmentCount: 1,
    networkSegments: [{ id: '79999999-9999-4999-8999-999999999999', cidr: '10.0.0.0/24' }],
    networkSegmentCount: 1,
  };
}

function softwareRow(id = DEVICE_A) {
  return {
    id: id === DEVICE_A ? DEVICE_BATCH_A : DEVICE_BATCH_B, subjectId: id, subjectType: 'device',
    orgId: ORG_ID, siteId: SITE_ID, createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    software: [{ id: '77777777-7777-4777-8777-777777777777', name: 'PostgreSQL', version: '17', vendor: 'PostgreSQL Global Development Group', installedOn: '2026-01-01', managed: true, uninstallString: 'secret', fileHash: 'secret' }],
    softwareCount: 1,
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

describe('partner reconstruction inventory exports', () => {
  beforeEach(() => {
    vi.clearAllMocks(); results = []; mocks.accessibleOrgIds = [ORG_ID];
    mocks.projections.length = 0; mocks.builders.length = 0;
    mocks.select.mockImplementation((projection: Record<string, unknown>) => {
      mocks.projections.push(projection);
      return query(results.shift() ?? []);
    });
    mocks.execute.mockResolvedValue([{ snapshotAt: new Date('2026-07-14T12:00:00.000Z') }]);
    app = new Hono().route('/partner-api', partnerApiRoutes);
  });

  it.each(['/device-inventory', '/device-software'])('requires authentication and exact inventory scope for %s', async (path) => {
    expect((await request(`/partner-api${path}`, '', 'missing')).status).toBe(401);
    expect((await request(`/partner-api${path}`, 'devices:read')).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each(['/device-inventory', '/device-software'])('rejects invalid filters and cursors for %s', async (path) => {
    for (const suffix of ['?orgId=nope', '?siteId=nope', '?limit=0', '?updatedSince=yesterday', '?cursor=bad']) {
      expect((await request(`/partner-api${path}${suffix}`)).status).toBe(400);
    }
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each(['/device-inventory', '/device-software'])('returns an empty schema-valid page and locks before querying %s', async (path) => {
    results.push([]);
    if (path === '/device-inventory') results.push([]);
    const response = await request(`/partner-api${path}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schemaVersion: '1', data: [], nextCursor: null, hasMore: false });
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]!);
  });

  it('exports explicit durable hardware, firmware, disk, interface, IP, warranty, VM, and approved equipment fields', async () => {
    results.push([inventoryRow()]);
    results.push([siteInventoryRow()]);
    const body = await (await request('/partner-api/device-inventory')).json();
    expect(body.data[0]).toMatchObject({
      subjectType: 'device', deviceId: DEVICE_A, orgId: ORG_ID, siteId: SITE_ID,
      hardware: { processor: { model: 'Xeon Gold', cores: 16, threads: 32 }, memory: { totalMb: 65536 }, firmware: { biosVersion: '1.4.2' } },
      disks: [{ mountPoint: 'C:', totalGb: 1000 }],
      addresses: [
        expect.objectContaining({ address: '10.0.0.10', assignment: 'static', reservationEligible: true }),
        expect.objectContaining({ address: '10.0.0.55', assignment: 'dhcp', reservationEligible: false }),
      ],
      warranty: { status: 'active', endsOn: '2028-01-01' },
      virtualMachines: [{ externalId: 'vm-guid', name: 'APP01', memoryMb: 8192 }],
    });
    expect(body.data[0].interfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Ethernet', macAddress: '00:11:22:33:44:55' }),
    ]));
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['providertoken', 'usedgb', 'lastsyncerror', 'state', 'checkpoints', 'openports', 'secret']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('exports site-scoped approved durable equipment and network segments even when the site has no managed devices', async () => {
    results.push([]);
    results.push([siteInventoryRow()]);
    const body = await (await request('/partner-api/device-inventory')).json();
    expect(body.data).toEqual([expect.objectContaining({
      subjectType: 'site', siteSubjectId: SITE_ID,
      networkEquipment: [expect.objectContaining({ type: 'switch', name: 'core-sw' })],
      networkSegments: [{ id: '79999999-9999-4999-8999-999999999999', cidr: '10.0.0.0/24' }],
    })]);
    expect(JSON.stringify(body)).not.toMatch(/openPorts|secret/i);
  });

  it('exports approved printers as durable reconstruction equipment', async () => {
    const printer = {
      id: '76666666-6666-4666-8666-666666666667', type: 'printer', name: 'front-office-printer',
      address: '10.0.0.25', macAddress: '00:aa:bb:cc:dd:ef', manufacturer: 'HP', model: 'LaserJet',
    };
    results.push([]);
    results.push([{ ...siteInventoryRow(), networkEquipment: [printer], networkEquipmentCount: 1 }]);
    const response = await request('/partner-api/device-inventory');
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].networkEquipment).toEqual([printer]);
  });

  it('omits IP history whose current interface endpoint is missing', async () => {
    const source = inventoryRow();
    results.push([{
      ...source,
      addresses: [{
        ...source.addresses[0],
        id: '73333333-3333-4333-8333-333333333334',
        interfaceId: '70000000-0000-4000-8000-000000000000',
        interfaceName: 'Removed adapter',
      }],
      addressCount: 0,
    }]);
    results.push([]);
    const response = await request('/partner-api/device-inventory');
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].addresses).toEqual([]);
  });

  it('resolves history by interface name, preferring an exact MAC and accepting a null history MAC', async () => {
    const source = inventoryRow();
    const exactId = '72222222-2222-4222-8222-222222222224';
    const fallbackId = '72222222-2222-4222-8222-222222222225';
    const interfaces = [
      { id: fallbackId, name: 'Bonded', macAddress: '00:00:00:00:00:01', primary: false },
      { id: exactId, name: 'Bonded', macAddress: '00:00:00:00:00:02', primary: false },
    ];
    results.push([{
      ...source,
      interfaces,
      interfaceCount: 2,
      addresses: [
        { ...source.addresses[0], id: '73333333-3333-4333-8333-333333333335', interfaceName: 'Bonded', macAddress: '00:00:00:00:00:02' },
        { ...source.addresses[1], id: '73333333-3333-4333-8333-333333333336', interfaceName: 'Bonded', macAddress: null },
      ],
      addressCount: 2,
    }]);
    results.push([]);
    const response = await request('/partner-api/device-inventory');
    expect(response.status).toBe(200);
    const addresses = (await response.json()).data[0].addresses;
    expect(addresses[0].interfaceId).toBe(exactId);
    expect(addresses[1].interfaceId).toBe(fallbackId);
  });

  it.each(['/device-inventory', '/device-software'])('requires a same-org site join for device rows on %s', async (path) => {
    results.push([]);
    if (path === '/device-inventory') results.push([]);
    expect((await request(`/partner-api${path}`)).status).toBe(200);
    const builder = mocks.builders[0]!;
    expect(builder.innerJoin).toHaveBeenCalled();
    const condition = builder.innerJoin.mock.calls[0]![1] as SQL;
    const rendered = new PgDialect().sqlToQuery(condition).sql;
    expect(rendered).toContain('"sites"."id" = "devices"."site_id"');
    expect(rendered).toContain('"sites"."org_id" = "devices"."org_id"');
  });

  it('builds derived identities from canonical JSON arrays through the text SQL overload', async () => {
    results.push([], []);
    expect((await request('/partner-api/device-inventory')).status).toBe(200);
    const projection = mocks.projections[0]!;
    const dialect = new PgDialect();
    for (const [field, namespace] of [
      ['interfaces', 'interface'],
      ['addresses', 'address'],
      ['virtualMachines', 'hyperv-vm'],
    ] as const) {
      const query = dialect.sqlToQuery(projection[field] as SQL);
      expect(query.sql).toContain('breeze_partner_export_stable_uuid');
      expect(query.sql).not.toContain('md5(');
      expect(query.sql).toContain('array_to_json(ARRAY[');
      expect(query.sql).not.toContain("|| ':' ||");
      expect(query.params).toContain(namespace);
      if (field === 'addresses') {
        expect(query.sql).toContain('JOIN LATERAL');
        expect(query.sql).toContain('current_interface.interface_name = a.interface_name');
        expect(query.sql).toContain('a.mac_address IS NOT NULL AND current_interface.mac_address = a.mac_address');
        expect(query.sql).toContain('resolved_interface.mac_address');
      }
    }
  });

  it('exports a bounded complete software snapshot without raw uninstall/hash/location fields', async () => {
    results.push([softwareRow()]);
    const body = await (await request('/partner-api/device-software')).json();
    expect(body.data[0]).toMatchObject({
      deviceId: DEVICE_A, software: [{ name: 'PostgreSQL', version: '17', managed: true }],
      collection: { total: 1, included: 1, complete: true, reason: null },
    });
    expect(JSON.stringify(body).toLowerCase()).not.toMatch(/uninstall|string|filehash|secret/);
  });

  it('reports capped child collections explicitly instead of silently truncating them', async () => {
    results.push([{ ...inventoryRow(), diskCount: 501 }]);
    results.push([]);
    const body = await (await request('/partner-api/device-inventory')).json();
    expect(body.data[0].collections.disks).toEqual({ total: 501, included: 1, complete: false, reason: 'collection_limit_exceeded' });
  });

  it('walks multiple pages with stable snapshots and filter-bound cursors', async () => {
    results.push([inventoryRow(DEVICE_A), inventoryRow(DEVICE_B)]);
    results.push([]);
    const first = await (await request(`/partner-api/device-inventory?orgId=${ORG_ID}&siteId=${SITE_ID}&limit=1`)).json();
    expect(first.hasMore).toBe(true);
    results.push([inventoryRow(DEVICE_B)]);
    results.push([]);
    const second = await (await request(`/partner-api/device-inventory?orgId=${ORG_ID}&siteId=${SITE_ID}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second).toMatchObject({ hasMore: false, snapshotAt: first.snapshotAt });
    expect(second.data[0].deviceId).toBe(DEVICE_B);
    expect((await request(`/partner-api/device-inventory?orgId=${ORG_ID}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400);
  });

  it.each(['/device-inventory', '/device-software'])('supports updatedSince and accessible site/org filters for %s', async (path) => {
    results.push([path.endsWith('software') ? softwareRow() : inventoryRow()]);
    if (path === '/device-inventory') results.push([]);
    const queryString = new URLSearchParams({ orgId: ORG_ID, siteId: SITE_ID, updatedSince: '2026-07-11T12:00:00.000Z' });
    expect((await request(`/partner-api${path}?${queryString}`)).status).toBe(200);
  });

  it.each(['/device-inventory', '/device-software'])('fails closed for inaccessible organizations and query failures on %s', async (path) => {
    expect((await request(`/partner-api${path}?orgId=${OTHER_ORG_ID}`)).status).toBe(404);
    results.push(new Error('postgresql://secret@internal-host/db'));
    const response = await request(`/partner-api${path}`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/secret|internal-host/);
  });
});
