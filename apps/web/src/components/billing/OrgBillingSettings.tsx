import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { isValidEmail } from '@/lib/email';
import { pctFromFraction } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface OrgBilling {
  taxId: string | null;
  taxExempt: boolean;
  taxRate: string | null;
  billingContact: { email?: string | null; name?: string | null } | null;
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
  const { t } = useTranslation('billing');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const [taxId, setTaxId] = useState('');
  const [taxExempt, setTaxExempt] = useState(false);
  const [taxPercent, setTaxPercent] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactName, setContactName] = useState('');
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
      setContactEmail(o.billingContact?.email ?? '');
      setContactName(o.billingContact?.name ?? '');
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

  // Contact email is optional (blank clears it), but a non-empty value must be a
  // valid address. Guard client-side so the Save button reflects it pre-submit;
  // the server still validates the format on PATCH.
  const contactEmailInvalid = contactEmail.trim() !== '' && !isValidEmail(contactEmail);

  const save = useCallback(async () => {
    if (saving || contactEmailInvalid) return;
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
            // Send null (not '') when cleared — the schema validates email format
            // and treats null as "no recipient" rather than rejecting a blank.
            billingContactEmail: contactEmail.trim() === '' ? null : contactEmail.trim(),
            billingContactName: contactName.trim() === '' ? null : contactName.trim(),
            billingAddressLine1: line1.trim() === '' ? null : line1,
            billingAddressLine2: line2.trim() === '' ? null : line2,
            billingAddressCity: city.trim() === '' ? null : city,
            billingAddressRegion: region.trim() === '' ? null : region,
            billingAddressPostalCode: postal.trim() === '' ? null : postal,
            billingAddressCountry: country.trim() === '' ? null : country.trim().toUpperCase(),
          }),
        }),
        errorFallback: t('orgBillingSettings.saveError'),
        successMessage: t('orgBillingSettings.saveSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      void load();
    } catch (err) {
      handleActionError(err, t('orgBillingSettings.saveError'));
    } finally {
      setSaving(false);
    }
  }, [saving, contactEmailInvalid, taxId, taxExempt, taxPercent, contactEmail, contactName, line1, line2, city, region, postal, country, orgId, load]);

  if (loading) return <p className="text-sm text-muted-foreground">{t('orgBillingSettings.loading')}</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-billing-load-error">
        {t('orgBillingSettings.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </div>
    );
  }

  const inputCls = 'mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm';

  return (
    <div className="space-y-6" data-testid="org-billing-settings">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgBillingSettings.tax.title')}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="ob-taxid">{t('orgBillingSettings.tax.taxId')}</label>
            <input id="ob-taxid" type="text" maxLength={100} value={taxId} onChange={(e) => setTaxId(e.target.value)} data-testid="org-billing-taxid" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-taxrate">{t('orgBillingSettings.tax.taxRate')}</label>
            <input
              id="ob-taxrate" type="number" min={0} max={100} step="0.001" value={taxPercent}
              onChange={(e) => setTaxPercent(e.target.value)} placeholder={t('orgBillingSettings.tax.partnerDefault')}
              disabled={taxExempt}
              data-testid="org-billing-taxrate"
              className={`${inputCls} disabled:opacity-50`}
            />
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={taxExempt} onChange={(e) => setTaxExempt(e.target.checked)} data-testid="org-billing-exempt" />
          {t('orgBillingSettings.tax.taxExempt')}
        </label>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgBillingSettings.contact.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('orgBillingSettings.contact.description')}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="ob-contact-email">{t('orgBillingSettings.contact.email')}</label>
            <input id="ob-contact-email" type="email" maxLength={255} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder={t('orgBillingSettings.contact.emailPlaceholder')} data-testid="org-billing-contact-email" aria-invalid={contactEmailInvalid} className={`${inputCls} ${contactEmailInvalid ? 'border-destructive' : ''}`} />
            {contactEmailInvalid && (
              <p className="mt-1 text-xs text-destructive" data-testid="org-billing-contact-email-error">
                {t('orgBillingSettings.contact.emailInvalid')}
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-contact-name">{t('orgBillingSettings.contact.name')}</label>
            <input id="ob-contact-name" type="text" maxLength={255} value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder={t('common:labels.optional')} data-testid="org-billing-contact-name" className={inputCls} />
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgBillingSettings.address.title')}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="ob-line1">{t('orgBillingSettings.address.line1')}</label>
            <input id="ob-line1" type="text" maxLength={255} value={line1} onChange={(e) => setLine1(e.target.value)} data-testid="org-billing-line1" className={inputCls} />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="ob-line2">{t('orgBillingSettings.address.line2')}</label>
            <input id="ob-line2" type="text" maxLength={255} value={line2} onChange={(e) => setLine2(e.target.value)} data-testid="org-billing-line2" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-city">{t('orgBillingSettings.address.city')}</label>
            <input id="ob-city" type="text" maxLength={120} value={city} onChange={(e) => setCity(e.target.value)} data-testid="org-billing-city" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-region">{t('orgBillingSettings.address.region')}</label>
            <input id="ob-region" type="text" maxLength={120} value={region} onChange={(e) => setRegion(e.target.value)} data-testid="org-billing-region" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-postal">{t('orgBillingSettings.address.postal')}</label>
            <input id="ob-postal" type="text" maxLength={40} value={postal} onChange={(e) => setPostal(e.target.value)} data-testid="org-billing-postal" className={inputCls} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ob-country">{t('orgBillingSettings.address.country')}</label>
            <input id="ob-country" type="text" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} data-testid="org-billing-country" className={`${inputCls} uppercase`} />
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving || contactEmailInvalid}
          data-testid="org-billing-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('common:states.saving') : t('orgBillingSettings.saveButton')}
        </button>
      </div>
    </div>
  );
}
