import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';

interface PartnerCatalogDefaults {
  currencyCode: string; invoiceNumberPrefix: string; invoiceTermsDays: number;
  defaultMarkupPercent: string | null; autoTaxHardware: boolean; catalogAiStyle: string | null;
}

/**
 * Moved off Billing settings (M4): these three fields only ever pre-fill catalog
 * import (TD SYNNEX/EC Express) and the quote editor's "Auto-fill from web" —
 * verified, they never enter resolvePrice. Same PATCH endpoint as Billing
 * settings; the three base fields it requires ride along unedited.
 */
export default function CatalogDefaultsCard() {
  const { t } = useTranslation(['settings', 'billing']);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [base, setBase] = useState<{ currencyCode: string; invoiceNumberPrefix: string; invoiceTermsDays: number } | null>(null);
  const [markupPercent, setMarkupPercent] = useState('');
  const [autoTaxHardware, setAutoTaxHardware] = useState(true);
  const [aiStyle, setAiStyle] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth('/orgs/partners/me');
      if (!res.ok) throw new Error('load failed');
      const p = (await res.json()) as PartnerCatalogDefaults;
      setBase({ currencyCode: p.currencyCode, invoiceNumberPrefix: p.invoiceNumberPrefix, invoiceTermsDays: p.invoiceTermsDays });
      setMarkupPercent(p.defaultMarkupPercent != null ? String(Number(p.defaultMarkupPercent)) : '');
      setAutoTaxHardware(p.autoTaxHardware ?? true);
      setAiStyle(p.catalogAiStyle ?? '');
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (saving || !base) return;
    setSaving(true);
    try {
      const trimmed = markupPercent.trim();
      await runAction({
        request: () => fetchWithAuth('/partner/billing-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: base.currencyCode,
            invoiceNumberPrefix: base.invoiceNumberPrefix,
            invoiceTermsDays: base.invoiceTermsDays,
            defaultMarkupPercent: trimmed === '' ? null : Number(trimmed),
            autoTaxHardware,
            catalogAiStyle: aiStyle.trim() === '' ? null : aiStyle.trim(),
          }),
        }),
        errorFallback: t('catalogDefaultsCard.saveError'),
        successMessage: t('catalogDefaultsCard.saveSuccess'),
      });
      void load();
    } catch (err) {
      handleActionError(err, t('catalogDefaultsCard.saveError'));
    } finally {
      setSaving(false);
    }
  }, [saving, base, markupPercent, autoTaxHardware, aiStyle, load, t]);

  if (loading) return <p className="text-sm text-muted-foreground">{t('catalogDefaultsCard.loading')}</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="catalog-defaults-load-error">
        {t('catalogDefaultsCard.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </div>
    );
  }

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="catalog-defaults-card">
      <h2 className="text-lg font-semibold">{t('catalogDefaultsCard.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('catalogDefaultsCard.description')}</p>
      <div className="mt-4">
        <label className="text-sm font-medium" htmlFor="cd-markup">{t('billing:partnerBillingSettings.defaults.defaultMarkup')}</label>
        <input
          id="cd-markup" type="number" min={0} max={9999.99} step="0.01" value={markupPercent}
          onChange={(e) => setMarkupPercent(e.target.value)} placeholder={t('common:labels.none')}
          data-testid="catalog-defaults-markup"
          className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm sm:w-64"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('billing:partnerBillingSettings.defaults.markupHelp')}</p>
      </div>
      <div className="mt-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox" checked={autoTaxHardware} onChange={(e) => setAutoTaxHardware(e.target.checked)}
            data-testid="catalog-defaults-auto-tax-hardware" className="h-4 w-4 rounded border"
          />
          <span className="text-sm font-medium">{t('billing:partnerBillingSettings.defaults.autoTaxHardware')}</span>
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{t('billing:partnerBillingSettings.defaults.autoTaxHardwareHelp')}</p>
      </div>
      <div className="mt-4">
        <label className="text-sm font-medium" htmlFor="cd-ai-style">{t('billing:partnerBillingSettings.defaults.aiStyle')}</label>
        <textarea
          id="cd-ai-style" rows={4} value={aiStyle} maxLength={2000}
          onChange={(e) => setAiStyle(e.target.value)}
          placeholder={t('billing:partnerBillingSettings.defaults.aiStylePlaceholder')}
          data-testid="catalog-defaults-ai-style"
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('billing:partnerBillingSettings.defaults.aiStyleHelp')}</p>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving}
          data-testid="catalog-defaults-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('common:states.saving') : t('catalogDefaultsCard.saveButton')}
        </button>
      </div>
    </section>
  );
}
