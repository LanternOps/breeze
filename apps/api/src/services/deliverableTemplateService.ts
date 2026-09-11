import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  deliverableTemplateSets,
  deliverableTemplateItems,
  type DeliverableTemplateSetRow,
  type DeliverableTemplateItemRow,
} from '../db/schema/deliverableTemplates';
import type { AuthContext } from '../middleware/auth';
import type {
  CreateTemplateSetInput, UpdateTemplateSetInput, CreateTemplateItemInput, UpdateTemplateItemInput,
} from '@breeze/shared';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';
import { isPgUniqueViolation, pgErrorConstraint } from '../utils/pgErrors';
import { createDeliverable, DeliverableServiceError } from './serviceDeliverableService';
import { firstAnchorAfter, type Cadence } from './recurrence';
import { contracts } from '../db/schema/contracts';
import { serviceDeliverables } from '../db/schema/serviceDeliverables';

/**
 * Deliverable template sets and items (spec #5573 §4.6, D9). Dual ownership per
 * CLAUDE.md "Partner-Wide First": org_id XOR partner_id. This module is the
 * ONLY writer of both tables.
 */

export interface TemplateActor {
  userId: string | null;
  scope: AuthContext['scope'];
  partnerId: string | null;
  partnerOrgAccess: AuthContext['partnerOrgAccess'];
  accessibleOrgIds: string[] | null;
}

export class TemplateServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) {
    super(message);
    this.name = 'TemplateServiceError';
  }
}

export type TemplateItemView = DeliverableTemplateItemRow;
export interface TemplateSetView extends DeliverableTemplateSetRow {
  items: TemplateItemView[];
  ownerScope: 'organization' | 'partner';
}

const notFound = () => new TemplateServiceError('Not found', 404, 'NOT_FOUND');

function requireOrgAccess(actor: TemplateActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) throw notFound();
}

/**
 * Rows this actor may READ. The partner-wide arm is gated on partner scope
 * (CLAUDE.md "Partner-Wide First" step 3): the table's partner-wide SELECT
 * policy deliberately makes those rows readable from an org context, so this
 * gate is the ONLY authorization control on that axis, not a redundant second
 * one (partnerWideAccess.ts canReadPartnerWideRows).
 */
function visibilityCondition(actor: TemplateActor): SQL | undefined {
  if (actor.accessibleOrgIds === null) return undefined; // system
  const arms: SQL[] = [];
  if (actor.accessibleOrgIds.length > 0) arms.push(inArray(deliverableTemplateSets.orgId, actor.accessibleOrgIds));
  if (actor.scope === 'partner' && actor.partnerId) {
    arms.push(and(isNull(deliverableTemplateSets.orgId), eq(deliverableTemplateSets.partnerId, actor.partnerId))!);
  }
  if (arms.length === 0) return sql`false`;
  return arms.length === 1 ? arms[0]! : or(...arms)!;
}

const ownerScopeOf = (row: Pick<DeliverableTemplateSetRow, 'orgId'>) =>
  (row.orgId === null ? 'partner' as const : 'organization' as const);

/** Visibility is not permission: a partner-wide row is administrable only by a full-partner admin. */
function requireWritable(row: Pick<DeliverableTemplateSetRow, 'orgId'>, actor: TemplateActor): void {
  if (row.orgId === null && !canManagePartnerWidePolicies(actor)) throw new PartnerWideWriteDeniedError();
}

function mapUniqueViolation(err: unknown): never {
  if (isPgUniqueViolation(err)) {
    const constraint = pgErrorConstraint(err) ?? '';
    if (constraint.startsWith('deliverable_template_items_set_name')) {
      throw new TemplateServiceError('An item with this name already exists in the set', 409, 'DUPLICATE_TEMPLATE_ITEM_NAME');
    }
    throw new TemplateServiceError('A template set with this name already exists', 409, 'DUPLICATE_TEMPLATE_SET_NAME');
  }
  throw err;
}

async function loadSetOr404(setId: string, actor: TemplateActor): Promise<DeliverableTemplateSetRow> {
  const [row] = await db.select().from(deliverableTemplateSets)
    .where(and(eq(deliverableTemplateSets.id, setId), visibilityCondition(actor)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

async function loadItems(setIds: string[]): Promise<Map<string, TemplateItemView[]>> {
  const byId = new Map<string, TemplateItemView[]>();
  if (setIds.length === 0) return byId;
  const items = await db.select().from(deliverableTemplateItems)
    .where(inArray(deliverableTemplateItems.setId, setIds))
    .orderBy(asc(deliverableTemplateItems.sortOrder), asc(deliverableTemplateItems.name));
  for (const item of items) {
    const list = byId.get(item.setId) ?? [];
    list.push(item);
    byId.set(item.setId, list);
  }
  return byId;
}

async function hydrate(setRow: DeliverableTemplateSetRow): Promise<TemplateSetView> {
  const items = (await loadItems([setRow.id])).get(setRow.id) ?? [];
  return { ...setRow, items, ownerScope: ownerScopeOf(setRow) };
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export async function listTemplateSets(actor: TemplateActor, q: { orgId?: string } = {}): Promise<TemplateSetView[]> {
  const conditions: SQL[] = [];
  const visibility = visibilityCondition(actor);
  if (visibility) conditions.push(visibility);
  if (q.orgId !== undefined) {
    requireOrgAccess(actor, q.orgId);
    conditions.push(eq(deliverableTemplateSets.orgId, q.orgId));
  }
  const rows = await db.select().from(deliverableTemplateSets)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(deliverableTemplateSets.name));
  const items = await loadItems(rows.map((r) => r.id));
  return rows.map((row) => ({ ...row, items: items.get(row.id) ?? [], ownerScope: ownerScopeOf(row) }));
}

export async function getTemplateSet(setId: string, actor: TemplateActor): Promise<TemplateSetView> {
  return hydrate(await loadSetOr404(setId, actor));
}

/** Resolves the ONE owner axis a new set gets. Partner-wide creation is gated; org-owned is 404 on a foreign org. */
function resolveOwner(input: CreateTemplateSetInput, actor: TemplateActor): { orgId: string | null; partnerId: string | null } {
  if (input.ownerScope === 'partner') {
    if (!canManagePartnerWidePolicies(actor)) throw new PartnerWideWriteDeniedError();
    if (!actor.partnerId) throw new TemplateServiceError('A partner context is required to create a partner-wide template set', 400, 'PARTNER_CONTEXT_REQUIRED');
    return { orgId: null, partnerId: actor.partnerId };
  }
  const orgId = input.orgId ?? (actor.accessibleOrgIds?.length === 1 ? actor.accessibleOrgIds[0]! : undefined);
  if (!orgId) throw new TemplateServiceError('orgId is required for an organization-owned template set', 400, 'ORG_REQUIRED');
  requireOrgAccess(actor, orgId);
  return { orgId, partnerId: null };
}

export async function createTemplateSet(input: CreateTemplateSetInput, actor: TemplateActor): Promise<TemplateSetView> {
  const owner = resolveOwner(input, actor);
  try {
    // Nested transaction = SAVEPOINT under the request's own transaction, so a
    // 23505 rolls back only this write and the mapped 409 survives commit
    // (same lesson as serviceDeliverableService.assertNameAvailable).
    return await db.transaction(async (tx) => {
      const [setRow] = await tx.insert(deliverableTemplateSets).values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: input.name,
        description: input.description ?? null,
        createdBy: actor.userId,
      }).returning();
      if (!setRow) throw new TemplateServiceError('Insert returned no row', 500, 'INSERT_FAILED');
      const items: TemplateItemView[] = [];
      for (const item of input.items ?? []) {
        // Owner columns are ALWAYS copied from the resolved set, never taken
        // from input — that is what keeps the two branch FKs satisfiable.
        const [itemRow] = await tx.insert(deliverableTemplateItems).values({
          setId: setRow.id,
          orgId: owner.orgId,
          partnerId: owner.partnerId,
          name: item.name,
          description: item.description ?? null,
          cadence: item.cadence,
          leadDays: item.leadDays,
          graceDays: item.graceDays,
          artifactRequired: item.artifactRequired,
          completionMode: item.completionMode,
          sortOrder: item.sortOrder,
        }).returning();
        if (itemRow) items.push(itemRow);
      }
      return { ...setRow, items, ownerScope: ownerScopeOf(setRow) };
    });
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function updateTemplateSet(setId: string, patch: UpdateTemplateSetInput, actor: TemplateActor): Promise<TemplateSetView> {
  const existing = await loadSetOr404(setId, actor);
  requireWritable(existing, actor);
  try {
    const [row] = await db.transaction(async (tx) => tx.update(deliverableTemplateSets)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(deliverableTemplateSets.id, existing.id))
      .returning());
    if (!row) throw notFound();
    return hydrate(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function deleteTemplateSet(setId: string, actor: TemplateActor): Promise<void> {
  const existing = await loadSetOr404(setId, actor);
  requireWritable(existing, actor);
  // Items ride the two branch FKs (ON DELETE CASCADE).
  await db.delete(deliverableTemplateSets).where(eq(deliverableTemplateSets.id, existing.id));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function addTemplateItem(setId: string, input: CreateTemplateItemInput, actor: TemplateActor): Promise<TemplateItemView> {
  const set = await loadSetOr404(setId, actor);
  requireWritable(set, actor);
  try {
    const [row] = await db.transaction(async (tx) => tx.insert(deliverableTemplateItems).values({
      setId: set.id,
      orgId: set.orgId,
      partnerId: set.partnerId,
      name: input.name,
      description: input.description ?? null,
      cadence: input.cadence,
      leadDays: input.leadDays,
      graceDays: input.graceDays,
      artifactRequired: input.artifactRequired,
      completionMode: input.completionMode,
      sortOrder: input.sortOrder,
    }).returning());
    if (!row) throw new TemplateServiceError('Insert returned no row', 500, 'INSERT_FAILED');
    return row;
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function updateTemplateItem(setId: string, itemId: string, patch: UpdateTemplateItemInput, actor: TemplateActor): Promise<TemplateItemView> {
  const set = await loadSetOr404(setId, actor);
  requireWritable(set, actor);
  try {
    const [row] = await db.transaction(async (tx) => tx.update(deliverableTemplateItems)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
        ...(patch.leadDays !== undefined ? { leadDays: patch.leadDays } : {}),
        ...(patch.graceDays !== undefined ? { graceDays: patch.graceDays } : {}),
        ...(patch.artifactRequired !== undefined ? { artifactRequired: patch.artifactRequired } : {}),
        ...(patch.completionMode !== undefined ? { completionMode: patch.completionMode } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(deliverableTemplateItems.id, itemId), eq(deliverableTemplateItems.setId, set.id)))
      .returning());
    if (!row) throw notFound();
    return row;
  } catch (err) {
    mapUniqueViolation(err);
  }
}

// ---------------------------------------------------------------------------
// Apply (spec §4.6 D9 — copy on apply)
// ---------------------------------------------------------------------------

export interface AppliedTemplateResult {
  setId: string;
  setName: string;
  orgId: string;
  contractId: string | null;
  effectiveFrom: string;
  created: Array<{ id: string; name: string; cadence: Cadence; anchorDueDate: string }>;
  skipped: string[];
}

/**
 * Copy every item of a template set into one organization as scheduled
 * deliverables, all-or-nothing.
 *
 * Applying does NOT require canManagePartnerWidePolicies: reading a
 * partner-wide set and copying it into an org you can already administer is a
 * READ of the template plus an org write, not an edit of partner-wide state.
 */
export async function applyTemplateSet(
  orgId: string,
  setId: string,
  opts: { contractId?: string; effectiveFrom?: string; ownerUserId?: string; onCollision?: 'reject' | 'skip' },
  actor: TemplateActor,
): Promise<AppliedTemplateResult> {
  requireOrgAccess(actor, orgId);
  const set = await loadSetOr404(setId, actor);
  const items = await db.select().from(deliverableTemplateItems)
    .where(eq(deliverableTemplateItems.setId, set.id))
    .orderBy(asc(deliverableTemplateItems.sortOrder), asc(deliverableTemplateItems.name));

  const contractId = opts.contractId ?? null;
  let contractStart: string | null = null;
  if (contractId) {
    const [row] = await db.select({ startDate: contracts.startDate }).from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.orgId, orgId))).limit(1);
    if (!row) throw new TemplateServiceError('Contract does not belong to this organization', 400, 'CONTRACT_NOT_IN_ORG');
    contractStart = row.startDate;
  }
  // Spec D1: effective_from defaults to the contract start when attached, else today.
  const effectiveFrom = opts.effectiveFrom ?? contractStart ?? new Date().toISOString().slice(0, 10);

  const names = items.map((i) => i.name);
  const collisions = names.length === 0 ? [] : (await db
    .select({ name: serviceDeliverables.name }).from(serviceDeliverables)
    .where(and(
      eq(serviceDeliverables.orgId, orgId),
      // Mirrors service_deliverables_org_contract_name_uq, whose contract axis
      // is COALESCE(contract_id, nil).
      contractId ? eq(serviceDeliverables.contractId, contractId) : isNull(serviceDeliverables.contractId),
      inArray(serviceDeliverables.name, names),
    ))).map((r) => r.name);

  if (collisions.length > 0 && (opts.onCollision ?? 'reject') === 'reject') {
    throw new TemplateServiceError(
      `These deliverables already exist on the target: ${collisions.join(', ')}`,
      409, 'TEMPLATE_NAME_COLLISION', { collisions },
    );
  }
  const skipped = new Set(collisions);
  const toCreate = items.filter((i) => !skipped.has(i.name));

  const deliverableActor = { userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds };

  // All-or-nothing: every createDeliverable runs on the SAME tx handle, so a
  // failure on item 7 of 8 leaves no partial schedule behind. Nested under the
  // request transaction this is a SAVEPOINT, so a mapped 409 survives commit.
  let created: AppliedTemplateResult['created'];
  try {
    created = await db.transaction(async (tx) => {
      const out: AppliedTemplateResult['created'] = [];
      for (const item of toCreate) {
        const anchorDueDate = firstAnchorAfter(effectiveFrom, item.cadence as Cadence);
        const row = await createDeliverable(orgId, {
          contractId: contractId ?? undefined,
          name: item.name,
          description: item.description ?? undefined,
          cadence: item.cadence as Cadence,
          anchorDueDate,
          effectiveFrom,
          leadDays: item.leadDays,
          graceDays: item.graceDays,
          artifactRequired: item.artifactRequired,
          completionMode: item.completionMode,
          ownerUserId: opts.ownerUserId ?? undefined,
          portalVisible: true,
          sortOrder: item.sortOrder,
        }, deliverableActor, tx);
        out.push({ id: row.id, name: row.name, cadence: row.cadence as Cadence, anchorDueDate });
      }
      return out;
    });
  } catch (err) {
    mapApplyError(err);
  }

  return { setId: set.id, setName: set.name, orgId, contractId, effectiveFrom, created, skipped: [...skipped] };
}

/**
 * A concurrent apply races past the pre-check and hits
 * service_deliverables_org_contract_name_uq (or trips W01's own DUPLICATE_NAME
 * pre-check); give the caller one error shape.
 */
function mapApplyError(err: unknown): never {
  const duplicate = isPgUniqueViolation(err)
    || (err instanceof DeliverableServiceError && err.code === 'DUPLICATE_NAME');
  if (duplicate) {
    // The caller-facing payload cannot name the loser (the index error carries
    // no row), so record the constraint server-side for the forensic trail.
    console.warn('[deliverableTemplateService] applyTemplateSet lost a concurrent-apply race', {
      constraint: isPgUniqueViolation(err) ? pgErrorConstraint(err) : 'DUPLICATE_NAME pre-check',
    });
    throw new TemplateServiceError(
      'A deliverable with one of these names already exists on the target',
      409, 'TEMPLATE_NAME_COLLISION', { collisions: [] },
    );
  }
  throw err;
}

export async function removeTemplateItem(setId: string, itemId: string, actor: TemplateActor): Promise<void> {
  const set = await loadSetOr404(setId, actor);
  requireWritable(set, actor);
  const [row] = await db.delete(deliverableTemplateItems)
    .where(and(eq(deliverableTemplateItems.id, itemId), eq(deliverableTemplateItems.setId, set.id)))
    .returning({ id: deliverableTemplateItems.id });
  if (!row) throw notFound();
}
