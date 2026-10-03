import { describe, expect, it } from 'vitest';
import { computeCollectOn, noticeLeadDays } from './scheduler';

describe('collection date', () => {
  it.each([
    ['earlier', 1, '2026-10-02'], ['later', 1, '2026-10-31'],
    ['earlier', 10, '2026-10-11'], ['later', 10, '2026-10-31'],
  ] as const)('%s with %i days', (rule, leadDays, expected) => {
    expect(computeCollectOn({ issueDate: '2026-10-01', dueDate: '2026-10-31',
      offsetDays: 0, rule, noticeDate: '2026-10-01', leadDays })).toBe(expected);
  });
  it('uses UTC calendar arithmetic across a leap day', () => {
    expect(computeCollectOn({ issueDate: '2028-02-28', dueDate: '2028-02-29',
      offsetDays: 2, rule: 'later', noticeDate: '2028-02-28', leadDays: 1 }))
      .toBe('2028-03-01');
  });
  it('pushes a late notice into the following month', () => {
    expect(computeCollectOn({ issueDate: '2026-10-01', dueDate: '2026-10-01',
      offsetDays: 0, rule: 'earlier', noticeDate: '2026-10-28', leadDays: 10 }))
      .toBe('2026-11-07');
  });
  it.each(['2026-02-30', 'invalid', '2026-1-01'])('rejects %s', issueDate => {
    expect(() => computeCollectOn({ issueDate, dueDate: '2026-10-01',
      offsetDays: 0, rule: 'later', noticeDate: '2026-10-01', leadDays: 1 })).toThrow();
  });
  it.each([
    ['card', null, 1], ['card', 'individual', 1],
    ['us_bank_account', 'company', 1], ['us_bank_account', 'individual', 10],
  ] as const)('lead for %s/%s', (type, accountHolderType, expected) => {
    expect(noticeLeadDays({ type, accountHolderType })).toBe(expected);
  });
});

import { eligibilityReason, type Eligibility } from './scheduler';
const good: Eligibility = {
  active: true, effective: true, methodUsable: true, charging: true,
  stripeReady: true, sameAccount: true, achCurrency: true,
  capCurrency: true, underCap: true, excludedContract: false, excludedInvoice: false,
};
it.each([
  ['active', false, 'not_enrolled'], ['effective', false, 'enrolled_after_issue'],
  ['methodUsable', false, 'method_not_usable'], ['charging', false, 'charging_disabled'],
  ['stripeReady', false, 'stripe_unavailable'], ['sameAccount', false, 'stripe_unavailable'],
  ['achCurrency', false, 'ach_currency_unsupported'], ['capCurrency', false, 'cap_currency_mismatch'],
  ['underCap', false, 'over_cap'], ['excludedContract', true, 'excluded_contract'],
  ['excludedInvoice', true, 'excluded_invoice'],
] as const)('%s yields %s', (key, value, reason) => {
  expect(eligibilityReason({ ...good, [key]: value })).toBe(reason);
});
it('keeps a fully eligible invoice eligible', () => expect(eligibilityReason(good)).toBeNull());
