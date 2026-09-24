import { and, asc, eq, inArray, isNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  ticketChecklistItems,
  ticketChecklistTemplates,
  ticketChecklistTemplateItems,
  type TicketChecklistTemplateRow,
  type TicketChecklistTemplateItemRow,
} from '../db/schema';
import { aiOperatorTaskSteps } from '../db/schema/aiOperatorTaskGraph';
import type { AuthContext } from '../middleware/auth';
import type {
  ApplyChecklistTemplateInput,
  CreateChecklistTemplateInput,
  CreateChecklistTemplateItemInput,
  UpdateChecklistTemplateInput,
  UpdateChecklistTemplateItemInput,
} from '@breeze/shared';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';
import { isPgUniqueViolation, pgErrorConstraint } from '../utils/pgErrors';
import { listChecklist, type ChecklistSummary } from './ticketChecklistService';
import { assertChecklistTemplateNotInUse } from './checklistTemplateReference';
import { assertTicketUntickedChecklistItemsDeletable } from './aiOperator/humanWorkService';

/**
 * Ticket checklist templates (spec #5783 §4.2, §4.3, §6.2). Dual ownership per
 * CLAUDE.md "Partner-Wide First": org_id XOR partner_id. This module is the
 * ONLY writer of both tables.
 *
 * Three authorization rules live here and nowhere else:
 *
 * 1. Visibility is dual-axis and the partner arm is gated on
 *    `scope === 'partner'`. An org token carries a partnerId but never passes
 *    `breeze_has_partner_access`; RLS is stricter than the app layer here and
 *    this code must never claim parity.
 * 2. Partner-wide WRITES gate on `canManagePartnerWidePolicies`.
 * 3. APPLY deliberately does NOT (spec §6.2). Applying is a read of the source
 *    plus a write to the target, not partner-wide administration; requiring
 *    `partnerOrgAccess === 'all'` merely to *use* a shared checklist would make
 *    partner-wide templates useless to the technicians they exist for.
 *
 * And the rule that keeps apply tenant-safe: copied rows are stamped with the
 * TICKET's org_id, never the template's owner (which is NULL for a partner-wide
 * template).
 *
 * W03 (#5811) added the delete guard: `deleteChecklistTemplate` now refuses
 * with 409 `CHECKLIST_TEMPLATE_IN_USE` when a deliverable or a deliverable
 * template item points at the template, because the FKs are `ON DELETE SET
 * NULL` and a silently emptied future checklist is exactly the failure to
 * prevent. The rules themselves live in `./checklistTemplateReference`, shared
 * with the two deliverable writers.
 */

export interface ChecklistTemplateActor {
  userId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  scope: AuthContext['scope'];
  partnerOrgAccess?: AuthContext['partnerOrgAccess'];
}

export class ChecklistTemplateServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ChecklistTemplateServiceError';
  }
}

export interface ChecklistTemplateItemView {
  id: string;
  templateId: string;
  label: string;
  detail: string | null;
  sortOrder: number;
}

export interface ChecklistTemplateView {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  ownerScope: 'organization' | 'partner';
  name: string;
  description: string | null;
  instructions: string | null;
  isActive: boolean;
  items: ChecklistTemplateItemView[];
  createdAt: string;
}

const notFound = () => new ChecklistTemplateServiceError('Not found', 404, 'NOT_FOUND');

const toIso = (value: Date | string | null | undefined): string =>
  value instanceof Date
    ? value.toISOString()
    : value
      ? new Date(value).toISOString()
      : new Date(0).toISOString();

const ownerScopeOf = (row: Pick<TicketChecklistTemplateRow, 'orgId'>) =>
  row.orgId === null ? ('partner' as const) : ('organization' as const);

function itemView(row: TicketChecklistTemplateItemRow): ChecklistTemplateItemView {
  return {
    id: row.id,
    templateId: row.templateId,
    label: row.label,
    detail: row.detail,
    sortOrder: row.sortOrder,
  };
}

function templateView(
  row: TicketChecklistTemplateRow,
  items: ChecklistTemplateItemView[],
): ChecklistTemplateView {
  return {
    id: row.id,
    orgId: row.orgId,
    partnerId: row.partnerId,
    ownerScope: ownerScopeOf(row),
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    isActive: row.isActive,
    items,
    createdAt: toIso(row.createdAt),
  };
}

function requireOrgAccess(actor: ChecklistTemplateActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) throw notFound();
}

/**
 * App-layer dual-axis visibility.
 *
 * The partner-wide arm is added ONLY for a partner-scoped actor. An org token
 * carries a partnerId (`middleware/auth.ts` feeds it into
 * `DbAccessContext.currentPartnerId`), and the table's partner-wide SELECT
 * policy deliberately makes those rows readable from an org context — so this
 * gate is the ONLY authorization control on the partner axis, not a redundant
 * second one (`partnerWideAccess.ts` `canReadPartnerWideRows`, #4952).
 */
export function visibleChecklistTemplateCondition(
  actor: ChecklistTemplateActor,
): SQL | undefined {
  if (actor.accessibleOrgIds === null) return undefined; // system: everything
  const arms: SQL[] = [];
  if (actor.accessibleOrgIds.length > 0) {
    arms.push(inArray(ticketChecklistTemplates.orgId, actor.accessibleOrgIds));
  }
  if (actor.scope === 'partner' && actor.partnerId) {
    arms.push(
      and(
        isNull(ticketChecklistTemplates.orgId),
        eq(ticketChecklistTemplates.partnerId, actor.partnerId),
      )!,
    );
  }
  if (arms.length === 0) return sql`false`;
  return arms.length === 1 ? arms[0]! : or(...arms)!;
}

/**
 * The `?orgId=` narrowing filter, dual-axis for the same reason
 * `visibleChecklistTemplateCondition` is: the web `fetchWithAuth` wrapper pins
 * `orgId` on EVERY request once an org is open, so a bare `org_id = $1` would
 * hide every partner-wide template the moment a technician opens a ticket
 * (#5675) — the template would stop being listable AND stop being applicable.
 */
function orgFilterCondition(actor: ChecklistTemplateActor, orgId: string): SQL {
  const orgArm = eq(ticketChecklistTemplates.orgId, orgId);
  if (actor.scope !== 'partner' || !actor.partnerId) return orgArm;
  return or(
    orgArm,
    and(
      isNull(ticketChecklistTemplates.orgId),
      eq(ticketChecklistTemplates.partnerId, actor.partnerId),
    ),
  )!;
}

/** Visibility is not permission: a partner-wide row is administrable only by a full-partner admin. */
function requireWritable(
  row: Pick<TicketChecklistTemplateRow, 'orgId'>,
  actor: ChecklistTemplateActor,
): void {
  if (row.orgId === null && !canManagePartnerWidePolicies(actor)) {
    throw new PartnerWideWriteDeniedError();
  }
}

function mapUniqueViolation(err: unknown): never {
  if (isPgUniqueViolation(err)) {
    const constraint = pgErrorConstraint(err) ?? '';
    if (constraint.startsWith('ticket_checklist_template_items_template_label')) {
      throw new ChecklistTemplateServiceError(
        'A step with this label already exists in the template',
        409,
        'DUPLICATE_CHECKLIST_TEMPLATE_ITEM_LABEL',
      );
    }
    throw new ChecklistTemplateServiceError(
      'A checklist template with this name already exists',
      409,
      'DUPLICATE_CHECKLIST_TEMPLATE_NAME',
    );
  }
  throw err;
}

/** 404, never 403 — a template of another tenant and a non-existent one must be indistinguishable. */
export async function loadChecklistTemplateOr404(
  templateId: string,
  actor: ChecklistTemplateActor,
): Promise<TicketChecklistTemplateRow> {
  const [row] = (await db
    .select()
    .from(ticketChecklistTemplates)
    .where(
      and(eq(ticketChecklistTemplates.id, templateId), visibleChecklistTemplateCondition(actor)),
    )
    .limit(1)) as TicketChecklistTemplateRow[];
  if (!row) throw notFound();
  return row;
}

async function loadItems(templateIds: string[]): Promise<Map<string, ChecklistTemplateItemView[]>> {
  const byId = new Map<string, ChecklistTemplateItemView[]>();
  if (templateIds.length === 0) return byId;
  const rows = (await db
    .select()
    .from(ticketChecklistTemplateItems)
    .where(inArray(ticketChecklistTemplateItems.templateId, templateIds))
    .orderBy(
      asc(ticketChecklistTemplateItems.sortOrder),
      asc(ticketChecklistTemplateItems.label),
    )) as TicketChecklistTemplateItemRow[];
  for (const row of rows) {
    const list = byId.get(row.templateId) ?? [];
    list.push(itemView(row));
    byId.set(row.templateId, list);
  }
  return byId;
}

async function hydrate(row: TicketChecklistTemplateRow): Promise<ChecklistTemplateView> {
  return templateView(row, (await loadItems([row.id])).get(row.id) ?? []);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listChecklistTemplates(
  actor: ChecklistTemplateActor,
  opts: { orgId?: string; includeInactive?: boolean } = {},
): Promise<ChecklistTemplateView[]> {
  const conditions: SQL[] = [];
  const visibility = visibleChecklistTemplateCondition(actor);
  if (visibility) conditions.push(visibility);
  if (opts.orgId !== undefined) {
    requireOrgAccess(actor, opts.orgId);
    conditions.push(orgFilterCondition(actor, opts.orgId));
  }
  // Inactive templates stay linked where they are already used but drop out of
  // every picker — that is the whole point of the flag, so the default list
  // hides them.
  if (!opts.includeInactive) conditions.push(eq(ticketChecklistTemplates.isActive, true));

  const rows = (await db
    .select()
    .from(ticketChecklistTemplates)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(ticketChecklistTemplates.name))) as TicketChecklistTemplateRow[];
  const items = await loadItems(rows.map((r) => r.id));
  return rows.map((row) => templateView(row, items.get(row.id) ?? []));
}

export async function getChecklistTemplate(
  templateId: string,
  actor: ChecklistTemplateActor,
): Promise<ChecklistTemplateView> {
  return hydrate(await loadChecklistTemplateOr404(templateId, actor));
}

/** Resolves the ONE owner axis a new template gets. Partner-wide creation is gated; org-owned is 404 on a foreign org. */
function resolveOwner(
  input: CreateChecklistTemplateInput,
  actor: ChecklistTemplateActor,
): { orgId: string | null; partnerId: string | null } {
  if (input.ownerScope === 'partner') {
    if (!canManagePartnerWidePolicies(actor)) throw new PartnerWideWriteDeniedError();
    if (!actor.partnerId) {
      throw new ChecklistTemplateServiceError(
        'A partner context is required to create a partner-wide checklist template',
        400,
        'PARTNER_CONTEXT_REQUIRED',
      );
    }
    return { orgId: null, partnerId: actor.partnerId };
  }
  const orgId =
    input.orgId ?? (actor.accessibleOrgIds?.length === 1 ? actor.accessibleOrgIds[0]! : undefined);
  if (!orgId) {
    throw new ChecklistTemplateServiceError(
      'orgId is required for an organization-owned checklist template',
      400,
      'ORG_REQUIRED',
    );
  }
  requireOrgAccess(actor, orgId);
  return { orgId, partnerId: null };
}

export async function createChecklistTemplate(
  input: CreateChecklistTemplateInput,
  actor: ChecklistTemplateActor,
): Promise<ChecklistTemplateView> {
  const owner = resolveOwner(input, actor);
  try {
    // Nested transaction = SAVEPOINT under the request's own transaction, so a
    // 23505 rolls back only this write and the mapped 409 survives commit.
    return await db.transaction(async (tx) => {
      const [row] = (await tx
        .insert(ticketChecklistTemplates)
        .values({
          orgId: owner.orgId,
          partnerId: owner.partnerId,
          name: input.name,
          description: input.description ?? null,
          instructions: input.instructions ?? null,
          createdBy: actor.userId,
        })
        .returning()) as TicketChecklistTemplateRow[];
      if (!row) {
        throw new ChecklistTemplateServiceError('Insert returned no row', 500, 'INSERT_FAILED');
      }
      const items: ChecklistTemplateItemView[] = [];
      for (const item of input.items ?? []) {
        // Owner columns are ALWAYS copied from the resolved template, never
        // taken from input — that is what keeps the two branch FKs satisfiable.
        const [itemRow] = (await tx
          .insert(ticketChecklistTemplateItems)
          .values({
            templateId: row.id,
            orgId: owner.orgId,
            partnerId: owner.partnerId,
            label: item.label,
            detail: item.detail ?? null,
            sortOrder: item.sortOrder,
          })
          .returning()) as TicketChecklistTemplateItemRow[];
        // Throw rather than skip: silently returning a template with fewer
        // steps than the caller asked for would be a 200 that lies.
        if (!itemRow) {
          throw new ChecklistTemplateServiceError(
            'Item insert returned no row',
            500,
            'INSERT_FAILED',
          );
        }
        items.push(itemView(itemRow));
      }
      return templateView(row, items);
    });
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function updateChecklistTemplate(
  templateId: string,
  patch: UpdateChecklistTemplateInput,
  actor: ChecklistTemplateActor,
): Promise<ChecklistTemplateView> {
  const existing = await loadChecklistTemplateOr404(templateId, actor);
  requireWritable(existing, actor);
  try {
    const [row] = (await db
      .update(ticketChecklistTemplates)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions ?? null } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(ticketChecklistTemplates.id, existing.id))
      .returning()) as TicketChecklistTemplateRow[];
    if (!row) throw notFound();
    return hydrate(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function deleteChecklistTemplate(
  templateId: string,
  actor: ChecklistTemplateActor,
): Promise<void> {
  const existing = await loadChecklistTemplateOr404(templateId, actor);
  requireWritable(existing, actor);
  // ORDER MATTERS. The 404 (cannot see it) and the 403 (can see it, may not
  // write it) both come first: a 409 naming the referencing deliverables would
  // otherwise tell a caller who is not allowed to know that the template exists
  // and what uses it.
  //
  // #5808 W03 — deleting a referenced template would SET NULL the pointer and
  // silently empty every FUTURE occurrence's checklist. Deactivation
  // (`isActive: false`) is the supported retirement path.
  await assertChecklistTemplateNotInUse(existing.id);
  // Items ride the two branch FKs (both ON DELETE CASCADE).
  await db.delete(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, existing.id));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function addChecklistTemplateItem(
  templateId: string,
  input: CreateChecklistTemplateItemInput,
  actor: ChecklistTemplateActor,
): Promise<ChecklistTemplateItemView> {
  const template = await loadChecklistTemplateOr404(templateId, actor);
  requireWritable(template, actor);
  try {
    const [row] = (await db
      .insert(ticketChecklistTemplateItems)
      .values({
        templateId: template.id,
        // Copied from the parent, never from input — the branch FKs depend on it.
        orgId: template.orgId,
        partnerId: template.partnerId,
        label: input.label,
        detail: input.detail ?? null,
        sortOrder: input.sortOrder,
      })
      .returning()) as TicketChecklistTemplateItemRow[];
    if (!row) {
      throw new ChecklistTemplateServiceError('Insert returned no row', 500, 'INSERT_FAILED');
    }
    return itemView(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

async function loadItemOr404(
  itemId: string,
  actor: ChecklistTemplateActor,
): Promise<{ item: TicketChecklistTemplateItemRow; template: TicketChecklistTemplateRow }> {
  const [item] = (await db
    .select()
    .from(ticketChecklistTemplateItems)
    .where(eq(ticketChecklistTemplateItems.id, itemId))
    .limit(1)) as TicketChecklistTemplateItemRow[];
  if (!item) throw notFound();
  // Authorization is decided on the PARENT, which carries the visibility
  // condition — an item row on its own would let a foreign-tenant id through
  // whenever RLS happened to be permissive on the read.
  const template = await loadChecklistTemplateOr404(item.templateId, actor);
  return { item, template };
}

export async function updateChecklistTemplateItem(
  itemId: string,
  patch: UpdateChecklistTemplateItemInput,
  actor: ChecklistTemplateActor,
): Promise<ChecklistTemplateItemView> {
  const { template } = await loadItemOr404(itemId, actor);
  requireWritable(template, actor);
  try {
    const [row] = (await db
      .update(ticketChecklistTemplateItems)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail ?? null } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(ticketChecklistTemplateItems.id, itemId))
      .returning()) as TicketChecklistTemplateItemRow[];
    if (!row) throw notFound();
    return itemView(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function removeChecklistTemplateItem(
  itemId: string,
  actor: ChecklistTemplateActor,
): Promise<void> {
  const { template } = await loadItemOr404(itemId, actor);
  requireWritable(template, actor);
  await db.delete(ticketChecklistTemplateItems).where(eq(ticketChecklistTemplateItems.id, itemId));
}

/**
 * Whole-list reorder in ONE statement, mirroring W01's `reorderChecklist`: two
 * concurrent reorders serialize at the row locks instead of interleaving into a
 * half-order, and a partial or foreign id list is refused before anything is
 * written.
 */
export async function reorderChecklistTemplateItems(
  templateId: string,
  itemIds: string[],
  actor: ChecklistTemplateActor,
): Promise<ChecklistTemplateItemView[]> {
  const template = await loadChecklistTemplateOr404(templateId, actor);
  requireWritable(template, actor);

  const current = (await db
    .select({ id: ticketChecklistTemplateItems.id })
    .from(ticketChecklistTemplateItems)
    .where(eq(ticketChecklistTemplateItems.templateId, template.id))) as Array<{ id: string }>;

  const currentSet = new Set(current.map((r) => r.id));
  const submitted = new Set(itemIds);
  const sameSet =
    submitted.size === itemIds.length &&
    currentSet.size === submitted.size &&
    [...submitted].every((id) => currentSet.has(id));

  if (!sameSet) {
    throw new ChecklistTemplateServiceError(
      "The reorder list must contain exactly the template's current items, once each",
      400,
      'CHECKLIST_TEMPLATE_REORDER_MISMATCH',
      { expected: current.length, received: itemIds.length },
    );
  }

  const values = sql.join(
    itemIds.map((id, index) => sql`(${id}::uuid, ${index}::int)`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE ticket_checklist_template_items AS t
       SET sort_order = v.pos, updated_at = NOW()
      FROM (VALUES ${values}) AS v(id, pos)
     WHERE t.id = v.id AND t.template_id = ${template.id}::uuid
  `);

  return (await loadItems([template.id])).get(template.id) ?? [];
}

// ---------------------------------------------------------------------------
// Apply to a ticket (spec §3.3, §6.1)
// ---------------------------------------------------------------------------

/**
 * Copy a template's steps onto one ticket.
 *
 * Deliberately NOT gated on `canManagePartnerWidePolicies` (spec §6.2, rule 3
 * in the module header).
 *
 * Every copied row is stamped with the TICKET's org_id — never the template's
 * owner, which is NULL for a partner-wide template. A partner-wide template
 * therefore produces org-scoped rows inside each customer's tenant and no
 * cross-tenant row is ever created.
 */
export async function applyChecklistTemplateToTicket(
  ticket: { id: string; orgId: string },
  input: ApplyChecklistTemplateInput,
  actor: ChecklistTemplateActor,
): Promise<ChecklistSummary> {
  const template = await loadChecklistTemplateOr404(input.templateId, actor);
  if (template.isActive === false) {
    throw new ChecklistTemplateServiceError(
      'This checklist template is inactive and can no longer be applied',
      409,
      'CHECKLIST_TEMPLATE_INACTIVE',
    );
  }

  const items = (await db
    .select()
    .from(ticketChecklistTemplateItems)
    .where(eq(ticketChecklistTemplateItems.templateId, template.id))
    .orderBy(
      asc(ticketChecklistTemplateItems.sortOrder),
      asc(ticketChecklistTemplateItems.label),
    )) as TicketChecklistTemplateItemRow[];

  await db.transaction(async (tx) => {
    if (input.mode === 'replace_unticked') {
      // An unticked item a running Operator step waits on is guarded exactly
      // as a single delete is (assertChecklistItemDeletable): the FK is ON
      // DELETE SET NULL, so nothing below would refuse it.
      await assertTicketUntickedChecklistItemsDeletable(ticket.id, tx);
      // ONLY unticked rows. A ticked item carries done_at/done_by_user_id — a
      // human attestation that the step was performed — and applying a template
      // must never destroy one. There is no destructive mode by design.
      //
      // The pre-check above is a plain read, so it cannot see an Operator
      // item committed after it runs. The NOT EXISTS below is what ENFORCES
      // the rule, against the DELETE statement's own snapshot (READ
      // COMMITTED). A human-work item and its waiting link are committed
      // together (humanWorkService opens both in one transaction), so an
      // item committed BEFORE this statement starts is visible together with
      // its waiting step and is excluded here, and one committed AFTER it
      // starts is not visible to this statement at all. The pre-check stays
      // for the readable 409 in the common case.
      await tx
        .delete(ticketChecklistItems)
        .where(
          and(
            eq(ticketChecklistItems.ticketId, ticket.id),
            isNull(ticketChecklistItems.doneAt),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(aiOperatorTaskSteps)
                .where(and(
                  eq(aiOperatorTaskSteps.checklistItemId, ticketChecklistItems.id),
                  eq(aiOperatorTaskSteps.state, 'waiting'),
                )),
            ),
          ),
        );
      // The NOT EXISTS can leave a waited-on item in place (the race above).
      // A replace that quietly kept an old step would be a partial replace,
      // so re-check on this statement's fresh snapshot and refuse: the
      // throw rolls the whole apply back, delete included.
      await assertTicketUntickedChecklistItemsDeletable(ticket.id, tx);
    }

    const [agg] = (await tx
      .select({ maxPosition: sql<number | null>`MAX(${ticketChecklistItems.position})` })
      .from(ticketChecklistItems)
      .where(eq(ticketChecklistItems.ticketId, ticket.id))) as Array<{
      maxPosition: number | null;
    }>;
    let position = (agg?.maxPosition ?? -1) + 1;

    if (items.length > 0) {
      await tx.insert(ticketChecklistItems).values(
        items.map((it) => ({
          // The TICKET's org. NEVER template.orgId, which is NULL for a
          // partner-wide template.
          orgId: ticket.orgId,
          ticketId: ticket.id,
          label: it.label,
          detail: it.detail,
          position: position++,
          source: 'checklist_template' as const,
          sourceTemplateItemId: it.id,
          createdBy: actor.userId,
        })),
      );
    }
  });

  return listChecklist(ticket.id);
}
