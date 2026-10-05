import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { autopayScheduleSummary, type AutopayCustomerPage } from '@breeze/shared';
import { apiGet, apiPost } from '@/lib/api';
import { cn } from '@/lib/utils';
import { money } from '@/lib/format';
import { linkFailureOf, methodFeeLabel, methodInSentence, savedMethodLabel, type AutopayPortalPage, type MethodType } from '@/lib/autopay';
import { BTN_BLOCK, BTN_PRIMARY, BTN_SECONDARY, Notice } from './ui';
import { AutopayShell } from './autopay/AutopayShell';
import { AuthorizationBox } from './autopay/AuthorizationBox';
import { MethodChoice, type MethodOption } from './autopay/MethodChoice';
import { SummaryList } from './autopay/SummaryList';
import { StatePanel } from './autopay/StatePanel';
import { LinkStatePanel, type LinkFailureView } from './autopay/LinkStatePanel';

type Feedback = { tone: 'warning' | 'destructive'; title: string; body?: string } | null;
const STORAGE_HELP = 'This page needs your browser to allow site data so it can finish your setup when you come back from Stripe. Open the link in a regular (not private) window, then try again.';

function methodsFor(achMode: AutopayCustomerPage['achMode']): MethodType[] {
  return achMode === 'card_only' ? ['card'] : achMode === 'ach_only' ? ['us_bank_account'] : ['us_bank_account', 'card'];
}

/**
 * Set up automatic payments (emailed link) or change the saved method (portal, or a
 * card-expiring link for an active enrollment). One column: the MSP asking, the
 * terms at a glance, the method choice with each fee, the full authorization beside
 * its checkbox, then Stripe.
 */
export default function AutopaySetupPage({ token, portal = false, onCancel }: {
  token?: string; portal?: boolean; onCancel?: () => void;
}) {
  const [data, setData] = useState<AutopayPortalPage | null>(null);
  const [failure, setFailure] = useState<LinkFailureView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [method, setMethod] = useState<MethodType>('us_bank_account');
  const [accepted, setAccepted] = useState(false);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [reload, setReload] = useState(0);
  const inFlight = useRef(false);
  const config = { redirectOnUnauthorized: portal };
  const base = portal ? '/portal/payment-methods' : `/autopay/public/${encodeURIComponent(token ?? '')}`;

  useEffect(() => {
    let cancelled = false;
    void apiGet<AutopayPortalPage>(base, { redirectOnUnauthorized: portal }).then(result => {
      if (cancelled) return;
      if (!result.data) {
        const link = linkFailureOf(result);
        if (link) setFailure(link); else setLoadError(true);
        return;
      }
      setData(result.data);
      if (result.data.stopOnly) return;
      const allowed = methodsFor(result.data.achMode);
      const current = result.data.enrollment?.status === 'active' ? result.data.method?.type : undefined;
      setMethod(current && allowed.includes(current) ? current : allowed[0]!);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [base, portal, reload]);

  // Back from Stripe through the browser cache: never leave a frozen "Opening Stripe…".
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) { inFlight.current = false; setBusy(false); } };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  const choose = useCallback((next: MethodType) => {
    setMethod(next);
    setChanged(accepted);
    setAccepted(false);
  }, [accepted]);

  async function start() {
    if (!data || data.stopOnly || !accepted || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFeedback(null);
    let status: number | undefined;
    let url: string | null = null;
    try {
      const result = await apiPost<{ url: string }>(`${base}/setup-session`,
        { methodType: method, consentAccepted: true, disclosureHash: data.disclosures[method].hash }, config);
      status = result.statusCode;
      if (result.data && typeof result.data.url === 'string' && result.data.url.startsWith('https://checkout.stripe.com/')) url = result.data.url;
    } catch { url = null; }
    if (url) {
      if (!portal && token) {
        try { sessionStorage.setItem('autopay-return-token', token); }
        catch { setFeedback({ tone: 'destructive', title: "We couldn't open Stripe's secure page.", body: STORAGE_HELP }); inFlight.current = false; setBusy(false); return; }
      }
      window.location.assign(url);
      return;
    }
    inFlight.current = false; setBusy(false);
    if (status === 409) {
      setFeedback({ tone: 'warning', title: `${data.partnerName || 'Your service provider'} updated these terms a moment ago.`,
        body: 'Please read the updated authorization and agree again.' });
      setAccepted(false); setChanged(true); setReload(value => value + 1);
      return;
    }
    setFeedback({ tone: 'destructive', title: "We couldn't open Stripe's secure page.",
      body: `Please try again. If it keeps happening, email ${data.partnerName || 'your service provider'}.` });
  }

  const wrap = (children: ReactNode, branding?: Partial<{ partnerName: string; logoUrl: string | null; supportEmail: string | null }>) =>
    portal ? <section className="space-y-6" data-testid="autopay-setup-page">{children}</section>
      : <AutopayShell partnerName={branding?.partnerName} logoUrl={branding?.logoUrl} supportEmail={branding?.supportEmail} testId="autopay-setup-page">{children}</AutopayShell>;

  if (failure) return wrap(<LinkStatePanel failure={failure} purpose="enroll" />, failure);
  if (loadError) {
    return wrap(<StatePanel title="We couldn't load this page" headingLevel={portal ? 2 : 1}
      primary={{ label: 'Refresh', onClick: () => window.location.reload() }}>
      <p>Please refresh in a moment. Nothing about your payments has changed.</p>
    </StatePanel>);
  }
  if (!data) return wrap(<p className="text-sm text-muted-foreground" aria-busy="true">Loading…</p>);
  if (data.stopOnly) {
    return wrap(<Notice tone="neutral" title="Changing your payment method isn't available right now."
      action={onCancel && <button type="button" className={BTN_SECONDARY} onClick={onCancel}>Back</button>} />);
  }

  const update = data.enrollment?.status === 'active' && !!data.method;
  const msp = data.partnerName || 'Your service provider';
  const H = portal ? 'h2' : 'h1';
  const scheduleTerms = data.disclosures.card?.scheduleTerms ?? data.disclosures.us_bank_account?.scheduleTerms;
  const cap = scheduleTerms?.cap.enabled ? ` (up to ${money(scheduleTerms.cap.amount, scheduleTerms.cap.currency)} each)` : '';
  const fees = data.fees;
  const bankCheaper = !!fees && Number(fees.us_bank_account.feeAmount) <= Number(fees.card.feeAmount);
  const options: MethodOption<MethodType>[] = methodsFor(data.achMode).map(type => type === 'us_bank_account'
    ? { value: type, name: 'Bank account', testId: 'autopay-method-us_bank_account', feeTestId: 'autopay-fee-us_bank_account',
      fee: methodFeeLabel(type, fees?.us_bank_account) ?? data.disclosures.us_bank_account.feeText,
      detail: data.achMode === 'ach_preferred' && bankCheaper ? `Recommended by ${msp}` : 'A US checking or savings account' }
    : { value: type, name: 'Card', testId: 'autopay-method-card', feeTestId: 'autopay-fee-card',
      fee: methodFeeLabel(type, fees?.card) ?? data.disclosures.card.feeText,
      detail: fees?.card.kind === 'card_percent' ? 'Debit and prepaid cards: no fee' : null });

  return wrap(<>
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Automatic payments</p>
      <H className={cn('font-display font-semibold leading-tight tracking-tight text-foreground', portal ? 'text-xl' : 'text-[1.75rem]')}>
        {update ? 'Change your payment method' : 'Pay future invoices automatically'}
      </H>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {update
          ? `Your new method replaces your ${methodInSentence(savedMethodLabel(data.method))} for future automatic payments. Your schedule stays the same.`
          : `${msp} will charge each new invoice to the payment method you choose, and email you before every payment.`}
      </p>
    </div>
    <div className={portal ? 'mt-0' : 'mt-6'}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">At a glance</h2>
      <SummaryList rows={[
        { label: 'When', value: scheduleTerms ? autopayScheduleSummary(scheduleTerms) : data.scheduleText },
        { label: 'Before', value: 'An email with the amount and date' },
        { label: 'Invoices', value: `Issued after you set this up${cap}` },
        { label: 'Your say', value: 'Skip any payment from its email, or stop at any time' },
      ]} />
    </div>
    <div className="mt-6 space-y-6">
      <MethodChoice legend="Choose how to pay" name="autopay-method" options={options} value={method} onChange={choose} disabled={busy} />
      {update && method === 'us_bank_account' && (
        <p className="text-sm text-muted-foreground">If Stripe can't connect your bank instantly, it verifies the account with small deposits (1–2 business days). Automatic payments wait until then.</p>
      )}
      <AuthorizationBox id="autopay-authorization" text={data.disclosures[method].text} checked={accepted} disabled={busy}
        onChange={value => { setAccepted(value); if (value) setChanged(false); }} changedNotice={changed}
        testIds={{ text: 'autopay-consent-text', checkbox: 'autopay-consent' }} />
      {feedback && <Notice tone={feedback.tone} title={feedback.title} data-testid="autopay-feedback">{feedback.body && <p>{feedback.body}</p>}</Notice>}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button type="button" data-testid="autopay-setup-submit" disabled={!accepted || busy} aria-describedby={!accepted ? 'autopay-submit-help' : undefined}
            className={cn(BTN_PRIMARY, BTN_BLOCK)} onClick={() => void start()}>
            <Lock className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Opening Stripe…' : 'Continue to Stripe'}
          </button>
          {portal && onCancel && <button type="button" className={cn(BTN_SECONDARY, BTN_BLOCK)} onClick={onCancel} disabled={busy}>Cancel</button>}
        </div>
        {!accepted && <p id="autopay-submit-help" className="text-sm text-muted-foreground">Tick the box above to continue.</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">You'll add your details on Stripe's secure page. {msp} only sees the last four digits.</p>
      </div>
    </div>
  </>, data);
}
