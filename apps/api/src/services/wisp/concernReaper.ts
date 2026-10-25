/**
 * Wisp W05b Task 10 — concern retention reaper (w00 "Triage engine (W05)",
 * plan Review Focus 3, amendment Task 16).
 *
 * Two passes, each isolated so one failing does not stop the other:
 *
 *  1. Retention: delete `resolved` / `dismissed` concerns last touched more
 *     than `resolvedRetentionDays` (default 90) ago, in bounded ctid batches,
 *     one transaction per batch (jobs/retentionBatch.ts). Recipient rows go
 *     with them (`ON DELETE CASCADE`). Live concerns are never deleted.
 *
 *  2. Subject reconciliation: a LIVE org-level concern whose subject row no
 *     longer exists in the concern's org is resolved with outcome
 *     `subject_gone`, so its recipients are never nudged again. One bounded
 *     `NOT EXISTS` query per subject kind, each pinned
 *     `<table>.org_id = wisp_concerns.org_id` — a subject that moved to another
 *     org counts as gone (the concern's org no longer holds it).
 *
 *     What counts as "gone", per kind:
 *       - ticket: row missing or soft-deleted (`deleted_at` set: hidden from
 *         every staff list; a restored ticket can be raised again).
 *       - device: row missing or `status = 'decommissioned'` (removed from the
 *         fleet; the removed-device purge hard-deletes it later. A device
 *         restored afterwards can be raised again).
 *       - org: `organizations.id = subject_id = wisp_concerns.org_id`, not
 *         soft-deleted.
 *       - integration: `connection_health_incidents`; run: `ai_agent_runs`;
 *         task: `ai_operator_tasks`; alert, quote, invoice, contract, site:
 *         their own tables. Existence only — a resolved alert or closed
 *         incident is a state for the assessment to judge, not "gone".
 *       - incident: NOT reconciled. It names the concern itself (no table);
 *         the correlator auto-closes it.
 *     Partner-level concerns (`org_id IS NULL`) are skipped.
 *
 * Resolutions go through W05a's `resolveConcern(id, {}, 'subject_gone')`: no
 * grant ⇒ no `concern_outcome` memory block (nothing was learned).
 *
 * The `concern_outcome` memory retention is the job's third pass
 * (jobs/wispConcernRetention.ts), next to the broker-contract allowlist entry.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ConcernSubjectKind } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { alerts } from '../../db/schema/alerts';
import { connectionHealthIncidents } from '../../db/schema/connectionHealth';
import { contracts } from '../../db/schema/contracts';
import { devices } from '../../db/schema/devices';
import { invoices } from '../../db/schema/invoices';
import { organizations, sites } from '../../db/schema/orgs';
import { tickets } from '../../db/schema/portal';
import { quotes } from '../../db/schema/quotes';
import { wispConcerns } from '../../db/schema/wispConcerns';
import { pruneInCtidBatches, warnOnRetentionBacklog } from '../../jobs/retentionBatch';
import { captureException } from '../sentry';
import { resolveConcern } from './concerns';

const LOG_PREFIX = '[WispConcernReaper]';
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RESOLVED_RETENTION_DAYS = 90;
export const DEFAULT_REAPER_LIMIT = 500;
export const REAPER_MAX_BATCHES = 20;
export const SUBJECT_GONE_OUTCOME = 'subject_gone';

type SubjectTable = {
  table: PgTable;
  id: AnyPgColumn;
  /** The column pinned to `wisp_concerns.org_id`. */
  orgId: AnyPgColumn;
  /** Extra "still present" predicate (soft delete / removal); absent = existence only. */
  present?: SQL;
};

/**
 * Every subject kind, exhaustively: adding a kind to CONCERN_SUBJECT_KINDS
 * fails the build here until it is mapped (or explicitly `null`).
 */
const SUBJECT_TABLES: Record<ConcernSubjectKind, SubjectTable | null> = {
  ticket: { table: tickets, id: tickets.id, orgId: tickets.orgId, present: sql`${tickets.deletedAt} IS NULL` },
  device: { table: devices, id: devices.id, orgId: devices.orgId, present: sql`${devices.status} <> 'decommissioned'` },
  alert: { table: alerts, id: alerts.id, orgId: alerts.orgId },
  org: { table: organizations, id: organizations.id, orgId: organizations.id, present: sql`${organizations.deletedAt} IS NULL` },
  integration: { table: connectionHealthIncidents, id: connectionHealthIncidents.id, orgId: connectionHealthIncidents.orgId },
  run: { table: aiAgentRuns, id: aiAgentRuns.id, orgId: aiAgentRuns.orgId },
  task: { table: aiOperatorTasks, id: aiOperatorTasks.id, orgId: aiOperatorTasks.orgId },
  quote: { table: quotes, id: quotes.id, orgId: quotes.orgId },
  invoice: { table: invoices, id: invoices.id, orgId: invoices.orgId },
  contract: { table: contracts, id: contracts.id, orgId: contracts.orgId },
  site: { table: sites, id: sites.id, orgId: sites.orgId },
  // Names the concern itself (correlator-minted); the correlator auto-closes it.
  incident: null,
};

export const RECONCILED_SUBJECT_KINDS = (Object.keys(SUBJECT_TABLES) as ConcernSubjectKind[])
  .filter((kind) => SUBJECT_TABLES[kind] !== null);

export type ReapConcernsOptions = { resolvedRetentionDays?: number; limit?: number };

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function reportFailure(op: string, err: unknown, tags: Record<string, string> = {}): void {
  console.error(`${LOG_PREFIX} ${op} failed:`, err);
  captureException(err, undefined, { op: `wisp.concernReaper.${op}`, ...tags });
}

/** Pass 1 — delete closed concerns past retention. Opens its own context per batch. */
export async function pruneClosedConcerns(now: Date, opts: ReapConcernsOptions = {}): Promise<{ deleted: number }> {
  const days = positiveInt(opts.resolvedRetentionDays, DEFAULT_RESOLVED_RETENTION_DAYS);
  const batchSize = positiveInt(opts.limit, DEFAULT_REAPER_LIMIT);
  // postgres-js does not coerce a JS Date in template params; pass an ISO string.
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const result = await pruneInCtidBatches({
    table: 'wisp_concerns',
    // Literal status list: matches the partial index `wisp_concerns_closed_updated_idx`.
    where: sql`${wispConcerns.status} IN ('resolved','dismissed') AND ${wispConcerns.updatedAt} < ${cutoff}::timestamptz`,
    batchSize,
    maxBatches: REAPER_MAX_BATCHES,
    label: 'wisp.concernReaper.prune',
  });
  warnOnRetentionBacklog(LOG_PREFIX, 'wisp_concerns', result);
  return { deleted: result.deleted };
}

function goneSubjectQuery(kind: ConcernSubjectKind, t: SubjectTable, limit: number): SQL {
  const present = t.present ? sql` AND ${t.present}` : sql``;
  return sql`
    SELECT ${wispConcerns.id} AS id
    FROM ${wispConcerns}
    WHERE ${wispConcerns.status} IN ('open','snoozed')
      AND ${wispConcerns.orgId} IS NOT NULL
      AND ${wispConcerns.subjectKind} = ${kind}
      AND NOT EXISTS (SELECT 1 FROM ${t.table} WHERE ${t.id} = ${wispConcerns.subjectId} AND ${t.orgId} = ${wispConcerns.orgId}${present})
    ORDER BY ${wispConcerns.updatedAt}
    LIMIT ${limit}
  `;
}

/**
 * Pass 2 — resolve live org-level concerns whose subject is gone. At most
 * `limit` concerns per kind per run; the remainder is left for the next run.
 */
export async function reconcileConcernSubjects(opts: Pick<ReapConcernsOptions, 'limit'> = {}): Promise<{ subjectGone: number }> {
  const limit = positiveInt(opts.limit, DEFAULT_REAPER_LIMIT);
  let subjectGone = 0;
  for (const kind of RECONCILED_SUBJECT_KINDS) {
    const t = SUBJECT_TABLES[kind];
    if (!t) continue;
    let ids: string[];
    try {
      const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
        async () => [...((await db.execute(goneSubjectQuery(kind, t, limit))) as unknown as Array<{ id: string }>)],
        `wisp.concernReaper.reconcile.${kind}`,
      ));
      ids = rows.map((r) => r.id);
    } catch (err) {
      reportFailure('reconcile', err, { subjectKind: kind });
      continue;
    }
    // Each resolution opens its own short system context (no long transaction).
    for (const id of ids) {
      try {
        await resolveConcern(id, {}, SUBJECT_GONE_OUTCOME);
        subjectGone += 1;
      } catch (err) {
        reportFailure('resolve', err, { subjectKind: kind, concernId: id });
      }
    }
    if (ids.length >= limit) {
      console.warn(`${LOG_PREFIX} ${kind}: ${ids.length} concerns with a gone subject this run (limit ${limit}); the rest wait for the next run`);
    }
  }
  return { subjectGone };
}

/** Both passes; a pass that throws is logged and counts zero. */
export async function reapConcerns(now: Date, opts: ReapConcernsOptions = {}): Promise<{ deleted: number; subjectGone: number }> {
  let deleted = 0;
  let subjectGone = 0;
  try {
    ({ deleted } = await pruneClosedConcerns(now, opts));
  } catch (err) {
    reportFailure('prune', err);
  }
  try {
    ({ subjectGone } = await reconcileConcernSubjects(opts));
  } catch (err) {
    reportFailure('reconcile', err);
  }
  return { deleted, subjectGone };
}
