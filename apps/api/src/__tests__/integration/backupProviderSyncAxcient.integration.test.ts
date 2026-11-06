import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

// Stub the registry and the credential codec only. The adapter's real device
// projection feeds the real persist, mapping, device matching, alerts,
// alertService and eventBus, against the test Postgres and Redis.
const listCustomers = vi.fn();
const listDevices = vi.fn();
vi.mock('../../services/backupProviders/registry', () => ({
  BACKUP_PROVIDER_KEYS: ['axcient'] as const,
  getBackupProvider: () => ({
    key: 'axcient',
    label: 'Axcient x360Recover',
    credentialsSchema: { parse: (v: unknown) => v },
    testConnection: vi.fn(),
    listCustomers,
    listDevices,
  }),
}));
vi.mock('../../services/backupProviders/credentials', () => ({
  encryptProviderCredentials: vi.fn(() => 'ciphertext'),
  decryptProviderCredentials: vi.fn(() => ({ apiKey: 'test-axcient-key-0000' })),
}));

import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  backupProviderConnections,
  backupProviderDevices,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { getEventBus } from '../../services/eventBus';
import { syncConnectionById } from '../../jobs/backupProviderSync';
import { axcientDeviceToVendorDevice } from '../../services/backupProviders/axcient/device';
import { PROVIDER_ALERT_PARKED_NOTE } from '../../services/backupProviders/alerts';
import devices101 from '../../services/backupProviders/axcient/__fixtures__/devices-client-101.json';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Row = Record<string, unknown>;
/** Fixture devices by id: 501 NORMAL server, 503 TROUBLED/APPLIANCE_OFFLINE, 504 PARKED. */
const fixture = (id: number): Row => ({ ...(devices101.find((d) => d.id === id) as Row) });
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

interface Seeded { orgId: string; deviceId: string; connectionId: string }

async function seed(unique: string, hostname: string): Promise<Seeded> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `AX Partner ${unique}`, slug: `ax-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD', partnerId: partner!.id, name: `AX Org ${unique}`,
        slug: `ax-org-${unique}`, type: 'customer', status: 'active',
      })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `AX Site ${unique}` }).returning({ id: sites.id });
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id, siteId: site!.id,
        agentId: `ax-agent-${unique}`, hostname,
        osType: 'windows', osVersion: '2022', architecture: 'x86_64',
        agentVersion: '0.0.0-test', status: 'online',
      })
      .returning({ id: devices.id });
    const [connection] = await db
      .insert(backupProviderConnections)
      .values({
        partnerId: partner!.id, provider: 'axcient', name: `AX Conn ${unique}`,
        baseUrl: 'https://axapi.axcient.com/x360recover',
        credentialsEncrypted: 'ciphertext', vendorRootId: '26', vendorRootName: 'Synthetic MSP',
        isActive: true, status: 'connected', syncIntervalMinutes: 30,
        showProviderNameInPortal: false,
      })
      .returning({ id: backupProviderConnections.id });
    return { orgId: org!.id, deviceId: device!.id, connectionId: connection!.id };
  });
}

/**
 * Axcient `client_code` is a short code, so real mappings are manual. Carrying
 * the org id in `externalCode` is the test's shortcut onto the auto mapper.
 */
function vendorAccount(orgId: string, device: Row) {
  listCustomers.mockResolvedValue([
    { vendorCustomerId: '101', name: 'Synthetic Client A', parentId: null, level: '0', externalCode: orgId },
  ]);
  listDevices.mockResolvedValue({ devices: [axcientDeviceToVendorDevice(device)], failedCustomerIds: [] });
}

async function readState(seeded: Seeded) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(backupProviderDevices)
      .where(eq(backupProviderDevices.connectionId, seeded.connectionId));
    const open = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.orgId, seeded.orgId), eq(alerts.status, 'active')));
    return { row: row!, open };
  });
}

const capturedEvents: string[] = [];
let unsubscribes: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  capturedEvents.length = 0;
  const bus = getEventBus();
  unsubscribes = (['backup.provider_device_unhealthy', 'backup.provider_device_recovered'] as const).map((type) =>
    bus.subscribe(type, (event) => {
      capturedEvents.push(event.type);
      return Promise.resolve();
    }));
});

afterEach(() => {
  for (const off of unsubscribes) off();
  unsubscribes = [];
});

const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('Axcient x360Recover sync (real Postgres + Redis)', () => {
  runDb('a matched SERVER flips the Breeze device to protected via hostname', async () => {
    const seeded = await seed(uniqueId(), 'SYN-SRV-01');
    vendorAccount(seeded.orgId, { ...fixture(501), latest_vault_rp: daysAgo(0.1) });
    await syncConnectionById(seeded.connectionId);

    const { row, open } = await readState(seeded);
    expect(row.provider).toBe('axcient');
    expect(row.vendorDeviceId).toBe('501');
    expect(row.orgId).toBe(seeded.orgId);
    expect(row.breezeDeviceId).toBe(seeded.deviceId);
    expect(row.deviceMatchSource).toBe('auto_hostname');
    expect(row.status).toBe('completed');
    expect(row.dataSources).toEqual(['image']);
    expect(row.pendingCondition).toBeNull();
    expect(open).toHaveLength(0);
  });

  runDb('a TROUBLED device raises a device alert on the second poll', async () => {
    const seeded = await seed(uniqueId(), 'SYN-SRV-02');
    vendorAccount(seeded.orgId, fixture(503));

    await syncConnectionById(seeded.connectionId);
    const first = await readState(seeded);
    expect(first.row.status).toBe('failed');
    expect(first.row.pendingCondition).toBe('failed');
    expect(first.open).toHaveLength(0);

    await syncConnectionById(seeded.connectionId);
    const second = await readState(seeded);
    expect(second.row.pendingCondition).toBe('raised:failed');
    expect(second.open).toHaveLength(1);
    expect(second.open[0]!.deviceId).toBe(seeded.deviceId);
    expect(second.open[0]!.title).toContain('Backup failed on');
    expect(capturedEvents).toEqual(['backup.provider_device_unhealthy']);
  });

  runDb('a PARKED device raises nothing across two polls', async () => {
    const seeded = await seed(uniqueId(), 'SYN-SRV-03');
    // Ten days without a recovery point would be `stale` for any other status.
    vendorAccount(seeded.orgId, { ...fixture(504), latest_local_rp: daysAgo(10) });

    for (let poll = 0; poll < 2; poll++) {
      await syncConnectionById(seeded.connectionId);
      const { row, open } = await readState(seeded);
      expect(row.status).toBe('paused');
      expect(row.breezeDeviceId).toBe(seeded.deviceId);
      expect(row.pendingCondition).toBeNull();
      expect(open).toHaveLength(0);
    }
    expect(capturedEvents).toEqual([]);
  });

  runDb('parking a device with an open alert retires the alert without announcing a recovery', async () => {
    const seeded = await seed(uniqueId(), 'SYN-SRV-02');
    vendorAccount(seeded.orgId, fixture(503));
    await syncConnectionById(seeded.connectionId);
    await syncConnectionById(seeded.connectionId);
    const raised = await readState(seeded);
    expect(raised.open).toHaveLength(1);
    capturedEvents.length = 0;

    vendorAccount(seeded.orgId, { ...fixture(503), current_health_status: { status: 'PARKED', reason: 'PARKED_BY_OPERATOR' } });
    await syncConnectionById(seeded.connectionId);
    const parked = await readState(seeded);
    expect(parked.row.status).toBe('paused');
    expect(parked.row.pendingCondition).toBeNull();
    expect(parked.open).toHaveLength(0);
    const [resolved] = await withSystemDbAccessContext(() => db
      .select()
      .from(alerts)
      .where(eq(alerts.id, raised.open[0]!.id)));
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.resolutionNote).toBe(PROVIDER_ALERT_PARKED_NOTE);
    expect(resolved!.resolutionReason).toBe('source_retired');
    expect(capturedEvents).toEqual([]);
  });

  runDb('persists verified-bootable evidence and no screenshot URL', async () => {
    const seeded = await seed(uniqueId(), 'SYN-SRV-01');
    vendorAccount(seeded.orgId, fixture(501));
    await syncConnectionById(seeded.connectionId);

    const { row } = await readState(seeded);
    expect(row.verifiedBootable).toBe(true);
    expect(row.verifiedBootableAt).toEqual(new Date('2026-11-05T03:12:00Z'));
    expect(row.verifiedBootableFailedChecks).toEqual([]);
    const [raw] = await withSystemDbAccessContext(() => db
      .select({ text: sql<string>`${backupProviderDevices.vendorRaw}::text` })
      .from(backupProviderDevices)
      .where(eq(backupProviderDevices.id, row.id)));
    expect(raw!.text).not.toContain('screenshot');
    expect(raw!.text).toContain('device_details_page_url');

    // Evidence that disappears on a later sync clears, never keeps a stale pass.
    vendorAccount(seeded.orgId, { ...fixture(501), latest_autoverify_details: undefined });
    await syncConnectionById(seeded.connectionId);
    const after = await readState(seeded);
    expect(after.row.verifiedBootable).toBeNull();
    expect(after.row.verifiedBootableAt).toBeNull();
    expect(after.row.verifiedBootableFailedChecks).toBeNull();
  });
});
