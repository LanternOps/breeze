import { and, asc, eq, gte, isNotNull, notInArray } from 'drizzle-orm';
import type { CreateKeyDateInput, UpdateKeyDateInput } from '@breeze/shared';
import { db } from '../db';
import { contracts, organizationKeyDates, organizations, users, type OrganizationKeyDateRow } from '../db/schema';
import type { DeliverableActor } from './serviceDeliverableService';
import { DeliverableServiceError } from './serviceDeliverableService';

/**
 * Spec #5573 §4.5 / plan W01 Task 9. Org key dates plus, on read, the end
 * dates of live contracts so the org record shows one chronological list.
 * Every query filters by orgId — defence in depth on top of RLS.
 */
export interface KeyDateView {
  source: 'key_date' | 'contract_end';
  id: string;
  label: string;
  kind: string;
  date: string;
  recursAnnually: boolean;
  remindDaysBefore: number | null;
  ownerUserId: string | null;
  portalVisible: boolean;
  notes: string | null;
  contractId: string | null;
}

// Same shape as serviceDeliverableService's helper, kept local so this module
// has no runtime dependency on that file's internals. 404 (not 403): spec §12
// forbids an existence leak across orgs.
function requireOrgAccess(actor: DeliverableActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The owner must be a user of the org's partner. Resolved via the org's
 *  partner_id (never the actor's — a platform actor may carry none). */
async function assertOwnerInOrgPartner(orgId: string, ownerUserId: string): Promise<void> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');

  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, ownerUserId), eq(users.partnerId, org.partnerId)))
    .limit(1);
  if (!owner) {
    throw new DeliverableServiceError('Owner must be a user of this organization\'s partner', 400, 'OWNER_NOT_ALLOWED', { ownerUserId });
  }
}

function toKeyDateView(row: OrganizationKeyDateRow): KeyDateView {
  return {
    source: 'key_date',
    id: row.id,
    label: row.label,
    kind: row.kind,
    date: row.date,
    recursAnnually: row.recursAnnually,
    remindDaysBefore: row.remindDaysBefore,
    ownerUserId: row.ownerUserId,
    portalVisible: row.portalVisible,
    notes: row.notes,
    contractId: null,
  };
}

function toContractEndView(c: { id: string; name: string; endDate: string }): KeyDateView {
  return {
    source: 'contract_end',
    id: c.id,
    label: c.name,
    kind: 'contract_end',
    date: c.endDate,
    recursAnnually: false,
    remindDaysBefore: null,
    ownerUserId: null,
    portalVisible: true,
    notes: null,
    contractId: c.id,
  };
}

export async function listKeyDates(
  orgId: string,
  actor: DeliverableActor,
  opts?: { includeContractEnds?: boolean },
): Promise<KeyDateView[]> {
  requireOrgAccess(actor, orgId);
  const includeContractEnds = opts?.includeContractEnds ?? true;

  const rows = await db
    .select()
    .from(organizationKeyDates)
    .where(eq(organizationKeyDates.orgId, orgId))
    .orderBy(asc(organizationKeyDates.date));
  const views: KeyDateView[] = rows.map(toKeyDateView);

  if (includeContractEnds) {
    const today = todayISO();
    const ends = await db
      .select({ id: contracts.id, name: contracts.name, endDate: contracts.endDate, status: contracts.status })
      .from(contracts)
      .where(and(
        eq(contracts.orgId, orgId),
        isNotNull(contracts.endDate),
        gte(contracts.endDate, today),
        notInArray(contracts.status, ['draft', 'cancelled']),
      ))
      .orderBy(asc(contracts.endDate));
    for (const c of ends) {
      // The SQL predicate is authoritative; re-check in memory so a caller
      // (or a mock) that hands back unfiltered rows cannot surface a stale
      // or draft contract end.
      if (!c.endDate || c.endDate < today) continue;
      if (c.status === 'draft' || c.status === 'cancelled') continue;
      views.push(toContractEndView({ id: c.id, name: c.name, endDate: c.endDate }));
    }
  }

  return views.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function createKeyDate(
  orgId: string,
  input: CreateKeyDateInput,
  actor: DeliverableActor,
): Promise<OrganizationKeyDateRow> {
  requireOrgAccess(actor, orgId);
  const ownerUserId = input.ownerUserId ?? null;
  if (ownerUserId !== null) await assertOwnerInOrgPartner(orgId, ownerUserId);

  const [row] = await db
    .insert(organizationKeyDates)
    .values({
      orgId,
      label: input.label,
      kind: input.kind,
      date: input.date,
      recursAnnually: input.recursAnnually,
      remindDaysBefore: input.remindDaysBefore ?? null,
      ownerUserId,
      portalVisible: input.portalVisible,
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new DeliverableServiceError('Key date insert returned no row', 500, 'INSERT_FAILED');
  return row;
}

export async function updateKeyDate(
  orgId: string,
  id: string,
  patch: UpdateKeyDateInput,
  actor: DeliverableActor,
): Promise<OrganizationKeyDateRow> {
  requireOrgAccess(actor, orgId);
  if (patch.ownerUserId != null) await assertOwnerInOrgPartner(orgId, patch.ownerUserId);

  const set: Partial<typeof organizationKeyDates.$inferInsert> = { updatedAt: new Date() };
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.date !== undefined) set.date = patch.date;
  if (patch.recursAnnually !== undefined) set.recursAnnually = patch.recursAnnually;
  if (patch.remindDaysBefore !== undefined) set.remindDaysBefore = patch.remindDaysBefore;
  if (patch.ownerUserId !== undefined) set.ownerUserId = patch.ownerUserId;
  if (patch.portalVisible !== undefined) set.portalVisible = patch.portalVisible;
  if (patch.notes !== undefined) set.notes = patch.notes;

  const [row] = await db
    .update(organizationKeyDates)
    .set(set)
    .where(and(eq(organizationKeyDates.id, id), eq(organizationKeyDates.orgId, orgId)))
    .returning();
  if (!row) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
  return row;
}

export async function deleteKeyDate(orgId: string, id: string, actor: DeliverableActor): Promise<void> {
  requireOrgAccess(actor, orgId);
  const [row] = await db
    .delete(organizationKeyDates)
    .where(and(eq(organizationKeyDates.id, id), eq(organizationKeyDates.orgId, orgId)))
    .returning({ id: organizationKeyDates.id });
  if (!row) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
}

export async function sweepKeyDateReminders(_today: string): Promise<number> {
  throw new Error('not implemented (W02)');
}
