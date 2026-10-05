import { useEffect, useState, type ReactElement } from 'react';
import type { AutopayStopView } from '@breeze/shared';
import { apiGet, apiPost } from '@/lib/api';
import { linkFailureOf } from '@/lib/autopay';
import { AutopayShell } from './autopay/AutopayShell';
import { StatePanel } from './autopay/StatePanel';
import { LinkStatePanel, type LinkFailureView } from './autopay/LinkStatePanel';
import { StopAutopayConfirm } from './autopay/StopAutopayConfirm';

type Phase = 'loading' | 'error' | 'ready' | 'stopped' | 'kept';

/** The emailed "Stop automatic payments" link. */
export default function AutopayStopPage({ token }: { token: string }) {
  const [view, setView] = useState<AutopayStopView | null>(null);
  const [failure, setFailure] = useState<LinkFailureView | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const endpoint = `/autopay/public/${encodeURIComponent(token)}/stop`;
  useEffect(() => {
    let cancelled = false;
    void apiGet<AutopayStopView>(endpoint, { redirectOnUnauthorized: false }).then(result => {
      if (cancelled) return;
      if (result.data) { setView(result.data); setPhase('ready'); return; }
      const link = linkFailureOf(result);
      if (link) setFailure(link); else setPhase('error');
    }).catch(() => { if (!cancelled) setPhase('error'); });
    return () => { cancelled = true; };
  }, [endpoint]);

  const branding: { partnerName?: string | null; logoUrl?: string | null; supportEmail?: string | null } = view ?? failure ?? {};
  const msp = view?.partnerName || 'Your service provider';
  const stop = async () => {
    const result = await apiPost<{ success?: boolean }>(endpoint, {}, { redirectOnUnauthorized: false });
    if (!result.data || result.error || (result.statusCode ?? 200) >= 400) return false;
    setPhase('stopped');
    return true;
  };

  let panel: ReactElement;
  if (failure) panel = <LinkStatePanel failure={failure} purpose="stop_autopay" />;
  else if (phase === 'error') {
    panel = <StatePanel title="We couldn't load this page" primary={{ label: 'Refresh', onClick: () => window.location.reload() }}>
      <p>Please refresh in a moment. Nothing about your payments has changed.</p>
    </StatePanel>;
  } else if (phase === 'loading' || !view) panel = <p className="text-sm text-muted-foreground" aria-busy="true">Loading…</p>;
  else if (phase === 'stopped') {
    const method = view.method?.type === 'us_bank_account' ? 'bank account' : view.method ? 'card' : null;
    panel = <StatePanel mark={{ tone: 'neutral', label: 'Off' }} title="Automatic payments are off" testId="autopay-stop-done">
      <p>{`${msp} won't charge you automatically${method ? `, and your saved ${method} has been removed` : ''}.`}</p>
      <p>{`We're emailing you a confirmation${view.openInvoiceCount > 0 ? ', with links to your open invoices' : ''}. If a bank payment had already started, it may still complete.`}</p>
    </StatePanel>;
  } else if (phase === 'kept') {
    panel = <StatePanel mark={{ tone: 'success', label: view.enrollment?.status === 'paused' ? 'Paused' : 'On' }} title="Nothing changed">
      <p>{view.enrollment?.status === 'paused'
        ? `Your automatic payments to ${view.partnerName || 'your service provider'} stay paused. You can close this page.`
        : `Automatic payments to ${view.partnerName || 'your service provider'} are still on. You can close this page.`}</p>
    </StatePanel>;
  } else if (view.enrollment?.status === 'cancelled') {
    panel = <StatePanel mark={{ tone: 'neutral', label: 'Off' }} title="Automatic payments are off">
      <p>{`${msp} won't charge you automatically.`}</p>
    </StatePanel>;
  } else if (!view.enrollment || (view.enrollment.status === 'requested' && !view.method)) {
    panel = <StatePanel mark={{ tone: 'neutral', label: 'Not set up' }} title="You haven't set up automatic payments">
      <p>{`There's nothing to stop. ${msp} can't charge you automatically unless you set up automatic payments yourself. You don't need to do anything.`}</p>
    </StatePanel>;
  } else {
    panel = <StopAutopayConfirm partnerName={view.partnerName} enrollment={view.enrollment} method={view.method}
      onStop={stop} onKeep={() => setPhase('kept')} />;
  }
  return (
    <AutopayShell partnerName={branding.partnerName} logoUrl={branding.logoUrl} supportEmail={branding.supportEmail} testId="autopay-stop-page">
      {panel}
    </AutopayShell>
  );
}
