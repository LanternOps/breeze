import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { currencyLabel, currencyOptions } from '@/lib/currencies';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { pctFromFraction } from './invoiceTypes';
import { isHttpUrl, httpUrlErrorMessage } from '@breeze/shared';
import { resetPartnerCurrencyCache } from '@/lib/partnerCurrencyCache';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface PartnerBilling {
  currencyCode: string;
  defaultTaxRate: string | null;
  invoiceNumberPrefix: string;
  invoiceTermsDays: number;
  defaultMarkupPercent: string | null;
  autoTaxHardware: boolean;
  autoEmailInvoiceOnQuoteAccept: boolean;
  invoiceDeviceAppendix: boolean;
  catalogAiStyle: string | null;
  invoiceFooter: string | null;
  documentTheme: 'classic' | 'condensed';
  documentPageSize: 'letter' | 'a4';
  billingCompanyName: string | null;
  billingPhone: string | null;
  billingWebsite: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingAddressCity: string | null;
  billingAddressRegion: string | null;
  billingAddressPostalCode: string | null;
  billingAddressCountry: string | null;
  billingTermsAndConditions: string | null;
}

export default function PartnerBillingSettings() {
  const { t } = useTranslation('billing');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const [currencyCode, setCurrencyCode] = useState('USD');
  // Tax rate edited as a percentage (e.g. 8.5) but stored/sent as a fraction.
  const [taxPercent, setTaxPercent] = useState('');
  const [prefix, setPrefix] = useState('INV');
  const [termsDays, setTermsDays] = useState('30');
  // Default markup over distributor cost used to pre-fill catalog import prices.
  const [markupPercent, setMarkupPercent] = useState('');
  // When true, hardware catalog items default to taxable on import.
  const [autoTaxHardware, setAutoTaxHardware] = useState(true);
  // Default ON — same `!== false` read-back as the server-side accept gate.
  const [autoEmailInvoice, setAutoEmailInvoice] = useState(true);
  const [deviceAppendix, setDeviceAppendix] = useState(false);
  // Partner AI copy style for Auto-fill/Polish; empty = built-in house format.
  const [aiStyle, setAiStyle] = useState('');
  const [footer, setFooter] = useState('');
  const [documentTheme, setDocumentTheme] = useState<'classic' | 'condensed'>('classic');
  const [documentPageSize, setDocumentPageSize] = useState<'letter' | 'a4'>('letter');
  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [addr1, setAddr1] = useState('');
  const [addr2, setAddr2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');
  const [country, setCountry] = useState('');
  const [terms, setTerms] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth('/orgs/partners/me');
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('load failed');
      const p = (await res.json()) as PartnerBilling;
      setCurrencyCode(p.currencyCode ?? 'USD');
      setTaxPercent(pctFromFraction(p.defaultTaxRate));
      setPrefix(p.invoiceNumberPrefix ?? 'INV');
      setTermsDays(String(p.invoiceTermsDays ?? 30));
      setMarkupPercent(p.defaultMarkupPercent != null ? String(Number(p.defaultMarkupPercent)) : '');
      setAutoTaxHardware(p.autoTaxHardware ?? true);
      setAutoEmailInvoice(p.autoEmailInvoiceOnQuoteAccept !== false);
      setDeviceAppendix(p.invoiceDeviceAppendix === true);
      setAiStyle(p.catalogAiStyle ?? '');
      setFooter(p.invoiceFooter ?? '');
      setDocumentTheme(p.documentTheme ?? 'classic');
      setDocumentPageSize(p.documentPageSize ?? 'letter');
      setCompanyName(p.billingCompanyName ?? '');
      setPhone(p.billingPhone ?? '');
      setWebsite(p.billingWebsite ?? '');
      setAddr1(p.billingAddressLine1 ?? '');
      setAddr2(p.billingAddressLine2 ?? '');
      setCity(p.billingAddressCity ?? '');
      setRegion(p.billingAddressRegion ?? '');
      setPostal(p.billingAddressPostalCode ?? '');
      setCountry(p.billingAddressCountry ?? '');
      setTerms(p.billingTermsAndConditions ?? '');
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // #3430 — billingWebsite is now http/https-only server-side. This form PATCHes
  // the FULL payload, so a legacy scheme-less value loaded at :79 would 400 an
  // otherwise-unrelated edit (tax rate, invoice prefix) with only a toast naming
  // the wire field. Flagging it inline points at the field that actually needs
  // fixing, before the round-trip.
  const websiteTrimmed = website.trim();
  const websiteInvalid = websiteTrimmed !== '' && !isHttpUrl(websiteTrimmed);

  const save = useCallback(async () => {
    if (saving) return;
    if (websiteInvalid) return;
    setSaving(true);
    try {
      const pct = taxPercent.trim();
      const defaultTaxRate = pct === '' ? null : Number(pct) / 100;
      const markupTrimmed = markupPercent.trim();
      const defaultMarkupPercent = markupTrimmed === '' ? null : Number(markupTrimmed);
      await runAction({
        request: () => fetchWithAuth('/partner/billing-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: currencyCode.trim().toUpperCase(),
            defaultTaxRate,
            invoiceNumberPrefix: prefix.trim(),
            invoiceTermsDays: Number(termsDays),
            defaultMarkupPercent,
            autoTaxHardware,
            autoEmailInvoiceOnQuoteAccept: autoEmailInvoice,
            invoiceDeviceAppendix: deviceAppendix,
            catalogAiStyle: aiStyle.trim() === '' ? null : aiStyle.trim(),
            invoiceFooter: footer.trim() === '' ? null : footer,
            documentTheme,
            documentPageSize,
            billingCompanyName: companyName.trim() === '' ? null : companyName.trim(),
            billingPhone: phone.trim() === '' ? null : phone.trim(),
            billingWebsite: website.trim() === '' ? null : website.trim(),
            billingAddressLine1: addr1.trim() === '' ? null : addr1.trim(),
            billingAddressLine2: addr2.trim() === '' ? null : addr2.trim(),
            billingAddressCity: city.trim() === '' ? null : city.trim(),
            billingAddressRegion: region.trim() === '' ? null : region.trim(),
            billingAddressPostalCode: postal.trim() === '' ? null : postal.trim(),
            billingAddressCountry: country.trim() === '' ? null : country.trim().toUpperCase(),
            billingTermsAndConditions: terms.trim() === '' ? null : terms,
          }),
        }),
        errorFallback: t('partnerBillingSettings.saveError'),
        successMessage: t('partnerBillingSettings.saveSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      // The reporting currency may have just changed. Both money caches key off
      // this one: partnerCurrencyCache feeds every currency LABEL, and the
      // approximate-total cache is bound to its generation, so its converted
      // figures (denominated in the SERVER-derived reporting currency, which
      // their key cannot name) are dropped in the same motion. Without this the
      // tab renders the previous currency until logout.
      resetPartnerCurrencyCache();
      void load();
    } catch (err) {
      handleActionError(err, t('partnerBillingSettings.saveError'));
    } finally {
      setSaving(false);
    }
  }, [saving, websiteInvalid, currencyCode, taxPercent, prefix, termsDays, markupPercent, autoTaxHardware, autoEmailInvoice, deviceAppendix, aiStyle, footer,
      documentTheme, documentPageSize, companyName, phone, website, addr1, addr2, city, region, postal, country, terms, load]);

  if (loading) return <p className="text-sm text-muted-foreground">{t('partnerBillingSettings.loading')}</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="partner-billing-load-error">
        {t('partnerBillingSettings.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="partner-billing-settings">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('partnerBillingSettings.defaults.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('partnerBillingSettings.defaults.description')}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="pb-currency">{t('partnerBillingSettings.defaults.currencyCode')}</label>
            {/* #3204: was a free-text maxLength={3} input, which accepted a
                typo'd or non-existent code and only surfaced it once a document
                rendered. Any already-stored off-list code stays selectable via
                currencyOptions so an existing setting is never silently reset. */}
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
          <div>
            <label className="text-sm font-medium" htmlFor="pb-markup">{t('partnerBillingSettings.defaults.defaultMarkup')}</label>
            <input
              id="pb-markup" type="number" min={0} max={9999.99} step="0.01" value={markupPercent}
              onChange={(e) => setMarkupPercent(e.target.value)} placeholder={t('common:labels.none')}
              data-testid="partner-billing-markup"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('partnerBillingSettings.defaults.markupHelp')}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              id="pb-auto-tax-hardware"
              type="checkbox"
              checked={autoTaxHardware}
              onChange={(e) => setAutoTaxHardware(e.target.checked)}
              data-testid="partner-billing-auto-tax-hardware"
              className="h-4 w-4 rounded border"
            />
            <span className="text-sm font-medium">{t('partnerBillingSettings.defaults.autoTaxHardware')}</span>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('partnerBillingSettings.defaults.autoTaxHardwareHelp')}
          </p>
        </div>
        <div className="mt-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              id="pb-auto-email-invoice"
              type="checkbox"
              checked={autoEmailInvoice}
              onChange={(e) => setAutoEmailInvoice(e.target.checked)}
              data-testid="partner-billing-auto-email-invoice"
              className="h-4 w-4 rounded border"
            />
            <span className="text-sm font-medium">{t('partnerBillingSettings.defaults.autoEmailInvoice')}</span>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('partnerBillingSettings.defaults.autoEmailInvoiceHelp')}
          </p>
        </div>
        <div className="mt-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              id="pb-device-appendix"
              type="checkbox"
              checked={deviceAppendix}
              onChange={(e) => setDeviceAppendix(e.target.checked)}
              data-testid="partner-billing-device-appendix"
              className="h-4 w-4 rounded border"
            />
            <span className="text-sm font-medium">{t('partnerBillingSettings.defaults.deviceAppendix')}</span>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('partnerBillingSettings.defaults.deviceAppendixHelp')}
          </p>
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-ai-style">{t('partnerBillingSettings.defaults.aiStyle')}</label>
          <textarea
            id="pb-ai-style" rows={4} value={aiStyle} maxLength={2000}
            onChange={(e) => setAiStyle(e.target.value)}
            placeholder={t('partnerBillingSettings.defaults.aiStylePlaceholder')}
            data-testid="partner-billing-ai-style"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t('partnerBillingSettings.defaults.aiStyleHelp')}
          </p>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="pb-document-theme">{t('partnerBillingSettings.defaults.documentTheme')}</label>
            <select
              id="pb-document-theme" value={documentTheme}
              onChange={(e) => setDocumentTheme(e.target.value as 'classic' | 'condensed')}
              data-testid="partner-billing-document-theme"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="classic">{t('partnerBillingSettings.defaults.documentThemeClassic')}</option>
              <option value="condensed">{t('partnerBillingSettings.defaults.documentThemeCondensed')}</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-document-page-size">{t('partnerBillingSettings.defaults.documentPageSize')}</label>
            <select
              id="pb-document-page-size" value={documentPageSize}
              onChange={(e) => setDocumentPageSize(e.target.value as 'letter' | 'a4')}
              data-testid="partner-billing-document-page-size"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="letter">{t('partnerBillingSettings.defaults.documentPageSizeLetter')}</option>
              <option value="a4">{t('partnerBillingSettings.defaults.documentPageSizeA4')}</option>
            </select>
          </div>
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-footer">{t('partnerBillingSettings.defaults.invoiceFooter')}</label>
          <textarea
            id="pb-footer" rows={3} value={footer}
            onChange={(e) => setFooter(e.target.value)} placeholder={t('partnerBillingSettings.defaults.invoiceFooterPlaceholder')}
            data-testid="partner-billing-footer"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('partnerBillingSettings.company.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('partnerBillingSettings.company.description')}
        </p>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-company">{t('partnerBillingSettings.company.name')}</label>
          <input
            id="pb-company" type="text" value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            data-testid="partner-billing-company-name"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="pb-phone">{t('partnerBillingSettings.company.phone')}</label>
            <input
              id="pb-phone" type="text" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="partner-billing-phone"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-website">{t('partnerBillingSettings.company.website')}</label>
            <input
              id="pb-website" type="text" value={website}
              onChange={(e) => setWebsite(e.target.value)}
              data-testid="partner-billing-website"
              aria-invalid={websiteInvalid || undefined}
              aria-describedby={websiteInvalid ? 'pb-website-error' : undefined}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            {websiteInvalid && (
              <p id="pb-website-error" data-testid="partner-billing-website-error" className="mt-1 text-sm text-destructive">
                {httpUrlErrorMessage(t('partnerBillingSettings.company.website'))}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-addr1">{t('partnerBillingSettings.company.addressLine1')}</label>
          <input
            id="pb-addr1" type="text" value={addr1}
            onChange={(e) => setAddr1(e.target.value)}
            data-testid="partner-billing-addr1"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-addr2">{t('partnerBillingSettings.company.addressLine2')}</label>
          <input
            id="pb-addr2" type="text" value={addr2}
            onChange={(e) => setAddr2(e.target.value)}
            data-testid="partner-billing-addr2"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className="text-sm font-medium" htmlFor="pb-city">{t('partnerBillingSettings.company.city')}</label>
            <input
              id="pb-city" type="text" value={city}
              onChange={(e) => setCity(e.target.value)}
              data-testid="partner-billing-city"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-region">{t('partnerBillingSettings.company.region')}</label>
            <input
              id="pb-region" type="text" value={region}
              onChange={(e) => setRegion(e.target.value)}
              data-testid="partner-billing-region"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-postal">{t('partnerBillingSettings.company.postal')}</label>
            <input
              id="pb-postal" type="text" value={postal}
              onChange={(e) => setPostal(e.target.value)}
              data-testid="partner-billing-postal"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-4 sm:w-24">
          <label className="text-sm font-medium" htmlFor="pb-country">{t('partnerBillingSettings.company.country')}</label>
          <input
            id="pb-country" type="text" maxLength={2} value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            data-testid="partner-billing-country"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm uppercase"
          />
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-tc">{t('partnerBillingSettings.company.defaultTerms')}</label>
          <textarea
            id="pb-tc" rows={4} value={terms}
            onChange={(e) => setTerms(e.target.value)}
            placeholder={t('partnerBillingSettings.company.defaultTermsPlaceholder')}
            data-testid="partner-billing-terms"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving || websiteInvalid}
          data-testid="partner-billing-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('common:states.saving') : t('partnerBillingSettings.saveButton')}
        </button>
      </div>
    </div>
  );
}
