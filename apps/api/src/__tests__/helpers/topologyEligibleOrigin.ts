import { expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { NetworkContextFull } from '@breeze/shared';

import { db, runOutsideDbContext, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import type { TopologyRequestContext } from '../../services/topology/access';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { updateTopologySiteConfiguration } from '../../services/topology/siteConfiguration';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { setupTestEnvironment } from '../integration/db-utils';
import { orgContext } from '../integration/topology-fixtures';

/**
 * A REAL eligible diagnostic origin, materialized the way production does it
 * (M1 `baseline-no-management`, see topologyBaselineAcceptance): one enrolled,
 * online agent whose accepted network context carries one interface, one IPv4
 * default route and one resolver, published through the real ingest and
 * reconcile paths. The real planning loader and compiler plan `gateway_basic`
 * against it — nothing about origin selection is faked.
 */
export const TOPOLOGY_ELIGIBLE_ORIGIN_GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'topology', action: 'write' },
  { resource: 'topology', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
  { resource: 'ai_sessions', action: 'use' },
  { resource: 'sites', action: 'read' },
  { resource: 'sites', action: 'write' },
];

const system = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology eligible origin fixture'));

export async function seedTopologyEligibleOrigin(flags: Record<string, boolean> = {}) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: TOPOLOGY_ELIGIBLE_ORIGIN_GRANTS });
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const scope = { orgId, siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  const deviceId = crypto.randomUUID();

  const setFlags = (next: Record<string, boolean>) => system(() =>
    db.update(organizations)
      .set({ settings: { topologyFeatureFlags: { materialization: true, diagnostics: true, ai: true, ...next } } })
      .where(eq(organizations.id, orgId)));
  await setFlags(flags);

  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  const auth: AuthContext = {
    principal: { kind: 'user_session' },
    user: { id: env.user.id, email: env.user.email, name: 'Topology Tester', isPlatformAdmin: false },
    token: {
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId, partnerId: env.partner.id,
      scope: 'organization', type: 'access', mfa: true,
    },
    partnerId: env.partner.id,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
  const context: TopologyRequestContext = {
    scope,
    auth,
    permissions: {
      permissions: TOPOLOGY_ELIGIBLE_ORIGIN_GRANTS, scope: 'organization', partnerId: env.partner.id, orgId, roleId: env.role.id,
    } as unknown as UserPermissions,
  };

  await scoped(() => db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status,last_seen_at,agent_token_hash)
    VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},'diag-origin','linux','1','amd64','1','online',now(),${'a'.repeat(64)})`));
  // Outbound probing must be settled BEFORE the collector negotiates: the
  // accepted configuration revision is part of origin eligibility.
  await scoped(() => updateTopologySiteConfiguration(context, { targets: {}, policies: {}, outboundEnabled: true }, '0'));

  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  expect(imported.complete).toBe(true);

  const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(deviceId)));
  if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
  const producer: AuthenticatedTopologyProducer = {
    scope, producerId: deviceId, producerKind: 'agent', producerEpoch: config.producerEpoch!,
    configurationRevision: config.configurationRevision!, sourceIdentity: config.sourceIdentity!,
  };
  const report: NetworkContextFull = networkContextFixture();
  Object.assign(report, {
    producerEpoch: producer.producerEpoch, sequence: '1', snapshotId: crypto.randomUUID(),
    capturedAt: new Date(Date.now() - 1000).toISOString(),
    capabilities: [
      { name: 'interfaces', version: 1, supported: true },
      { name: 'network_diagnostic', version: 1, supported: true },
      { name: 'route_lookup', version: 1, supported: true },
      { name: 'interface_bound_probes', version: 1, supported: true },
    ],
  });
  for (const section of report.sections) section.contentDigest = topologySectionDigest(report, section, producer.sourceIdentity);
  report.contentDigest = topologyContextDigest(report, producer.sourceIdentity);
  expect((await scoped(() => ingestTopologyNetworkContext(producer, report))).accepted).toBe(true);
  expect((await scoped(() => withDbTransaction(() => reconcileTopologySite(scope)))).published).toBe(true);

  const [binding] = await scoped(() => db.execute(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${orgId}::uuid AND device_id=${deviceId}::uuid`));
  const nodeId = String(binding!.node_id);
  const graphRevision = async () => {
    const [state] = await scoped(() => db.execute(sql`SELECT graph_revision::text AS revision FROM topology_site_state WHERE org_id=${orgId}::uuid AND site_id=${siteId}::uuid`));
    return String(state!.revision);
  };

  return { env, orgId, siteId, scope, deviceId, nodeId, auth, context, scoped, system, setFlags, graphRevision };
}

export type TopologyEligibleOrigin = Awaited<ReturnType<typeof seedTopologyEligibleOrigin>>;
