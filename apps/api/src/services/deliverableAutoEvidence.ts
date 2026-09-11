/**
 * Auto-evidence for service deliverables (#5573 spec D12, §5.3 step 3).
 *
 * A deliverable with `auto_evidence_report_id` gets a run of that report on
 * its due date, attached as `report_run` evidence, plus an internal ticket
 * note. The technician reviews a report Breeze already made instead of
 * assembling one; the occurrence itself does not move — resolving the ticket
 * (or an explicit deliver) is still the act of delivery.
 *
 * AUTHORITY: ReportExecutionAuthority has no 'system' arm by design
 * (siteScope.ts — widening it would let user-path callers forge human
 * provenance). So this reproduces reportScheduleWorker.ts's reauthorization
 * sequence: refuse a non-user-principal definition, decode its persisted
 * scope, re-resolve the owner's LIVE scope, intersect, preflight. The run row
 * is then stamped `requested_by_kind = 'system'` with both requester ids NULL
 * (what report_runs_requested_by_shape_chk's system arm requires), while
 * `execution_scope_*` records whose scope actually ran. The two column
 * families answer different questions: who could see the data, and who asked.
 */
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { reports, reportRuns } from '../db/schema/reports';
import { serviceDeliverableEvidence, serviceDeliverableOccurrences } from '../db/schema/serviceDeliverables';
import { ticketComments } from '../db/schema/portal';
import { generateReport, assertReportExecutionPreflight } from './reportGenerationService';
import { captureException } from './sentry';
import {
  decodeSiteScope, intersectSiteScopes, persistedSiteScopeValues, resolveLiveReportAuthority,
  siteScopeFingerprint, type PersistedSiteScopeColumns, type ReportExecutionAuthority,
} from './siteScope';
import type { SweepDeliverable } from './serviceDeliverableService';

export const AUTO_EVIDENCE_TICKET_NOTE = 'Report attached, review and resolve';

export type AutoEvidenceRefusal =
  | 'already_attached' | 'not_due' | 'definition_not_found'
  | 'system_principal_definition' | 'portal_user_principal_definition'
  | 'scope_unverifiable' | 'scope_no_intersection' | 'scope_empty' | 'generation_failed';

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
        }), 'deliverableSweep.autoEvidence'));
      if (res.ok) generated++;
      else if (res.reason !== 'not_due' && res.reason !== 'already_attached') {
        // Never silent: a refused or failed generation leaves the occurrence
        // untouched and the technician delivers manually.
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

/** System caller — run inside withSystemDbAccessContext. */
export async function generateAutoEvidenceForOccurrence(args: {
  orgId: string; occurrenceId: string; ticketId: string | null; reportId: string; dueAt: string; today: string;
}): Promise<AutoEvidenceOutcome> {
  if (args.today < args.dueAt) return refused('not_due');

  // Once per occurrence, ever (spec §5.3 step 3).
  const existing = await db.select({ id: serviceDeliverableEvidence.id })
    .from(serviceDeliverableEvidence)
    .where(and(eq(serviceDeliverableEvidence.occurrenceId, args.occurrenceId), eq(serviceDeliverableEvidence.kind, 'report_run')))
    .limit(1);
  if (existing.length > 0) return refused('already_attached');

  const [definition] = await db.select().from(reports)
    .where(and(eq(reports.id, args.reportId), eq(reports.orgId, args.orgId))).limit(1);
  if (!definition) return refused('definition_not_found');

  // Refused BEFORE any scope decode or authority resolution can invent a principal.
  const principal = definition.executionScopePrincipalKind ?? null;
  if (principal === 'system') return refused('system_principal_definition');
  if (principal === 'portal_user') return refused('portal_user_principal_definition');
  if (!definition.executionScopeUserId) return refused('scope_unverifiable');

  let persistedScope;
  try { persistedScope = decodeSiteScope(definition as unknown as PersistedSiteScopeColumns, definition.orgId); }
  catch { return refused('scope_unverifiable'); }
  if (persistedScope.kind === 'legacy_unscoped') return refused('scope_unverifiable');

  const live = await resolveLiveReportAuthority(definition.executionScopeUserId, definition.orgId, 'read')
    .catch(() => ({ ok: false as const, reason: 'unverifiable_scope' as const }));
  if (!live.ok || live.authority.scope.kind === 'legacy_unscoped') return refused('scope_unverifiable');

  const effectiveScope = intersectSiteScopes(persistedScope, live.authority.scope);
  if (!effectiveScope) return refused('scope_no_intersection');
  if (effectiveScope.kind === 'legacy_unscoped') return refused('scope_unverifiable');
  if (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0) return refused('scope_empty');

  const authority: ReportExecutionAuthority = {
    principalKind: 'user', scope: effectiveScope,
    principalUserId: live.authority.principalUserId, capturedAt: live.authority.capturedAt,
    fingerprint: siteScopeFingerprint(effectiveScope),
  };
  const config = (definition.config ?? {}) as Record<string, unknown>;
  try { assertReportExecutionPreflight(definition.orgId, config, authority, definition.type); }
  catch { return refused('scope_unverifiable'); }

  const [run] = await db.insert(reportRuns).values({
      reportId: definition.id, status: 'running', startedAt: new Date(),
      // The sweep requested this run; no human did.
      requestedByKind: 'system', requestedByUserId: null, requestedByPortalUserId: null,
      ...persistedSiteScopeValues(authority),
    }).returning({ id: reportRuns.id });
  if (!run) return refused('generation_failed');

  let result;
  try {
    // Savepoint: a Postgres error inside the generator must not poison this
    // occurrence's transaction, or the failed-run stamp below could not run.
    result = await db.transaction(() => generateReport(definition.type, definition.orgId, config, authority));
  } catch (err) {
    await db.update(reportRuns).set({
        status: 'failed', completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : 'Failed to generate report',
      })
      .where(eq(reportRuns.id, run.id));
    return refused('generation_failed');
  }

  const rowsOut = Array.isArray(result.rows) ? result.rows : [];
  await db.update(reportRuns).set({
      status: 'completed', completedAt: new Date(),
      outputUrl: `/api/reports/runs/${run.id}/download`,
      result, rowCount: result.rowCount ?? rowsOut.length,
    }).where(eq(reportRuns.id, run.id));

  await db.insert(serviceDeliverableEvidence).values({
      orgId: args.orgId, occurrenceId: args.occurrenceId, kind: 'report_run',
      // report_id proves org ownership: report_runs has no org_id of its own,
      // so the composite FK (report_id, org_id) -> reports(id, org_id) is what
      // keeps a foreign run out.
      reportId: definition.id, reportRunId: run.id, createdByUserId: null,
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
  return { ok: true, reportRunId: run.id };
}
