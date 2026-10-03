import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { navigateTo } from '@/lib/navigation';
import { runAction } from '@/lib/runAction';
type ActionResult = { success?: boolean; status?: 'pending' | 'skipped'; url?: string; processing?: boolean; paid?: boolean };
const pendingMessage = "Skip requested — a payment already in progress is being stopped; we'll confirm by email.";
export default function AutopayActionPage({ token, action }: { token: string; action: 'skip' | 'confirm' }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const endpoint = `/autopay/public/${encodeURIComponent(token)}/${action}`;
  useEffect(() => {
    let canceled = false;
    setReady(false); setMessage('');
    void apiGet<{ state: string; control?: string | null }>(endpoint, { redirectOnUnauthorized: false }).then(result => {
      if (canceled) return;
      if (result.data && !result.error) {
        if (action === 'skip' && result.data.control === 'skip') setMessage(pendingMessage);
        else if (action === 'skip' && result.data.state === 'skipped_by_client') setMessage('Automatic payment skipped. You can still pay the invoice directly.');
        else setReady(true);
      } else setMessage('This link is unavailable.');
    }).catch(() => { if (!canceled) setMessage('This link is unavailable.'); });
    return () => { canceled = true; };
  }, [endpoint, action]);
  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true);
    const result = await runAction<ActionResult>({
      request: () => apiPost<ActionResult>(endpoint, {}, { redirectOnUnauthorized: false }),
      errorFallback: 'The request could not be completed.', successMessage: 'Request completed.',
      onOutcome: text => setMessage(text),
    });
    if (result) {
      if (result.url) void navigateTo(result.url);
      else {
        setReady(false);
        setMessage(result.status === 'pending' ? pendingMessage : action === 'skip'
          ? 'Automatic payment skipped. You can still pay the invoice directly.'
          : result.processing ? 'Payment is processing.' : result.paid ? 'Payment received.' : 'Payment needs billing review.');
      }
    }
    setBusy(false);
  };
  return <main className="mx-auto max-w-xl space-y-5 px-6 py-12" data-testid={`autopay-${action}-page`} aria-busy={busy}>
    <h1 className="text-2xl font-semibold">{action === 'skip' ? 'Skip automatic payment' : 'Confirm payment'}</h1>
    <p>{action === 'skip' ? 'This skips automatic payment for this invoice only.'
      : 'Continue to a secure payment page. A payment already processing will not be charged again.'}</p>
    {message && <p role="status" data-testid="autopay-action-result">{message}</p>}
    {ready && <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      data-testid={`autopay-${action}-submit`} disabled={busy} onClick={() => void submit()}>
      {busy ? 'Submitting…' : action === 'skip' ? 'Skip this invoice' : 'Continue to payment'}
    </button>}
  </main>;
}
