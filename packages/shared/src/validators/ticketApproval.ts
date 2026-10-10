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

export type PartnerTicketApprovalSettingsPatch = z.infer<typeof partnerTicketApprovalSettingsPatchSchema>;
export type OrgTicketApprovalSettingsPatch = z.infer<typeof orgTicketApprovalSettingsPatchSchema>;
