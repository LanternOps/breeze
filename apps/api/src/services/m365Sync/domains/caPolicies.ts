import { db } from '../../../db';
import { m365CaPolicies } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

interface PolicyItem {
  id?: string;
  displayName?: string | null;
  state?: string | null;
  createdDateTime?: string | null;
  modifiedDateTime?: string | null;
  conditions?: unknown;
  grantControls?: unknown;
  sessionControls?: unknown;
}

/**
 * `core_hash` covers the whole projection (a rename is still a row change worth
 * persisting), while `definition_hash` covers ONLY what changes the policy's
 * effect: state + the three control objects. Sub-project 3's change alerts key
 * on definition_hash, so a rename must not page anyone — and disabling a policy
 * must (spec §3.2). Keeping the two hashes separate is the whole reason the
 * column exists.
 */
function coreProjection(item: PolicyItem): Record<string, unknown> {
  return {
    displayName: item.displayName ?? null,
    state: item.state ?? null,
    createdDateTime: item.createdDateTime ?? null,
    modifiedDateTime: item.modifiedDateTime ?? null,
    conditions: item.conditions ?? null,
    grantControls: item.grantControls ?? null,
    sessionControls: item.sessionControls ?? null,
  };
}

function definitionProjection(item: PolicyItem): Record<string, unknown> {
  return {
    state: item.state ?? null,
    conditions: item.conditions ?? null,
    grantControls: item.grantControls ?? null,
    sessionControls: item.sessionControls ?? null,
  };
}

export async function persistCaPolicies(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as PolicyItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.ca_policies] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.id) return null;
    const core = coreProjection(item);
    return {
      graphId: item.id,
      coreHash: canonicalHash(core),
      row: {
        orgId: ctx.orgId,
        graphId: item.id,
        displayName: core.displayName as string | null,
        state: core.state as string | null,
        graphCreatedAt: core.createdDateTime ? new Date(core.createdDateTime as string) : null,
        graphModifiedAt: core.modifiedDateTime ? new Date(core.modifiedDateTime as string) : null,
        conditions: item.conditions ?? null,
        grantControls: item.grantControls ?? null,
        sessionControls: item.sessionControls ?? null,
        definitionHash: canonicalHash(definitionProjection(item)),
        coreHash: canonicalHash(core),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365CaPolicies).values(chunk).onConflictDoUpdate({
      target: [m365CaPolicies.orgId, m365CaPolicies.graphId],
      set: {
        displayName: sqlExcluded('display_name'),
        state: sqlExcluded('state'),
        graphCreatedAt: sqlExcluded('graph_created_at'),
        graphModifiedAt: sqlExcluded('graph_modified_at'),
        conditions: sqlExcluded('conditions'),
        grantControls: sqlExcluded('grant_controls'),
        sessionControls: sqlExcluded('session_controls'),
        definitionHash: sqlExcluded('definition_hash'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  }, ctx);

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365CaPolicies as never, ctx.orgId, plan.staleIds, ctx.now, ctx)
    : 0;

  // Keys are m365_posture_rollups COLUMN names (spec §5.9). The rollup reads
  // last_counts by key, so a key without a matching column is dead weight —
  // there is deliberately no `ca_policies_total`.
  const counts: Record<string, number> = {
    ca_policies_enabled: 0,
    ca_policies_report_only: 0,
    ca_policies_disabled: 0,
  };
  for (const item of items) {
    switch ((item.state ?? '').trim()) {
      case 'enabled': counts.ca_policies_enabled = (counts.ca_policies_enabled ?? 0) + 1; break;
      case 'enabledForReportingButNotEnforced':
        counts.ca_policies_report_only = (counts.ca_policies_report_only ?? 0) + 1;
        break;
      case 'disabled': counts.ca_policies_disabled = (counts.ca_policies_disabled ?? 0) + 1; break;
      default: break;   // an unrecognised state lands in NO bucket, never guessed into one
    }
  }

  return { inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged, stale, complete, counts };
}
