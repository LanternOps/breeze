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
    portalVisible: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(effectiveRange, effectiveRangeMessage);

export const listDeliverablesQuerySchema = z.object({
  contractId: z.string().guid().optional(),
  includeInactive: optionalQueryBoolean,
});

export const reportRunEvidenceRefSchema = z.object({
  kind: z.literal('report_run'),
  reportRunId: z.string().guid(),
});
// W03 widens this union with { kind: 'document', documentId }.
export const evidenceRefSchema = z.discriminatedUnion('kind', [reportRunEvidenceRefSchema]);
export const addEvidenceSchema = evidenceRefSchema;

export const deliverOccurrenceSchema = z.object({
  note: z.string().max(4000).optional(),
  evidence: z.array(evidenceRefSchema).max(20).optional(),
});
export const waiveOccurrenceSchema = z.object({ reason: z.string().min(1).max(2000) });
export const rescheduleOccurrenceSchema = z.object({ dueAt: isoDate });
export const listOccurrencesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export type CreateDeliverableInput = z.infer<typeof createDeliverableSchema>;
export type UpdateDeliverableInput = z.infer<typeof updateDeliverableSchema>;
export type DeliverOccurrenceInput = z.infer<typeof deliverOccurrenceSchema>;
export type WaiveOccurrenceInput = z.infer<typeof waiveOccurrenceSchema>;
export type RescheduleOccurrenceInput = z.infer<typeof rescheduleOccurrenceSchema>;
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
