// apps/api/src/services/actionIntents/intentQuery.ts
//
// AI patch agent W02 Task 2
// (docs/superpowers/plans/ai-mcp/2026-09-13-ai-patch-agent-02-actionable-installs.md).
//
// Batched idempotency-key lookup used by `patchEpisode.ts`'s suppression
// read: given a set of `patch:<orgId>:<deviceId>:<patchId>` keys for one
// org, return every action_intents row created for those keys since a given
// time, most-recent-first per key, so the caller can feed each episode's
// history into `shouldSuppressPatchEpisode`.
//
// `org_id` is pinned on every query in addition to the key — the
// idempotency key alone is not a tenant boundary (it's just a string derived
// from ids the caller already scoped), so a lookup that filtered on key only
// would cross tenants if two orgs' rows ever collided on `idempotencyKey`
// (they should not under the current key scheme, but the query must not
// depend on that holding).

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
// Direct module import, not the schema barrel — same note as sweepFindings.ts.
import { actionIntents } from '../../db/schema/actionIntents';
import type { ActionIntentStatus } from '../../db/schema/actionIntents';

export const INTENT_QUERY_KEY_BATCH = 500;

export interface IntentIdempotencyRow {
  idempotencyKey: string;
  status: ActionIntentStatus;
  createdAt: Date;
  decidedAt: Date | null;
}

/**
 * Same skip-if-already-system shape as `sweepFindings.ts`'s
 * `inSystemDbContext`: a bare system wrapper is a no-op inside an ambient
 * request context, and re-entering from an already-system context would
 * take a SECOND pooled connection while the first is still held.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export async function findIntentsByIdempotencyKey(args: {
  orgId: string;
  keys: string[];
  since: Date;
}): Promise<IntentIdempotencyRow[]> {
  const { orgId, since } = args;
  const uniqueKeys = [...new Set(args.keys)];
  if (uniqueKeys.length === 0) return [];

  const batches = chunk(uniqueKeys, INTENT_QUERY_KEY_BATCH);

  const results = await inSystemDbContext(async () => {
    const batchResults: IntentIdempotencyRow[][] = [];
    for (const batch of batches) {
      // eslint-disable-next-line no-await-in-loop -- intentionally sequential: one system-context section, N small batches.
      const rows = await db
        .select({
          idempotencyKey: actionIntents.idempotencyKey,
          status: actionIntents.status,
          createdAt: actionIntents.createdAt,
          decidedAt: actionIntents.decidedAt,
        })
        .from(actionIntents)
        .where(
          and(
            eq(actionIntents.orgId, orgId),
            inArray(actionIntents.idempotencyKey, batch),
            gte(actionIntents.createdAt, since),
          ),
        )
        .orderBy(desc(actionIntents.createdAt));
      batchResults.push(rows as IntentIdempotencyRow[]);
    }
    return batchResults.flat();
  });

  // Each batch is already most-recent-first; sort the merged result so the
  // order holds across batch boundaries too.
  return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
