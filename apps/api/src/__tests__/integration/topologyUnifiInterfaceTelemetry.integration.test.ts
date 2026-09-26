import './setup';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { canonicalizeUnifiResource, type UnifiResource, type UnifiTopologyV1 } from '@breeze/shared';
import { closeDb, db, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';
import { createSite } from './db-utils';
import { negotiateTopologyContext, resetTopologyProducerAuthoritiesForTest, resetTopologyTelemetryAuthoritiesForTest } from '../../services/topology/collectionAuthority';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { adaptUnifiTopology } from '../../services/topology/unifiAdapter';
import { currentUnifiCollectorTopology, loadUnifiCollector } from '../../services/topology/unifiAuthority';
import { registerTopologyPhysicalAuthorities } from '../../services/topology/physicalAuthorities';

afterAll(() => closeDb());
afterEach(() => { resetTopologyProducerAuthoritiesForTest(); resetTopologyTelemetryAuthoritiesForTest(); });

/**
 * M3 Task 4: UniFi device-detail ports become canonical controller-port
 * interfaces, and their link state/speed lands in the interface telemetry sink
 * under the `unifi` producer and the controller-site authority. No counters,
 * rates or PoE are claimed.
 */
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(() => db.transaction(fn));
type Port = { portIndex: number; name: string | null; linkUp: boolean | null; speedMbps: number | null; poeMode: string | null };

async function fixture(flags: Record<string, boolean> = { materialization: true, physical: true, interfaceHealth: true }) {
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
  const devices = [{ rowKey: 'dev-switch-1', deviceId: 'dev-switch-1', mac: '02:00:00:00:0a:03', name: 'Switch', model: null, ipAddress: null, state: 'ONLINE' }];
  const resource = (kind: UnifiResource['kind'], rows: unknown[]) => ({ controllerSiteId: 'default', kind, contentDigest: '0'.repeat(64), outcome: 'complete', rowCount: rows.length, rows }) as unknown as UnifiResource;
  let sequence = 1_790_000_000_000;
  const report = async (ports: Port[], offsetMs: number): Promise<UnifiTopologyV1> => {
    const collector = (await sys(() => loadUnifiCollector(collectorId)))!;
    const current = (await sys(() => currentUnifiCollectorTopology(collectorDevice, collector)))!;
    const resources = [resource('device_list', devices), resource('device_details', [
      { rowKey: 'dev-switch-1', deviceId: 'dev-switch-1', uplinkDeviceId: null, uplinkPortIndex: null, ports }])];
    for (const r of resources) r.contentDigest = createHash('sha256').update(canonicalizeUnifiResource(current, r)).digest('hex');
    return { version: 1, producerEpoch: current.producerEpoch, snapshotId: crypto.randomUUID(), sequence: String(++sequence),
      capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 60, resources } as UnifiTopologyV1;
  };
  const adapt = async (r: UnifiTopologyV1) => sys(async () => adaptUnifiTopology(collectorDevice, (await loadUnifiCollector(collectorId))!, r));
  const reconcile = async () => { for (let i = 0; i < 4; i++) { const r = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope))); if (!r.published) break; } };
  const ports = () => scoped(async () => (await db.execute(sql`SELECT id::text, interface_key, epoch, os_index, controller_port_key FROM topology_interfaces
    WHERE org_id=${scope.orgId}::uuid AND controller_port_key IS NOT NULL ORDER BY interface_key`)) as unknown as { id: string; interface_key: string; epoch: string; os_index: string; controller_port_key: string }[]);
  const samples = () => scoped(async () => (await db.execute(sql`SELECT s.interface_id::text, s.sampled_at, s.readings, c.producer_kind, c.context_key
    FROM topology_interface_samples s JOIN topology_collection_sources c ON c.id = s.source_id
    WHERE s.org_id=${scope.orgId}::uuid AND s.resolution='raw' ORDER BY s.sampled_at, s.interface_id`)) as unknown as
    { interface_id: string; readings: Record<string, unknown>; producer_kind: string; context_key: string }[]);
  return { scope, collectorId, integrationId, report, adapt, reconcile, ports, samples };
}

const up = (portIndex: number, speedMbps = 1000): Port => ({ portIndex, name: `Port ${portIndex}`, linkUp: true, speedMbps, poeMode: 'auto' });
const down = (portIndex: number): Port => ({ portIndex, name: `Port ${portIndex}`, linkUp: false, speedMbps: 0, poeMode: null });

describe('UniFi port link-state telemetry', () => {
  it('projects controller ports, then records link state and speed only under the controller-site authority', async () => {
    const f = await fixture();
    // Before the ports are projected there is nothing canonical to attach to.
    expect((await f.adapt(await f.report([up(1), down(2)], -60_000))).accepted).toBe(true);
    expect(await f.samples()).toEqual([]);
    await f.reconcile();
    const ports = await f.ports();
    expect(ports.map(p => [p.interface_key, p.epoch, p.os_index])).toEqual([['unifi-port:1', 'gen:1', '1'], ['unifi-port:2', 'gen:1', '2']]);

    expect((await f.adapt(await f.report([up(1), down(2)], -30_000))).accepted).toBe(true);
    const rows = await f.samples();
    expect(rows).toHaveLength(2);
    const byPort = new Map(rows.map(r => [r.interface_id, r]));
    expect(byPort.get(ports[0]!.id)!.readings).toMatchObject({ operStatus: 'up', adminStatus: 'unknown', capacityBps: '1000000000', inOctets: null, reportedInBps: null });
    expect(byPort.get(ports[1]!.id)!.readings).toMatchObject({ operStatus: 'down', capacityBps: null });
    expect(rows.every(r => r.producer_kind === 'unifi' && r.context_key === `${f.collectorId}:default`)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('poe');
  });

  it('refreshes unchanged state slowly but records a link change immediately', async () => {
    const f = await fixture();
    await f.adapt(await f.report([up(1), up(2)], -120_000));
    await f.reconcile();
    await f.adapt(await f.report([up(1), up(2)], -90_000));
    expect(await f.samples()).toHaveLength(2);
    await f.adapt(await f.report([up(1), up(2)], -60_000));
    expect(await f.samples()).toHaveLength(2);
    await f.adapt(await f.report([up(1), down(2)], -30_000));
    const rows = await f.samples();
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)!.readings).toMatchObject({ operStatus: 'down' });
  });

  it('records nothing while interface health is disabled', async () => {
    const f = await fixture({ materialization: true, physical: true, interfaceHealth: false });
    await f.adapt(await f.report([up(1)], -60_000));
    await f.reconcile();
    await f.adapt(await f.report([up(1)], -30_000));
    expect(await f.ports()).toHaveLength(1);
    expect(await f.samples()).toEqual([]);
  });

  it('never attributes a remapped controller site\'s ports to the old site', async () => {
    const f = await fixture();
    await f.adapt(await f.report([up(1)], -60_000));
    await f.reconcile();
    const otherSite = (await createSite({ orgId: f.scope.orgId })).id;
    await sys(() => db.execute(sql`UPDATE unifi_site_mappings SET site_id=${otherSite}::uuid WHERE integration_id=${f.integrationId}::uuid`));
    await f.adapt(await f.report([up(1)], -30_000));
    // The old site's canonical ports are outside the new controller-site scope.
    expect(await f.samples()).toEqual([]);
  });
});
