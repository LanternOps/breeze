import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { runAction } from '@/lib/runAction';
import type { AutopayPageData, MethodType, SetupOutcome } from '@/lib/autopay';
export default function AutopaySetupPage({ token, portal = false, mode = 'setup' }: {
  token?: string; portal?: boolean; mode?: 'setup' | 'return' | 'stop';
}) {
  const [data, setData] = useState<AutopayPageData | null>(null);
  const [stopName, setStopName] = useState<string | null>(null);
  const [method, setMethod] = useState<MethodType>('us_bank_account');
  const [accepted, setAccepted] = useState(false); const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(''); const [failed, setFailed] = useState(false);
  const [finished, setFinished] = useState(false); const [outcome, setOutcome] = useState<SetupOutcome | null>(null);
  const config = { redirectOnUnauthorized: portal };
  const base = portal ? '/portal/payment-methods' : `/autopay/public/${encodeURIComponent(token ?? '')}`;
  const onOutcome = (message: string, error: boolean) => { setFeedback(message); setFailed(error); };
  useEffect(() => {
    if (mode === 'return') return;
    let cancelled = false;
    const path = mode === 'stop' && !portal ? `${base}/stop` : base;
    void apiGet<AutopayPageData & { orgName?: string }>(path, { redirectOnUnauthorized: portal }).then(result => {
      if (cancelled) return;
      if (!result.data) { onOutcome(result.error || 'This link is unavailable. Ask your service provider for a new one.', true); return; }
      if (mode === 'stop') { setStopName(result.data.partnerName); return; }
      setData(result.data); setMethod(result.data.achMode === 'card_only' ? 'card' : 'us_bank_account'); setAccepted(false);
    });
    return () => { cancelled = true; };
  }, [base, mode, portal]);
  async function start() {
    if (!data || !accepted || busy) return; setBusy(true);
    const result = await runAction<{ url: string }>({
      request: () => apiPost(`${base}/setup-session`, { methodType: method, consentAccepted: true, disclosureHash: data.disclosures[method].hash }, config),
      onOutcome, successMessage: 'Opening secure Stripe setup…', errorFallback: 'Could not open secure setup. Try again.',
      validate: value => typeof value.url === 'string' && value.url.startsWith('https://checkout.stripe.com/'),
    });
    if (result) {
      if (!portal && token) {
        try { sessionStorage.setItem('autopay-return-token', token); }
        catch { onOutcome('Enable session storage to return securely from Stripe, then try again.', true); setBusy(false); return; }
      }
      window.location.assign(result.url);
    } else { setBusy(false); setAccepted(false); }
  }
  async function confirmReturn() {
    if (busy) return; setBusy(true);
    const params = new URLSearchParams(window.location.search);
    const checkoutSessionId = params.get('session_id');
    const returnToken = sessionStorage.getItem('autopay-return-token');
    const returnPortal = params.get('target') === 'portal';
    if (!checkoutSessionId || (!returnPortal && !returnToken)) { onOutcome('This return link is incomplete. Contact your service provider.', true); setBusy(false); return; }
    const result = await runAction<SetupOutcome>({
      request: () => apiPost(returnPortal ? '/portal/payment-methods/setup-return' : '/autopay/public/setup-return',
        { checkoutSessionId, ...(!returnPortal ? { token: returnToken } : {}) }, { redirectOnUnauthorized: returnPortal }),
      onOutcome, successMessage: 'Setup checked.', errorFallback: 'Could not confirm setup. Try again.',
    });
    if (result) { setOutcome(result); if (!returnPortal) sessionStorage.removeItem('autopay-return-token'); } setBusy(false);
  }
  async function stop() {
    if (busy || finished) return; setBusy(true);
    const result = await runAction({ request: () => apiPost(portal ? '/portal/autopay/stop' : `${base}/stop`, {}, config),
      onOutcome, successMessage: 'Automatic payments stopped. Any payment already processing will still complete.',
      errorFallback: 'Could not stop automatic payments. Try again.' });
    setFinished(result !== null); setBusy(false);
  }
  return <section className="mx-auto max-w-xl space-y-5 p-6" data-testid="autopay-setup-page">
    {feedback && <p role={failed ? 'alert' : 'status'} data-testid="autopay-feedback">{feedback}</p>}
    {mode === 'return' ? <div data-testid="autopay-return">
      <h1>Confirm automatic payment setup</h1>
      {!outcome && <button data-testid="autopay-return-submit" disabled={busy} onClick={() => void confirmReturn()}>Confirm setup</button>}
      {outcome && <div data-testid="autopay-return-outcome">
        <h2>{({ activated: 'Automatic payments are set up', pending_verification: 'Bank verification is pending',
          stale_generation: 'This setup request is no longer current', failed: 'Setup was not completed' })[outcome.outcome]}</h2>
        {(outcome.outcome === 'activated' || outcome.outcome === 'pending_verification') && <p>{outcome.methodLabel} — {outcome.feeText}</p>}
        {outcome.outcome === 'pending_verification' && <p>Follow Stripe’s verification instructions. No automatic payment can be made until verification completes.</p>}
        {outcome.outcome === 'stale_generation' && <p>This return did not restart automatic payments. Ask your service provider for a new request.</p>}
      </div>}
    </div> : mode === 'stop' ? stopName && <div data-testid="autopay-stop-confirm">
      <h1>Stop automatic payments to {stopName}?</h1>
      <p>Future automatic payments will stop. A bank payment already processing cannot be recalled. Open invoices still need to be paid.</p>
      <button data-testid="autopay-stop-submit" disabled={busy || finished} onClick={() => void stop()}>Stop automatic payments</button>
    </div> : data && <>
      {data.logoUrl && <img src={data.logoUrl} alt={`${data.partnerName} logo`} className="max-h-16" />}
      <h1>Set up automatic payments to {data.partnerName}</h1><p>{data.scheduleText}</p>
      <p>This applies to new invoices after enrollment. You can stop automatic payments at any time.</p>
      <fieldset disabled={busy}><legend>Choose your payment method</legend>
        {(data.achMode === 'card_only' ? ['card'] : data.achMode === 'ach_only' ? ['us_bank_account'] : ['us_bank_account', 'card']).map(value => {
          const type = value as MethodType;
          return <label key={type} className="block my-3"><input type="radio" name="autopay-method" data-testid={`autopay-method-${type}`}
            checked={method === type} onChange={() => { setMethod(type); setAccepted(false); }} />
            {type === 'card' ? 'Card' : data.achMode === 'ach_preferred' ? 'Bank account (recommended)' : 'Bank account'}
            <span className="block" data-testid={`autopay-fee-${type}`}>{data.disclosures[type].feeText}</span>
          </label>;
        })}
      </fieldset>
      <p data-testid="autopay-consent-text">{data.disclosures[method].text}</p>
      <label><input data-testid="autopay-consent" type="checkbox" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} /> I agree to this authorization.</label>
      <button data-testid="autopay-setup-submit" disabled={!accepted || busy} onClick={() => void start()}>Continue to secure Stripe setup</button>
    </>}
  </section>;
}
