import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import type { db } from '../../db';

type Executor = Pick<typeof db, 'execute'>;
/**
 * Explicit identity dirty mark (M2 D15.2) for writers of identity the physical
 * publisher resolves against but does not itself observe: discovered-asset IPs
 * (an SNMP target `snmp:<ip>` names its subject by the scoped asset at that
 * address) and agent-reported NIC MACs (`device_network`, the only trusted MAC
 * binding source, D16). The next publication runs the re-resolution pass.
 * A leaf module so inventory/worker writers do not import the projector graph.
 * No-op when the site has no topology state yet.
 */
export async function markTopologyIdentityDirty(tx: Executor, scope: TopologyScope): Promise<void> {
  await tx.execute(sql`UPDATE topology_site_state SET identity_revision=identity_revision+1, dirty_revision=dirty_revision+1, last_build_status='pending', updated_at=now()
    WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
}
