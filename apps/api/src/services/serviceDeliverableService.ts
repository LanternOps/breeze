import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  serviceDeliverables, serviceDeliverableOccurrences, serviceDeliverableEvidence,
  type ServiceDeliverableRow, type ServiceDeliverableOccurrenceRow,
} from '../db/schema/serviceDeliverables';
import { contracts } from '../db/schema/contracts';
import { organizations } from '../db/schema/orgs';
import { users } from '../db/schema/users';
import { reports, reportRuns } from '../db/schema/reports';
import { orgDocuments } from '../db/schema/orgDocuments';
import { contractDocuments } from '../db/schema/contractDocuments';
import { ticketCategories } from '../db/schema/tickets';
import { ticketChecklistItems, ticketChecklistTemplateItems } from '../db/schema/ticketChecklists';
import { checklistCountsForTickets } from './ticketChecklistService';
import { ticketComments } from '../db/schema/portal';
import type {
  CreateDeliverableInput, UpdateDeliverableInput, MoveDeliverablesInput, DeliverOccurrenceInput, WaiveOccurrenceInput,
  RescheduleOccurrenceInput, EvidenceRef,
} from '@breeze/shared';
import { transition, InvalidTransitionError, type OccurrenceStatus } from './serviceDeliverableState';
import { isInLeadWindow, isPastGrace, nextPlannedDueDate, planOccurrences, rebasedSchedule, type Cadence } from './recurrence';
import { addDaysISO } from './contractMath';
import type { TicketActor } from './ticketService';
import { createPlannedWorkTicket } from './plannedWorkTicket';
import { captureException } from './sentry';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { assertChecklistTemplateUsableByOrg } from './checklistTemplateReference';
import { isMspStaffReportType } from './reportRegistry';

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
  evidence: Array<{
    id: string; kind: 'document' | 'report_run' | 'contract_document';
    documentId: string | null; reportId: string | null; reportRunId: string | null;
    /** #9312: the signed agreement (contract_documents) this evidence references. */
    contractDocumentId: string | null;
    createdAt: string;
  }>;
  /**
   * #5808 W03 — MSP-only checklist progress for the occurrence's ticket. `null`
   * when the occurrence has no ticket or its ticket has no checklist.
   *
   * Present on EVERY OccurrenceView, not just the list: the drawer replaces a
   * row in place with whatever a mutation returns, so a mutation view that
   * omitted this would blank the chip the moment an occurrence is delivered.
   *
   * The customer portal builds its own DTOs in services/portal/serviceReadModel.ts
   * and must never gain this field (spec §5).
   */
  checklist: { done: number; total: number } | null;
}

/**
 * A live db handle or an open transaction handle. `applyTemplateSet` (W05)
 * needs every createDeliverable in ONE transaction: reaching for the
 * module-level `db` proxy from inside `db.transaction()` resolves to the
 * AMBIENT request transaction, not the nested one, so the writes would not be
 * covered by the all-or-nothing rollback.
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Nested `transaction()` on an open handle is a SAVEPOINT (see
 * assertNameAvailable) — the cast is only needed because the union's two arms
 * type their callback handle differently; both accept the same call.
 */
function withSavepoint<T>(executor: DbExecutor, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return (executor as typeof db).transaction(async (savepoint) => fn(savepoint));
}

const NON_TERMINAL: readonly OccurrenceStatus[] = ['scheduled', 'open', 'awaiting_evidence', 'missed'];
const ACTIONABLE: readonly OccurrenceStatus[] = ['open', 'awaiting_evidence', 'missed'];
const RESCHEDULABLE: ReadonlySet<OccurrenceStatus> = new Set(NON_TERMINAL);

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
  if (!d.active || (d.effectiveUntil !== null && today > d.effectiveUntil)) return 'inactive';
  if (occ.some((o) => o.status === 'missed')) return 'missed';
  const open = occ.filter((o) => o.status === 'open' || o.status === 'awaiting_evidence');
  if (open.some((o) => o.dueAt < today)) return 'late';
  if (open.some((o) => isInLeadWindow(o.dueAt, d.leadDays, today))) return 'due_soon';
  return 'on_track';
}

type SummaryOccurrence = Pick<ServiceDeliverableOccurrenceRow, 'id' | 'deliverableId' | 'status' | 'dueAt' | 'deliveredAt' | 'deliveryNote'> & { originalDueAt?: string | null };

function buildSummary(row: ServiceDeliverableRow, contractName: string | null, occ: SummaryOccurrence[], today: string): DeliverableSummary {
  const live = occ.filter((o) => NON_TERMINAL.includes(o.status));
  const liveNext = live.reduce<string | null>((min, o) => (min === null || o.dueAt < min ? o.dueAt : min), null);
  // #9308: with no live occurrence, report the planned due date (the sweep has not
  // materialized it yet). `occ` carries every status so a waived/delivered slot is
  // never re-planned.
  const nextDue = liveNext ?? (row.active && (row.effectiveUntil === null || today <= row.effectiveUntil)
    ? nextPlannedDueDate({
      anchorDueDate: row.anchorDueDate, cadence: row.cadence as Cadence,
      effectiveFrom: row.effectiveFrom, effectiveUntil: row.effectiveUntil,
      afterDue: occ.reduce<string | null>((max, o) => { const x = o.originalDueAt ?? o.dueAt; return max === null || x > max ? x : max; }, null),
    })
    : null);
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

async function loadSummaries(orgId: string, filters: { id?: string; contractId?: string; includeInactive?: boolean }, executor: DbExecutor = db): Promise<DeliverableSummary[]> {
  const conditions = [eq(serviceDeliverables.orgId, orgId)];
  if (filters.id !== undefined) conditions.push(eq(serviceDeliverables.id, filters.id));
  if (filters.contractId !== undefined) conditions.push(eq(serviceDeliverables.contractId, filters.contractId));
  if (!filters.includeInactive) conditions.push(eq(serviceDeliverables.active, true));
  const rows = await executor
    .select({ deliverable: serviceDeliverables, contractName: contracts.name })
    .from(serviceDeliverables)
    .leftJoin(contracts, and(eq(contracts.id, serviceDeliverables.contractId), eq(contracts.orgId, serviceDeliverables.orgId)))
    .where(and(...conditions))
    .orderBy(asc(serviceDeliverables.sortOrder), asc(serviceDeliverables.name));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.deliverable.id);
  const occ = await executor
    .select({
      id: serviceDeliverableOccurrences.id, deliverableId: serviceDeliverableOccurrences.deliverableId,
      status: serviceDeliverableOccurrences.status, dueAt: serviceDeliverableOccurrences.dueAt,
      deliveredAt: serviceDeliverableOccurrences.deliveredAt, deliveryNote: serviceDeliverableOccurrences.deliveryNote,
      originalDueAt: serviceDeliverableOccurrences.originalDueAt,
    })
    .from(serviceDeliverableOccurrences)
    .where(and(
      eq(serviceDeliverableOccurrences.orgId, orgId),
      inArray(serviceDeliverableOccurrences.deliverableId, ids),
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

type RefInput = Pick<UpdateDeliverableInput, 'contractId' | 'ownerUserId' | 'ticketCategoryId' | 'autoEvidenceReportId' | 'checklistTemplateId'>;

/** Only keys PRESENT on the input are validated, so a PATCH that omits a
 *  reference never re-validates it (and a null clears it without a lookup). */
async function validateReferences(orgId: string, input: RefInput, executor: DbExecutor = db): Promise<void> {
  if (input.contractId != null) {
    const [c] = await executor.select({ id: contracts.id, status: contracts.status }).from(contracts)
      .where(and(eq(contracts.id, input.contractId), eq(contracts.orgId, orgId))).limit(1);
    if (!c) throw new DeliverableServiceError('Contract does not belong to this organization', 400, 'CONTRACT_NOT_IN_ORG');
    // #9302. Cancelling a contract end-dates its deliverables
    // (applyContractCancelledToDeliverables); attaching one afterwards would
    // resurrect work against a dead contract.
    if (c.status === 'cancelled') throw new DeliverableServiceError('Deliverables cannot be assigned to a cancelled contract', 400, 'CONTRACT_NOT_ASSIGNABLE');
  }
  if (input.ownerUserId != null || input.ticketCategoryId != null || input.checklistTemplateId != null) {
    const [org] = await executor.select({ partnerId: organizations.partnerId }).from(organizations)
      .where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw notFound();
    if (input.ownerUserId != null) {
      const [u] = await executor.select({ id: users.id }).from(users)
        .where(and(eq(users.id, input.ownerUserId), eq(users.partnerId, org.partnerId))).limit(1);
      if (!u) throw new DeliverableServiceError('Owner must be a user of the organization\'s partner', 400, 'OWNER_NOT_ALLOWED');
    }
    if (input.ticketCategoryId != null) {
      const [cat] = await executor.select({ id: ticketCategories.id }).from(ticketCategories)
        .where(and(eq(ticketCategories.id, input.ticketCategoryId), eq(ticketCategories.partnerId, org.partnerId))).limit(1);
      if (!cat) throw new DeliverableServiceError('Ticket category must belong to the organization\'s partner', 400, 'CATEGORY_NOT_ALLOWED');
    }
    if (input.checklistTemplateId != null) {
      // #5808 W03. The FK is single-column on purpose (a composite one could
      // never match a partner-wide template), so this app-layer check IS the
      // constraint. Validated against the ORG'S partner rather than the actor's:
      // the deliverable's org is what the sweep will later fan the template out
      // to, and requireOrgAccess has already established the actor may write
      // here. A refusal is 404, never 403.
      await assertChecklistTemplateUsableByOrg(input.checklistTemplateId, orgId, org.partnerId, executor);
    }
  }
  if (input.autoEvidenceReportId != null) {
    const [r] = await executor.select({ id: reports.id, type: reports.type }).from(reports)
      .where(and(eq(reports.id, input.autoEvidenceReportId), eq(reports.orgId, orgId))).limit(1);
    if (!r) throw notFound();
    if (isMspStaffReportType(r.type)) throw internalReportType();
  }
}

/**
 * #3198 W02 ruling F1. Business report types (registry audience 'msp_staff':
 * SLA attainment, technician time, AR aging) are internal to the MSP, and
 * deliverable evidence can be customer-visible (portal service read model).
 * Refused on link (autoEvidenceReportId) and on manual attach; the nightly
 * auto-evidence sweep refuses them too (deliverableAutoEvidence.ts).
 */
const internalReportType = () =>
  new DeliverableServiceError('Internal business reports cannot be attached as deliverable evidence', 400, 'INTERNAL_REPORT_TYPE');

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
async function assertNameAvailable(orgId: string, contractId: string | null, name: string, excludeId?: string, executor: DbExecutor = db): Promise<void> {
  const conditions = [
    eq(serviceDeliverables.orgId, orgId),
    eq(serviceDeliverables.name, name),
    contractId === null ? isNull(serviceDeliverables.contractId) : eq(serviceDeliverables.contractId, contractId),
  ];
  if (excludeId) conditions.push(ne(serviceDeliverables.id, excludeId));
  const [dup] = await executor.select({ one: sql<number>`1` }).from(serviceDeliverables).where(and(...conditions)).limit(1);
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
async function loadWrittenSummary(orgId: string, id: string, executor: DbExecutor = db): Promise<DeliverableSummary> {
  const [summary] = await loadSummaries(orgId, { id, includeInactive: true }, executor);
  if (!summary) throw new DeliverableServiceError('Deliverable vanished after write', 500, 'RELOAD_FAILED');
  return summary;
}

/**
 * `executor` defaults to the ambient `db` proxy. `applyTemplateSet` (W05) passes
 * the open transaction handle so every deliverable of one template apply lands
 * in the same all-or-nothing transaction, reads included.
 */
export async function createDeliverable(orgId: string, input: CreateDeliverableInput, actor: DeliverableActor, executor: DbExecutor = db): Promise<DeliverableSummary> {
  requireOrgAccess(actor, orgId);
  await validateReferences(orgId, input, executor);
  await assertNameAvailable(orgId, input.contractId ?? null, input.name, undefined, executor);
  let row: ServiceDeliverableRow | undefined;
  try {
    // Savepoint: see assertNameAvailable — keeps a 23505 from poisoning the request transaction.
    [row] = await withSavepoint(executor, async (tx) => tx.insert(serviceDeliverables).values({
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
      instructions: input.instructions ?? null,
      checklistTemplateId: input.checklistTemplateId ?? null,
      portalVisible: input.portalVisible,
      sortOrder: input.sortOrder,
      createdBy: actor.userId,
    }).returning());
  } catch (err) {
    mapUniqueViolation(err);
  }
  if (!row) throw new DeliverableServiceError('Insert returned no row', 500, 'INSERT_FAILED');
  return loadWrittenSummary(orgId, row.id, executor);
}

export async function updateDeliverable(orgId: string, id: string, patch: UpdateDeliverableInput, actor: DeliverableActor): Promise<DeliverableSummary> {
  requireOrgAccess(actor, orgId);
  const [existing] = await db.select({ id: serviceDeliverables.id, name: serviceDeliverables.name, contractId: serviceDeliverables.contractId })
    .from(serviceDeliverables)
    .where(and(eq(serviceDeliverables.id, id), eq(serviceDeliverables.orgId, orgId))).limit(1);
  if (!existing) throw notFound();
  // An unchanged contractId (the edit form re-sends it) is not a move: a
  // deliverable on a since-cancelled contract must stay editable (#9302).
  await validateReferences(orgId, patch.contractId === existing.contractId ? { ...patch, contractId: undefined } : patch);
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

/**
 * #9302 bulk move. All-or-nothing: every id must belong to `orgId` (else 404,
 * nothing changes), and any name collision in the target — against its
 * existing deliverables or between the moved ones — fails the whole batch with
 * 409 `details.names`. Only `service_deliverables.contract_id` is written;
 * occurrences and evidence are history and stay untouched.
 */
export async function moveDeliverables(
  orgId: string, input: MoveDeliverablesInput, actor: DeliverableActor,
): Promise<{ moved: number }> {
  requireOrgAccess(actor, orgId);
  const ids = [...new Set(input.deliverableIds)];
  const targetId = input.contractId;
  await validateReferences(orgId, { contractId: targetId });
  try {
    // Savepoint: see assertNameAvailable — keeps a 23505 from poisoning the request transaction.
    const moved = await db.transaction((tx) => moveDeliverablesWithin(tx, orgId, ids, targetId));
    return { moved };
  } catch (err) {
    mapUniqueViolation(err);
  }
}

/**
 * The body of {@link moveDeliverables}, on the CALLER's transaction, so a
 * larger operation (#9346 adopt-draft) can move deliverables and roll back
 * together with its own writes. The caller owns org access and has already
 * validated `targetId` (same org, not cancelled); `ids` must be non-empty and
 * de-duplicated. Throws 404 / 409 `DUPLICATE_NAME` (`details.names`) /
 * 409 `MOVE_INCOMPLETE` as DeliverableServiceError; a racing 23505 surfaces raw
 * (map it with the caller's own savepoint, as moveDeliverables does).
 */
export async function moveDeliverablesWithin(
  tx: DbExecutor, orgId: string, ids: string[], targetId: string | null,
): Promise<number> {
  const found = await tx.select({ id: serviceDeliverables.id, name: serviceDeliverables.name })
    .from(serviceDeliverables)
    .where(and(eq(serviceDeliverables.orgId, orgId), inArray(serviceDeliverables.id, ids)));
  if (found.length !== ids.length) throw notFound();

  const seen = new Set<string>();
  const colliding = new Set<string>();
  for (const r of found) { if (seen.has(r.name)) colliding.add(r.name); seen.add(r.name); }
  const existing = await tx.select({ name: serviceDeliverables.name }).from(serviceDeliverables)
    .where(and(
      eq(serviceDeliverables.orgId, orgId),
      targetId === null ? isNull(serviceDeliverables.contractId) : eq(serviceDeliverables.contractId, targetId),
      inArray(serviceDeliverables.name, [...seen]),
      sql`${serviceDeliverables.id} NOT IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
    ));
  for (const e of existing) colliding.add(e.name);
  if (colliding.size > 0) {
    throw new DeliverableServiceError(
      'A deliverable with this name already exists for the target contract', 409, 'DUPLICATE_NAME',
      { names: [...colliding].sort() },
    );
  }

  const updated = await tx.update(serviceDeliverables)
    .set({ contractId: targetId, updatedAt: new Date() })
    .where(and(eq(serviceDeliverables.orgId, orgId), inArray(serviceDeliverables.id, ids)))
    .returning({ id: serviceDeliverables.id });
  // Roll the batch back rather than report a partial move as success.
  if (updated.length !== ids.length) throw new DeliverableServiceError('Not every deliverable could be moved', 409, 'MOVE_INCOMPLETE');
  return updated.length;
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

type EvidenceListRow = Pick<typeof serviceDeliverableEvidence.$inferSelect, 'id' | 'occurrenceId' | 'kind' | 'documentId' | 'reportId' | 'reportRunId' | 'contractDocumentId' | 'createdAt'>;

const evidenceColumns = {
  id: serviceDeliverableEvidence.id, occurrenceId: serviceDeliverableEvidence.occurrenceId, kind: serviceDeliverableEvidence.kind,
  documentId: serviceDeliverableEvidence.documentId, reportId: serviceDeliverableEvidence.reportId,
  reportRunId: serviceDeliverableEvidence.reportRunId, contractDocumentId: serviceDeliverableEvidence.contractDocumentId,
  createdAt: serviceDeliverableEvidence.createdAt,
};

function toEvidenceView(e: EvidenceListRow): OccurrenceView['evidence'][number] {
  return {
    id: e.id, kind: e.kind, documentId: e.documentId, reportId: e.reportId, reportRunId: e.reportRunId,
    contractDocumentId: e.contractDocumentId ?? null, createdAt: e.createdAt.toISOString(),
  };
}

function toView(
  loaded: LoadedOccurrence,
  evidence: EvidenceListRow[],
  today: string,
  checklist: { done: number; total: number } | null = null,
): OccurrenceView {
  const { artifactRequired: _a, completionMode: _c, graceDays: _g, leadDays: _l, ...row } = loaded;
  return { ...row, late: isLate(row, today), evidence: evidence.map(toEvidenceView), checklist };
}

async function loadView(orgId: string, occurrenceId: string, executor: DbExecutor): Promise<OccurrenceView> {
  const loaded = await loadOccurrence(orgId, occurrenceId, executor);
  const evidence = await executor.select(evidenceColumns).from(serviceDeliverableEvidence)
    .where(and(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId), eq(serviceDeliverableEvidence.orgId, orgId)))
    .orderBy(asc(serviceDeliverableEvidence.createdAt));
  // The chip has to survive a mutation: the drawer swaps the row in place with
  // whatever comes back here, so omitting the summary would blank it on every
  // deliver/waive/reschedule.
  const counts = loaded.ticketId ? await checklistCountsForTickets([loaded.ticketId]) : null;
  return toView(loaded, evidence, todayISO(), counts?.get(loaded.ticketId!) ?? null);
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
      const [run] = await executor.select({ id: reportRuns.id, reportId: reportRuns.reportId, type: reports.type })
        .from(reportRuns)
        .innerJoin(reports, eq(reports.id, reportRuns.reportId))
        .where(and(eq(reportRuns.id, ref.reportRunId), eq(reports.orgId, orgId)))
        .limit(1);
      if (!run) throw notFound();
      if (isMspStaffReportType(run.type)) throw internalReportType();
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
    case 'contract_document': {
      // #9312: a signed agreement already stored in Breeze, referenced in
      // place — never copied into org_documents, so there is one record with
      // one retention rule. Same 404-not-403 contract as 'document': another
      // org's agreement must be indistinguishable from a missing one. The
      // explicit org predicate matters because a partner-scoped RLS context
      // can see every org of the partner; the composite FK
      // (contract_document_id, org_id) is the DB backstop.
      const [agreement] = await executor.select({ id: contractDocuments.id })
        .from(contractDocuments)
        .where(and(eq(contractDocuments.id, ref.contractDocumentId), eq(contractDocuments.orgId, orgId)))
        .limit(1);
      if (!agreement) throw notFound();
      await executor.insert(serviceDeliverableEvidence).values({
        orgId, occurrenceId, kind: 'contract_document', contractDocumentId: agreement.id,
        documentId: null, reportId: null, reportRunId: null, createdByUserId: actor.userId,
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
  // ONE grouped query for every occurrence's checklist progress, folded into
  // the payload the drawer already fetches. The alternative — 24 self-fetching
  // checklist cards on drawer open — is 24 requests for a chip.
  const ticketIds = rows.map((r) => r.ticketId).filter((v): v is string => !!v);
  const counts = ticketIds.length > 0 ? await checklistCountsForTickets(ticketIds) : null;
  const today = todayISO();
  return rows.map((r) => toView(
    r,
    byOccurrence.get(r.id) ?? [],
    today,
    r.ticketId ? counts?.get(r.ticketId) ?? null : null,
  ));
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

/** Spec §5.3 step 1. System caller — run inside withSystemDbAccessContext. */
export async function materializeOccurrences(deliverableId: string, today: string): Promise<ServiceDeliverableOccurrenceRow[]> {
  const [d] = await db
    .select({
      id: serviceDeliverables.id, orgId: serviceDeliverables.orgId, name: serviceDeliverables.name,
      cadence: serviceDeliverables.cadence, anchorDueDate: serviceDeliverables.anchorDueDate,
      effectiveFrom: serviceDeliverables.effectiveFrom, effectiveUntil: serviceDeliverables.effectiveUntil,
      leadDays: serviceDeliverables.leadDays, graceDays: serviceDeliverables.graceDays,
    })
    .from(serviceDeliverables).where(eq(serviceDeliverables.id, deliverableId)).limit(1);
  if (!d) throw notFound();

  // Keyed on original_due_at: a rescheduled occurrence moved its due_at, but its
  // nominal slot is still taken and must not be planned again.
  const existing = await db
    .select({ originalDueAt: serviceDeliverableOccurrences.originalDueAt })
    .from(serviceDeliverableOccurrences)
    .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId));

  const plan = planOccurrences({
    anchorDueDate: d.anchorDueDate, cadence: d.cadence as Cadence,
    effectiveFrom: d.effectiveFrom, effectiveUntil: d.effectiveUntil,
    leadDays: d.leadDays, graceDays: d.graceDays, today,
    existingDueDates: existing.map((e) => e.originalDueAt),
  });
  if (plan.length === 0) return [];

  return db.insert(serviceDeliverableOccurrences)
    .values(plan.map((p) => ({
      orgId: d.orgId, deliverableId: d.id,
      // Spec §4.2: the name at materialization. A later rename never rewrites history.
      nameSnapshot: d.name,
      periodStart: p.periodStart, periodEnd: p.periodEnd,
      dueAt: p.dueAt, originalDueAt: p.dueAt, status: p.initialStatus,
    })))
    // UNIQUE (deliverable_id, period_start) is the claim; a concurrent sweep
    // loses silently rather than raising 23505 and failing the deliverable.
    .onConflictDoNothing({ target: [serviceDeliverableOccurrences.deliverableId, serviceDeliverableOccurrences.periodStart] })
    .returning();
}
/** Spec §5.3 step 2, single-row form. System caller. */
export async function openOccurrence(occurrenceId: string, ticketId: string | null): Promise<void> {
  await db.update(serviceDeliverableOccurrences)
    .set({ status: 'open', ...(ticketId ? { ticketId } : {}), updatedAt: new Date() })
    .where(and(eq(serviceDeliverableOccurrences.id, occurrenceId), eq(serviceDeliverableOccurrences.status, 'scheduled')));
}
const MISSABLE: readonly OccurrenceStatus[] = ['open', 'awaiting_evidence'];

/** Spec §5.3 step 4, single-row form. System caller. */
export async function markOccurrenceMissed(occurrenceId: string): Promise<void> {
  await db.update(serviceDeliverableOccurrences)
    .set({ status: 'missed', updatedAt: new Date() })
    .where(and(eq(serviceDeliverableOccurrences.id, occurrenceId), inArray(serviceDeliverableOccurrences.status, MISSABLE)));
}
const RESOLVED_LIKE: ReadonlySet<string> = new Set(['resolved', 'closed']);
const REOPENED_LIKE: ReadonlySet<string> = new Set(['new', 'open', 'pending', 'on_hold']);

/**
 * Spec §6. System caller (the `deliverable-status` subscriber). Advisory, not
 * the record of delivery (D4) — the deliverable's completion policy decides,
 * via the pure state machine. Idempotent by construction: the write is CAS'd
 * on the status this function read, so a duplicate or racing event updates 0
 * rows.
 */
export async function applyTicketStatusChange(args: {
  ticketId: string; orgId: string; to: string; actorUserId: string | null; resolutionNote: string | null;
}): Promise<void> {
  const [occ] = await db.select({
      id: serviceDeliverableOccurrences.id, status: serviceDeliverableOccurrences.status,
      deliveredVia: serviceDeliverableOccurrences.deliveredVia,
      artifactRequired: serviceDeliverables.artifactRequired,
      completionMode: serviceDeliverables.completionMode,
    })
    .from(serviceDeliverableOccurrences)
    .innerJoin(serviceDeliverables, and(
      eq(serviceDeliverables.id, serviceDeliverableOccurrences.deliverableId),
      eq(serviceDeliverables.orgId, serviceDeliverableOccurrences.orgId),
    ))
    .where(and(eq(serviceDeliverableOccurrences.ticketId, args.ticketId), eq(serviceDeliverableOccurrences.orgId, args.orgId)))
    .limit(1);
  if (!occ) return;

  const current = occ.status;
  let outcome: ReturnType<typeof transition>;
  if (RESOLVED_LIKE.has(args.to)) {
    const evidence = await db.select({ id: serviceDeliverableEvidence.id })
      .from(serviceDeliverableEvidence)
      .where(and(eq(serviceDeliverableEvidence.occurrenceId, occ.id), eq(serviceDeliverableEvidence.orgId, args.orgId)))
      .limit(1);
    outcome = transition(current, {
      type: 'ticket_resolved', hasEvidence: evidence.length > 0,
      artifactRequired: occ.artifactRequired, completionMode: occ.completionMode,
    });
  } else if (REOPENED_LIKE.has(args.to)) {
    outcome = transition(current, { type: 'ticket_reopened', deliveredVia: occ.deliveredVia });
  } else {
    return;
  }
  if (outcome.next === null) return;

  const now = new Date();
  const patch: Partial<typeof serviceDeliverableOccurrences.$inferInsert> = { status: outcome.next, updatedAt: now };
  if (outcome.next === 'delivered') {
    patch.deliveredAt = now;
    patch.deliveredByUserId = args.actorUserId;
    patch.deliveredVia = 'ticket';
    patch.deliveryNote = args.resolutionNote;
  } else if (outcome.next === 'awaiting_evidence') {
    // The delivery is not recorded until evidence arrives (addEvidence stamps
    // it), but the technician's resolution note is the delivery narrative —
    // keep it so the eventual delivery carries it.
    patch.deliveryNote = args.resolutionNote;
  } else if (outcome.next === 'open') {
    patch.deliveredAt = null; patch.deliveredByUserId = null;
    patch.deliveredVia = null; patch.deliveryNote = null;
  }

  await db.update(serviceDeliverableOccurrences).set(patch)
    // CAS on the status we decided from: a concurrent write loses silently.
    .where(and(occurrenceKey(args.orgId, occ.id), eq(serviceDeliverableOccurrences.status, current)));
}

// ---------------------------------------------------------------------------
// W02 sweep-shaped siblings (system callers, no actor).
// ---------------------------------------------------------------------------

export interface SweepDeliverable {
  id: string; orgId: string; name: string;
  cadence: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';
  anchorDueDate: string; effectiveFrom: string; effectiveUntil: string | null;
  leadDays: number; graceDays: number; autoEvidenceReportId: string | null;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Oct 2026" | "Q4 2026" | "H2 2026" | "2026" — the period label in the ticket subject. */
export function periodLabel(cadence: Cadence, periodEnd: string): string {
  const y = Number(periodEnd.slice(0, 4));
  const m = Number(periodEnd.slice(5, 7));
  if (cadence === 'annual') return String(y);
  if (cadence === 'semiannual') return `H${m <= 6 ? 1 : 2} ${y}`;
  if (cadence === 'quarterly') return `Q${Math.ceil(m / 3)} ${y}`;
  return `${MONTH_ABBR[m - 1]} ${y}`;                        // monthly and one_time
}

/**
 * Synthetic actor for sweep-created tickets: only ever written to
 * audit_logs.actor_id, which is NOT NULL with no FK to users (precedent:
 * inboundEmailService.ts). createTicket writes no `tickets` column from it.
 */
const DELIVERABLE_SWEEP_ACTOR: TicketActor = { kind: 'system', source: 'planned_work', name: 'Service deliverables' };

type SweepOccurrence = { id: string; nameSnapshot: string; periodStart: string; periodEnd: string; dueAt: string };

/**
 * Spec §5.3 step 2. Self-wrapping: one system transaction per occurrence, so
 * the claim UPDATE and the ticket creation commit or roll back together — a
 * crash between them cannot strand an `open` occurrence with no ticket and no
 * retry.
 */
export async function openDueOccurrencesForDeliverable(
  d: SweepDeliverable, today: string, serviceOffWarned: Set<string>,
): Promise<number> {
  const candidates: SweepOccurrence[] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
        id: serviceDeliverableOccurrences.id, nameSnapshot: serviceDeliverableOccurrences.nameSnapshot,
        periodStart: serviceDeliverableOccurrences.periodStart, periodEnd: serviceDeliverableOccurrences.periodEnd,
        dueAt: serviceDeliverableOccurrences.dueAt,
      })
      .from(serviceDeliverableOccurrences)
      .where(and(eq(serviceDeliverableOccurrences.deliverableId, d.id), eq(serviceDeliverableOccurrences.status, 'scheduled'))),
    'deliverableSweep.selectScheduled'));

  let opened = 0;
  for (const occ of candidates) {
    if (!isInLeadWindow(occ.dueAt, d.leadDays, today)) continue;
    // Per occurrence: its transaction rolls back (releasing the claim for
    // tomorrow), and the deliverable's REMAINING occurrences — and the miss
    // and auto-evidence steps that follow in the sweep — still run today.
    try {
      opened += await runOutsideDbContext(() => withSystemDbAccessContext(
        () => openOneOccurrence(d, occ, serviceOffWarned), 'deliverableSweep.openOccurrence'));
    } catch (err) {
      console.error('[deliverables] opening an occurrence failed', `orgId=${d.orgId}`, `deliverableId=${d.id}`,
        `occurrenceId=${occ.id}`, err instanceof Error ? err.message : String(err));
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return opened;
}

async function openOneOccurrence(d: SweepDeliverable, occ: SweepOccurrence, serviceOffWarned: Set<string>): Promise<number> {
  // Claim first: 0 rows means a concurrent sweep won and already has the ticket.
  const claimed = await db.update(serviceDeliverableOccurrences)
    .set({ status: 'open', updatedAt: new Date() })
    .where(and(eq(serviceDeliverableOccurrences.id, occ.id), eq(serviceDeliverableOccurrences.status, 'scheduled')))
    .returning({ id: serviceDeliverableOccurrences.id });
  if (claimed.length === 0) return 0;

  const [cfg] = await db.select({
      ownerUserId: serviceDeliverables.ownerUserId,
      ticketCategoryId: serviceDeliverables.ticketCategoryId,
      description: serviceDeliverables.description,
      instructions: serviceDeliverables.instructions,
      checklistTemplateId: serviceDeliverables.checklistTemplateId,
    }).from(serviceDeliverables).where(eq(serviceDeliverables.id, d.id)).limit(1);

  // Any failure other than Service Management `off` (and a stale owner or
  // category, which the helper drops) is rethrown: this transaction rolls
  // back, the claim is released, and the occurrence retries on the next run
  // rather than being stranded `open` with no ticket.
  const created = await createPlannedWorkTicket({
    orgId: d.orgId, workKind: 'deliverable',
    subject: `${occ.nameSnapshot} — ${periodLabel(d.cadence, occ.periodEnd)}`,
    description: cfg?.description ?? undefined,
    dueDate: new Date(`${occ.dueAt}T00:00:00.000Z`),
    assigneeId: cfg?.ownerUserId ?? null,
    categoryId: cfg?.ticketCategoryId ?? null,
  }, DELIVERABLE_SWEEP_ACTOR, { orgId: d.orgId, deliverableId: d.id });

  if (created.kind === 'service_management_off') {
    // Spec §5.3 step 2: an `off` partner still gets the occurrence, fulfilled by hand.
    if (!serviceOffWarned.has(d.orgId)) {
      serviceOffWarned.add(d.orgId);
      console.warn('[deliverables] Service Management is off for this partner — occurrences opened without tickets',
        `orgId=${d.orgId}`, `deliverableId=${d.id}`);
    }
    return 1;
  }

  await db.update(serviceDeliverableOccurrences)
    .set({ ticketId: created.ticketId, updatedAt: new Date() })
    .where(eq(serviceDeliverableOccurrences.id, occ.id));

  // ── #5808 W03: seed the checklist, then snapshot the instructions ────────
  //
  // Both run on the ambient `db` handle, inside the SAME per-occurrence system
  // transaction as the claim and the ticket creation (see this function's
  // docstring). A failure here therefore rolls the claim back and the
  // occurrence retries tomorrow, rather than being stranded `open` with a
  // ticket and no checklist. Do NOT open a nested transaction here, and do not
  // reach for a fresh pool handle.
  if (cfg?.checklistTemplateId) {
    const steps = await db.select({
        id: ticketChecklistTemplateItems.id,
        label: ticketChecklistTemplateItems.label,
        detail: ticketChecklistTemplateItems.detail,
      })
      .from(ticketChecklistTemplateItems)
      .where(eq(ticketChecklistTemplateItems.templateId, cfg.checklistTemplateId))
      .orderBy(asc(ticketChecklistTemplateItems.sortOrder), asc(ticketChecklistTemplateItems.label));
    if (steps.length === 0) {
      // A referenced template with NO items is indistinguishable, downstream,
      // from a deliverable that was never given a checklist at all: the ticket
      // opens, `checklist` reads null, and nothing anywhere says a checklist
      // was supposed to be here. That is the exact silent-empty failure the
      // delete guard exists to prevent, arriving by a different route (an admin
      // removed every step from a template a live deliverable still points at).
      // Warn so it is visible in logs and Sentry rather than only in a customer
      // complaint weeks later. Matches the service_management_off branch above.
      console.warn(
        '[deliverables] a deliverable references a checklist template with no items — its ticket opened with an empty checklist',
        `orgId=${d.orgId}`, `deliverableId=${d.id}`, `checklistTemplateId=${cfg.checklistTemplateId}`,
      );
    } else {
      await db.insert(ticketChecklistItems).values(steps.map((step, index) => ({
        // The DELIVERABLE's org. NEVER the template's, which is NULL for a
        // partner-wide template — a partner-wide template produces org-scoped
        // rows inside each customer's own tenant, and no cross-tenant row is
        // ever created.
        orgId: d.orgId,
        ticketId: created.ticketId,
        label: step.label,
        detail: step.detail,
        position: index,
        source: 'deliverable' as const,
        sourceTemplateItemId: step.id,
        // NULL, not DELIVERABLE_SWEEP_ACTOR.userId: that is the nil UUID
        // '00000000-…-0000' and is not a users row, so writing it would 23503
        // and abort this occurrence every single night.
        createdBy: null,
      })));
    }
  }

  if (cfg?.instructions) {
    // A point-in-time SNAPSHOT, matching the nameSnapshot precedent: editing
    // the deliverable's instructions tomorrow must not silently rewrite what a
    // technician was told to do last month.
    //
    // commentType 'internal' matches deliverableAutoEvidence.ts — the other
    // comment this same sweep posts on this same ticket. `isPublic: false` is
    // what keeps it out of the portal (routes/portal/tickets.ts filters on
    // is_public = true), and originPrincipalKind 'system' keeps the helpdesk
    // loop guard from ever re-admitting it as a human reply.
    await db.insert(ticketComments).values({
      ticketId: created.ticketId,
      userId: null,
      authorName: 'Breeze',
      authorType: 'system',
      commentType: 'internal',
      content: `Internal instructions for this deliverable:\n\n${cfg.instructions}`,
      isPublic: false,
      originPrincipalKind: 'system',
    });
  }
  return 1;
}
/**
 * Spec §5.3 step 4, sweep form. System caller. The ticket is deliberately
 * untouched: a missed deliverable's work may still be in flight, and closing
 * its ticket would destroy that signal.
 */
export async function markDueOccurrencesMissedForDeliverable(
  d: SweepDeliverable, today: string, options: { closing?: boolean } = {},
): Promise<number> {
  // Closing mode (#5609): the deliverable has left its window (inactive or past
  // effective_until), so the main sweep will never visit it again. Retire every
  // not-yet-terminal occurrence, including `scheduled` rows that never opened,
  // but keep the grace window: `active` is reversible, and a paused deliverable
  // must not stamp `missed` earlier than the normal sweep would.
  const statuses = options.closing ? (['scheduled', ...MISSABLE] as const) : MISSABLE;
  const cutoff = addDaysISO(today, -d.graceDays);
  const rows = await db.update(serviceDeliverableOccurrences)
    .set({ status: 'missed', updatedAt: new Date() })
    .where(and(
      eq(serviceDeliverableOccurrences.deliverableId, d.id),
      inArray(serviceDeliverableOccurrences.status, statuses),
      lt(serviceDeliverableOccurrences.dueAt, cutoff),
    ))
    .returning({ id: serviceDeliverableOccurrences.id });
  return rows.length;
}
/**
 * Spec §5.4. A cancelled contract ends the service it paid for, so every
 * deliverable still open-ended on it stops today. `paused` deliberately does
 * nothing (a billing pause is not a service pause) and `expired` is ignored
 * entirely (D1 — generateDueInvoice expires an annual-advance contract the day
 * after its single invoice while service runs on).
 *
 * The contract's CURRENT status is re-read rather than trusted from the event:
 * `contract-events` gained its first consumer in this wave, so the first
 * deploy drains a historical backlog, and a cancel later reversed must not
 * close a live deliverable. cancelContract stores no cancellation timestamp,
 * so `today` is the processing date, not a back-date. Self-wrapping.
 */
export async function applyContractCancelledToDeliverables(contractId: string, today: string): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [contract] = await db.select({ id: contracts.id, orgId: contracts.orgId, status: contracts.status })
      .from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!contract || contract.status !== 'cancelled') return 0;

    const updated = await db.update(serviceDeliverables)
      .set({ effectiveUntil: today, updatedAt: new Date() })
      .where(and(
        eq(serviceDeliverables.contractId, contractId),
        eq(serviceDeliverables.orgId, contract.orgId),
        isNull(serviceDeliverables.effectiveUntil),
      ))
      .returning({ id: serviceDeliverables.id });
    if (updated.length > 0) {
      console.log('[deliverables] contract cancelled — closed effective window',
        `contractId=${contractId}`, `deliverables=${updated.length}`, `effectiveUntil=${today}`);
    }
    return updated.length;
  }, 'deliverables.contractCancelled'));
}

/**
 * #9309 (D1 amendment). While a contract is a draft the sweep skips its
 * deliverables, so their schedule is still pinned to whatever start the
 * contract had when they were applied. When the start becomes real — a
 * draft's start-date edit (`from` = old start, `to` = new start), or
 * activation (`from` = start, `to` = the later of start and today) — the
 * deliverables on the contract with NO occurrence yet are re-based onto `to`
 * (recurrence.rebasedSchedule) when they were pinned to the old start
 * (`effective_from = from`) or would begin before `to`. A deliverable the MSP
 * gave its own start on or after `to` keeps it. A deliverable that already
 * has an occurrence is never touched: its history is real.
 *
 * A deliverable whose `effective_until` falls before `to` can owe nothing
 * under this contract (its window closes before service starts), and left on
 * its old schedule the sweep would materialize obligations dated before the
 * contract began. It is deactivated instead, and logged.
 *
 * Runs on the CALLER's executor so it commits or rolls back with the contract
 * write that triggered it; the actor's context already covers the contract's
 * org. Re-applying the same `from`/`to` is a no-op.
 */
export async function rebaseUnmaterializedDeliverables(
  contractId: string, orgId: string, start: { from: string; to: string }, executor: DbExecutor = db,
): Promise<{ rebased: number; deactivated: number }> {
  // `o.` keeps the subquery's column unambiguous inside the UPDATE below.
  const noOccurrence = (deliverableId: typeof serviceDeliverables.id | string) => sql`not exists (select 1 from ${serviceDeliverableOccurrences} o where o.deliverable_id = ${deliverableId})`;
  const rows = await executor.select({
      id: serviceDeliverables.id, cadence: serviceDeliverables.cadence, anchorDueDate: serviceDeliverables.anchorDueDate,
      effectiveFrom: serviceDeliverables.effectiveFrom, effectiveUntil: serviceDeliverables.effectiveUntil,
      active: serviceDeliverables.active,
    })
    .from(serviceDeliverables)
    .where(and(
      eq(serviceDeliverables.contractId, contractId),
      eq(serviceDeliverables.orgId, orgId),
      ne(serviceDeliverables.effectiveFrom, start.to),
      or(eq(serviceDeliverables.effectiveFrom, start.from), lt(serviceDeliverables.effectiveFrom, start.to)),
      noOccurrence(serviceDeliverables.id),
    ));

  let rebased = 0;
  let deactivated = 0;
  for (const r of rows) {
    // Re-checked on each write so an occurrence materialized since the read wins.
    const target = and(eq(serviceDeliverables.id, r.id), eq(serviceDeliverables.orgId, orgId), noOccurrence(r.id));
    if (r.effectiveUntil !== null && r.effectiveUntil < start.to) {
      if (!r.active) continue;
      const off = await executor.update(serviceDeliverables).set({ active: false, updatedAt: new Date() })
        .where(target).returning({ id: serviceDeliverables.id });
      deactivated += off.length;
      if (off.length > 0) {
        console.warn('[deliverables] deactivated: effective window closes before the contract start',
          `deliverableId=${r.id}`, `contractId=${contractId}`, `effectiveUntil=${r.effectiveUntil}`, `start=${start.to}`);
      }
      continue;
    }
    const next = rebasedSchedule({ cadence: r.cadence as Cadence, anchorDueDate: r.anchorDueDate, effectiveFrom: r.effectiveFrom }, start.to);
    const written = await executor.update(serviceDeliverables).set({ ...next, updatedAt: new Date() })
      .where(target).returning({ id: serviceDeliverables.id });
    rebased += written.length;
  }
  if (rebased > 0 || deactivated > 0) {
    console.log('[deliverables] contract start set — re-based unmaterialized deliverables',
      `contractId=${contractId}`, `rebased=${rebased}`, `deactivated=${deactivated}`, `from=${start.from}`, `to=${start.to}`);
  }
  return { rebased, deactivated };
}
