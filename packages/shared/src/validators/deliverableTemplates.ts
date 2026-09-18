import { z } from 'zod';

/**
 * Deliverable template sets and items (spec #5573 §4.6, D9). A set is owned by
 * ONE axis — an organization or the partner ("all orgs") — never both; the
 * server derives the owner columns and gates partner-wide writes on
 * canManagePartnerWidePolicies.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const templateOwnerScopeSchema = z.enum(['organization', 'partner']);

/**
 * #5784. The report types Breeze may generate on its own behalf as service-plan
 * evidence. HAND-PARALLEL to `MANAGED_EVIDENCE_REGISTRY` in
 * `apps/api/src/services/managedEvidenceRegistry.ts` (the shared validator
 * cannot import from apps/api); `managedEvidenceRegistry.test.ts` pins the two
 * together. W02 added the first member; W03 adds 'endpoint_management_review',
 * W04 'vulnerability_management' and W06 'identity_access_review', each
 * alongside its own enum migration. Later waves only APPEND to this tuple.
 */
export const MANAGED_EVIDENCE_REPORT_TYPES = [
  // #5784 W02 — Huntress threat detection review.
  'threat_detection_review',
  // #5784 W03 — Intune endpoint management review over the #5327 sync tables.
  'endpoint_management_review',
  // #5784 W04 — the vulnerability detail artifact.
  'vulnerability_management',
  // #5784 W06 — the identity and access review (interactive sign-ins).
  'identity_access_review',
] as const satisfies readonly string[];
export type ManagedEvidenceReportType = (typeof MANAGED_EVIDENCE_REPORT_TYPES)[number];

// The tuple is non-empty as of W02, so this is a real `z.enum` rather than
// W01's placeholder `z.custom` — the rejection message now names the allowed
// values instead of a generic refusal.
const managedEvidenceReportTypeSchema = z.enum(MANAGED_EVIDENCE_REPORT_TYPES);

// Defaults live only on the CREATE shape. `.partial()` does not strip a
// `.default()` — an absent key still resolves to the default — so deriving the
// update schema from the defaulted fields would make `PATCH { graceDays }`
// silently reset leadDays/artifactRequired/completionMode/sortOrder.
const templateItemFieldTypes = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  // Mirrors deliverableCadenceSchema in serviceDeliverables.ts (W01); kept as a
  // literal enum rather than an import so a cadence added to one file cannot
  // silently widen the other without a test noticing.
  cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'one_time']),
  leadDays: z.number().int().min(0).max(365),
  graceDays: z.number().int().min(0).max(365),
  artifactRequired: z.boolean(),
  completionMode: z.enum(['explicit', 'on_ticket_resolve']),
  // #5808 W03. Both are copied onto the deliverable by applyTemplateSet.
  // Neither carries a default, so they flow through `.partial()` into the
  // update schema unchanged and a PATCH can clear either with an explicit null.
  // The OWNER-AXIS rule on checklistTemplateId (a partner-wide item may point
  // only at a partner-wide template of the same partner) is not expressible in
  // Zod — it lives in services/checklistTemplateReference.ts.
  // `.optional()` like `description` above: absent means "leave it alone", an
  // explicit null clears it. Without it both would be REQUIRED on create.
  instructions: z.string().max(10000).nullable().optional(),
  checklistTemplateId: z.string().guid().nullable().optional(),
  sortOrder: z.number().int().min(0),
  /**
   * #5784. A managed evidence report TYPE, resolved to the target org's managed
   * definition at applyTemplateSet time. Deliberately NOT the full report_type
   * enum: only the managed evidence types can be provisioned on demand, and an
   * id could never be carried by a partner-wide item at all.
   */
  autoEvidenceReportType: managedEvidenceReportTypeSchema.nullable().optional(),
};

export const createTemplateItemSchema = z.object({
  ...templateItemFieldTypes,
  leadDays: templateItemFieldTypes.leadDays.default(7),
  graceDays: templateItemFieldTypes.graceDays.default(14),
  artifactRequired: templateItemFieldTypes.artifactRequired.default(true),
  completionMode: templateItemFieldTypes.completionMode.default('on_ticket_resolve'),
  sortOrder: templateItemFieldTypes.sortOrder.default(0),
});
export const updateTemplateItemSchema = z.object(templateItemFieldTypes).partial().strict();

export const createTemplateSetSchema = z.object({
  // Create-only. The server derives the partner from the caller's own token and
  // gates partner-wide creation on canManagePartnerWidePolicies.
  ownerScope: templateOwnerScopeSchema.default('organization'),
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  items: z.array(createTemplateItemSchema).max(50).default([]),
});

// CLAUDE.md "Partner-Wide First" step 2: an update schema derived via .partial()
// MUST omit ownerScope, or a PATCH could re-home a set onto the other axis.
// orgId and items are omitted for the same reason — items are managed through
// the item routes so ownership stays derivable from the parent.
export const updateTemplateSetSchema = createTemplateSetSchema
  .omit({ ownerScope: true, orgId: true, items: true })
  .partial()
  .strict();

export const listTemplateSetsQuerySchema = z.object({
  orgId: z.string().guid().optional(),
});

export const applyTemplateSetSchema = z.object({
  setId: z.string().guid(),
  contractId: z.string().guid().optional(),
  effectiveFrom: isoDate.optional(),
  ownerUserId: z.string().guid().optional(),
});

export type CreateTemplateItemInput = z.infer<typeof createTemplateItemSchema>;
export type UpdateTemplateItemInput = z.infer<typeof updateTemplateItemSchema>;
export type CreateTemplateSetInput = z.infer<typeof createTemplateSetSchema>;
export type UpdateTemplateSetInput = z.infer<typeof updateTemplateSetSchema>;
export type ApplyTemplateSetInput = z.infer<typeof applyTemplateSetSchema>;
export type TemplateOwnerScope = z.infer<typeof templateOwnerScopeSchema>;
