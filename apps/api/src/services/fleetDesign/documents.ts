/**
 * Fleet Design → org documents hand-off (Fleet Designer W05, #5655; spec
 * §4.4 "when org_documents ships").
 *
 * Renders the stored Fleet Design report server-side through the SAME shared
 * PDF renderer the web download uses, files it in the org's document library
 * under category `baseline`, and — when the org has a deliverable that is
 * meant to carry it — attaches it as `document` evidence on that
 * deliverable's open occurrence.
 *
 * Which deliverable: one whose `auto_evidence_report_id` is the org's Fleet
 * Design report definition (the explicit link a technician sets on the
 * deliverable form), else an active deliverable named for a configuration
 * audit (the "quarterly configuration audit" the deliverables spec
 * describes). The sweep's own auto-evidence path refuses the Fleet Design
 * definition by design (system principal), so this is the only route by
 * which a Fleet Design reaches a deliverable.
 *
 * Idempotent per report run: the document's `original_filename` is derived
 * from the report run id, and a second filing of the same run returns the
 * existing document instead of uploading a twin, and re-attempts the evidence
 * link (the two writes are not atomic, so a failure between them must not
 * strand the linkage). The check is a read, not a constraint —
 * `org_documents` has no unique index on `(org_id, original_filename)` and
 * must not grow one, since ordinary uploads legitimately share filenames.
 * Two genuinely simultaneous filings of the same run can therefore both
 * upload; the outcome is a duplicate library row a technician can delete,
 * never a duplicate evidence link (that check is by document id). A scheduled
 * design run files itself (`finalizeFleetDesign`); a manual run is filed by
 * the technician from the Fleet Design page.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { buildReportPdf } from '@breeze/shared/reportPdf';
import { db } from '../../db';
import { orgDocuments } from '../../db/schema/orgDocuments';
import { serviceDeliverableEvidence, serviceDeliverableOccurrences, serviceDeliverables } from '../../db/schema/serviceDeliverables';
import { loadFleetDesignReport } from '../aiAgents/fleetDesignReport';
import { uploadDocument } from '../orgDocumentService';
import { addEvidence, DeliverableServiceError, type DeliverableActor } from '../serviceDeliverableService';

export interface FileFleetDesignDocumentInput {
  orgId: string;
  reportRunId: string;
  actor: DeliverableActor;
  /** IANA zone for the "Generated" line on the PDF; the org's timezone when known. */
  timezone?: string;
  /**
   * Whether the caller may also attach the filed document as deliverable
   * evidence — `addEvidence` can transition an occurrence to `delivered`, a
   * contract-adjacent state change that `routes/serviceDeliverables.ts` gates
   * on `contracts:write`. A `documents:write`-only technician still files the
   * document; the linkage is simply skipped rather than becoming a side door.
   * The scheduled path passes true (system actor).
   */
  linkDeliverableEvidence?: boolean;
}

export interface FileFleetDesignDocumentResult {
  documentId: string;
  /** True when this run had already been filed and no new document was created. */
  alreadyFiled: boolean;
  /** The deliverable occurrence the document was attached to, if any. */
  evidence: { deliverableId: string; occurrenceId: string } | null;
}

export function fleetDesignDocumentFilename(reportRunId: string): string {
  return `fleet-design-${reportRunId}.pdf`;
}

export function fleetDesignDocumentTitle(orgName: string | undefined, generatedAt: string | null | undefined): string {
  const day = (generatedAt ?? new Date().toISOString()).slice(0, 10);
  const org = (orgName ?? '').trim();
  return org ? `Fleet Design — ${org} — ${day}` : `Fleet Design — ${day}`;
}

async function findFiledDocument(orgId: string, reportRunId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: orgDocuments.id })
    .from(orgDocuments)
    .where(and(
      eq(orgDocuments.orgId, orgId),
      eq(orgDocuments.originalFilename, fleetDesignDocumentFilename(reportRunId)),
      isNull(orgDocuments.deletedAt),
    ))
    .limit(1);
  return row?.id ?? null;
}

/** The deliverable meant to carry Fleet Designs for this org, linked one first. */
async function findFleetDesignDeliverable(orgId: string, reportId: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: serviceDeliverables.id, autoEvidenceReportId: serviceDeliverables.autoEvidenceReportId, name: serviceDeliverables.name })
    .from(serviceDeliverables)
    .where(and(
      eq(serviceDeliverables.orgId, orgId),
      eq(serviceDeliverables.active, true),
      or(eq(serviceDeliverables.autoEvidenceReportId, reportId), sql`${serviceDeliverables.name} ILIKE '%configuration audit%'`),
    ))
    .orderBy(desc(serviceDeliverables.createdAt))
    .limit(20);
  const linked = rows.find((r) => r.autoEvidenceReportId === reportId);
  const chosen = linked ?? rows[0];
  return chosen ? { id: chosen.id } : null;
}

async function findOpenOccurrence(orgId: string, deliverableId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: serviceDeliverableOccurrences.id })
    .from(serviceDeliverableOccurrences)
    .where(and(
      eq(serviceDeliverableOccurrences.orgId, orgId),
      eq(serviceDeliverableOccurrences.deliverableId, deliverableId),
      inArray(serviceDeliverableOccurrences.status, ['open', 'awaiting_evidence']),
    ))
    .orderBy(desc(serviceDeliverableOccurrences.dueAt))
    .limit(1);
  return row?.id ?? null;
}

/** Whether this document is already evidence on this occurrence (a re-file must not attach a twin). */
async function evidenceAlreadyLinked(orgId: string, occurrenceId: string, documentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: serviceDeliverableEvidence.id })
    .from(serviceDeliverableEvidence)
    .where(and(
      eq(serviceDeliverableEvidence.orgId, orgId),
      eq(serviceDeliverableEvidence.occurrenceId, occurrenceId),
      eq(serviceDeliverableEvidence.documentId, documentId),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * Attach the filed document to the deliverable that should carry it. Runs on
 * EVERY call, including one that found the document already filed: the upload
 * and the evidence link are two writes, and a failure between them used to
 * strand the linkage forever (the next call short-circuited on the document's
 * existence and never retried it).
 */
async function linkEvidence(
  orgId: string, reportId: string, documentId: string, actor: DeliverableActor,
): Promise<{ deliverableId: string; occurrenceId: string } | null> {
  const deliverable = await findFleetDesignDeliverable(orgId, reportId);
  if (!deliverable) return null;
  const occurrenceId = await findOpenOccurrence(orgId, deliverable.id);
  if (!occurrenceId) return null;
  if (!(await evidenceAlreadyLinked(orgId, occurrenceId, documentId))) {
    await addEvidence(orgId, occurrenceId, { kind: 'document', documentId }, actor);
  }
  return { deliverableId: deliverable.id, occurrenceId };
}

export async function fileFleetDesignDocument(input: FileFleetDesignDocumentInput): Promise<FileFleetDesignDocumentResult> {
  const { orgId, reportRunId, actor } = input;
  const report = await loadFleetDesignReport(reportRunId, (col) => eq(col, orgId));
  if (!report) throw new DeliverableServiceError('Not found', 404, 'not_found');

  const existing = await findFiledDocument(orgId, reportRunId);
  let documentId = existing;

  if (!documentId) {
    const timezone = input.timezone ?? 'UTC';
    const generatedAt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })
      .format(report.generatedAt ? new Date(report.generatedAt) : new Date());
    const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt, timezone, summary: report.summary as never });
    const buffer = Buffer.from(doc.output('arraybuffer'));

    const uploaded = await uploadDocument(orgId, {
      title: fleetDesignDocumentTitle(report.summary.fleetDesign?.orgName, report.generatedAt),
      description: `Fleet Design report (run ${reportRunId}).`,
      category: 'baseline',
      portalVisible: false,
      file: { buffer, contentType: 'application/pdf', filename: fleetDesignDocumentFilename(reportRunId) },
    }, actor);
    documentId = uploaded.id;
  }

  const evidence = input.linkDeliverableEvidence === false
    ? null
    : await linkEvidence(orgId, report.reportId, documentId, actor);
  return { documentId, alreadyFiled: existing !== null, evidence };
}
