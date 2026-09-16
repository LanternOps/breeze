import { sql, type SQL } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';

type InventoryReference = { deviceId?: string | null; discoveredAssetId?: string | null; manualNodeId?: string | null };
type Executor = { execute(query: SQL): PromiseLike<unknown> };

/** Inventory writers lock their source row before the capture/lifecycle site
 * lock. A publisher already holds site state, so waiting on its binding FK
 * could deadlock and abort the user's deletion/move. Yield the publication
 * instead; the caller rolls back its whole unit and retries fresh authority.
 * KEY SHARE remains compatible with ordinary non-key inventory updates. */
export async function lockTopologyInventoryReferences(scope: TopologyScope, references: InventoryReference[], executor: Executor = db): Promise<void> {
  assertInTransaction('topology inventory references');
  const sources = [['devices', 'deviceId'], ['discovered_assets', 'discoveredAssetId'], ['topology_manual_nodes', 'manualNodeId']] as const;
  for (const [table, field] of sources) {
    const ids = [...new Set(references.map(row => row[field]).filter((id): id is string => !!id))].sort();
    for (let start = 0; start < ids.length; start += 1000) {
      await executor.execute(sql`SELECT id FROM ${sql.identifier(table)}
        WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid
          AND id IN (${sql.join(ids.slice(start, start + 1000).map(id => sql`${id}::uuid`), sql`,`)})
        ORDER BY id FOR KEY SHARE NOWAIT`);
    }
  }
}
