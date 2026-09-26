import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  relationshipDetailResponseSchema, topologyInterfaceHistoryResponseSchema, topologyLinkHealthResponseSchema,
} from '@breeze/shared';
import { authMiddleware } from '../../middleware/auth';
import { topologyGraphRoutes } from '../../routes/topology/graphs';
import { topologyHistoryRoutes } from '../../routes/topology/history';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * M3 Task 6 against real Postgres through the authenticated routes (request
 * RLS): interface history and link health are scoped to the exact site and
 * org, gated by the physical + interfaceHealth capability, bounded, and
 * side-effect free — no command, discovery job, diagnostic run, sample,
 * rollup or revision is written by any read.
 */
const READ = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }];
const app = () => new Hono().use('*', authMiddleware).route('/topology', topologyGraphRoutes).route('/topology', topologyHistoryRoutes);
const get = (env: TestEnvironment, siteId: string, path: string) =>
  app().request(`/topology/sites/${siteId}/${path}`, { headers: { Authorization: `Bearer ${env.token}` } });
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function setFlags(orgId: string, flags: Record<string, boolean>) {
  await getTestDb().execute(sql`UPDATE organizations SET settings = ${JSON.stringify({ topologyFeatureFlags: { materialization: true, ui: true, ...flags } })}::jsonb WHERE id = ${orgId}::uuid`);
}

type Seed = Awaited<ReturnType<typeof seed>>;
/** A switch node with one port, a physical LLDP link to a neighbor port, one SNMP telemetry source and 20 minutes of samples. */
async function seed(orgId: string, siteId: string, options: { operStatus?: string; ageMs?: number } = {}) {
  const db = getTestDb();
  const scope = { orgId, siteId };
  const ids = { sw: randomUUID(), peer: randomUUID(), port: randomUUID(), peerPort: randomUUID(), link: randomUUID(), member: randomUUID(), device: randomUUID(), source: randomUUID() };
  await db.execute(sql`INSERT INTO topology_site_state (org_id, site_id, graph_revision, health_revision) VALUES (${orgId}::uuid, ${siteId}::uuid, 5, 3) ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${ids.device}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${ids.device}, 'poller', 'linux', '1', 'amd64', '1')`);
  for (const [id, key] of [[ids.sw, `device:${ids.device}`], [ids.peer, `net:${ids.peer}`]] as const) {
    await db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${canonicalIdentityKey(scope, 'endpoint', key)}, ${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: key })}::jsonb, 'endpoint')`);
  }
  await db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, device_id) VALUES (${orgId}::uuid, ${siteId}::uuid, ${ids.sw}::uuid, ${ids.device}::uuid)`);
  for (const [id, owner, key] of [[ids.port, ids.sw, 'if:1'], [ids.peerPort, ids.peer, 'if:9']] as const) {
    await db.execute(sql`INSERT INTO topology_interfaces (id, org_id, site_id, owner_node_id, interface_key, epoch, name)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${owner}::uuid, ${key}, 'gen:1', ${key})`);
  }
  const rel = (id: string, kind: string, evidence: string, si: string | null, ti: string | null, attributes: object) => db.execute(sql`INSERT INTO topology_relationships
      (id, org_id, site_id, canonical_key, identity_material, kind, source_node_id, target_node_id, source_interface_id, target_interface_id, directness, confidence, evidence_class, support_count, last_supported_at, attributes)
    VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${canonicalIdentityKey(scope, kind as 'attachment', id)}, ${JSON.stringify({ version: 1, kind, sourceKey: id })}::jsonb,
      ${kind}, ${ids.sw}::uuid, ${ids.peer}::uuid, ${si}::uuid, ${ti}::uuid, 'direct', 'high', ${evidence}, 1, now(), ${JSON.stringify(attributes)}::jsonb)`);
  await rel(ids.link, 'physical_link', 'observed', ids.port, ids.peerPort, { method: 'lldp', physical: { resolution: 'resolved' } });
  await rel(ids.member, 'network_member', 'inferred', null, null, {});
  await db.execute(sql`INSERT INTO topology_collection_sources (id, org_id, site_id, producer_id, producer_kind, producer_epoch, protocol, context_key, address_family,
      expected_interval_seconds, last_outcome, last_received_at, accepted_sequence, confirmed_sequence)
    VALUES (${ids.source}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${ids.device}::uuid, 'snmp', 'p1', 'if_metrics', 'snmp:192.0.2.10', 'any', 60, 'complete', now(), 20, 20)`);
  const now = Date.now() - (options.ageMs ?? 0);
  for (const day of new Set([iso(now - 25 * MIN).slice(0, 10), iso(now).slice(0, 10)])) {
    await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition('raw', ${day}::date)`);
  }
  for (let i = 0; i <= 20; i += 1) {
    const at = now - (20 - i) * MIN;
    const readings = { v: 1, expectedIntervalSeconds: 60, counterWidth: 64, inOctets: String(7500 * i), outOctets: '0', inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0',
      inPackets: null, outPackets: null, capacityBps: '1000000', discontinuityTicks: '0', deviceUptimeTicks: String(1_000_000 + i * 6000), reportedInBps: null, reportedOutBps: null,
      adminStatus: 'up', operStatus: i === 20 ? (options.operStatus ?? 'up') : 'up', unavailable: {} };
    await db.execute(sql`INSERT INTO topology_interface_samples (org_id, site_id, interface_id, interface_epoch, source_id, producer_epoch, source_sequence, sampled_at, resolution, readings, sample_count)
      VALUES (${orgId}::uuid, ${siteId}::uuid, ${ids.port}::uuid, 'gen:1', ${ids.source}::uuid, 'p1', ${String(i + 1)}, ${iso(at)}::timestamptz, 'raw', ${JSON.stringify(readings)}::jsonb, 1)`);
  }
  return { scope, ids, now };
}

async function sideEffects(orgId: string) {
  const [row] = await getTestDb().execute<Record<string, string>>(sql`SELECT
    (SELECT count(*) FROM device_commands WHERE device_id IN (SELECT id FROM devices WHERE org_id = ${orgId}::uuid))::text AS commands,
    (SELECT count(*) FROM discovery_jobs WHERE org_id = ${orgId}::uuid)::text AS jobs,
    (SELECT count(*) FROM topology_diagnostic_runs WHERE org_id = ${orgId}::uuid)::text AS runs,
    (SELECT count(*) FROM topology_interface_samples WHERE org_id = ${orgId}::uuid)::text AS samples,
    (SELECT string_agg(graph_revision::text || '/' || health_revision::text, ',') FROM topology_site_state WHERE org_id = ${orgId}::uuid) AS revisions,
    (SELECT max(updated_at) FROM topology_collection_sources WHERE org_id = ${orgId}::uuid)::text AS sources`);
  return row;
}

const history = (seedData: Seed, extra = '') => `interfaces/${seedData.ids.port}/history?series=in_bps,in_errors_per_second&from=${iso(seedData.now - 15 * MIN)}&to=${iso(seedData.now)}${extra}`;

describe('M3 Task 6 interface history and link health (real DB)', () => {
  it('serves scoped bounded history and link health with zero polls, commands or writes', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: true });
    const s = await seed(env.organization.id, env.site.id, { operStatus: 'down' });
    const before = await sideEffects(env.organization.id);

    const res = await get(env, env.site.id, history(s, '&resolution=raw'));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const parsed = topologyInterfaceHistoryResponseSchema.parse(body);
    expect(parsed.resolution).toBe('raw');
    const bps = parsed.series.find((series) => series.name === 'in_bps')!;
    expect(bps).toMatchObject({ unit: 'bits_per_second', interfaceEpoch: 'gen:1', sourceId: s.ids.source, sourceKind: 'snmp' });
    expect(bps.points.filter((p) => p.value !== null).every((p) => Math.abs(p.value! - 1000) < 1e-6)).toBe(true);
    expect(parsed.epochs).toEqual([expect.objectContaining({ current: true, sourceState: 'active' })]);

    const link = await get(env, env.site.id, `relationships/${s.ids.link}/health`);
    const linkBody = topologyLinkHealthResponseSchema.parse(await link.json());
    expect(link.status).toBe(200);
    expect(linkBody.health).toMatchObject({ status: 'failed_check', freshness: 'fresh' });
    expect(linkBody.health.reasons.map((r) => r.code)).toContain('interface_link_down');
    expect(linkBody.endpoints.source).toMatchObject({ interfaceId: s.ids.port, operStatus: 'down', status: 'failed_check' });
    expect(linkBody.endpoints.target).toMatchObject({ interfaceId: s.ids.peerPort, status: 'unknown', reasons: ['interface_unmeasured'] });
    expect(linkBody.healthRevision).toBe('3');
    expect(Date.parse(linkBody.freshUntil!)).toBeGreaterThan(Date.now());
    // The same port evidence reaches the batch health read and relationship detail.
    const batch = await (await get(env, env.site.id, `health?relationshipIds=${s.ids.link},${s.ids.member}`)).json() as { relationships: { id: string; health: { status: string } }[]; freshUntil: string };
    expect(batch.relationships.find((r) => r.id === s.ids.link)!.health.status).toBe('failed_check');
    // An inferred membership edge never inherits cable status.
    expect(batch.relationships.find((r) => r.id === s.ids.member)!.health.status).toBe('unknown');
    const detail = relationshipDetailResponseSchema.parse(await (await get(env, env.site.id, `relationships/${s.ids.link}`)).json());
    expect(detail.relationship.health.status).toBe('failed_check');

    expect(await sideEffects(env.organization.id)).toEqual(before);
  });

  it('refuses an otherwise valid interface or link from another site of the same org, and from another org', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: true });
    const siteB = (await createSite({ orgId: env.organization.id })).id;
    const inB = await seed(env.organization.id, siteB);
    await seed(env.organization.id, env.site.id);
    // Requested through site A: the site-B interface is not in scope.
    expect((await get(env, env.site.id, history(inB))).status).toBe(404);
    expect((await get(env, env.site.id, `relationships/${inB.ids.link}/health`)).status).toBe(404);
    // Its own site still serves it.
    expect((await get(env, siteB, history(inB))).status).toBe(200);

    const other = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(other.organization.id, { physical: true, interfaceHealth: true });
    const foreign = await seed(other.organization.id, other.site.id);
    expect((await get(env, other.site.id, history(foreign))).status).toBe(404);
    expect((await get(env, env.site.id, history(foreign))).status).toBe(404);
  });

  it('denies a reader without topology read and hides history while the capability is off', async () => {
    const denied = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    await setFlags(denied.organization.id, { physical: true, interfaceHealth: true });
    const d = await seed(denied.organization.id, denied.site.id);
    expect((await get(denied, denied.site.id, history(d))).status).toBe(403);

    const env = await setupTestEnvironment({ rolePermissions: READ });
    const s = await seed(env.organization.id, env.site.id, { operStatus: 'down' });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: false });
    expect((await get(env, env.site.id, history(s))).status).toBe(404);
    const link = topologyLinkHealthResponseSchema.parse(await (await get(env, env.site.id, `relationships/${s.ids.link}/health`)).json());
    expect(link).toMatchObject({ interfaceEvidence: { applies: false, reason: 'interface_health_unavailable' }, endpoints: { source: null, target: null } });
    await setFlags(env.organization.id, { physical: false, interfaceHealth: true });
    expect((await get(env, env.site.id, history(s))).status).toBe(404);
    expect((await get(env, env.site.id, `relationships/${s.ids.link}/health`)).status).toBe(404);
  });

  it('reports stale measurement and a stopped source honestly instead of the last status', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: true });
    const stale = await seed(env.organization.id, env.site.id, { operStatus: 'down', ageMs: 10 * MIN });
    let link = topologyLinkHealthResponseSchema.parse(await (await get(env, env.site.id, `relationships/${stale.ids.link}/health`)).json());
    expect(link.endpoints.source).toMatchObject({ status: 'unknown', freshness: 'stale', reasons: ['interface_measurement_stale'] });
    expect(link.health.status).toBe('unknown');

    // A fresh port-down whose measurement was stopped (source revoked) is unmonitored at once.
    const siteB = (await createSite({ orgId: env.organization.id })).id;
    const stopped = await seed(env.organization.id, siteB, { operStatus: 'down' });
    await getTestDb().execute(sql`UPDATE topology_collection_sources SET revoked_at = now() WHERE id = ${stopped.ids.source}::uuid`);
    link = topologyLinkHealthResponseSchema.parse(await (await get(env, siteB, `relationships/${stopped.ids.link}/health`)).json());
    expect(link.endpoints.source).toMatchObject({ status: 'unknown', coverage: 'unmonitored', reasons: ['interface_measurement_stopped'], operStatus: null });
    expect(link.health.status).toBe('unknown');
    // History of a stopped source stays readable as history.
    const body = topologyInterfaceHistoryResponseSchema.parse(await (await get(env, siteB, history(stopped, '&resolution=raw'))).json());
    expect(body.epochs[0]).toMatchObject({ sourceState: 'stopped' });
  });
});
