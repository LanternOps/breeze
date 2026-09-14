import { z } from 'zod';

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

export const CHECKLIST_ITEM_SOURCES = ['manual', 'deliverable', 'checklist_template'] as const;
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

export type ChecklistItemSource = z.infer<typeof checklistItemSourceSchema>;
export type ChecklistItemCreateInput = z.infer<typeof checklistItemCreateSchema>;
export type ChecklistItemPatchInput = z.infer<typeof checklistItemPatchSchema>;
export type ChecklistReorderInput = z.infer<typeof checklistReorderSchema>;
