import { z } from 'zod';

/**
 * Customer work approval policy (#4617 spec §4.1, §7). Partner default →
 * org override. The partner PATCH sets values; the org PATCH also accepts
 * `null`, which clears that field's override so it inherits again.
 */
export const TICKET_APPROVAL_ENFORCEMENTS = ['soft', 'hard'] as const;
export type TicketApprovalEnforcementMode = (typeof TICKET_APPROVAL_ENFORCEMENTS)[number];

const enabled = z.boolean();
const budgetTrigger = z.boolean();
const afterHoursTrigger = z.boolean();
const enforcement = z.enum(TICKET_APPROVAL_ENFORCEMENTS);
const requestTtlHours = z.number().int().min(1).max(720);

export const partnerTicketApprovalSettingsPatchSchema = z.object({
  enabled, budgetTrigger, afterHoursTrigger, enforcement, requestTtlHours,
}).partial().strict();

export const orgTicketApprovalSettingsPatchSchema = z.object({
  enabled: enabled.nullable(),
  budgetTrigger: budgetTrigger.nullable(),
  afterHoursTrigger: afterHoursTrigger.nullable(),
  enforcement: enforcement.nullable(),
  requestTtlHours: requestTtlHours.nullable(),
}).partial().strict();

/**
 * A positive money amount as a decimal STRING with at most 2 places (a JS
 * number would lose precision). `> 0` is enforced here so a zero never reaches
 * the SQL CHECK (which would surface as a 500). Whether the currency allows
 * the decimals (e.g. JPY has none) is checked by the service against the
 * stamped currency.
 */
export const positiveMoneyAmountSchema = z.string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Expected a positive amount with at most 2 decimal places')
  .refine((v) => Number(v) > 0, 'Expected an amount greater than zero');

/** Staff-raised ask (#4617 spec §6.3): a budget extension or an after-hours coverage window. */
export const createTicketApprovalRequestSchema = z.object({
  trigger: z.enum(['budget', 'after_hours']),
  message: z.string().trim().max(2000).optional(),
  extensionMinutes: z.number().int().positive().max(1_000_000).optional(),
  extensionAmount: positiveMoneyAmountSchema.optional(),
  coverageStartsAt: z.coerce.date().optional(),
  coverageEndsAt: z.coerce.date().optional(),
}).strict();

/** "Ask again" on a denied, expired or cancelled request. */
export const reaskTicketApprovalRequestSchema = z.object({
  message: z.string().trim().max(2000).optional(),
  extensionMinutes: z.number().int().positive().max(1_000_000).optional(),
  extensionAmount: positiveMoneyAmountSchema.optional(),
}).strict();

export const TICKET_APPROVAL_DECISION_METHODS = ['verbal', 'email', 'signed_document', 'other'] as const;
export type TicketApprovalDecisionMethod = (typeof TICKET_APPROVAL_DECISION_METHODS)[number];

/**
 * Staff recording the customer's decision on their behalf. The actor is ALWAYS
 * the signed-in staff user (taken from the session, never the body — hence
 * `.strict()`); signer name/email are attestation fields of the record only.
 * `revision` is the one the staff member saw, so a stale page gets 409.
 */
export const decideTicketApprovalOnBehalfSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  revision: z.number().int().min(1),
  method: z.enum(TICKET_APPROVAL_DECISION_METHODS),
  reference: z.string().trim().min(1, 'A reference is required').max(500),
  signerName: z.string().trim().min(1, 'The signer\'s name is required').max(255),
  signerEmail: z.string().trim().email().max(255).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict();

export type CreateTicketApprovalRequestInput = z.infer<typeof createTicketApprovalRequestSchema>;
export type ReaskTicketApprovalRequestInput = z.infer<typeof reaskTicketApprovalRequestSchema>;
export type DecideTicketApprovalOnBehalfInput = z.infer<typeof decideTicketApprovalOnBehalfSchema>;

export type PartnerTicketApprovalSettingsPatch = z.infer<typeof partnerTicketApprovalSettingsPatchSchema>;
export type OrgTicketApprovalSettingsPatch = z.infer<typeof orgTicketApprovalSettingsPatchSchema>;
