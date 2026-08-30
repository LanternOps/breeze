// apps/api/src/services/aiAgents/narrativeReport.ts
/**
 * Phase 2 wave P2-3 (weekly org narrative), Task A7 — turns the
 * `NarrativeOutcome` a `narrative`-profile run produced (`runLoop.ts`'s
 * `finalizeNarrative`) into a durable, downloadable REPORT: one system-authored
 * `reports` definition per schedule plus one `report_runs` artifact per
 * occurrence, with `ai_agent_runs.report_run_id` linking the run to it.
 *
 * Direct sibling of `sweepFindings.ts` (`persistSweepFindings`) and
 * `alertVerdicts.ts` (`persistAlertVerdict`) — read either for the shared
 * DB-context posture. Three things are structurally different here:
 *
 *  1. **There IS a table, and it is somebody else's.** A narrative lands in
 *     `reports`/`report_runs`, the same two tables the human report builder
 *     writes to. That is deliberate: an MSP gets the weekly narrative in the
 *     same place as every other report, with the same download route, the same
 *     PDF renderer and the same RLS. The cost is that the row must carry
 *     provenance no human report ever needs — `execution_scope_principal_kind
 *     = 'system'` with a NULL acting user (`persistedSystemSiteScopeValues`,
 *     siteScope.ts) and `source_ai_agent_schedule_id` as the typed identity of
 *     the schedule that owns it. Everything downstream keys off those two:
 *     `reportScheduleWorker` refuses to execute a system-principal definition,
 *     and the report write routes refuse to mutate one.
 *
 *  2. **It is ONE transaction, and the run link is the commit gate.**
 *     `withSystemDbAccessContext` opens a real transaction and routes every
 *     `db` statement inside it onto that connection (see `db/index.ts`), so
 *     the whole body below is atomic without a nested `db.transaction`
 *     (which would only add a SAVEPOINT). The final statement is a
 *     compare-and-set on `ai_agent_runs.report_run_id`: if it matches zero
 *     rows — a second executor got there first, the stall reaper moved the
 *     run, the row left the org — the throw rolls the definition AND the
 *     artifact back. A narrative artifact that no run points at is an
 *     orphaned customer-facing document, which is worse than no document.
 *
 *  3. **Every statement is org-pinned by hand.** The system context bypasses
 *     RLS by design (it has to: it writes on behalf of no user), so `org_id`
 *     appears in the WHERE of the run lock, the definition read-back, the
 *     `last_generated_at` stamp and the run CAS. `narrativeReport.test.ts`
 *     asserts that against COMPILED SQL, because a mocked `.where()` cannot
 *     tell a present pin from a missing one.
 *
 * ## What reaches the stored snapshot
 *
 * `report_runs.result.summary.narrative` is an `OrgNarrativeReportSummary`:
 * the server-titled sections, the SERVER-DERIVED markdown (re-derived here via
 * `renderNarrativeMarkdown` rather than copied off the outcome, so the cap
 * holds even for a hand-built or legacy outcome), and provenance scalars. The
 * weekly `NarrativeContext` itself is NOT stored — only its `period`,
 * `org.name`, `org.partnerName` and `truncated` flag. The context is a whole
 * organization's activity assembled under a system context to be rendered into
 * ONE prompt; `runLoop.narrative.test.ts` and `runTrace.test.ts` both carry
 * tripwires against it reaching a persisted row.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS,
  NARRATIVE_SECTION_KEYS,
  renderNarrativeMarkdown,
  type AiAgentRunNarrativeDto,
  type NarrativeOutcome,
  type NarrativeSection,
  type NarrativeSectionKey,
  type OrgNarrativeReportSummary,
} from '@breeze/shared';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — same note as runLoop.ts.
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { reportRuns, reports } from '../../db/schema/reports';
import type { NarrativeContext } from './narrativeContext';
import { persistedSystemSiteScopeValues, systemReportAuthority } from '../siteScope';

/** The definition name every weekly narrative shares. Not model-authored and
 *  not per-org: it is chrome, exactly like the section titles. */
export const NARRATIVE_REPORT_NAME = 'Weekly AI operations narrative';

/** The `reports.type` value that marks a system-managed narrative definition.
 *  Several other modules gate on the same value as a bare literal (the report
 *  write routes, the ad-hoc generate schema, `reportGenerationService`'s two
 *  exhaustive switches, the scheduled-report worker) — kept literal there
 *  because the pg enum + exhaustive switches already pin them. */
export const NARRATIVE_REPORT_TYPE = 'ai_org_narrative' as const;

/** Max characters of an org/partner/agent NAME carried into the stored
 *  snapshot. These are DB-sourced, not model-authored, but they render into a
 *  document an MSP forwards to their customer — so they get the same
 *  one-line flattening every narrative string gets. */
const NAME_MAX_CHARS = 200;

export interface NarrativePersistInput {
  run: { id: string; orgId: string; agentId: string; scheduleId: string };
  agent: { id: string; name: string };
  /** The schedule occurrence this narrative covers; `null` for a manually
   *  triggered narrative run. Carried for the log line only — the artifact's
   *  own period comes from the CONTEXT the run actually read. */
  occurrenceKey: string | null;
  context: NarrativeContext;
  outcome: NarrativeOutcome;
}

/**
 * The run is no longer the owner of this narrative: it left `running` (stall
 * reaper, cancellation, a second executor), or it already carries an artifact,
 * or the final link CAS matched zero rows. Distinct from a generic failure
 * because `finalizeNarrative` maps it to its own error code — a lost CAS is a
 * race that resolved correctly, not a bug to page anyone about.
 */
export class NarrativePersistConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NarrativePersistConflictError';
  }
}

/**
 * Same skip-if-already-system shape as every other file in this directory (see
 * `runLoop.ts`'s own `inSystemDbContext`): a bare system wrapper is a no-op
 * inside an ambient request context, and re-entering from an already-system
 * context would take a SECOND pooled connection while the first is still held.
 *
 * Note what this means for atomicity: when the caller already holds a system
 * context, the statements below join THAT transaction rather than opening one.
 * Still atomic — just atomic with the caller's other work. `finalizeNarrative`
 * holds no ambient context, so in production this always opens its own.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Collapses one stored/rendered string to a single line and strips leading
 * markdown block markers — the same treatment `flattenNarrativeLine`
 * (validators/orgNarrative.ts) applies to bullets, duplicated here because
 * that helper is module-private to the shared package and this file also has
 * to flatten values the submission schema never saw (an org name off the
 * `organizations` row, a section title on a legacy stored outcome).
 *
 * `\p{C}` covers C0/DEL/C1 and the bidi overrides that can visually reorder a
 * rendered line.
 */
function flattenLine(value: unknown, maxChars = NAME_MAX_CHARS): string {
  if (typeof value !== 'string') return '';
  let line = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  while (/^[#\-*+>]+(\s|$)/.test(line)) {
    line = line.replace(/^[#\-*+>]+\s*/, '').trim();
  }
  return line.slice(0, maxChars);
}

/**
 * Section titles/keys whose NAME would shadow a leak tripwire, lowercased once
 * at module load. Same hazard `sweepFindings.ts` documents for a finding's
 * `evidence` keys: every leak assertion in this repo reads
 * `expect(JSON.stringify(dto)).not.toContain('"toolOutput"')`, so a section
 * literally titled `toolOutput` does not merely leak — it turns a red suite
 * green. A narrative section's title is server-attached today, but the STORED
 * outcome is jsonb read back with no compile-time shape, so the projection
 * refuses one rather than trusting the writer.
 */
const SHADOWED_SECTION_NAMES: ReadonlySet<string> = new Set(
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS.map((key) => key.toLowerCase()),
);

const KNOWN_SECTION_KEYS: ReadonlySet<string> = new Set(NARRATIVE_SECTION_KEYS);

/** Bounded, flattened, tripwire-free sections — used for BOTH the stored
 *  snapshot and the run-detail projection so the two can never disagree about
 *  what a section says. */
function safeSections(value: unknown): NarrativeSection[] {
  if (!Array.isArray(value)) return [];
  const out: NarrativeSection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const section = raw as Record<string, unknown>;
    const key = typeof section.key === 'string' ? section.key : '';
    const title = flattenLine(section.title);
    if (SHADOWED_SECTION_NAMES.has(key.toLowerCase())) continue;
    if (SHADOWED_SECTION_NAMES.has(title.toLowerCase())) continue;
    if (!KNOWN_SECTION_KEYS.has(key)) continue;
    const bullets = Array.isArray(section.bullets)
      ? section.bullets.map((bullet) => flattenLine(bullet, 1000)).filter((bullet) => bullet.length > 0)
      : [];
    out.push({ key: key as NarrativeSectionKey, title, bullets });
  }
  return out;
}

/**
 * PRECONDITION: must not be called from inside an ambient REQUEST context (see
 * `inSystemDbContext` above). `finalizeNarrative` satisfies this — it runs from
 * the background run loop, which holds no ambient context of its own.
 *
 * Throws `NarrativePersistConflictError` when the run is no longer this
 * narrative's owner; any other throw is a genuine failure the caller reports as
 * `narrative_persist_failed`. Either way the enclosing transaction rolls back,
 * so a failed call leaves NO definition, NO artifact and NO link.
 */
export async function persistNarrativeReport(
  input: NarrativePersistInput,
): Promise<{ reportId: string; reportRunId: string; downloadPath: string }> {
  const { run, agent, context, outcome } = input;

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
      throw new NarrativePersistConflictError('run row is not visible for narrative persistence');
    }
    if (locked.status !== 'running') {
      throw new NarrativePersistConflictError(`run left \`running\` (status ${locked.status})`);
    }
    if (locked.reportRunId !== null) {
      throw new NarrativePersistConflictError('run already carries a narrative artifact');
    }

    const scopeValues = persistedSystemSiteScopeValues(systemReportAuthority(run.orgId));

    // 2. Find-or-create the definition. `ON CONFLICT DO NOTHING` against the
    //    PARTIAL unique index `reports_source_ai_agent_schedule_uniq`
    //    (org_id, source_ai_agent_schedule_id) WHERE source_ai_agent_schedule_id
    //    IS NOT NULL — the predicate is not optional: without it Postgres
    //    cannot infer the partial index and raises 42P10 instead of doing
    //    nothing. The read-back that follows returns the WINNER, whether that
    //    is our row or a concurrent writer's.
    await db
      .insert(reports)
      .values({
        orgId: run.orgId,
        name: NARRATIVE_REPORT_NAME,
        type: NARRATIVE_REPORT_TYPE,
        // Config is provenance, not parameters: nothing generates this report
        // from its config (`reportGenerationService` refuses the type
        // outright — the artifact is stored, never regenerated).
        config: { source: 'ai_agent', agentId: agent.id, scheduleId: run.scheduleId },
        schedule: 'weekly',
        format: 'pdf',
        // No acting user anywhere in this path. The shape CHECK
        // (`reports_execution_scope_shape_chk`) admits a NULL
        // execution_scope_user_id only when principal_kind = 'system'.
        createdBy: null,
        sourceAiAgentScheduleId: run.scheduleId,
        ...scopeValues,
      })
      .onConflictDoNothing({
        target: [reports.orgId, reports.sourceAiAgentScheduleId],
        // `where` on a DO NOTHING is the conflict-TARGET predicate — drizzle
        // renders `on conflict (org_id,source_ai_agent_schedule_id) where …
        // do nothing` (there is no `targetWhere` on this config; that field
        // belongs to DO UPDATE). It has to match the partial index's own
        // predicate exactly or Postgres cannot infer the index.
        where: isNotNull(reports.sourceAiAgentScheduleId),
      });

    const [definition] = await db
      .select({ id: reports.id })
      .from(reports)
      .where(and(
        eq(reports.orgId, run.orgId),
        eq(reports.sourceAiAgentScheduleId, run.scheduleId),
      ))
      .limit(1);
    if (!definition) {
      // Not a conflict: the upsert either inserted our row or lost to a
      // concurrent one, and BOTH leave a readable winner. Reaching here means
      // something else deleted it inside our transaction's snapshot, which is
      // a real failure the caller should log as such.
      throw new Error('narrative report definition disappeared after upsert');
    }

    // 3. The artifact. `rows: []` / `rowCount: 0` because a narrative has no
    //    tabular body at all — the whole document is `summary.narrative`.
    const generatedAt = new Date();
    const sections = safeSections(outcome.sections);
    const headline = flattenLine(outcome.headline, 400);
    const summary: OrgNarrativeReportSummary = {
      narrative: {
        version: outcome.version,
        headline,
        sections,
        // RE-DERIVED, never copied off the outcome: `renderNarrativeMarkdown`
        // owns the cap and the line-boundary truncation, and a hand-built or
        // legacy outcome can carry a `markdown` that respects neither.
        markdown: renderNarrativeMarkdown(headline, sections),
        orgName: flattenLine(context.org?.name),
        partnerName: flattenLine(context.org?.partnerName),
        periodStart: context.period?.start ?? undefined,
        periodEnd: context.period?.end ?? undefined,
        generatedAt: generatedAt.toISOString(),
        runId: run.id,
        agentName: flattenLine(agent.name),
        contextTruncated: context.truncated === true,
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
        ...scopeValues,
      })
      .returning({ id: reportRuns.id });
    if (!artifact) throw new Error('narrative report run insert returned no row');

    const downloadPath = `/api/reports/runs/${artifact.id}/download`;
    // The download URL embeds the artifact's own id, which only exists after
    // the INSERT — hence a second statement rather than a value on the first.
    await db
      .update(reportRuns)
      .set({ outputUrl: downloadPath })
      .where(eq(reportRuns.id, artifact.id));

    // 4. Stamp the definition so `/reports` sorts and renders it like any
    //    other. Org-pinned even though the id is unique: the system context
    //    bypasses RLS, so the pin is the only tenancy check on this statement.
    await db
      .update(reports)
      .set({ lastGeneratedAt: generatedAt, updatedAt: generatedAt })
      .where(and(eq(reports.id, definition.id), eq(reports.orgId, run.orgId)));

    // 5. The commit gate. `report_run_id IS NULL` makes this a compare-and-set:
    //    zero rows means somebody else linked an artifact (or moved the run)
    //    while we held the lock, and the throw rolls back everything above.
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
      throw new NarrativePersistConflictError(
        'run could not be linked to the narrative artifact (report_run_id was already set)',
      );
    }

    return { reportId: definition.id, reportRunId: artifact.id, downloadPath };
  });
}

/**
 * Safe projection of a narrative run's outcome for `GET /ai/agents/runs/:runId`.
 *
 * Carries the STRUCTURED sections and not the derived markdown (the run-detail
 * view renders sections itself; shipping both doubles the payload for no
 * reader — see `AiAgentRunNarrativeDto`'s own docstring). Every string is
 * flattened and every tripwire-named section dropped, for the reason
 * `SHADOWED_SECTION_NAMES` documents.
 *
 * `report` is the linked `report_runs`/`reports` pair the route loaded, or
 * `null` when the run carries no artifact (never materialised, or the artifact
 * was since deleted — the FK is `ON DELETE SET NULL`, so run history survives).
 */
export function projectNarrative(
  run: { reportRunId: string | null },
  outcome: { narrative?: NarrativeOutcome },
  report: {
    reportId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    contextTruncated: boolean;
  } | null,
): AiAgentRunNarrativeDto | null {
  const narrative = outcome.narrative;
  if (!narrative) return null;

  return {
    headline: flattenLine(narrative.headline, 400),
    sections: safeSections(narrative.sections),
    reportRunId: run.reportRunId,
    reportId: report?.reportId ?? null,
    downloadPath: run.reportRunId ? `/api/reports/runs/${run.reportRunId}/download` : null,
    periodStart: report?.periodStart ?? null,
    periodEnd: report?.periodEnd ?? null,
    contextTruncated: report?.contextTruncated ?? false,
  };
}

/**
 * The narrative snapshot fields the run-detail route needs off a linked
 * `report_runs` row, projected out of the stored jsonb by Postgres so the route
 * never pulls the whole `result` document (which carries the full markdown)
 * across the wire just to read three scalars.
 */
export const narrativeArtifactProjection = {
  reportRunId: reportRuns.id,
  reportId: reportRuns.reportId,
  periodStart: sql<string | null>`${reportRuns.result}->'summary'->'narrative'->>'periodStart'`,
  periodEnd: sql<string | null>`${reportRuns.result}->'summary'->'narrative'->>'periodEnd'`,
  contextTruncated: sql<boolean | null>`(${reportRuns.result}->'summary'->'narrative'->>'contextTruncated')::boolean`,
};
