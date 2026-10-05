import { useEffect, useState } from 'react';
import type { AutopayEnrollmentStatus, AutopayEnrollmentView } from '@breeze/shared';
import { apiGet } from '@/lib/api';
import { savedMethodLabel, type AutopayPortalPage } from '@/lib/autopay';
import AutopaySetupPage from './AutopaySetupPage';
const STATUS_LABELS: Record<AutopayEnrollmentStatus, string> = {
  active: 'Active', paused: 'Paused by your provider', cancelled: 'Stopped', requested: 'Requested',
};
function statusLabel(status: AutopayEnrollmentStatus | undefined): string {
  return status ? STATUS_LABELS[status] ?? 'Status unavailable' : 'Not set up';
}
/** Plain-language needs-attention copy. Only method problems can be fixed by the
 * client, and only where the portal accepts an update (active or requested). */
function needsAttention(enrollment: AutopayEnrollmentView | null, canUpdate: boolean): { text: string; methodProblem: boolean } | null {
  if (!enrollment?.needsAttentionReason || enrollment.status === 'cancelled') return null;
  const fix = canUpdate ? 'Update it to keep them working.' : 'Contact your service provider to update it.';
  switch (enrollment.needsAttentionReason) {
    case 'method_unusable':
      return { methodProblem: true, text: `Your saved payment method can't be used for automatic payments. ${fix}` };
    case 'verification_failed':
      return { methodProblem: true, text: "We couldn't verify your bank account, so it can't be used for automatic payments. "
        + (canUpdate ? 'Update your payment method to keep them working.' : 'Contact your service provider to update it.') };
    case 'stripe_account_changed': case 'key_missing_permissions':
      return { methodProblem: false, text: 'Automatic payments are on hold while your service provider fixes its payment setup. No action is needed from you.' };
    default: return null;
  }
}
export default function PaymentMethodsPage() {
  const [data, setData] = useState<AutopayPortalPage | null>(null); const [error, setError] = useState('');
  const [view, setView] = useState<'summary' | 'setup' | 'stop'>('summary');
  const [refresh, setRefresh] = useState(0);
  const [stopped, setStopped] = useState(false);
  useEffect(() => { let current = true;
    void apiGet<AutopayPortalPage>('/portal/payment-methods').then(result => {
      if (!current) return; if (result.data) setData(result.data); else setError(result.error || 'Payment methods are unavailable.');
    }).catch(() => { if (current) setError('Payment methods are unavailable.'); }); return () => { current = false; };
  }, [refresh]);
  if (error && !data) return <p role="alert" data-testid="autopay-payment-methods-error">{error}</p>;
  if (!data) return <p>Loading payment methods…</p>;
  const status = data.enrollment?.status;
  const canUpdate = !data.stopOnly && (status === 'active' || status === 'requested');
  const attention = needsAttention(data.enrollment, canUpdate);
  // A provider-side hold refuses setup completion, so an update would fail after card entry.
  const providerHold = attention !== null && !attention.methodProblem;
  return <main data-testid="autopay-payment-methods" className="space-y-5">
    {stopped && <p role="status" data-testid="autopay-stop-feedback">Automatic payments stopped. Any payment already processing will still complete.</p>}
    {error && <p role="alert" data-testid="autopay-payment-methods-error">{error}</p>}
    <h1>Payment methods</h1><p data-testid="autopay-status">Automatic payments: {statusLabel(status)}</p>
    {attention && <p role="alert" data-testid="autopay-needs-attention">{attention.text}</p>}
    {!(attention?.methodProblem && !data.method) && <p data-testid="autopay-saved-method">{savedMethodLabel(data.method)}</p>}
    {data.method?.status === 'pending_verification' && <p>Verification pending — no automatic payments can be made yet.</p>}
    {!data.stopOnly && (canUpdate ? !providerHold &&
      <button data-testid="autopay-update-method" onClick={() => setView('setup')}>Update payment method</button>
      : status === 'paused' ? <p>Your service provider has paused automatic payments.</p>
      : <p>Ask your service provider to send an automatic payment request.</p>)}
    {data.enrollment && data.enrollment.status !== 'cancelled' && <button data-testid="autopay-portal-stop" onClick={() => setView('stop')}>Stop automatic payments</button>}
    {view !== 'summary' && <button data-testid="autopay-back" onClick={() => setView('summary')}>Back</button>}
    {view === 'setup' && !data.stopOnly && <AutopaySetupPage portal />}
    {view === 'stop' && <AutopaySetupPage portal mode="stop" onStopped={() => {
      setStopped(true);
      setView('summary');
      setData(current => current && { ...current, enrollment: current.enrollment && { ...current.enrollment, status: 'cancelled' } });
      setError('');
      if (!data.stopOnly) setRefresh(value => value + 1);
    }} />}
  </main>;
}
