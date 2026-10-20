import { z } from 'zod';
import { optionalQueryBoolean } from './queryParams';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const deliverableCadenceSchema = z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'one_time']);
export const deliverableCompletionModeSchema = z.enum(['explicit', 'on_ticket_resolve']);

const effectiveRange = (d: { effectiveFrom?: string; effectiveUntil?: string | null }) =>
  d.effectiveUntil == null || d.effectiveFrom == null || d.effectiveUntil >= d.effectiveFrom;
const effectiveRangeMessage = { message: 'effectiveUntil must be on or after effectiveFrom', path: ['effectiveUntil'] };

export const createDeliverableSchema = z
  .object({
    contractId: z.string().guid().nullable().optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    cadence: deliverableCadenceSchema,
    anchorDueDate: isoDate,
    effectiveFrom: isoDate,
    effectiveUntil: isoDate.nullable().optional(),
    leadDays: z.number().int().min(0).max(365).default(7),
    graceDays: z.number().int().min(0).max(365).default(14),
    artifactRequired: z.boolean().default(true),
    completionMode: deliverableCompletionModeSchema.default('on_ticket_resolve'),
    autoEvidenceReportId: z.string().guid().nullable().optional(),
    ownerUserId: z.string().guid().nullable().optional(),
    ticketCategoryId: z.string().guid().nullable().optional(),
    // #5808 W03. Internal runbook prose for the technician — NEVER shown to the
    // customer (spec §5). The pointer is a live reference: editing the template
    // improves every FUTURE occurrence, and already-opened ones keep the rows
    // they were seeded with.
    instructions: z.string().max(10000).nullable().optional(),
    checklistTemplateId: z.string().guid().nullable().optional(),
    portalVisible: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .refine(effectiveRange, effectiveRangeMessage);

// Written out longhand rather than derived from the create fields: cadence and
// anchorDueDate are deliberately absent (spec §16 — history is not rewritten),
// and no field carries a default on update.
export const updateDeliverableSchema = z
  .object({
    contractId: z.string().guid().nullable().optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    effectiveFrom: isoDate.optional(),
    effectiveUntil: isoDate.nullable().optional(),
    leadDays: z.number().int().min(0).max(365).optional(),
    graceDays: z.number().int().min(0).max(365).optional(),
    artifactRequired: z.boolean().optional(),
    completionMode: deliverableCompletionModeSchema.optional(),
    autoEvidenceReportId: z.string().guid().nullable().optional(),
    ownerUserId: z.string().guid().nullable().optional(),
    ticketCategoryId: z.string().guid().nullable().optional(),
    // #5808 W03. Internal runbook prose for the technician — NEVER shown to the
    // customer (spec §5). The pointer is a live reference: editing the template
    // improves every FUTURE occurrence, and already-opened ones keep the rows
    // they were seeded with.
    instructions: z.string().max(10000).nullable().optional(),
    checklistTemplateId: z.string().guid().nullable().optional(),
    portalVisible: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(effectiveRange, effectiveRangeMessage);

export const listDeliverablesQuerySchema = z.object({
  contractId: z.string().guid().optional(),
  // W03: was z.coerce.boolean(), which reads the string 'false' as TRUE and so
  // inverted `?includeInactive=false` (queryParams.ts, and the repo-wide guard
  // in queryParams.test.ts).
  includeInactive: optionalQueryBoolean,
});

export const reportRunEvidenceRefSchema = z.object({
  kind: z.literal('report_run'),
  reportRunId: z.string().guid(),
});
export const documentEvidenceRefSchema = z.object({
  kind: z.literal('document'),
  documentId: z.string().guid(),
});
/** #9312: a signed agreement already stored in Breeze (contract_documents),
 *  linked by reference — never copied into the document library. */
export const contractDocumentEvidenceRefSchema = z.object({
  kind: z.literal('contract_document'),
  contractDocumentId: z.string().guid(),
});
// Every arm of deliverable_evidence_kind is reachable from the API.
export const evidenceRefSchema = z.discriminatedUnion('kind', [
  reportRunEvidenceRefSchema, documentEvidenceRefSchema, contractDocumentEvidenceRefSchema,
]);
export const addEvidenceSchema = evidenceRefSchema;

// #9302. Bulk move of deliverables onto another contract (null = standalone).
export const moveDeliverablesSchema = z.object({
  deliverableIds: z.array(z.string().guid()).min(1).max(200),
  contractId: z.string().guid().nullable(),
});

export const deliverOccurrenceSchema = z.object({
  note: z.string().max(4000).optional(),
  evidence: z.array(evidenceRefSchema).max(20).optional(),
});
export const waiveOccurrenceSchema = z.object({ reason: z.string().min(1).max(2000) });
export const rescheduleOccurrenceSchema = z.object({ dueAt: isoDate });
/** #9314 — move many occurrences at once: to one date, or by a day offset
 *  (exactly one of the two). Max 100 ids per request. */
export const bulkRescheduleOccurrencesSchema = z.object({
  occurrenceIds: z.array(z.string().guid()).min(1).max(100),
  dueAt: isoDate.optional(),
  shiftDays: z.number().int().min(-3650).max(3650).optional(),
}).refine((v) => (v.dueAt === undefined) !== (v.shiftDays === undefined), {
  message: 'Provide exactly one of dueAt or shiftDays',
});
export const listOccurrencesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export type CreateDeliverableInput = z.infer<typeof createDeliverableSchema>;
export type UpdateDeliverableInput = z.infer<typeof updateDeliverableSchema>;
export type MoveDeliverablesInput = z.infer<typeof moveDeliverablesSchema>;
export type DeliverOccurrenceInput = z.infer<typeof deliverOccurrenceSchema>;
export type WaiveOccurrenceInput = z.infer<typeof waiveOccurrenceSchema>;
export type RescheduleOccurrenceInput = z.infer<typeof rescheduleOccurrenceSchema>;
export type BulkRescheduleOccurrencesInput = z.infer<typeof bulkRescheduleOccurrencesSchema>;
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
