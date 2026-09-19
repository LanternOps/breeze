/**
 * Manual network assets — data model + scan-upsert contract (#5213 W01).
 *
 * Migration under test:
 * `2026-10-14-100100-discovered-assets-manual-source.sql`.
 *
 * Everything here needs a REAL Postgres: the partial unique index, the two
 * CHECK constraints and the "a scan re-finds a manual row" path are all
 * decided by the database at write time. A compiled-SQL mock cannot observe
 * any of them — in particular an `ON CONFLICT` that fails to repeat the
 * partial index's predicate raises 42P10 only against a live server.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, discoveredAssets, discoveryJobs, discoveryProfiles } from '../../db/schema';
import { unifiCollectors, unifiIntegrations } from '../../db/schema/unifi';
import { processResults } from '../../jobs/discoveryWorker';
import { reconcileTelemetry } from '../../services/unifi/unifiTelemetryService';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

/**
 * Makes every `select ... from discovered_assets` come back empty so the UniFi
 * writer misses its own lookups and is forced down the INSERT ... ON CONFLICT
 * branch — the only way to exercise the partial-index arbiter deterministically
 * (in production it is reached by a race with agent discovery). Mirrors the
 * helper of the same name in unifiAssetTypeSource.integration.test.ts.
 */
function dbWithBlindAssetLookups(database: any) {
  const emptyChain: any = {
    where: () => emptyChain,
    limit: () => emptyChain,
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return {
    ...database,
    select: (...args: any[]) => {
      const real = database.select(...args);
      return {
        ...real,
        from: (table: any) => (table === discoveredAssets ? emptyChain : real.from(table)),
      };
    },
    insert: database.insert.bind(database),
    update: database.update.bind(database),
    delete: database.delete.bind(database),
  };
}

let orgId: string;
let siteId: string;
let profileId: string;
let jobId: string;

beforeEach(async () => {
  const partner = await createPartner({});
  const org = await createOrganization({ partnerId: partner.id });
  orgId = org.id;
  const site = await createSite({ orgId });
  siteId = site.id;

  const raw = getTestDb();
  const [profile] = await raw
    .insert(discoveryProfiles)
    .values({ orgId, siteId, name: 'manual-asset-suite', subnets: ['10.4.4.0/24'] })
    .returning();
  profileId = profile!.id;
  const [job] = await raw
    .insert(discoveryJobs)
    .values({ profileId, orgId, siteId, status: 'running' })
    .returning();
  jobId = job!.id;
});

afterEach(async () => {
  const raw = getTestDb();
  // Children before parents: unifi_device_telemetry.discovered_asset_id has no
  // ON DELETE, so it must go first or the asset delete raises 23503.
  await raw.execute(sql`
    delete from unifi_device_telemetry where discovered_asset_id in
      (select id from discovered_assets where org_id = ${orgId})`);
  await raw.execute(sql`
    delete from unifi_clients where discovered_asset_id in
      (select id from discovered_assets where org_id = ${orgId})`);
  await raw.execute(sql`delete from unifi_collectors where org_id = ${orgId}`);
  await raw.delete(discoveredAssets).where(eq(discoveredAssets.orgId, orgId));
  await raw.delete(discoveryJobs).where(eq(discoveryJobs.orgId, orgId));
  await raw.delete(discoveryProfiles).where(eq(discoveryProfiles.orgId, orgId));
});

async function insertManualAsset(values: Record<string, unknown>): Promise<string> {
  const raw = getTestDb();
  const [row] = await raw
    .insert(discoveredAssets)
    .values({
      orgId,
      siteId,
      source: 'manual',
      approvalStatus: 'approved',
      typeSource: 'manual',
      isOnline: false,
      ...values,
    } as never)
    .returning({ id: discoveredAssets.id });
  return row!.id;
}

describe('manual network assets — data model (#5213)', () => {
  it('permits many IP-less rows in one org but still rejects a duplicate IP', async () => {
    await insertManualAsset({ url: 'https://a.example', assetType: 'website' });
    await insertManualAsset({ url: 'https://b.example', assetType: 'website' });

    const raw = getTestDb();
    const ipless = await raw.execute(sql`
      select count(*)::int as n from discovered_assets
       where org_id = ${orgId} and ip_address is null`);
    expect((ipless as unknown as { n: number }[])[0]!.n).toBe(2);

    await raw.insert(discoveredAssets).values({ orgId, siteId, ipAddress: '10.9.9.9', source: 'scan' } as never);
    await expect(
      raw.insert(discoveredAssets).values({ orgId, siteId, ipAddress: '10.9.9.9', source: 'scan' } as never),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
  });

  it('rejects a non-manual row with no IP', async () => {
    const raw = getTestDb();
    await expect(
      raw.insert(discoveredAssets).values({ orgId, siteId, source: 'scan' } as never),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  });

  it('rejects a manual row with no identity at all', async () => {
    const raw = getTestDb();
    await expect(
      raw.insert(discoveredAssets).values({
        orgId, siteId, source: 'manual', approvalStatus: 'approved', typeSource: 'manual',
      } as never),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  });

  it('defaults source to scan and leaves no pre-existing row null', async () => {
    const raw = getTestDb();
    await raw.insert(discoveredAssets).values({ orgId, siteId, ipAddress: '10.4.4.1' } as never);
    const rows = await raw.execute(sql`
      select count(*)::int as n from discovered_assets where source is null`);
    expect((rows as unknown as { n: number }[])[0]!.n).toBe(0);
    const [row] = await raw
      .select({ source: discoveredAssets.source })
      .from(discoveredAssets)
      .where(eq(discoveredAssets.ipAddress, '10.4.4.1'));
    expect(row!.source).toBe('scan');
  });
});

describe('manual network assets — scan upsert (#5213)', () => {
  it("a scan of a manual row's IP updates in place and preserves operator fields", async () => {
    const id = await insertManualAsset({
      ipAddress: '10.4.4.4',
      label: 'Warehouse printer',
      hostname: 'wh-print',
      manufacturer: 'Operator Co',
      model: 'OP-1',
      assetType: 'printer',
    });

    await withSystemDbAccessContext(() => processResults({
      type: 'process-results',
      jobId,
      profileId,
      orgId,
      siteId,
      hostsScanned: 1,
      hostsDiscovered: 1,
      hosts: [{ ip: '10.4.4.4', hostname: 'scanner-guess', mac: 'aa:bb:cc:dd:ee:ff' } as never],
    }));

    const raw = getTestDb();
    const rows = await raw
      .select()
      .from(discoveredAssets)
      .where(eq(discoveredAssets.ipAddress, '10.4.4.4'));
    expect(rows).toHaveLength(1);          // no duplicate row
    const row = rows[0]!;
    expect(row.id).toBe(id);               // same identity
    expect(row.source).toBe('manual');     // not relabelled
    expect(row.label).toBe('Warehouse printer');
    expect(row.hostname).toBe('wh-print'); // operator value survives the scan
    expect(row.manufacturer).toBe('Operator Co');
    expect(row.model).toBe('OP-1');
    expect(row.assetType).toBe('printer');
    expect(row.lastSeenAt).not.toBeNull(); // but liveness DID update
  });

  it('a scan DOES overwrite hostname/manufacturer/model on a non-manual row', async () => {
    // Positive control: without it, a guard that simply never writes those
    // columns would pass the assertion above vacuously.
    const raw = getTestDb();
    await raw.insert(discoveredAssets).values({
      orgId, siteId, ipAddress: '10.4.4.7', source: 'scan',
      hostname: 'stale-name', manufacturer: 'Stale Co', model: 'STALE-1',
      approvalStatus: 'approved',
    } as never);

    await withSystemDbAccessContext(() => processResults({
      type: 'process-results',
      jobId,
      profileId,
      orgId,
      siteId,
      hostsScanned: 1,
      hostsDiscovered: 1,
      hosts: [{ ip: '10.4.4.7', hostname: 'fresh-name', mac: 'aa:bb:cc:dd:ee:01' } as never],
    }));

    const [row] = await raw
      .select()
      .from(discoveredAssets)
      .where(eq(discoveredAssets.ipAddress, '10.4.4.7'));
    expect(row!.hostname).toBe('fresh-name');
  });

  it('accepts a manual row identified by hostname alone', async () => {
    // The third arm of discovered_assets_manual_identity_chk (ip OR hostname OR
    // url). The other two arms are covered above; without this one the CHECK
    // could reject hostname-only rows and no test would notice.
    const id = await insertManualAsset({ hostname: 'printer.lan' });
    const raw = getTestDb();
    const [row] = await raw.select().from(discoveredAssets).where(eq(discoveredAssets.id, id));
    expect(row!.hostname).toBe('printer.lan');
    expect(row!.ipAddress).toBeNull();
    expect(row!.url).toBeNull();
  });

  it('does not raise device_disappeared for a never-scanned manual IP', async () => {
    await insertManualAsset({ ipAddress: '10.4.4.5' });

    await withSystemDbAccessContext(() => processResults({
      type: 'process-results',
      jobId,
      profileId,
      orgId,
      siteId,
      hostsScanned: 1,
      hostsDiscovered: 1,
      hosts: [{ ip: '10.4.4.6' } as never],
    }));

    const raw = getTestDb();
    const events = await raw.execute(sql`
      select count(*)::int as n from network_change_events
       where org_id = ${orgId} and event_type = 'device_disappeared'`);
    expect((events as unknown as { n: number }[])[0]!.n).toBe(0);
  });
});

describe('UniFi telemetry upsert against the partial index (#5213)', () => {
  /**
   * The telemetry writer's ON CONFLICT targets the now-PARTIAL
   * discovered_assets_org_ip_unique. Postgres only INFERS a partial unique
   * index when the statement repeats its predicate; without `targetWhere` the
   * statement raises 42P10 at runtime — which no compiled-SQL mock can observe.
   * This is the live-server proof for that path.
   */
  it('absorbs a colliding non-NULL IP without 42P10 and does not relabel the row', async () => {
    const raw = getTestDb() as any;
    const unique = Math.random().toString(36).slice(2, 8);
    const [device] = await raw.insert(devices).values({
      orgId, siteId,
      agentId: `unifi-collector-agent-${unique}`,
      hostname: `unifi-collector-host-${unique}`,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64',
      agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id });
    const partnerId = (await raw.execute(sql`
      select partner_id from organizations where id = ${orgId}`)) as unknown as { partner_id: string }[];
    const [integration] = await raw.insert(unifiIntegrations)
      .values({ partnerId: partnerId[0]!.partner_id, apiKeyEncrypted: 'test-cloud-key' })
      .returning({ id: unifiIntegrations.id });
    const [collector] = await raw.insert(unifiCollectors).values({
      integrationId: integration.id, orgId, siteId,
      unifiHostId: `host-${unique}`, collectorDeviceId: device.id,
      controllerUrl: `https://unifi-${unique}.example`,
      localApiKeyEncrypted: 'test-local-key',
    }).returning({ id: unifiCollectors.id });

    // The colliding row an agent scan would have written a moment earlier.
    const manualId = await insertManualAsset({ ipAddress: '10.4.4.9', hostname: 'operator-name' });

    await reconcileTelemetry(dbWithBlindAssetLookups(raw), {
      collectorId: collector.id,
      polledAt: new Date().toISOString(),
      firmwareOk: true,
      devices: [{ unifiDeviceId: `ud-${unique}`, mac: 'aa:bb:cc:11:22:33', name: 'AP-1',
                  raw: { ipAddress: '10.4.4.9' } } as never],
      clients: [],
    });

    const rows = await raw.select().from(discoveredAssets)
      .where(eq(discoveredAssets.ipAddress, '10.4.4.9'));
    expect(rows).toHaveLength(1);            // the partial arbiter was inferred
    expect(rows[0]!.id).toBe(manualId);
    expect(rows[0]!.source).toBe('manual');  // conflict branch never rewrites source
  });
});
