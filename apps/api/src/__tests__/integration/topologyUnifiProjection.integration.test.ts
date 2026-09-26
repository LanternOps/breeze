import './setup';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { canonicalizeUnifiResource, type UnifiResource, type UnifiTopologyV1 } from '@breeze/shared';
import { closeDb, db, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';
import { negotiateTopologyContext, resetTopologyProducerAuthoritiesForTest } from '../../services/topology/collectionAuthority';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { adaptUnifiTopology } from '../../services/topology/unifiAdapter';
import { currentUnifiCollectorTopology, loadUnifiCollector } from '../../services/topology/unifiAuthority';
import { registerTopologyPhysicalAuthorities } from '../../services/topology/physicalAuthorities';

afterAll(() => closeDb());
afterEach(() => resetTopologyProducerAuthoritiesForTest());

/**
 * M2 Task 6b: UniFi normalized rows -> canonical attachments through the real
 * adapter + publisher. A roaming client's new association gets support at once;
 * the old association loses this source's support (source withdrawal), and an
 * AP bound through its agent-reported NIC MAC is the inventory node itself.
 */
const AP1_MAC = '02:00:00:00:0a:01', AP2_MAC = '02:00:00:00:0a:02', SWITCH_MAC = '02:00:00:00:0a:03', CLIENT_MAC = '02:00:00:00:0c:01';
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(() => db.transaction(fn));

async function fixture() {
  registerTopologyPhysicalAuthorities();
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  const test = getTestDb();
  const collectorDevice = crypto.randomUUID(), apDevice = crypto.randomUUID(), integrationId = crypto.randomUUID(), collectorId = crypto.randomUUID();
  await test.execute(sql`UPDATE organizations SET settings=${JSON.stringify({ topologyFeatureFlags: { materialization: true, physical: true } })}::jsonb WHERE id=${scope.orgId}::uuid`);
  for (const [id, name] of [[collectorDevice, 'collector'], [apDevice, 'ap-1-managed']] as const) {
    await test.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash)
      VALUES (${id}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${id},${name},'linux','1','amd64','1',${'a'.repeat(64)})`);
  }
  // AP 1 runs a Breeze agent: its NIC MAC is the only binding source (D16).
  await test.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address) VALUES (${apDevice}::uuid,${scope.orgId}::uuid,'eth0',${AP1_MAC})`);
  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  expect(imported.complete).toBe(true);
  const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(collectorDevice)));
  if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
  await sys(async () => {
    await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${integrationId}::uuid, ${tenant.partnerId}::uuid, 'k')`);
    await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
      VALUES (${collectorId}::uuid, ${integrationId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'host:1', ${collectorDevice}::uuid, 'https://host-1', 'k')`);
    await db.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
      VALUES (${integrationId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'host:1', 'default')`);
  });
  const devices = [
    { rowKey: 'dev-ap-1', deviceId: 'dev-ap-1', mac: AP1_MAC, name: 'AP 1', model: null, ipAddress: null, state: 'ONLINE' },
    { rowKey: 'dev-ap-2', deviceId: 'dev-ap-2', mac: AP2_MAC, name: 'AP 2', model: null, ipAddress: null, state: 'ONLINE' },
    { rowKey: 'dev-switch-1', deviceId: 'dev-switch-1', mac: SWITCH_MAC, name: 'Switch', model: null, ipAddress: null, state: 'ONLINE' },
  ];
  const clientRow = (uplink: string, clientType = 'WIRELESS') => ({ rowKey: 'client-roam', clientId: 'client-roam', mac: CLIENT_MAC, clientType, uplinkDeviceId: uplink, name: 'laptop',
    ipAddress: null, uplinkPortIndex: null, ssid: null, vlan: null, signalDbm: null });
  const resource = (kind: UnifiResource['kind'], rows: unknown[]) => ({ controllerSiteId: 'default', kind, contentDigest: '0'.repeat(64), outcome: 'complete', rowCount: rows.length, rows }) as unknown as UnifiResource;
  const report = async (sequence: string, offsetMs: number, clients: unknown[]): Promise<UnifiTopologyV1> => {
    const collector = (await sys(() => loadUnifiCollector(collectorId)))!;
    const current = (await sys(() => currentUnifiCollectorTopology(collectorDevice, collector)))!;
    const resources = [resource('device_list', devices), resource('client_list', clients), resource('device_details', [
      { rowKey: 'dev-ap-2', deviceId: 'dev-ap-2', uplinkDeviceId: 'dev-switch-1', uplinkPortIndex: 7, ports: [] }]), resource('statistics', [])];
    for (const r of resources) r.contentDigest = createHash('sha256').update(canonicalizeUnifiResource(current, r)).digest('hex');
    return { version: 1, producerEpoch: current.producerEpoch, snapshotId: crypto.randomUUID(), sequence, capturedAt: new Date(Date.now() + offsetMs).toISOString(),
      captureAgeAtSendMs: 0, expectedIntervalSeconds: 300, resources } as UnifiTopologyV1;
  };
  const adapt = async (r: UnifiTopologyV1) => {
    const receipt = await sys(async () => adaptUnifiTopology(collectorDevice, (await loadUnifiCollector(collectorId))!, r));
    expect(receipt.accepted, JSON.stringify(receipt)).toBe(true);
  };
  const reconcile = async () => { for (let i = 0; i < 4; i++) { const r = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope))); if (!r.published) break; } };
  const q = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => scoped(async () => (await db.execute(query)) as unknown as T[]);
  const attachments = () => q<{ id: string; lifecycle: string; source_node_id: string; target_node_id: string; association: string; uplink: string; support_count: string }>(sql`
    SELECT id, lifecycle, source_node_id, target_node_id, attributes->'physical'->>'association' AS association, attributes->'physical'->>'uplinkEndpointKey' AS uplink,
      support_count::text FROM topology_relationships WHERE org_id=${scope.orgId}::uuid AND attributes->>'method'='unifi' ORDER BY first_supported_at, id`);
  const support = (relationshipId: string) => q<{ lifecycle: string }>(sql`SELECT lifecycle FROM topology_relationship_support WHERE relationship_id=${relationshipId}::uuid`);
  const deviceNode = async (deviceId: string) => String((await q<{ node_id: string }>(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${scope.orgId}::uuid AND device_id=${deviceId}::uuid`))[0]!.node_id);
  const endpointNode = async (suffix: string) => (await q<{ id: string }>(sql`SELECT id FROM topology_nodes WHERE org_id=${scope.orgId}::uuid
    AND identity_material->>'sourceKey' = ${`unifi:host%3A1:default:${suffix}`}`))[0]?.id;
  return { scope, apDevice, report, adapt, reconcile, attachments, support, deviceNode, endpointNode, clientRow };
}

describe('UniFi projection through the publisher (M2 Task 6b)', () => {
  it('roaming client: the new association is supported at once, the old one is withdrawn by the source', async () => {
    const f = await fixture();
    await f.adapt(await f.report('1', -60_000, [f.clientRow('dev-ap-1')]));
    await f.reconcile();
    let rows = await f.attachments();
    const first = rows.find(r => r.uplink?.endsWith(':device:dev-ap-1'))!;
    expect(first).toMatchObject({ lifecycle: 'active', association: 'wireless', support_count: '1' });
    // AP 1 is bound through its agent NIC MAC: the attachment hangs off the inventory node; no duplicate endpoint.
    expect(first.source_node_id).toBe(await f.deviceNode(f.apDevice));
    expect(await f.endpointNode('device:dev-ap-1')).toBeUndefined();
    const clientNode = await f.endpointNode(`mac:${encodeURIComponent(CLIENT_MAC)}`);
    expect(first.target_node_id).toBe(clientNode);
    // The controller uplink of AP 2 is an attachment (v1 names no local uplink port).
    expect(rows.find(r => r.association === 'uplink')).toMatchObject({ lifecycle: 'active', source_node_id: await f.endpointNode('device:dev-switch-1'), target_node_id: await f.endpointNode('device:dev-ap-2') });

    await f.adapt(await f.report('2', 0, [f.clientRow('dev-ap-2')]));
    await f.reconcile();
    rows = await f.attachments();
    const roamed = rows.find(r => r.uplink?.endsWith(':device:dev-ap-2') && r.association === 'wireless')!;
    expect(roamed).toMatchObject({ lifecycle: 'active', support_count: '1', target_node_id: clientNode, source_node_id: await f.endpointNode('device:dev-ap-2') });
    const old = rows.find(r => r.id === first.id)!;
    expect(old).toMatchObject({ lifecycle: 'withdrawn', support_count: '0' });
    expect((await f.support(first.id)).map(s => s.lifecycle)).toEqual(['withdrawn']);
    // No UniFi row ever mints a measured cable.
    expect(rows.every(r => r.association !== null)).toBe(true);
  });
});
