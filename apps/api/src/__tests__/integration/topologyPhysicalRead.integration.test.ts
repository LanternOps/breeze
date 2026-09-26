import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { graphResponseSchema, relationshipDetailResponseSchema, relationshipEvidenceResponseSchema, type GraphResponse } from '@breeze/shared';
import { authMiddleware } from '../../middleware/auth';
import { topologyGraphRoutes } from '../../routes/topology/graphs';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * M2 Task 9 read contracts against real Postgres through the authenticated
 * route (request RLS): D9/D15.4 physical exposure gate, D17 per-view
 * exclusions, D11 coverage from expected scopes, detail ports/alternatives and
 * paginated evidence — and that every GET writes and dispatches nothing.
 */
const READ = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }];
const app = () => new Hono().use('*', authMiddleware).route('/topology', topologyGraphRoutes);
const get = (env: TestEnvironment, path: string) => app().request(`/topology/sites/${env.site.id}/${path}`, { headers: { Authorization: `Bearer ${env.token}` } });
async function json<T>(env: TestEnvironment, path: string, parse: (value: unknown) => T): Promise<T> {
  const res = await get(env, path); const body = await res.json();
  expect(res.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
  return parse(body);
}
const graph = (env: TestEnvironment, query: string): Promise<GraphResponse> => json(env, `graph?${query}`, (v) => graphResponseSchema.parse(v));
const hex = (c: string) => c.repeat(64);

async function setFlags(orgId: string, physical: boolean) {
  await getTestDb().execute(sql`UPDATE organizations SET settings = ${JSON.stringify({ topologyFeatureFlags: { materialization: true, ui: true, physical } })}::jsonb WHERE id = ${orgId}::uuid`);
}

async function seed(env: TestEnvironment) {
  const db = getTestDb();
  const scope = { orgId: env.organization.id, siteId: env.site.id };
  const ids = { sw: randomUUID(), host: randomUUID(), net: randomUUID(), chassis: randomUUID(), device: randomUUID(), hostDevice: randomUUID(),
    p1: randomUUID(), p2: randomUUID(), p24: randomUUID(), chassisPort: randomUUID(),
    link: randomUUID(), fdb: randomUUID(), fdb2: randomUUID(), member: randomUUID(), source: randomUUID(), run: randomUUID(), observation: randomUUID() };
  await db.execute(sql`INSERT INTO topology_site_state (org_id, site_id, graph_revision) VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, 5)`);
  for (const [id, name] of [[ids.device, 'core-switch'], [ids.hostDevice, 'desk-12']] as const) {
    await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${id}, ${name}, 'linux', '1', 'amd64', '1')`);
  }
  const node = async (id: string, kind: 'endpoint' | 'network', sourceKey: string, label: string) => db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind, attributes)
    VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${canonicalIdentityKey(scope, kind, sourceKey)},
      ${JSON.stringify({ version: 1, kind, sourceKey })}::jsonb, ${kind}, ${JSON.stringify({ label })}::jsonb)`);
  await node(ids.sw, 'endpoint', `device:${ids.device}`, 'Core switch');
  await node(ids.host, 'endpoint', `device:${ids.hostDevice}`, 'Desk 12');
  await node(ids.net, 'network', 'net:192.0.2.0/24', '192.0.2.0/24');
  // An unbound LLDP chassis endpoint exists only because a physical collector saw it.
  await node(ids.chassis, 'endpoint', 'lldp-chassis:mac_address:02%3A00%3A00%3A00%3A00%3A09', 'Unmanaged neighbor');
  for (const [nodeId, deviceId] of [[ids.sw, ids.device], [ids.host, ids.hostDevice]] as const) {
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, device_id) VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, ${nodeId}::uuid, ${deviceId}::uuid)`);
  }
  for (const [id, owner, key, name, alias] of [[ids.p1, ids.sw, 'if:1', 'port-1', 'Uplink'], [ids.p2, ids.sw, 'if:2', 'port-2', null], [ids.p24, ids.sw, 'if:24', 'port-24', 'Desk drop'], [ids.chassisPort, ids.chassis, 'name:Gi0/1', 'Gi0/1', null]] as const) {
    await db.execute(sql`INSERT INTO topology_interfaces (id, org_id, site_id, owner_node_id, interface_key, epoch, name, alias)
      VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${owner}::uuid, ${key}, 'gen:1', ${name}, ${alias})`);
  }
  const rel = async (id: string, kind: string, source: string, target: string, extra: { si?: string; ti?: string; evidence: string; confidence: string; directness: string; attributes: object }) =>
    db.execute(sql`INSERT INTO topology_relationships (id, org_id, site_id, canonical_key, identity_material, kind, source_node_id, target_node_id, source_interface_id, target_interface_id,
        directness, confidence, evidence_class, support_count, last_supported_at, attributes)
      VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${canonicalIdentityKey(scope, kind as 'attachment', id)}, ${JSON.stringify({ version: 1, kind, sourceKey: id })}::jsonb,
        ${kind}, ${source}::uuid, ${target}::uuid, ${extra.si ?? null}::uuid, ${extra.ti ?? null}::uuid, ${extra.directness}, ${extra.confidence}, ${extra.evidence}, 1, now(), ${JSON.stringify(extra.attributes)}::jsonb)`);
  await rel(ids.link, 'physical_link', ids.sw, ids.chassis, { si: ids.p1, ti: ids.chassisPort, evidence: 'observed', confidence: 'high', directness: 'direct', attributes: { method: 'lldp', physical: { resolution: 'resolved' } } });
  const fdbPhysical = (alternatives: string[]) => ({ resolution: 'resolved', subjectAuthority: 'snmp:192.0.2.1', localPort: { namespace: 'if_index', value: '24', resolvedInterfaceKey: null },
    remoteChassis: { subtype: 'mac_address', value: '02:00:00:00:cc:01' }, fdbSelection: 'competing', alternativeRelationshipIds: alternatives });
  await rel(ids.fdb, 'attachment', ids.sw, ids.host, { si: ids.p24, evidence: 'inferred', confidence: 'low', directness: 'unknown', attributes: { method: 'fdb', physical: fdbPhysical([ids.fdb2]) } });
  await rel(ids.fdb2, 'attachment', ids.sw, ids.host, { si: ids.p2, evidence: 'inferred', confidence: 'low', directness: 'unknown', attributes: { method: 'fdb', physical: { ...fdbPhysical([ids.fdb]), localPort: { namespace: 'if_index', value: '2', resolvedInterfaceKey: null } } } });
  await rel(ids.member, 'network_member', ids.host, ids.net, { evidence: 'observed', confidence: 'high', directness: 'direct', attributes: {} });
  // One discovery source → one run → one observation + support on the FDB relationship.
  await db.execute(sql`INSERT INTO topology_collection_sources (id, org_id, site_id, producer_id, producer_kind, producer_epoch, protocol, context_key, last_outcome,
      current_baseline, fresh_until, last_received_at, accepted_sequence, confirmed_sequence, content_digest, published_digest)
    VALUES (${ids.source}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${ids.device}::uuid, 'discovery', ${hex('e')}, 'fdb', 'snmp:192.0.2.1/default', 'complete',
      ${JSON.stringify({ section: { kind: 'fdb', outcome: 'complete', rowCount: 2 } })}::jsonb, now() + interval '1 hour', now(), 1, 1, ${hex('d')}, ${hex('d')})`);
  await db.execute(sql`INSERT INTO topology_collection_runs (id, org_id, site_id, source_id, producer_id, producer_epoch, sequence, snapshot_id, content_digest, observed_at, effective_at,
      outcome, snapshot, normalized_bytes, expected_interval_seconds)
    VALUES (${ids.run}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${ids.source}::uuid, ${ids.device}::uuid, ${hex('e')}, 1, ${randomUUID()}::uuid, ${hex('d')}, now(), now(),
      'complete', '{}'::jsonb, 2, 300)`);
  await db.execute(sql`INSERT INTO topology_observations (id, org_id, site_id, run_id, observation_key, relationship_id, method, evidence_class, attributes, observed_at, effective_at, received_at, fresh_until)
    VALUES (${ids.observation}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${ids.run}::uuid, 'fdb|row-1', ${ids.fdb}::uuid, 'fdb', 'inferred', '{}'::jsonb, now(), now(), now(), now() + interval '1 hour')`);
  await db.execute(sql`INSERT INTO topology_relationship_support (org_id, site_id, relationship_id, source_id, latest_observation_id, producer_epoch, sequence, content_digest,
      first_positive_at, last_positive_at, effective_at, fresh_until)
    VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, ${ids.fdb}::uuid, ${ids.source}::uuid, ${ids.observation}::uuid, ${hex('e')}, 1, ${hex('d')}, now(), now(), now(), now() + interval '1 hour')`);
  return { scope, ids };
}

async function writeCounts(orgId: string) {
  const [row] = await getTestDb().execute<Record<string, string>>(sql`SELECT
    (SELECT count(*) FROM device_commands WHERE device_id IN (SELECT id FROM devices WHERE org_id = ${orgId}::uuid))::text AS commands,
    (SELECT count(*) FROM discovery_jobs WHERE org_id = ${orgId}::uuid)::text AS jobs,
    (SELECT count(*) FROM topology_diagnostic_runs WHERE org_id = ${orgId}::uuid)::text AS runs,
    (SELECT count(*) FROM topology_diagnostic_steps WHERE org_id = ${orgId}::uuid)::text AS steps,
    (SELECT count(*) FROM topology_view_exclusions WHERE org_id = ${orgId}::uuid)::text AS exclusions,
    (SELECT count(*) FROM topology_change_outbox WHERE org_id = ${orgId}::uuid)::text AS outbox,
    (SELECT graph_revision FROM topology_site_state WHERE org_id = ${orgId}::uuid LIMIT 1)::text AS revision,
    (SELECT max(updated_at) FROM topology_relationships WHERE org_id = ${orgId}::uuid)::text AS relationships`);
  return row;
}

describe('M2 physical read gating, exclusions, coverage and evidence (real DB)', () => {
  it('hides collected physical relationships and physical-only nodes everywhere while the flag is off, and restores them without reprojection', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const { ids } = await seed(env);
    await setFlags(env.organization.id, false);

    const overview = await graph(env, 'view=overview');
    expect(overview.relationships.map((r) => r.id)).toEqual([ids.member]);
    expect(overview.nodes.map((n) => n.id)).not.toContain(ids.chassis);
    expect(overview.counts.totalRelationships).toBe(1);
    const physical = await graph(env, 'view=physical');
    expect(physical.nodes).toEqual([]); expect(physical.relationships).toEqual([]);
    expect(physical.coverage.reasons.map((r) => r.code)).toEqual(['physical_disabled']);
    // Neighborhood: the host's one-hop overview neighborhood no longer reaches the switch.
    const neighborhood = await graph(env, `view=overview&focusNodeId=${ids.host}&hops=1`);
    expect(neighborhood.nodes.map((n) => n.id).sort()).toEqual([ids.host, ids.net].sort());
    for (const path of [`relationships/${ids.fdb}`, `relationships/${ids.fdb}/evidence`, `health?relationshipIds=${ids.fdb}`, `nodes/${ids.chassis}`]) {
      expect((await get(env, path)).status, path).toBe(404);
    }
    const list = await json(env, 'nodes?limit=100', (v) => v as { nodes: { id: string }[] });
    expect(list.nodes.map((n) => n.id)).not.toContain(ids.chassis);

    await setFlags(env.organization.id, true);
    const enabled = await graph(env, 'view=overview');
    expect(enabled.relationships.map((r) => r.id).sort()).toEqual([ids.link, ids.fdb, ids.fdb2, ids.member].sort());
    expect(enabled.nodes.map((n) => n.id)).toContain(ids.chassis);
    expect((await get(env, `relationships/${ids.fdb}`)).status).toBe(200);
  });

  it('refuses a cursor issued while physical was exposed once it is turned off', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await seed(env); await setFlags(env.organization.id, true);
    const first = await graph(env, 'view=overview&limit=1');
    expect(first.frontier.length).toBeGreaterThan(0);
    await setFlags(env.organization.id, false);
    expect((await get(env, `expansions/${first.frontier[0]!.token}`)).status).toBe(400);
  });

  it('applies an exclusion to one view only, adjusts counts and neighborhoods, and keeps detail and evidence inspectable', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const { scope, ids } = await seed(env); await setFlags(env.organization.id, true);
    const before = await graph(env, 'view=physical');
    const exclusionId = randomUUID();
    await getTestDb().execute(sql`INSERT INTO topology_view_exclusions (id, org_id, site_id, relationship_id, view, reason)
      VALUES (${exclusionId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${ids.fdb}::uuid, 'physical', 'Not a real cable')`);
    const after = await graph(env, 'view=physical');
    expect(after.relationships.map((r) => r.id)).not.toContain(ids.fdb);
    expect(after.counts.totalRelationships).toBe(before.counts.totalRelationships - 1);
    expect((await graph(env, 'view=overview')).relationships.map((r) => r.id)).toContain(ids.fdb);
    // Excluding the second candidate too removes the host from physical-view membership.
    await getTestDb().execute(sql`INSERT INTO topology_view_exclusions (org_id, site_id, relationship_id, view, reason)
      VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, ${ids.fdb2}::uuid, 'physical', 'Not a real cable')`);
    const hostless = await graph(env, 'view=physical');
    expect(hostless.nodes.map((n) => n.id)).not.toContain(ids.host);
    expect(hostless.counts.totalNodes).toBe(before.counts.totalNodes - 1);

    const detail = await json(env, `relationships/${ids.fdb}`, (v) => relationshipDetailResponseSchema.parse(v));
    expect(detail.relationship).toMatchObject({ id: ids.fdb, excluded: true, evidence: { methods: ['fdb'] } });
    expect(detail.exclusions).toEqual([expect.objectContaining({ id: exclusionId, view: 'physical', reason: 'Not a real cable' })]);
    expect(detail.endpoints.source).toMatchObject({ label: 'Core switch', port: { name: 'port-24', alias: 'Desk drop', key: 'if:24' } });
    expect(detail.physical).toMatchObject({ method: 'fdb', portRole: 'learned', fdbSelection: 'competing' });
    expect(detail.alternatives).toEqual([expect.objectContaining({ relationshipId: ids.fdb2, sourceNodeLabel: 'Core switch', port: expect.objectContaining({ name: 'port-2' }) })]);
    const evidence = await json(env, `relationships/${ids.fdb}/evidence?limit=1`, (v) => relationshipEvidenceResponseSchema.parse(v));
    expect(evidence.observations.map((o) => [o.id, o.status, o.producerKind])).toEqual([[ids.observation, 'current', 'discovery']]);
    expect(evidence.confirmations).toHaveLength(1);
    expect(evidence.details.state).toBe('available');
  });

  it('computes distinct coverage reasons from expected scopes, including scopes that never reported', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const { scope, ids } = await seed(env); await setFlags(env.organization.id, true);
    const db = getTestDb();
    const source = (protocol: string, context: string, outcome: string, reasonCode: string | null, rowCount: number) => db.execute(sql`INSERT INTO topology_collection_sources
        (org_id, site_id, producer_id, producer_kind, producer_epoch, protocol, context_key, last_outcome, current_baseline, fresh_until, last_received_at)
      VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, ${ids.device}::uuid, 'discovery', ${hex('e')}, ${protocol}, ${context}, ${outcome},
        ${JSON.stringify({ section: { outcome, rowCount, ...(reasonCode ? { reasonCode } : {}) } })}::jsonb, now() + interval '1 hour', now())`);
    await source('lldp', 'snmp:192.0.2.2/default', 'complete', null, 0);
    await source('cdp', 'snmp:192.0.2.2/default', 'unsupported', 'not_supported', 0);
    await source('lldp', 'snmp:192.0.2.3/default', 'failed', 'timeout', 0);
    await source('fdb', 'snmp:192.0.2.3/default', 'partial', 'limit_exceeded', 5);
    await source('lldp', 'snmp:192.0.2.4/default', 'failed', 'no_usable_credentials', 0);
    await db.execute(sql`UPDATE topology_relationships SET attributes = jsonb_set(attributes, '{physical,resolution}', '"unresolved"') WHERE id = ${ids.fdb2}::uuid`);
    // An expected discovery scope whose deadline passed with no report from its collector.
    const profileId = randomUUID(), otherDevice = randomUUID();
    await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${otherDevice}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${otherDevice}, 'collector-2', 'linux', '1', 'amd64', '1')`);
    await db.execute(sql`INSERT INTO discovery_profiles (id, org_id, site_id, name, subnets, methods) VALUES (${profileId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'p', ARRAY['192.0.2.0/24'], ARRAY['snmp']::discovery_method[])`);
    await db.execute(sql`INSERT INTO discovery_jobs (profile_id, org_id, site_id, status, topology_dispatch, topology_deadline_at, topology_config_generation)
      VALUES (${profileId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'completed',
        ${JSON.stringify({ deviceId: otherDevice, dispatchedAt: new Date(Date.now() - 3_600_000).toISOString() })}::jsonb, now() - interval '30 minutes', ${hex('a')})`);
    // A UniFi controller site mapped here with no local collector, and one a collector here could not place.
    const integrationId = randomUUID(), collectorId = randomUUID();
    await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${integrationId}::uuid, ${env.partner.id}::uuid, 'k')`);
    await db.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id) VALUES (${integrationId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'host:cloud', 'default')`);
    await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
      VALUES (${collectorId}::uuid, ${integrationId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'host:local', ${ids.device}::uuid, 'https://unifi.local', 'k')`);
    await db.execute(sql`INSERT INTO unifi_controller_sites (collector_id, org_id, local_site_id, topology_coverage_reason) VALUES (${collectorId}::uuid, ${scope.orgId}::uuid, 'branch', 'controller_site_unmapped')`);

    const before = await writeCounts(scope.orgId);
    const physical = await graph(env, 'view=physical');
    expect(physical.coverage.state).toBe('limited');
    const counts = Object.fromEntries(physical.coverage.reasons.map((r) => [r.code, r.count]));
    expect(counts).toMatchObject({
      collection_complete_empty: 1, collection_unsupported: 1, collection_timeout: 1, collection_partial_limit: 1, credentials_missing: 1,
      interface_unresolved: 1, collection_not_received: 1, no_collector: 1, controller_site_unmapped: 1,
    });
    expect(new Set(physical.coverage.reasons.map((r) => r.message)).size).toBe(physical.coverage.reasons.length);
    expect((await graph(env, 'view=logical')).coverage.reasons.map((r) => r.code)).toEqual(['legacy_evidence_only']);
    expect(await writeCounts(scope.orgId)).toEqual(before);
  });

  it('writes nothing and dispatches nothing on any GET', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const { scope, ids } = await seed(env); await setFlags(env.organization.id, true);
    const before = await writeCounts(scope.orgId);
    const first = await graph(env, 'view=physical&limit=1');
    for (const path of ['graph?view=overview', 'graph?view=logical', `graph?view=physical&focusNodeId=${ids.sw}&hops=2`, 'nodes?limit=10', `nodes/${ids.sw}`,
      `relationships/${ids.fdb}`, `relationships/${ids.fdb}/evidence`, `health?relationshipIds=${ids.fdb},${ids.link}&nodeIds=${ids.sw}`,
      ...first.frontier.map((f) => `expansions/${f.token}`)]) {
      const res = await get(env, path); expect(res.status, `${path}: ${await res.text()}`).toBe(200);
    }
    expect(await writeCounts(scope.orgId)).toEqual(before);
  });
});
