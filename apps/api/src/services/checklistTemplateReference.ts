import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  ticketChecklistTemplates,
  serviceDeliverables,
  deliverableTemplateItems,
} from '../db/schema';
import type { DbExecutor } from './ticketChecklistService';

/**
 * The single source of the checklist-template REFERENCE rules (#5808 W03,
 * spec §4.4).
 *
 * Three writers need them — `createDeliverable`/`updateDeliverable`, the
 * deliverable-template item routes, and `applyTemplateSet` — and three copies
 * would drift. The foreign key cannot enforce them: it is single-column on
 * purpose, because a composite `(checklist_template_id, org_id)` FK can never
 * match a partner-wide template (`org_id` NULL vs `service_deliverables.org_id`
 * NOT NULL). The full argument lives in the header of migration
 * `2026-10-16-192300-deliverable-checklist-wiring.sql`.
 *
 * Every function takes an optional executor so a caller already inside a
 * transaction passes its own handle rather than checking out a SECOND pooled
 * connection under an open transaction — the hang-at-concurrency shape
 * CLAUDE.md warns about.
 *
 * Errors carry `status` + `code` structurally. Every route error mapper that
 * can see them (`handleDeliverableError`, `handleTemplateError`,
 * `handleChecklistTemplateError`) matches on that shape rather than
 * `instanceof`, so this module needs no registration anywhere.
 */
export class ChecklistReferenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ChecklistReferenceError';
  }
}

/**
 * 404, never 403: a template belonging to another tenant and one that does not
 * exist must be indistinguishable, or the status code itself becomes an
 * existence oracle for another MSP's template ids.
 */
const notFound = () => new ChecklistReferenceError('Checklist template not found', 404, 'NOT_FOUND');

type TemplateOwner = { orgId: string | null; partnerId: string | null };

async function loadTemplateOwner(
  templateId: string,
  exec: DbExecutor = db,
): Promise<TemplateOwner | undefined> {
  const [row] = (await exec
    .select({
      orgId: ticketChecklistTemplates.orgId,
      partnerId: ticketChecklistTemplates.partnerId,
    })
    .from(ticketChecklistTemplates)
    .where(eq(ticketChecklistTemplates.id, templateId))
    .limit(1)) as TemplateOwner[];
  return row;
}

/**
 * An ORG-scoped row may reference its own org's template, or its partner's
 * partner-wide one — and nothing else.
 */
export async function assertChecklistTemplateUsableByOrg(
  templateId: string,
  orgId: string,
  partnerId: string | null,
  exec: DbExecutor = db,
): Promise<void> {
  const t = await loadTemplateOwner(templateId, exec);
  if (!t) throw notFound();
  if (t.orgId !== null) {
    if (t.orgId !== orgId) throw notFound();
    return;
  }
  if (partnerId === null || t.partnerId !== partnerId) throw notFound();
}

/**
 * A DELIVERABLE TEMPLATE ITEM's reference must not narrow the owner axis.
 *
 * A partner-wide item may reference ONLY a partner-wide template of the same
 * partner. An org-owned template would be invisible to every other org the set
 * is applied to, and the apply would then silently produce an empty checklist
 * rather than an error — the worst available outcome.
 */
export async function assertChecklistTemplateUsableByTemplateItemOwner(
  templateId: string,
  owner: TemplateOwner,
  exec: DbExecutor = db,
): Promise<void> {
  if (owner.orgId !== null) {
    return assertChecklistTemplateUsableByOrg(templateId, owner.orgId, owner.partnerId, exec);
  }
  const t = await loadTemplateOwner(templateId, exec);
  if (!t) throw notFound();
  if (t.orgId !== null) throw notFound(); // org-owned: refused for a partner-wide item
  if (owner.partnerId === null || t.partnerId !== owner.partnerId) throw notFound();
}

/**
 * Every row that points at this template. Capped at 50 per side: the caller
 * only needs enough to name what is in the way, and an unbounded list on a
 * heavily-used template would be a large error body for no benefit.
 *
 * Both queries ride the partial indexes added by migration 2026-10-16-192300,
 * because this runs on every template delete.
 */
export async function findChecklistTemplateReferences(templateId: string): Promise<{
  deliverables: Array<{ id: string; name: string }>;
  templateItems: Array<{ id: string; name: string }>;
}> {
  const [deliverables, templateItems] = await Promise.all([
    db
      .select({ id: serviceDeliverables.id, name: serviceDeliverables.name })
      .from(serviceDeliverables)
      .where(eq(serviceDeliverables.checklistTemplateId, templateId))
      .limit(50),
    db
      .select({ id: deliverableTemplateItems.id, name: deliverableTemplateItems.name })
      .from(deliverableTemplateItems)
      .where(eq(deliverableTemplateItems.checklistTemplateId, templateId))
      .limit(50),
  ]);
  return { deliverables, templateItems };
}

/**
 * Deleting a referenced template would `SET NULL` the pointer (the FK's last
 * line of defence) and silently empty every FUTURE occurrence's checklist — no
 * error, no signal, discovered weeks later by a customer. Refuse, and name what
 * is in the way.
 *
 * `is_active = false` is the supported retirement path: existing references
 * keep working and the template stops appearing in pickers.
 */
export async function assertChecklistTemplateNotInUse(templateId: string): Promise<void> {
  const refs = await findChecklistTemplateReferences(templateId);
  if (refs.deliverables.length === 0 && refs.templateItems.length === 0) return;
  throw new ChecklistReferenceError(
    'This checklist template is still used by a deliverable or a deliverable template item. Deactivate it instead of deleting it.',
    409,
    'CHECKLIST_TEMPLATE_IN_USE',
    refs,
  );
}
