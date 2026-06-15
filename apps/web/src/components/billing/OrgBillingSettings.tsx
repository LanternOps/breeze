import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { pctFromFraction } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface OrgBilling {
  taxId: string | null;
  taxExempt: boolean;
  taxRate: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingAddressCity: string | null;
  billingAddressRegion: string | null;
  billingAddressPostalCode: string | null;
  billingAddressCountry: string | null;
}

interface Props {
  orgId: string;
}

export default function OrgBillingSettings({ orgId }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const [taxId, setTaxId] = useState('');
  const [taxExempt, setTaxExempt] = useState(false);
  const [taxPercent, setTaxPercent] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');
  const [country, setCountry] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/orgs/organizations/${orgId}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('load failed');
      const o = (await res.json()) as OrgBilling;
      setTaxId(o.taxId ?? '');
      setTaxExempt(Boolean(o.taxExempt));
      setTaxPercent(pctFromFraction(o.taxRate));
      setLine1(o.billingAddressLine1 ?? '');
      setLine2(o.billingAddressLine2 ?? '');
      setCity(o.billingAddressCity ?? '');
      setRegion(o.billingAddressRegion ?? '');
      setPostal(o.billingAddressPostalCode ?? '');
      setCountry(o.billingAddressCountry ?? '');
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const pct = taxPercent.trim();
      await runAction({
        request: () => fetchWithAuth(`/orgs/${orgId}/billing-settings`, {
          method: 'PATCH',
          body: JSON.stringify({
            taxId: taxId.trim() === '' ? null : taxId.trim(),
            taxExempt,
            taxRate: pct === '' ? null : Number(pct) / 100,
            billingAddressLine1: line1.trim() === '' ? null : line1,
            billingAddressLine2: line2.trim() === '' ? null : line2,
            billingAddressCity: city.trim() === '' ? null : city,
            billingAddressRegion: region.trim() === '' ? null : region,
            billingAddressPostalCode: postal.trim() === '' ? null : postal,
            billingAddressCountry: country.trim() === '' ? null : country.trim().toUpperCase(),
          }),
        }),
        errorFallback: 'Failed to save organization billing settings.',
        successMessage: 'Organization billing settings saved',
        onUnauthorized: UNAUTHORIZED,
      });
      void load();
    } catch (err) {
      handleActionError(err, 'Failed to save organization billing settings.');
    } finally {
      setSaving(false);
    }
  }, [saving, taxId, taxExempt, taxPercent, line1, line2, city, region, postal, country, orgId, load]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading billing settings…</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-billing-load-error">
        Billing settings failed to load.{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">Retry</button>
      </div>
    );
  }

  const inputCls = 'mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm';

  return (
    <div className="space-y-6" data-testid="org-billing-settings">
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Tax</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="ob-taxid">Tax ID</label>
            <input id="ob-taxid" type="text" maxLength={100} value={taxId} onChange={(e) => setTaxId(e.target.value)} data-testid="org-billing-taxid" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-taxrate">Tax rate (%)</label>
            <input
              id="ob-taxrate" type="number" min={0} max={100} step="0.1" value={taxPercent}
              onChange={(e) => setTaxPercent(e.target.value)} placeholder="Partner default"
              disabled={taxExempt}
              data-testid="org-billing-taxrate"
              className={`${inputCls} disabled:opacity-50`}
            />
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={taxExempt} onChange={(e) => setTaxExempt(e.target.checked)} data-testid="org-billing-exempt" />
          Tax exempt
        </label>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Billing address</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="ob-line1">Address line 1</label>
            <input id="ob-line1" type="text" maxLength={255} value={line1} onChange={(e) => setLine1(e.target.value)} data-testid="org-billing-line1" className={inputCls} />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="ob-line2">Address line 2</label>
            <input id="ob-line2" type="text" maxLength={255} value={line2} onChange={(e) => setLine2(e.target.value)} data-testid="org-billing-line2" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-city">City</label>
            <input id="ob-city" type="text" maxLength={120} value={city} onChange={(e) => setCity(e.target.value)} data-testid="org-billing-city" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-region">Region / state</label>
            <input id="ob-region" type="text" maxLength={120} value={region} onChange={(e) => setRegion(e.target.value)} data-testid="org-billing-region" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-postal">Postal code</label>
            <input id="ob-postal" type="text" maxLength={40} value={postal} onChange={(e) => setPostal(e.target.value)} data-testid="org-billing-postal" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-country">Country (2-letter)</label>
            <input id="ob-country" type="text" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} data-testid="org-billing-country" className={`${inputCls} uppercase`} />
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving}
          data-testid="org-billing-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save billing settings'}
        </button>
      </div>
    </div>
  );
}
