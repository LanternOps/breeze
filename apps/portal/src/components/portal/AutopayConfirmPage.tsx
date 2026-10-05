import { paymentMethodInSentence } from '@breeze/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AutopayConfirmView } from '@breeze/shared';
import { apiGet, apiPost } from '@/lib/api';
import { navigateTo } from '@/lib/navigation';
import { money } from '@/lib/format';
import { linkFailureOf} from '@/lib/autopay';
import { cn } from '@/lib/utils';
import { BTN_BLOCK, BTN_PRIMARY, LINK, Notice } from './ui';
import { AutopayShell } from './autopay/AutopayShell';
import { StatePanel, type PanelAction } from './autopay/StatePanel';
import { LinkStatePanel, type LinkFailureView } from './autopay/LinkStatePanel';

type Result = { url?: string; processing?: boolean; paid?: boolean; notNeeded?: boolean };
type Landed = 'processing' | 'paid' | 'not_needed' | 'review' | null;

/**
 * The emailed "Confirm payment" link for an automatic payment the bank wants the
 * client to authenticate (3DS). Continuing cancels that off-session attempt and
 * takes the client to the invoice to pay on-session; the bank confirms there.
 */
export default function AutopayConfirmPage({ token }: { token: string }) {
  const [view, setView] = useState<AutopayConfirmView | null>(null);
  const [failure, setFailure] = useState<LinkFailureView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [landed, setLanded] = useState<Landed>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const endpoint = `/autopay/public/${encodeURIComponent(token)}/confirm`;

  useEffect(() => {
    let cancelled = false;
    void apiGet<AutopayConfirmView>(endpoint, { redirectOnUnauthorized: false }).then(result => {
      if (cancelled) return;
      if (result.data) { setView(result.data); return; }
      const link = linkFailureOf(result);
      if (link) setFailure(link); else setLoadError(true);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [endpoint]);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(false);
    const result = await apiPost<Result>(endpoint, {}, { redirectOnUnauthorized: false }).catch(() => null);
    const data = result?.data;
    if (data?.url) { void navigateTo(data.url); return; }
    inFlight.current = false; setBusy(false);
    if (data?.processing) setLanded('processing');
    else if (data?.paid) setLanded('paid');
    else if (data?.notNeeded) setLanded('not_needed');
    // 409s carry server-owned sentences: money arrived but needs review, or still processing.
    else if (result?.statusCode === 409) setLanded(/review/i.test(result.error ?? '') ? 'review' : 'processing');
    else setError(true);
  }

  const shell = (panel: ReactElement, branding: { partnerName?: string | null; logoUrl?: string | null; supportEmail?: string | null } = {}) =>
    <AutopayShell partnerName={branding.partnerName} logoUrl={branding.logoUrl} supportEmail={branding.supportEmail} testId="autopay-confirm-page">{panel}</AutopayShell>;
  if (failure) return shell(<LinkStatePanel failure={failure} purpose="confirm_payment" />, failure);
  if (loadError) {
    return shell(<StatePanel title="We couldn't load this page" primary={{ label: 'Refresh', onClick: () => window.location.reload() }}>
      <p>Please refresh in a moment. Nothing has been charged by opening this page.</p>
    </StatePanel>);
  }
  if (!view) return shell(<p className="text-sm text-muted-foreground" aria-busy="true">Loading…</p>);

  const invoice = view.invoiceNumber ? `invoice ${view.invoiceNumber}` : 'this invoice';
  const msp = view.partnerName || 'your service provider';
  const viewInvoice: PanelAction | null = view.invoiceUrl ? { label: 'View invoice', href: view.invoiceUrl, variant: 'secondary' } : null;
  const state: Landed = landed ?? (view.state === 'processing' ? 'processing' : view.state === 'succeeded' ? 'paid'
    : view.state === 'not_needed' || view.state === 'canceled' ? 'not_needed' : view.state === 'unapplied' ? 'review' : null);
  let panel: ReactElement;
  if (state === 'processing') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'Processing' }} title="Your payment is processing" primary={viewInvoice}>
      <p>{`A payment for ${invoice} is already processing, so there's nothing to confirm. We'll email you a receipt when it completes.`}</p>
    </StatePanel>;
  } else if (state === 'paid') {
    panel = <StatePanel mark={{ tone: 'success', label: 'Paid' }} title="Payment received" primary={viewInvoice}>
      <p>{`Thank you. ${view.invoiceNumber ? `Invoice ${view.invoiceNumber}` : 'The invoice'} is paid, and a receipt is on its way to your email.`}</p>
    </StatePanel>;
  } else if (state === 'not_needed') {
    panel = <StatePanel title="No action needed" primary={viewInvoice}>
      <p>This payment doesn't need confirming any more. It was canceled, or the invoice was settled another way.</p>
    </StatePanel>;
  } else if (state === 'review') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'Received' }} title="We received your payment"
      primary={view.supportEmail ? { label: `Email ${view.partnerName || 'them'}`, href: `mailto:${view.supportEmail}`, variant: 'secondary' } : null}>
      <p>{`Your payment came through, and ${msp} is reviewing how it's applied. You don't need to do anything, and they'll contact you if needed.`}</p>
    </StatePanel>;
  } else {
    const method = view.methodLabel ? ` with your ${paymentMethodInSentence(view.methodLabel)}` : '';
    panel = <div className="space-y-5">
      <StatePanel mark={{ tone: 'warning', label: 'Confirmation needed' }} title={`Confirm your payment for ${invoice}`}
        summary={[...(view.invoiceNumber ? [{ label: 'Invoice', value: view.invoiceNumber }] : []),
          { label: 'Amount', value: money(view.amount, view.currency), figure: true },
          ...(view.methodLabel ? [{ label: 'Payment method', value: view.methodLabel }] : [])]}>
        <p>{`Your bank asked you to confirm the ${money(view.amount, view.currency)} payment${method}. Nothing has been charged yet. You'll finish paying on the invoice page with Stripe.`}</p>
      </StatePanel>
      {error && <Notice tone="destructive" title="We couldn't confirm the payment right now"><p>Please try again in a moment, or open the invoice to check its status.</p></Notice>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button type="button" className={cn(BTN_PRIMARY, BTN_BLOCK)} data-testid="autopay-confirm-submit" disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Opening…' : 'Continue to payment'}
        </button>
        {view.invoiceUrl && <a href={view.invoiceUrl} className={cn(LINK, 'self-center text-sm')}>View invoice</a>}
      </div>
    </div>;
  }
  return shell(panel, view);
}
