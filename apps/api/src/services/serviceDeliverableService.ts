import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  serviceDeliverables, serviceDeliverableOccurrences, serviceDeliverableEvidence,
  type ServiceDeliverableRow, type ServiceDeliverableOccurrenceRow,
} from '../db/schema/serviceDeliverables';
import { contracts } from '../db/schema/contracts';
import { organizations } from '../db/schema/orgs';
import { users } from '../db/schema/users';
import { reports, reportRuns } from '../db/schema/reports';
import { orgDocuments } from '../db/schema/orgDocuments';
import { ticketCategories } from '../db/schema/tickets';
import type {
  CreateDeliverableInput, UpdateDeliverableInput, DeliverOccurrenceInput, WaiveOccurrenceInput,
  RescheduleOccurrenceInput, EvidenceRef,
} from '@breeze/shared';
import { transition, InvalidTransitionError, type OccurrenceStatus } from './serviceDeliverableState';
import { isInLeadWindow, isPastGrace } from './recurrence';
import { isPgUniqueViolation } from '../utils/pgErrors';

/**
 * Spec #5573 §5–§7, §12. Every read and write filters by `orgId` in addition to
 * the row id — defence in depth on top of the shape-1 RLS policies. Foreign-org
 * access is a 404 (never 403) so nothing leaks about rows in other tenants.
 */

export interface DeliverableActor { userId: string | null; partnerId: string | null; accessibleOrgIds: string[] | null }

export class DeliverableServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) {
    super(message);
    this.name = 'DeliverableServiceError';
  }
}

export interface DeliverableSummary extends ServiceDeliverableRow {
  contractName: string | null;
  nextDue: string | null;
  lastDelivered: { at: string; late: boolean; note: string | null } | null;
  openCount: number;
  status: 'on_track' | 'due_soon' | 'late' | 'missed' | 'inactive';
}

export interface OccurrenceView extends ServiceDeliverableOccurrenceRow {
  late: boolean;
  evidence: Array<{ id: string; kind: 'document' | 'report_run'; documentId: string | null; reportId: string | null; reportRunId: string | null; createdAt: string }>;
}

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const NON_TERMINAL: readonly OccurrenceStatus[] = ['scheduled', 'open', 'awaiting_evidence', 'missed'];
const ACTIONABLE: readonly OccurrenceStatus[] = ['open', 'awaiting_evidence', 'missed'];
const RESCHEDULABLE: ReadonlySet<OccurrenceStatus> = new Set(NON_TERMINAL);
const DELIVERED_OR_NON_TERMINAL: readonly OccurrenceStatus[] = [...NON_TERMINAL, 'delivered'];

const notFound = () => new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
const todayISO = () => new Date().toISOString().slice(0, 10);
const dateOf = (ts: Date) => ts.toISOString().slice(0, 10);

function requireOrgAccess(actor: DeliverableActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) throw notFound();
}

// ---------------------------------------------------------------------------
// Summary derivation (pure)
// ---------------------------------------------------------------------------

export function summarizeStatus(
  d: { active: boolean; effectiveFrom: string; effectiveUntil: string | null; leadDays: number },
  occ: Array<{ status: OccurrenceStatus; dueAt: string }>,
  today = todayISO(),
): DeliverableSummary['status'] {
  if (!d.active || today < d.effectiveFrom || (d.effectiveUntil !== null && today > d.effectiveUntil)) return 'inactive';
  if (occ.some((o) => o.status === 'missed')) return 'missed';
  const open = occ.filter((o) => o.status === 'open' || o.status === 'awaiting_evidence');
  if (open.some((o) => o.dueAt < today)) return 'late';
  if (open.some((o) => isInLeadWindow(o.dueAt, d.leadDays, today))) return 'due_soon';
  return 'on_track';
}

type SummaryOccurrence = Pick<ServiceDeliverableOccurrenceRow, 'id' | 'deliverableId' | 'status' | 'dueAt' | 'deliveredAt' | 'deliveryNote'>;

function buildSummary(row: ServiceDeliverableRow, contractName: string | null, occ: SummaryOccurrence[], today: string): DeliverableSummary {
  const live = occ.filter((o) => NON_TERMINAL.includes(o.status));
  const nextDue = live.reduce<string | null>((min, o) => (min === null || o.dueAt < min ? o.dueAt : min), null);
  const delivered = occ.filter((o): o is SummaryOccurrence & { deliveredAt: Date } => o.status === 'delivered' && o.deliveredAt !== null);
  const last = delivered.reduce<(SummaryOccurrence & { deliveredAt: Date }) | null>(
    (best, o) => (best === null || o.deliveredAt.getTime() > best.deliveredAt.getTime() ? o : best), null);
  return {
    ...row,
    contractName,
    nextDue,
    lastDelivered: last === null ? null : { at: last.deliveredAt.toISOString(), late: dateOf(last.deliveredAt) > last.dueAt, note: last.deliveryNote },
    openCount: occ.filter((o) => ACTIONABLE.includes(o.status)).length,
    status: summarizeStatus(row, live, today),
  };
}

async function loadSummaries(orgId: string, filters: { id?: string; contractId?: string; includeInactive?: boolean }): Promise<DeliverableSummary[]> {
  const conditions = [eq(serviceDeliverables.orgId, orgId)];
  if (filters.id !== undefined) conditions.push(eq(serviceDeliverables.id, filters.id));
  if (filters.contractId !== undefined) conditions.push(eq(serviceDeliverables.contractId, filters.contractId));
  if (!filters.includeInactive) conditions.push(eq(serviceDeliverables.active, true));
  const rows = await db
    .select({ deliverable: serviceDeliverables, contractName: contracts.name })
    .from(serviceDeliverables)
    .leftJoin(contracts, and(eq(contracts.id, serviceDeliverables.contractId), eq(contracts.orgId, serviceDeliverables.orgId)))
    .where(and(...conditions))
    .orderBy(asc(serviceDeliverables.sortOrder), asc(serviceDeliverables.name));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.deliverable.id);
  const occ = await db
    .select({
      id: serviceDeliverableOccurrences.id, deliverableId: serviceDeliverableOccurrences.deliverableId,
      status: serviceDeliverableOccurrences.status, dueAt: serviceDeliverableOccurrences.dueAt,
      deliveredAt: serviceDeliverableOccurrences.deliveredAt, deliveryNote: serviceDeliverableOccurrences.deliveryNote,
    })
    .from(serviceDeliverableOccurrences)
    .where(and(
      eq(serviceDeliverableOccurrences.orgId, orgId),
      inArray(serviceDeliverableOccurrences.deliverableId, ids),
      inArray(serviceDeliverableOccurrences.status, DELIVERED_OR_NON_TERMINAL),
    ));
  const byDeliverable = new Map<string, SummaryOccurrence[]>();
  for (const o of occ) {
    const list = byDeliverable.get(o.deliverableId) ?? [];
    list.push(o);
    byDeliverable.set(o.deliverableId, list);
  }
  const today = todayISO();
  return rows.map((r) => buildSummary(r.deliverable, r.contractName, byDeliverable.get(r.deliverable.id) ?? [], today));
}

// ---------------------------------------------------------------------------
// Reference validation (create / update)
// ---------------------------------------------------------------------------

type RefInput = Pick<UpdateDeliverableInput, 'contractId' | 'ownerUserId' | 'ticketCategoryId' | 'autoEvidenceReportId'>;

/** Only keys PRESENT on the input are validated, so a PATCH that omits a
 *  reference never re-validates it (and a null clears it without a lookup). */
async function validateReferences(orgId: string, input: RefInput): Promise<void> {
  if (input.contractId != null) {
    const [c] = await db.select({ id: contracts.id }).from(contracts)
      .where(and(eq(contracts.id, input.contractId), eq(contracts.orgId, orgId))).limit(1);
    if (!c) throw new DeliverableServiceError('Contract does not belong to this organization', 400, 'CONTRACT_NOT_IN_ORG');
  }
  if (input.ownerUserId != null || input.ticketCategoryId != null) {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
      .where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw notFound();
    if (input.ownerUserId != null) {
      const [u] = await db.select({ id: users.id }).from(users)
        .where(and(eq(users.id, input.ownerUserId), eq(users.partnerId, org.partnerId))).limit(1);
      if (!u) throw new DeliverableServiceError('Owner must be a user of the organization\'s partner', 400, 'OWNER_NOT_ALLOWED');
    }
    if (input.ticketCategoryId != null) {
      const [cat] = await db.select({ id: ticketCategories.id }).from(ticketCategories)
        .where(and(eq(ticketCategories.id, input.ticketCategoryId), eq(ticketCategories.partnerId, org.partnerId))).limit(1);
      if (!cat) throw new DeliverableServiceError('Ticket category must belong to the organization\'s partner', 400, 'CATEGORY_NOT_ALLOWED');
    }
  }
  if (input.autoEvidenceReportId != null) {
    const [r] = await db.select({ id: reports.id }).from(reports)
      .where(and(eq(reports.id, input.autoEvidenceReportId), eq(reports.orgId, orgId))).limit(1);
    if (!r) throw notFound();
  }
}

const duplicateName = () =>
  new DeliverableServiceError('A deliverable with this name already exists for this contract', 409, 'DUPLICATE_NAME');

/**
 * Pre-check `service_deliverables_org_contract_name_uq` as the PRIMARY path: a
 * raised 23505 aborts whatever transaction it fires in, and if that were the
 * request's own withDbAccessContext transaction postgres.js would re-throw it at
 * commit even after we caught it, turning the mapped 409 into a raw 500 (same
 * lesson as ticketConfigService / catalogService). `mapUniqueViolation` is only
 * the concurrent-writer backstop (two requests passing the pre-check together),
 * and it is reachable ONLY because the write runs in its own nested
 * `db.transaction` — a savepoint under the request transaction — so the index
 * error rolls back the savepoint alone and the outer transaction stays usable
 * for the 409 response.
 */
async function assertNameAvailable(orgId: string, contractId: string | null, name: string, excludeId?: string): Promise<void> {
  const conditions = [
    eq(serviceDeliverables.orgId, orgId),
    eq(serviceDeliverables.name, name),
    contractId === null ? isNull(serviceDeliverables.contractId) : eq(serviceDeliverables.contractId, contractId),
  ];
  if (excludeId) conditions.push(ne(serviceDeliverables.id, excludeId));
  const [dup] = await db.select({ one: sql<number>`1` }).from(serviceDeliverables).where(and(...conditions)).limit(1);
  if (dup) throw duplicateName();
}

function mapUniqueViolation(err: unknown): never {
  if (isPgUniqueViolation(err)) throw duplicateName();
  throw err;
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

export async function listDeliverables(
  orgId: string, q: { contractId?: string; includeInactive?: boolean }, actor: DeliverableActor,
): Promise<DeliverableSummary[]> {
  requireOrgAccess(actor, orgId);
  return loadSummaries(orgId, q);
}

export async function getDeliverable(orgId: string, id: string, actor: DeliverableActor): Promise<DeliverableSummary> {
  requireOrgAccess(actor, orgId);
  const [summary] = await loadSummaries(orgId, { id, includeInactive: true });
  if (!summary) throw notFound();
  return summary;
}

/** Re-reads a just-written deliverable as the same summary shape the list and
 *  get endpoints return, so the web table can splice a create/PATCH response
 *  straight in without losing status / nextDue / contractName. includeInactive
 *  so a PATCH that just deactivated the row still resolves. */
async function loadWrittenSummary(orgId: string, id: string): Promise<DeliverableSummary> {
  const [summary] = await loadSummaries(orgId, { id, includeInactive: true });
  if (!summary) throw new DeliverableServiceError('Deliverable vanished after write', 500, 'RELOAD_FAILED');
  return summary;
}

export async function createDeliverable(orgId: string, input: CreateDeliverableInput, actor: DeliverableActor): Promise<DeliverableSummary> {
  requireOrgAccess(actor, orgId);
  await validateReferences(orgId, input);
  await assertNameAvailable(orgId, input.contractId ?? null, input.name);
  let row: ServiceDeliverableRow | undefined;
  try {
    // Savepoint: see assertNameAvailable — keeps a 23505 from poisoning the request transaction.
    [row] = await db.transaction(async (tx) => tx.insert(serviceDeliverables).values({
      orgId,
      contractId: input.contractId ?? null,
      name: input.name,
      description: input.description ?? null,
      cadence: input.cadence,
      anchorDueDate: input.anchorDueDate,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil ?? null,
      leadDays: input.leadDays,
      graceDays: input.graceDays,
      artifactRequired: input.artifactRequired,
      completionMode: input.completionMode,
      autoEvidenceReportId: input.autoEvidenceReportId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      ticketCategoryId: input.ticketCategoryId ?? null,
      portalVisible: input.portalVisible,
      sortOrder: input.sortOrder,
      createdBy: actor.userId,
    }).returning());
  } catch (err) {
    mapUniqueViolation(err);
  }
  if (!row) throw new DeliverableServiceError('Insert returned no row', 500, 'INSERT_FAILED');
  return loadWrittenSummary(orgId, row.id);
}

export async function updateDeliverable(orgId: string, id: string, patch: UpdateDeliverableInput, actor: DeliverableActor): Promise<DeliverableSummary> {
  requireOrgAccess(actor, orgId);
  const [existing] = await db.select({ id: serviceDeliverables.id, name: serviceDeliverables.name, contractId: serviceDeliverables.contractId })
    .from(serviceDeliverables)
    .where(and(eq(serviceDeliverables.id, id), eq(serviceDeliverables.orgId, orgId))).limit(1);
  if (!existing) throw notFound();
  await validateReferences(orgId, patch);
  if (patch.name !== undefined || patch.contractId !== undefined) {
    await assertNameAvailable(
      orgId,
      patch.contractId === undefined ? existing.contractId : (patch.contractId ?? null),
      patch.name ?? existing.name,
      id,
    );
  }
  let row: { id: string } | undefined;
  try {
    // Savepoint: see assertNameAvailable — keeps a 23505 from poisoning the request transaction.
    [row] = await db.transaction(async (tx) => tx.update(serviceDeliverables)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(serviceDeliverables.id, id), eq(serviceDeliverables.orgId, orgId)))
      .returning({ id: serviceDeliverables.id }));
  } catch (err) {
    mapUniqueViolation(err);
  }
  if (!row) throw notFound();
  return loadWrittenSummary(orgId, row.id);
}

export async function deactivateDeliverable(orgId: string, id: string, actor: DeliverableActor): Promise<void> {
  requireOrgAccess(actor, orgId);
  const [row] = await db.update(serviceDeliverables)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(serviceDeliverables.id, id), eq(serviceDeliverables.orgId, orgId)))
    .returning({ id: serviceDeliverables.id });
  if (!row) throw notFound();
}

// ---------------------------------------------------------------------------
// Occurrence loading
// ---------------------------------------------------------------------------

type LoadedOccurrence = ServiceDeliverableOccurrenceRow & {
  artifactRequired: boolean;
  completionMode: 'explicit' | 'on_ticket_resolve';
  graceDays: number;
  leadDays: number;
};

const occurrenceWithDeliverable = {
  ...getTableColumns(serviceDeliverableOccurrences),
  artifactRequired: serviceDeliverables.artifactRequired,
  completionMode: serviceDeliverables.completionMode,
  graceDays: serviceDeliverables.graceDays,
  leadDays: serviceDeliverables.leadDays,
};

async function loadOccurrence(orgId: string, occurrenceId: string, executor: DbExecutor): Promise<LoadedOccurrence> {
  const [row] = await executor
    .select(occurrenceWithDeliverable)
    .from(serviceDeliverableOccurrences)
    .innerJoin(serviceDeliverables, and(
      eq(serviceDeliverables.id, serviceDeliverableOccurrences.deliverableId),
      eq(serviceDeliverables.orgId, serviceDeliverableOccurrences.orgId),
    ))
    .where(and(eq(serviceDeliverableOccurrences.id, occurrenceId), eq(serviceDeliverableOccurrences.orgId, orgId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

function isLate(o: Pick<ServiceDeliverableOccurrenceRow, 'status' | 'dueAt' | 'deliveredAt'>, today: string): boolean {
  if (o.status === 'delivered') return o.deliveredAt !== null && dateOf(o.deliveredAt) > o.dueAt;
  if (o.status === 'waived') return false;
  return today > o.dueAt;
}

type EvidenceListRow = Pick<typeof serviceDeliverableEvidence.$inferSelect, 'id' | 'occurrenceId' | 'kind' | 'documentId' | 'reportId' | 'reportRunId' | 'createdAt'>;

const evidenceColumns = {
  id: serviceDeliverableEvidence.id, occurrenceId: serviceDeliverableEvidence.occurrenceId, kind: serviceDeliverableEvidence.kind,
  documentId: serviceDeliverableEvidence.documentId, reportId: serviceDeliverableEvidence.reportId,
  reportRunId: serviceDeliverableEvidence.reportRunId, createdAt: serviceDeliverableEvidence.createdAt,
};

function toEvidenceView(e: EvidenceListRow): OccurrenceView['evidence'][number] {
  return { id: e.id, kind: e.kind, documentId: e.documentId, reportId: e.reportId, reportRunId: e.reportRunId, createdAt: e.createdAt.toISOString() };
}

function toView(loaded: LoadedOccurrence, evidence: EvidenceListRow[], today: string): OccurrenceView {
  const { artifactRequired: _a, completionMode: _c, graceDays: _g, leadDays: _l, ...row } = loaded;
  return { ...row, late: isLate(row, today), evidence: evidence.map(toEvidenceView) };
}

async function loadView(orgId: string, occurrenceId: string, executor: DbExecutor): Promise<OccurrenceView> {
  const loaded = await loadOccurrence(orgId, occurrenceId, executor);
  const evidence = await executor.select(evidenceColumns).from(serviceDeliverableEvidence)
    .where(and(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId), eq(serviceDeliverableEvidence.orgId, orgId)))
    .orderBy(asc(serviceDeliverableEvidence.createdAt));
  return toView(loaded, evidence, todayISO());
}

async function countEvidence(orgId: string, occurrenceId: string, executor: DbExecutor): Promise<number> {
  const [row] = await executor.select({ n: count() }).from(serviceDeliverableEvidence)
    .where(and(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId), eq(serviceDeliverableEvidence.orgId, orgId)));
  return Number(row?.n ?? 0);
}

/** Resolves the reference against the org (404 on a foreign or missing target)
 *  and inserts the evidence row. Never trusts the caller's ids alone. */
async function insertEvidenceRef(orgId: string, occurrenceId: string, ref: EvidenceRef, actor: DeliverableActor, executor: DbExecutor): Promise<void> {
  switch (ref.kind) {
    case 'report_run': {
      const [run] = await executor.select({ id: reportRuns.id, reportId: reportRuns.reportId })
        .from(reportRuns)
        .innerJoin(reports, eq(reports.id, reportRuns.reportId))
        .where(and(eq(reportRuns.id, ref.reportRunId), eq(reports.orgId, orgId)))
        .limit(1);
      if (!run) throw notFound();
      await executor.insert(serviceDeliverableEvidence).values({
        orgId, occurrenceId, kind: 'report_run', documentId: null, reportId: run.reportId, reportRunId: run.id, createdByUserId: actor.userId,
      });
      return;
    }
    case 'document': {
      // 404 not 403 (spec §12): a document of another org — or a soft-deleted
      // one — must be indistinguishable from one that does not exist. The
      // composite FK (document_id, org_id) is the DB backstop; checking here
      // gives the caller a clean 404 instead of a 23503. Evidence pins this
      // exact version: a later replace creates a new id and never moves it.
      const [doc] = await executor.select({ id: orgDocuments.id })
        .from(orgDocuments)
        .where(and(eq(orgDocuments.id, ref.documentId), eq(orgDocuments.orgId, orgId), isNull(orgDocuments.deletedAt)))
        .limit(1);
      if (!doc) throw notFound();
      await executor.insert(serviceDeliverableEvidence).values({
        orgId, occurrenceId, kind: 'document', documentId: doc.id, reportId: null, reportRunId: null, createdByUserId: actor.userId,
      });
      return;
    }
    default: {
      // Turns a forgotten branch into a compile error and a loud 500, never a
      // silent no-op.
      const _exhaustive: never = ref;
      throw new DeliverableServiceError('Unsupported evidence kind', 500, 'UNSUPPORTED_EVIDENCE_KIND');
    }
  }
}

function occurrenceKey(orgId: string, occurrenceId: string) {
  return and(eq(serviceDeliverableOccurrences.id, occurrenceId), eq(serviceDeliverableOccurrences.orgId, orgId));
}

/** Optimistic guard for a status transition: the UPDATE also matches the status
 *  the transition was computed from, so a concurrent transition (another tech,
 *  the W02 scheduler, a ticket bridge) cannot be silently overwritten — the
 *  update matches zero rows and the caller gets a 409 to reload and retry. */
async function updateOccurrenceFrom(
  tx: DbExecutor, orgId: string, occurrenceId: string, fromStatus: OccurrenceStatus,
  values: Partial<typeof serviceDeliverableOccurrences.$inferInsert>,
): Promise<void> {
  const [row] = await tx.update(serviceDeliverableOccurrences)
    .set(values)
    .where(and(occurrenceKey(orgId, occurrenceId), eq(serviceDeliverableOccurrences.status, fromStatus)))
    .returning({ id: serviceDeliverableOccurrences.id });
  if (!row) {
    throw new DeliverableServiceError(
      'The occurrence changed while this request was in flight; reload and retry', 409, 'INVALID_OCCURRENCE_TRANSITION',
    );
  }
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

export async function listOccurrences(
  orgId: string, deliverableId: string, q: { limit: number }, actor: DeliverableActor,
): Promise<OccurrenceView[]> {
  requireOrgAccess(actor, orgId);
  const [d] = await db.select({ id: serviceDeliverables.id }).from(serviceDeliverables)
    .where(and(eq(serviceDeliverables.id, deliverableId), eq(serviceDeliverables.orgId, orgId))).limit(1);
  if (!d) throw notFound();
  const rows = await db.select(occurrenceWithDeliverable)
    .from(serviceDeliverableOccurrences)
    .innerJoin(serviceDeliverables, and(
      eq(serviceDeliverables.id, serviceDeliverableOccurrences.deliverableId),
      eq(serviceDeliverables.orgId, serviceDeliverableOccurrences.orgId),
    ))
    .where(and(eq(serviceDeliverableOccurrences.deliverableId, deliverableId), eq(serviceDeliverableOccurrences.orgId, orgId)))
    .orderBy(desc(serviceDeliverableOccurrences.dueAt))
    .limit(q.limit);
  if (rows.length === 0) return [];
  const evidence = await db.select(evidenceColumns).from(serviceDeliverableEvidence)
    .where(and(eq(serviceDeliverableEvidence.orgId, orgId), inArray(serviceDeliverableEvidence.occurrenceId, rows.map((r) => r.id))))
    .orderBy(asc(serviceDeliverableEvidence.createdAt));
  const byOccurrence = new Map<string, EvidenceListRow[]>();
  for (const e of evidence) {
    const list = byOccurrence.get(e.occurrenceId) ?? [];
    list.push(e);
    byOccurrence.set(e.occurrenceId, list);
  }
  const today = todayISO();
  return rows.map((r) => toView(r, byOccurrence.get(r.id) ?? [], today));
}

export async function deliverOccurrence(
  orgId: string, occurrenceId: string, input: DeliverOccurrenceInput, actor: DeliverableActor,
): Promise<OccurrenceView> {
  requireOrgAccess(actor, orgId);
  return db.transaction(async (tx) => {
    const current = await loadOccurrence(orgId, occurrenceId, tx);
    for (const ref of input.evidence ?? []) await insertEvidenceRef(orgId, occurrenceId, ref, actor, tx);
    const hasEvidence = (await countEvidence(orgId, occurrenceId, tx)) > 0;
    let next: OccurrenceStatus;
    try {
      const t = transition(current.status, { type: 'deliver', hasEvidence, artifactRequired: current.artifactRequired });
      next = t.next ?? current.status;
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      // The state machine refuses for one of two reasons: the status cannot be
      // delivered from at all (409), or only the evidence is missing (400). Ask
      // it again with evidence present to tell the two apart without copying
      // its status table here.
      let statusAllows = true;
      try { transition(current.status, { type: 'deliver', hasEvidence: true, artifactRequired: current.artifactRequired }); } catch { statusAllows = false; }
      if (statusAllows) throw new DeliverableServiceError('This deliverable requires evidence before it can be marked delivered', 400, 'EVIDENCE_REQUIRED');
      throw new DeliverableServiceError(err.message, 409, 'INVALID_OCCURRENCE_TRANSITION');
    }
    const now = new Date();
    await updateOccurrenceFrom(tx, orgId, occurrenceId, current.status, {
      status: next, deliveredAt: now, deliveredByUserId: actor.userId, deliveredVia: 'explicit',
      deliveryNote: input.note ?? null, updatedAt: now,
    });
    return loadView(orgId, occurrenceId, tx);
  });
}

function applyTransition(current: OccurrenceStatus, event: Parameters<typeof transition>[1]): OccurrenceStatus {
  try {
    return transition(current, event).next ?? current;
  } catch (err) {
    if (err instanceof InvalidTransitionError) throw new DeliverableServiceError(err.message, 409, 'INVALID_OCCURRENCE_TRANSITION');
    throw err;
  }
}

export async function waiveOccurrence(
  orgId: string, occurrenceId: string, input: WaiveOccurrenceInput, actor: DeliverableActor,
): Promise<OccurrenceView> {
  requireOrgAccess(actor, orgId);
  const reason = input.reason.trim();
  if (reason.length === 0) throw new DeliverableServiceError('A reason is required to waive an occurrence', 400, 'REASON_REQUIRED');
  return db.transaction(async (tx) => {
    const current = await loadOccurrence(orgId, occurrenceId, tx);
    const next = applyTransition(current.status, { type: 'waive' });
    const now = new Date();
    await updateOccurrenceFrom(tx, orgId, occurrenceId, current.status,
      { status: next, waivedAt: now, waivedByUserId: actor.userId, waivedReason: reason, updatedAt: now });
    return loadView(orgId, occurrenceId, tx);
  });
}

export async function reopenOccurrence(orgId: string, occurrenceId: string, actor: DeliverableActor): Promise<OccurrenceView> {
  requireOrgAccess(actor, orgId);
  return db.transaction(async (tx) => {
    const current = await loadOccurrence(orgId, occurrenceId, tx);
    const next = applyTransition(current.status, { type: 'reopen' });
    await updateOccurrenceFrom(tx, orgId, occurrenceId, current.status, {
      status: next,
      deliveredAt: null, deliveredByUserId: null, deliveredVia: null, deliveryNote: null,
      waivedAt: null, waivedByUserId: null, waivedReason: null,
      updatedAt: new Date(),
    });
    return loadView(orgId, occurrenceId, tx);
  });
}

export async function rescheduleOccurrence(
  orgId: string, occurrenceId: string, input: RescheduleOccurrenceInput, actor: DeliverableActor,
): Promise<OccurrenceView> {
  requireOrgAccess(actor, orgId);
  return db.transaction(async (tx) => {
    const current = await loadOccurrence(orgId, occurrenceId, tx);
    if (!RESCHEDULABLE.has(current.status)) {
      throw new DeliverableServiceError(`Cannot reschedule an occurrence in status ${current.status}`, 409, 'INVALID_OCCURRENCE_TRANSITION');
    }
    // A missed occurrence pulled back inside its grace window is live again;
    // originalDueAt is never touched (spec §7: the history of the slip is kept).
    const next: OccurrenceStatus = current.status === 'missed' && !isPastGrace(input.dueAt, current.graceDays, todayISO()) ? 'open' : current.status;
    await updateOccurrenceFrom(tx, orgId, occurrenceId, current.status, { dueAt: input.dueAt, status: next, updatedAt: new Date() });
    return loadView(orgId, occurrenceId, tx);
  });
}

/** Load one occurrence by id, 404 NOT_FOUND on a foreign org or a missing row
 *  (W03: the evidence-upload route needs it before it writes a document). */
export async function getOccurrenceOr404(orgId: string, occurrenceId: string, actor: DeliverableActor): Promise<OccurrenceView> {
  requireOrgAccess(actor, orgId);
  return loadView(orgId, occurrenceId, db);
}

export async function addEvidence(orgId: string, occurrenceId: string, ref: EvidenceRef, actor: DeliverableActor): Promise<OccurrenceView> {
  requireOrgAccess(actor, orgId);
  return db.transaction(async (tx) => {
    const current = await loadOccurrence(orgId, occurrenceId, tx);
    await insertEvidenceRef(orgId, occurrenceId, ref, actor, tx);
    const t = transition(current.status, { type: 'evidence_added' });
    if (t.next !== null && t.next !== current.status) {
      // Only awaiting_evidence → delivered gets here: the ticket resolution
      // started the delivery, this evidence completes it.
      const now = new Date();
      await updateOccurrenceFrom(tx, orgId, occurrenceId, current.status, {
        status: t.next, deliveredAt: now, deliveredByUserId: actor.userId, deliveredVia: 'ticket', updatedAt: now,
      });
    }
    return loadView(orgId, occurrenceId, tx);
  });
}

export async function removeEvidence(orgId: string, occurrenceId: string, evidenceId: string, actor: DeliverableActor): Promise<OccurrenceView> {
  requireOrgAccess(actor, orgId);
  return db.transaction(async (tx) => {
    const current = await loadOccurrence(orgId, occurrenceId, tx);
    const existing = await tx.select({ id: serviceDeliverableEvidence.id }).from(serviceDeliverableEvidence)
      .where(and(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId), eq(serviceDeliverableEvidence.orgId, orgId)));
    if (!existing.some((e) => e.id === evidenceId)) throw notFound();
    if (current.status === 'delivered' && current.artifactRequired && existing.length <= 1) {
      throw new DeliverableServiceError('Removing the last evidence would leave a delivered occurrence unsupported; reopen it first', 409, 'EVIDENCE_REQUIRED');
    }
    await tx.delete(serviceDeliverableEvidence).where(and(
      eq(serviceDeliverableEvidence.id, evidenceId),
      eq(serviceDeliverableEvidence.occurrenceId, occurrenceId),
      eq(serviceDeliverableEvidence.orgId, orgId),
    ));
    return loadView(orgId, occurrenceId, tx);
  });
}

// ---------------------------------------------------------------------------
// Reserved for W02 (system callers, no actor; run inside withSystemDbAccessContext).
// Exported as stubs so W02 replaces bodies, not names.
// ---------------------------------------------------------------------------

export async function materializeOccurrences(_deliverableId: string, _today: string): Promise<ServiceDeliverableOccurrenceRow[]> {
  throw new Error('not implemented (W02)');
}
export async function openOccurrence(_occurrenceId: string, _ticketId: string | null): Promise<void> {
  throw new Error('not implemented (W02)');
}
export async function markOccurrenceMissed(_occurrenceId: string): Promise<void> {
  throw new Error('not implemented (W02)');
}
export async function applyTicketStatusChange(_args: {
  ticketId: string; orgId: string; to: string; actorUserId: string | null; resolutionNote: string | null;
}): Promise<void> {
  throw new Error('not implemented (W02)');
}
