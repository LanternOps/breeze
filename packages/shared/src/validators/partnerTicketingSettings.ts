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
  // Flood protection: per-hour ticket-creation caps enforced in the inbound
  // worker (before the DB transaction — a Redis rate check cannot run inside
  // the held context, #1105). Each is a sliding 1h window; 0 means "unlimited"
  // (skip that window). Absent ⇒ the INBOUND_MAX_* env defaults apply. Over-cap
  // mail is quarantined (review queue), never silently dropped.
  maxTicketsPerSenderPerHour: z.number().int().min(0).max(10000).optional(),
  maxTicketsPerDomainPerHour: z.number().int().min(0).max(50000).optional(),
  maxTicketsPerPartnerPerHour: z.number().int().min(0).max(200000).optional(),
  // Reply-to-client content mode. Default (false/absent) keeps the existing
  // portal-notification email ("you have a new reply, sign in"). When true, a
  // public tech reply emails the customer the actual comment text (threaded) —
  // for MSPs that do not run the client portal.
  fullMessageReply: z.boolean().optional(),
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

// ---------------------------------------------------------------------------
// Tolerant reads (W02-API / M14)
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * WHY THE FALLBACK IS THE RAW SUB-OBJECT, NOT `{}`.
 *
 * A stored row that fails validation is almost always PARTIALLY valid — one
 * bad field among several good ones, written years ago by looser code. If a
 * failed parse collapsed the whole sub-object to `{}`, a row carrying
 * `{ enabled: false, unknownSenderMode: 'bogus' }` would read back as
 * `enabled: undefined` — and every reader treats an absent `enabled` as TRUE
 * (deliberately, so an upgrade cannot silently stop ingestion; see #3608).
 * That is a fail-OPEN regression: a partner who explicitly disabled inbound
 * email-to-ticket would have it turned back on by a typo elsewhere in the
 * object.
 *
 * So validation here buys VISIBILITY, not enforcement: on success the caller
 * gets validated, typed data; on failure it gets exactly what today's
 * unchecked cast would have handed it, plus `valid: false` so it can warn.
 * The per-field tolerance each reader already implements (`enabled !== false`,
 * mode allowlists, integer-range fallbacks) remains the last line of defence.
 * Reads must never throw on stored data — one bad historical row would
 * otherwise be a 500 for every request touching that partner's settings.
 */
export function readTicketingInboundSettings(partnerSettings: unknown): {
  settings: TicketingInboundSettings;
  valid: boolean;
} {
  const raw = asRecord(asRecord(partnerSettings).ticketing).inbound;
  if (raw === undefined || raw === null) return { settings: {}, valid: true };

  const parsed = ticketingInboundSettingsSchema.safeParse(raw);
  if (parsed.success) return { settings: parsed.data, valid: true };
  return { settings: asRecord(raw) as TicketingInboundSettings, valid: false };
}

/** Same contract as readTicketingInboundSettings, for `timeTracking.sessionSuggestions`. */
export function readTimeTrackingSessionSuggestions(partnerSettings: unknown): {
  settings: NonNullable<TimeTrackingSessionSuggestionsSettings['sessionSuggestions']>;
  valid: boolean;
} {
  const timeTracking = asRecord(partnerSettings).timeTracking;
  const raw = asRecord(timeTracking).sessionSuggestions;
  if (raw === undefined || raw === null) return { settings: {}, valid: true };

  const parsed = timeTrackingSessionSuggestionsSchema.safeParse({ sessionSuggestions: raw });
  if (parsed.success) return { settings: parsed.data.sessionSuggestions ?? {}, valid: true };
  return {
    settings: asRecord(raw) as NonNullable<TimeTrackingSessionSuggestionsSettings['sessionSuggestions']>,
    valid: false,
  };
}
