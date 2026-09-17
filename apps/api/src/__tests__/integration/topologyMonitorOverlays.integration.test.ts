import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { graphResponseSchema } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { topologyGraphRoutes } from '../../routes/topology/graphs';
import { canonicalIdentityKey } from '../../services/topology/identity';
import type { TopologyRequestContext } from '../../services/topology/access';
import {
  advanceTopologyHealthRevision, readTopologyMonitorOverlays,
} from '../../services/topology/monitorOverlays';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

const READ = [
  { resource: 'topology', action: 'read' },
  { resource: 'devices', action: 'read' },
  { resource: 'alerts', action: 'read' },
];

function context(
  env: TestEnvironment, siteId: string,
  overrides: { permissions?: { resource: string; action: string }[]; allowedSiteIds?: string[] } = {},
): TopologyRequestContext {
  return {
    auth: { orgId: env.organization.id, allowedSiteIds: overrides.allowedSiteIds, canAccessOrg: () => true },
    permissions: { scope: 'organization', orgId: env.organization.id, permissions: overrides.permissions ?? READ },
    scope: { orgId: env.organization.id, siteId },
  } as unknown as TopologyRequestContext;
}

function scoped<T>(orgId: string, action: () => Promise<T>) {
  return withDbAccessContext(orgContext(orgId), action);
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** One site, one canonical node bound to a device, and one bound ICMP monitor. */
async function seed(orgId: string, siteId: string, options: { bind?: boolean } = {}) {
  const test = getTestDb();
  const nodeId = randomUUID();
  const originNodeId = randomUUID();
  const deviceId = randomUUID();
  const assetId = randomUUID();
  const monitorId = randomUUID();

  await test.execute(sql`INSERT INTO topology_site_state (org_id, site_id, graph_revision, health_revision)
    VALUES (${orgId}::uuid, ${siteId}::uuid, 5, 2)
    ON CONFLICT (org_id, site_id) DO UPDATE SET graph_revision = 5, health_revision = 2`);
  await test.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${deviceId}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${deviceId}, 'collector', 'linux', '1', 'amd64', '1')`);
  await test.execute(sql`INSERT INTO discovered_assets (id, org_id, site_id, ip_address)
    VALUES (${assetId}::uuid, ${orgId}::uuid, ${siteId}::uuid, '192.0.2.1')`);
  for (const [id, kind] of [[nodeId, 'gateway'], [originNodeId, 'endpoint']] as const) {
    await test.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${canonicalIdentityKey({ orgId, siteId }, kind, id)},
        ${JSON.stringify({ version: 1, kind, sourceKey: id })}::jsonb, ${kind})`);
  }
  await test.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, device_id)
    VALUES (${orgId}::uuid, ${siteId}::uuid, ${originNodeId}::uuid, ${deviceId}::uuid)`);
  await test.execute(sql`INSERT INTO network_monitors (id, org_id, site_id, asset_id, name, monitor_type, target, polling_interval, is_active)
    VALUES (${monitorId}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${assetId}::uuid, 'Gateway ping', 'icmp_ping', '192.0.2.1', 60, true)`);

  const fixture = { orgId, siteId, nodeId, originNodeId, deviceId, assetId, monitorId };
  if (options.bind !== false) await bind(fixture, monitorId);
  return fixture;
}

async function bind(fixture: { orgId: string; siteId: string; nodeId: string; deviceId: string }, monitorId: string, metricRole = 'connectivity') {
  await getTestDb().execute(sql`INSERT INTO topology_monitor_bindings
      (org_id, site_id, node_id, monitor_id, context_key, family, metric_role, origin_policy)
    VALUES (${fixture.orgId}::uuid, ${fixture.siteId}::uuid, ${fixture.nodeId}::uuid, ${monitorId}::uuid,
      'default', 'ipv4', ${metricRole}, ${JSON.stringify({ deviceId: fixture.deviceId })}::jsonb)`);
}

async function result(
  fixture: Seed, status: 'online' | 'offline' | 'degraded',
  options: { monitorId?: string; deviceId?: string; ageSeconds?: number } = {},
) {
  const id = randomUUID();
  await getTestDb().execute(sql`INSERT INTO network_monitor_results (id, monitor_id, org_id, device_id, status, "timestamp")
    VALUES (${id}::uuid, ${options.monitorId ?? fixture.monitorId}::uuid, ${fixture.orgId}::uuid,
      ${options.deviceId ?? fixture.deviceId}::uuid, ${status}, now() - make_interval(secs => ${options.ageSeconds ?? 5}))`);
  return id;
}

async function alert(fixture: Seed, deviceId: string, monitorId = fixture.monitorId) {
  const id = randomUUID();
  await getTestDb().execute(sql`INSERT INTO alerts (id, device_id, org_id, status, severity, title, context)
    VALUES (${id}::uuid, ${deviceId}::uuid, ${fixture.orgId}::uuid, 'active', 'critical', 'Monitor down',
      ${JSON.stringify({ source: 'network_monitor', monitorId })}::jsonb)`);
  return id;
}

describe('topology monitor overlays against real PostgreSQL', () => {
  it('attributes a reused monitor result to its bound subject through the unprivileged app role', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const fixture = await seed(env.organization.id, env.site.id);
    const resultId = await result(fixture, 'online');

    const overlays = await scoped(fixture.orgId, async () => {
      const [role] = await db.execute<{ current_user: string }>(sql`SELECT current_user`);
      expect(role?.current_user).toBe('breeze_app');
      return readTopologyMonitorOverlays(context(env, fixture.siteId), [{ kind: 'node', id: fixture.nodeId }]);
    });

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({
      subject: { kind: 'node', id: fixture.nodeId },
      status: 'healthy', coverage: 'monitored', freshness: 'fresh', activeAlertCount: 0,
    });
    expect(overlays[0]!.provenance).toMatchObject({
      monitorId: fixture.monitorId, monitorName: 'Gateway ping', monitorType: 'icmp_ping',
      destination: '192.0.2.1', resultId, originDeviceId: fixture.deviceId, originNodeId: fixture.originNodeId,
    });
  });

  it('never reuses an assetless legacy monitor that has no site', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const fixture = await seed(env.organization.id, env.site.id, { bind: false });
    const legacyId = randomUUID();
    await getTestDb().execute(sql`INSERT INTO network_monitors (id, org_id, name, monitor_type, target)
      VALUES (${legacyId}::uuid, ${fixture.orgId}::uuid, 'legacy', 'icmp_ping', '192.0.2.1')`);
    await getTestDb().execute(sql`INSERT INTO network_monitor_results (monitor_id, org_id, status, "timestamp")
      VALUES (${legacyId}::uuid, ${fixture.orgId}::uuid, 'online', now())`);

    // The canonical binding table refuses a monitor that is not in this site,
    // which is what keeps the legacy row out of every overlay read.
    await expect(bind(fixture, legacyId)).rejects.toMatchObject({ cause: { code: '23503' } });

    const overlays = await scoped(fixture.orgId, () =>
      readTopologyMonitorOverlays(context(env, fixture.siteId), [{ kind: 'node', id: fixture.nodeId }]));
    expect(overlays).toEqual([]);
  });

  it('stops attributing a monitor once its asset moves to another site', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const fixture = await seed(env.organization.id, env.site.id);
    await result(fixture, 'online');
    const destination = await createSite({ orgId: fixture.orgId });

    await scoped(fixture.orgId, () => db.execute(sql`UPDATE discovered_assets SET site_id = ${destination.id}::uuid
      WHERE id = ${fixture.assetId}::uuid`));

    const overlays = await scoped(fixture.orgId, () =>
      readTopologyMonitorOverlays(context(env, fixture.siteId), [{ kind: 'node', id: fixture.nodeId }]));
    expect(overlays).toEqual([]);
  });

  it('counts only the alerts the reader may see and withholds the count entirely when denied', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const fixture = await seed(env.organization.id, env.site.id);
    await result(fixture, 'offline');
    const elsewhere = await createSite({ orgId: fixture.orgId });
    const farDeviceId = randomUUID();
    await getTestDb().execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${farDeviceId}::uuid, ${fixture.orgId}::uuid, ${elsewhere.id}::uuid, ${farDeviceId}, 'far', 'linux', '1', 'amd64', '1')`);
    await alert(fixture, fixture.deviceId);
    await alert(fixture, farDeviceId);

    const subjects = [{ kind: 'node' as const, id: fixture.nodeId }];
    const unrestricted = await scoped(fixture.orgId, () =>
      readTopologyMonitorOverlays(context(env, fixture.siteId), subjects));
    const restricted = await scoped(fixture.orgId, () =>
      readTopologyMonitorOverlays(context(env, fixture.siteId, { allowedSiteIds: [fixture.siteId] }), subjects));
    const denied = await scoped(fixture.orgId, () => readTopologyMonitorOverlays(
      context(env, fixture.siteId, { permissions: READ.filter((p) => p.resource !== 'alerts') }), subjects));

    expect(unrestricted[0]!.activeAlertCount).toBe(2);
    expect(restricted[0]!.activeAlertCount).toBe(1);
    expect(denied[0]!.activeAlertCount).toBeNull();
    expect(denied[0]!.reasons).toContain('alert_counts_restricted');
    expect(denied[0]!.status).toBe('failed_check');
  });

  it('collapses duplicate compatible bindings onto the freshest measurement', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const fixture = await seed(env.organization.id, env.site.id);
    await result(fixture, 'offline', { ageSeconds: 30 });
    const secondMonitorId = randomUUID();
    await getTestDb().execute(sql`INSERT INTO network_monitors (id, org_id, site_id, name, monitor_type, target, polling_interval)
      VALUES (${secondMonitorId}::uuid, ${fixture.orgId}::uuid, ${fixture.siteId}::uuid, 'Second ping', 'icmp_ping', '192.0.2.1', 60)`);
    await bind(fixture, secondMonitorId);
    await result(fixture, 'online', { monitorId: secondMonitorId, ageSeconds: 1 });

    const overlays = await scoped(fixture.orgId, () =>
      readTopologyMonitorOverlays(context(env, fixture.siteId), [{ kind: 'node', id: fixture.nodeId }]));

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({ status: 'healthy', provenance: { monitorId: secondMonitorId } });
  });

  it('keeps another organization bindings invisible under row level security', async () => {
    const mine = await setupTestEnvironment({ rolePermissions: READ });
    const theirs = await setupTestEnvironment({ rolePermissions: READ });
    const foreign = await seed(theirs.organization.id, theirs.site.id);
    await result(foreign, 'online');

    const overlays = await scoped(mine.organization.id, () => readTopologyMonitorOverlays(
      context(mine, foreign.siteId), [{ kind: 'node', id: foreign.nodeId }]));
    expect(overlays).toEqual([]);
  });

  it('serves attributed health on a graph GET without issuing a command or moving a revision', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const fixture = await seed(env.organization.id, env.site.id);
    const resultId = await result(fixture, 'degraded');

    const app = new Hono();
    app.use('*', authMiddleware);
    app.route('/topology', topologyGraphRoutes);
    const before = await revisions(fixture.siteId);
    const commandsBefore = await commandCount();

    const response = await app.request(`/topology/sites/${fixture.siteId}/graph?includeHealth=true`, {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const graph = graphResponseSchema.parse(await response.json());

    const subject = graph.nodes.find((node) => node.id === fixture.nodeId)!;
    expect(subject.health).toMatchObject({
      status: 'degraded', coverage: 'monitored', freshness: 'fresh',
      originNodeId: fixture.originNodeId, resultId,
    });
    const origin = graph.nodes.find((node) => node.id === fixture.originNodeId)!;
    expect(origin.health).toMatchObject({ status: 'unknown', coverage: 'unmonitored' });
    expect(origin.health.reasons.length).toBeGreaterThan(0);

    expect(await commandCount()).toBe(commandsBefore);
    expect(await revisions(fixture.siteId)).toEqual(before);
  });

  it('advances only the health revision when health is refreshed', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const fixture = await seed(env.organization.id, env.site.id);
    const before = await revisions(fixture.siteId);

    await scoped(fixture.orgId, () => advanceTopologyHealthRevision(db, { orgId: fixture.orgId, siteId: fixture.siteId }));

    const after = await revisions(fixture.siteId);
    expect(after.health).toBe(String(Number(before.health) + 1));
    expect(after.graph).toBe(before.graph);
    expect(after.dirty).toBe(before.dirty);
  });
});

async function revisions(siteId: string) {
  const [row] = await getTestDb().execute<{ graph: string; health: string; dirty: string }>(
    sql`SELECT graph_revision::text AS graph, health_revision::text AS health, dirty_revision::text AS dirty
      FROM topology_site_state WHERE site_id = ${siteId}::uuid`,
  );
  return row!;
}

async function commandCount(): Promise<number> {
  const [row] = await getTestDb().execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM device_commands`);
  return Number(row!.count);
}
