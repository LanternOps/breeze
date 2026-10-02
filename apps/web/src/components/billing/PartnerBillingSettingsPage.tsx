import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { pctFromFraction } from './invoiceTypes';
import { isHttpUrl, parseCompanyContact, parseCompanyAddress, isCompanyAddressBlank } from '@breeze/shared';
import { resetPartnerCurrencyCache } from '@/lib/partnerCurrencyCache';
import { usePermissions } from '../../lib/permissions';
import { useHashTab } from '../../lib/useHashState';
import { OverflowTabs, overflowPanelId, overflowTabId, type OverflowTab } from '../shared/OverflowTabs';
import AccessDenied from '../shared/AccessDenied';
import BillingDefaultsTab from './BillingDefaultsTab';
import BillingDocumentsTab from './BillingDocumentsTab';
import BillingConnectionsTab from './BillingConnectionsTab';
import BillingRatesTab from './BillingRatesTab';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const BILLING_TABS = ['defaults', 'documents', 'rates', 'connections'] as const;
type BillingTab = (typeof BILLING_TABS)[number];

interface PartnerBilling {
  currencyCode: string; defaultTaxRate: string | null; invoiceNumberPrefix: string; invoiceTermsDays: number;
  autoEmailInvoiceOnQuoteAccept: boolean; notifyCustomerOnBehalfAcceptance?: boolean; invoiceDeviceAppendix: boolean; invoiceFooter: string | null;
  documentTheme: 'classic' | 'condensed'; documentPageSize: 'letter' | 'a4';
  // partners.name — the seller name documents print when billingCompanyName is
  // blank (sellerSnapshot: nonBlank(billingCompanyName) ?? nonBlank(name)).
  name?: string | null;
  billingCompanyName: string | null; billingPhone: string | null; billingWebsite: string | null;
  billingAddressLine1: string | null; billingAddressLine2: string | null; billingAddressCity: string | null;
  billingAddressRegion: string | null; billingAddressPostalCode: string | null; billingAddressCountry: string | null;
  billingTermsAndConditions: string | null;
  // "Company details" fallback tier for the letterhead override (#6228) — same
  // shape GET /orgs/partners/me already returns (partnerPublicColumns()).
  settings?: { contact?: unknown; address?: unknown } | null;
}

export default function PartnerBillingSettingsPage() {
  const { t } = useTranslation('billing');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  // Same grant the PATCH /partner/billing-settings route requires (invoices:write).
  const { can } = usePermissions();
  const hasWriteGrant = can('invoices', 'write');
  // The route ALSO requires partner-wide access (requirePartnerWideBillingAdmin →
  // canManagePartnerWidePolicies). Read the API's answer from /users/me instead of
  // re-deriving it; absent (stale session) is treated as capable — the server
  // still enforces and the 403 toast remains the backstop (#7517).
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const canWrite = hasWriteGrant && canManagePartnerWide;
  const [activeTab, setActiveTab] = useHashTab<BillingTab>(BILLING_TABS, 'defaults');

  const [currencyCode, setCurrencyCode] = useState('USD');
  const [taxPercent, setTaxPercent] = useState('');
  const [prefix, setPrefix] = useState('INV');
  const [termsDays, setTermsDays] = useState('30');
  const [autoEmailInvoice, setAutoEmailInvoice] = useState(true);
  const [notifyOnBehalfAcceptance, setNotifyOnBehalfAcceptance] = useState(false);
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
  // Resolved "company details" values, read straight off the same GET response —
  // the InheritedField placeholder/source for the letterhead override fields (#6228).
  const [inheritedCompanyName, setInheritedCompanyName] = useState<string | null>(null);
  const [inheritedPhone, setInheritedPhone] = useState<string | null>(null);
  const [inheritedWebsite, setInheritedWebsite] = useState<string | null>(null);
  const [inheritedAddress, setInheritedAddress] = useState<ReturnType<typeof parseCompanyAddress> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setDenied(false);
    try {
      const res = await fetchWithAuth('/orgs/partners/me');
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 403) { setDenied(true); return; }
      if (!res.ok) throw new Error('load failed');
      const p = (await res.json()) as PartnerBilling;
      setCurrencyCode(p.currencyCode ?? 'USD');
      setTaxPercent(pctFromFraction(p.defaultTaxRate));
      setPrefix(p.invoiceNumberPrefix ?? 'INV');
      setTermsDays(String(p.invoiceTermsDays ?? 30));
      setAutoEmailInvoice(p.autoEmailInvoiceOnQuoteAccept !== false);
      // Default OFF (#6635): only an explicit true reads as on.
      setNotifyOnBehalfAcceptance(p.notifyCustomerOnBehalfAcceptance === true);
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
      const companyContact = parseCompanyContact(p.settings?.contact);
      const companyAddress = parseCompanyAddress(p.settings?.address);
      setInheritedCompanyName(p.name?.trim() || null);
      setInheritedPhone(companyContact.phone);
      setInheritedWebsite(companyContact.website);
      setInheritedAddress(isCompanyAddressBlank(companyAddress) ? null : companyAddress);
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
    if (saving || websiteInvalid || !canWrite) return;
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
            notifyCustomerOnBehalfAcceptance: notifyOnBehalfAcceptance,
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
  }, [saving, websiteInvalid, canWrite, currencyCode, taxPercent, prefix, termsDays, autoEmailInvoice, notifyOnBehalfAcceptance, deviceAppendix,
      footer, documentTheme, documentPageSize, companyName, phone, website, addr1, addr2, city, region, postal, country, terms, load, t]);

  if (loading) return <p className="text-sm text-muted-foreground">{t('partnerBillingSettings.loading')}</p>;
  // A 403 is a permission state, not a transient failure — no Retry.
  if (denied) return <AccessDenied testId="partner-billing-denied" />;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="partner-billing-load-error">
        {t('partnerBillingSettings.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </div>
    );
  }

  // Preserve the settings tab order; future slots may be reserved.
  const TABS: Array<{ id: BillingTab; labelKey: string; reserved?: true }> = [
    { id: 'defaults', labelKey: 'partnerBillingSettingsTabs.defaults' },
    { id: 'documents', labelKey: 'partnerBillingSettingsTabs.documents' },
    { id: 'rates', labelKey: 'partnerBillingSettingsTabs.rates' },
    { id: 'connections', labelKey: 'partnerBillingSettingsTabs.connections' },
  ];
  const renderedTabs = TABS.filter((tab) => !tab.reserved);
  const overflowTabs: OverflowTab[] = renderedTabs.map((tab) => ({
    id: tab.id,
    label: t(/* i18n-dynamic */ tab.labelKey),
    icon: null,
  }));

  return (
    <div className="space-y-6" data-testid="partner-billing-settings">
      <div data-testid="billing-settings-tabs">
        <OverflowTabs
          tabs={overflowTabs}
          activeTab={activeTab}
          onTabChange={(id) => { window.location.hash = id; setActiveTab(id as BillingTab); }}
          testIdPrefix="billing-settings-tab-"
        />
      </div>

      {/* Exactly one tab block renders at a time, so a single wrapper always
          matches the active tab button's aria-controls (axe: aria-valid-attr-value). */}
      <div
        role="tabpanel"
        id={overflowPanelId(activeTab, 'billing-settings-tab-')}
        aria-labelledby={overflowTabId(activeTab, 'billing-settings-tab-')}
        tabIndex={-1}
        className="space-y-6"
      >
      {!canWrite && (activeTab === 'defaults' || activeTab === 'documents') && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" data-testid="partner-billing-readonly">
          {hasWriteGrant ? t('partnerBillingSettings.readOnlyNoPartnerWideNotice') : t('partnerBillingSettings.readOnlyNotice')}
        </p>
      )}
      {activeTab === 'defaults' && (
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0 m-0">
        <BillingDefaultsTab
          currencyCode={currencyCode} setCurrencyCode={setCurrencyCode}
          taxPercent={taxPercent} setTaxPercent={setTaxPercent}
          prefix={prefix} setPrefix={setPrefix}
          termsDays={termsDays} setTermsDays={setTermsDays}
        />
        </fieldset>
      )}
      {activeTab === 'documents' && (
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0 m-0">
        <BillingDocumentsTab
          autoEmailInvoice={autoEmailInvoice} setAutoEmailInvoice={setAutoEmailInvoice}
          notifyOnBehalfAcceptance={notifyOnBehalfAcceptance} setNotifyOnBehalfAcceptance={setNotifyOnBehalfAcceptance}
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
          inheritedCompanyName={inheritedCompanyName}
          inheritedPhone={inheritedPhone} inheritedWebsite={inheritedWebsite} inheritedAddress={inheritedAddress}
        />
        </fieldset>
      )}
      {activeTab === 'rates' && <BillingRatesTab currencyCode={currencyCode} />}
      {activeTab === 'connections' && <BillingConnectionsTab />}
      </div>

      {canWrite && activeTab !== 'rates' && activeTab !== 'connections' && <div className="flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving || websiteInvalid}
          data-testid="partner-billing-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('common:states.saving') : t('partnerBillingSettings.saveButton')}
        </button>
      </div>}
    </div>
  );
}
