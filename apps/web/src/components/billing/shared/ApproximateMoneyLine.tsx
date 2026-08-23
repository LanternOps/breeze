import { useTranslation } from 'react-i18next';

import { selectApproxTotal } from '@/lib/reporting/approximateTotal';
import { useApproximateTotal } from '@/lib/useApproximateTotal';
import { formatMoney } from './format';

/**
 * The optional "≈ X <partner currency>" companion line (multi-currency spec §8).
 * It NEVER replaces the authoritative per-currency segmentation above it, and it
 * renders nothing at all when a single leg is missing or stale — an approximate
 * total that silently drops a currency is worse than no total. All conversion
 * and summation happened on the server; this component only formats.
 */
export function ApproximateMoneyLine({ byCurrency, date, testId }: {
  byCurrency: readonly { code: string; amount: string | number }[];
  date?: string;
  testId?: string;
}) {
  const { t } = useTranslation('common');
  const { response, loading, failed } = useApproximateTotal(byCurrency, date);
  if (loading || failed) return null;
  const view = selectApproxTotal(response);
  if (view.status !== 'available') return null;
  return (
    <div className="text-xs text-muted-foreground" data-testid={testId ?? 'approximate-money-line'}>
      {t('money.approximateTotal', {
        amount: formatMoney(view.amount, view.currencyCode),
        rateDate: view.rateDate,
      })}
    </div>
  );
}

export default ApproximateMoneyLine;
