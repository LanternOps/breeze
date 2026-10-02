import type {AutopayCustomerPage as AutopayPageData} from '@breeze/shared';
export type {AutopayPaymentMethodType as MethodType,AutopayCustomerPage as AutopayPageData,AutopaySetupResult as SetupOutcome,AutopayPortalPage} from '@breeze/shared';
export function savedMethodLabel(method: AutopayPageData['method']): string {
  if (!method) return 'No payment method on file';
  return method.type === 'card' ? `${method.cardBrand ?? 'Card'} ${method.cardFunding ?? ''} ••${method.cardLast4 ?? '????'}`
    : `${method.bankName ?? 'Bank account'} ••${method.bankLast4 ?? '????'}`;
}
