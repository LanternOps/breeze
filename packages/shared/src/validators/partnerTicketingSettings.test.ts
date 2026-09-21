import { describe, expect, it } from 'vitest';
import {
  ticketingInboundSettingsSchema,
  timeTrackingSessionSuggestionsSchema,
  readTicketingInboundSettings,
  readTimeTrackingSessionSuggestions,
} from './partnerTicketingSettings';

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

  it('accepts the fullMessageReply toggle and rejects a non-boolean', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ fullMessageReply: true }).success).toBe(true);
    expect(ticketingInboundSettingsSchema.safeParse({ fullMessageReply: 'yes' }).success).toBe(false);
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

describe('readTicketingInboundSettings (tolerant read)', () => {
  it('returns the parsed sub-object and valid:true for a well-formed row', () => {
    const result = readTicketingInboundSettings({
      ticketing: { inbound: { enabled: false, unknownSenderMode: 'drop' } },
    });
    expect(result.valid).toBe(true);
    expect(result.settings).toMatchObject({ enabled: false, unknownSenderMode: 'drop' });
  });

  it('returns empty settings (valid:true) when the path is simply absent', () => {
    expect(readTicketingInboundSettings({})).toEqual({ settings: {}, valid: true });
    expect(readTicketingInboundSettings(null)).toEqual({ settings: {}, valid: true });
    expect(readTicketingInboundSettings({ ticketing: 'nonsense' })).toEqual({ settings: {}, valid: true });
  });

  it('never throws on a malformed stored row', () => {
    expect(() => readTicketingInboundSettings({
      ticketing: { inbound: { unknownSenderMode: 'not-a-real-mode', enabled: 'yes' } },
    })).not.toThrow();
  });

  /**
   * THE REGRESSION GUARD. A whole-object `{}` fallback on a partially malformed
   * row would silently discard a stored `enabled: false` — re-enabling inbound
   * email-to-ticket for a partner that explicitly turned it off, since every
   * reader treats absent `enabled` as true (#3608). The tolerant read must
   * therefore hand back the RAW sub-object, not an empty one, when validation
   * fails; it reports `valid: false` so the caller can log it.
   */
  it('keeps the other fields of a PARTIALLY malformed row instead of dropping to {}', () => {
    const result = readTicketingInboundSettings({
      ticketing: { inbound: { enabled: false, dropUnverifiedSenders: true, unknownSenderMode: 'bogus' } },
    });
    expect(result.valid).toBe(false);
    expect(result.settings.enabled).toBe(false);
    expect(result.settings.dropUnverifiedSenders).toBe(true);
  });
});

describe('readTimeTrackingSessionSuggestions (tolerant read)', () => {
  it('returns the parsed sub-object and valid:true for a well-formed row', () => {
    const result = readTimeTrackingSessionSuggestions({
      timeTracking: { sessionSuggestions: { enabled: true, minSessionSeconds: 60 } },
    });
    expect(result.valid).toBe(true);
    expect(result.settings).toMatchObject({ enabled: true, minSessionSeconds: 60 });
  });

  it('returns empty settings (valid:true) when the path is absent', () => {
    expect(readTimeTrackingSessionSuggestions({})).toEqual({ settings: {}, valid: true });
    expect(readTimeTrackingSessionSuggestions(undefined)).toEqual({ settings: {}, valid: true });
  });

  it('never throws, and keeps the valid fields of a partially malformed row', () => {
    let result!: ReturnType<typeof readTimeTrackingSessionSuggestions>;
    expect(() => { result = readTimeTrackingSessionSuggestions({
      timeTracking: { sessionSuggestions: { enabled: true, minSessionSeconds: 5 } },
    }); }).not.toThrow();
    expect(result.valid).toBe(false);
    expect(result.settings.enabled).toBe(true);
  });
});
