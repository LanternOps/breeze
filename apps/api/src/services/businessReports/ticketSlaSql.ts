import { sql, type SQL } from 'drizzle-orm';

/**
 * The ONE definition of which tickets an SLA report counts and when each target
 * was due (#11018), shared by `ticket_sla_attainment` and
 * `ticket_sla_performance` so the two cannot drift on either.
 *
 * Both arguments are closed string-literal unions, never caller data, so
 * `sql.raw` binds nothing a caller controls. The line breaks and SQL comments
 * are part of the contract: `ticketSlaReport.test.ts` pins the staff statements
 * byte for byte.
 */
export type SlaDueKind = 'response' | 'resolution';

/** Excludes deleted tickets, merged tombstones and planned work. */
export function slaTicketEligibilitySql(alias: 't'): SQL {
  return sql.raw(`${alias}.deleted_at IS NULL
        -- #8972 spec §3.6: a merged tombstone's close stamps are merge stamps.
        AND ${alias}.merged_into_ticket_id IS NULL
        -- #5573 §4.8: the sweep excludes planned work, so the recompute must too.
        AND ${alias}.work_kind = 'support'`);
}

/**
 * The stored deadline, or the wall-clock formula the SLA sweep's heal will store
 * when a target's deadline is not written yet (a pre-#8973 ticket), so such a
 * target is judged rather than dropped.
 */
export function effectiveDueSql(kind: SlaDueKind, alias: 't'): SQL {
  return sql.raw(`COALESCE(${alias}.${kind}_due_at, ${alias}.created_at
          + (${alias}.${kind}_sla_minutes + COALESCE(${alias}.sla_paused_minutes, 0)) * interval '1 minute')`);
}

/** Naive `timestamp` columns hold UTC; render them as ISO instants in SQL so
 *  the output does not depend on the driver's timestamp parser. */
export const isoInstantSql = (column: SQL): SQL => sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
