import { describe, expect, it } from 'vitest';
import { buildTicketApprovalSummary, type SummaryInput } from './summary';

const POLICY = {
  enabled: { value: true, source: 'partner' as const },
  budgetTrigger: { value: true, source: 'default' as const },
  afterHoursTrigger: { value: true, source: 'default' as const },
  enforcement: { value: 'soft' as const, source: 'default' as const },
  requestTtlHours: { value: 72, source: 'default' as const },
};

function req(over: Partial<SummaryInput['requests'][number]> = {}): SummaryInput['requests'][number] {
  return {
    id: 'r1', orgId: 'o1', ticketId: 't1', trigger: 'budget', origin: 'auto', status: 'pending', revision: 1,
    enforcement: 'soft', requestedByUserId: null, requestedAt: new Date('2026-10-12T10:00:00Z'),
    expiresAt: new Date('2026-10-15T10:00:00Z'), message: null, budgetMinutesAtRequest: 120, consumedMinutesAtRequest: 90,
    budgetAmountAtRequest: null, consumedAmountAtRequest: null, currencyCode: 'USD', requestedExtensionMinutes: 30,
    requestedExtensionAmount: null, coverageStartsAt: null, coverageEndsAt: null, afterHoursWorkTypeId: null,
    approverEmails: ['billing@example.com'], notifyEmails: ['req@example.com'], decidedAt: null, decisionOrigin: null,
    decidedByPortalUserId: null, decidedByUserId: null, signerName: null, signerEmail: null, decisionMethod: null,
    decisionReference: null, decisionNote: null, decidedRevision: null, approvedExtensionMinutes: null,
    approvedExtensionAmount: null, ipAddress: '203.0.113.9', userAgent: 'UA', createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

const entry = (over: Partial<SummaryInput['entries'][number]> = {}): SummaryInput['entries'][number] => ({
  id: 'e1', approvalRequestId: null, billingStatus: 'not_billed', isBillable: true, coverage: 'billable',
  endedAt: new Date(), billableMinutes: null, durationMinutes: 60, hourlyRate: '100.00', currencyCode: 'USD', ...over,
});

const base = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  policy: POLICY,
  ticket: { budgetMinutes: 120, budgetAmount: '200.00', budgetCurrencyCode: 'USD' },
  requests: [], entries: [], userNames: new Map(), ...over,
});

describe('buildTicketApprovalSummary', () => {
  it('ceiling includes approved budget extensions on both axes', () => {
    const s = buildTicketApprovalSummary(base({
      requests: [
        req({ id: 'a', status: 'approved', approvedExtensionMinutes: 60, approvedExtensionAmount: '50.00' }),
        req({ id: 'b', status: 'denied', approvedExtensionMinutes: null }),
        req({ id: 'c', trigger: 'after_hours', status: 'approved', approvedExtensionMinutes: 999 }),
      ],
    }));
    expect(s.ceiling).toEqual({ minutes: 180, amount: '250.00' });
    expect(s.approvedExtensions).toEqual({ minutes: 60, amount: '50.00' });
  });

  it('a null budget axis has a null ceiling (no ceiling on that axis)', () => {
    const s = buildTicketApprovalSummary(base({ ticket: { budgetMinutes: null, budgetAmount: null, budgetCurrencyCode: null } }));
    expect(s.ceiling).toEqual({ minutes: null, amount: null });
    expect(s.budget).toEqual({ minutes: null, amount: null, currency: null });
  });

  it('consumed counts settled billable entries; held counts awaiting_approval entries separately', () => {
    const s = buildTicketApprovalSummary(base({
      entries: [
        entry({ id: 'e1', durationMinutes: 90, billingStatus: 'billed' }),
        entry({ id: 'e2', durationMinutes: 30, billableMinutes: 45, billingStatus: 'not_billed' }),
        entry({ id: 'e3', durationMinutes: 60, billingStatus: 'awaiting_approval', approvalRequestId: 'r1' }),
        entry({ id: 'e4', durationMinutes: 600, billingStatus: 'no_charge' }),
        entry({ id: 'e5', durationMinutes: 600, isBillable: false, coverage: 'non_billable' }),
        entry({ id: 'e6', durationMinutes: 600, endedAt: null }),
        entry({ id: 'e7', durationMinutes: 30, billingStatus: 'awaiting_approval', approvalRequestId: 'r1', hourlyRate: null }),
      ],
      requests: [req()],
    }));
    expect(s.consumed).toEqual({ minutes: 135, amount: '225.00' });
    expect(s.held).toEqual({ minutes: 90, amount: '100.00', entryCount: 2, unpricedEntryCount: 1 });
    expect(s.requests[0]!.heldEntryCount).toBe(2);
  });

  it('exposes the revision and the recipient split, and never the customer IP or user agent', () => {
    const s = buildTicketApprovalSummary(base({ requests: [req({ revision: 3 })] }));
    const r = s.requests[0]!;
    expect(r.revision).toBe(3);
    expect(r.approverEmails).toEqual(['billing@example.com']);
    expect(r.notifyEmails).toEqual(['req@example.com']);
    expect(r).not.toHaveProperty('ipAddress');
    expect(r).not.toHaveProperty('userAgent');
  });

  it('names the staff user who recorded an on-behalf decision', () => {
    const s = buildTicketApprovalSummary(base({
      requests: [req({ status: 'approved', decisionOrigin: 'on_behalf', decidedByUserId: 'u-staff', signerName: 'Pat' })],
      userNames: new Map([['u-staff', 'Tess Tech']]),
    }));
    expect(s.requests[0]!.decidedByUserName).toBe('Tess Tech');
    expect(s.requests[0]!.signerName).toBe('Pat');
  });

  it('orders requests newest first', () => {
    const s = buildTicketApprovalSummary(base({
      requests: [
        req({ id: 'old', requestedAt: new Date('2026-10-01T00:00:00Z') }),
        req({ id: 'new', requestedAt: new Date('2026-10-10T00:00:00Z') }),
      ],
    }));
    expect(s.requests.map((r) => r.id)).toEqual(['new', 'old']);
  });
});
