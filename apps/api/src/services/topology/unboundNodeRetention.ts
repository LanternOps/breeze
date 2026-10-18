import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';

/** A scoped unbound endpoint ages out once it, and every relationship that ever
 * touched it, has been idle this long. Archiving already waits 7 days past a
 * relationship's freshness, so this is a further grace period for a device that
 * was only briefly unreachable. */
export const UNBOUND_STUB_RETENTION_DAYS = 30;
export const UNBOUND_STUB_BATCH = 500;
/** Source-key prefixes of the scoped unbound endpoints (physicalIdentity.ts, unifiAdapter.ts). */
const STUB_PREFIXES = ['lldp-chassis:', 'cdp-device:', 'mac-endpoint:', 'physical-target:', 'unifi:'] as const;

/** SQL predicate shared by the worker's candidate scan and the purge itself. */
export function agedUnboundStubNodes(scope: TopologyScope, now: Date) {
  const cutoff = new Date(now.getTime() - UNBOUND_STUB_RETENTION_DAYS * 86_400_000).toISOString();
  const org = sql`${scope.orgId}::uuid`, site = sql`${scope.siteId}::uuid`;
  const prefixes = sql.join(STUB_PREFIXES.map(p => sql`${p + '%'}`), sql`,`);
  return sql`SELECT n.id FROM topology_nodes n
    WHERE n.org_id=${org} AND n.site_id=${site} AND n.kind='endpoint'
      AND n.identity_material->>'sourceKey' LIKE ANY (ARRAY[${prefixes}])
      AND n.label_override IS NULL AND n.alias_target_id IS NULL AND n.deleted_at IS NULL
      AND n.updated_at < ${cutoff}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM topology_nodes a WHERE a.org_id=n.org_id AND a.site_id=n.site_id AND a.alias_target_id=n.id)
      AND NOT EXISTS (SELECT 1 FROM topology_node_bindings b WHERE b.org_id=n.org_id AND b.site_id=n.site_id AND b.node_id=n.id)
      AND NOT EXISTS (SELECT 1 FROM topology_node_positions p WHERE p.org_id=n.org_id AND p.site_id=n.site_id AND p.node_id=n.id AND p.pinned)
      AND NOT EXISTS (SELECT 1 FROM topology_monitoring_policies m WHERE m.org_id=n.org_id AND m.site_id=n.site_id AND m.subject_node_id=n.id)
      AND NOT EXISTS (SELECT 1 FROM topology_monitor_bindings mb WHERE mb.org_id=n.org_id AND mb.site_id=n.site_id AND mb.node_id=n.id)
      AND NOT EXISTS (SELECT 1 FROM topology_telemetry_arms ta WHERE ta.org_id=n.org_id AND ta.site_id=n.site_id AND ta.target_node_id=n.id AND ta.state<>'revoked')
      AND NOT EXISTS (SELECT 1 FROM topology_diagnostic_runs dr WHERE dr.org_id=n.org_id AND dr.site_id=n.site_id
        AND (dr.subject_node_id=n.id OR dr.origin_node_id=n.id)
        AND (dr.state IN ('queued','running') OR dr.queued_at >= ${cutoff}::timestamptz OR dr.finished_at >= ${cutoff}::timestamptz))
      AND NOT EXISTS (SELECT 1 FROM topology_relationships r WHERE r.org_id=n.org_id AND r.site_id=n.site_id
        AND (r.source_node_id=n.id OR r.target_node_id=n.id)
        AND (r.lifecycle='active' OR r.updated_at >= ${cutoff}::timestamptz OR r.last_supported_at >= ${cutoff}::timestamptz))`;
}

/**
 * Delete scoped unbound stub nodes with no active relationship for the
 * retention window (#7267). Must run under the site-state lock the retention
 * pass already holds, so it cannot interleave with a publication that is about
 * to re-reference the node. Dependent rows (withdrawn/archived relationships,
 * their support/observations, interfaces, positions) go via ON DELETE CASCADE;
 * a re-sighting simply re-creates the stub from its identity key.
 *
 * Kept: any node with a binding (not unbound), a user label, a pinned
 * position, a monitoring policy/binding, a non-revoked telemetry arm, an
 * in-flight or in-window diagnostic run, or an alias relationship in either
 * direction. Those carry operator intent, or would trip the NO ACTION alias FK.
 * Every FK onto topology_nodes is classified in the integration test's
 * KNOWN_NODE_FKS; a new one fails it until it is handled here.
 */
export async function purgeAgedUnboundStubNodes(scope: TopologyScope, now = new Date(), limit = UNBOUND_STUB_BATCH): Promise<{ deleted: number; more: boolean }> {
  assertInTransaction('purgeAgedUnboundStubNodes');
  const candidates = await db.execute<{ id: string }>(sql`${agedUnboundStubNodes(scope, now)}
    ORDER BY n.updated_at, n.id LIMIT ${limit + 1} FOR UPDATE OF n SKIP LOCKED`);
  if (!candidates.length) return { deleted: 0, more: false };
  const ids = sql.join(candidates.slice(0, limit).map(row => sql`${row.id}::uuid`), sql`,`);
  // `latest_observation_id` is NO ACTION and the node's observations cascade, so
  // release any support pointer at them first (same as purgeDeletedProducerEvidence).
  await db.execute(sql`UPDATE topology_relationship_support SET latest_observation_id=NULL, updated_at=now()
    WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND latest_observation_id IN (
      SELECT o.id FROM topology_observations o WHERE o.org_id=${scope.orgId}::uuid AND o.site_id=${scope.siteId}::uuid AND o.subject_node_id IN (${ids}))`);
  await db.execute(sql`DELETE FROM topology_nodes WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND id IN (${ids})`);
  return { deleted: Math.min(candidates.length, limit), more: candidates.length > limit };
}
