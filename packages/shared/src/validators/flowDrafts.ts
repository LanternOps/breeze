/**
 * Flows completion W01b (#12435): request bodies of the REST draft routes
 * (`POST /flows`, `PUT /flows/:id`, `DELETE /flows/:id`, `POST /flows/validate`).
 *
 * The document is any JSON object here: the catalog-aware validator owns its
 * shape, and an invalid document is a 422 carrying the validation, never a
 * 400. The slug is length-bounded only, so the service's `invalid_slug` (422)
 * stays the one answer for a malformed slug.
 *
 * Every schema is strict, so a body cannot smuggle a field the route does not
 * accept (an owner change on update, a `flowId` on create).
 */
import { z } from 'zod';

const documentField = z.record(z.string(), z.unknown());
const ownerScopeField = z.enum(['organization', 'partner']);
const versionField = z.number().int().min(1);

export const flowDraftCreateRequestSchema = z.strictObject({
  document: documentField,
  ownerScope: ownerScopeField.optional(),
  orgId: z.string().uuid().optional(),
  slug: z.string().min(1).max(200).optional(),
});
export type FlowDraftCreateRequest = z.infer<typeof flowDraftCreateRequestSchema>;

/** `expectedVersion` is required: a stale write is a 409, never a silent overwrite. */
export const flowDraftUpdateRequestSchema = z.strictObject({
  document: documentField,
  expectedVersion: versionField,
});
export type FlowDraftUpdateRequest = z.infer<typeof flowDraftUpdateRequestSchema>;

export const flowDraftDeleteRequestSchema = z.strictObject({
  expectedVersion: versionField,
});
export type FlowDraftDeleteRequest = z.infer<typeof flowDraftDeleteRequestSchema>;

/** With `flowId`, the server derives the owner from the row and ignores `ownerScope`/`orgId`. */
export const flowDraftValidateRequestSchema = z.strictObject({
  document: documentField,
  ownerScope: ownerScopeField.optional(),
  orgId: z.string().uuid().optional(),
  flowId: z.string().uuid().optional(),
});
export type FlowDraftValidateRequest = z.infer<typeof flowDraftValidateRequestSchema>;
