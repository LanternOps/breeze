import { and, eq, isNull, sql } from 'drizzle-orm';
import type { db } from '../db';
import { organizations } from '../db/schema';
import type { AutoMapOrgRow } from './externalTenantMapping';
import { notHiddenOrgType } from './unassignedPool/visibility';

// Anything that can `select`: `db`, a `db.transaction` callback tx, or the
// narrowed provider-sync tx (ProviderSyncTx / EdrSyncTx).
type DbExecutor = Pick<typeof db, 'select'>;

/**
 * Orgs an external tenant/customer may be mapped onto: the partner's live,
 * visible, non-holding orgs. The one predicate shared by every external
 * tenant-mapping loader (EDR, backup, Pax8).
 */
export async function loadMappableOrgs(executor: DbExecutor, partnerId: string): Promise<AutoMapOrgRow[]> {
  return executor
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      isNull(organizations.deletedAt),
      isNull(organizations.archivedAt),
      sql`${organizations.status} NOT IN ('archived','purging','merging')`,
      // Quick Support and the holding org are never a customer to map onto.
      notHiddenOrgType(),
      sql`${organizations.type} <> 'unassigned_pool'`,
    ));
}
