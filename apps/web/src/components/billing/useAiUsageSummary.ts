import { useTranslation } from 'react-i18next';
import { normalizeAiUsage, type AiUsageValue } from './aiUsagePricing';

/** One resolver for the AI terms wording, shared by the Rates table column and
 * the org read-only line. Pass any profile-shaped object; missing fields read
 * as "Not billed". */
export function useAiUsageSummary() {
  const { t } = useTranslation('billing');
  return (terms: Partial<AiUsageValue> | null | undefined): string => {
    const { aiCoverage, aiMarkupPercent, aiRates } = normalizeAiUsage(terms);
    if (aiCoverage === 'included') return t('rates.ai.summaryIncluded');
    if (aiCoverage === 'non_billable') return t('rates.ai.summaryNotBilled');
    const count = aiRates.length;
    const hasMarkup = aiMarkupPercent !== null && aiMarkupPercent !== '';
    const percent = hasMarkup ? String(Number(aiMarkupPercent)) : '';
    if (count > 0 && hasMarkup) return t('rates.ai.summaryBillablePriceListMarkup', { count, percent });
    if (count > 0) return t('rates.ai.summaryBillablePriceList', { count });
    if (hasMarkup) return t('rates.ai.summaryBillableMarkup', { percent });
    return t('rates.ai.summaryBillableUnpriced');
  };
}
