import { describe, it, expect } from 'vitest';
import {
  partnerTicketApprovalSettingsPatchSchema,
  orgTicketApprovalSettingsPatchSchema,
} from './ticketApproval';

describe('partnerTicketApprovalSettingsPatchSchema', () => {
  it('accepts a partial patch', () => {
    expect(partnerTicketApprovalSettingsPatchSchema.parse({ enabled: true })).toEqual({ enabled: true });
  });
  it('rejects null (the partner row is the floor; nothing to inherit from)', () => {
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ enforcement: null }).success).toBe(false);
  });
  it('rejects an unknown key', () => {
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ budget: 5 }).success).toBe(false);
  });
  it('bounds request_ttl_hours to 1..720 integers', () => {
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ requestTtlHours: 0 }).success).toBe(false);
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ requestTtlHours: 721 }).success).toBe(false);
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ requestTtlHours: 1.5 }).success).toBe(false);
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ requestTtlHours: 720 }).success).toBe(true);
  });
  it('accepts only soft or hard enforcement', () => {
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ enforcement: 'hard' }).success).toBe(true);
    expect(partnerTicketApprovalSettingsPatchSchema.safeParse({ enforcement: 'strict' }).success).toBe(false);
  });
});

describe('orgTicketApprovalSettingsPatchSchema', () => {
  it('accepts null on every field (clear the override = inherit)', () => {
    const all = { enabled: null, budgetTrigger: null, afterHoursTrigger: null, enforcement: null, requestTtlHours: null };
    expect(orgTicketApprovalSettingsPatchSchema.parse(all)).toEqual(all);
  });
  it('still validates non-null values', () => {
    expect(orgTicketApprovalSettingsPatchSchema.safeParse({ requestTtlHours: 0 }).success).toBe(false);
    expect(orgTicketApprovalSettingsPatchSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });
  it('rejects an unknown key', () => {
    expect(orgTicketApprovalSettingsPatchSchema.safeParse({ partnerId: 'x' }).success).toBe(false);
  });
});
