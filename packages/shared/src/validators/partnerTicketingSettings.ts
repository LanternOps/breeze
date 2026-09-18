import { z } from 'zod';

// Extracted verbatim from apps/api/src/routes/orgs.ts's route-local
// `partnerSettingsSchema` (2026-09-17, settings-consolidation W02-API / M14) so
// the contract is shared between the write boundary (PATCH /orgs/partners/me)
// and the tolerant reads in partnerDefaultSettings.ts, ticketConfigService.ts
// and timeSuggestionSettings.ts — audit finding 32.
//
// Accepted/rejected shapes are unchanged by the move. Reads must use
// `safeParse`, never `.parse()`: `partners.settings` is jsonb written over
// years by looser code paths, and one bad historical row must not become a 500
// for every request touching that partner's settings.

/**
 * `partners.settings.ticketing.inbound`.
 *
 * PATCH /partners/me deep-merges `ticketing` one level, but the `inbound`
 * sub-object is replaced wholesale — callers must send the COMPLETE object
 * (incl. the `address` self-hosted override read back via getTicketConfig).
 */
export const ticketingInboundSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  address: z.string().email().optional().or(z.literal('')),
  defaultTriageOrgId: z.string().guid().nullable().optional(),
  autoresponderEnabled: z.boolean().optional(),
  // Unknown-sender routing. `unknownSenderMode` is the current 3-way control;
  // `triageUnknownSenders` is the legacy boolean still accepted for back-compat
  // (loadPartnerInboundPolicy maps it true→'triage'). The card now sends
  // `unknownSenderMode`, which retires the legacy key on the next save (the
  // inbound sub-object is replaced wholesale).
  unknownSenderMode: z.enum(['quarantine', 'triage', 'drop']).optional(),
  triageUnknownSenders: z.boolean().optional(),
  // When true, senders failing the SPF/DKIM/DMARC gate are dropped silently
  // instead of quarantined. Default-off; applies to all unverified senders.
  dropUnverifiedSenders: z.boolean().optional(),
  autoresponseSubject: z.string().max(200).nullable().optional(),
  autoresponseBody: z.string().max(5000).nullable().optional(),
});
export type TicketingInboundSettings = z.infer<typeof ticketingInboundSettingsSchema>;

/**
 * `partners.settings.timeTracking` — the session-suggestion block (W06, #3900).
 *
 * `.strict()` on the inner object so a typo ("enabledd") is a 400 rather than a
 * silently stored no-op; `.passthrough()` on the wrapper so a sibling block
 * this schema does not own (e.g. `timeTracking.locationSuggestions`) is neither
 * rejected nor stripped.
 */
export const timeTrackingSessionSuggestionsSchema = z.object({
  sessionSuggestions: z.object({
    enabled: z.boolean().optional(),
    minSessionSeconds: z.number().int().min(30).max(3600).optional(),
    mergeGapMinutes: z.number().int().min(0).max(120).optional(),
  }).strict().optional(),
}).passthrough();
export type TimeTrackingSessionSuggestionsSettings = z.infer<typeof timeTrackingSessionSuggestionsSchema>;
