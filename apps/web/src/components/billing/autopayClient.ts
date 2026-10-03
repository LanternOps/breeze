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
export function mutateAutopay<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return runAction<T>({ request: () => fetchWithAuth(path, { method, body: JSON.stringify(body) }),
    errorFallback: i18n.t('billing:autopay.error'), successMessage: data => {
      // Skipped requests are explained per organization in the caller's result.
      // A partial or all-skipped response must not produce a success toast.
      if (data && typeof data === 'object' && 'requested' in data && 'skipped' in data) {
        const result = data as { requested: unknown[]; skipped: unknown[] };
        return result.requested.length > 0 && result.skipped.length === 0
          ? i18n.t('billing:autopay.requestedCount', { count: result.requested.length }) : '';
      }
      return i18n.t('billing:autopay.done');
    } });
}
export function methodLabel(method: AutopayRow['method']): string {
  if (!method) return '—';
  return method.type === 'card'
    ? `${method.cardBrand ?? i18n.t('billing:autopay.card')} ••${method.cardLast4 ?? '????'} ${method.cardExpMonth ?? ''}/${method.cardExpYear ?? ''}`
    : `${method.bankName ?? i18n.t('billing:autopay.bank')} ••${method.bankLast4 ?? '????'}`;
}

export function skippedAutopayReason(reason:string):string{
 const keys:Record<string,string>={no_billing_contact:'autopay.skipNoContact',stripe_not_ready:'autopay.skipStripeNotReady',already_active:'autopay.skipAlreadyActive'};
 return i18n.t(/* i18n-dynamic */ keys[reason]?`billing:${keys[reason]}`:'billing:autopay.error');
}
