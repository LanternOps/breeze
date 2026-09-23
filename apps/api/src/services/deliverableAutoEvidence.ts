/**
 * Auto-evidence for service deliverables (#5573 spec D12, §5.3 step 3;
 * #5784 W01 managed evidence, OD-5 = B / OD-11 = A).
 *
 * A deliverable with `auto_evidence_report_id` gets a run of that report on
 * its due date, attached as `report_run` evidence, plus an internal ticket
 * note. The technician reviews a report Breeze already made instead of
 * assembling one; the occurrence itself does not move — resolving the ticket
 * (or an explicit deliver) is still the act of delivery.
 *
 * TWO EXECUTION PATHS, chosen by the definition:
 *
 *  - MANAGED (#5784): the org's managed evidence definition — a type the closed
 *    `MANAGED_EVIDENCE_REGISTRY` names AND `portal_self_service = true` — runs
 *    through `generateManagedEvidenceReport` under a `SystemReportExecutionAuthority`
 *    that is org-wide by construction. An org-owned recurring obligation must
 *    not stop producing evidence because one technician changed jobs.
 *  - USER (#5573, unchanged): everything else reproduces
 *    reportScheduleWorker.ts's reauthorization sequence — refuse a
 *    non-user-principal definition, decode its persisted scope, re-resolve the
 *    owner's LIVE scope, intersect, preflight. `ReportExecutionAuthority` has no
 *    'system' arm by design (siteScope.ts); the managed path is a second,
 *    explicitly typed entry point, not a widening of this one.
 *
 * In both paths the run row is stamped `requested_by_kind = 'system'` with both
 * requester ids NULL (what report_runs_requested_by_shape_chk's system arm
 * requires), while `execution_scope_*` records whose scope actually ran. The
 * two column families answer different questions: who could see the data, and
 * who asked.
 *
 * PERIOD AND BASELINE (OD-11 = A): the occurrence's own period is passed into
 * generation and the comparator is the prior occurrence OF THE SAME DELIVERABLE
 * (`previousOccurrenceBaselineFor`), never "the last completed run of this
 * report" — one shared managed definition per type would otherwise make a
 * monthly and a quarterly deliverable compare each other's runs.
 *
 * VISIBLE REFUSALS: a refusal other than `not_due` / `already_attached` is
 * recorded on the occurrence (`auto_evidence_attempted_at`,
 * `auto_evidence_refusal`) and posted ONCE per distinct reason as an internal
 * ticket comment — the persisted reason is the de-duplication key, so a
 * nightly sweep does not spam the ticket.
 */
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { reports, reportRuns } from '../db/schema/reports';
import { serviceDeliverableEvidence, serviceDeliverableOccurrences } from '../db/schema/serviceDeliverables';
import { ticketComments } from '../db/schema/portal';
import {
  assertReportExecutionPreflight,
  generateManagedEvidenceReport,
  generateReport,
  type EvidenceRunContext,
  type ReportResult,
} from './reportGenerationService';
import { previousOccurrenceBaselineFor } from './evidenceBaseline';
import { isManagedEvidenceType, type ManagedEvidenceType } from './managedEvidenceRegistry';
import { captureException } from './sentry';
import {
  decodeSiteScope, intersectSiteScopes, persistedSiteScopeValues, persistedSystemSiteScopeValues,
  resolveLiveReportAuthority, siteScopeFingerprint, systemReportAuthorityFor,
  type PersistedSiteScopeColumns, type ReportExecutionAuthority,
} from './siteScope';
import type { SweepDeliverable } from './serviceDeliverableService';

export const AUTO_EVIDENCE_TICKET_NOTE = 'Report attached, review and resolve';

export type AutoEvidenceRefusal =
  | 'already_attached' | 'not_due' | 'definition_not_found'
  | 'system_principal_definition' | 'portal_user_principal_definition'
  | 'scope_unverifiable' | 'scope_no_intersection' | 'scope_empty' | 'generation_failed';

/**
 * What the technician reads on the ticket when the nightly sweep could not build
 * the evidence. One comment per DISTINCT reason, never one per sweep — the
 * occurrence's `auto_evidence_refusal` column is the de-duplication key. `null`
 * marks the quiet reasons that write no state at all.
 */
export const AUTO_EVIDENCE_REFUSAL_NOTES: Record<AutoEvidenceRefusal, string | null> = {
  not_due: null,
  already_attached: null,
  definition_not_found: 'Automatic evidence could not be generated: the report definition this deliverable points at no longer exists. Re-link it on the deliverable, or attach the artifact by hand.',
  system_principal_definition: 'Automatic evidence could not be generated: the linked report definition is system-owned and cannot be run on a technician’s behalf. Link a managed evidence report type instead.',
  portal_user_principal_definition: 'Automatic evidence could not be generated: the linked report definition belongs to a customer portal user. Link a staff-owned or managed evidence report instead.',
  scope_unverifiable: 'Automatic evidence could not be generated: the report definition’s owner no longer has access to this organization. Re-save the report definition under a current owner, or link a managed evidence report type.',
  scope_no_intersection: 'Automatic evidence could not be generated: the report definition is limited to sites the current owner cannot see. Widen the definition’s sites or re-save it under an owner with access.',
  scope_empty: 'Automatic evidence could not be generated: the report definition resolves to zero sites. Widen its site selection.',
  generation_failed: 'Automatic evidence could not be generated: the report run failed. Open the report definition and run it by hand to see the error.',
};

export type AutoEvidenceOutcome =
  | { ok: true; reportRunId: string }
  | { ok: false; reason: AutoEvidenceRefusal };

const refused = (reason: AutoEvidenceRefusal): AutoEvidenceOutcome => ({ ok: false, reason });

/**
 * Every `open` occurrence of this deliverable that is due and has no run yet.
 * Self-wrapping: one system transaction per occurrence, so one failure rolls
 * back that occurrence's run + evidence + note together.
 */
export async function generateAutoEvidenceForDeliverable(d: SweepDeliverable, today: string): Promise<number> {
  const reportId = d.autoEvidenceReportId;
  if (!reportId) return 0;
  const open = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
        id: serviceDeliverableOccurrences.id, ticketId: serviceDeliverableOccurrences.ticketId,
        dueAt: serviceDeliverableOccurrences.dueAt,
        // #5784 OD-11: the occurrence's OWN window is the only correct one.
        periodStart: serviceDeliverableOccurrences.periodStart,
        periodEnd: serviceDeliverableOccurrences.periodEnd,
        // #5784: last refusal, so a repeated identical refusal does not re-comment.
        lastRefusal: serviceDeliverableOccurrences.autoEvidenceRefusal,
      })
      .from(serviceDeliverableOccurrences)
      .where(and(eq(serviceDeliverableOccurrences.deliverableId, d.id), eq(serviceDeliverableOccurrences.status, 'open'))),
    'deliverableSweep.selectAutoEvidence'));

  let generated = 0;
  for (const occ of open) {
    if (today < occ.dueAt) continue;   // cheap pre-filter; the per-occurrence check is authoritative
    try {
      const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        generateAutoEvidenceForOccurrence({
          orgId: d.orgId, occurrenceId: occ.id, ticketId: occ.ticketId,
          reportId, dueAt: occ.dueAt, today,
          deliverableId: d.id, periodStart: occ.periodStart, periodEnd: occ.periodEnd,
          lastRefusal: occ.lastRefusal,
        }), 'deliverableSweep.autoEvidence'));
      if (res.ok) generated++;
      else if (res.reason !== 'not_due' && res.reason !== 'already_attached') {
        // Never silent: a refused or failed generation leaves the occurrence
        // untouched and the technician delivers manually. The persisted state
        // and ticket comment serve a different reader than this log line.
        console.warn('[deliverables] auto-evidence skipped', `occurrenceId=${occ.id}`, `reportId=${reportId}`, `reason=${res.reason}`);
      }
    } catch (err) {
      // Per occurrence, so one unrecoverable failure does not cost this
      // deliverable's other occurrences their evidence — or the sweep steps
      // that follow it.
      console.error('[deliverables] auto-evidence failed', `orgId=${d.orgId}`, `occurrenceId=${occ.id}`,
        `reportId=${reportId}`, err instanceof Error ? err.message : String(err));
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return generated;
}

export interface AutoEvidenceOccurrenceArgs {
  orgId: string;
  occurrenceId: string;
  ticketId: string | null;
  reportId: string;
  dueAt: string;
  today: string;
  /** #5784 OD-11: the baseline selector's key. */
  deliverableId: string;
  /** Occurrence period, ISO dates, inclusive. */
  periodStart: string;
  periodEnd: string;
  /** The occurrence's persisted `auto_evidence_refusal` — de-duplicates the ticket comment. */
  lastRefusal: string | null;
}

/** System caller — run inside withSystemDbAccessContext. */
export async function generateAutoEvidenceForOccurrence(args: AutoEvidenceOccurrenceArgs): Promise<AutoEvidenceOutcome> {
  if (args.today < args.dueAt) return refused('not_due');

  // Once per occurrence, ever (spec §5.3 step 3).
  const existing = await db.select({ id: serviceDeliverableEvidence.id })
    .from(serviceDeliverableEvidence)
    .where(and(eq(serviceDeliverableEvidence.occurrenceId, args.occurrenceId), eq(serviceDeliverableEvidence.kind, 'report_run')))
    .limit(1);
  if (existing.length > 0) return refused('already_attached');

  /**
   * Refusals that reach here are real: write the queryable state, and post the
   * internal ticket comment only when the reason CHANGED (including from NULL,
   * i.e. the first refusal). `not_due` / `already_attached` never get here.
   */
  const recordRefusal = async (reason: AutoEvidenceRefusal): Promise<AutoEvidenceOutcome> => {
    await db.update(serviceDeliverableOccurrences)
      .set({ autoEvidenceAttemptedAt: new Date(), autoEvidenceRefusal: reason })
      .where(eq(serviceDeliverableOccurrences.id, args.occurrenceId));
    const note = AUTO_EVIDENCE_REFUSAL_NOTES[reason];
    if (note && reason !== args.lastRefusal && args.ticketId) {
      await db.insert(ticketComments).values({
        ticketId: args.ticketId, userId: null, authorName: 'Breeze', authorType: 'system',
        commentType: 'internal', content: note, isPublic: false,
        originPrincipalKind: 'system',
      });
    }
    return refused(reason);
  };

  const [definition] = await db.select().from(reports)
    .where(and(eq(reports.id, args.reportId), eq(reports.orgId, args.orgId))).limit(1);
  if (!definition) return recordRefusal('definition_not_found');
  // #3198 W01: the WHERE above already pins this row to `reports.orgId =
  // args.orgId` (a non-null `string`), so use `args.orgId` below instead of
  // `definition.orgId`, which Drizzle still types `string | null` on the
  // nullable column. This module only ever handles org-owned deliverable
  // evidence definitions — a partner-owned row (`orgId: null`) can never
  // satisfy that WHERE clause and so never reaches here.

  const config = (definition.config ?? {}) as Record<string, unknown>;

  /** Shared completed-run + evidence-insert + note tail for both paths. */
  const finishRun = async (runId: string, result: ReportResult): Promise<AutoEvidenceOutcome> => {
    // #5784 OD-11: the comparator is the prior occurrence of THIS deliverable.
    // Both paths were missing `previous`; one call site serves both.
    const previous = await previousOccurrenceBaselineFor({
      deliverableId: args.deliverableId, currentPeriodStart: args.periodStart,
    });
    if (previous) result.previous = previous;

    // A recovered deliverable clears its refusal state.
    await db.update(serviceDeliverableOccurrences)
      .set({ autoEvidenceAttemptedAt: new Date(), autoEvidenceRefusal: null })
      .where(eq(serviceDeliverableOccurrences.id, args.occurrenceId));

    const rowsOut = Array.isArray(result.rows) ? result.rows : [];
    await db.update(reportRuns).set({
        status: 'completed', completedAt: new Date(),
        outputUrl: `/api/reports/runs/${runId}/download`,
        result, rowCount: result.rowCount ?? rowsOut.length,
      }).where(eq(reportRuns.id, runId));

    await db.insert(serviceDeliverableEvidence).values({
        orgId: args.orgId, occurrenceId: args.occurrenceId, kind: 'report_run',
        // report_id proves org ownership: report_runs has no org_id of its own,
        // so the composite FK (report_id, org_id) -> reports(id, org_id) is what
        // keeps a foreign run out.
        reportId: definition.id, reportRunId: runId, createdByUserId: null,
      }).returning({ id: serviceDeliverableEvidence.id });

    if (args.ticketId) {
      await db.insert(ticketComments).values({
        ticketId: args.ticketId, userId: null, authorName: 'Breeze', authorType: 'system',
        commentType: 'internal', content: AUTO_EVIDENCE_TICKET_NOTE, isPublic: false,
        // Not 'user': the helpdesk loop guard treats any non-user origin as
        // system-authored and never admits it as a human reply.
        originPrincipalKind: 'system',
      });
    }
    return { ok: true, reportRunId: runId };
  };

  /** Open the run row, run the generator under a savepoint, stamp failure. */
  const runGenerator = async (
    scopeValues: PersistedSiteScopeColumns,
    generate: () => Promise<ReportResult>,
  ): Promise<AutoEvidenceOutcome> => {
    const [run] = await db.insert(reportRuns).values({
        reportId: definition.id, status: 'running', startedAt: new Date(),
        // The sweep requested this run; no human did.
        requestedByKind: 'system', requestedByUserId: null, requestedByPortalUserId: null,
        ...scopeValues,
      }).returning({ id: reportRuns.id });
    if (!run) return recordRefusal('generation_failed');

    let result: ReportResult;
    try {
      // Savepoint: a Postgres error inside the generator must not poison this
      // occurrence's transaction, or the failed-run stamp below could not run.
      result = await db.transaction(() => generate());
    } catch (err) {
      // Log the generator's own failure BEFORE the bookkeeping writes: if one of
      // those throws, the whole occurrence transaction rolls back and only the
      // secondary error would otherwise reach the caller and Sentry.
      console.error('[deliverables] auto-evidence generation failed', `occurrenceId=${args.occurrenceId}`,
        `reportId=${definition.id}`, err instanceof Error ? err.message : String(err));
      const outcome = await recordRefusal('generation_failed');
      await db.update(reportRuns).set({
          status: 'failed', completedAt: new Date(),
          errorMessage: err instanceof Error ? err.message : 'Failed to generate report',
        })
        .where(eq(reportRuns.id, run.id));
      return outcome;
    }
    return finishRun(run.id, result);
  };

  // #5784 OD-5 = B. The org's managed evidence definition runs under system
  // authority; everything else keeps the shipped user path below, unchanged —
  // including its principal-kind gate. The test is DEFINITION-based (registry
  // type AND portal_self_service), never type-based: a technician's own saved
  // report of a managed type still runs as that technician.
  if (isManagedEvidenceType(definition.type) && definition.portalSelfService === true) {
    const evidence: EvidenceRunContext = {
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      generatedAt: new Date().toISOString(),
      deliverableId: args.deliverableId,
    };
    const authority = systemReportAuthorityFor(args.orgId);
    return runGenerator(
      persistedSystemSiteScopeValues(authority),
      () => generateManagedEvidenceReport(definition.type as ManagedEvidenceType, args.orgId, config, evidence),
    );
  }

  // Refused BEFORE any scope decode or authority resolution can invent a principal.
  const principal = definition.executionScopePrincipalKind ?? null;
  if (principal === 'system') return recordRefusal('system_principal_definition');
  if (principal === 'portal_user') return recordRefusal('portal_user_principal_definition');
  if (!definition.executionScopeUserId) return recordRefusal('scope_unverifiable');

  let persistedScope;
  try { persistedScope = decodeSiteScope(definition as unknown as PersistedSiteScopeColumns, args.orgId); }
  catch { return recordRefusal('scope_unverifiable'); }
  if (persistedScope.kind === 'legacy_unscoped') return recordRefusal('scope_unverifiable');

  const live = await resolveLiveReportAuthority(definition.executionScopeUserId, args.orgId, 'read')
    .catch(() => ({ ok: false as const, reason: 'unverifiable_scope' as const }));
  if (!live.ok || live.authority.scope.kind === 'legacy_unscoped') return recordRefusal('scope_unverifiable');

  const effectiveScope = intersectSiteScopes(persistedScope, live.authority.scope);
  if (!effectiveScope) return recordRefusal('scope_no_intersection');
  if (effectiveScope.kind === 'legacy_unscoped') return recordRefusal('scope_unverifiable');
  if (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0) return recordRefusal('scope_empty');

  const authority: ReportExecutionAuthority = {
    principalKind: 'user', scope: effectiveScope,
    principalUserId: live.authority.principalUserId, capturedAt: live.authority.capturedAt,
    fingerprint: siteScopeFingerprint(effectiveScope),
  };
  try { assertReportExecutionPreflight(args.orgId, config, authority, definition.type); }
  catch { return recordRefusal('scope_unverifiable'); }

  return runGenerator(
    persistedSiteScopeValues(authority),
    () => generateReport(definition.type, args.orgId, config, authority),
  );
}
