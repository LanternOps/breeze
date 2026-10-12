import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { createTopologyGraph } from './topology-fixtures';
import { purgeAgedUnboundStubNodes, UNBOUND_STUB_RETENTION_DAYS } from '../../services/topology/unboundNodeRetention';
import { expireTopologyEvidence } from '../../services/topology/collectionRetention';
import { runTopologyCollectionRetentionTick } from '../../jobs/topologyCollectionRetentionWorker';

afterAll(() => closeDb());
const system = <T>(work: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(work));
const DAY = 86_400_000;

type Scope = { orgId: string; siteId: string };
const agedAt = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const OLD = UNBOUND_STUB_RETENTION_DAYS + 5;

async function addNode(s: Scope, sourceKey: string, opts: { ageDays?: number; labelOverride?: string } = {}) {
  const id = crypto.randomUUID();
  const at = agedAt(opts.ageDays ?? OLD);
  await system(() => db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind, label_override, created_at, updated_at)
    VALUES (${id}::uuid, ${s.orgId}::uuid, ${s.siteId}::uuid, ${id}, ${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey })}::jsonb,
      'endpoint', ${opts.labelOverride ?? null}, ${at}::timestamptz, ${at}::timestamptz)`));
  return id;
}
async function addRel(s: Scope, from: string, to: string, lifecycle: 'active' | 'withdrawn' | 'archived', ageDays = OLD) {
  const key = crypto.randomUUID();
  const at = agedAt(ageDays);
  await system(() => db.execute(sql`INSERT INTO topology_relationships (org_id, site_id, canonical_key, identity_material, kind, source_node_id, target_node_id, lifecycle, created_at, updated_at)
    VALUES (${s.orgId}::uuid, ${s.siteId}::uuid, ${key}, ${JSON.stringify({ version: 1, kind: 'attachment', sourceKey: key })}::jsonb, 'attachment',
      ${from}::uuid, ${to}::uuid, ${lifecycle}, ${at}::timestamptz, ${at}::timestamptz)`));
  return key;
}
const exists = (id: string) => system(async () => (await db.execute(sql`SELECT 1 FROM topology_nodes WHERE id=${id}::uuid`)).length === 1);
const purge = (s: Scope, limit?: number) => system(() => db.transaction(() => purgeAgedUnboundStubNodes(s, new Date(), limit)));

describe('unbound topology stub node retention (#7267)', () => {
  it('deletes every scoped prefix once it has had no active relationship past the retention window', async () => {
    const g = await createTopologyGraph();
    const keys = ['lldp-chassis:mac:aa', 'cdp-device:hostname:sw1', 'mac-endpoint:aa:bb:cc:dd:ee:01', 'physical-target:abc', 'unifi:host:site:device:1'];
    const ids = await Promise.all(keys.map(k => addNode(g, k)));
    for (const id of ids) await addRel(g, g.nodeId, id, 'withdrawn');
    expect((await purge(g)).deleted).toBe(keys.length);
    for (const id of ids) expect(await exists(id)).toBe(false);
  });

  it('keeps a stub with an active relationship, however old', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'lldp-chassis:mac:active');
    await addRel(g, g.nodeId, id, 'active');
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('keeps a stub whose newest relationship activity is inside the window', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'lldp-chassis:mac:recent');
    await addRel(g, g.nodeId, id, 'withdrawn', OLD);
    await addRel(g, g.nodeId, id, 'withdrawn', 1);
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('keeps a stub that was itself touched inside the window', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'mac-endpoint:aa:bb:cc:dd:ee:02', { ageDays: 1 });
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('keeps nodes outside the scoped-prefix set and user-labelled nodes', async () => {
    const g = await createTopologyGraph();
    const other = await addNode(g, 'device:something-else');
    const labelled = await addNode(g, 'lldp-chassis:mac:named', { labelOverride: 'Core switch' });
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(other)).toBe(true);
    expect(await exists(labelled)).toBe(true);
  });

  it('keeps a bound stub (a node with an inventory binding is not unbound)', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'mac-endpoint:aa:bb:cc:dd:ee:03');
    const assetId = crypto.randomUUID();
    await system(() => db.execute(sql`INSERT INTO discovered_assets (id, org_id, site_id, ip_address)
      VALUES (${assetId}::uuid, ${g.orgId}::uuid, ${g.siteId}::uuid, '192.0.2.77')`));
    await system(() => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, discovered_asset_id)
      VALUES (${g.orgId}::uuid, ${g.siteId}::uuid, ${id}::uuid, ${assetId}::uuid)`));
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('keeps an alias target and does not trip the NO ACTION alias FK', async () => {
    const g = await createTopologyGraph();
    const target = await addNode(g, 'lldp-chassis:mac:alias-target');
    const alias = await addNode(g, 'manual:alias-source');
    await system(() => db.execute(sql`UPDATE topology_nodes SET alias_target_id=${target}::uuid WHERE id=${alias}::uuid`));
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(target)).toBe(true);
  });

  it('keeps a stub with a pinned position', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'cdp-device:hostname:pinned');
    await system(() => db.execute(sql`INSERT INTO topology_node_positions (org_id, site_id, layout_id, node_id, x, y, pinned)
      VALUES (${g.orgId}::uuid, ${g.siteId}::uuid, ${g.layoutId}::uuid, ${id}::uuid, 1, 1, true)`));
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('removes the dead relationships and positions with the node, and never touches another site', async () => {
    const g = await createTopologyGraph();
    const h = await createTopologyGraph();
    const id = await addNode(g, 'cdp-device:hostname:gone');
    const hid = await addNode(h, 'cdp-device:hostname:gone');
    await addRel(g, g.nodeId, id, 'archived');
    await addRel(h, h.nodeId, hid, 'archived');
    await system(() => db.execute(sql`INSERT INTO topology_node_positions (org_id, site_id, layout_id, node_id, x, y)
      VALUES (${g.orgId}::uuid, ${g.siteId}::uuid, ${g.layoutId}::uuid, ${id}::uuid, 1, 1)`));
    expect((await purge(g)).deleted).toBe(1);
    const [left] = await system(() => db.execute<{ rels: number; pos: number }>(sql`SELECT
      (SELECT count(*)::int FROM topology_relationships WHERE source_node_id=${id}::uuid OR target_node_id=${id}::uuid) AS rels,
      (SELECT count(*)::int FROM topology_node_positions WHERE node_id=${id}::uuid) AS pos`));
    expect(left).toEqual({ rels: 0, pos: 0 });
    expect(await exists(hid)).toBe(true);
  });

  it('deletes in bounded batches and reports whether more remain', async () => {
    const g = await createTopologyGraph();
    for (let i = 0; i < 5; i++) await addNode(g, `mac-endpoint:aa:bb:cc:00:00:${i}0`);
    expect(await purge(g, 3)).toEqual({ deleted: 3, more: true });
    expect(await purge(g, 3)).toEqual({ deleted: 2, more: false });
  });

  it('reports no more work when the batch exactly drains the backlog', async () => {
    const g = await createTopologyGraph();
    for (let i = 0; i < 2; i++) await addNode(g, `mac-endpoint:aa:bb:cc:01:00:${i}0`);
    expect(await purge(g, 2)).toEqual({ deleted: 2, more: false });
  });

  it('honours the 30-day boundary independently of the exported constant', async () => {
    const g = await createTopologyGraph();
    const young = await addNode(g, 'mac-endpoint:aa:bb:cc:02:00:01', { ageDays: 29 });
    const aged = await addNode(g, 'mac-endpoint:aa:bb:cc:02:00:02', { ageDays: 31 });
    expect((await purge(g)).deleted).toBe(1);
    expect(await exists(young)).toBe(true);
    expect(await exists(aged)).toBe(false);
  });

  it('keeps a stub whose relationship was supported inside the window even if its row is old', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'lldp-chassis:mac:supported');
    await addRel(g, g.nodeId, id, 'withdrawn');
    await system(() => db.execute(sql`UPDATE topology_relationships SET last_supported_at=now()-interval '2 days'
      WHERE source_node_id=${id}::uuid OR target_node_id=${id}::uuid`));
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('keeps non-endpoint nodes, soft-deleted nodes and alias sources even with a scoped prefix', async () => {
    const g = await createTopologyGraph();
    const network = await addNode(g, 'lldp-chassis:mac:net');
    await system(() => db.execute(sql`UPDATE topology_nodes SET kind='network', identity_material=jsonb_set(identity_material,'{kind}','"network"') WHERE id=${network}::uuid`));
    const soft = await addNode(g, 'lldp-chassis:mac:soft');
    await system(() => db.execute(sql`UPDATE topology_nodes SET deleted_at=now() WHERE id=${soft}::uuid`));
    const keeper = await addNode(g, 'lldp-chassis:mac:alias-keeper', { ageDays: 1 });
    const source = await addNode(g, 'mac-endpoint:aa:bb:cc:03:00:01');
    await system(() => db.execute(sql`UPDATE topology_nodes SET alias_target_id=${keeper}::uuid WHERE id=${source}::uuid`));
    expect((await purge(g)).deleted).toBe(0);
    for (const id of [network, soft, source]) expect(await exists(id)).toBe(true);
  });

  it('does not touch another site in the same org', async () => {
    const g = await createTopologyGraph();
    const otherSite = crypto.randomUUID();
    await system(() => db.execute(sql`INSERT INTO sites (id, org_id, name) VALUES (${otherSite}::uuid, ${g.orgId}::uuid, 'second')`));
    const mine = await addNode(g, 'cdp-device:hostname:a');
    const theirs = await addNode({ orgId: g.orgId, siteId: otherSite }, 'cdp-device:hostname:a');
    expect((await purge(g)).deleted).toBe(1);
    expect(await exists(mine)).toBe(false);
    expect(await exists(theirs)).toBe(true);
  });

  it('runs as part of the site evidence retention pass', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'unifi:host:site:device:9');
    const result = await system(() => expireTopologyEvidence(g));
    expect(result.purgedStubNodes).toBe(1);
    expect(await exists(id)).toBe(false);
  });

  it('makes a site with only aged stubs a worker candidate', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'lldp-chassis:mac:worker');
    await system(() => db.execute(sql`INSERT INTO topology_site_state (org_id, site_id, updated_at) VALUES (${g.orgId}::uuid, ${g.siteId}::uuid, '2000-01-01')
      ON CONFLICT (org_id, site_id) DO UPDATE SET updated_at='2000-01-01'`));
    await runTopologyCollectionRetentionTick();
    expect(await exists(id)).toBe(false);
  });
});
