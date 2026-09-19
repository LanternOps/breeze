import { useTranslation } from 'react-i18next';

/**
 * Plain links, not a status widget (M6) — no read-only Stripe/QuickBooks
 * connection-status endpoint exists for this tab to call without an API
 * change (grepped `apps/api/src/routes` for a GET status route; none found).
 * Stripe/QuickBooks keep their full read+write flow on
 * `/integrations#accounting`.
 */
export default function BillingConnectionsTab() {
  const { t } = useTranslation('billing');
  return (
    <div className="space-y-4" data-testid="billing-connections-tab">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('billingConnectionsTab.accounting.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('billingConnectionsTab.accounting.description')}</p>
        <a
          href="/integrations#accounting" data-testid="billing-connections-accounting-link"
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t('billingConnectionsTab.accounting.cta')}
        </a>
      </section>
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('billingConnectionsTab.catalog.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('billingConnectionsTab.catalog.description')}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-4">
          <a href="/settings/catalog" data-testid="billing-connections-catalog-link" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            {t('billingConnectionsTab.catalog.catalogCta')}
          </a>
          <a href="/integrations#distributors" data-testid="billing-connections-distributors-link" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            {t('billingConnectionsTab.catalog.distributorsCta')}
          </a>
        </div>
      </section>
    </div>
  );
}
