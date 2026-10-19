import './setup';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { canonicalizeUnifiResource, canonicalizeUnifiResourceV2, type UnifiResource, type UnifiResourceV2, type UnifiTopologyV1, type UnifiTopologyV2 } from '@breeze/shared';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v1.json';
import { closeDb, db, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';
import { negotiateTopologyContext, resetTopologyProducerAuthoritiesForTest, resetTopologyTelemetryAuthoritiesForTest } from '../../services/topology/collectionAuthority';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { adaptUnifiTopology } from '../../services/topology/unifiAdapter';
import { currentUnifiCollectorTopology, loadUnifiCollector, unifiTopologyAdvertisement } from '../../services/topology/unifiAuthority';
import { materializeUnifiWifiCurrentState } from '../../services/topology/unifiWifiMaterializer';
import { registerTopologyPhysicalAuthorities } from '../../services/topology/physicalAuthorities';
import { reconcileTelemetry } from '../../services/unifi/unifiTelemetryService';

afterAll(() => closeDb());
afterEach(() => { resetTopologyProducerAuthoritiesForTest(); resetTopologyTelemetryAuthoritiesForTest(); });

/**
 * UniFi Wi-Fi monitoring (topology v2): accepted v2 resources materialize into the existing
 * `unifi_device_telemetry` row, in one batched upsert, under the same collector-site authority
 * as the structural topology. Spec sections 7, 8, 12, 13 and 14.3.
 */
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(() => db.transaction(fn));
type Row = Record<string, unknown>;
const ON = { materialization: true, physical: true, interfaceHealth: true };

async function fixture(flags: Record<string, boolean> = ON) {
  registerTopologyPhysicalAuthorities();
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  const test = getTestDb();
  const collectorDevice = crypto.randomUUID(), integrationId = crypto.randomUUID(), collectorId = crypto.randomUUID();
  await test.execute(sql`UPDATE organizations SET settings=${JSON.stringify({ topologyFeatureFlags: flags })}::jsonb WHERE id=${scope.orgId}::uuid`);
  await test.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash)
    VALUES (${collectorDevice}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${collectorDevice},'collector','linux','1','amd64','1',${'a'.repeat(64)})`);
  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(collectorDevice)));
  if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
  await sys(async () => {
    await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${integrationId}::uuid, ${tenant.partnerId}::uuid, 'k')`);
    await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
      VALUES (${collectorId}::uuid, ${integrationId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'host:1', ${collectorDevice}::uuid, 'https://host-1', 'k')`);
    await db.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
      VALUES (${integrationId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'host:1', 'default')`);
  });

  const resource = (kind: UnifiResourceV2['kind'], rows: unknown[], outcome = 'complete') => ({
    controllerSiteId: 'default', kind, contentDigest: '0'.repeat(64), outcome, ...(outcome === 'partial' ? { reasonCode: 'limit_exceeded' } : {}), rowCount: rows.length, rows,
  }) as unknown as UnifiResourceV2;
  let sequence = 1_790_000_000_000;
  const report = async (resources: UnifiResourceV2[], offsetMs: number): Promise<UnifiTopologyV2> => {
    const collector = (await sys(() => loadUnifiCollector(collectorId)))!;
    const current = (await sys(() => currentUnifiCollectorTopology(collectorDevice, collector)))!;
    for (const r of resources) r.contentDigest = createHash('sha256').update(canonicalizeUnifiResourceV2(current, r)).digest('hex');
    return { version: 2, producerEpoch: current.producerEpoch, snapshotId: crypto.randomUUID(), sequence: String(++sequence),
      capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 60, resources } as UnifiTopologyV2;
  };
  // A real v1 report (the frozen v1 vector) bound to the same producer identity and epoch, for the v2 -> v1 fallback path.
  const reportV1 = async (offsetMs: number): Promise<UnifiTopologyV1> => {
    const collector = (await sys(() => loadUnifiCollector(collectorId)))!;
    const current = (await sys(() => currentUnifiCollectorTopology(collectorDevice, collector)))!;
    const vector = vectors.vectors[0]!;
    const deviceList = { ...structuredClone(vector.report.resources.find(r => r.kind === 'device_list')!), controllerSiteId: 'default' } as unknown as UnifiResource;
    deviceList.contentDigest = createHash('sha256').update(canonicalizeUnifiResource(current, deviceList)).digest('hex');
    return { ...structuredClone(vector.report), producerEpoch: current.producerEpoch, snapshotId: crypto.randomUUID(), sequence: String(++sequence),
      capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, resources: [deviceList] } as unknown as UnifiTopologyV1;
  };
  const adaptV1 = async (r: UnifiTopologyV1) => sys(async () => adaptUnifiTopology(collectorDevice, (await loadUnifiCollector(collectorId))!, r));
  const adapt = async (r: UnifiTopologyV2) => sys(async () => adaptUnifiTopology(collectorDevice, (await loadUnifiCollector(collectorId))!, r));
  const rows = async () => {
    const result = await test.execute(sql`SELECT unifi_device_id, org_id::text, site_id::text, mac, name, controller_state, wifi_capable, num_clients, uptime_seconds, cpu_pct, mem_pct,
        tx_bytes, rx_bytes, uplink_rx_rate_bps, uplink_tx_rate_bps, wifi_radio_overview, wifi_radio_statistics,
        device_inventory_observed_at, wifi_detail_observed_at, wifi_statistics_observed_at, wifi_clients_observed_at,
        statistics_last_heartbeat_at, statistics_next_heartbeat_at
      FROM unifi_device_telemetry WHERE collector_id=${collectorId}::uuid ORDER BY unifi_device_id`);
    return new Map((result as unknown as Row[]).map(r => [String(r.unifi_device_id), r]));
  };
  return { scope, tenant, collectorDevice, collectorId, integrationId, resource, report, reportV1, adapt, adaptV1, rows, test };
}

const apRow = (id: string) => ({ rowKey: id, deviceId: id, mac: null, name: id, model: 'U6', ipAddress: null, state: 'ONLINE', features: ['accessPoint'], interfaces: ['ports', 'radios'] });
const switchRow = (id: string) => ({ rowKey: id, deviceId: id, mac: null, name: id, model: 'USW', ipAddress: null, state: 'ONLINE', features: ['switching'], interfaces: ['ports'] });
const clientRow = (id: string, uplink: string | null, type = 'WIRELESS') => ({ rowKey: id, clientId: id, mac: null, clientType: type, uplinkDeviceId: uplink, name: null, ipAddress: null, uplinkPortIndex: null, ssid: null, vlan: null, signalDbm: null });
const detailRow = (id: string, radios: unknown) => ({ rowKey: id, deviceId: id, uplinkDeviceId: null, uplinkPortIndex: null, ports: [], radios });
const statRow = (id: string, over: Record<string, unknown> = {}) => ({ rowKey: id, deviceId: id, uptimeSeconds: 100, cpuUtilizationPct: 1.5, memoryUtilizationPct: 40, uplinkRxRateBps: 10, uplinkTxRateBps: 20,
  lastHeartbeatAt: null, nextHeartbeatAt: null, radios: [{ frequencyGHz: 5, txRetriesPct: 0 }], ...over });
const OVERVIEW = [{ frequencyGHz: 5, channel: 44, channelWidthMHz: 40, wlanStandard: '802.11ax' }];

describe('UniFi Wi-Fi current-state materializer', () => {
  it('materializes the typed Wi-Fi fields into the existing telemetry row and never touches the byte counters', async () => {
    const f = await fixture();
    const poll = await f.report([
      f.resource('device_list', [apRow('ap-1'), apRow('ap-2'), switchRow('sw-1')]),
      f.resource('client_list', [clientRow('c1', 'ap-1'), clientRow('c2', 'ap-1'), clientRow('c3', 'ap-1', 'WIRED'), clientRow('c4', 'sw-1')]),
      f.resource('device_details', [detailRow('ap-1', OVERVIEW), detailRow('ap-2', null)]),
      f.resource('statistics', [statRow('ap-1'), statRow('ap-2', { cpuUtilizationPct: null, uplinkRxRateBps: null })]),
    ], -30_000);
    expect((await f.adapt(poll)).accepted).toBe(true);
    const rows = await f.rows();
    const ap1 = rows.get('ap-1')!;
    expect(ap1).toMatchObject({ controller_state: 'ONLINE', wifi_capable: true, num_clients: 2 });
    expect(Number(ap1.cpu_pct)).toBe(1.5);
    expect(Number(ap1.uplink_rx_rate_bps)).toBe(10);
    expect(Number(ap1.uplink_tx_rate_bps)).toBe(20);
    expect(ap1.wifi_radio_overview).toEqual(OVERVIEW);
    expect(ap1.wifi_radio_statistics).toEqual([{ frequencyGHz: 5, txRetriesPct: 0 }]);
    // Rates are bits per second and never land in the byte counters.
    expect(ap1.tx_bytes).toBeNull();
    expect(ap1.rx_bytes).toBeNull();
    // A measured zero client count for a capable AP, and no count at all for a switch (even with a client on it).
    expect(rows.get('ap-2')!.num_clients).toBe(0);
    expect(rows.get('ap-2')!.cpu_pct).toBeNull();
    expect(rows.get('sw-1')).toMatchObject({ wifi_capable: false, num_clients: null });
    // The tenant of the written row is the already-authorized scope.
    expect(ap1).toMatchObject({ org_id: f.scope.orgId, site_id: f.scope.siteId });
  });

  it('is one batched statement for the whole poll, not one per AP', async () => {
    const f = await fixture();
    const aps = Array.from({ length: 25 }, (_, i) => `ap-${i}`);
    const poll = await f.report([f.resource('device_list', aps.map(apRow)), f.resource('statistics', aps.map(id => statRow(id)))], -30_000);
    const collector = (await sys(() => loadUnifiCollector(f.collectorId)))!;
    const accepted = poll.resources.map(resource => ({ resource, scope: f.scope, authorityKey: `${f.collectorId}:default` }));
    const receipt = await sys(() => materializeUnifiWifiCurrentState({ collector, report: poll, accepted }));
    expect(receipt).toEqual({ rows: 25, statements: 1 });
    expect((await f.rows()).size).toBe(25);
  });

  it('is idempotent: replaying the same poll changes nothing and creates no duplicates', async () => {
    const f = await fixture();
    const resources = () => [f.resource('device_list', [apRow('ap-1')]), f.resource('statistics', [statRow('ap-1')])];
    await f.adapt(await f.report(resources(), -30_000));
    const first = (await f.rows()).get('ap-1')!;
    await f.adapt(await f.report(resources(), -30_000));
    const rows = await f.rows();
    expect(rows.size).toBe(1);
    expect(rows.get('ap-1')).toMatchObject({ cpu_pct: first.cpu_pct, num_clients: first.num_clients, controller_state: 'ONLINE' });
  });

  it('a present row with an omitted field clears it, a measured zero stays zero, and an omitted row keeps its value and timestamp', async () => {
    const f = await fixture();
    await f.adapt(await f.report([
      f.resource('device_list', [apRow('ap-1'), apRow('ap-2')]),
      f.resource('statistics', [statRow('ap-1', { cpuUtilizationPct: 5 }), statRow('ap-2', { cpuUtilizationPct: 7 })]),
    ], -60_000));
    const before = await f.rows();
    expect(Number(before.get('ap-2')!.cpu_pct)).toBe(7);
    // Poll 2: only ap-1 is in this (rotated, partial) statistics resource; its cpu is now omitted and its rates are measured zero.
    await f.adapt(await f.report([
      f.resource('device_list', [apRow('ap-1'), apRow('ap-2')]),
      f.resource('statistics', [statRow('ap-1', { cpuUtilizationPct: null, uplinkRxRateBps: 0, uplinkTxRateBps: 0 })], 'partial'),
    ], -30_000));
    const after = await f.rows();
    const ap1 = after.get('ap-1')!;
    expect(ap1.cpu_pct).toBeNull();
    expect(Number(ap1.uplink_rx_rate_bps)).toBe(0);
    expect(Number(ap1.uplink_tx_rate_bps)).toBe(0);
    expect(new Date(String(ap1.wifi_statistics_observed_at)).getTime()).toBeGreaterThan(new Date(String(before.get('ap-1')!.wifi_statistics_observed_at)).getTime());
    const ap2 = after.get('ap-2')!;
    expect(Number(ap2.cpu_pct)).toBe(7);
    expect(ap2.wifi_statistics_observed_at).toEqual(before.get('ap-2')!.wifi_statistics_observed_at);
    // The inventory family still refreshed for the omitted-statistics device.
    expect(new Date(String(ap2.device_inventory_observed_at)).getTime()).toBeGreaterThan(new Date(String(before.get('ap-2')!.device_inventory_observed_at)).getTime());
  });

  it('a partial client list leaves the last wireless count and its timestamp untouched; a later complete list refreshes them', async () => {
    const f = await fixture();
    const list = f.resource.bind(f);
    await f.adapt(await f.report([list('device_list', [apRow('ap-1')]), list('client_list', [clientRow('c1', 'ap-1'), clientRow('c2', 'ap-1')])], -90_000));
    const first = (await f.rows()).get('ap-1')!;
    expect(first.num_clients).toBe(2);
    await f.adapt(await f.report([list('device_list', [apRow('ap-1')]), list('client_list', [clientRow('c1', 'ap-1')], 'partial')], -60_000));
    const partial = (await f.rows()).get('ap-1')!;
    expect(partial.num_clients).toBe(2);
    expect(partial.wifi_clients_observed_at).toEqual(first.wifi_clients_observed_at);
    await f.adapt(await f.report([list('device_list', [apRow('ap-1')]), list('client_list', [clientRow('c1', 'ap-1')])], -30_000));
    expect((await f.rows()).get('ap-1')!.num_clients).toBe(1);
  });

  it('writes nothing while the interface-health gate is off, and the v1/v2 advertisement follows the same gate', async () => {
    const off = await fixture({ materialization: true, physical: true, interfaceHealth: false });
    const poll = await off.report([off.resource('device_list', [apRow('ap-1')]), off.resource('statistics', [statRow('ap-1')])], -30_000);
    expect((await off.adapt(poll)).accepted).toBe(true); // the structural receipt is unaffected
    expect((await off.rows()).size).toBe(0);
    expect(await sys(() => unifiTopologyAdvertisement(off.collectorDevice, off.collectorId))).toMatchObject({ acceptedUnifiTopologyVersions: [1] });

    const on = await fixture();
    expect(await sys(() => unifiTopologyAdvertisement(on.collectorDevice, on.collectorId))).toMatchObject({ acceptedUnifiTopologyVersions: [1, 2] });
  });

  it('lets an agent that emitted v2 fall back to v1 under the same producer epoch, with no schema or digest ambiguity', async () => {
    const f = await fixture();
    const v2 = await f.report([f.resource('device_list', [apRow('ap-1')]), f.resource('statistics', [statRow('ap-1')])], -30_000);
    expect((await f.adapt(v2)).accepted).toBe(true);
    const before = (await f.rows()).get('ap-1')!;

    // The v2 advertisement is gone (rollback): the agent emits exact v1 under the same producer authority and epoch.
    const v1 = await f.reportV1(-20_000);
    expect(v1.producerEpoch).toBe(v2.producerEpoch);
    expect((await f.adaptV1(v1)).accepted).toBe(true);
    // A v1 poll neither erases nor rewrites the Wi-Fi current state.
    const after = (await f.rows()).get('ap-1')!;
    expect(after).toMatchObject({ controller_state: 'ONLINE', wifi_capable: true, uplink_rx_rate_bps: before.uplink_rx_rate_bps });
    expect(after.wifi_statistics_observed_at).toEqual(before.wifi_statistics_observed_at);

    // And the same agent can move forward to v2 again under that epoch.
    const again = await f.report([f.resource('device_list', [apRow('ap-1')]), f.resource('statistics', [statRow('ap-1', { uplinkRxRateBps: 99 })])], -10_000);
    expect(again.producerEpoch).toBe(v2.producerEpoch);
    expect((await f.adapt(again)).accepted).toBe(true);
    expect(Number((await f.rows()).get('ap-1')!.uplink_rx_rate_bps)).toBe(99);
  });

  it('keeps the exact collector/controller-site/org authority: a controller site mapped to another org is rejected and materializes nothing', async () => {
    const f = await fixture();
    const other = await createTopologyTenant();
    // The collector keeps a valid mapping in its own org (so it still advertises topology); only the controller site
    // that carries the report is mapped to another org. That is the exact case the authority must fence.
    await f.test.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
      VALUES (${f.integrationId}::uuid, ${f.scope.orgId}::uuid, ${f.scope.siteId}::uuid, 'host:1', 'spare')`);
    await f.test.execute(sql`UPDATE unifi_site_mappings SET org_id=${other.orgId}::uuid, site_id=${other.siteId}::uuid
      WHERE integration_id=${f.integrationId}::uuid AND unifi_site_id='default'`);
    const receipt = await f.adapt(await f.report([f.resource('device_list', [apRow('ap-1')]), f.resource('statistics', [statRow('ap-1')])], -30_000));
    expect(receipt.accepted).toBe(false);
    expect(receipt.resources).toHaveLength(2);
    expect(receipt.resources.every(r => !r.accepted && r.reason === 'controller_site_other_org')).toBe(true);
    expect((await f.rows()).size).toBe(0);
  });

  it('never writes Wi-Fi state into a row that currently belongs to another site', async () => {
    const f = await fixture();
    const resources = () => [f.resource('device_list', [apRow('ap-1')]), f.resource('statistics', [statRow('ap-1', { cpuUtilizationPct: 3 })])];
    await f.adapt(await f.report(resources(), -60_000));
    const { createSite } = await import('./db-utils');
    const elsewhere = (await createSite({ orgId: f.scope.orgId })).id;
    await f.test.execute(sql`UPDATE unifi_device_telemetry SET site_id=${elsewhere}::uuid WHERE collector_id=${f.collectorId}::uuid`);
    await f.adapt(await f.report([f.resource('device_list', [apRow('ap-1')]), f.resource('statistics', [statRow('ap-1', { cpuUtilizationPct: 99 })])], -30_000));
    expect(Number((await f.rows()).get('ap-1')!.cpu_pct)).toBe(3);
  });
});

describe('legacy reconcile writer fence', () => {
  const legacyPayload = (collectorId: string, over: Record<string, unknown> = {}) => ({
    collectorId, polledAt: new Date().toISOString(), firmwareOk: true, clients: [], deviceId: undefined,
    devices: [{ unifiDeviceId: 'ap-1', unifiSiteId: 'default', mac: null, name: 'ap-1', txBytes: 5, rxBytes: 6, raw: {} }], ...over,
  });
  const seed = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await f.adapt(await f.report([
      f.resource('device_list', [apRow('ap-1')]), f.resource('client_list', [clientRow('c1', 'ap-1')]),
      f.resource('statistics', [statRow('ap-1', { uptimeSeconds: 777, cpuUtilizationPct: 9, memoryUtilizationPct: 55 })]),
    ], -30_000));
    expect((await f.rows()).get('ap-1')).toMatchObject({ num_clients: 1 });
  };

  it('a request that carried topologyV2 cannot null or overwrite the v2-owned columns, even though the legacy body omits them', async () => {
    const f = await fixture();
    await seed(f);
    await sys(() => reconcileTelemetry(db as never, legacyPayload(f.collectorId, { topologyV2Present: true }) as never));
    const row = (await f.rows()).get('ap-1')!;
    expect(Number(row.uptime_seconds)).toBe(777);
    expect(Number(row.cpu_pct)).toBe(9);
    expect(Number(row.mem_pct)).toBe(55);
    expect(row.num_clients).toBe(1);
    // Legacy-owned fields still update.
    expect(Number(row.tx_bytes)).toBe(5);
    expect(Number(row.rx_bytes)).toBe(6);
  });

  it('a v1 / old-agent request keeps the existing legacy behaviour for every field', async () => {
    const f = await fixture();
    await seed(f);
    await sys(() => reconcileTelemetry(db as never, legacyPayload(f.collectorId) as never));
    const row = (await f.rows()).get('ap-1')!;
    expect(row.uptime_seconds).toBeNull();
    expect(row.cpu_pct).toBeNull();
    expect(row.mem_pct).toBeNull();
    expect(row.num_clients).toBeNull();
  });

  it('a legacy-created row under the fence starts with null v2-owned columns instead of the legacy body values', async () => {
    const f = await fixture();
    const device = { unifiDeviceId: 'ap-9', unifiSiteId: 'default', mac: null, name: 'ap-9', uptimeSeconds: 5, cpuPct: 1, memPct: 2, numClients: 3, raw: {} };
    await sys(() => reconcileTelemetry(db as never, legacyPayload(f.collectorId, { topologyV2Present: true, devices: [device] }) as never));
    expect((await f.rows()).get('ap-9')).toMatchObject({ uptime_seconds: null, cpu_pct: null, mem_pct: null, num_clients: null });
  });
});
