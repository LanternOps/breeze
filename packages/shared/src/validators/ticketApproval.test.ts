import { describe, it, expect } from 'vitest';
import {
  partnerTicketApprovalSettingsPatchSchema,
  orgTicketApprovalSettingsPatchSchema,
  createTicketApprovalRequestSchema,
  reaskTicketApprovalRequestSchema,
  decideTicketApprovalOnBehalfSchema,
} from './ticketApproval';
import { updateTicketSchema } from './tickets';

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

describe('updateTicketSchema budget fields (#4617 W03)', () => {
  it('accepts a positive integer budgetMinutes and a 2dp budgetAmount', () => {
    expect(updateTicketSchema.parse({ budgetMinutes: 120, budgetAmount: '450.50' }))
      .toEqual({ budgetMinutes: 120, budgetAmount: '450.50' });
  });
  it('accepts null to clear either axis', () => {
    expect(updateTicketSchema.parse({ budgetMinutes: null, budgetAmount: null }))
      .toEqual({ budgetMinutes: null, budgetAmount: null });
  });
  it('rejects zero, negative and fractional minutes', () => {
    for (const v of [0, -5, 1.5]) expect(updateTicketSchema.safeParse({ budgetMinutes: v }).success).toBe(false);
  });
  it('rejects a zero, negative, 3dp or numeric budgetAmount', () => {
    for (const v of ['0', '0.00', '-1', '1.005', 12, '1e3', '']) {
      expect(updateTicketSchema.safeParse({ budgetAmount: v }).success).toBe(false);
    }
  });
  it('does not accept the currency from the client (the service stamps it)', () => {
    expect(updateTicketSchema.parse({ budgetCurrencyCode: 'USD' } as never)).toEqual({});
  });
});

describe('createTicketApprovalRequestSchema', () => {
  it('accepts a budget ask with minutes', () => {
    expect(createTicketApprovalRequestSchema.safeParse({ trigger: 'budget', extensionMinutes: 60 }).success).toBe(true);
  });
  it('accepts an after-hours window and coerces the dates', () => {
    const r = createTicketApprovalRequestSchema.parse({
      trigger: 'after_hours', coverageStartsAt: '2026-10-12T18:00:00Z', coverageEndsAt: '2026-10-12T23:00:00Z',
    });
    expect(r.coverageStartsAt).toBeInstanceOf(Date);
  });
  it('rejects an unknown trigger and unknown keys', () => {
    expect(createTicketApprovalRequestSchema.safeParse({ trigger: 'other' }).success).toBe(false);
    expect(createTicketApprovalRequestSchema.safeParse({ trigger: 'budget', extensionMinutes: 60, status: 'approved' }).success).toBe(false);
  });
});

describe('reaskTicketApprovalRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(reaskTicketApprovalRequestSchema.safeParse({}).success).toBe(true);
  });
  it('rejects a non-positive extension', () => {
    expect(reaskTicketApprovalRequestSchema.safeParse({ extensionMinutes: 0 }).success).toBe(false);
  });
});

describe('decideTicketApprovalOnBehalfSchema', () => {
  const base = { decision: 'approved', revision: 2, method: 'email', reference: 'Email 12 Oct', signerName: 'Pat Customer' };
  it('accepts a complete on-behalf decision', () => {
    expect(decideTicketApprovalOnBehalfSchema.safeParse({ ...base, signerEmail: 'pat@example.com', note: 'ok' }).success).toBe(true);
  });
  it('rejects a blank or whitespace reference', () => {
    expect(decideTicketApprovalOnBehalfSchema.safeParse({ ...base, reference: '' }).success).toBe(false);
    expect(decideTicketApprovalOnBehalfSchema.safeParse({ ...base, reference: '   ' }).success).toBe(false);
  });
  it('rejects a missing signer name, a bad method, and a non-positive revision', () => {
    expect(decideTicketApprovalOnBehalfSchema.safeParse({ ...base, signerName: ' ' }).success).toBe(false);
    expect(decideTicketApprovalOnBehalfSchema.safeParse({ ...base, method: 'telepathy' }).success).toBe(false);
    expect(decideTicketApprovalOnBehalfSchema.safeParse({ ...base, revision: 0 }).success).toBe(false);
  });
  it('rejects any actor field from the client', () => {
    expect(decideTicketApprovalOnBehalfSchema.safeParse({ ...base, userId: '00000000-0000-4000-8000-000000000000' }).success).toBe(false);
  });
});
