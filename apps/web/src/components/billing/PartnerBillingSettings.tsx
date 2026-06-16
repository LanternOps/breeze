import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { pctFromFraction } from './invoiceTypes';
import StripeConnectCard from './StripeConnectCard';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface PartnerBilling {
  currencyCode: string;
  defaultTaxRate: string | null;
  invoiceNumberPrefix: string;
  invoiceTermsDays: number;
  invoiceFooter: string | null;
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
  const [footer, setFooter] = useState('');

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
      setFooter(p.invoiceFooter ?? '');
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
      await runAction({
        request: () => fetchWithAuth('/partner/billing-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: currencyCode.trim().toUpperCase(),
            defaultTaxRate,
            invoiceNumberPrefix: prefix.trim(),
            invoiceTermsDays: Number(termsDays),
            invoiceFooter: footer.trim() === '' ? null : footer,
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
  }, [saving, currencyCode, taxPercent, prefix, termsDays, footer, load]);

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
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Invoice defaults</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Currency, tax, numbering, and terms applied to new invoices across your customers.
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
              id="pb-tax" type="number" min={0} max={100} step="0.1" value={taxPercent}
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
            <label className="text-sm font-medium" htmlFor="pb-terms">Payment terms (days)</label>
            <input
              id="pb-terms" type="number" min={0} max={365} step="1" value={termsDays}
              onChange={(e) => setTermsDays(e.target.value)}
              data-testid="partner-billing-terms"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
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

      <StripeConnectCard />

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
