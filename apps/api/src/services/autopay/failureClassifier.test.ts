import { expect, it } from 'vitest';
import { classifyCollectionFailure } from './failureClassifier';
it.each([
  ['card', 'card_declined', 'insufficient_funds', null, 'requires_payment_method', 'soft'],
  ['card', 'card_declined', 'issuer_not_available', null, 'requires_payment_method', 'soft'],
  ['card', 'card_declined', 'stolen_card', null, 'requires_payment_method', 'hard'],
  ['card', 'expired_card', null, null, 'requires_payment_method', 'hard'],
  ['card', 'authentication_required', null, null, 'requires_payment_method', 'auth_required'],
  ['card', null, null, null, 'requires_action', 'auth_required'],
  ['card', 'card_declined', 'unknown_new_code', null, 'requires_payment_method', 'hard'],
  ['us_bank_account', null, null, 'R01', 'requires_payment_method', 'nsf'],
  ['us_bank_account', null, null, 'R09', 'requires_payment_method', 'nsf'],
  ...['R02','R03','R04','R16','R20'].map(code => ['us_bank_account', null, null, code, 'requires_payment_method', 'hard'] as const),
  ...['R05','R07','R08','R10','R29'].map(code => ['us_bank_account', null, null, code, 'requires_payment_method', 'revoked'] as const),
] as const)('classifies %s/%s/%s/%s', (methodType, code, declineCode, achReturnCode, piStatus, expected) => {
  expect(classifyCollectionFailure({ methodType: methodType as 'card' | 'us_bank_account',
    code, declineCode, achReturnCode, piStatus: piStatus! })).toBe(expected);
});

it.each(['processing_error', 'try_again_later', 'reenter_transaction'])('retries the documented soft card decline %s', declineCode => {
  expect(classifyCollectionFailure({ methodType: 'card', code: 'card_declined', declineCode, achReturnCode: null, piStatus: 'requires_payment_method' })).toBe('soft');
});
it.each(['r01', 'r09'])('normalizes ACH return code %s', achReturnCode => {
  expect(classifyCollectionFailure({ methodType: 'us_bank_account', code: null, declineCode: null, achReturnCode, piStatus: 'requires_payment_method' })).toBe('nsf');
});
it.each([null, 'R99'])('unknown bank failures never guess NSF: %s', achReturnCode => {
  expect(classifyCollectionFailure({ methodType: 'us_bank_account', code: 'insufficient_funds', declineCode: null, achReturnCode, piStatus: 'requires_payment_method' })).toBe('hard');
});
it('recognizes authentication_required in the decline code', () => {
  expect(classifyCollectionFailure({ methodType: 'card', code: 'card_declined', declineCode: 'authentication_required', achReturnCode: null, piStatus: 'requires_payment_method' })).toBe('auth_required');
});
