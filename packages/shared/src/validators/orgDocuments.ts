import { z } from 'zod';
import { optionalQueryBoolean } from './queryParams';

/**
 * Organization document library (service deliverables W03, spec #5573 §4.4/§10).
 * Keep the category list in step with the `org_document_category` pg enum
 * (apps/api/src/db/schema/orgDocuments.ts).
 */
export const orgDocumentCategorySchema = z.enum([
  'baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other',
]);

/** Multipart text parts and query strings arrive as strings. `z.coerce.boolean`
 *  would read the string 'false' as TRUE, so parse the two literals explicitly. */
const boolFromString = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().max(4000).nullable();

export const uploadDocumentMetaSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.optional(),
  category: orgDocumentCategorySchema.default('other'),
  // Fail closed: nothing reaches the customer portal unless asked for.
  portalVisible: boolFromString.default(false),
});

/** Replace takes the same metadata, every field optional and WITHOUT defaults:
 *  an omitted field is inherited from the document being replaced. */
export const replaceDocumentMetaSchema = z.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  category: orgDocumentCategorySchema.optional(),
  portalVisible: boolFromString.optional(),
});

export const updateDocumentSchema = z.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  category: orgDocumentCategorySchema.optional(),
  portalVisible: z.boolean().optional(),
}).strict().refine((p) => Object.keys(p).length > 0, { message: 'at least one field must be provided' });

export const listDocumentsQuerySchema = z.object({
  category: orgDocumentCategorySchema.optional(),
  // The canonical query-string boolean: `z.coerce.boolean()` reads 'false' as
  // TRUE (queryParams.ts), which would silently invert this filter.
  includeSuperseded: optionalQueryBoolean,
});

export type OrgDocumentCategory = z.infer<typeof orgDocumentCategorySchema>;
export type UploadDocumentMeta = z.infer<typeof uploadDocumentMetaSchema>;
export type ReplaceDocumentMeta = z.infer<typeof replaceDocumentMetaSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
