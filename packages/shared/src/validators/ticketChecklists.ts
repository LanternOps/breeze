import { z } from 'zod';
import { optionalQueryBoolean } from './queryParams';

/**
 * Ticket checklists (spec #5783 §4.1, §6.1).
 *
 * `done_at` and `done_by_user_id` are deliberately ABSENT from every schema
 * here. They are the human attestation that a step was performed and are
 * computed server-side from the authenticated principal and now(); a body that
 * could set them would let a caller forge a compliance record. `.strict()` is
 * what actually enforces that — a non-strict object would silently drop the
 * extra keys instead of rejecting the request.
 *
 * `position` is likewise absent: ordering is whole-list only
 * (POST /tickets/:id/checklist/reorder), so two concurrent reorders cannot
 * interleave into a half-order.
 */

/**
 * `ticket_checklist_items.source`. APPEND-ONLY: these are Postgres enum labels
 * with ordinals, added by migration, and a shipped label can never be removed.
 *
 * `operator_task` (Recipe Library spec §5.3, wave E3) marks a step an AI
 * Operator `human_work` step created and is waiting on. The Operator CREATES
 * such rows and never completes them — completion stays a human attestation
 * (§6.5), enforced by `apps/api/src/services/aiOperator/humanWorkPurity.test.ts`.
 */
export const CHECKLIST_ITEM_SOURCES = [
  'manual',
  'deliverable',
  'checklist_template',
  'operator_task',
] as const;
export const checklistItemSourceSchema = z.enum(CHECKLIST_ITEM_SOURCES);

const label = z.string().min(1).max(500);
const detail = z.string().max(2000).nullable();

export const checklistItemCreateSchema = z
  .object({
    label,
    detail: detail.optional(),
  })
  .strict();

export const checklistItemPatchSchema = z
  .object({
    label: label.optional(),
    detail: detail.optional(),
    /** true ticks the step, false clears it. Never a timestamp. */
    done: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one of label, detail or done is required',
  });

export const checklistReorderSchema = z
  .object({
    /** The COMPLETE ordered id list for the ticket. A partial list is a 400. */
    itemIds: z.array(z.string().guid()).min(1).max(500),
  })
  .strict();

/**
 * Ticket checklist TEMPLATES (spec #5783 §4.2, §4.3, §6.2).
 *
 * `ownerScope` is create-only. Ownership is org XOR partner in the database and
 * re-homing a template across that axis would silently hand one org's private
 * procedure to every org under the partner (or the reverse), so the update
 * schema omits it — CLAUDE.md "Partner-Wide First" step 2.
 *
 * `partnerId` is never accepted from a body: the server derives it from the
 * caller's own token and gates partner-wide creation on
 * `canManagePartnerWidePolicies`.
 */
export const checklistTemplateOwnerScopeSchema = z.enum(['organization', 'partner']);

const templateItemLabel = z.string().min(1).max(500);
const templateItemDetail = z.string().max(2000).nullable();
const templateItemSortOrder = z.number().int().min(0);

export const createChecklistTemplateItemSchema = z
  .object({
    label: templateItemLabel,
    detail: templateItemDetail.optional(),
    sortOrder: templateItemSortOrder.default(0),
  })
  .strict();

/**
 * Defaults live only on the CREATE shape. `.partial()` does NOT strip a
 * `.default()` — an absent key still resolves to the default — so deriving the
 * update schema from the defaulted fields would make `PATCH { label }` silently
 * reset sortOrder to 0.
 */
export const updateChecklistTemplateItemSchema = z
  .object({
    label: templateItemLabel,
    detail: templateItemDetail,
    sortOrder: templateItemSortOrder,
  })
  .partial()
  .strict();

export const createChecklistTemplateSchema = z
  .object({
    /** Create-only. See the module note above. */
    ownerScope: checklistTemplateOwnerScopeSchema.default('organization'),
    orgId: z.string().guid().optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    /** Internal runbook prose. Never rendered in the customer portal (spec §5). */
    instructions: z.string().max(10000).nullable().optional(),
    items: z.array(createChecklistTemplateItemSchema).max(100).default([]),
  })
  .strict();

/**
 * `ownerScope`, `orgId` and `items` are omitted deliberately: the first two
 * would re-home a template across the ownership axis, and items are managed
 * through the item routes so their ownership stays derivable from the parent.
 */
export const updateChecklistTemplateSchema = createChecklistTemplateSchema
  .omit({ ownerScope: true, orgId: true, items: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .strict();

export const checklistTemplateItemReorderSchema = z
  .object({
    /** The COMPLETE ordered id list for the template. A partial list is a 400. */
    itemIds: z.array(z.string().guid()).min(1).max(500),
  })
  .strict();

export const listChecklistTemplatesQuerySchema = z
  .object({
    orgId: z.string().guid().optional(),
    // optionalQueryBoolean, never z.coerce.boolean(): the latter treats every
    // non-empty string as true, so `?includeInactive=false` would read as true.
    // Enforced by packages/shared/src/validators/queryParams.test.ts.
    includeInactive: optionalQueryBoolean,
  })
  .strict();

export const applyChecklistTemplateSchema = z
  .object({
    templateId: z.string().guid(),
    /**
     * `append` adds the template's steps after whatever is already there.
     * `replace_unticked` drops items with done_at IS NULL and then appends.
     * There is deliberately NO destructive mode: a ticked item is a human
     * attestation and is never dropped by applying a template (spec §3.3).
     */
    mode: z.enum(['append', 'replace_unticked']).default('append'),
  })
  .strict();

export type ChecklistItemSource = z.infer<typeof checklistItemSourceSchema>;
export type ChecklistItemCreateInput = z.infer<typeof checklistItemCreateSchema>;
export type ChecklistItemPatchInput = z.infer<typeof checklistItemPatchSchema>;
export type ChecklistReorderInput = z.infer<typeof checklistReorderSchema>;
export type ChecklistTemplateOwnerScope = z.infer<typeof checklistTemplateOwnerScopeSchema>;
export type CreateChecklistTemplateInput = z.infer<typeof createChecklistTemplateSchema>;
export type UpdateChecklistTemplateInput = z.infer<typeof updateChecklistTemplateSchema>;
export type CreateChecklistTemplateItemInput = z.infer<typeof createChecklistTemplateItemSchema>;
export type UpdateChecklistTemplateItemInput = z.infer<typeof updateChecklistTemplateItemSchema>;
export type ChecklistTemplateItemReorderInput = z.infer<typeof checklistTemplateItemReorderSchema>;
export type ListChecklistTemplatesQuery = z.infer<typeof listChecklistTemplatesQuerySchema>;
export type ApplyChecklistTemplateInput = z.infer<typeof applyChecklistTemplateSchema>;
