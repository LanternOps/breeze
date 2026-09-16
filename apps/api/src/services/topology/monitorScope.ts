import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TopologyScope } from '@breeze/shared';
import { assertInTransaction } from '../../db';
import type { TopologyTransaction } from './legacyCapture';
import { normalizedTopologyScope } from './identity';
/** Called before inventory detachment; SQL backstops older/direct SQL writers. */
export async function detachTopologyMonitorAuthority(tx: TopologyTransaction, scope: TopologyScope, assetId: string, reason: string): Promise<void> {
  assertInTransaction('detachTopologyMonitorAuthority');
  const current = normalizedTopologyScope(scope);
  await tx.execute(sql`SELECT breeze_detach_topology_monitor_authority('asset',${z.uuid().parse(assetId)}::uuid,
    ${current.orgId}::uuid,${current.siteId}::uuid,${z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).parse(reason)})`);
}
