import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction, handleActionError } from '../../lib/runAction';
import { isValidEmail } from '@/lib/email';
import { currencyLabel, currencyOptions } from '@/lib/currencies';
import { pctFromFraction } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

/** Mirror of the API's `OrgCurrencyImpact` (apps/api/src/services/orgCurrencyService.ts).
 *  Every group is keyed on the ROW's own stamped currency — amounts are never
 *  summed across currencies, and nothing here is ever converted. */
interface OrgCurrencyImpactGroup {
  currencyCode: string;
  documents: { draftInvoices: number; draftQuotes: number; sentQuotes: number; viewedQuotes: number };
  contracts: { draft: number; active: number; paused: number };
  billables: {
    monetaryTimeSnapshots: number; readyTimeEntries: number; runningTimeEntries: number;
    currentlyNonBillableTimeEntries: number; missingRateTimeEntries: number; laborAmount: string | null;
    monetaryPartSnapshots: number; readyParts: number; currentlyNonBillableParts: number; partAmount: string;
  };
  recovery: { kind: 'assemble_draft'; currencyCode: string };
}

interface OrgCurrencyImpact {
  orgId: string;
  currentCurrencyCode: string;
  targetCurrencyCode: string;
  changeRequired: boolean;
  impactsByCurrency: OrgCurrencyImpactGroup[];
  configurationWarnings: {
    orgDefaultRate: { configured: boolean; rateCurrency: string | null; willStopApplying: boolean };
    categoryRatesSkipped: number;
    orgCatalogOverridesSkipped: number;
    /** Unbilled time with hours but no hourly rate, stamped in the TARGET
     *  currency or unstamped — NOT stranded by the change, so it is reported on
     *  its own line and never as a "assemble a draft in X" group (#3778). */
    rateLessTimeEntries: number;
  };
}

/** Body of a 409 ORG_CURRENCY_CHANGED — the optimistic precondition lost a race
 *  with another writer, and the server hands back the CURRENT code plus a fresh
 *  summary so the user re-confirms against reality instead of blind-retrying. */
function staleCurrencyDetails(err: unknown): { currentCurrencyCode: string; impact: OrgCurrencyImpact } | null {
  if (!(err instanceof ActionError) || err.status !== 409 || err.code !== 'ORG_CURRENCY_CHANGED') return null;
  const details = (err.body as { details?: unknown } | undefined)?.details as
    { currentCurrencyCode?: unknown; impact?: unknown } | undefined;
  if (!details || typeof details.currentCurrencyCode !== 'string' || !details.impact) return null;
  return { currentCurrencyCode: details.currentCurrencyCode, impact: details.impact as OrgCurrencyImpact };
}

interface OrgBilling {
  currencyCode: string | null;
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
  const { t, i18n } = useTranslation('billing');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  // Multi-currency wave 6 (#3778). `currencyCode` is the STORED value (the
  // optimistic precondition sent back to the server); `selectedCurrency` is what
  // the <select> shows. They diverge only while the confirmation panel is open —
  // selecting a code previews, it never mutates.
  const [currencyCode, setCurrencyCode] = useState('');
  const [selectedCurrency, setSelectedCurrency] = useState('');
  const [impact, setImpact] = useState<OrgCurrencyImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactError, setImpactError] = useState(false);
  const [currencyPanelOpen, setCurrencyPanelOpen] = useState(false);
  const [currencyStale, setCurrencyStale] = useState(false);
  const [changingCurrency, setChangingCurrency] = useState(false);

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
      setCurrencyCode(o.currencyCode ?? '');
      setSelectedCurrency(o.currencyCode ?? '');
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

  const closeCurrencyPanel = useCallback(() => {
    setCurrencyPanelOpen(false);
    setImpact(null);
    setImpactError(false);
    setCurrencyStale(false);
  }, []);

  /** Advisory, read-only preview. Never a blocker and never a promise — rows can
   *  be created between this preview and the change (the server-side org SHARE
   *  barrier, not this count, is what makes the cutover exact). */
  const previewCurrency = useCallback(async (code: string) => {
    setCurrencyPanelOpen(true);
    setCurrencyStale(false);
    setImpact(null);
    setImpactError(false);
    setImpactLoading(true);
    try {
      const res = await fetchWithAuth(
        `/orgs/${orgId}/billing-settings/currency-impact?currencyCode=${encodeURIComponent(code)}`,
        // The org is already in the PATH, and the query schema is `.strict()` —
        // letting fetchWithAuth append the org-switcher's `orgId` (which need
        // not even be this org) 400s the request and the panel degrades to
        // "summary could not be loaded". Caught by the wave-6 browser slice
        // (e2e-tests/tests/multi-currency.spec.ts); unit tests mock
        // fetchWithAuth and cannot see the injection.
        { skipOrgIdInjection: true });
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('impact failed');
      const body = (await res.json()) as { data: OrgCurrencyImpact };
      setImpact(body.data);
    } catch {
      setImpactError(true);
    } finally {
      setImpactLoading(false);
    }
  }, [orgId]);

  /** Cancel reverts the <select> to the STORED code — an abandoned preview must
   *  not leave the form showing a currency the organization does not have. */
  const cancelCurrencyChange = useCallback(() => {
    setSelectedCurrency(currencyCode);
    closeCurrencyPanel();
  }, [currencyCode, closeCurrencyPanel]);

  const onSelectCurrency = useCallback((code: string) => {
    setSelectedCurrency(code);
    if (code === currencyCode) { closeCurrencyPanel(); return; }
    void previewCurrency(code);
  }, [currencyCode, closeCurrencyPanel, previewCurrency]);

  /** The ONLY mutation on this panel. Payload is currency-ONLY: the service
   *  rejects any other field alongside `currencyCode` (wave-6 plan, Task 11). */
  const confirmCurrencyChange = useCallback(async () => {
    if (changingCurrency || !selectedCurrency || selectedCurrency === currencyCode) return;
    setChangingCurrency(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/orgs/${orgId}/billing-settings`, {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: selectedCurrency,
            expectedCurrentCurrencyCode: currencyCode,
            confirmSnapshotRetention: true,
          }),
        }),
        errorFallback: t('orgBillingSettings.currency.changeError'),
        successMessage: t('orgBillingSettings.currency.changeSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      closeCurrencyPanel();
      void load();
    } catch (err) {
      const stale = staleCurrencyDetails(err);
      if (stale) {
        // Keep the panel OPEN against the server's fresh summary and re-arm the
        // precondition with the code the server says is current — confirming
        // again is a deliberate second decision, not a silent retry.
        setCurrencyCode(stale.currentCurrencyCode);
        setImpact(stale.impact);
        setImpactError(false);
        setCurrencyStale(true);
        return;
      }
      handleActionError(err, t('orgBillingSettings.currency.changeError'));
    } finally {
      setChangingCurrency(false);
    }
  }, [changingCurrency, selectedCurrency, currencyCode, orgId, t, closeCurrencyPanel, load]);

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

  const countRow = (code: string, key: string, label: string, value: number) => (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums" data-testid={`org-billing-impact-${code}-${key}`}>{value}</span>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="org-billing-settings">
      {/* Multi-currency wave 6 (#3778). Selecting a code previews; only the
          confirmation panel below mutates, with a currency-ONLY payload. */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgBillingSettings.currency.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('orgBillingSettings.currency.description')}</p>
        <div className="mt-4 sm:max-w-xs">
          <label className="text-sm font-medium" htmlFor="ob-currency">{t('orgBillingSettings.currency.label')}</label>
          {/* An already-stored off-list code stays selectable via currencyOptions
              so an existing setting is never silently reset (#3204 precedent). */}
          <select
            id="ob-currency" value={selectedCurrency}
            onChange={(e) => onSelectCurrency(e.target.value)}
            data-testid="org-billing-currency"
            className={inputCls}
          >
            {currencyOptions(currencyCode).map((code) => (
              <option key={code} value={code}>{currencyLabel(code, i18n.language)}</option>
            ))}
          </select>
        </div>

        {currencyPanelOpen && (
          <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-4" data-testid="org-billing-currency-panel">
            <h3 className="text-sm font-semibold">
              {t('orgBillingSettings.currency.panelTitle', { currency: selectedCurrency })}
            </h3>

            {currencyStale && (
              <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400" data-testid="org-billing-currency-stale">
                {t('orgBillingSettings.currency.stale', { currency: currencyCode })}
              </p>
            )}

            {impactLoading && (
              <p className="mt-2 text-sm text-muted-foreground" data-testid="org-billing-currency-loading">
                {t('orgBillingSettings.currency.loading', { currency: selectedCurrency })}
              </p>
            )}
            {impactError && (
              <p className="mt-2 text-sm text-destructive" data-testid="org-billing-currency-error">
                {t('orgBillingSettings.currency.error')}
              </p>
            )}

            {impact && (
              <div className="mt-3 space-y-4">
                {impact.impactsByCurrency.length === 0 && (
                  <p className="text-sm text-muted-foreground" data-testid="org-billing-currency-none">
                    {t('orgBillingSettings.currency.none')}
                  </p>
                )}
                {impact.impactsByCurrency.map((g) => (
                  <div key={g.currencyCode} className="rounded-md border bg-background p-3" data-testid={`org-billing-currency-group-${g.currencyCode}`}>
                    <h4 className="text-sm font-semibold">
                      {t('orgBillingSettings.currency.groupTitle', { currency: g.currencyCode })}
                    </h4>
                    <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      {countRow(g.currencyCode, 'draftInvoices', t('orgBillingSettings.currency.counts.draftInvoices'), g.documents.draftInvoices)}
                      {countRow(g.currencyCode, 'draftQuotes', t('orgBillingSettings.currency.counts.draftQuotes'), g.documents.draftQuotes)}
                      {countRow(g.currencyCode, 'sentQuotes', t('orgBillingSettings.currency.counts.sentQuotes'), g.documents.sentQuotes)}
                      {countRow(g.currencyCode, 'viewedQuotes', t('orgBillingSettings.currency.counts.viewedQuotes'), g.documents.viewedQuotes)}
                      {countRow(g.currencyCode, 'draftContracts', t('orgBillingSettings.currency.counts.draftContracts'), g.contracts.draft)}
                      {countRow(g.currencyCode, 'activeContracts', t('orgBillingSettings.currency.counts.activeContracts'), g.contracts.active)}
                      {countRow(g.currencyCode, 'pausedContracts', t('orgBillingSettings.currency.counts.pausedContracts'), g.contracts.paused)}
                      {countRow(g.currencyCode, 'timeEntries', t('orgBillingSettings.currency.counts.timeEntries'), g.billables.monetaryTimeSnapshots)}
                      {countRow(g.currencyCode, 'parts', t('orgBillingSettings.currency.counts.parts'), g.billables.monetaryPartSnapshots)}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('orgBillingSettings.currency.timeDetail', {
                        ready: g.billables.readyTimeEntries, running: g.billables.runningTimeEntries,
                        nonBillable: g.billables.currentlyNonBillableTimeEntries, missingRate: g.billables.missingRateTimeEntries,
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('orgBillingSettings.currency.partsDetail', {
                        ready: g.billables.readyParts, nonBillable: g.billables.currentlyNonBillableParts,
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('orgBillingSettings.currency.amounts', {
                        labor: `${g.billables.laborAmount ?? '0.00'} ${g.currencyCode}`,
                        parts: `${g.billables.partAmount} ${g.currencyCode}`,
                      })}
                    </p>
                    {/* The spec §7 recovery path: an explicit same-currency
                        assembly, never a conversion or a restamp. */}
                    <p className="mt-2 text-sm" data-testid={`org-billing-currency-recovery-${g.currencyCode}`}>
                      {t('orgBillingSettings.currency.recovery', { currency: g.currencyCode })}
                    </p>
                  </div>
                ))}

                {impact.configurationWarnings.rateLessTimeEntries > 0 && (
                  <p className="text-sm text-muted-foreground" data-testid="org-billing-currency-rate-less">
                    {t('orgBillingSettings.currency.rateLess', { count: impact.configurationWarnings.rateLessTimeEntries })}
                  </p>
                )}

                <div>
                  <h4 className="text-sm font-semibold">{t('orgBillingSettings.currency.warningsTitle')}</h4>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {impact.configurationWarnings.orgDefaultRate.willStopApplying && (
                      <li data-testid="org-billing-currency-warning-rate">
                        {t('orgBillingSettings.currency.warningRate', {
                          currency: impact.configurationWarnings.orgDefaultRate.rateCurrency ?? '',
                        })}
                      </li>
                    )}
                    {impact.configurationWarnings.categoryRatesSkipped > 0 && (
                      <li data-testid="org-billing-currency-warning-categories">
                        {t('orgBillingSettings.currency.warningCategories', { count: impact.configurationWarnings.categoryRatesSkipped })}
                      </li>
                    )}
                    {impact.configurationWarnings.orgCatalogOverridesSkipped > 0 && (
                      <li data-testid="org-billing-currency-warning-overrides">
                        {t('orgBillingSettings.currency.warningOverrides', { count: impact.configurationWarnings.orgCatalogOverridesSkipped })}
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            <p className="mt-3 text-sm" data-testid="org-billing-currency-retention">
              {t('orgBillingSettings.currency.retention')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="org-billing-currency-advisory">
              {t('orgBillingSettings.currency.advisory')}
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button" onClick={cancelCurrencyChange} data-testid="org-billing-currency-cancel"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                {t('orgBillingSettings.currency.cancel')}
              </button>
              <button
                type="button" onClick={() => void confirmCurrencyChange()} disabled={changingCurrency}
                data-testid="org-billing-currency-confirm"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {changingCurrency ? t('orgBillingSettings.currency.changing') : t('orgBillingSettings.currency.confirm')}
              </button>
            </div>
          </div>
        )}
      </section>

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
