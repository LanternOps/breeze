import { sql } from 'drizzle-orm';
import { db } from '../../../db';
import { inOwnedRunTransaction } from './persist';
import {
  M365_SYNC_PERSIST_CHUNK_SIZE,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';

export interface SigninPersistResult extends DomainPersistResult {
  /** Opaque executor blob; non-null means more pages remain (spec §4.1). */
  continuation: string | null;
  /** Tenant has no Entra ID P1: a complete, zero-update success; interval → max (§6). */
  unlicensed: boolean;
}

interface SigninItem { id: string; lastSuccessfulSignInAt: string | null }

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function parseItems(items: Record<string, unknown>[]): SigninItem[] {
  const byId = new Map<string, SigninItem>();
  for (const item of items) {
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : null;
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, lastSuccessfulSignInAt: isoOrNull(item.lastSuccessfulSignInAt) });
  }
  return [...byId.values()];
}

function updatedCount(rows: unknown): number {
  const list = (rows as { rows?: unknown[] }).rows ?? rows;
  const first = Array.isArray(list) ? list[0] as { updated?: unknown } | undefined : undefined;
  return Number(first?.updated ?? 0) || 0;
}

/**
 * Sign-in activity is NOT an entity domain (spec §5.5): it never inserts, never
 * marks stale and never touches core_hash or last_changed_at. It updates one
 * nullable column on rows that already exist, matched by (org_id, graph_id).
 * Users the users domain has not seen yet are simply not matched — the next
 * users run inserts them and the next sign-in run fills the timestamp.
 *
 * `IS DISTINCT FROM` keeps it change-only: a tenant whose people did not sign
 * in since the last run writes zero rows. Timestamps are bound as ISO strings
 * and cast in SQL — a JS Date inside a raw drizzle fragment throws at bind time
 * in postgres.js, which compiled-SQL tests do not catch.
 *
 * The worker holds no DB context in Phase C (spec §5.3), so each chunk opens
 * its own short system context; the explicit org_id predicate is the tenant
 * boundary.
 */
export async function persistSigninActivity(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<SigninPersistResult> {
  const unlicensed = result.sources.signInActivity === 'unlicensed';
  const continuation = typeof result.continuation === 'string' && result.continuation.length > 0
    ? result.continuation
    : null;
  const base: SigninPersistResult = {
    inserted: 0,
    updated: 0,
    stale: 0,
    unchanged: 0,
    counts: {},
    // A page that still has a continuation has not enumerated the tenant, so it
    // is not a complete snapshot. An unlicensed tenant IS complete: there is
    // nothing to enumerate.
    complete: unlicensed || (continuation === null && result.sources.signInActivity === 'ok' && !result.truncated),
    continuation,
    unlicensed,
  };
  if (unlicensed) return base;

  const items = parseItems(result.items);
  if (items.length === 0) return base;

  let updated = 0;
  for (let i = 0; i < items.length; i += M365_SYNC_PERSIST_CHUNK_SIZE) {
    const chunk = items.slice(i, i + M365_SYNC_PERSIST_CHUNK_SIZE);
    const values = sql.join(
      chunk.map((item) => sql`(${item.id}::text, ${item.lastSuccessfulSignInAt}::timestamptz)`),
      sql`, `,
    );
    const rows = await inOwnedRunTransaction(ctx, 'm365SyncSigninPersist', () => db.execute(sql`
      with page (graph_id, signed_in_at) as (values ${values}),
      updated as (
        update m365_users u
        set last_successful_sign_in_at = p.signed_in_at
        from page p
        where u.org_id = ${ctx.orgId}::uuid
          and u.graph_id = p.graph_id
          and u.last_successful_sign_in_at is distinct from p.signed_in_at
        returning 1
      )
      select (select count(*) from updated)::int as updated
    `));
    updated += updatedCount(rows);
  }

  return { ...base, updated, unchanged: Math.max(items.length - updated, 0) };
}
