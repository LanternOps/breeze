import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { closeDb, db, runOutsideDbContext, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { organizations, organizationUsers } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { clearPermissionCache } from '../../services/permissions';
import { createAccessToken } from '../../services/jwt';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { assignUserToOrganization, createRole, createSite, createUser, grantRolePermissions, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

export { closeDb };

/**
 * Two-site org for topology site location W2 (#7886) over the REAL collection seam: each device reports one LAN
 * (its own address, prefix and default gateway, optionally the gateway's ARP row) into its assigned site's graph
 * via negotiateTopologyContext -> ingestTopologyNetworkContext -> reconcileTopologySite, as
 * topologyNeighbourCorroboration.integration.test.ts does. Fictional names only (Harbor Dental, Main Office,
 * Lakeside).
 */
export const PRESENCE_GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'devices', action: 'read' },
];

export type PresenceSiteKey = 'A' | 'B' | 'C';
export type PresenceDeviceSpec = {
  key: string; site: PresenceSiteKey; hostname: string;
  address: string; prefixLength?: number; gateway: string;
  /** The gateway's MAC in this device's own ARP cache (neighbor row), when set. */
  gatewayMac?: string;
  /** Interface kind reported for the LAN interface (e.g. 'tunnel'). */
  interfaceKind?: string;
};

export const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology presence test'));

async function insertDeclarations(orgId: string, siteId: string, prefixes: string[]) {
  if (!prefixes.length) return;
  await withDbAccessContext(orgContext(orgId), () => db.execute(sql`INSERT INTO discovery_profiles (org_id, site_id, name, enabled, subnets)
    VALUES (${orgId}::uuid, ${siteId}::uuid, ${`LAN sweep ${randomUUID().slice(0, 6)}`}, true, ${`{${prefixes.map((p) => `"${p}"`).join(',')}}`}::text[])`));
}

export async function twoSiteOrg(opts: {
  devices: PresenceDeviceSpec[];
  declare?: Partial<Record<PresenceSiteKey, string[]>>;
  withSiteC?: boolean;
}) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: PRESENCE_GRANTS, organizationOptions: { name: 'Harbor Dental' } as never });
  const orgId = env.organization.id;
  await getTestDb().execute(sql`UPDATE sites SET name = 'Main Office' WHERE id = ${env.site.id}::uuid`);
  const siteB = await createSite({ orgId, name: 'Lakeside' });
  const siteC = opts.withSiteC ? await createSite({ orgId, name: 'Harbor Annex' }) : null;
  const sites: Record<PresenceSiteKey, string> = { A: env.site.id, B: siteB.id, C: siteC?.id ?? '' };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  await system(() => db.update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, orgId)));

  const ids: Record<string, string> = {};
  for (const [index, spec] of opts.devices.entries()) {
    const deviceId = randomUUID();
    ids[spec.key] = deviceId;
    await scoped(async () => {
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status,last_seen_at,agent_token_hash)
        VALUES (${deviceId}::uuid,${orgId}::uuid,${sites[spec.site]}::uuid,${deviceId},${spec.hostname},'windows','11','amd64','1','online',now(),${randomUUID().replaceAll('-', '').padEnd(64, String(index % 10))})`);
      await db.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address,ip_address,ip_type,is_primary)
        VALUES (${deviceId}::uuid,${orgId}::uuid,'eth0',${`02:00:00:00:${(index >> 8).toString(16).padStart(2, '0')}:${(index & 255).toString(16).padStart(2, '0')}`},${spec.address},'ipv4',true)`);
    });
  }

  const usedSites = [...new Set(opts.devices.map((d) => d.site))];
  for (const key of (['A', 'B', 'C'] as const).filter((k) => sites[k])) {
    const scope = { orgId, siteId: sites[key] };
    let imported = await scoped(() => importLegacyTopologySite(scope));
    for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
    if (!imported.complete) throw new Error(`fixture import incomplete for site ${key}`);
  }
  for (const key of ['A', 'B', 'C'] as const) await insertDeclarations(orgId, sites[key], sites[key] ? opts.declare?.[key] ?? [] : []);

  const producers = new Map<string, AuthenticatedTopologyProducer>();
  const sequences = new Map<string, number>();
  const report = async (key: string, override: Partial<Pick<PresenceDeviceSpec, 'address' | 'prefixLength' | 'gateway' | 'gatewayMac' | 'interfaceKind'>> = {}) => {
    const spec = { ...opts.devices.find((d) => d.key === key)!, ...override };
    const deviceId = ids[key]!;
    let producer = producers.get(key);
    if (!producer) {
      const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(deviceId)));
      if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
      producer = { scope: { orgId, siteId: sites[spec.site] }, producerId: deviceId, producerKind: 'agent', producerEpoch: config.producerEpoch!,
        configurationRevision: config.configurationRevision!, sourceIdentity: config.sourceIdentity! };
      producers.set(key, producer);
    }
    const sequence = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, sequence);
    const value = networkContextFixture();
    Object.assign(value, { producerEpoch: producer.producerEpoch, sequence: String(sequence), snapshotId: randomUUID(),
      capturedAt: new Date(Date.now() - 1000 + sequence).toISOString() });
    const interfaces = value.sections.find((section) => section.kind === 'interfaces')!;
    const routes = value.sections.find((section) => section.kind === 'routes')!;
    const neighbors = value.sections.find((section) => section.kind === 'neighbors')!;
    interfaces.rows[0]!.addresses = [{ ...interfaces.rows[0]!.addresses[0]!, address: spec.address, prefixLength: spec.prefixLength ?? 24 }];
    if (spec.interfaceKind) (interfaces.rows[0] as { kind: string }).kind = spec.interfaceKind;
    routes.rows[0]!.nextHops = [{ ...routes.rows[0]!.nextHops[0]!, address: spec.gateway }];
    const rows = spec.gatewayMac
      ? [{ rowKey: 'nb-gateway', address: spec.gateway, family: 'ipv4' as const, zone: null, interfaceKey: 'if-1', mac: spec.gatewayMac, state: 'reachable' as const, isRouter: null }]
      : [];
    Object.assign(neighbors, { rows, rowCount: rows.length });
    for (const section of value.sections) section.contentDigest = topologySectionDigest(value, section, producer.sourceIdentity);
    value.contentDigest = topologyContextDigest(value, producer.sourceIdentity);
    const accepted = await scoped(() => ingestTopologyNetworkContext(producer!, value));
    if (!accepted.accepted) throw new Error(`fixture report rejected: ${JSON.stringify(accepted)}`);
  };
  const publish = async (key: PresenceSiteKey) => {
    const published = await scoped(() => withDbTransaction(() => reconcileTopologySite({ orgId, siteId: sites[key] })));
    if (!published.published) throw new Error(`fixture publish failed for site ${key}: ${JSON.stringify(published)}`);
  };
  const reportAll = async () => { for (const spec of opts.devices) await report(spec.key); };
  const publishAll = async () => { for (const key of usedSites) await publish(key); };

  /** Org members: unrestricted, Main Office only, Lakeside only. */
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, PRESENCE_GRANTS);
  const member = async (siteIds: string[] | null) => {
    const user = await createUser({ partnerId: env.partner.id, orgId });
    await assignUserToOrganization(user.id, orgId, role.id);
    if (siteIds) {
      await getTestDb().update(organizationUsers).set({ siteIds })
        .where(and(eq(organizationUsers.userId, user.id), eq(organizationUsers.orgId, orgId)));
    }
    const token = await createAccessToken({ sub: user.id, email: user.email, roleId: role.id, orgId, partnerId: env.partner.id,
      scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID() });
    return { userId: user.id, token };
  };
  const users = { both: await member(null), onlyA: await member([sites.A]), onlyB: await member([sites.B]) };

  const presenceRows = async () => {
    const rows = await getTestDb().execute(sql`SELECT device_id, org_id, assigned_site_id, state, reason, matched_site_id, declaring_site_ids,
        host(prefix) AS prefix_host, prefix::text AS prefix, host(gateway_address) AS gateway_address, gateway_mac::text AS gateway_mac,
        mac_corroborated, fingerprint_version::text AS fingerprint_version, fresh_until, observed_at
      FROM topology_device_presence WHERE org_id = ${orgId}::uuid`) as unknown as Array<Record<string, unknown> & { device_id: string }>;
    const byKey: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      const key = Object.entries(ids).find(([, id]) => id === row.device_id)?.[0] ?? row.device_id;
      byKey[key] = row;
    }
    return byKey;
  };

  /** Mount a router on the real auth middleware and GET a path as a token. */
  const request = async (routes: Hono, token: string, path: string, headers: Record<string, string> = {}) => {
    await clearPermissionCache();
    const app = new Hono();
    app.use('*', authMiddleware);
    app.route('/topology', routes);
    return app.request(path, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  };

  return { env, orgId, sites, siteA: sites.A, siteB: sites.B, siteC: sites.C, ids, report, reportAll, publish, publishAll, users, presenceRows, request, scoped };
}

export type TwoSiteOrg = Awaited<ReturnType<typeof twoSiteOrg>>;
