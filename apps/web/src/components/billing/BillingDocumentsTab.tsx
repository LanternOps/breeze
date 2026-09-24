import { useTranslation } from 'react-i18next';
import { httpUrlErrorMessage } from '@breeze/shared';
import InheritedField from '../shared/InheritedField';

interface InheritedAddress {
  line1: string | null; line2: string | null; city: string | null;
  region: string | null; postalCode: string | null; country: string | null;
}

interface BillingDocumentsTabProps {
  autoEmailInvoice: boolean;
  setAutoEmailInvoice: (v: boolean) => void;
  notifyOnBehalfAcceptance: boolean;
  setNotifyOnBehalfAcceptance: (v: boolean) => void;
  deviceAppendix: boolean;
  setDeviceAppendix: (v: boolean) => void;
  footer: string;
  setFooter: (v: string) => void;
  documentTheme: 'classic' | 'condensed';
  setDocumentTheme: (v: 'classic' | 'condensed') => void;
  documentPageSize: 'letter' | 'a4';
  setDocumentPageSize: (v: 'letter' | 'a4') => void;
  companyName: string;
  setCompanyName: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  website: string;
  setWebsite: (v: string) => void;
  websiteInvalid: boolean;
  addr1: string;
  setAddr1: (v: string) => void;
  addr2: string;
  setAddr2: (v: string) => void;
  city: string;
  setCity: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  postal: string;
  setPostal: (v: string) => void;
  country: string;
  setCountry: (v: string) => void;
  terms: string;
  setTerms: (v: string) => void;
  /** Resolved "company details" values (partners.name / settings.contact / settings.address)
   *  — shown as the InheritedField placeholder/source when the corresponding letterhead
   *  override is blank (#6228). Undefined/null when no company-details value is set either. */
  inheritedPhone?: string | null;
  inheritedWebsite?: string | null;
  inheritedAddress?: InheritedAddress | null;
}

/**
 * Auto-email / device appendix / document theme+size / footer / Company card
 * — the second tab of the Billing settings page (M4). AI style copy pointer
 * moved to CatalogDefaultsCard.
 */
export default function BillingDocumentsTab({
  autoEmailInvoice, setAutoEmailInvoice, notifyOnBehalfAcceptance, setNotifyOnBehalfAcceptance, deviceAppendix, setDeviceAppendix, footer, setFooter,
  documentTheme, setDocumentTheme, documentPageSize, setDocumentPageSize,
  companyName, setCompanyName, phone, setPhone, website, setWebsite, websiteInvalid,
  addr1, setAddr1, addr2, setAddr2, city, setCity, region, setRegion, postal, setPostal,
  country, setCountry, terms, setTerms,
  inheritedPhone = null, inheritedWebsite = null, inheritedAddress = null,
}: BillingDocumentsTabProps) {
  const { t } = useTranslation('billing');
  const inheritedSource = t('partnerBillingSettings.company.inheritedFromCompanyDetails');
  const addressOverridden = [addr1, addr2, city, region, postal, country].some((f) => f.trim() !== '');
  const useCompanyAddress = () => {
    setAddr1(''); setAddr2(''); setCity(''); setRegion(''); setPostal(''); setCountry('');
  };
  return (
    <>
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div>
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
              id="pb-notify-on-behalf-acceptance"
              type="checkbox"
              checked={notifyOnBehalfAcceptance}
              onChange={(e) => setNotifyOnBehalfAcceptance(e.target.checked)}
              data-testid="partner-billing-notify-on-behalf-acceptance"
              className="h-4 w-4 rounded border"
            />
            <span className="text-sm font-medium">{t('partnerBillingSettings.defaults.notifyOnBehalfAcceptance')}</span>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('partnerBillingSettings.defaults.notifyOnBehalfAcceptanceHelp')}
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
          <InheritedField
            id="pb-phone"
            label={t('partnerBillingSettings.company.phone')}
            value={phone}
            onChange={setPhone}
            inheritedValue={inheritedPhone}
            inheritedSource={inheritedSource}
            data-testid="partner-billing-phone"
          />
          <div>
            <InheritedField
              id="pb-website"
              label={t('partnerBillingSettings.company.website')}
              value={website}
              onChange={setWebsite}
              inheritedValue={inheritedWebsite}
              inheritedSource={inheritedSource}
              data-testid="partner-billing-website"
              ariaInvalid={websiteInvalid}
              ariaDescribedBy={websiteInvalid ? 'pb-website-error' : undefined}
            />
            {websiteInvalid && (
              <p id="pb-website-error" data-testid="partner-billing-website-error" className="mt-1 text-sm text-destructive">
                {httpUrlErrorMessage(t('partnerBillingSettings.company.website'))}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{t('partnerBillingSettings.company.addressTitle')}</p>
          {addressOverridden ? (
            <button
              type="button"
              onClick={useCompanyAddress}
              data-testid="partner-billing-use-company-address"
              className="text-xs font-medium text-primary underline hover:no-underline"
            >
              {t('partnerBillingSettings.company.useCompanyAddress')}
            </button>
          ) : inheritedAddress ? (
            <p className="text-xs text-muted-foreground" data-testid="partner-billing-address-inherited-note">
              {t('partnerBillingSettings.company.addressInherited')}
            </p>
          ) : null}
        </div>
        <div className="mt-2">
          <label className="text-sm font-medium" htmlFor="pb-addr1">{t('partnerBillingSettings.company.addressLine1')}</label>
          <input
            id="pb-addr1" type="text" value={addr1}
            placeholder={inheritedAddress?.line1 ?? undefined}
            onChange={(e) => setAddr1(e.target.value)}
            data-testid="partner-billing-addr1"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-addr2">{t('partnerBillingSettings.company.addressLine2')}</label>
          <input
            id="pb-addr2" type="text" value={addr2}
            placeholder={inheritedAddress?.line2 ?? undefined}
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
              placeholder={inheritedAddress?.city ?? undefined}
              onChange={(e) => setCity(e.target.value)}
              data-testid="partner-billing-city"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-region">{t('partnerBillingSettings.company.region')}</label>
            <input
              id="pb-region" type="text" value={region}
              placeholder={inheritedAddress?.region ?? undefined}
              onChange={(e) => setRegion(e.target.value)}
              data-testid="partner-billing-region"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-postal">{t('partnerBillingSettings.company.postal')}</label>
            <input
              id="pb-postal" type="text" value={postal}
              placeholder={inheritedAddress?.postalCode ?? undefined}
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
            placeholder={inheritedAddress?.country ?? undefined}
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
    </>
  );
}
