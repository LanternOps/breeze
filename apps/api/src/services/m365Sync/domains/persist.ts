import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { M365_SYNC_PERSIST_CHUNK_SIZE, type PersistContext } from '../types';

export interface EntityPlan<TRow> {
  rows: TRow[];
  inserted: number;
  updated: number;
  unchanged: number;
  staleIds: string[];
}

/**
 * The change-only-write partition (spec §5.4). Everything about which rows get
 * touched is decided HERE, in memory, before a single statement is issued —
 * which is what makes "second identical run issues zero entity writes" a
 * property of the code rather than a hope about Postgres.
 *
 * A row that is unchanged but currently STALE is rewritten, because it has
 * come back and its tombstone must be lifted; that is why `isStale` is carried
 * in the existing map at all.
 */
export function planEntityWrites<TItem, TRow>(
  ctx: PersistContext,
  items: TItem[],
  complete: boolean,
  build: (item: TItem) => { graphId: string; coreHash: string; row: TRow } | null,
): EntityPlan<TRow> {
  const byGraphId = new Map<string, { coreHash: string; row: TRow }>();
  for (const item of items) {
    const built = build(item);
    if (!built || !built.graphId) continue;
    byGraphId.set(built.graphId, { coreHash: built.coreHash, row: built.row });
  }

  const rows: TRow[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [graphId, built] of byGraphId) {
    const prior = ctx.existing.get(graphId);
    if (!prior) { inserted += 1; rows.push(built.row); continue; }
    if (prior.coreHash !== built.coreHash || prior.isStale) { updated += 1; rows.push(built.row); continue; }
    unchanged += 1;
  }

  // Only a COMPLETE run may tombstone: a truncated or primary-failed run has no
  // authority to say a row is gone, it only knows it did not see it.
  const staleIds: string[] = [];
  if (complete) {
    for (const [graphId, prior] of ctx.existing) {
      if (prior.isStale) continue;
      if (!byGraphId.has(graphId)) staleIds.push(graphId);
    }
  }

  return { rows, inserted, updated, unchanged, staleIds };
}

/**
 * One SHORT transaction per 1 000-row chunk (spec §5.3). The upserts are
 * idempotent, so a failure part-way leaves a consistent partial state that the
 * next run finishes — the alternative, one transaction over 25 000 rows, would
 * hold a pooled connection for the whole write on a 1-vCPU managed database.
 */
export async function writeEntityChunks<TRow>(
  rows: TRow[],
  write: (chunk: TRow[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += M365_SYNC_PERSIST_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + M365_SYNC_PERSIST_CHUNK_SIZE);
    await runOutsideDbContext(() => withSystemDbAccessContext(
      () => write(chunk),
      'm365SyncPersistChunk',
    ));
  }
}

/** Set-based tombstone in one statement per chunk of ids. */
export async function markEntitiesStale(
  table: AnyPgTable & { orgId: never; graphId: never; isStale: never; staleSince: never },
  orgId: string,
  graphIds: string[],
  now: Date,
): Promise<number> {
  let marked = 0;
  for (let i = 0; i < graphIds.length; i += M365_SYNC_PERSIST_CHUNK_SIZE) {
    const chunk = graphIds.slice(i, i + M365_SYNC_PERSIST_CHUNK_SIZE);
    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.update(table)
        .set({ isStale: true, staleSince: now } as never)
        .where(and(
          eq((table as never as { orgId: never }).orgId, orgId as never),
          inArray((table as never as { graphId: never }).graphId, chunk as never),
          eq((table as never as { isStale: never }).isStale, false as never),
        ));
    }, 'm365SyncMarkStale'));
    marked += chunk.length;
  }
  return marked;
}

export const sqlExcluded = (column: string) => sql.raw(`excluded."${column}"`);
export const sqlFalse = () => sql`false`;
export const sqlNull = () => sql`null`;

export { and, eq, inArray, sql };
