import { describe, it, expect } from 'vitest';
import { formatMinutes, approvalAskSentence, approvalSnapshotLine } from './approvalText';
import { money } from './money';
import type { PortalApproval } from './api';

const ask = (over: Partial<PortalApproval['ask']> = {}): PortalApproval['ask'] => ({
  minutes: null, amount: null, currencyCode: null, coverageStartsAt: null, coverageEndsAt: null, ...over,
});
const approval = (over: Partial<PortalApproval> = {}): Pick<PortalApproval, 'trigger' | 'ticketNumber' | 'ask'> => ({
  trigger: 'budget', ticketNumber: 'T-1042', ask: ask({ minutes: 150 }), ...over,
});

describe('formatMinutes', () => {
  it.each([[150, '2 h 30 m'], [60, '1 h'], [45, '45 m'], [0, '0 m'], [605, '10 h 5 m']])('%d -> %s', (n, s) => {
    expect(formatMinutes(n)).toBe(s);
  });
});

describe('approvalAskSentence', () => {
  it('minutes only', () => {
    expect(approvalAskSentence(approval())).toBe('Approve up to 2 h 30 m more on ticket #T-1042');
  });
  it('minutes and amount', () => {
    const a = approval({ ask: ask({ minutes: 150, amount: '375.00', currencyCode: 'USD' }) });
    expect(approvalAskSentence(a)).toBe(`Approve up to 2 h 30 m (${money('375.00', 'USD')}) more on ticket #T-1042`);
  });
  it('amount only', () => {
    const a = approval({ ask: ask({ amount: '375.00', currencyCode: 'USD' }) });
    expect(approvalAskSentence(a)).toBe(`Approve up to ${money('375.00', 'USD')} more on ticket #T-1042`);
  });
  it('budget with no figures stays readable', () => {
    expect(approvalAskSentence(approval({ ask: ask() }))).toBe('Approve additional work on ticket #T-1042');
  });
  it('after hours', () => {
    expect(approvalAskSentence(approval({ trigger: 'after_hours', ask: ask() }))).toBe('Approve after-hours work on ticket #T-1042');
  });
  it('after hours with a coverage window', () => {
    const s = approvalAskSentence(approval({
      trigger: 'after_hours',
      ask: ask({ coverageStartsAt: '2026-10-12T22:00:00.000Z', coverageEndsAt: '2026-10-13T02:00:00.000Z' }),
    }));
    expect(s).toMatch(/^Approve after-hours work on ticket #T-1042 \(.+ to .+\)$/);
  });
});

describe('approvalSnapshotLine', () => {
  const snap = (over: Partial<PortalApproval['snapshot']>): PortalApproval['snapshot'] => ({
    budgetMinutes: null, consumedMinutes: null, budgetAmount: null, consumedAmount: null, ...over,
  });
  it('budget and used minutes', () => {
    expect(approvalSnapshotLine(snap({ budgetMinutes: 600, consumedMinutes: 585 }), null)).toBe('Budget 10 h, used 9 h 45 m');
  });
  it('omits null axes', () => {
    expect(approvalSnapshotLine(snap({ budgetMinutes: 600 }), null)).toBe('Budget 10 h');
    expect(approvalSnapshotLine(snap({ consumedMinutes: 30 }), null)).toBe('Used 30 m');
  });
  it('includes amounts', () => {
    expect(approvalSnapshotLine(snap({ budgetAmount: '1000.00', consumedAmount: '900.00' }), 'USD'))
      .toBe(`Budget ${money('1000.00', 'USD')}, used ${money('900.00', 'USD')}`);
  });
  it('returns null when empty', () => {
    expect(approvalSnapshotLine(snap({}), null)).toBeNull();
  });
});
