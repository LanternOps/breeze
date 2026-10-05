import { AUTOPAY_LINK_FAILURE_CODES, formatPaymentMethod, formatPercentBps,
  type AutopayCustomerPage as AutopayPageData, type AutopayLinkFailureCode, type AutopayLinkFailureDetails } from '@breeze/shared';
import type { ApiResponse } from './api';
import { money } from './format';
export type {AutopayPaymentMethodType as MethodType,AutopayCustomerPage as AutopayPageData,AutopaySetupResult as SetupOutcome,AutopayPortalPage} from '@breeze/shared';

/** "Visa credit card ending in 4242": never a raw brand slug or funding code (lab D-11). */
export function savedMethodLabel(method: AutopayPageData['method']): string {
  return method ? formatPaymentMethod(method) : 'No payment method on file';
}

/** A link that can't be used, as the page sees it: the code plus the error body's data. */
export function linkFailureOf(response: ApiResponse<unknown>): ({ code: AutopayLinkFailureCode } & AutopayLinkFailureDetails) | null {
  const code = response.code as AutopayLinkFailureCode | undefined;
  if (!code || !(AUTOPAY_LINK_FAILURE_CODES as readonly string[]).includes(code)) return null;
  const data = response.errorData && typeof response.errorData === 'object' ? response.errorData as AutopayLinkFailureDetails : {};
  return { ...data, code };
}

type FeeQuote = { kind?: 'none' | 'card_percent' | 'ach_flat'; feeAmount?: string; appliedBps?: number | null };
/** Short fee words for a method row: "$1.00 fee", "Credit cards: up to 3% fee", "No fee". */
export function methodFeeLabel(type: 'card' | 'us_bank_account', quote: FeeQuote | undefined, currency = 'USD'): string | null {
  if (!quote?.kind) return null;
  if (quote.kind === 'none') return 'No fee';
  if (quote.kind === 'ach_flat') return `${money(quote.feeAmount ?? '0', currency)} fee`;
  return type === 'card' && quote.appliedBps != null ? `Credit cards: up to ${formatPercentBps(quote.appliedBps)} fee` : null;
}
