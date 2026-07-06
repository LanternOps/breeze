import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { pctFromFraction } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface PartnerBilling {
  currencyCode: string;
  defaultTaxRate: string | null;
  invoiceNumberPrefix: string;
  invoiceTermsDays: number;
  defaultMarkupPercent: string | null;
  autoTaxHardware: boolean;
  catalogAiStyle: string | null;
  invoiceFooter: string | null;
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
  // Partner AI copy style for Auto-fill/Polish; empty = built-in house format.
  const [aiStyle, setAiStyle] = useState('');
  const [footer, setFooter] = useState('');
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
      setAiStyle(p.catalogAiStyle ?? '');
      setFooter(p.invoiceFooter ?? '');
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

  const save = useCallback(async () => {
    if (saving) return;
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
            catalogAiStyle: aiStyle.trim() === '' ? null : aiStyle.trim(),
            invoiceFooter: footer.trim() === '' ? null : footer,
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
        errorFallback: 'Failed to save billing settings.',
        successMessage: 'Billing settings saved',
        onUnauthorized: UNAUTHORIZED,
      });
      void load();
    } catch (err) {
      handleActionError(err, 'Failed to save billing settings.');
    } finally {
      setSaving(false);
    }
  }, [saving, currencyCode, taxPercent, prefix, termsDays, markupPercent, autoTaxHardware, aiStyle, footer,
      companyName, phone, website, addr1, addr2, city, region, postal, country, terms, load]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading billing settings…</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="partner-billing-load-error">
        Billing settings failed to load.{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="partner-billing-settings">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">Billing defaults</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Currency, tax, numbering, and terms applied to new quotes and invoices across your customers.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="pb-currency">Currency code</label>
            <input
              id="pb-currency" type="text" maxLength={3} value={currencyCode}
              onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
              data-testid="partner-billing-currency"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm uppercase"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-tax">Default tax rate (%)</label>
            <input
              id="pb-tax" type="number" min={0} max={100} step="0.001" value={taxPercent}
              onChange={(e) => setTaxPercent(e.target.value)} placeholder="None"
              data-testid="partner-billing-tax"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-prefix">Invoice number prefix</label>
            <input
              id="pb-prefix" type="text" maxLength={12} value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              data-testid="partner-billing-prefix"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-terms-days">Payment terms (days)</label>
            <input
              id="pb-terms-days" type="number" min={0} max={365} step="1" value={termsDays}
              onChange={(e) => setTermsDays(e.target.value)}
              data-testid="partner-billing-terms-days"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-markup">Default markup (%)</label>
            <input
              id="pb-markup" type="number" min={0} max={9999.99} step="0.01" value={markupPercent}
              onChange={(e) => setMarkupPercent(e.target.value)} placeholder="None"
              data-testid="partner-billing-markup"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Default markup over distributor cost, used to pre-fill the sell price when importing catalog
              items. The resulting gross margin is shown as you import.
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
            <span className="text-sm font-medium">Auto-tax hardware items</span>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Newly imported hardware defaults to taxable.
          </p>
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-ai-style">AI product copy style</label>
          <textarea
            id="pb-ai-style" rows={4} value={aiStyle} maxLength={2000}
            onChange={(e) => setAiStyle(e.target.value)}
            placeholder={'Default: the item name is a short, generic customer-friendly name ("Wireless Access Point"); the description starts with the full product name, then bullet-point specs precise enough to verify an order against. Describe your own style here to override it.'}
            data-testid="partner-billing-ai-style"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Shapes how &ldquo;Auto-fill from web&rdquo; and &ldquo;Polish with AI&rdquo; write product names and
            descriptions on quotes, invoices, and catalog items. Leave blank for the default format.
          </p>
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-footer">Invoice footer</label>
          <textarea
            id="pb-footer" rows={3} value={footer}
            onChange={(e) => setFooter(e.target.value)} placeholder="Payment instructions, thank-you note, etc."
            data-testid="partner-billing-footer"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">Company contact</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Shown as the seller on quotes and invoices.
        </p>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-company">Company name</label>
          <input
            id="pb-company" type="text" value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            data-testid="partner-billing-company-name"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="pb-phone">Phone</label>
            <input
              id="pb-phone" type="text" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="partner-billing-phone"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-website">Website</label>
            <input
              id="pb-website" type="text" value={website}
              onChange={(e) => setWebsite(e.target.value)}
              data-testid="partner-billing-website"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-addr1">Address line 1</label>
          <input
            id="pb-addr1" type="text" value={addr1}
            onChange={(e) => setAddr1(e.target.value)}
            data-testid="partner-billing-addr1"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-addr2">Address line 2</label>
          <input
            id="pb-addr2" type="text" value={addr2}
            onChange={(e) => setAddr2(e.target.value)}
            data-testid="partner-billing-addr2"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className="text-sm font-medium" htmlFor="pb-city">City</label>
            <input
              id="pb-city" type="text" value={city}
              onChange={(e) => setCity(e.target.value)}
              data-testid="partner-billing-city"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-region">State / region</label>
            <input
              id="pb-region" type="text" value={region}
              onChange={(e) => setRegion(e.target.value)}
              data-testid="partner-billing-region"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pb-postal">Postal code</label>
            <input
              id="pb-postal" type="text" value={postal}
              onChange={(e) => setPostal(e.target.value)}
              data-testid="partner-billing-postal"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-4 sm:w-24">
          <label className="text-sm font-medium" htmlFor="pb-country">Country (2-letter)</label>
          <input
            id="pb-country" type="text" maxLength={2} value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            data-testid="partner-billing-country"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm uppercase"
          />
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium" htmlFor="pb-tc">Default terms &amp; conditions</label>
          <textarea
            id="pb-tc" rows={4} value={terms}
            onChange={(e) => setTerms(e.target.value)}
            placeholder="Payment terms, disclaimers, warranty language, etc."
            data-testid="partner-billing-terms"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving}
          data-testid="partner-billing-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save billing settings'}
        </button>
      </div>
    </div>
  );
}
