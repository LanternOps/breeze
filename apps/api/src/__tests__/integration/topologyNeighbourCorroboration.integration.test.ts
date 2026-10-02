import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { graphResponseSchema, type GraphResponse, type NetworkContextFull } from '@breeze/shared';
import { closeDb, db, runOutsideDbContext, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { topologyGraphRoutes } from '../../routes/topology/graphs';
import { clearPermissionCache } from '../../services/permissions';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { readNeighborEvidence } from '../../services/topology/neighborEvidence';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

/**
 * Neighbour-cache corroboration (#7816/#7817) against real Postgres: agents report
 * ARP rows through the REAL collection seam; only PUBLISHED baselines under the
 * current producer epoch may corroborate, and the read never leaves its org/site.
 */
const GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'devices', action: 'read' },
];
const PRINTER_IP = '10.1.2.77';
const PRINTER_MAC = '00:11:22:33:44:77';
const GATEWAY_MAC = '00:00:5e:00:01:01';
const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology neighbour corroboration test'));
type NeighborRow = Extract<NetworkContextFull['sections'][number], { kind: 'neighbors' }>['rows'][number];
type InterfaceKind = Extract<NetworkContextFull['sections'][number], { kind: 'interfaces' }>['rows'][number]['kind'];
const neighbor = (rowKey: string, address: string, mac: string, state: NeighborRow['state'] = 'reachable'): NeighborRow =>
  ({ rowKey, address, family: 'ipv4', zone: null, interfaceKey: 'if-1', mac, state, isRouter: null });
const gatewayRow = neighbor('nb-gateway', '10.1.2.1', GATEWAY_MAC);
const printerRow = neighbor('nb-printer', PRINTER_IP, PRINTER_MAC, 'stale');

async function lanSite(observers: number) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const scope = { orgId, siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  const deviceIds = Array.from({ length: observers }, () => crypto.randomUUID());
  const printerId = crypto.randomUUID();
  await system(() => db.update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, orgId)));
  await scoped(async () => {
    for (const [index, deviceId] of deviceIds.entries()) {
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status,last_seen_at,agent_token_hash)
        VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},${`lan-observer-${index}`},'linux','6.1','amd64','1','online',now(),${String(index + 1).padStart(64, 'c')})`);
      await db.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address,ip_address,ip_type,is_primary)
        VALUES (${deviceId}::uuid,${orgId}::uuid,'eth0',${`02:00:00:00:00:0${index}`},${`10.1.2.${10 + index}`},'ipv4',true)`);
    }
    await db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,mac_address,hostname,asset_type,is_online)
      VALUES (${printerId}::uuid,${orgId}::uuid,${siteId}::uuid,${PRINTER_IP},${PRINTER_MAC.toUpperCase().replaceAll(':', '-')},'lan-printer','printer',true)`);
  });
  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  expect(imported.complete).toBe(true);

  const producers: AuthenticatedTopologyProducer[] = [];
  for (const deviceId of deviceIds) {
    const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(deviceId)));
    if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
    producers.push({ scope, producerId: deviceId, producerKind: 'agent', producerEpoch: config.producerEpoch!,
      configurationRevision: config.configurationRevision!, sourceIdentity: config.sourceIdentity! });
  }
  /** One full report from observer `index` with the given ARP rows (and, optionally, its interface kind and CIDR). */
  const report = async (index: number, sequence: string, rows: NeighborRow[], iface: { kind?: InterfaceKind; address?: string; prefixLength?: number } = {}) => {
    const producer = producers[index]!;
    const value = networkContextFixture();
    Object.assign(value, { producerEpoch: producer.producerEpoch, sequence, snapshotId: crypto.randomUUID(),
      capturedAt: new Date(Date.now() - 1000 + Number(sequence)).toISOString() });
    const interfaces = value.sections.find((section) => section.kind === 'interfaces')!;
    const routes = value.sections.find((section) => section.kind === 'routes')!;
    const neighbors = value.sections.find((section) => section.kind === 'neighbors')!;
    interfaces.rows[0]!.addresses = [{ ...interfaces.rows[0]!.addresses[0]!, address: iface.address ?? `10.1.2.${10 + index}`, prefixLength: iface.prefixLength ?? 24 }];
    if (iface.kind) interfaces.rows[0]!.kind = iface.kind;
    routes.rows[0]!.nextHops = [{ ...routes.rows[0]!.nextHops[0]!, address: '10.1.2.1' }];
    Object.assign(neighbors, { rows, rowCount: rows.length });
    for (const section of value.sections) section.contentDigest = topologySectionDigest(value, section, producer.sourceIdentity);
    value.contentDigest = topologyContextDigest(value, producer.sourceIdentity);
    const accepted = await scoped(() => ingestTopologyNetworkContext(producer, value));
    expect(accepted.accepted, JSON.stringify(accepted)).toBe(true);
  };
  const publish = async () => {
    const published = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope)));
    expect(published.published).toBe(true);
  };
  const printerNode = async () => {
    const [row] = await scoped(() => db.execute(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${orgId}::uuid AND discovered_asset_id=${printerId}::uuid`));
    return String(row!.node_id);
  };
  const graph = async (): Promise<GraphResponse> => {
    clearPermissionCache();
    const app = new Hono();
    app.use('*', authMiddleware);
    app.route('/topology', topologyGraphRoutes);
    const response = await app.request(`/topology/sites/${siteId}/graph`, { headers: { Authorization: `Bearer ${env.token}` } });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return graphResponseSchema.parse(body);
  };
  const placement = async () => {
    const id = await printerNode();
    const body = await graph();
    const member = body.presentation.nodes.flatMap((node) => node.group?.kind === 'network' ? node.group.members : []).find((m) => m.nodeId === id);
    return { member, body };
  };
  return { orgId, siteId, scope, scoped, deviceIds, report, publish, placement, graph };
}

describe('neighbour-cache corroboration over published baselines', () => {
  it('corroborates only from published, current-epoch caches and shows the corroborated gateway MAC', async () => {
    const site = await lanSite(2);
    await site.report(0, '1', [gatewayRow]);
    await site.report(1, '1', [gatewayRow]);
    await site.publish();

    const first = await site.placement();
    expect(first.member).toMatchObject({ placement: 'address_match' });
    const gateway = first.body.presentation.nodes.find((node) => node.group?.kind === 'gateway')!;
    expect(gateway.group!.gatewayMacs).toEqual([expect.objectContaining({ address: '10.1.2.1', mac: GATEWAY_MAC, observerCount: 2 })]);
    const card = first.body.presentation.nodes.find((node) => node.group?.kind === 'network' && node.group.prefix === '10.1.2.0/24')!;
    expect(card.group).toMatchObject({ conflict: false, neighborCoverage: 'complete', observerCount: 2 });

    // Accepted but unpublished content never corroborates.
    await site.report(0, '2', [gatewayRow, printerRow]);
    expect((await site.placement()).member).toMatchObject({ placement: 'address_match' });

    await site.publish();
    const published = await site.placement();
    expect(published.member).toMatchObject({ placement: 'neighbor_seen', primary: true, neighbor: {
      method: 'neighbor_cache', evidenceClass: 'inferred', confidence: 'low', observerLabel: 'lan-observer-0', interfaceName: 'eth0',
      address: PRINTER_IP, mac: PRINTER_MAC, state: 'stale', rowKey: 'nb-printer' } });
    expect(Date.parse(published.member!.neighbor!.expiresAt)).toBeGreaterThan(Date.now());
    const publishedCard = published.body.presentation.nodes.find((node) => node.group?.kind === 'network' && node.group.prefix === '10.1.2.0/24')!;
    expect(publishedCard.group!.observerCount).toBe(2);
    // No canonical write: still no relationship touches the printer.
    const printer = await (async () => (published.member!.nodeId))();
    expect(published.body.relationships.some((edge) => edge.sourceNodeId === printer || edge.targetNodeId === printer)).toBe(false);

    // A source whose producer epoch moved on (re-enrolment) no longer corroborates its old published content.
    await system(() => db.execute(sql`UPDATE topology_collection_sources SET producer_epoch = 'rotated-epoch'
      WHERE org_id=${site.orgId}::uuid AND producer_id=${site.deviceIds[0]}::uuid AND protocol='neighbors'`));
    expect((await site.placement()).member).toMatchObject({ placement: 'address_match' });
  });

  it('classifies each card by the reporting interface kind, not the CIDR (#7819)', async () => {
    const site = await lanSite(3);
    // WireGuard on RFC1918, a genuine CGNAT LAN on Wi-Fi, and CGNAT on an interface of unknown kind.
    await site.report(0, '1', [], { kind: 'tunnel' });
    await site.report(1, '1', [], { kind: 'wifi', address: '100.64.0.11', prefixLength: 16 });
    await site.report(2, '1', [], { kind: 'unknown', address: '100.72.0.12', prefixLength: 16 });
    await site.publish();
    const body = await site.graph();
    const classes = Object.fromEntries(body.presentation.nodes.filter((node) => node.group?.kind === 'network').map((node) => [node.group!.prefix, node.group!.networkClass]));
    expect(classes).toMatchObject({ '10.1.2.0/24': 'overlay', '100.64.0.0/16': 'lan', '100.72.0.0/16': 'overlay' });
  });

  it('reads only its own org and site', async () => {
    const a = await lanSite(1);
    const b = await lanSite(1);
    await a.report(0, '1', [gatewayRow]);
    await a.publish();
    await b.report(0, '1', [gatewayRow, printerRow]);
    await b.publish();

    // B's cache sees "its" printer; A's identical printer (same IP and MAC) is not corroborated by it.
    expect((await b.placement()).member).toMatchObject({ placement: 'neighbor_seen' });
    expect((await a.placement()).member).toMatchObject({ placement: 'address_match' });

    const exposure = { physical: false, excluded: new Set<string>() };
    const read = (orgId: string, siteId: string) => withDbAccessContext(orgContext(a.orgId), () => withDbTransaction(() =>
      readNeighborEvidence(db, { orgId, siteId }, 'overview', exposure, [PRINTER_IP, '10.1.2.1'])));
    expect((await read(a.orgId, a.siteId)).baselines.map((baseline) => baseline.rows.map((row) => row.rowKey))).toEqual([['nb-gateway']]);
    // A's org with B's site id, and B's whole scope under A's RLS context: nothing.
    expect((await read(a.orgId, b.siteId)).baselines).toEqual([]);
    expect((await read(b.orgId, b.siteId)).baselines).toEqual([]);
  });
});
