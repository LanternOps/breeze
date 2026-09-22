import './setup';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Proves the wave's stated invariant: a partner-owned backup provider
 * connection fans out ONLY to that partner's own organizations.
 * `autoMapCustomers` (services/backupProviders/mapping.ts) scopes its org
 * lookup to `eq(organizations.partnerId, partnerId)`, and unit tests cover
 * that filter with in-memory arrays — but nothing before this file proved it
 * on the real schema, against two real partners whose orgs and devices
 * actually coexist in the same tables.
 *
 * Stub the vendor adapter and credential codec, same as the sibling
 * `backupProviderSync.integration.test.ts` — everything else (persist,
 * mapping, device matching, ledger) runs for real against test Postgres.
 */
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
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { syncConnectionById } from '../../jobs/backupProviderSync';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface OrgFixture {
  orgId: string;
  deviceId: string;
  hostname: string;
}

interface PartnerFixture {
  partnerId: string;
  connectionId: string;
  vendorRootId: string;
  orgs: [OrgFixture, OrgFixture];
}

async function seedPartner(label: string, unique: string, sharedHostname: string): Promise<PartnerFixture> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `Fanout Partner ${label} ${unique}`, slug: `fanout-partner-${label}-${unique}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });

    const orgs: OrgFixture[] = [];
    // Org 1 in every partner shares the SAME hostname across partners on
    // purpose — this is the collision that would prove a cross-partner leak if
    // device matching (or org mapping) ever escaped its partner boundary.
    const hostnames = [sharedHostname, `${label}-2-${unique}`];
    for (let i = 0; i < 2; i++) {
      const hostname = hostnames[i]!;
      const [org] = await db
        .insert(organizations)
        .values({
          currencyCode: 'USD', partnerId: partner!.id, name: `Fanout Org ${label}${i + 1} ${unique}`,
          slug: `fanout-org-${label}${i + 1}-${unique}`, type: 'customer', status: 'active',
        })
        .returning({ id: organizations.id });
      const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Fanout Site ${label}${i + 1} ${unique}` }).returning({ id: sites.id });
      const [device] = await db
        .insert(devices)
        .values({
          orgId: org!.id, siteId: site!.id,
          agentId: `fanout-agent-${label}${i + 1}-${unique}`, hostname,
          osType: 'windows', osVersion: '2022', architecture: 'x86_64',
          agentVersion: '0.0.0-test', status: 'online',
        })
        .returning({ id: devices.id });
      orgs.push({ orgId: org!.id, deviceId: device!.id, hostname });
    }

    const vendorRootId = `${label}-root-${unique}`;
    const [connection] = await db
      .insert(backupProviderConnections)
      .values({
        partnerId: partner!.id, provider: 'cove', name: `Fanout Conn ${label} ${unique}`,
        baseUrl: 'https://api.backup.management/jsonapi',
        credentialsEncrypted: 'ciphertext', vendorRootId, vendorRootName: 'Root',
        isActive: true, status: 'connected', syncIntervalMinutes: 30,
        showProviderNameInPortal: false,
      })
      .returning({ id: backupProviderConnections.id });

    return {
      partnerId: partner!.id,
      connectionId: connection!.id,
      vendorRootId,
      orgs: orgs as [OrgFixture, OrgFixture],
    };
  });
}

function vendorCustomer(over: Record<string, unknown>) {
  return {
    vendorCustomerId: 'vc-default',
    name: 'unused',
    parentId: 'root',
    level: 'EndCustomer',
    externalCode: null as string | null,
    ...over,
  };
}

function vendorDeviceFor(vendorCustomerId: string, vendorDeviceId: string, hostname: string) {
  return {
    vendorDeviceId,
    vendorCustomerId,
    name: hostname,
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
    raw: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backup provider partner fan-out (real Postgres)', () => {
  runDb('two partners, one connection each: mapping, ledger org and device matching never cross the partner boundary', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sharedHostname = `shared-host-${unique}`;

    const partnerA = await seedPartner('a', unique, sharedHostname);
    const partnerB = await seedPartner('b', unique, sharedHostname);
    const [orgA1, orgA2] = partnerA.orgs;
    const [orgB1, orgB2] = partnerB.orgs;

    // connA's vendor customers: two that map inside partner A by external
    // code, plus one whose external code is partner B's org id — the direct
    // cross-partner leak probe. If autoMapCustomers ever dropped its
    // partnerId filter, this customer would resolve because the org id is
    // real; scoped correctly, org B's id simply isn't in org A's candidate
    // set and the customer stays unmapped.
    const customerA1Id = 'vc-a1';
    const customerA2Id = 'vc-a2';
    const customerCrossId = 'vc-a-cross';

    // connB's vendor customers: map inside partner B only.
    const customerB1Id = 'vc-b1';
    const customerB2Id = 'vc-b2';

    listCustomers.mockImplementation(async (_creds: unknown, _baseUrl: string, vendorRootId: string) => {
      if (vendorRootId === partnerA.vendorRootId) {
        return [
          vendorCustomer({ vendorCustomerId: customerA1Id, name: 'A1 unused name', externalCode: orgA1.orgId }),
          vendorCustomer({ vendorCustomerId: customerA2Id, name: 'A2 unused name', externalCode: orgA2.orgId }),
          vendorCustomer({ vendorCustomerId: customerCrossId, name: 'Cross-partner leak probe', externalCode: orgB1.orgId }),
        ];
      }
      if (vendorRootId === partnerB.vendorRootId) {
        return [
          vendorCustomer({ vendorCustomerId: customerB1Id, name: 'B1 unused name', externalCode: orgB1.orgId }),
          vendorCustomer({ vendorCustomerId: customerB2Id, name: 'B2 unused name', externalCode: orgB2.orgId }),
        ];
      }
      throw new Error(`unexpected vendorRootId ${vendorRootId}`);
    });

    listDevices.mockImplementation(async (_creds: unknown, _baseUrl: string, vendorRootId: string) => {
      if (vendorRootId === partnerA.vendorRootId) {
        return [
          // Same hostname as org B1's device — proves matching stays inside org A.
          vendorDeviceFor(customerA1Id, 'vd-a1', orgA1.hostname),
          vendorDeviceFor(customerA2Id, 'vd-a2', orgA2.hostname),
          vendorDeviceFor(customerCrossId, 'vd-a-cross', 'irrelevant-cross-host'),
        ];
      }
      if (vendorRootId === partnerB.vendorRootId) {
        return [
          vendorDeviceFor(customerB1Id, 'vd-b1', orgB1.hostname),
          vendorDeviceFor(customerB2Id, 'vd-b2', orgB2.hostname),
        ];
      }
      throw new Error(`unexpected vendorRootId ${vendorRootId}`);
    });

    await syncConnectionById(partnerA.connectionId);
    await syncConnectionById(partnerB.connectionId);

    const state = await withSystemDbAccessContext(async () => {
      const customersA = await db
        .select()
        .from(backupProviderCustomers)
        .where(eq(backupProviderCustomers.connectionId, partnerA.connectionId));
      const customersB = await db
        .select()
        .from(backupProviderCustomers)
        .where(eq(backupProviderCustomers.connectionId, partnerB.connectionId));
      const devicesA = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, partnerA.connectionId));
      const devicesB = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, partnerB.connectionId));
      const historyA = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.orgId, orgA1.orgId));
      const historyB = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.orgId, orgB1.orgId));
      return { customersA, customersB, devicesA, devicesB, historyA, historyB };
    });

    // ---- (a) each connection maps ONLY its own partner's orgs -----------
    const byVendorId = <T extends { vendorCustomerId: string }>(rows: T[], id: string) =>
      rows.find((r) => r.vendorCustomerId === id)!;

    expect(byVendorId(state.customersA, customerA1Id).orgId).toBe(orgA1.orgId);
    expect(byVendorId(state.customersA, customerA1Id).mappingSource).toBe('auto_external_code');
    expect(byVendorId(state.customersA, customerA2Id).orgId).toBe(orgA2.orgId);
    // The cross-partner probe: org B1's id is a REAL org id, just not one
    // partner A's connection is allowed to see.
    expect(byVendorId(state.customersA, customerCrossId).orgId).toBeNull();
    expect(byVendorId(state.customersA, customerCrossId).mappingSource).toBeNull();

    expect(byVendorId(state.customersB, customerB1Id).orgId).toBe(orgB1.orgId);
    expect(byVendorId(state.customersB, customerB2Id).orgId).toBe(orgB2.orgId);

    // ---- (c) a device in the other partner is never matched -------------
    // Both org A1's and org B1's devices share a hostname; each provider
    // device row must link to the device in ITS OWN org, never the other.
    const providerDeviceA1 = state.devicesA.find((d) => d.vendorDeviceId === 'vd-a1')!;
    const providerDeviceB1 = state.devicesB.find((d) => d.vendorDeviceId === 'vd-b1')!;
    expect(providerDeviceA1.orgId).toBe(orgA1.orgId);
    expect(providerDeviceA1.breezeDeviceId).toBe(orgA1.deviceId);
    expect(providerDeviceA1.breezeDeviceId).not.toBe(orgB1.deviceId);
    expect(providerDeviceA1.deviceMatchSource).toBe('auto_hostname');

    expect(providerDeviceB1.orgId).toBe(orgB1.orgId);
    expect(providerDeviceB1.breezeDeviceId).toBe(orgB1.deviceId);
    expect(providerDeviceB1.breezeDeviceId).not.toBe(orgA1.deviceId);
    expect(providerDeviceB1.deviceMatchSource).toBe('auto_hostname');

    // The unmapped cross-partner customer's device is counted but never
    // stored (mirrors the existing "unmapped customer" contract).
    expect(state.devicesA.some((d) => d.vendorDeviceId === 'vd-a-cross')).toBe(false);
    const [connA] = await withSystemDbAccessContext(() => db
      .select()
      .from(backupProviderConnections)
      .where(eq(backupProviderConnections.id, partnerA.connectionId)));
    expect(connA!.lastSyncUnmappedCustomers).toBe(1);
    expect(connA!.lastSyncUnmappedDevices).toBe(1);

    // ---- (b) ledger/history rows carry the matched DEVICE's org ---------
    const ledgerRowForA1 = state.historyA.find((h) => h.providerDeviceId === providerDeviceA1.id);
    const ledgerRowForB1 = state.historyB.find((h) => h.providerDeviceId === providerDeviceB1.id);
    expect(ledgerRowForA1).toBeDefined();
    expect(ledgerRowForA1!.orgId).toBe(orgA1.orgId);
    expect(ledgerRowForA1!.orgId).not.toBe(orgB1.orgId);
    expect(ledgerRowForB1).toBeDefined();
    expect(ledgerRowForB1!.orgId).toBe(orgB1.orgId);
    expect(ledgerRowForB1!.orgId).not.toBe(orgA1.orgId);

    // No history row for org A1 belongs to a device outside org A1 (and
    // symmetrically for org B1) — the org-scoped `WHERE h.org_id = ...`
    // filter above already guarantees this, but assert the row set sizes to
    // make a silent widening of that filter visible.
    expect(state.historyA).toHaveLength(1);
    expect(state.historyB).toHaveLength(1);
  });
});
