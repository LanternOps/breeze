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
const count = (from: ReturnType<typeof sql>) => system(async () => Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${from}`))[0]!.n));
async function addPolicy(s: Scope, subjectNodeId: string | null) {
  const id = crypto.randomUUID();
  await system(() => db.execute(sql`INSERT INTO topology_monitoring_policies (id, org_id, site_id, key, definition, subject_node_id)
    VALUES (${id}::uuid, ${s.orgId}::uuid, ${s.siteId}::uuid, ${'k-' + id.slice(0, 8)}, '{}'::jsonb, ${subjectNodeId}::uuid)`));
  return id;
}
async function addArm(s: Scope & { deviceId: string }, nodeId: string, profileId: string, state: 'armed' | 'revoked') {
  await system(() => db.execute(sql`INSERT INTO topology_telemetry_arms (org_id, site_id, target_node_id, collector_device_id, credential_profile_id, authority_key,
      target_address, credential_digest, interfaces, state, revoked_at, armed_by, authority_actor, authority_permission_version, effect_digest, expires_at)
    VALUES (${s.orgId}::uuid, ${s.siteId}::uuid, ${nodeId}::uuid, ${s.deviceId}::uuid, ${profileId}::uuid, ${'snmp:' + nodeId}, '192.0.2.9', ${'a'.repeat(64)},
      '[{"ifIndex":1}]'::jsonb, ${state}, ${state === 'revoked' ? sql`now()` : null}, ${crypto.randomUUID()}::uuid, '{}'::jsonb, 'v1', ${'b'.repeat(64)}, now() + interval '1 day')`));
}
async function addRun(s: Scope, o: { subject: string; origin: string; state: string; queuedDaysAgo: number }) {
  const at = agedAt(o.queuedDaysAgo);
  await system(() => db.execute(sql`INSERT INTO topology_diagnostic_runs (org_id, site_id, recipe_id, recipe_version, requester_id, subject_node_id, origin_node_id,
      origin_snapshot, plan, plan_digest, idempotency_key, body_hash, attempt_id, state, queued_at, queue_deadline, deadline, created_at, updated_at)
    VALUES (${s.orgId}::uuid, ${s.siteId}::uuid, 'ping', 1, ${crypto.randomUUID()}::uuid, ${o.subject}::uuid, ${o.origin}::uuid, '{}'::jsonb, '{}'::jsonb,
      ${'c'.repeat(64)}, ${crypto.randomUUID()}, ${'d'.repeat(64)}, ${crypto.randomUUID()}::uuid, ${o.state}, ${at}::timestamptz, ${at}::timestamptz + interval '1 minute', ${at}::timestamptz + interval '2 minutes', ${at}::timestamptz, ${at}::timestamptz)`));
}
/** Every FK onto topology_nodes (confdeltype c=CASCADE, a=NO ACTION). A new one fails this test until it is classified in
 * unboundNodeRetention.ts: add a keeper predicate if deleting the node would lose operator intent, else list it here as accepted. */
const KNOWN_NODE_FKS = [
  'topology_nodes.alias_target_id:a',            // keeper: alias source/target
  'topology_node_bindings.node_id:c',            // keeper: bound node is not unbound
  'topology_node_positions.node_id:c',           // keeper when pinned; unpinned layout positions are derived
  'topology_monitoring_policies.subject_node_id:c', // keeper
  'topology_monitor_bindings.node_id:c',         // keeper
  'topology_telemetry_arms.target_node_id:c',    // keeper while not revoked
  'topology_diagnostic_runs.subject_node_id:c',  // keeper while in flight or inside the window
  'topology_diagnostic_runs.origin_node_id:c',   // keeper while in flight or inside the window
  'topology_relationships.source_node_id:c',     // keeper while active/recent; dead ones cascade by design
  'topology_relationships.target_node_id:c',
  'topology_observations.subject_node_id:c',     // derived evidence, cascades by design (support pointer released first)
  'topology_interfaces.owner_node_id:c',         // derived inventory of the node itself, cascades by design
];
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

  it('keeps a stub referenced by a monitoring policy and leaves the policy and its relationships intact', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'lldp-chassis:mac:policy');
    await addRel(g, g.nodeId, id, 'withdrawn');
    const policyId = await addPolicy(g, id);
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
    expect(await count(sql`topology_monitoring_policies WHERE id=${policyId}::uuid`)).toBe(1);
    expect(await count(sql`topology_relationships WHERE source_node_id=${id}::uuid OR target_node_id=${id}::uuid`)).toBe(1);
  });

  it('keeps a stub referenced by a monitor binding and leaves the binding and its relationships intact', async () => {
    const g = await createTopologyGraph();
    const id = await addNode(g, 'mac-endpoint:aa:bb:cc:04:00:01');
    await addRel(g, g.nodeId, id, 'archived');
    const policyId = await addPolicy(g, null); // owner for the binding; deliberately NOT attached to the stub
    await system(() => db.execute(sql`INSERT INTO topology_monitor_bindings (org_id, site_id, node_id, policy_id, context_key, family, metric_role)
      VALUES (${g.orgId}::uuid, ${g.siteId}::uuid, ${id}::uuid, ${policyId}::uuid, 'ctx', 'ipv4', 'reachability')`));
    expect((await purge(g)).deleted).toBe(0);
    expect(await exists(id)).toBe(true);
    expect(await count(sql`topology_monitor_bindings WHERE node_id=${id}::uuid`)).toBe(1);
    expect(await count(sql`topology_relationships WHERE source_node_id=${id}::uuid OR target_node_id=${id}::uuid`)).toBe(1);
  });

  it('keeps a stub that is the target of a live telemetry arm, but not one whose arm was revoked', async () => {
    const g = await createTopologyGraph();
    const armed = await addNode(g, 'lldp-chassis:mac:armed');
    const revoked = await addNode(g, 'lldp-chassis:mac:revoked');
    const profileId = crypto.randomUUID();
    await system(() => db.execute(sql`INSERT INTO discovery_profiles (id, org_id, site_id, name) VALUES (${profileId}::uuid, ${g.orgId}::uuid, ${g.siteId}::uuid, 'p')`));
    await addArm(g, armed, profileId, 'armed');
    await addArm(g, revoked, profileId, 'revoked');
    expect((await purge(g)).deleted).toBe(1);
    expect(await exists(armed)).toBe(true);
    expect(await exists(revoked)).toBe(false);
    expect(await count(sql`topology_telemetry_arms WHERE target_node_id=${armed}::uuid`)).toBe(1);
  });

  it('keeps a stub with an in-flight or recent diagnostic run (as subject or origin); drops it once the runs are old and terminal', async () => {
    const g = await createTopologyGraph();
    const inflight = await addNode(g, 'lldp-chassis:mac:diag-inflight');
    const recentOrigin = await addNode(g, 'lldp-chassis:mac:diag-origin');
    const oldDone = await addNode(g, 'lldp-chassis:mac:diag-old');
    await addRun(g, { subject: inflight, origin: g.nodeId, state: 'running', queuedDaysAgo: OLD });
    await addRun(g, { subject: g.nodeId, origin: recentOrigin, state: 'completed', queuedDaysAgo: 1 });
    await addRun(g, { subject: oldDone, origin: g.nodeId, state: 'completed', queuedDaysAgo: OLD });
    expect((await purge(g)).deleted).toBe(1);
    expect(await exists(inflight)).toBe(true);
    expect(await exists(recentOrigin)).toBe(true);
    expect(await exists(oldDone)).toBe(false);
  });

  it('accounts for every foreign key onto topology_nodes: each is either a keeper rule or an accepted cascade', async () => {
    const fks = await system(() => db.execute<{ tbl: string; col: string; del: string }>(sql`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype::text AS del
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
      WHERE c.contype='f' AND c.confrelid='topology_nodes'::regclass ORDER BY 1,2`));
    const seen = fks.map(r => `${r.tbl}.${r.col}:${r.del}`).sort();
    expect(seen).toEqual([...KNOWN_NODE_FKS].sort());
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
