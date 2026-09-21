import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Stub the vendor adapter and the credential codec. Everything else — persist,
// mapping, device matching, alerts, alertService, eventBus — runs for real
// against the test Postgres and Redis.
const listCustomers = vi.fn();
const listDevices = vi.fn();
vi.mock('../../services/backupProviders/registry', () => ({
  BACKUP_PROVIDER_KEYS: ['cove'] as const,
  getBackupProvider: () => ({
    key: 'cove',
    label: 'Cove Data Protection',
    credentialsSchema: { parse: (v: unknown) => v },
    testConnection: vi.fn(),
    listCustomers,
    listDevices,
  }),
}));
vi.mock('../../services/backupProviders/credentials', () => ({
  encryptProviderCredentials: vi.fn(() => 'ciphertext'),
  decryptProviderCredentials: vi.fn(() => ({ partnerName: 'p', username: 'u', password: 'x' })),
}));

import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { getEventBus } from '../../services/eventBus';
import { syncConnectionById } from '../../jobs/backupProviderSync';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerId: string;
  orgId: string;
  deviceId: string;
  connectionId: string;
}

async function seed(unique: string): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `BP Partner ${unique}`, slug: `bp-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD', partnerId: partner!.id, name: `BP Org ${unique}`,
        slug: `bp-org-${unique}`, type: 'customer', status: 'active',
      })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `BP Site ${unique}` }).returning({ id: sites.id });
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id, siteId: site!.id,
        agentId: `bp-agent-${unique}`, hostname: `srv-${unique}`,
        osType: 'windows', osVersion: '2022', architecture: 'x86_64',
        agentVersion: '0.0.0-test', status: 'online',
      })
      .returning({ id: devices.id });
    const [connection] = await db
      .insert(backupProviderConnections)
      .values({
        partnerId: partner!.id, provider: 'cove', name: `BP Conn ${unique}`,
        baseUrl: 'https://api.backup.management/jsonapi',
        credentialsEncrypted: 'ciphertext', vendorRootId: '1000', vendorRootName: 'Root',
        isActive: true, status: 'connected', syncIntervalMinutes: 30,
        showProviderNameInPortal: false,
      })
      .returning({ id: backupProviderConnections.id });

    return {
      partnerId: partner!.id,
      orgId: org!.id,
      deviceId: device!.id,
      connectionId: connection!.id,
    };
  });
}

const customer = (orgId: string) => ({
  vendorCustomerId: 'vc-1',
  name: 'Some Other Name Entirely',
  parentId: '1000',
  level: 'EndCustomer',
  // Exercises the auto_external_code rule: the vendor row carries the Breeze org id.
  externalCode: orgId,
});

const vendorDevice = (over: Record<string, unknown> = {}) => ({
  vendorDeviceId: 'vd-1',
  vendorCustomerId: 'vc-1',
  name: 'SRV-01',
  computerName: null as string | null,
  osType: 'server' as const,
  osVersion: 'Windows Server 2022',
  clientVersion: '24.3',
  macAddresses: [] as string[],
  accountType: 'backup_manager' as const,
  dataSources: ['files'],
  status: 'failed' as const,
  vendorStatusCode: 2,
  lastSessionAt: new Date(),
  lastSuccessAt: null as Date | null,
  lastCompletedAt: null as Date | null,
  selectedBytes: 1024,
  usedBytes: 512,
  errorsCount: 3,
  vendorCreatedAt: null as Date | null,
  vendorExpiresAt: null as Date | null,
  raw: { D09F00: 2 },
  ...over,
});

const capturedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
let unsubscribes: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  capturedEvents.length = 0;
  const bus = getEventBus();
  unsubscribes = [
    bus.subscribe('backup.provider_device_unhealthy', (event) => {
      capturedEvents.push({ type: event.type, payload: event.payload as Record<string, unknown> });
      return Promise.resolve();
    }),
    bus.subscribe('backup.provider_device_recovered', (event) => {
      capturedEvents.push({ type: event.type, payload: event.payload as Record<string, unknown> });
      return Promise.resolve();
    }),
  ];
});

afterEach(() => {
  for (const off of unsubscribes) off();
  unsubscribes = [];
});

describe('backup provider sync (real Postgres + Redis)', () => {
  runDb('customers -> auto-mapping -> devices -> ledger -> (two polls) alert -> cleared -> resolved', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fixture = await seed(unique);
    // The vendor device's name matches the Breeze device's hostname, so the
    // hostname rule links them.
    const deviceName = `srv-${unique}`;

    // ---- poll 1 -------------------------------------------------------
    listCustomers.mockResolvedValue([customer(fixture.orgId)]);
    listDevices.mockResolvedValue([vendorDevice({ name: deviceName })]);
    await syncConnectionById(fixture.connectionId);

    const afterFirst = await withSystemDbAccessContext(async () => {
      const [mapped] = await db
        .select()
        .from(backupProviderCustomers)
        .where(eq(backupProviderCustomers.connectionId, fixture.connectionId));
      const [row] = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.providerDeviceId, row!.id));
      const openAlerts = await db.select().from(alerts).where(eq(alerts.orgId, fixture.orgId));
      const [connection] = await db
        .select()
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, fixture.connectionId));
      return { mapped, row, ledger, openAlerts, connection };
    });

    // Auto-mapped by external code, device stored under the mapped org, linked
    // to the Breeze device by hostname, one ledger row for today.
    expect(afterFirst.mapped!.orgId).toBe(fixture.orgId);
    expect(afterFirst.mapped!.mappingSource).toBe('auto_external_code');
    expect(afterFirst.mapped!.deviceCount).toBe(1);
    expect(afterFirst.row!.orgId).toBe(fixture.orgId);
    expect(afterFirst.row!.provider).toBe('cove');
    expect(afterFirst.row!.breezeDeviceId).toBe(fixture.deviceId);
    expect(afterFirst.row!.deviceMatchSource).toBe('auto_hostname');
    expect(afterFirst.ledger).toHaveLength(1);
    expect(afterFirst.ledger[0]!.status).toBe('failed');
    expect(afterFirst.ledger[0]!.observations).toBe(1);
    // Hysteresis: nothing raised on the first observation.
    expect(afterFirst.row!.pendingCondition).toBe('failed');
    expect(afterFirst.openAlerts).toHaveLength(0);
    expect(capturedEvents).toHaveLength(0);
    expect(afterFirst.connection!.lastSyncStatus).toBe('success');
    expect(afterFirst.connection!.lastSyncCustomers).toBe(1);
    expect(afterFirst.connection!.lastSyncDevices).toBe(1);
    expect(afterFirst.connection!.lastSyncLinkedDevices).toBe(1);
    expect(afterFirst.connection!.lastSyncUnmappedDevices).toBe(0);

    // ---- poll 2: same condition -> raise -------------------------------
    await syncConnectionById(fixture.connectionId);

    const afterSecond = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const open = await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.orgId, fixture.orgId), eq(alerts.status, 'active')));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.providerDeviceId, row!.id));
      return { row, open, ledger };
    });

    expect(afterSecond.row!.pendingCondition).toBe('raised:failed');
    expect(afterSecond.open).toHaveLength(1);
    expect(afterSecond.open[0]!.deviceId).toBe(fixture.deviceId);
    expect(afterSecond.open[0]!.severity).toBe('high');
    expect(afterSecond.open[0]!.title).toContain('Backup failed on');
    expect(afterSecond.open[0]!.context).toMatchObject({
      source: 'backup_provider',
      connectionId: fixture.connectionId,
      providerDeviceId: afterSecond.row!.id,
      condition: 'failed',
    });
    // Same UTC day, second poll: one ledger row, two observations.
    expect(afterSecond.ledger).toHaveLength(1);
    expect(afterSecond.ledger[0]!.observations).toBe(2);
    expect(capturedEvents.filter((e) => e.type === 'backup.provider_device_unhealthy')).toHaveLength(1);
    expect(capturedEvents[0]!.payload).toMatchObject({
      connectionId: fixture.connectionId,
      providerKey: 'cove',
      orgId: fixture.orgId,
      deviceId: fixture.deviceId,
      condition: 'failed',
    });

    // ---- poll 3: same condition again -> no duplicate -------------------
    capturedEvents.length = 0;
    await syncConnectionById(fixture.connectionId);
    const afterThird = await withSystemDbAccessContext(() => db
      .select()
      .from(alerts)
      .where(and(eq(alerts.orgId, fixture.orgId), eq(alerts.status, 'active'))));
    expect(afterThird).toHaveLength(1);
    expect(capturedEvents).toHaveLength(0);

    // ---- poll 4: condition clears -> resolve + recovered ----------------
    listDevices.mockResolvedValue([vendorDevice({
      name: deviceName, status: 'completed', vendorStatusCode: 5,
      lastSuccessAt: new Date(), lastCompletedAt: new Date(), errorsCount: 0,
    })]);
    await syncConnectionById(fixture.connectionId);

    const afterFourth = await withSystemDbAccessContext(async () => {
      const all = await db.select().from(alerts).where(eq(alerts.orgId, fixture.orgId));
      const [row] = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      return { all, row };
    });
    expect(afterFourth.all).toHaveLength(1);
    expect(afterFourth.all[0]!.status).toBe('resolved');
    expect(afterFourth.all[0]!.resolutionNote).toBe('Condition cleared by provider sync');
    expect(afterFourth.row!.pendingCondition).toBeNull();
    expect(capturedEvents.filter((e) => e.type === 'backup.provider_device_recovered')).toHaveLength(1);
  });

  runDb('a failed vendor enumeration deletes nothing and records the error', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fixture = await seed(unique);
    const deviceName = `srv-${unique}`;

    listCustomers.mockResolvedValue([customer(fixture.orgId)]);
    listDevices.mockResolvedValue([vendorDevice({ name: deviceName })]);
    await syncConnectionById(fixture.connectionId);

    const before = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.orgId, fixture.orgId));
      return { rows, ledger };
    });
    expect(before.rows).toHaveLength(1);
    expect(before.ledger).toHaveLength(1);

    // The adapter throws on a partial page, so a caught enumeration error must
    // never look like "every device vanished".
    listDevices.mockRejectedValueOnce(new Error('cove page 2 of 5 failed'));
    await expect(syncConnectionById(fixture.connectionId)).rejects.toThrow('cove page 2 of 5 failed');

    const after = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const customers = await db
        .select()
        .from(backupProviderCustomers)
        .where(eq(backupProviderCustomers.connectionId, fixture.connectionId));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.orgId, fixture.orgId));
      const [connection] = await db
        .select()
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, fixture.connectionId));
      return { rows, customers, ledger, connection };
    });

    expect(after.rows).toHaveLength(1);
    expect(after.customers).toHaveLength(1);
    expect(after.ledger).toHaveLength(1);
    expect(after.connection!.lastSyncStatus).toBe('error');
    expect(after.connection!.lastSyncError).toContain('cove page 2 of 5 failed');
    // Not a credential problem, so the connection stays syncable.
    expect(after.connection!.status).toBe('connected');
  });

  runDb('a device under an UNMAPPED customer is counted but never stored', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fixture = await seed(unique);

    // No external code and a name that matches no org -> stays unmapped.
    listCustomers.mockResolvedValue([{
      vendorCustomerId: 'vc-9', name: 'Nobody In Breeze', parentId: '1000',
      level: 'EndCustomer', externalCode: null,
    }]);
    listDevices.mockResolvedValue([vendorDevice({ vendorCustomerId: 'vc-9', vendorDeviceId: 'vd-9' })]);
    await syncConnectionById(fixture.connectionId);

    const result = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const [connection] = await db
        .select()
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, fixture.connectionId));
      return { rows, connection };
    });

    expect(result.rows).toHaveLength(0);
    expect(result.connection!.lastSyncUnmappedCustomers).toBe(1);
    expect(result.connection!.lastSyncUnmappedDevices).toBe(1);
    expect(result.connection!.lastSyncDevices).toBe(0);
  });
});
