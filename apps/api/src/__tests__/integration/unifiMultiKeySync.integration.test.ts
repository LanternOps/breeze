/**
 * Real-PostgreSQL contract for the multi-key UniFi sync (#11808 W2, #12277).
 *
 * Two keys on one connection; one fails. The network phase runs the real
 * collectSyncData against fake clients, then applySyncData and recordKeyResults
 * run through the production `db` pool as the non-BYPASSRLS `breeze_app` role,
 * in a system context like the worker. Seeding uses the superuser test client.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { unifiDevices, unifiIntegrationKeys, unifiIntegrations, unifiSiteMappings, unifiSyncRuns } from '../../db/schema';
import type { UnifiClient, UnifiDeviceDto } from '../../services/unifi/unifiClient';
import { UnifiApiError } from '../../services/unifi/unifiClient';
import { recordKeyResults, sealUnifiKey } from '../../services/unifi/unifiKeyService';
import { applySyncData, collectSyncData } from '../../services/unifi/unifiSyncService';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const device = (id: string): UnifiDeviceDto => ({
  unifiDeviceId: id, mac: null, name: id, model: 'U6', deviceType: 'uap', ip: null,
  firmwareVersion: '1', firmwareUpdatable: false, adoptionState: 'online', uptimeSeconds: 1, raw: { id },
});

function workingClient(): UnifiClient {
  const sites = [['h1', 's1'], ['h2', 's2'], ['h3', 's3']].map(([hostId, id]) => ({ id: id!, hostId: hostId!, name: id! }));
  return {
    listHosts: async () => ['h1', 'h2', 'h3'].map((id) => ({ id, name: id, type: 'console', model: null })),
    listSites: async () => sites,
    listSitesForSync: async () => ({ sites, hostsWithDroppedRows: new Set<string>(), rowsWithoutHostId: 0 }),
    listDevicesByHost: async () => new Map([['h1', [device('d1')]], ['h2', [device('d3')]], ['h3', [device('d4')]]]),
    listIspMetricsBySite: async () => new Map(),
  };
}

function rejectedClient(): UnifiClient {
  const reject = async (): Promise<never> => { throw new UnifiApiError('Unauthorized', 401); };
  return { listHosts: reject, listSites: reject, listSitesForSync: reject, listDevicesByHost: reject, listIspMetricsBySite: reject };
}

async function seed() {
  const admin = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const [site1, site2, site3] = await Promise.all([1, 2, 3].map(() => createSite({ orgId: org.id })));
  const otherSite = await createSite({ orgId: otherOrg.id });
  const [integration] = await admin.insert(unifiIntegrations)
    .values({ partnerId: partner.id, connectionType: 'cloud', apiKeyEncrypted: sealUnifiKey('legacy-0001') })
    .returning({ id: unifiIntegrations.id });
  const keys = await admin.insert(unifiIntegrationKeys).values([
    { integrationId: integration.id, partnerId: partner.id, label: 'Independent', apiKeyEncrypted: sealUnifiKey('key-a-1111'), createdAt: new Date('2026-01-01T00:00:00Z') },
    { integrationId: integration.id, partnerId: partner.id, label: 'Fabric', apiKeyEncrypted: sealUnifiKey('key-b-2222'), createdAt: new Date('2026-01-02T00:00:00Z'), lastSeenHostIds: ['h1'] },
  ]).returning({ id: unifiIntegrationKeys.id, label: unifiIntegrationKeys.label, lastSeenHostIds: unifiIntegrationKeys.lastSeenHostIds });
  const mappings = await admin.insert(unifiSiteMappings).values([
    { integrationId: integration.id, orgId: org.id, siteId: site1!.id, unifiHostId: 'h1', unifiSiteId: 's1' },
    { integrationId: integration.id, orgId: org.id, siteId: site2!.id, unifiHostId: 'h2', unifiSiteId: 's2' },
    { integrationId: integration.id, orgId: org.id, siteId: site3!.id, unifiHostId: 'h3', unifiSiteId: 's3' },
  ]).returning();
  const [m1] = mappings;
  await admin.insert(unifiDevices).values(['d1', 'd2'].map((id) => ({
    orgId: org.id, siteId: site1!.id, integrationId: integration.id, mappingId: m1.id, unifiDeviceId: id, raw: { id, before: true },
  })));
  return { partner, org, otherOrg, otherSite, integrationId: integration.id as string, keys, mappings };
}

describe('multi-key sync on real Postgres (#11808 W2)', () => {
  runDb('a partial run leaves the uncertain host untouched, skips a remapped mapping, and records both keys', async () => {
    const t = await seed();
    const [keyA, keyB] = t.keys;
    const [m1, m2, m3] = t.mappings;
    const before = await getTestDb().select().from(unifiDevices).where(eq(unifiDevices.integrationId, t.integrationId));

    const runStartedAt = new Date();
    const collected = await collectSyncData([
      { id: keyA.id, label: keyA.label, client: workingClient(), lastSeenHostIds: null },
      { id: keyB.id, label: keyB.label, client: rejectedClient(), lastSeenHostIds: keyB.lastSeenHostIds },
    ], t.mappings);
    expect(collected.uncertainHostIds).toEqual(new Set(['h1']));

    // m3 is remapped to another org while the sync was collecting.
    await (getTestDb() as any).update(unifiSiteMappings)
      .set({ orgId: t.otherOrg.id, siteId: t.otherSite.id, updatedAt: new Date() })
      .where(eq(unifiSiteMappings.id, m3.id));

    const result = await withSystemDbAccessContext(() =>
      applySyncData(db, { id: t.integrationId, partnerId: t.partner.id }, 'manual', t.mappings, collected));
    await withSystemDbAccessContext(() => recordKeyResults(db, {
      integrationId: t.integrationId, partnerId: t.partner.id, runStartedAt, results: collected.keyResults,
      keyLast4ById: new Map([[keyA.id, '1111']]),
    }));

    expect(result.status).toBe('partial');
    expect(result.error).toBe('1 of 2 API keys failed: "Fabric" (key rejected)');

    const after = await getTestDb().select().from(unifiDevices).where(eq(unifiDevices.integrationId, t.integrationId));
    // Uncertain h1: d1 and d2 are byte-for-byte unchanged (not written, not swept).
    for (const id of ['d1', 'd2']) {
      const was = before.find((r) => r.unifiDeviceId === id)!;
      const now = after.find((r) => r.unifiDeviceId === id)!;
      expect(now).toEqual(was);
    }
    // h2 synced normally; the remapped m3 got nothing, in either org.
    expect(after.find((r) => r.unifiDeviceId === 'd3')).toMatchObject({ mappingId: m2.id, orgId: t.org.id, isStale: false });
    expect(after.find((r) => r.unifiDeviceId === 'd4')).toBeUndefined();
    expect(after.filter((r) => r.mappingId === m1.id).map((r) => r.unifiDeviceId).sort()).toEqual(['d1', 'd2']);

    const [run] = await getTestDb().select().from(unifiSyncRuns).where(eq(unifiSyncRuns.integrationId, t.integrationId));
    expect(run!.status).toBe('partial');
    expect(run!.keyResults).toEqual([
      { keyId: keyA.id, label: 'Independent', status: 'success', hostsSeen: 3, sitesSeen: 3, error: null },
      { keyId: keyB.id, label: 'Fabric', status: 'failed', hostsSeen: null, sitesSeen: null, error: 'Unauthorized' },
    ]);
    expect(JSON.stringify(run!.keyResults)).not.toContain('key-a-1111');

    const keyRows = await getTestDb().select().from(unifiIntegrationKeys).where(eq(unifiIntegrationKeys.integrationId, t.integrationId));
    const a = keyRows.find((k) => k.id === keyA.id)!;
    const b = keyRows.find((k) => k.id === keyB.id)!;
    expect(a).toMatchObject({
      status: 'connected', lastSyncStatus: 'success', lastSyncError: null, hostsSeen: 3, sitesSeen: 3,
      lastSeenHostIds: ['h1', 'h2', 'h3'], keyLast4: '1111',
    });
    expect(a.lastOkAt).toBeInstanceOf(Date);
    expect(b).toMatchObject({ status: 'reauth_required', lastSyncStatus: 'failed', lastSyncError: 'Unauthorized', lastSeenHostIds: ['h1'] });
    expect(b.lastOkAt).toBeNull();
  });

  runDb('recordKeyResults skips a deleted key, never overwrites a newer run, and fills key_last4 only when null', async () => {
    const t = await seed();
    const [keyA, keyB] = t.keys;
    const newer = new Date('2030-01-01T00:00:00Z');
    await (getTestDb() as any).update(unifiIntegrationKeys)
      .set({ lastSyncAt: newer, lastSyncStatus: 'success', status: 'connected', keyLast4: 'zzzz' })
      .where(eq(unifiIntegrationKeys.id, keyA.id));

    const deletedKeyId = '00000000-0000-4000-8000-000000000001';
    await expect(withSystemDbAccessContext(() => recordKeyResults(db, {
      integrationId: t.integrationId,
      partnerId: t.partner.id,
      runStartedAt: new Date('2026-06-01T00:00:00Z'),
      results: [
        { keyId: keyA.id, label: 'Independent', status: 'failed', authFailure: true, hostsSeen: null, sitesSeen: null, hostIds: null, error: 'late' },
        { keyId: deletedKeyId, label: 'Gone', status: 'success', authFailure: false, hostsSeen: 1, sitesSeen: 1, hostIds: ['h1'], error: null },
        { keyId: keyB.id, label: 'Fabric', status: 'success', authFailure: false, hostsSeen: 1, sitesSeen: 1, hostIds: ['h1'], error: null },
      ],
      keyLast4ById: new Map([[keyA.id, 'aaaa'], [keyB.id, '2222']]),
    }))).resolves.toBeUndefined();

    const rows = await getTestDb().select().from(unifiIntegrationKeys).where(eq(unifiIntegrationKeys.integrationId, t.integrationId));
    const a = rows.find((k) => k.id === keyA.id)!;
    expect(a).toMatchObject({ status: 'connected', lastSyncStatus: 'success', keyLast4: 'zzzz' });
    expect(a.lastSyncAt!.toISOString()).toBe(newer.toISOString());
    expect(rows.find((k) => k.id === keyB.id)).toMatchObject({ status: 'connected', keyLast4: '2222', lastSeenHostIds: ['h1'] });

    // A second success on key B does not replace the stored last4.
    await withSystemDbAccessContext(() => recordKeyResults(db, {
      integrationId: t.integrationId,
      partnerId: t.partner.id,
      runStartedAt: new Date('2026-06-02T00:00:00Z'),
      results: [{ keyId: keyB.id, label: 'Fabric', status: 'success', authFailure: false, hostsSeen: 1, sitesSeen: 1, hostIds: ['h1'], error: null }],
      keyLast4ById: new Map([[keyB.id, '9999']]),
    }));
    const [b] = await getTestDb().select().from(unifiIntegrationKeys).where(eq(unifiIntegrationKeys.id, keyB.id));
    expect(b!.keyLast4).toBe('2222');
  });

  runDb("recordKeyResults never writes another partner's key", async () => {
    const t = await seed();
    const other = await seed();
    await withSystemDbAccessContext(() => recordKeyResults(db, {
      integrationId: t.integrationId,
      partnerId: t.partner.id,
      runStartedAt: new Date(),
      results: [{ keyId: other.keys[0].id, label: 'x', status: 'failed', authFailure: true, hostsSeen: null, sitesSeen: null, hostIds: null, error: 'x' }],
      keyLast4ById: new Map(),
    }));
    const [row] = await getTestDb().select().from(unifiIntegrationKeys).where(eq(unifiIntegrationKeys.id, other.keys[0].id));
    expect(row!.lastSyncStatus).toBeNull();
  });
});
