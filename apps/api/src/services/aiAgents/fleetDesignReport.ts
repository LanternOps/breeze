// apps/api/src/services/aiAgents/fleetDesignReport.ts
/**
 * Fleet Designer W01 (#5651), Task 8 — turns the `FleetDesignOutcome` a
 * `design`-profile run produced (`runLoop.ts`'s `finalizeFleetDesign`) into a
 * durable, downloadable REPORT: one system-authored `reports` definition per
 * ORGANIZATION plus one `report_runs` artifact per run, with
 * `ai_agent_runs.report_run_id` linking the run to it.
 *
 * Direct sibling of `narrativeReport.ts` (`persistNarrativeReport`) — read
 * that module's header for the shared DB-context posture (one system
 * transaction, the run-lock-then-CAS pattern, hand-pinned `org_id` on every
 * statement). Two things are structurally different here:
 *
 *  1. **The definition is keyed on the ORG, not the schedule.** A narrative
 *     definition is one per `source_ai_agent_schedule_id` because every
 *     narrative run is scheduled. A Fleet Design has no such guarantee —
 *     `POST /ai/fleet-design/runs` starts a manual, schedule-less run — so
 *     the definition is upserted against the PARTIAL unique index
 *     `reports_ai_fleet_design_org_uniq` (`org_id`) `WHERE type =
 *     'ai_fleet_design'` (migration `2026-10-16-170500-ai-agents-fleet-designer.sql`)
 *     instead. A later run — manual or scheduled — reuses the SAME
 *     definition row and simply replaces its artifact, exactly like a human
 *     re-running any other one-time report.
 *  2. **`schedule: 'one_time'`, not `'weekly'`.** The definition's own
 *     `schedule` column governs whether `reportScheduleWorker.ts` would try
 *     to poll it for a next occurrence; a Fleet Design is never polled (its
 *     occurrences come from the AGENT scheduler, exactly like narrative) so
 *     the exclusion is enforced the same way (`WORKER_EXCLUDED_REPORT_TYPES`),
 *     but `'one_time'` is also just the true shape here: unlike narrative,
 *     the schedule that produced a GIVEN run is not part of the definition's
 *     own identity.
 *
 * ## What reaches the stored snapshot
 *
 * `report_runs.result.summary.fleetDesign` is a `FleetDesignReportSummary`:
 * the server-built `FleetDesignOutcome` (every `itemRef` attached,
 * `baseline.numbers` computed, markdown derived) verbatim, plus provenance
 * scalars. The bounded `DesignEvidence` bundle itself is NEVER stored — only
 * `evidenceTruncated` and `devicesNotAssessed`, same "the evidence was
 * assembled to be rendered into ONE prompt, not persisted" posture
 * `narrativeReport.ts` documents for `NarrativeContext`.
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  type AiAgentRunFleetDesignDto,
  type FleetDesignDrift,
  type FleetDesignOutcome,
  type FleetDesignReportSummary,
} from '@breeze/shared';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — same note as runLoop.ts /
// narrativeReport.ts.
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { reportRuns, reports } from '../../db/schema/reports';
import type { DesignEvidence } from './designEvidence';
import { persistedSystemSiteScopeValues, systemReportAuthority } from '../siteScope';

/** The definition name every Fleet Design shares. Not model-authored: it is
 *  chrome, exactly like the narrative's `NARRATIVE_REPORT_NAME`. */
export const FLEET_DESIGN_REPORT_NAME = 'Fleet Design';

/** The `reports.type` value that marks a system-managed Fleet Design
 *  definition. Several other modules gate on the same value as a bare
 *  literal (`reportGenerationService`'s two exhaustive switches, the
 *  ad-hoc-generate/create schemas, the scheduled-report worker, the
 *  system-managed-definition helper) — kept literal there for the same
 *  reason `NARRATIVE_REPORT_TYPE` is. */
export const FLEET_DESIGN_REPORT_TYPE = 'ai_fleet_design' as const;

/** Max characters of an org/partner/agent NAME carried into the stored
 *  snapshot — same treatment `narrativeReport.ts`'s `NAME_MAX_CHARS` gives. */
const NAME_MAX_CHARS = 200;

export interface FleetDesignPersistInput {
  run: { id: string; orgId: string; agentId: string; scheduleId: string | null };
  agent: { id: string; name: string };
  evidence: DesignEvidence;
  outcome: FleetDesignOutcome;
  /** W05: server-computed drift against the org's applied design; null when there was none. */
  drift?: FleetDesignDrift | null;
}

/**
 * The run is no longer the owner of this design: it left `running` (stall
 * reaper, cancellation, a second executor), or it already carries an
 * artifact, or the final link CAS matched zero rows. Distinct from a generic
 * failure because `finalizeFleetDesign` maps it to its own error code — a
 * lost CAS is a race that resolved correctly, not a bug to page anyone
 * about. Direct sibling of `NarrativePersistConflictError`.
 */
export class FleetDesignPersistConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetDesignPersistConflictError';
  }
}

/**
 * Same skip-if-already-system shape as `narrativeReport.ts`'s
 * `inSystemDbContext` (and `runLoop.ts`'s, and `runFinalizers.ts`'s): a bare
 * system wrapper is a no-op inside an ambient request context, and
 * re-entering from an already-system context would take a SECOND pooled
 * connection while the first is still held.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** Collapses one stored string to a single line, same treatment
 *  `narrativeReport.ts`'s `flattenLine` gives an org/partner/agent name. */
function flattenLine(value: unknown, maxChars = NAME_MAX_CHARS): string {
  if (typeof value !== 'string') return '';
  const line = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return line.slice(0, maxChars);
}

function countWatchesAndRules(outcome: FleetDesignOutcome): { watchCount: number; ruleCount: number } {
  let watchCount = 0;
  let ruleCount = 0;
  for (const entry of outcome.sections.monitoring) {
    watchCount += entry.watches.length;
    ruleCount += entry.alertRules.length;
  }
  return { watchCount, ruleCount };
}

/**
 * PRECONDITION: must not be called from inside an ambient REQUEST context
 * (see `inSystemDbContext` above). `finalizeFleetDesign` satisfies this — it
 * runs from the background run loop, which holds no ambient context of its
 * own.
 *
 * Throws `FleetDesignPersistConflictError` when the run is no longer this
 * design's owner; any other throw is a genuine failure the caller reports as
 * `design_persist_failed`. Either way the enclosing transaction rolls back,
 * so a failed call leaves NO definition change, NO artifact and NO link.
 */
export async function persistFleetDesignReport(
  input: FleetDesignPersistInput,
): Promise<{ reportId: string; reportRunId: string; downloadPath: string }> {
  const { run, agent, evidence, outcome, drift = null } = input;

  return inSystemDbContext(async () => {
    // 1. Lock the run and re-check ownership. `FOR UPDATE` holds the row for
    //    the rest of the transaction, so a concurrent executor blocks here
    //    rather than racing us to the CAS in step 5.
    const [locked] = await db
      .select({
        id: aiAgentRuns.id,
        status: aiAgentRuns.status,
        reportRunId: aiAgentRuns.reportRunId,
      })
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.id, run.id), eq(aiAgentRuns.orgId, run.orgId)))
      .limit(1)
      .for('update');
    if (!locked) {
      throw new FleetDesignPersistConflictError('run row is not visible for fleet design persistence');
    }
    if (locked.status !== 'running') {
      throw new FleetDesignPersistConflictError(`run left \`running\` (status ${locked.status})`);
    }
    if (locked.reportRunId !== null) {
      throw new FleetDesignPersistConflictError('run already carries a fleet design artifact');
    }

    const scopeValues = persistedSystemSiteScopeValues(systemReportAuthority(run.orgId));

    // 2. Find-or-create the ONE Fleet Design definition for this org.
    //    `ON CONFLICT DO NOTHING` against the PARTIAL unique index
    //    `reports_ai_fleet_design_org_uniq` (org_id) WHERE type =
    //    'ai_fleet_design' — the predicate is not optional: without it
    //    Postgres cannot infer the partial index and raises 42P10 instead of
    //    doing nothing. The read-back that follows returns the WINNER,
    //    whether that is our row or a concurrent writer's, or the org's
    //    existing definition from a PRIOR run entirely (manual runs have no
    //    schedule to key on, so re-running the design reuses the same
    //    definition and replaces its artifact).
    await db
      .insert(reports)
      .values({
        orgId: run.orgId,
        name: FLEET_DESIGN_REPORT_NAME,
        type: FLEET_DESIGN_REPORT_TYPE,
        // Config is provenance, not parameters: nothing generates this report
        // from its config (`reportGenerationService` refuses the type
        // outright — the artifact is stored, never regenerated).
        config: { source: 'ai_agent', agentId: agent.id, scheduleId: run.scheduleId },
        schedule: 'one_time',
        format: 'pdf',
        // No acting user anywhere in this path. The shape CHECK
        // (`reports_execution_scope_shape_chk`) admits a NULL
        // execution_scope_user_id only when principal_kind = 'system'.
        createdBy: null,
        sourceAiAgentScheduleId: run.scheduleId,
        ...scopeValues,
      })
      .onConflictDoNothing({
        target: [reports.orgId],
        // `where` on a DO NOTHING is the conflict-TARGET predicate — drizzle
        // renders `on conflict (org_id) where type = 'ai_fleet_design' do
        // nothing`. It has to match the partial index's own predicate
        // exactly or Postgres cannot infer the index.
        where: sql`${reports.type} = 'ai_fleet_design'`,
      });

    const [definition] = await db
      .select({ id: reports.id })
      .from(reports)
      .where(and(
        eq(reports.orgId, run.orgId),
        eq(reports.type, FLEET_DESIGN_REPORT_TYPE),
      ))
      .limit(1);
    if (!definition) {
      // Not a conflict: the upsert either inserted our row or lost to a
      // concurrent one, and BOTH leave a readable winner. Reaching here means
      // something else deleted it inside our transaction's snapshot, which is
      // a real failure the caller should log as such.
      throw new Error('fleet design report definition disappeared after upsert');
    }

    // 3. The artifact. `rows: []` / `rowCount: 0` because a Fleet Design has
    //    no tabular body at all — the whole document is
    //    `summary.fleetDesign`.
    const generatedAt = new Date();
    const summary: FleetDesignReportSummary = {
      fleetDesign: {
        schemaVersion: outcome.schemaVersion,
        outcome,
        orgName: flattenLine(evidence.org.name),
        partnerName: flattenLine(evidence.org.partnerName),
        siteName: evidence.org.siteName ? flattenLine(evidence.org.siteName) : null,
        generatedAt: generatedAt.toISOString(),
        runId: run.id,
        agentName: flattenLine(agent.name),
        evidenceTruncated: evidence.truncated,
        devicesNotAssessed: evidence.devicesNotAssessed,
        unavailable: [...evidence.unavailable],
        drift,
      },
    };

    const [artifact] = await db
      .insert(reportRuns)
      .values({
        reportId: definition.id,
        status: 'completed',
        startedAt: generatedAt,
        completedAt: generatedAt,
        rowCount: 0,
        result: { rows: [], rowCount: 0, summary },
        requestedByKind: 'system',
        requestedByUserId: null,
        requestedByPortalUserId: null,
        ...scopeValues,
      })
      .returning({ id: reportRuns.id });
    if (!artifact) throw new Error('fleet design report run insert returned no row');

    const downloadPath = `/api/reports/runs/${artifact.id}/download`;
    // The download URL embeds the artifact's own id, which only exists after
    // the INSERT — hence a second statement rather than a value on the first.
    await db
      .update(reportRuns)
      .set({ outputUrl: downloadPath })
      .where(eq(reportRuns.id, artifact.id));

    // 4. Stamp the definition so `/reports` sorts and renders it like any
    //    other. Org-pinned even though the id is unique: the system context
    //    bypasses RLS, so the pin is the only tenancy check on this
    //    statement.
    await db
      .update(reports)
      .set({ lastGeneratedAt: generatedAt, updatedAt: generatedAt })
      .where(and(eq(reports.id, definition.id), eq(reports.orgId, run.orgId)));

    // 5. The commit gate. `report_run_id IS NULL` makes this a
    //    compare-and-set: zero rows means somebody else linked an artifact
    //    (or moved the run) while we held the lock, and the throw rolls back
    //    everything above.
    const linked = await db
      .update(aiAgentRuns)
      .set({ reportRunId: artifact.id })
      .where(and(
        eq(aiAgentRuns.id, run.id),
        eq(aiAgentRuns.orgId, run.orgId),
        isNull(aiAgentRuns.reportRunId),
      ))
      .returning({ id: aiAgentRuns.id });
    if (linked.length !== 1) {
      throw new FleetDesignPersistConflictError(
        'run could not be linked to the fleet design artifact (report_run_id was already set)',
      );
    }

    return { reportId: definition.id, reportRunId: artifact.id, downloadPath };
  });
}

/**
 * Safe projection of a design run's outcome for `GET /ai/agents/runs/:runId`.
 *
 * `artifact` is the linked `report_runs` row the route loaded (projected via
 * `fleetDesignArtifactProjection`), or `null` when the run carries no
 * artifact (never materialised, or the artifact was since deleted — the FK
 * is `ON DELETE SET NULL`, so run history survives). `evidenceTruncated`
 * comes from the STORED snapshot rather than the live `outcome`, which
 * carries no such field of its own — same "read it off the artifact, not the
 * in-memory outcome" split `projectNarrative`'s `contextTruncated` makes.
 */
export function projectFleetDesign(
  run: { reportRunId: string | null },
  outcome: { fleetDesign?: FleetDesignOutcome },
  artifact: { reportId: string | null; evidenceTruncated: boolean | null } | null,
): AiAgentRunFleetDesignDto | null {
  const fleetDesign = outcome.fleetDesign;
  if (!fleetDesign) return null;

  const { watchCount, ruleCount } = countWatchesAndRules(fleetDesign);

  return {
    reportRunId: run.reportRunId,
    reportId: artifact?.reportId ?? null,
    downloadPath: run.reportRunId ? `/api/reports/runs/${run.reportRunId}/download` : null,
    generatedAt: fleetDesign.generatedAt,
    functionCount: fleetDesign.sections.functions.length,
    watchCount,
    ruleCount,
    evidenceTruncated: artifact?.evidenceTruncated ?? false,
  };
}

/**
 * The fleet-design snapshot fields the run-detail route needs off a linked
 * `report_runs` row, projected out of the stored jsonb by Postgres so the
 * route never pulls the whole `result` document (which carries the full
 * outcome, including scripts) across the wire just to read a few scalars.
 * Direct sibling of `narrativeReport.ts`'s `narrativeArtifactProjection`.
 */
export const fleetDesignArtifactProjection = {
  reportRunId: reportRuns.id,
  reportId: reportRuns.reportId,
  generatedAt: sql<string | null>`${reportRuns.result}->'summary'->'fleetDesign'->>'generatedAt'`,
  evidenceTruncated: sql<boolean | null>`(${reportRuns.result}->'summary'->'fleetDesign'->>'evidenceTruncated')::boolean`,
};

/**
 * Loads one Fleet Design artifact by its `report_runs.id`, scoped by the
 * caller's own tenancy condition on `reports.org_id` — used by the run-detail
 * route (Task 12) and the W03 Fleet Design page. `orgCondition` is a plain
 * predicate builder (e.g. `(orgId) => eq(orgId, auth.orgId)`) rather than a
 * full `AuthContext`, so this module stays independent of the auth-context
 * shape callers build it from. `undefined` means "no org filter" — the
 * system-scope contract of `AuthContext.orgCondition`; `and()` drops it.
 *
 * Returns `null` when the run does not exist, does not belong to a Fleet
 * Design definition, or fails the caller's org condition — the caller cannot
 * tell those three apart, which is the point: a cross-tenant probe reads
 * identically to a typo'd id.
 */
export async function loadFleetDesignReport(
  reportRunId: string,
  orgCondition: (orgId: AnyPgColumn) => SQL<unknown> | undefined,
): Promise<{
  reportRunId: string; reportId: string; orgId: string; summary: FleetDesignReportSummary; generatedAt: string | null;
} | null> {
  const [row] = await db
    .select({
      reportRunId: reportRuns.id,
      reportId: reports.id,
      orgId: reports.orgId,
      summary: sql<FleetDesignReportSummary>`${reportRuns.result}->'summary'`,
      generatedAt: sql<string | null>`${reportRuns.result}->'summary'->'fleetDesign'->>'generatedAt'`,
    })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(
      eq(reportRuns.id, reportRunId),
      eq(reports.type, FLEET_DESIGN_REPORT_TYPE),
      orgCondition(reports.orgId),
    ))
    .limit(1);

  return row ?? null;
}
