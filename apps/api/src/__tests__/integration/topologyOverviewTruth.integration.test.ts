import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { graphResponseSchema, type GraphResponse } from '@breeze/shared';
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
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

/**
 * Grouped overview truth (#7879) against real Postgres, through the REAL collection seam
 * and the graph route: scan presence from the latest completed discovery scan, node
 * freshness/observation rolled up from relationship observations (confirmation-aware),
 * orphan network/gateway nodes folded or hidden, and decommissioned devices hidden.
 */
const GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'devices', action: 'read' },
];
const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology overview truth test'));

type Assets = { latest: string; stale: string; never: string; running: string; unifiFresh: string; unifiStale: string };

async function lanSite() {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const scope = { orgId, siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  const deviceIds = [crypto.randomUUID(), crypto.randomUUID()];
  const assets: Assets = { latest: crypto.randomUUID(), stale: crypto.randomUUID(), never: crypto.randomUUID(), running: crypto.randomUUID(),
    unifiFresh: crypto.randomUUID(), unifiStale: crypto.randomUUID() };
  const [profile, otherProfile, oldJob, latestJob, runningJob, otherJob, emptyJob] = Array.from({ length: 7 }, () => crypto.randomUUID());
  await system(() => db.update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, orgId)));
  await scoped(async () => {
    for (const [index, deviceId] of deviceIds.entries()) {
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status,last_seen_at,agent_token_hash)
        VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},${`truth-observer-${index}`},'linux','6.1','amd64','1','online',now(),${String(index + 1).padStart(64, 'e')})`);
      await db.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address,ip_address,ip_type,is_primary)
        VALUES (${deviceId}::uuid,${orgId}::uuid,'eth0',${`02:00:00:00:01:0${index}`},${`10.1.2.${10 + index}`},'ipv4',true)`);
    }
    // Two profiles scan this site. `profile` last completed latestJob (an hour ago); `otherProfile`
    // completed more recently still — which must not make `profile`'s assets look absent.
    for (const [id, name] of [[profile, 'lan'], [otherProfile, 'cameras']] as const) {
      await db.execute(sql`INSERT INTO discovery_profiles (id,org_id,site_id,name) VALUES (${id}::uuid,${orgId}::uuid,${siteId}::uuid,${name})`);
    }
    const job = (id: string, profileId: string, status: string, startedAgo: string, completedAgo: string | null) => db.execute(sql`INSERT INTO discovery_jobs
      (id,profile_id,org_id,site_id,status,started_at,completed_at,created_at)
      VALUES (${id}::uuid,${profileId}::uuid,${orgId}::uuid,${siteId}::uuid,${status}::discovery_job_status,
        now() - ${startedAgo}::interval, ${completedAgo === null ? null : sql`now() - ${completedAgo}::interval`}, now() - ${startedAgo}::interval)`);
    await job(oldJob!, profile!, 'completed', '30 days', '30 days');
    await job(latestJob!, profile!, 'completed', '61 minutes', '60 minutes');
    await job(runningJob!, profile!, 'running', '5 minutes', null);
    await job(otherJob!, otherProfile!, 'completed', '2 minutes', '1 minute');
    // A later scan of `profile` that found no hosts at all (agent on the wrong network) proves nobody's absence.
    await job(emptyJob!, profile!, 'completed', '2 minutes', '30 seconds');
    await db.execute(sql`UPDATE discovery_jobs SET hosts_scanned = 254, hosts_discovered = 0 WHERE id = ${emptyJob!}::uuid`);
    // is_online is deliberately the OPPOSITE of the truth on every row: it must not be read.
    const asset = (id: string, ip: string, online: boolean, lastJob: string | null, seenAgo: string) => db.execute(sql`INSERT INTO discovered_assets
      (id,org_id,site_id,ip_address,hostname,asset_type,is_online,last_seen_at,last_job_id)
      VALUES (${id}::uuid,${orgId}::uuid,${siteId}::uuid,${ip},${`asset-${ip}`},'printer',${online},now() - ${seenAgo}::interval,${lastJob}::uuid)`);
    await asset(assets.latest, '10.1.2.50', false, latestJob!, '60 minutes');
    await asset(assets.stale, '10.1.2.226', true, oldJob!, '30 days');
    await asset(assets.never, '10.1.2.51', true, null, '1 day');
    await asset(assets.running, '10.1.2.52', false, runningJob!, '3 minutes');
    // UniFi-sourced rows (no scan): the controller's verdict counts only while it is dated within the hour.
    const unifi = (id: string, ip: string, observedAgo: string) => db.execute(sql`INSERT INTO discovered_assets
      (id,org_id,site_id,ip_address,hostname,asset_type,is_online,last_seen_at,status_source,status_observed_at,source)
      VALUES (${id}::uuid,${orgId}::uuid,${siteId}::uuid,${ip},${`ap-${ip}`},'access_point',true,now() - ${observedAgo}::interval,'unifi',now() - ${observedAgo}::interval,'unifi')`);
    await unifi(assets.unifiFresh, '10.1.2.60', '5 minutes');
    await unifi(assets.unifiStale, '10.1.2.61', '2 days');
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
  /** One full report: observer 0 also holds a link-local address, both route via 10.1.2.100. */
  const report = async (index: number, sequence: string) => {
    const producer = producers[index]!;
    const value = networkContextFixture();
    Object.assign(value, { producerEpoch: producer.producerEpoch, sequence, snapshotId: crypto.randomUUID(),
      capturedAt: new Date(Date.now() - 1000 + Number(sequence)).toISOString() });
    const interfaces = value.sections.find((section) => section.kind === 'interfaces')!;
    const routes = value.sections.find((section) => section.kind === 'routes')!;
    const lan = { ...interfaces.rows[0]!.addresses[0]!, address: `10.1.2.${10 + index}`, prefixLength: 24 };
    interfaces.rows[0]!.addresses = index === 0 ? [lan, { ...lan, address: '169.254.10.10', prefixLength: 16 }] : [lan];
    routes.rows[0]!.nextHops = [{ ...routes.rows[0]!.nextHops[0]!, address: '10.1.2.100' }];
    for (const section of value.sections) section.contentDigest = topologySectionDigest(value, section, producer.sourceIdentity);
    value.contentDigest = topologyContextDigest(value, producer.sourceIdentity);
    const accepted = await scoped(() => ingestTopologyNetworkContext(producer, value));
    expect(accepted.accepted, JSON.stringify(accepted)).toBe(true);
  };
  await report(0, '1');
  await report(1, '1');
  const published = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope)));
  expect(published.published).toBe(true);

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
  const nodeOf = async (column: 'device_id' | 'discovered_asset_id', id: string) => {
    const [row] = await system(() => db.execute(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${orgId}::uuid AND ${sql.identifier(column)}=${id}::uuid`));
    return String(row!.node_id);
  };
  /** The observer's own canonical network/gateway nodes, by prefix or next hop. */
  const observerNodes = async (index: number) => {
    const endpoint = await nodeOf('device_id', deviceIds[index]!);
    const rows = await system(() => db.execute<{ id: string; rel: string; kind: string; label: string }>(sql`SELECT n.id, r.id AS rel, n.kind, coalesce(n.attributes->>'prefix', n.attributes->>'label') AS label
      FROM topology_relationships r JOIN topology_nodes n ON n.id = r.target_node_id
      WHERE r.org_id=${orgId}::uuid AND r.source_node_id=${endpoint}::uuid AND r.kind IN ('network_member','default_route') AND r.deleted_at IS NULL`));
    const find = (label: string) => rows.find((row) => row.label === label)!;
    return { endpoint, lan: find('10.1.2.0/24'), linkLocal: find('169.254.0.0/16'), gateway: find('10.1.2.100') };
  };
  const relationshipCount = async () => {
    const [row] = await system(() => db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM topology_relationships WHERE org_id=${orgId}::uuid`));
    return Number(row!.count);
  };
  return { orgId, siteId, deviceIds, assets, graph, nodeOf, observerNodes, relationshipCount };
}

const groups = (body: GraphResponse) => body.presentation.nodes.filter((node) => node.group);
const cardOf = (body: GraphResponse, prefix: string) => groups(body).find((node) => node.group!.kind === 'network' && node.group!.prefix === prefix);
const hiddenOf = (body: GraphResponse, basis: string) => groups(body).find((node) => node.group!.kind === 'hidden' && node.group!.basis === basis);
const gatewayOf = (body: GraphResponse, address: string) => groups(body).find((node) => node.group!.kind === 'gateway' && node.group!.address === address);

describe('grouped overview truth (#7879)', () => {
  it('reports scan presence from the latest completed scan of the asset’s profile, never from is_online', async () => {
    const site = await lanSite();
    const body = await site.graph();
    const state = async (asset: string) => {
      const nodeId = await site.nodeOf('discovered_asset_id', asset);
      const node = body.nodes.find((entry) => entry.id === nodeId)!;
      expect(node.inventory?.presence.source).toBe('scan');
      return node.inventory!.presence.state;
    };
    expect(await state(site.assets.latest)).toBe('online');
    expect(await state(site.assets.running)).toBe('online');
    // Last seen 30 days ago by a scan its profile has since completed again without it.
    expect(await state(site.assets.stale)).toBe('offline');
    expect(await state(site.assets.never)).toBe('unknown');
    expect(await state(site.assets.unifiFresh)).toBe('online');
    // A controller verdict two days old is no longer evidence, and there was never a scan.
    expect(await state(site.assets.unifiStale)).toBe('unknown');
  });

  it('rolls confirmed relationship observations into node freshness and lastObservedAt, and keeps fresh members fresh', async () => {
    const site = await lanSite();
    const observer = await site.observerNodes(0);
    // The routes and memberships were last re-written 11 h ago; the agent's node has no observation of its own.
    await system(() => db.execute(sql`UPDATE topology_relationship_support SET last_positive_at = now() - interval '11 hours',
      effective_at = now() - interval '11 hours', fresh_until = now() - interval '11 hours' + interval '15 minutes'
      WHERE org_id=${site.orgId}::uuid AND relationship_id IN (SELECT id FROM topology_relationships WHERE source_node_id = ${observer.endpoint}::uuid)`));
    await system(() => db.execute(sql`UPDATE topology_relationships SET last_supported_at = now() - interval '11 hours' WHERE source_node_id = ${observer.endpoint}::uuid`));
    await system(() => db.execute(sql`UPDATE topology_nodes SET last_observed_at = NULL WHERE id = ${observer.endpoint}::uuid`));
    const confirmedAt = new Date(Date.now() - 120_000);
    // Since then the agent re-captured the SAME, still-published content every cadence (the confirm path).
    await system(() => db.execute(sql`UPDATE topology_collection_sources SET confirmed_through_at = ${confirmedAt.toISOString()}::timestamptz,
      fresh_until = now() + interval '13 minutes' WHERE org_id=${site.orgId}::uuid AND producer_id = ${site.deviceIds[0]!}`));

    const fresh = await site.graph();
    const node = fresh.nodes.find((entry) => entry.id === observer.endpoint)!;
    expect(node.inventory?.presence).toMatchObject({ state: 'online', source: 'agent' });
    expect(node.freshness).toBe('fresh');
    expect(node.evidence.lastObservedAt).toBe(confirmedAt.toISOString());
    const member = cardOf(fresh, '10.1.2.0/24')!.group!.members.find((entry) => entry.nodeId === observer.endpoint)!;
    expect(member.stale).toBe(false);

    // A confirmation only counts under the confirmation rule: a source whose last outcome carries
    // no positives confirms nothing, however recent its confirmed_through_at.
    await system(() => db.execute(sql`UPDATE topology_collection_sources SET last_outcome = 'not_attempted', confirmed_through_at = now()
      WHERE org_id=${site.orgId}::uuid AND producer_id = ${site.deviceIds[0]!}`));
    const unconfirmed = (await site.graph()).nodes.find((entry) => entry.id === observer.endpoint)!;
    expect(unconfirmed.freshness).toBe('stale');
    expect(Date.now() - Date.parse(unconfirmed.evidence.lastObservedAt!)).toBeGreaterThan(10 * 3600_000);
    await system(() => db.execute(sql`UPDATE topology_collection_sources SET last_outcome = 'complete'
      WHERE org_id=${site.orgId}::uuid AND producer_id = ${site.deviceIds[0]!}`));

    // When the source stops confirming, the node is honestly stale — and still says WHEN it was last observed.
    await system(() => db.execute(sql`UPDATE topology_collection_sources SET confirmed_through_at = now() - interval '11 hours',
      fresh_until = now() - interval '11 hours' + interval '15 minutes' WHERE org_id=${site.orgId}::uuid AND producer_id = ${site.deviceIds[0]!}`));
    const stale = await site.graph();
    const staleNode = stale.nodes.find((entry) => entry.id === observer.endpoint)!;
    expect(staleNode.freshness).toBe('stale');
    expect(staleNode.evidence.lastObservedAt).not.toBeNull();
    expect(Date.now() - Date.parse(staleNode.evidence.lastObservedAt!)).toBeGreaterThan(10 * 3600_000);
    expect(cardOf(stale, '10.1.2.0/24')!.group!.members.find((entry) => entry.nodeId === observer.endpoint)!.stale).toBe(true);
  });

  it('folds orphan networks and gateways into the matching card, classes evidenced link-local orphans, and hides unevidenced ones', async () => {
    const site = await lanSite();
    const zero = await site.observerNodes(0);
    const one = await site.observerNodes(1);
    // Observer 1's facts and observer 0's link-local membership are withdrawn: their canonical nodes stay active with no relationship.
    await system(() => db.execute(sql`UPDATE topology_relationships SET lifecycle = 'withdrawn'
      WHERE id IN (${one.lan.rel}::uuid, ${one.gateway.rel}::uuid, ${zero.linkLocal.rel}::uuid)`));
    const before = await site.relationshipCount();

    const body = await site.graph();
    expect(cardOf(body, '10.1.2.0/24')!.group!.canonicalNodeIds).toEqual([zero.lan.id, one.lan.id].sort());
    expect(gatewayOf(body, '10.1.2.100')!.group!.canonicalNodeIds).toEqual([zero.gateway.id, one.gateway.id].sort());
    // Just observed, so evidenced: under its class, which the hidden-networks toggle governs.
    expect(cardOf(body, '169.254.0.0/16')!.group).toMatchObject({ networkClass: 'link_local', members: [], canonicalNodeIds: [zero.linkLocal.id] });
    expect(hiddenOf(body, 'no_current_evidence')).toBeUndefined();
    // Every canonical network/gateway node now has a home: nothing sits loose above the map.
    const folded = new Set(groups(body).flatMap((node) => node.group!.canonicalNodeIds));
    expect(body.nodes.filter((node) => (node.kind === 'network' || node.kind === 'gateway') && !folded.has(node.id))).toEqual([]);

    // A day without observation: no current evidence, so it leaves the overview.
    await system(() => db.execute(sql`UPDATE topology_nodes SET last_observed_at = now() - interval '1 day' WHERE id = ${zero.linkLocal.id}::uuid`));
    const aged = await site.graph();
    expect(cardOf(aged, '169.254.0.0/16')).toBeUndefined();
    expect(hiddenOf(aged, 'no_current_evidence')!.group!.canonicalNodeIds).toEqual([zero.linkLocal.id]);
    expect(groups(aged).every((node) => node.authority === false)).toBe(true);
    // Presentation only: reading never writes a relationship.
    expect(await site.relationshipCount()).toBe(before);
  });

  it('hides a decommissioned device, keeps its stale observations out of the cards and folds its now-orphaned nodes', async () => {
    const site = await lanSite();
    const zero = await site.observerNodes(0);
    const one = await site.observerNodes(1);
    await system(() => db.execute(sql`UPDATE devices SET status = 'decommissioned', decommissioned_at = now() WHERE id = ${site.deviceIds[1]!}::uuid`));

    const body = await site.graph();
    const hidden = hiddenOf(body, 'decommissioned')!;
    expect(hidden).toMatchObject({ role: 'hidden_group', memberCount: 1, authority: false });
    expect(hidden.group!.canonicalNodeIds).toEqual([one.endpoint]);
    const card = cardOf(body, '10.1.2.0/24')!;
    expect(card.group!.members.map((member) => member.nodeId)).not.toContain(one.endpoint);
    expect(card.group!.members.map((member) => member.nodeId)).toContain(zero.endpoint);
    expect(card.group!.observerCount).toBe(1);
    expect(card.group!.canonicalNodeIds).toEqual([zero.lan.id, one.lan.id].sort());
    expect(gatewayOf(body, '10.1.2.100')!.group!.canonicalNodeIds).toEqual([zero.gateway.id, one.gateway.id].sort());
    // Its stale default route no longer contributes to the card's routes_via edge.
    const contributing = body.presentation.edges.flatMap((edge) => edge.meaning === 'aggregate' ? edge.contributingRelationshipIds : []);
    expect(contributing).toContain(zero.gateway.rel);
    expect(contributing).not.toContain(one.gateway.rel);

    // Prod shape: the decommissioned agent's node ALSO carries a discovered-asset binding. While that asset
    // was not seen by the latest completed scan, the node stays hidden (the hardware is not evidently there).
    const assetId = crypto.randomUUID();
    await system(async () => {
      await db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,hostname,asset_type,is_online,last_seen_at)
        VALUES (${assetId}::uuid,${site.orgId}::uuid,${site.siteId}::uuid,'10.1.2.99','checkout-hw','workstation',true,now() - interval '20 days')`);
      await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,discovered_asset_id)
        VALUES (${site.orgId}::uuid,${site.siteId}::uuid,${one.endpoint}::uuid,${assetId}::uuid)`);
    });
    const staleAsset = await site.graph();
    expect(hiddenOf(staleAsset, 'decommissioned')!.group!.canonicalNodeIds).toEqual([one.endpoint]);
    expect(cardOf(staleAsset, '10.1.2.0/24')!.group!.members.map((member) => member.nodeId)).not.toContain(one.endpoint);

    // Once the latest completed scan sees that asset, the node renders AS the asset: asset label, presence and
    // inventory; the agent's hostname and status are dropped; placed by the asset address, never by agent facts.
    const [profileId, jobId] = [crypto.randomUUID(), crypto.randomUUID()];
    await system(async () => {
      await db.execute(sql`INSERT INTO discovery_profiles (id,org_id,site_id,name) VALUES (${profileId}::uuid,${site.orgId}::uuid,${site.siteId}::uuid,'checkout')`);
      await db.execute(sql`INSERT INTO discovery_jobs (id,profile_id,org_id,site_id,status,started_at,completed_at)
        VALUES (${jobId}::uuid,${profileId}::uuid,${site.orgId}::uuid,${site.siteId}::uuid,'completed',now() - interval '2 minutes',now() - interval '1 minute')`);
      await db.execute(sql`UPDATE discovered_assets SET last_job_id = ${jobId}::uuid, last_seen_at = now() WHERE id = ${assetId}::uuid`);
    });
    const shown = await site.graph();
    expect(hiddenOf(shown, 'decommissioned')).toBeUndefined();
    const node = shown.nodes.find((entry) => entry.id === one.endpoint)!;
    expect(node.label).toBe('checkout-hw');
    expect(node.inventory).toMatchObject({ source: 'discovered_asset', name: 'checkout-hw', addresses: ['10.1.2.99'],
      presence: { state: 'online', source: 'scan', agentStatus: null } });
    const shownCard = cardOf(shown, '10.1.2.0/24')!;
    expect(shownCard.group!.members.find((member) => member.nodeId === one.endpoint)).toMatchObject({ placement: 'address_match' });
    expect(shownCard.group!.observerCount).toBe(1);
    expect(shown.presentation.edges.flatMap((edge) => edge.meaning === 'aggregate' ? edge.contributingRelationshipIds : [])).not.toContain(one.gateway.rel);
  });
});
