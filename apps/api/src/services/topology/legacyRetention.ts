import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { requireLegacyScope } from './legacyImportState';

/** Seven-day delivery retention never removes pending work. An orphan delete
 * is the only durable fence when canonical endpoint FKs cannot be satisfied;
 * retain it until a canonical fence at least as new exists. */
export async function pruneDeliveredTopologyOutbox(scope: TopologyScope, now = new Date()): Promise<number> {
  await requireLegacyScope(scope);
  const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const result = await db.execute(sql`DELETE FROM topology_change_outbox WHERE id IN (
    SELECT o.id FROM topology_change_outbox o
    WHERE o.org_id=${scope.orgId}::uuid AND o.site_id=${scope.siteId}::uuid
      AND o.delivered_at IS NOT NULL AND o.delivered_at<${cutoff}::timestamptz
      -- Application journals are deliberately excluded from graph replay.
      -- Their pending execution remains durable even after the retention floor.
      AND (o.event_kind NOT LIKE 'template.application.%'
        OR (o.event_kind='template.application.preview' AND (o.payload->>'expiresAt')::timestamptz < now())
        OR (o.event_kind='template.application.intent'
          AND o.payload->'outcome'->>'state' IN ('applied','conflict','failed')
          AND o.updated_at < now()-interval '30 days'))
      -- M3-D15: recurring-monitoring events are consumed by their own typed
      -- worker; a pending one is never pruned, an applied one ages out late.
      AND (o.event_kind NOT LIKE 'monitoring.%'
        OR (o.payload->>'state' = 'applied' AND o.updated_at < now()-interval '30 days'))
      AND (o.event_kind<>'relationship.delete' OR EXISTS (
        SELECT 1 FROM topology_relationships r WHERE r.org_id=o.org_id AND r.site_id=o.site_id
          AND r.legacy_source_type=o.payload->>'sourceTable' AND r.legacy_source_id=o.aggregate_id AND r.legacy_source_revision>=o.source_revision))
      AND (o.event_kind<>'layout.delete' OR EXISTS (
        SELECT 1 FROM topology_nodes n JOIN topology_nodes c ON c.id=COALESCE(n.alias_target_id,n.id) AND c.org_id=n.org_id AND c.site_id=n.site_id
          JOIN topology_node_positions p ON p.node_id=c.id AND p.org_id=c.org_id AND p.site_id=c.site_id
          JOIN topology_layouts l ON l.id=p.layout_id AND l.org_id=p.org_id AND l.site_id=p.site_id AND l.view='overview'
        WHERE n.org_id=o.org_id AND n.site_id=o.site_id
          AND n.legacy_source_id=(o.payload->'data'->>'nodeId')::uuid
          AND n.legacy_source_type=CASE o.payload->'data'->>'nodeType' WHEN 'manual_node' THEN 'topology_manual_nodes' WHEN 'discovered_asset' THEN 'discovered_assets' WHEN 'device' THEN 'devices' ELSE '' END
          AND p.legacy_source_revision>=o.source_revision))
    ORDER BY o.delivered_at LIMIT 200
  ) RETURNING id`);
  return result.length;
}
