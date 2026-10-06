import type Stripe from 'stripe';
import { expect, it } from 'vitest';
import { prospectiveFeeText, verifiedFeeText, paymentFeeLine, chargeTotalLine } from './feeDisclosure';
it('explains the maximum and excludes every non-credit funding result', () => {
  const text = prospectiveFeeText({ feeAmount: '2.00', kind: 'card_percent', appliedBps: 200, reason: 'state_capped' }, 'USD');
  expect(text).toContain('2.00%'); expect(text).toContain('Debit, prepaid and unknown-funding cards have no fee');
  for (const funding of ['debit','prepaid','unknown',null]) expect(verifiedFeeText('card', funding, text)).toBe('No processing fee applies to this card.');
  expect(verifiedFeeText('card', 'credit', text, verifiedCard)).toBe(text);
  expect(paymentFeeLine('100.00','3.00','USD','card')).toBe('$100.00 + $3.00 card processing fee');
  expect(paymentFeeLine('100.00','2.50','USD','us_bank_account')).toBe('$100.00 + $2.50 bank processing fee');
  expect(paymentFeeLine('100.00','0.00','USD','card')).toBe('$100.00; no processing fee');
});
it('shows a flat fee and never labels setup as an immediate charge', () => {
  expect(prospectiveFeeText({ feeAmount:'2.50', kind:'ach_flat', appliedBps:null, reason:'applied' }, 'USD'))
    .toBe('Each bank payment includes a $2.50 processing fee. Saving this method does not itself charge a fee.');
});

const verifiedCard = { brand: 'visa', funding: 'credit', wallet: null,
  networks: { available: ['visa'], preferred: null } } as Stripe.PaymentMethod.Card;
it.each([
  undefined,
  { ...verifiedCard, wallet: { type: 'link' } },
  { ...verifiedCard, wallet: undefined },
  { ...verifiedCard, wallet: { type: 'unknown' } },
  { ...verifiedCard, networks: undefined },
  { ...verifiedCard, networks: { available: [], preferred: null } },
  { ...verifiedCard, networks: { available: ['unknown'], preferred: null } },
  { ...verifiedCard, networks: { available: ['visa'], preferred: 'unknown' } },
  { ...verifiedCard, brand: 'unknown' },
  { ...verifiedCard, funding: 'debit' },
])('fails closed for unsupported or absent live card evidence: %j', evidence => {
  expect(verifiedFeeText('card', 'credit', 'Credit card: up to 3.00% per automatic payment.',
    evidence as Stripe.PaymentMethod.Card | undefined)).toBe('No processing fee applies to this card.');
});
it('preserves bank terms and formats non-USD and zero-fee amounts', () => {
  expect(verifiedFeeText('us_bank_account', null, 'Bank fee')).toBe('Bank fee');
  expect(prospectiveFeeText({feeAmount:'0.00',kind:'none',appliedBps:null,reason:'disabled'},'USD')).toBe('No processing fee applies.');
  expect(paymentFeeLine('100.00','0','EUR','card')).toBe('EUR 100.00; no processing fee');
});

it('states the total that will be charged, principal plus fee (D-26)', () => {
  expect(chargeTotalLine('100.00','3.00','USD','card')).toBe('Total charge: $103.00 ($100.00 + $3.00 card processing fee)');
  expect(chargeTotalLine('150.00','1.00','USD','us_bank_account')).toBe('Total charge: $151.00 ($150.00 + $1.00 bank processing fee)');
  expect(chargeTotalLine('100.00','0.00','USD','card')).toBe('Total charge: $100.00 (no processing fee)');
  expect(chargeTotalLine('100.00','0','EUR','card')).toBe('Total charge: EUR 100.00 (no processing fee)');
});
