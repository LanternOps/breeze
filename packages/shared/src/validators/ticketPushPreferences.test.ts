import { describe, it, expect } from 'vitest';
import {
  resolveTicketPushPrefs,
  updateTicketPushPreferencesSchema,
  ticketPushPreferencesSchema,
  TICKET_PUSH_PREFERENCE_DEFAULTS,
} from './ticketPushPreferences';

describe('resolveTicketPushPrefs', () => {
  it('returns defaults for null and undefined', () => {
    expect(resolveTicketPushPrefs(null)).toEqual({ assignedEnabled: true, slaScope: 'owned' });
    expect(resolveTicketPushPrefs(undefined)).toEqual(TICKET_PUSH_PREFERENCE_DEFAULTS);
  });
  it('fills missing fields from defaults and keeps provided ones', () => {
    expect(resolveTicketPushPrefs({ slaScope: 'any' })).toEqual({ assignedEnabled: true, slaScope: 'any' });
    expect(resolveTicketPushPrefs({ assignedEnabled: false })).toEqual({ assignedEnabled: false, slaScope: 'owned' });
  });
  it('never returns an unknown scope', () => {
    expect(resolveTicketPushPrefs({ slaScope: 'bogus' as never }).slaScope).toBe('owned');
  });
});

describe('updateTicketPushPreferencesSchema', () => {
  it('rejects an empty patch', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({}).success).toBe(false);
  });
  it('rejects unknown keys (strict)', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({ userId: 'x', slaScope: 'off' }).success).toBe(false);
  });
  it('accepts a partial patch', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({ slaScope: 'any' }).success).toBe(true);
    expect(updateTicketPushPreferencesSchema.safeParse({ assignedEnabled: false }).success).toBe(true);
  });
  it('rejects an invalid scope', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({ slaScope: 'all' }).success).toBe(false);
  });
});

describe('ticketPushPreferencesSchema', () => {
  it('requires both fields', () => {
    expect(ticketPushPreferencesSchema.safeParse({ assignedEnabled: true }).success).toBe(false);
  });
});
