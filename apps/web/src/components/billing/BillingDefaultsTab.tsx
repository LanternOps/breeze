import { useTranslation } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { currencyLabel, currencyOptions } from '@/lib/currencies';

interface BillingDefaultsTabProps {
  currencyCode: string;
  setCurrencyCode: (v: string) => void;
  taxPercent: string;
  setTaxPercent: (v: string) => void;
  prefix: string;
  setPrefix: (v: string) => void;
  termsDays: string;
  setTermsDays: (v: string) => void;
}

/**
 * Currency / tax / invoice numbering / payment terms — the first tab of the
 * Billing settings page (M4). Markup/auto-tax-hardware/AI style moved to
 * CatalogDefaultsCard (they only ever pre-fill catalog import, never enter
 * price resolution).
 */
export default function BillingDefaultsTab({
  currencyCode, setCurrencyCode, taxPercent, setTaxPercent, prefix, setPrefix, termsDays, setTermsDays,
}: BillingDefaultsTabProps) {
  const { t } = useTranslation('billing');
  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs">
      <h2 className="text-lg font-semibold">{t('partnerBillingSettings.defaults.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('partnerBillingSettings.defaults.description')}
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-sm font-medium" htmlFor="pb-currency">{t('partnerBillingSettings.defaults.currencyCode')}</label>
          <select
            id="pb-currency" value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value)}
            data-testid="partner-billing-currency"
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {currencyOptions(currencyCode).map((code) => (
              <option key={code} value={code}>{currencyLabel(code, i18n.language)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="pb-tax">{t('partnerBillingSettings.defaults.defaultTaxRate')}</label>
          <input
            id="pb-tax" type="number" min={0} max={100} step="0.001" value={taxPercent}
            onChange={(e) => setTaxPercent(e.target.value)} placeholder={t('common:labels.none')}
            data-testid="partner-billing-tax"
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="pb-prefix">{t('partnerBillingSettings.defaults.invoiceNumberPrefix')}</label>
          <input
            id="pb-prefix" type="text" maxLength={12} value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            data-testid="partner-billing-prefix"
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="pb-terms-days">{t('partnerBillingSettings.defaults.paymentTermsDays')}</label>
          <input
            id="pb-terms-days" type="number" min={0} max={365} step="1" value={termsDays}
            onChange={(e) => setTermsDays(e.target.value)}
            data-testid="partner-billing-terms-days"
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
      </div>
    </section>
  );
}
