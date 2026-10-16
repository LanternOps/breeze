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
import { readSiteNetworkDeclarations } from '../../services/topology/siteNetworkDeclarations';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

/**
 * Site network declarations (site location W1, #7885) against real Postgres: enabled discovery
 * profile subnets and network baselines declare a site's networks by exact normalized prefix,
 * the read never leaves its org (RLS) or site, and the grouped overview marks LAN cards
 * declared/undeclared (AI reads pass `presentationGroups: false` and never carry it: graph.test.ts).
 */
const GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'devices', action: 'read' },
];
const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology site declarations test'));

async function profile(orgId: string, siteId: string, subnets: string[], enabled = true) {
  await withDbAccessContext(orgContext(orgId), () => db.execute(sql`INSERT INTO discovery_profiles (org_id, site_id, name, enabled, subnets)
    VALUES (${orgId}::uuid, ${siteId}::uuid, ${`Main LAN sweep ${crypto.randomUUID().slice(0, 6)}`}, ${enabled}, ${`{${subnets.map((s) => `"${s}"`).join(',')}}`}::text[])`));
}
async function baseline(orgId: string, siteId: string, subnet: string) {
  await withDbAccessContext(orgContext(orgId), () => db.execute(sql`INSERT INTO network_baselines (org_id, site_id, subnet)
    VALUES (${orgId}::uuid, ${siteId}::uuid, ${subnet})`));
}

describe('readSiteNetworkDeclarations', () => {
  it('declares exactly the normalized prefixes of the site\'s enabled profiles and baselines, under org RLS', async () => {
    const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
    const orgId = env.organization.id;
    const siteA = env.site.id;
    const siteB = (await createSite({ orgId, name: 'Lakeside' })).id;
    const org2 = await createOrganization({ partnerId: env.partner.id });
    const org2Site = (await createSite({ orgId: org2.id })).id;

    await profile(orgId, siteA, ['10.1.5.1/24', '10.1.5.0-10.1.5.255', '10.0.0.0/8', 'junk']);
    await profile(orgId, siteA, ['10.9.9.0/24'], false);
    await baseline(orgId, siteA, '10.1.2.0/24');
    await profile(orgId, siteB, ['10.1.7.0/24']);
    await profile(org2.id, org2Site, ['10.1.2.0/24']);

    const read = (contextOrg: string, siteId: string) => withDbAccessContext(orgContext(contextOrg), () => withDbTransaction(() =>
      readSiteNetworkDeclarations(db, { orgId, siteId })));
    const declarations = await read(orgId, siteA);
    expect([...declarations.prefixes.keys()].sort()).toEqual(['10.0.0.0/8', '10.1.2.0/24', '10.1.5.0/24']);
    expect(declarations.ignored).toBe(2);
    expect(declarations.prefixes.get('10.1.5.0/24')).toEqual([{ kind: 'discovery_profile', id: expect.any(String) }]);
    expect(declarations.prefixes.get('10.1.2.0/24')).toEqual([{ kind: 'network_baseline', id: expect.any(String) }]);
    expect([...(await read(orgId, siteB)).prefixes.keys()]).toEqual(['10.1.7.0/24']);

    // Control: the system scope sees site A's declarations, so the empty org-2 read below is RLS, not a vacuous query.
    expect((await system(() => withDbTransaction(() => readSiteNetworkDeclarations(db, { orgId, siteId: siteA })))).prefixes.size).toBe(3);
    const hidden = await read(org2.id, siteA);
    expect(hidden.prefixes.size).toBe(0);
    expect(hidden.ignored).toBe(0);
  });
});

/** A one-site org whose agents each report one LAN (address/prefix) via one gateway through the REAL collection seam. */
async function reportingSite(observers: { address: string; prefixLength: number; gateway: string }[]) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const scope = { orgId, siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  const deviceIds = observers.map(() => crypto.randomUUID());
  await system(() => db.update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, orgId)));
  await scoped(async () => {
    for (const [index, deviceId] of deviceIds.entries()) {
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status,last_seen_at,agent_token_hash)
        VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},${`declared-observer-${index}`},'linux','6.1','amd64','1','online',now(),${String(index + 1).padStart(64, 'd')})`);
      await db.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address,ip_address,ip_type,is_primary)
        VALUES (${deviceId}::uuid,${orgId}::uuid,'eth0',${`02:00:00:00:01:0${index}`},${observers[index]!.address},'ipv4',true)`);
    }
  });
  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  expect(imported.complete).toBe(true);
  for (const [index, deviceId] of deviceIds.entries()) {
    const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(deviceId)));
    if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
    const producer: AuthenticatedTopologyProducer = { scope, producerId: deviceId, producerKind: 'agent', producerEpoch: config.producerEpoch!,
      configurationRevision: config.configurationRevision!, sourceIdentity: config.sourceIdentity! };
    const value = networkContextFixture();
    Object.assign(value, { producerEpoch: producer.producerEpoch, sequence: '1', snapshotId: crypto.randomUUID(), capturedAt: new Date(Date.now() - 1000).toISOString() });
    const interfaces = value.sections.find((section) => section.kind === 'interfaces')!;
    const routes = value.sections.find((section) => section.kind === 'routes')!;
    const neighbors = value.sections.find((section) => section.kind === 'neighbors')!;
    const own = observers[index]!;
    interfaces.rows[0]!.addresses = [{ ...interfaces.rows[0]!.addresses[0]!, address: own.address, prefixLength: own.prefixLength }];
    routes.rows[0]!.nextHops = [{ ...routes.rows[0]!.nextHops[0]!, address: own.gateway }];
    Object.assign(neighbors, { rows: [], rowCount: 0 });
    for (const section of value.sections) section.contentDigest = topologySectionDigest(value, section, producer.sourceIdentity);
    value.contentDigest = topologyContextDigest(value, producer.sourceIdentity);
    const accepted = await scoped(() => ingestTopologyNetworkContext(producer, value));
    expect(accepted.accepted, JSON.stringify(accepted)).toBe(true);
  }
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
  return { env, orgId, siteId, scope, graph };
}

describe('declared vs undeclared network cards on the site map', () => {
  it('marks the declared card, keeps the undeclared one, and adds an empty declared card', async () => {
    const site = await reportingSite([
      { address: '10.1.2.10', prefixLength: 24, gateway: '10.1.2.100' },
      { address: '10.1.5.20', prefixLength: 24, gateway: '10.1.5.1' },
    ]);
    await profile(site.orgId, site.siteId, ['10.1.2.0/24']);
    await baseline(site.orgId, site.siteId, '10.1.9.0/24');

    const body = await site.graph();
    const cards = Object.fromEntries(body.presentation.nodes.filter((node) => node.group?.kind === 'network').map((node) => [node.group!.prefix, node.group!]));
    expect(cards['10.1.2.0/24']).toMatchObject({ basis: 'inferred_site_prefix', declaration: { state: 'declared', sources: ['discovery_profile'] } });
    expect(cards['10.1.5.0/24']).toMatchObject({ basis: 'inferred_site_prefix', declaration: { state: 'undeclared', sources: [] } });
    expect(cards['10.1.9.0/24']).toMatchObject({ basis: 'declared_site_network', networkClass: 'lan', members: [], canonicalNodeIds: [], observerCount: 0,
      declaration: { state: 'declared', sources: ['network_baseline'] } });

  });
});
