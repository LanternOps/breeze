import { describe, expect, it } from 'vitest';
import { ticketingInboundSettingsSchema, timeTrackingSessionSuggestionsSchema } from './partnerTicketingSettings';

describe('ticketingInboundSettingsSchema', () => {
  it('accepts a full valid config', () => {
    const result = ticketingInboundSettingsSchema.safeParse({
      enabled: true,
      address: 'support@example.com',
      defaultTriageOrgId: null,
      autoresponderEnabled: false,
      unknownSenderMode: 'quarantine',
      dropUnverifiedSenders: true,
      autoresponseSubject: null,
      autoresponseBody: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the empty object — every field is optional', () => {
    expect(ticketingInboundSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('still accepts the legacy triageUnknownSenders boolean for back-compat', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ triageUnknownSenders: true }).success).toBe(true);
  });

  it('rejects an invalid unknownSenderMode', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ unknownSenderMode: 'bogus' }).success).toBe(false);
  });

  it('rejects a non-boolean enabled', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });

  it('accepts an empty-string address (the UI\'s cleared state)', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ address: '' }).success).toBe(true);
  });

  it('rejects a non-email, non-empty address', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ address: 'not-an-email' }).success).toBe(false);
  });

  it('accepts a uuid defaultTriageOrgId and rejects a non-uuid', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ defaultTriageOrgId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    expect(ticketingInboundSettingsSchema.safeParse({ defaultTriageOrgId: 'nope' }).success).toBe(false);
  });
});

describe('timeTrackingSessionSuggestionsSchema', () => {
  it('accepts a full valid config', () => {
    const result = timeTrackingSessionSuggestionsSchema.safeParse({
      sessionSuggestions: { enabled: true, minSessionSeconds: 60, mergeGapMinutes: 5 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown key inside sessionSuggestions (strict)', () => {
    const result = timeTrackingSessionSuggestionsSchema.safeParse({
      sessionSuggestions: { enabledd: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range minSessionSeconds', () => {
    expect(timeTrackingSessionSuggestionsSchema.safeParse({
      sessionSuggestions: { minSessionSeconds: 10 },
    }).success).toBe(false);
  });

  it('passes through an unrecognized sibling key at the wrapper level', () => {
    const result = timeTrackingSessionSuggestionsSchema.safeParse({
      sessionSuggestions: { enabled: true },
      locationSuggestions: { enabled: true }, // owned by a different wave; must survive
    });
    expect(result.success).toBe(true);
    expect(result.success && (result.data as Record<string, unknown>).locationSuggestions).toEqual({ enabled: true });
  });
});
