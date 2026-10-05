import { paymentMethodInSentence } from '@breeze/shared';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AutopayBranding, AutopaySetupResult } from '@breeze/shared';
import { apiPost } from '@/lib/api';
import { withBase } from '@/lib/basePath';
import { AutopayShell } from './autopay/AutopayShell';
import { StatePanel, type PanelAction } from './autopay/StatePanel';

type Phase =
  | { kind: 'confirming' }
  | { kind: 'outcome'; result: AutopaySetupResult }
  | { kind: 'slow' }
  | { kind: 'cancelled'; token: string | null }
  | { kind: 'no_token' }
  | { kind: 'storage' }
  | { kind: 'error' };

const TOKEN_KEY = 'autopay-return-token';
/** Who sent the setup link, stored by the setup page so this page is branded before the outcome arrives (V-19). */
export const BRANDING_KEY = 'autopay-return-branding';
function storedBranding(): AutopayBranding | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(BRANDING_KEY) ?? 'null') as Partial<AutopayBranding> | null;
    return value && typeof value.partnerName === 'string'
      ? { partnerName: value.partnerName, logoUrl: typeof value.logoUrl === 'string' ? value.logoUrl : null,
        supportEmail: typeof value.supportEmail === 'string' ? value.supportEmail : null } : null;
  } catch { return null; }
}
const outcomeKey = (session: string) => `autopay-return-outcome:${session}`;
const STORAGE_HELP = 'This page needs your browser to allow site data so it can finish your setup. Open the setup link in a regular (not private) window, then try again.';
// Per page load: StrictMode and re-renders must never confirm the same session twice.
const started = new Set<string>();
export function resetReturnGuardForTests() { started.clear(); }

function readStorage(key: string): string | null { return sessionStorage.getItem(key); }
const portalTarget = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('target') === 'portal';

/**
 * Where Stripe sends the client after saving a method. Confirms by itself once
 * (no unexplained "Confirm setup" click), remembers the outcome so a reload shows
 * it again, keeps checking while Stripe is still confirming, and never ends on
 * "incomplete": without a stored link it tells the client what will happen next.
 */
export default function AutopayReturnPage({ retryDelaysMs = [3000, 6000, 12000, 24000] }: { retryDelaysMs?: number[] }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'confirming' });
  const [branding, setBranding] = useState<AutopayBranding | null>(() => (portalTarget() ? null : storedBranding()));
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const session = params.get('session_id');
  const portal = params.get('target') === 'portal';
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const confirm = useCallback(async (attempt: number) => {
    if (!session) { setPhase({ kind: 'no_token' }); return; }
    let returnToken: string | null = null;
    if (!portal) {
      try {
        const saved = readStorage(outcomeKey(session));
        returnToken = readStorage(TOKEN_KEY);
        if (saved) {
          const result = JSON.parse(saved) as AutopaySetupResult;
          setBranding(result.branding ?? null); setToken(returnToken); setPhase({ kind: 'outcome', result }); return;
        }
      } catch { setPhase({ kind: 'storage' }); return; }
      if (!returnToken) { setPhase({ kind: 'no_token' }); return; }
      setToken(returnToken);
    }
    setPhase(current => current.kind === 'slow' ? current : { kind: 'confirming' });
    const response = await apiPost<AutopaySetupResult>(portal ? '/portal/payment-methods/setup-return' : '/autopay/public/setup-return',
      { checkoutSessionId: session, ...(!portal ? { token: returnToken } : {}) }, { redirectOnUnauthorized: portal }).catch(() => null);
    const result = response?.data;
    if (!result?.outcome) { setPhase(response?.statusCode === 401 ? { kind: 'no_token' } : { kind: 'error' }); return; }
    if (result.branding) setBranding(result.branding);
    if (result.outcome === 'in_progress') {
      if (attempt < retryDelaysMs.length) {
        setPhase(current => current.kind === 'slow' ? current : { kind: 'confirming' });
        timer.current = setTimeout(() => { void confirm(attempt + 1); }, retryDelaysMs[attempt]);
      } else setPhase({ kind: 'slow' });
      return;
    }
    if (!portal) {
      try { sessionStorage.setItem(outcomeKey(session), JSON.stringify(result)); } catch { /* reload will re-confirm */ }
    }
    setPhase({ kind: 'outcome', result });
  }, [portal, retryDelaysMs, session]);

  useEffect(() => {
    if (params.get('cancelled') === '1') {
      let stored: string | null = null;
      try { stored = readStorage(TOKEN_KEY); } catch { stored = null; }
      setPhase({ kind: 'cancelled', token: stored });
      return;
    }
    const key = session ?? 'none';
    if (started.has(key)) return;
    started.add(key);
    void confirm(0);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restartHref = portal ? withBase('/payment-methods') : token ? withBase(`/autopay/${encodeURIComponent(token)}`) : null;
  const restart = (label: string): PanelAction | null => restartHref ? { label, href: restartHref, testId: 'autopay-restart' } : null;
  const back: PanelAction | null = portal ? { label: 'Back to payment methods', href: withBase('/payment-methods'), variant: 'secondary' } : null;
  const msp = branding?.partnerName || 'your service provider';
  const contact: PanelAction | null = branding?.supportEmail
    ? { label: `Email ${branding.partnerName || 'your service provider'}`, href: `mailto:${branding.supportEmail}` } : null;
  const noLinkHint = <p>Open the setup link in your email to start again.</p>;

  let panel: ReactElement;
  switch (phase.kind) {
    case 'confirming':
      panel = <StatePanel title="Finishing your setup…"><p>This takes a few seconds. Please keep this page open.</p></StatePanel>;
      break;
    case 'slow':
      // V-18: a click that seems to change nothing looks broken; say it's checking, then when.
      panel = <StatePanel mark={{ tone: 'neutral', label: 'Still confirming' }} title="This is taking longer than usual"
        primary={{ label: checking ? 'Checking…' : 'Check again', disabled: checking, variant: 'secondary',
          onClick: () => { setChecking(true); void confirm(retryDelaysMs.length).finally(() => { setChecking(false); setLastChecked(new Date()); }); } }}>
        <p>You can close this page. We'll email you as soon as your setup is confirmed.</p>
        {lastChecked && <p className="text-muted-foreground" data-testid="autopay-return-last-checked">
          {`Last checked at ${lastChecked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}</p>}
      </StatePanel>;
      break;
    case 'cancelled':
      panel = <StatePanel mark={{ tone: 'neutral', label: 'Not set up' }} title="Setup wasn't finished"
        primary={phase.token ? { label: 'Return to setup', href: withBase(`/autopay/${encodeURIComponent(phase.token)}`) } : back}>
        <p>You left Stripe's page before saving a payment method. Nothing was saved or charged.</p>
        {!phase.token && !portal && noLinkHint}
      </StatePanel>;
      break;
    case 'no_token':
      panel = <StatePanel title="Check your email" primary={back}>
        <p>We couldn't confirm your setup from this page. If you finished on Stripe's page, you'll get a confirmation email shortly. If none arrives, open the setup link in your email again.</p>
      </StatePanel>;
      break;
    case 'storage':
      panel = <StatePanel title="We couldn't finish here" primary={{ label: 'Try again', onClick: () => void confirm(0) }}>
        <p>{STORAGE_HELP}</p>
      </StatePanel>;
      break;
    case 'error':
      panel = <StatePanel title="We couldn't confirm your setup yet" primary={{ label: 'Try again', onClick: () => void confirm(0) }}>
        <p>Please try again in a moment. If you finished on Stripe's page, we'll email you a confirmation once it's done.</p>
      </StatePanel>;
      break;
    case 'outcome': {
      const r = phase.result;
      const method = paymentMethodInSentence(r.methodLabel ?? 'payment method');
      const body = (() => {
        switch (r.outcome) {
          case 'activated':
            return <StatePanel mark={{ tone: 'success', label: 'On' }} title="Automatic payments are on" primary={back}>
              <p>{`${branding?.partnerName || 'Your service provider'} will charge your ${method} for invoices issued from today. We'll email you the amount and date before each payment.`}</p>
              <p data-testid="autopay-return-fee">{r.feeText}</p>
              <p>{portal ? "We're emailing you a confirmation." : "We're emailing you a confirmation. You can close this page."}</p>
            </StatePanel>;
          case 'pending_verification':
            return <StatePanel mark={{ tone: 'warning', label: 'One more step' }} title="Verify your bank account" primary={back}>
              <p>{`Your ${method} is saved. Stripe will email you instructions to verify it, usually within 1–2 business days.`}</p>
              <p>No automatic payments are made until it's verified, and we'll email you when it's done.</p>
            </StatePanel>;
          case 'failed':
            return <StatePanel mark={{ tone: 'destructive', label: 'Not set up' }} title="Your setup didn't finish" tone="alert"
              primary={restart('Try again')}>
              <p>Stripe couldn't save your payment method, so nothing was set up and nothing was charged.</p>
              {!restartHref && noLinkHint}
            </StatePanel>;
          case 'abandoned':
            return <StatePanel mark={{ tone: 'neutral', label: 'Not set up' }} title="Your setup session expired" primary={restart('Start again')}>
              <p>Stripe's page timed out before your details were saved. Nothing was saved or charged.</p>
              {!restartHref && noLinkHint}
            </StatePanel>;
          case 'unsupported_method':
            return <StatePanel mark={{ tone: 'warning', label: 'Not set up' }} title="That payment method can't be used for automatic payments" primary={restart('Start again')}>
              <p data-testid="autopay-unsupported-method">Stripe Link can't be saved for automatic payments, so nothing was saved or charged. On Stripe's page, choose "Pay without Link" and type your card number, or choose a bank account.</p>
              {!restartHref && noLinkHint}
            </StatePanel>;
          case 'stale_generation':
            return r.current?.status === 'active'
              ? <StatePanel mark={{ tone: 'success', label: 'On' }} title="You're already set up" primary={back}>
                <p>{`This setup was replaced by a newer one. Automatic payments are on with your ${paymentMethodInSentence(r.current.methodLabel ?? 'saved payment method')}.`}</p>
              </StatePanel>
              : <StatePanel mark={{ tone: 'neutral', label: 'Not set up' }} title="This setup link was replaced" primary={contact} secondary={back}>
                <p>{`${branding?.partnerName || 'Your service provider'} sent you a newer setup link, so nothing was saved or charged here. Please use the link in your most recent email from ${msp}.`}</p>
              </StatePanel>;
          default:
            return <StatePanel title="Check your email" primary={back}><p>We'll email you once your setup is confirmed.</p></StatePanel>;
        }
      })();
      panel = <div data-testid="autopay-return-outcome">{body}</div>;
      break;
    }
  }
  const contactInCard = phase.kind === 'outcome' && phase.result.outcome === 'stale_generation' && phase.result.current?.status !== 'active' && !!contact;
  return (
    <AutopayShell partnerName={branding?.partnerName} logoUrl={branding?.logoUrl} supportEmail={branding?.supportEmail} testId="autopay-return"
      reserveIdentity={!portal} contactInCard={contactInCard}>
      {panel}
    </AutopayShell>
  );
}
