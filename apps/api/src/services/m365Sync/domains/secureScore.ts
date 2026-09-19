import { sql } from 'drizzle-orm';
import { db } from '../../../db';
import { inOwnedRunTransaction } from './persist';
import type { DomainPersistResult, M365SyncActionResult, PersistContext } from '../types';

interface ParsedScore {
  createdDateTime: string;
  currentScore: number | null;
  maxScore: number | null;
  activeUserCount: number | null;
  licensedUserCount: number | null;
  controlScores: unknown[];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function int(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.trunc(parsed);
}

/**
 * Newest-first, deduped by the UTC calendar day of Graph's own
 * `createdDateTime`. Graph revises the last day or two, and a backfill call
 * ($top=90) can return two entries for one day; the unique key is
 * (org_id, score_date), so the newest entry for a day must be the one that
 * survives — hence the sort BEFORE the dedupe. A single VALUES list naming the
 * same key twice would make ON CONFLICT raise, not pick one.
 */
function parseScores(items: Record<string, unknown>[]): ParsedScore[] {
  const parsed = items.flatMap((item) => {
    const created = typeof item.createdDateTime === 'string' ? item.createdDateTime : null;
    if (!created || !Number.isFinite(Date.parse(created))) return [];
    return [{
      createdDateTime: created,
      currentScore: num(item.currentScore),
      maxScore: num(item.maxScore),
      activeUserCount: int(item.activeUserCount),
      licensedUserCount: int(item.licensedUserCount),
      controlScores: Array.isArray(item.controlScores) ? item.controlScores : [],
    }];
  });
  parsed.sort((a, b) => Date.parse(b.createdDateTime) - Date.parse(a.createdDateTime));
  const byDay = new Map<string, ParsedScore>();
  for (const score of parsed) {
    const day = new Date(score.createdDateTime).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, score);
  }
  return [...byDay.values()];
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const list = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
}

/**
 * Secure Score is a time series, not an entity table (spec §3.3): nothing is
 * marked stale and there is no core_hash. Rows are keyed by Graph's own date,
 * computed in SQL from the bound ISO timestamp so the API process's zone can
 * never shift a day boundary, and a 90-day backfill therefore lands on the days
 * it describes rather than the day it was fetched. `tenant_id` is the
 * connection's verified tenant, so history survives a rebind and is filtered by
 * tenant at read time.
 *
 * The `backfill` flag never reaches this module — run.ts builds the action
 * with `m365SyncActionFor(domain, { backfill: state.lastSuccessAt === null })`.
 */
export async function persistSecureScore(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const complete = result.sources.secureScores === 'ok' && !result.truncated;
  const scores = parseScores(result.items);
  const base: DomainPersistResult = {
    inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {}, complete,
  };
  if (scores.length === 0) return base;

  const values = sql.join(
    scores.map((s) => sql`(
      ${ctx.orgId}::uuid,
      ${ctx.tenantId}::uuid,
      ((${s.createdDateTime}::timestamptz) at time zone 'UTC')::date,
      ${s.currentScore}::numeric(8,2),
      ${s.maxScore}::numeric(8,2),
      ${s.activeUserCount}::int,
      ${s.licensedUserCount}::int,
      ${JSON.stringify(s.controlScores)}::jsonb
    )`),
    sql`, `,
  );

  const written = await inOwnedRunTransaction(ctx, 'm365SyncSecureScorePersist', () => db.execute(sql`
    with written as (
      insert into m365_secure_score_snapshots (
        org_id, tenant_id, score_date, current_score, max_score,
        active_user_count, licensed_user_count, control_scores
      )
      values ${values}
      on conflict (org_id, score_date) do update set
        tenant_id = excluded.tenant_id,
        current_score = excluded.current_score,
        max_score = excluded.max_score,
        active_user_count = excluded.active_user_count,
        licensed_user_count = excluded.licensed_user_count,
        control_scores = excluded.control_scores
      returning (xmax = 0) as inserted
    )
    select
      (select count(*) from written where inserted)::int     as inserted,
      (select count(*) from written where not inserted)::int as updated
  `));

  const row = rowsOf(written)[0] ?? {};
  const newest = scores[0]!;
  const counts: Record<string, number> = {};
  if (newest.currentScore !== null) counts.secure_score = newest.currentScore;
  if (newest.maxScore !== null) counts.secure_score_max = newest.maxScore;

  return {
    ...base,
    inserted: Number(row.inserted ?? 0) || 0,
    updated: Number(row.updated ?? 0) || 0,
    counts,
  };
}
