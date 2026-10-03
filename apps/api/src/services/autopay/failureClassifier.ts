// failureClassifier.ts
import type { AutopayPaymentMethodType, CollectionFailureClass } from '@breeze/shared';
const SOFT = new Set(['insufficient_funds', 'issuer_not_available', 'processing_error', 'try_again_later', 'reenter_transaction']);
const REVOKED = new Set(['R05', 'R07', 'R08', 'R10', 'R29']);
export function classifyCollectionFailure(input: {
  methodType: AutopayPaymentMethodType; code: string | null; declineCode: string | null;
  achReturnCode: string | null; piStatus: string;
}): CollectionFailureClass {
  if (input.piStatus === 'requires_action' || input.code === 'authentication_required'
    || input.declineCode === 'authentication_required') return 'auth_required';
  if (input.methodType === 'us_bank_account') {
    const code = input.achReturnCode?.toUpperCase();
    if (code === 'R01' || code === 'R09') return 'nsf';
    if (code && REVOKED.has(code)) return 'revoked';
    return 'hard';
  }
  return SOFT.has(input.declineCode ?? input.code ?? '') ? 'soft' : 'hard';
}
