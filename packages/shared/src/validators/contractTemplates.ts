import { z } from 'zod';

// Contract template library (docs/superpowers/specs/2026-07-16-contract-documents-and-enhanced-proposals-design.md).
// Partner-Wide First shape (epic #2135), mirroring backupTargets.ts /
// ticketForms.ts: org_id XOR partner_id, ownership axis fixed at create time.
//
// The XOR pairing is enforced here (not just server-side/DB CHECK) so a
// mismatched create payload is a 400 at the boundary, not a 500 from the
// contract_templates_one_owner_chk constraint. Zod4 forbids `.partial()` on a
// schema carrying a refinement, so the ownership axis + refine live only on
// `createContractTemplateSchema`; `updateContractTemplateSchema` is derived
// from the refinement-free base shape (name/description are immutable-axis-
// free anyway — ownership can never change post-create).
const contractTemplateShape = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  // Partner-wide creation is gated on canManagePartnerWidePolicies server-side
  // (services/partnerWideAccess.ts) — this schema only shapes the payload.
  ownerScope: z.enum(['organization', 'partner']),
  orgId: z.string().guid().optional(),
});

export const createContractTemplateSchema = contractTemplateShape.superRefine((data, ctx) => {
  if (data.ownerScope === 'organization' && !data.orgId) {
    ctx.addIssue({
      code: 'custom',
      path: ['orgId'],
      message: 'orgId is required when ownerScope is "organization"',
    });
  }
  if (data.ownerScope === 'partner' && data.orgId) {
    ctx.addIssue({
      code: 'custom',
      path: ['orgId'],
      message: 'orgId must not be set when ownerScope is "partner"',
    });
  }
});

// Ownership (ownerScope/orgId) is immutable-by-omission: it is not part of the
// update shape, so it can never appear on an update payload (mirrors
// ticketForms.ts's updateTicketFormSchema).
export const updateContractTemplateSchema = contractTemplateShape
  .omit({ ownerScope: true, orgId: true })
  .partial();

export type CreateContractTemplateInput = z.infer<typeof createContractTemplateSchema>;
export type UpdateContractTemplateInput = z.infer<typeof updateContractTemplateSchema>;

// Read-side mirror of the write-side XOR invariant above (contractTemplateShape's
// superRefine, and the DB's contract_templates_one_owner_chk / contract_template_versions
// equivalent): every persisted template or version row has exactly one of
// orgId/partnerId set, never both, never neither. Modeling that as two independent
// `string | null` fields on a read DTO lets a caller observe an impossible
// `{ orgId: null, partnerId: null }` or `{ orgId: '...', partnerId: '...' }` combination
// without a type error. This discriminated union makes the invariant a compile-time
// fact instead of something only the write path enforces — API serializers attach
// `ownerScope` (see deriveTemplateOwnership in contractTemplateService.ts) and web
// consumers narrow on it instead of re-deriving `orgId === null`.
export type ContractTemplateOwnership =
  | { ownerScope: 'organization'; orgId: string; partnerId: null }
  | { ownerScope: 'partner'; orgId: null; partnerId: string };

// Authored version body. File uploads (source_type='uploaded') go through the
// multipart route and are not shaped by this schema.
export const createTemplateVersionSchema = z.object({
  bodyHtml: z.string().min(1).max(200_000),
});

export type CreateTemplateVersionInput = z.infer<typeof createTemplateVersionSchema>;

// A declared template variable — either resolved automatically from quote/org
// data (AUTO_CONTRACT_VARIABLES below) or filled in manually per contract
// document. `name` is the token used inside `{{ name }}` placeholders in the
// template body, so it is restricted to a conservative lowercase
// dotted/underscored identifier: no braces, spaces, or uppercase, and no
// leading digit/underscore (keeps it a valid-looking property path segment).
export const contractVariableSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, 'must be lowercase, start with a letter, and contain only letters, digits, "_" or "."'),
  kind: z.enum(['auto', 'manual']),
  label: z.string().max(100).optional(),
});

export type ContractVariable = z.infer<typeof contractVariableSchema>;

// Auto-resolved variable names available to every template, sourced from the
// quote/org/dates context at render time (no per-document manual entry
// required). Keep in sync with the resolver that fills these in (Task 11+).
export const AUTO_CONTRACT_VARIABLES: readonly string[] = [
  'client.name',
  'client.address',
  'seller.name',
  'quote.number',
  'quote.title',
  'totals.one_time',
  'totals.monthly',
  'totals.annual',
  'totals.total',
  'dates.effective',
  'dates.expiry',
];
