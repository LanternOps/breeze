import { bankNameLabel } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { i18n } from '../../lib/i18n';
import type {AutopayListRow as AutopayRow} from '@breeze/shared';
export type {AutopayListRow as AutopayRow} from '@breeze/shared';
export async function readAutopay<T>(path: string): Promise<T> {
  const response = await fetchWithAuth(path);
  if (!response.ok) throw new Error(i18n.t('billing:autopay.error'));
  return response.json() as Promise<T>;
}
/** `success` names what changed (e.g. "Automatic payments paused."); the default is generic.
 * `suppressErrorToast` lets a caller handle an expected answer (a step-up request) itself. */
export function mutateAutopay<T>(path: string, body: unknown, method = 'POST', success?: string,
  suppressErrorToast?: (status: number, code: string | undefined) => boolean): Promise<T> {
  return runAction<T>({ request: () => fetchWithAuth(path, { method, body: JSON.stringify(body) }),
    ...(suppressErrorToast ? { suppressErrorToast } : {}),
    errorFallback: i18n.t('billing:autopay.error'), successMessage: data => {
      // Skipped requests are explained per organization in the caller's result.
      // A partial or all-skipped response must not produce a success toast.
      if (data && typeof data === 'object' && 'requested' in data && 'skipped' in data) {
        const result = data as { requested: unknown[]; skipped: unknown[] };
        return result.requested.length > 0 && result.skipped.length === 0
          ? success ?? i18n.t('billing:autopay.requestedCount', { count: result.requested.length }) : '';
      }
      return success ?? i18n.t('billing:autopay.done');
    } });
}
// Stripe card.brand values. Brand names are proper nouns, so they are not translated.
const CARD_BRANDS: Record<string, string> = {
  amex: 'American Express', cartes_bancaires: 'Cartes Bancaires', diners: 'Diners Club', discover: 'Discover',
  eftpos_au: 'eftpos Australia', interac: 'Interac', jcb: 'JCB', link: 'Link', mastercard: 'Mastercard',
  unionpay: 'UnionPay', visa: 'Visa',
};
/** Display name for a Stripe card brand code; a generic "Card" when Stripe does not know it. */
export function cardBrandLabel(brand: string | null | undefined): string {
  const code = brand?.trim().toLowerCase() ?? '';
  if (!code || code === 'unknown') return i18n.t('billing:autopay.card');
  // A brand Stripe adds later reads as words, never as its code.
  return CARD_BRANDS[code] ?? code.split(/[_\s]+/).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}
export function methodLabel(method: AutopayRow['method']): string {
  if (!method) return '—';
  if (method.type !== 'card') return `${method.bankName ? bankNameLabel(method.bankName) : i18n.t('billing:autopay.bank')} ••${method.bankLast4 ?? '????'}`;
  const expiry = method.cardExpMonth && method.cardExpYear
    ? ` ${String(method.cardExpMonth).padStart(2, '0')}/${method.cardExpYear}` : '';
  return `${cardBrandLabel(method.cardBrand)} ••${method.cardLast4 ?? '????'}${expiry}`;
}

const attentionKeys: Record<string, string> = {
  method_unusable: 'autopay.needsAttention.method_unusable', stripe_account_changed: 'autopay.needsAttention.stripe_account_changed',
  key_missing_permissions: 'autopay.needsAttention.key_missing_permissions', verification_failed: 'autopay.needsAttention.verification_failed',
};
/** Staff copy for an enrollment's needs-attention reason; never the raw code. */
export function needsAttentionReason(reason: string): string {
  return i18n.t(/* i18n-dynamic */ `billing:${attentionKeys[reason] ?? 'autopay.status.needs_attention'}`);
}

export function skippedAutopayReason(reason:string):string{
 const keys:Record<string,string>={no_billing_contact:'autopay.skipNoContact',stripe_not_ready:'autopay.skipStripeNotReady',already_active:'autopay.skipAlreadyActive'};
 return i18n.t(/* i18n-dynamic */ keys[reason]?`billing:${keys[reason]}`:'billing:autopay.error');
}
