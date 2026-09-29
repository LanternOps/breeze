/**
 * Multi-org report series — reconciler, repair sweep and worker gate (spec §3.3).
 *
 * The reconciler is the ONLY writer of a child's shared fields (name, type,
 * format, schedule, config, series_revision, execution scope). It runs
 *  - transactionally inside every series write (services/reportSeries/store.ts),
 *  - in the repair sweep on every check-schedules tick (reconcileAllSeries,
 *    system context), and
 *  - from the worker gate when a queued child's revision is stale.
 *
 * Archive, never delete: a child whose org leaves the target set (exclusion,
 * ineligibility) keeps its row, runs and evidence with archived_at set, and is
 * unarchived in place if the org comes back.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { reports, reportSeries } from '../../db/schema';
import { captureException } from '../sentry';
import {
  captureChildExecutionScope,
  isSeriesOwnerEligible,
  type ExecutionScopeColumns,
} from './authority';
import { resolveSeriesTargetOrgIds } from './targets';
import {
  emptyReconcileResult,
  type ReconcileResult,
  type ReportSeriesRow,
  type SeriesGateDecision,
  type SeriesTx,
} from './types';

export const SERIES_SWEEP_LIMIT = 100;

/**
 * The all-NULL execution scope of a BLOCKED child (spec §3.4 "blocked: no
 * authority"). reports_execution_scope_shape_chk admits it (the legacy
 * shape); the worker's completeExecutableScopePredicate never polls it, so a
 * blocked child is never run with any authority at all.
 */
const BLOCKED_EXECUTION_SCOPE: ExecutionScopeColumns = {
  executionScopeVersion: null,
  executionScopeKind: null,
  executionScopeSiteIds: null,
  executionScopeUserId: null,
  executionScopeFingerprint: null,
  executionScopeCapturedAt: null,
  executionScopePrincipalKind: null,
};

export interface SeriesChildRow {
  id: string;
  orgId: string;
  seriesRevision: number | null;
  archivedAt: Date | null;
  executionScopeUserId: string | null;
}

/** A child's config: the series config with internal CC as emailRecipients. */
export function seriesChildConfig(config: unknown, internalCc: readonly string[]): Record<string, unknown> {
  const base: Record<string, unknown> = config && typeof config === 'object' && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
  delete base.emailRecipients;
  return internalCc.length > 0 ? { ...base, emailRecipients: [...internalCc] } : base;
}

function childSharedFields(series: ReportSeriesRow) {
  return {
    name: series.name,
    type: series.type,
    format: series.format,
    schedule: series.schedule,
    config: seriesChildConfig(series.config, series.internalCc),
    seriesRevision: series.revision,
  };
}

/** Every child of one series; active rows first, then most recently archived. */
export async function listSeriesChildren(seriesId: string, tx: SeriesTx): Promise<SeriesChildRow[]> {
  const rows = await tx
    .select({
      id: reports.id,
      orgId: reports.orgId,
      seriesRevision: reports.seriesRevision,
      archivedAt: reports.archivedAt,
      executionScopeUserId: reports.executionScopeUserId,
    })
    .from(reports)
    .where(eq(reports.seriesId, seriesId))
    .orderBy(desc(reports.archivedAt), desc(reports.updatedAt), desc(reports.id));
  // reports_series_child_shape_chk: a child always has an org.
  return rows.flatMap((row) => (row.orgId === null ? [] : [{ ...row, orgId: row.orgId }]));
}

async function updateSeriesChild(
  tx: SeriesTx,
  seriesId: string,
  child: Pick<SeriesChildRow, 'id' | 'orgId'>,
  set: Partial<typeof reports.$inferInsert>,
): Promise<void> {
  await tx
    .update(reports)
    .set(set)
    .where(and(eq(reports.id, child.id), eq(reports.orgId, child.orgId), eq(reports.seriesId, seriesId)));
}

export async function reconcileSeries(seriesId: string, tx: SeriesTx): Promise<ReconcileResult> {
  const result = emptyReconcileResult();
  const [series] = await tx
    .select()
    .from(reportSeries)
    .where(eq(reportSeries.id, seriesId))
    .limit(1)
    .for('update');
  if (!series) return result;

  const targetOrgIds = await resolveSeriesTargetOrgIds(series, tx);
  const targeted = new Set(targetOrgIds);
  const active = new Map<string, SeriesChildRow>();
  const archived = new Map<string, SeriesChildRow>();
  for (const child of await listSeriesChildren(seriesId, tx)) {
    if (child.archivedAt === null) active.set(child.orgId, child);
    else if (!archived.has(child.orgId)) archived.set(child.orgId, child);
  }

  const ownerUserId = series.ownerUserId;
  const ownerEligible = ownerUserId !== null
    && await isSeriesOwnerEligible(ownerUserId, series.partnerId, tx);
  const shared = childSharedFields(series);
  const now = new Date();

  for (const orgId of targetOrgIds) {
    const current = active.get(orgId);
    const scopeIsCurrent = current !== undefined
      && ownerEligible
      && current.executionScopeUserId !== null
      && current.executionScopeUserId === ownerUserId;

    let scope: ExecutionScopeColumns | null = null;
    if (!scopeIsCurrent) {
      const captured = ownerEligible && ownerUserId !== null
        ? await captureChildExecutionScope(ownerUserId, orgId, tx)
        : 'no_authority';
      if (captured === 'no_authority') {
        result.blocked.push(orgId);
        scope = BLOCKED_EXECUTION_SCOPE;
      } else {
        scope = captured;
      }
    }

    if (current) {
      // A still-blocked child is not rewritten just to re-blank its scope.
      const scopeChanges = scope !== null
        && !(scope === BLOCKED_EXECUTION_SCOPE && current.executionScopeUserId === null);
      if (current.seriesRevision === series.revision && !scopeChanges) continue;
      await updateSeriesChild(tx, seriesId, current, {
        ...shared,
        ...(scopeChanges && scope ? scope : {}),
        updatedAt: now,
      });
      result.updated += 1;
      continue;
    }

    const newScope = scope ?? BLOCKED_EXECUTION_SCOPE;
    const previous = archived.get(orgId);
    if (previous) {
      await updateSeriesChild(tx, seriesId, previous, {
        ...shared,
        ...newScope,
        archivedAt: null,
        updatedAt: now,
      });
      result.unarchived += 1;
      continue;
    }

    await tx.insert(reports).values({
      orgId,
      partnerId: null,
      seriesId,
      createdBy: series.createdBy,
      portalSelfService: false,
      ...shared,
      ...newScope,
    });
    result.created += 1;
  }

  for (const [orgId, child] of active) {
    if (targeted.has(orgId)) continue;
    await updateSeriesChild(tx, seriesId, child, { archivedAt: now, updatedAt: now });
    result.archived += 1;
  }
  return result;
}

/**
 * Series with STRUCTURAL drift: a targeted eligible org without an active
 * child, an active child at a stale revision (0 included), or an active child
 * of an org that is no longer targeted. Blocked children are deliberately not
 * drift (plan Contract concern 13). Random order so a persistently failing
 * series cannot starve the rest past the limit.
 */
export async function findSeriesNeedingReconcile(limit: number, tx: SeriesTx = db): Promise<string[]> {
  const rows = (await tx.execute(sql`
    WITH targets AS (
      SELECT s.id AS series_id, o.id AS org_id
        FROM report_series s
        JOIN organizations o ON o.partner_id = s.partner_id
       WHERE o.status IN ('active', 'trial')
         AND o.deleted_at IS NULL
         AND (
           (s.target_mode = 'all' AND NOT EXISTS (
              SELECT 1 FROM report_series_org_targets x WHERE x.series_id = s.id AND x.org_id = o.id))
           OR (s.target_mode = 'selected' AND EXISTS (
              SELECT 1 FROM report_series_org_targets x WHERE x.series_id = s.id AND x.org_id = o.id))
         )
    ),
    active_children AS (
      SELECT r.series_id, r.org_id, r.series_revision
        FROM reports r
       WHERE r.series_id IS NOT NULL AND r.archived_at IS NULL
    )
    SELECT s.id
      FROM report_series s
     WHERE EXISTS (
             SELECT 1 FROM targets t
              WHERE t.series_id = s.id
                AND NOT EXISTS (
                  SELECT 1 FROM active_children a WHERE a.series_id = t.series_id AND a.org_id = t.org_id))
        OR EXISTS (
             SELECT 1 FROM active_children a
              WHERE a.series_id = s.id
                AND (a.series_revision IS DISTINCT FROM s.revision
                     OR NOT EXISTS (
                       SELECT 1 FROM targets t WHERE t.series_id = a.series_id AND t.org_id = a.org_id)))
     ORDER BY random()
     LIMIT ${limit}
  `)) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * The repair sweep (spec §3.3 trigger 2), run on every check-schedules tick
 * BEFORE the due scan. Bounded, per-series error isolation (each series is its
 * own savepoint), logged. Picks up new orgs in 'all' mode and repairs anything
 * a crash left behind.
 */
export async function reconcileAllSeries(options: {
  limit?: number;
  reconcileOne?: (seriesId: string) => Promise<ReconcileResult>;
} = {}): Promise<void> {
  const limit = options.limit ?? SERIES_SWEEP_LIMIT;
  const reconcileOne = options.reconcileOne
    ?? ((seriesId: string) => db.transaction((tx) => reconcileSeries(seriesId, tx)));
  await withSystemDbAccessContext(async () => {
    const ids = await findSeriesNeedingReconcile(limit + 1);
    if (ids.length > limit) {
      console.warn('[reportSeries] repair sweep backlog exceeds one tick; the remainder rolls to the next tick', { limit });
    }
    for (const seriesId of ids.slice(0, limit)) {
      try {
        const result = await reconcileOne(seriesId);
        console.log('[reportSeries] repair sweep reconciled series', {
          seriesId,
          created: result.created,
          updated: result.updated,
          archived: result.archived,
          unarchived: result.unarchived,
          blocked: result.blocked.length,
        });
      } catch (err) {
        console.error('[reportSeries] repair sweep failed for one series; continuing', { seriesId, err });
        captureException(err);
      }
    }
  }, 'reportSeries.repairSweep');
}

/**
 * Worker gate (spec §3.3). Called by processRunScheduledReport for a row with
 * series_id set, BEFORE any authority resolution or run row. Closes the "job
 * queued before the org was excluded / the series was disabled / the owner
 * was demoted" races. A stale revision is reconciled first so the run uses the
 * current definition; the caller must re-read the row after 'run'.
 */
export async function seriesChildGate(report: {
  id: string;
  orgId: string;
  seriesId: string;
  seriesRevision: number | null;
  archivedAt: Date | null;
}): Promise<SeriesGateDecision> {
  if (report.archivedAt !== null) return 'skip_archived';
  return db.transaction(async (tx): Promise<SeriesGateDecision> => {
    const [series] = await tx
      .select()
      .from(reportSeries)
      .where(eq(reportSeries.id, report.seriesId))
      .limit(1)
      .for('update');
    if (!series) return 'skip_untargeted';
    if (!series.enabled) return 'skip_disabled';
    const targets = await resolveSeriesTargetOrgIds(series, tx);
    if (!targets.includes(report.orgId)) return 'skip_untargeted';
    if (series.ownerUserId === null || !(await isSeriesOwnerEligible(series.ownerUserId, series.partnerId, tx))) {
      return 'blocked_no_authority';
    }
    if (report.seriesRevision !== series.revision) await reconcileSeries(series.id, tx);
    const child = (await listSeriesChildren(series.id, tx)).find((row) => row.id === report.id);
    if (!child || child.archivedAt !== null) return 'skip_archived';
    if (child.executionScopeUserId === null || child.executionScopeUserId !== series.ownerUserId) {
      return 'blocked_no_authority';
    }
    return 'run';
  });
}
