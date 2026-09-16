import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { reportRuns } from '../db/schema/reports';
import {
  serviceDeliverableEvidence,
  serviceDeliverableOccurrences,
} from '../db/schema/serviceDeliverables';
import type { ReportResult } from './reportGenerationService';

/**
 * The baseline a service-plan evidence run compares against (#5784, OD-11 = A):
 * the run attached to the immediately-preceding occurrence OF THE SAME
 * DELIVERABLE.
 *
 * NOT `previousBaselineFor` (reportGenerationService.ts): that keys on
 * (report_id, execution_scope_fingerprint) and orders by completed_at. Because
 * §5.1 gives an org ONE shared managed definition per type, a monthly and a
 * quarterly deliverable on that definition share a report id AND — both running
 * org-wide under system authority — share a fingerprint, so it would hand each
 * of them the other's run. A deliverable has exactly one cadence, so keying on
 * deliverable_id and stepping back one occurrence is the correct comparator.
 *
 * Failures are swallowed to `undefined`: a missing comparator degrades the
 * artifact's "changes since last period" section to "no prior period", which the
 * renderers handle; it must never fail the evidence run itself.
 */
export async function previousOccurrenceBaselineFor(args: {
  deliverableId: string;
  currentPeriodStart: string;
}): Promise<ReportResult['previous']> {
  try {
    const [prior] = await db
      .select({
        summary: sql<Record<string, unknown> | null>`${reportRuns.result}->'summary'`,
        generatedAt: sql<string | null>`${reportRuns.result}->>'generatedAt'`,
        completedAt: reportRuns.completedAt,
      })
      .from(serviceDeliverableOccurrences)
      .innerJoin(
        serviceDeliverableEvidence,
        eq(serviceDeliverableEvidence.occurrenceId, serviceDeliverableOccurrences.id),
      )
      .innerJoin(reportRuns, eq(reportRuns.id, serviceDeliverableEvidence.reportRunId))
      .where(and(
        eq(serviceDeliverableOccurrences.deliverableId, args.deliverableId),
        lt(serviceDeliverableOccurrences.periodStart, args.currentPeriodStart),
        eq(serviceDeliverableEvidence.kind, 'report_run'),
        eq(reportRuns.status, 'completed'),
      ))
      // The prior OCCURRENCE, not the most recently completed run: a late
      // re-generation of an older period must not become the baseline.
      .orderBy(desc(serviceDeliverableOccurrences.periodStart), desc(reportRuns.completedAt))
      .limit(1);

    if (!prior?.summary || typeof prior.summary !== 'object') return undefined;
    return {
      generatedAt: prior.generatedAt ?? prior.completedAt?.toISOString() ?? null,
      summary: prior.summary,
    };
  } catch (err) {
    console.error('[deliverables] prior-occurrence baseline lookup failed', { deliverableId: args.deliverableId }, err);
    return undefined;
  }
}
