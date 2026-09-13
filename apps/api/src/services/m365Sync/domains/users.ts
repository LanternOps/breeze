import { db } from '../../../db';
import { m365Users } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

/**
 * PRIMARY fields only (spec §3.2, §5.4). The enrichment columns
 * (mfa_*, admin_roles, is_admin, last_successful_sign_in_at) are W05's and are
 * absent from BOTH the insert values and the conflict SET, so a users run can
 * never clobber enrichment written by a later, independent source. That is also
 * why they are absent from the hash: if they were in it, a registration-report
 * outage would rewrite every user row on the next run.
 */
interface UserItem {
  id?: string;
  userPrincipalName?: string | null;
  displayName?: string | null;
  mail?: string | null;
  accountEnabled?: boolean | null;
  jobTitle?: string | null;
  department?: string | null;
  usageLocation?: string | null;
  onPremisesSyncEnabled?: boolean | null;
  createdDateTime?: string | null;
  assignedLicenses?: string[] | null;
}

/**
 * The canonical primary-field projection. Exported so W05's enrichment pass
 * hashes the identical field set — a second definition would drift and rewrite
 * every user row.
 */
export function usersPrimaryProjection(item: UserItem): Record<string, unknown> {
  return {
    userPrincipalName: item.userPrincipalName ?? null,
    displayName: item.displayName ?? null,
    mail: item.mail ?? null,
    accountEnabled: item.accountEnabled ?? null,
    jobTitle: item.jobTitle ?? null,
    department: item.department ?? null,
    usageLocation: item.usageLocation ?? null,
    onPremisesSyncEnabled: item.onPremisesSyncEnabled ?? null,
    createdDateTime: item.createdDateTime ?? null,
    assignedLicenses: item.assignedLicenses ?? [],
  };
}

export async function persistUsers(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as UserItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.users] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.id) return null;
    const projection = usersPrimaryProjection(item);
    return {
      graphId: item.id,
      coreHash: canonicalHash(projection),
      row: {
        orgId: ctx.orgId,
        graphId: item.id,
        userPrincipalName: projection.userPrincipalName as string | null,
        displayName: projection.displayName as string | null,
        mail: projection.mail as string | null,
        accountEnabled: projection.accountEnabled as boolean | null,
        jobTitle: projection.jobTitle as string | null,
        department: projection.department as string | null,
        usageLocation: projection.usageLocation as string | null,
        onPremisesSyncEnabled: projection.onPremisesSyncEnabled as boolean | null,
        graphCreatedAt: projection.createdDateTime ? new Date(projection.createdDateTime as string) : null,
        assignedSkuIds: projection.assignedLicenses as string[],
        coreHash: canonicalHash(projection),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365Users).values(chunk).onConflictDoUpdate({
      target: [m365Users.orgId, m365Users.graphId],
      set: {
        userPrincipalName: sqlExcluded('user_principal_name'),
        displayName: sqlExcluded('display_name'),
        mail: sqlExcluded('mail'),
        accountEnabled: sqlExcluded('account_enabled'),
        jobTitle: sqlExcluded('job_title'),
        department: sqlExcluded('department'),
        usageLocation: sqlExcluded('usage_location'),
        onPremisesSyncEnabled: sqlExcluded('on_premises_sync_enabled'),
        graphCreatedAt: sqlExcluded('graph_created_at'),
        assignedSkuIds: sqlExcluded('assigned_sku_ids'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  });

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365Users as never, ctx.orgId, plan.staleIds, ctx.now)
    : 0;

  return {
    inserted: plan.inserted,
    updated: plan.updated,
    unchanged: plan.unchanged,
    stale,
    complete,
    counts: {
      users_total: items.length,
      users_enabled: items.filter((item) => item.accountEnabled === true).length,
    },
  };
}
