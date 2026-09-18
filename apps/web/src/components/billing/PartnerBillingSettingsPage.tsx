import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { pctFromFraction } from './invoiceTypes';
import { isHttpUrl } from '@breeze/shared';
import { resetPartnerCurrencyCache } from '@/lib/partnerCurrencyCache';
import { useHashTab } from '../../lib/useHashState';
import BillingDefaultsTab from './BillingDefaultsTab';
import BillingDocumentsTab from './BillingDocumentsTab';
import BillingConnectionsTab from './BillingConnectionsTab';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
// `rates` is NOT in BILLING_TABS: it is a reserved slot in the TABS config
// below (a typed entry with no button and no panel), not a selectable/hash
// -addressable tab yet. #4628 W02 adds the Rates panel and flips that one
// entry's `reserved` flag — it does not re-order or re-lay-out this page. Do
// not add 'rates' to this array or to activeTab's type until #4628 W02 does.
const BILLING_TABS = ['defaults', 'documents', 'connections'] as const;
type BillingTab = (typeof BILLING_TABS)[number];

interface PartnerBilling {
  currencyCode: string; defaultTaxRate: string | null; invoiceNumberPrefix: string; invoiceTermsDays: number;
  autoEmailInvoiceOnQuoteAccept: boolean; invoiceDeviceAppendix: boolean; invoiceFooter: string | null;
  documentTheme: 'classic' | 'condensed'; documentPageSize: 'letter' | 'a4';
  billingCompanyName: string | null; billingPhone: string | null; billingWebsite: string | null;
  billingAddressLine1: string | null; billingAddressLine2: string | null; billingAddressCity: string | null;
  billingAddressRegion: string | null; billingAddressPostalCode: string | null; billingAddressCountry: string | null;
  billingTermsAndConditions: string | null;
}

export default function PartnerBillingSettingsPage() {
  const { t } = useTranslation('billing');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useHashTab<BillingTab>(BILLING_TABS, 'defaults');

  const [currencyCode, setCurrencyCode] = useState('USD');
  const [taxPercent, setTaxPercent] = useState('');
  const [prefix, setPrefix] = useState('INV');
  const [termsDays, setTermsDays] = useState('30');
  const [autoEmailInvoice, setAutoEmailInvoice] = useState(true);
  const [deviceAppendix, setDeviceAppendix] = useState(false);
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
      setAutoEmailInvoice(p.autoEmailInvoiceOnQuoteAccept !== false);
      setDeviceAppendix(p.invoiceDeviceAppendix === true);
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

  const websiteTrimmed = website.trim();
  const websiteInvalid = websiteTrimmed !== '' && !isHttpUrl(websiteTrimmed);

  const save = useCallback(async () => {
    if (saving || websiteInvalid) return;
    setSaving(true);
    try {
      const pct = taxPercent.trim();
      const defaultTaxRate = pct === '' ? null : Number(pct) / 100;
      await runAction({
        request: () => fetchWithAuth('/partner/billing-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: currencyCode.trim().toUpperCase(),
            defaultTaxRate,
            invoiceNumberPrefix: prefix.trim(),
            invoiceTermsDays: Number(termsDays),
            autoEmailInvoiceOnQuoteAccept: autoEmailInvoice,
            invoiceDeviceAppendix: deviceAppendix,
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
      resetPartnerCurrencyCache();
      void load();
    } catch (err) {
      handleActionError(err, t('partnerBillingSettings.saveError'));
    } finally {
      setSaving(false);
    }
  }, [saving, websiteInvalid, currencyCode, taxPercent, prefix, termsDays, autoEmailInvoice, deviceAppendix,
      footer, documentTheme, documentPageSize, companyName, phone, website, addr1, addr2, city, region, postal, country, terms, load, t]);

  if (loading) return <p className="text-sm text-muted-foreground">{t('partnerBillingSettings.loading')}</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="partner-billing-load-error">
        {t('partnerBillingSettings.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </div>
    );
  }

  // Tab order is Defaults · Documents · Rates (reserved) · Connections — the
  // audit's target layout (§4). `rates` is a typed, unrendered placeholder so
  // #4628 W02 can add the real tab as a one-entry diff (flip `reserved` off,
  // supply a real labelKey) instead of re-laying-out this array. Never remove
  // or reorder this entry.
  const TABS: Array<{ id: BillingTab | 'rates'; labelKey: string; reserved?: true }> = [
    { id: 'defaults', labelKey: 'partnerBillingSettingsTabs.defaults' },
    { id: 'documents', labelKey: 'partnerBillingSettingsTabs.documents' },
    { id: 'rates', labelKey: 'partnerBillingSettingsTabs.rates', reserved: true },
    { id: 'connections', labelKey: 'partnerBillingSettingsTabs.connections' },
  ];
  // Cast is safe: filtering out `reserved` entries leaves only real BillingTab
  // ids, but TS can't narrow a `.filter()` predicate without a type guard —
  // a plain cast here is simpler than one and this array is tiny and local.
  const renderedTabs = TABS.filter((tab) => !tab.reserved) as Array<{ id: BillingTab; labelKey: string }>;

  return (
    <div className="space-y-6" data-testid="partner-billing-settings">
      <div role="tablist" className="flex gap-1 border-b" data-testid="billing-settings-tabs">
        {renderedTabs.map((tab) => (
          <button
            key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
            onClick={() => { window.location.hash = tab.id; setActiveTab(tab.id); }}
            data-testid={`billing-settings-tab-${tab.id}`}
            className={activeTab === tab.id ? 'border-b-2 border-primary px-4 py-2 text-sm font-medium -mb-px' : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground -mb-px'}
          >
            {t(/* i18n-dynamic */ tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab === 'defaults' && (
        <BillingDefaultsTab
          currencyCode={currencyCode} setCurrencyCode={setCurrencyCode}
          taxPercent={taxPercent} setTaxPercent={setTaxPercent}
          prefix={prefix} setPrefix={setPrefix}
          termsDays={termsDays} setTermsDays={setTermsDays}
        />
      )}
      {activeTab === 'documents' && (
        <BillingDocumentsTab
          autoEmailInvoice={autoEmailInvoice} setAutoEmailInvoice={setAutoEmailInvoice}
          deviceAppendix={deviceAppendix} setDeviceAppendix={setDeviceAppendix}
          footer={footer} setFooter={setFooter}
          documentTheme={documentTheme} setDocumentTheme={setDocumentTheme}
          documentPageSize={documentPageSize} setDocumentPageSize={setDocumentPageSize}
          companyName={companyName} setCompanyName={setCompanyName}
          phone={phone} setPhone={setPhone}
          website={website} setWebsite={setWebsite} websiteInvalid={websiteInvalid}
          addr1={addr1} setAddr1={setAddr1} addr2={addr2} setAddr2={setAddr2}
          city={city} setCity={setCity} region={region} setRegion={setRegion}
          postal={postal} setPostal={setPostal} country={country} setCountry={setCountry}
          terms={terms} setTerms={setTerms}
        />
      )}
      {activeTab === 'connections' && <BillingConnectionsTab />}

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
