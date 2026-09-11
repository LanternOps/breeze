import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type {
  PortalArtifactState,
  PortalDeliverableCadence,
  PortalDeliverableDto,
  PortalEvidenceRef,
  PortalKeyDateDto,
  PortalOccurrenceDto,
  PortalOccurrenceStatus,
  PortalOccurrencesDto,
  PortalServiceGroupDto,
  PortalServiceOverviewDto,
  ServiceTileDto,
} from '@breeze/shared';
import { db } from '../../db';
import {
  contracts,
  organizationKeyDates,
  orgDocuments,
  portalBranding,
  reports,
  serviceDeliverableEvidence,
  serviceDeliverableOccurrences,
  serviceDeliverables,
} from '../../db/schema';
import { summarizeStatus } from '../serviceDeliverableService';
import type { OccurrenceStatus } from '../serviceDeliverableState';

/**
 * Customer-portal Service scorecard read model (spec #5573 §8, decision D10).
 *
 * Every query here runs inside the portal session's own org-scoped RLS
 * transaction (`portalAuthMiddleware`, scope: 'organization'). There is no
 * system escalation anywhere in this module — the explicit `org_id` predicates
 * are defence in depth on top of `breeze_has_org_access(org_id)`, and they are
 * what the SQL-predicate unit tests assert.
 *
 * The publication rules live HERE, not in the routes:
 *  1. Nothing in any payload names, links or identifies a ticket.
 *  2. Document evidence publishes when the document is portal-visible and not
 *     soft-deleted — regardless of `enable_documents`, which governs the
 *     library page only.
 *  3. Report-run evidence publishes only when `enable_reports` is on AND the
 *     report definition is `portal_self_service`.
 *  4. A delivered occurrence with a required artifact and no publishable
 *     evidence reports `held_by_msp`. Nothing pretends evidence exists.
 */

/** The calendar date `now` falls on in `timezone`, as `YYYY-MM-DD`. */
export function isoDateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function artifactStateFor(args: {
  artifactRequired: boolean; delivered: boolean; evidence: readonly PortalEvidenceRef[];
}): PortalArtifactState {
  if (args.evidence.some((e) => e.kind === 'document')) return 'attached';
  if (args.evidence.some((e) => e.kind === 'report_run')) return 'report';
  return args.delivered && args.artifactRequired ? 'held_by_msp' : 'none';
}

const OCCURRENCE_STATUS: Record<string, PortalOccurrenceStatus> = {
  scheduled: 'scheduled',
  open: 'in_progress',
  // Deliberate: `awaiting_evidence` is the MSP's internal workflow state, not a
  // fact about the customer's service (spec D10).
  awaiting_evidence: 'in_progress',
  delivered: 'delivered',
  missed: 'missed',
  waived: 'waived',
};

export function portalOccurrenceStatus(dbStatus: string): PortalOccurrenceStatus {
  return OCCURRENCE_STATUS[dbStatus] ?? 'in_progress';
}

/** Occurrence states that are still ahead of the customer (not terminal). */
const LIVE_STATUSES: readonly OccurrenceStatus[] = ['scheduled', 'open', 'awaiting_evidence'];

interface EvidenceJoinRow {
  occurrenceId: string;
  kind: string;
  documentId: string | null;
  documentTitle: string | null;
  documentPortalVisible: boolean | null;
  documentDeletedAt: Date | null;
  reportRunId: string | null;
  reportName: string | null;
  reportPortalSelfService: boolean | null;
  createdAt: Date;
}

/** Rules 2 and 3 of the publication contract, applied to one evidence row. */
function publishableEvidence(row: EvidenceJoinRow, enableReports: boolean): PortalEvidenceRef | null {
  if (row.kind === 'document') {
    if (row.documentPortalVisible !== true || row.documentDeletedAt != null) return null;
    return {
      kind: 'document',
      documentId: row.documentId,
      reportRunId: null,
      title: row.documentTitle ?? 'Document',
      createdAt: row.createdAt.toISOString(),
    };
  }
  if (!enableReports || row.reportPortalSelfService !== true) return null;
  return {
    kind: 'report_run',
    documentId: null,
    reportRunId: row.reportRunId,
    title: row.reportName ?? 'Report',
    createdAt: row.createdAt.toISOString(),
  };
}

async function enableReportsFor(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ enableReports: portalBranding.enableReports })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);
  return row?.enableReports === true;
}

function evidenceQuery(orgId: string, occurrenceIds: string[]) {
  return db
    .select({
      occurrenceId: serviceDeliverableEvidence.occurrenceId,
      kind: serviceDeliverableEvidence.kind,
      documentId: serviceDeliverableEvidence.documentId,
      documentTitle: orgDocuments.title,
      documentPortalVisible: orgDocuments.portalVisible,
      documentDeletedAt: orgDocuments.deletedAt,
      reportRunId: serviceDeliverableEvidence.reportRunId,
      reportName: reports.name,
      reportPortalSelfService: reports.portalSelfService,
      createdAt: serviceDeliverableEvidence.createdAt,
    })
    .from(serviceDeliverableEvidence)
    .leftJoin(orgDocuments, and(
      eq(orgDocuments.id, serviceDeliverableEvidence.documentId),
      eq(orgDocuments.orgId, serviceDeliverableEvidence.orgId),
    ))
    .leftJoin(reports, and(
      eq(reports.id, serviceDeliverableEvidence.reportId),
      eq(reports.orgId, serviceDeliverableEvidence.orgId),
    ))
    .where(and(
      eq(serviceDeliverableEvidence.orgId, orgId),
      inArray(serviceDeliverableEvidence.occurrenceId, occurrenceIds),
    ))
    .orderBy(asc(serviceDeliverableEvidence.createdAt)) as unknown as Promise<EvidenceJoinRow[]>;
}

function groupEvidence(
  rows: EvidenceJoinRow[],
  enableReports: boolean,
): Map<string, PortalEvidenceRef[]> {
  const byOccurrence = new Map<string, PortalEvidenceRef[]>();
  for (const row of rows) {
    const ref = publishableEvidence(row, enableReports);
    if (!ref) continue;
    const list = byOccurrence.get(row.occurrenceId) ?? [];
    list.push(ref);
    byOccurrence.set(row.occurrenceId, list);
  }
  return byOccurrence;
}

interface OccurrenceRow {
  id: string;
  deliverableId: string;
  status: string;
  dueAt: string;
  originalDueAt: string;
  periodStart: string;
  periodEnd: string;
  deliveredAt: Date | null;
  deliveryNote: string | null;
}

function isLate(deliveredAt: Date | null, dueAt: string, timezone: string): boolean {
  return deliveredAt != null && isoDateInTimezone(deliveredAt, timezone) > dueAt;
}

export async function serviceOverview(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<PortalServiceOverviewDto> {
  const today = isoDateInTimezone(args.now, args.timezone);
  const enableReports = await enableReportsFor(orgId);

  const deliverableRows = await db
    .select({
      id: serviceDeliverables.id,
      name: serviceDeliverables.name,
      description: serviceDeliverables.description,
      cadence: serviceDeliverables.cadence,
      artifactRequired: serviceDeliverables.artifactRequired,
      leadDays: serviceDeliverables.leadDays,
      effectiveFrom: serviceDeliverables.effectiveFrom,
      effectiveUntil: serviceDeliverables.effectiveUntil,
      active: serviceDeliverables.active,
      contractId: serviceDeliverables.contractId,
      contractName: contracts.name,
    })
    .from(serviceDeliverables)
    .leftJoin(contracts, and(
      eq(contracts.id, serviceDeliverables.contractId),
      eq(contracts.orgId, serviceDeliverables.orgId),
    ))
    .where(and(
      eq(serviceDeliverables.orgId, orgId),
      eq(serviceDeliverables.portalVisible, true),
      eq(serviceDeliverables.active, true),
      lte(serviceDeliverables.effectiveFrom, today),
      or(
        isNull(serviceDeliverables.effectiveUntil),
        gte(serviceDeliverables.effectiveUntil, today),
      ),
    ))
    .orderBy(asc(serviceDeliverables.sortOrder), asc(serviceDeliverables.name)) as unknown as Array<{
      id: string; name: string; description: string | null;
      cadence: PortalDeliverableCadence; artifactRequired: boolean; leadDays: number;
      effectiveFrom: string; effectiveUntil: string | null; active: boolean;
      contractId: string | null; contractName: string | null;
    }>;

  const deliverableIds = deliverableRows.map((d) => d.id);
  const occurrenceRows: OccurrenceRow[] = deliverableIds.length === 0 ? [] : await db
    .select({
      id: serviceDeliverableOccurrences.id,
      deliverableId: serviceDeliverableOccurrences.deliverableId,
      status: serviceDeliverableOccurrences.status,
      dueAt: serviceDeliverableOccurrences.dueAt,
      originalDueAt: serviceDeliverableOccurrences.originalDueAt,
      periodStart: serviceDeliverableOccurrences.periodStart,
      periodEnd: serviceDeliverableOccurrences.periodEnd,
      deliveredAt: serviceDeliverableOccurrences.deliveredAt,
      deliveryNote: serviceDeliverableOccurrences.deliveryNote,
    })
    .from(serviceDeliverableOccurrences)
    .where(and(
      eq(serviceDeliverableOccurrences.orgId, orgId),
      inArray(serviceDeliverableOccurrences.deliverableId, deliverableIds),
    ))
    .orderBy(desc(serviceDeliverableOccurrences.dueAt)) as unknown as OccurrenceRow[];

  const byDeliverable = new Map<string, OccurrenceRow[]>();
  for (const row of occurrenceRows) {
    const list = byDeliverable.get(row.deliverableId) ?? [];
    list.push(row);
    byDeliverable.set(row.deliverableId, list);
  }

  // Only the occurrence the page actually renders needs its evidence read.
  const lastDeliveredByDeliverable = new Map<string, OccurrenceRow>();
  for (const [deliverableId, rows] of byDeliverable) {
    const delivered = rows
      .filter((o) => o.status === 'delivered' && o.deliveredAt != null)
      .sort((a, b) => b.deliveredAt!.getTime() - a.deliveredAt!.getTime());
    if (delivered[0]) lastDeliveredByDeliverable.set(deliverableId, delivered[0]);
  }
  const evidenceOccurrenceIds = [...lastDeliveredByDeliverable.values()].map((o) => o.id);
  const evidenceByOccurrence = evidenceOccurrenceIds.length === 0
    ? new Map<string, PortalEvidenceRef[]>()
    : groupEvidence(await evidenceQuery(orgId, evidenceOccurrenceIds), enableReports);

  const keyDateRows = await db
    .select({
      id: organizationKeyDates.id,
      label: organizationKeyDates.label,
      kind: organizationKeyDates.kind,
      date: organizationKeyDates.date,
      notes: organizationKeyDates.notes,
    })
    .from(organizationKeyDates)
    .where(and(
      eq(organizationKeyDates.orgId, orgId),
      eq(organizationKeyDates.portalVisible, true),
      gte(organizationKeyDates.date, today),
    ))
    .orderBy(asc(organizationKeyDates.date))
    .limit(20) as unknown as Array<{
      id: string; label: string; kind: string; date: string; notes: string | null;
    }>;

  const contractEndRows = await db
    .select({ id: contracts.id, name: contracts.name, endDate: contracts.endDate })
    .from(contracts)
    .where(and(
      eq(contracts.orgId, orgId),
      sql`${contracts.endDate} IS NOT NULL`,
      gte(contracts.endDate, today),
      notInArray(contracts.status, ['draft', 'cancelled']),
    ))
    .orderBy(asc(contracts.endDate)) as unknown as Array<{
      id: string; name: string; endDate: string;
    }>;

  const deliverables: Array<{ contractId: string | null; contractName: string | null; dto: PortalDeliverableDto }> = [];
  for (const d of deliverableRows) {
    const occ = byDeliverable.get(d.id) ?? [];
    const rollup = summarizeStatus(
      { active: d.active, effectiveFrom: d.effectiveFrom, effectiveUntil: d.effectiveUntil, leadDays: d.leadDays },
      occ.map((o) => ({ status: o.status as OccurrenceStatus, dueAt: o.dueAt })),
      today,
    );
    // 'inactive' means the deliverable's own predicate drifted, not a customer
    // state — drop the row rather than invent a fifth customer-facing word.
    if (rollup === 'inactive') continue;

    const last = lastDeliveredByDeliverable.get(d.id) ?? null;
    const evidence = last ? evidenceByOccurrence.get(last.id) ?? [] : [];
    const nextDue = occ
      .filter((o) => LIVE_STATUSES.includes(o.status as OccurrenceStatus) && o.dueAt >= today)
      .reduce<string | null>((min, o) => (min === null || o.dueAt < min ? o.dueAt : min), null);

    deliverables.push({
      contractId: d.contractId,
      contractName: d.contractName,
      dto: {
        id: d.id,
        name: d.name,
        description: d.description,
        cadence: d.cadence,
        artifactRequired: d.artifactRequired,
        lastDelivered: last === null ? null : {
          at: last.deliveredAt!.toISOString(),
          late: isLate(last.deliveredAt, last.dueAt, args.timezone),
          note: last.deliveryNote,
          artifactState: artifactStateFor({
            artifactRequired: d.artifactRequired,
            delivered: true,
            evidence,
          }),
          evidence,
        },
        nextDue,
        status: rollup,
      },
    });
  }

  const contractGroups = new Map<string, PortalServiceGroupDto>();
  const standalone: PortalDeliverableDto[] = [];
  for (const entry of deliverables) {
    if (entry.contractId === null) {
      standalone.push(entry.dto);
      continue;
    }
    const group = contractGroups.get(entry.contractId) ?? {
      source: 'contract' as const,
      contract: { id: entry.contractId, name: entry.contractName ?? 'Agreement' },
      deliverables: [],
    };
    group.deliverables.push(entry.dto);
    contractGroups.set(entry.contractId, group);
  }

  const groups: PortalServiceGroupDto[] = [...contractGroups.values()]
    .sort((a, b) => (a.contract?.name ?? '').localeCompare(b.contract?.name ?? ''));
  if (standalone.length > 0) {
    groups.push({ source: 'standalone', contract: null, deliverables: standalone });
  }

  const keyDates: PortalKeyDateDto[] = [
    ...keyDateRows.map((k) => ({
      source: 'key_date' as const,
      id: k.id,
      label: k.label,
      kind: k.kind,
      date: k.date,
      notes: k.notes,
    })),
    ...contractEndRows.map((c) => ({
      source: 'contract_end' as const,
      id: c.id,
      label: c.name,
      kind: 'contract_end',
      date: c.endDate,
      notes: null,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return {
    asOf: args.now.toISOString(),
    timezone: args.timezone,
    groups,
    keyDates,
  };
}

/** Spec §8: the last 24 occurrences. The cap is enforced here, never trusted
 *  from the query string. `null` = no portal-visible deliverable with that id
 *  in this org; the route turns that into a bare 404 (404-not-403). */
export async function deliverableOccurrences(
  orgId: string,
  deliverableId: string,
  args: { timezone: string; now: Date; limit?: number },
): Promise<PortalOccurrencesDto | null> {
  const [deliverable] = await db
    .select({
      id: serviceDeliverables.id,
      name: serviceDeliverables.name,
      cadence: serviceDeliverables.cadence,
      artifactRequired: serviceDeliverables.artifactRequired,
    })
    .from(serviceDeliverables)
    .where(and(
      eq(serviceDeliverables.orgId, orgId),
      eq(serviceDeliverables.id, deliverableId),
      eq(serviceDeliverables.portalVisible, true),
    ))
    .limit(1) as unknown as Array<{
      id: string; name: string; cadence: PortalDeliverableCadence; artifactRequired: boolean;
    }>;
  if (!deliverable) return null;

  const limit = Math.min(args.limit ?? 24, 24);
  const rows = await db
    .select({
      id: serviceDeliverableOccurrences.id,
      nameSnapshot: serviceDeliverableOccurrences.nameSnapshot,
      status: serviceDeliverableOccurrences.status,
      dueAt: serviceDeliverableOccurrences.dueAt,
      originalDueAt: serviceDeliverableOccurrences.originalDueAt,
      periodStart: serviceDeliverableOccurrences.periodStart,
      periodEnd: serviceDeliverableOccurrences.periodEnd,
      deliveredAt: serviceDeliverableOccurrences.deliveredAt,
      deliveryNote: serviceDeliverableOccurrences.deliveryNote,
    })
    .from(serviceDeliverableOccurrences)
    .where(and(
      eq(serviceDeliverableOccurrences.orgId, orgId),
      eq(serviceDeliverableOccurrences.deliverableId, deliverable.id),
    ))
    .orderBy(desc(serviceDeliverableOccurrences.dueAt))
    .limit(limit) as unknown as Array<OccurrenceRow & { nameSnapshot: string }>;

  const evidenceByOccurrence = rows.length === 0
    ? new Map<string, PortalEvidenceRef[]>()
    : groupEvidence(
        await evidenceQuery(orgId, rows.map((r) => r.id)),
        await enableReportsFor(orgId),
      );

  const occurrences: PortalOccurrenceDto[] = rows.map((row) => {
    const evidence = evidenceByOccurrence.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.nameSnapshot,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      dueAt: row.dueAt,
      rescheduled: row.dueAt !== row.originalDueAt,
      status: portalOccurrenceStatus(row.status),
      deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
      late: isLate(row.deliveredAt, row.dueAt, args.timezone),
      note: row.deliveryNote,
      artifactState: artifactStateFor({
        artifactRequired: deliverable.artifactRequired,
        delivered: row.status === 'delivered',
        evidence,
      }),
      evidence,
    };
  });

  return {
    asOf: args.now.toISOString(),
    timezone: args.timezone,
    deliverable: { id: deliverable.id, name: deliverable.name, cadence: deliverable.cadence },
    occurrences,
  };
}

/** Dashboard tile. `null` = `enable_service` is off (or no branding row), in
 *  which case `dashboardForOrg` omits the key entirely. */
export async function serviceTile(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<ServiceTileDto | null> {
  const [branding] = await db
    .select({ enableService: portalBranding.enableService })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);
  if (branding?.enableService !== true) return null;

  const today = isoDateInTimezone(args.now, args.timezone);
  const windowStart = isoDateInTimezone(
    new Date(args.now.getTime() - 90 * 24 * 60 * 60 * 1000),
    args.timezone,
  );

  const [counts] = await db
    .select({
      onTime: sql<number>`count(*) FILTER (WHERE ${serviceDeliverableOccurrences.status} = 'delivered' AND ${serviceDeliverableOccurrences.deliveredAt}::date <= ${serviceDeliverableOccurrences.dueAt})::int`,
      late: sql<number>`count(*) FILTER (WHERE ${serviceDeliverableOccurrences.status} = 'delivered' AND ${serviceDeliverableOccurrences.deliveredAt}::date > ${serviceDeliverableOccurrences.dueAt})::int`,
      missed: sql<number>`count(*) FILTER (WHERE ${serviceDeliverableOccurrences.status} = 'missed')::int`,
    })
    .from(serviceDeliverableOccurrences)
    .innerJoin(serviceDeliverables, and(
      eq(serviceDeliverables.id, serviceDeliverableOccurrences.deliverableId),
      eq(serviceDeliverables.orgId, serviceDeliverableOccurrences.orgId),
    ))
    .where(and(
      eq(serviceDeliverableOccurrences.orgId, orgId),
      eq(serviceDeliverables.portalVisible, true),
      gte(serviceDeliverableOccurrences.dueAt, windowStart),
    )) as unknown as Array<{ onTime: number; late: number; missed: number }>;

  const [next] = await db
    .select({
      name: serviceDeliverableOccurrences.nameSnapshot,
      dueAt: serviceDeliverableOccurrences.dueAt,
    })
    .from(serviceDeliverableOccurrences)
    .innerJoin(serviceDeliverables, and(
      eq(serviceDeliverables.id, serviceDeliverableOccurrences.deliverableId),
      eq(serviceDeliverables.orgId, serviceDeliverableOccurrences.orgId),
    ))
    .where(and(
      eq(serviceDeliverableOccurrences.orgId, orgId),
      eq(serviceDeliverables.portalVisible, true),
      inArray(serviceDeliverableOccurrences.status, [...LIVE_STATUSES]),
      gte(serviceDeliverableOccurrences.dueAt, today),
    ))
    .orderBy(asc(serviceDeliverableOccurrences.dueAt))
    .limit(1) as unknown as Array<{ name: string; dueAt: string }>;

  const onTime = Number(counts?.onTime ?? 0);
  const late = Number(counts?.late ?? 0);
  const missed = Number(counts?.missed ?? 0);
  const nextDue = next ? { name: next.name, dueAt: next.dueAt } : null;
  const hasRecord = onTime + late + missed > 0 || nextDue !== null;

  // Never a fabricated zero: an org with nothing scheduled reports no_data and
  // null values, matching the TileStatus contract.
  if (!hasRecord) {
    return {
      status: 'no_data',
      windowDays: 90,
      deliveredOnTime: null,
      deliveredLate: null,
      missed: null,
      nextDue: null,
      asOf: args.now.toISOString(),
    };
  }

  return {
    status: 'ok',
    windowDays: 90,
    deliveredOnTime: onTime,
    deliveredLate: late,
    missed,
    nextDue,
    asOf: args.now.toISOString(),
  };
}
