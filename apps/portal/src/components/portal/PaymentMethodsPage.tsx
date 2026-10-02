import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { savedMethodLabel, type AutopayPageData } from '@/lib/autopay';
import AutopaySetupPage from './AutopaySetupPage';
export default function PaymentMethodsPage() {
  const [data, setData] = useState<AutopayPageData | null>(null); const [error, setError] = useState('');
  const [view, setView] = useState<'summary' | 'setup' | 'stop'>('summary');
  const [refresh, setRefresh] = useState(0);
  const [stopped, setStopped] = useState(false);
  useEffect(() => { let current = true;
    void apiGet<AutopayPageData>('/portal/payment-methods').then(result => {
      if (!current) return; if (result.data) setData(result.data); else setError(result.error || 'Payment methods are unavailable.');
    }).catch(() => { if (current) setError('Payment methods are unavailable.'); }); return () => { current = false; };
  }, [refresh]);
  if (error && !data) return <p role="alert" data-testid="autopay-payment-methods-error">{error}</p>;
  if (!data) return <p>Loading payment methods…</p>;
  return <main data-testid="autopay-payment-methods" className="space-y-5">
    {stopped && <p role="status" data-testid="autopay-stop-feedback">Automatic payments stopped. Any payment already processing will still complete.</p>}
    {error && <p role="alert" data-testid="autopay-payment-methods-error">{error}</p>}
    <h1>Payment methods</h1><p>Automatic payments: {data.enrollment?.status ?? 'Not requested'}</p>
    <p data-testid="autopay-saved-method">{savedMethodLabel(data.method)}</p>
    {data.method?.status === 'pending_verification' && <p>Verification pending — no automatic payments can be made yet.</p>}
    {data.enrollment?.status === 'active' || data.enrollment?.status === 'requested' ?
      <button data-testid="autopay-update-method" onClick={() => setView('setup')}>Update payment method</button> :
      <p>Ask your service provider to send an automatic payment request.</p>}
    {data.enrollment && data.enrollment.status !== 'cancelled' && <button data-testid="autopay-portal-stop" onClick={() => setView('stop')}>Stop automatic payments</button>}
    {view !== 'summary' && <button data-testid="autopay-back" onClick={() => setView('summary')}>Back</button>}
    {view === 'setup' && <AutopaySetupPage portal />}
    {view === 'stop' && <AutopaySetupPage portal mode="stop" onStopped={() => {
      setStopped(true);
      setView('summary');
      setData(current => current && { ...current, enrollment: current.enrollment && { ...current.enrollment, status: 'cancelled' } });
      setError('');
      setRefresh(value => value + 1);
    }} />}
  </main>;
}
