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
import { Nowrap, StatePanel, type PanelAction } from './autopay/StatePanel';
import { LinkStatePanel, linkFailureContactInCard, type LinkFailureView } from './autopay/LinkStatePanel';

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
  /** R5: after a failed POST, read the link again and show its state; true when it answered. */
  const reread = async (): Promise<boolean> => {
    const result = await apiGet<AutopayConfirmView>(endpoint, { redirectOnUnauthorized: false }).catch(() => null);
    if (result?.data) { setView(result.data); return true; }
    const link = result ? linkFailureOf(result) : null;
    if (link) { setFailure(link); return true; }
    return false;
  };

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(false);
    const result = await apiPost<Result>(endpoint, {}, { redirectOnUnauthorized: false }).catch(() => null);
    const data = result?.data;
    // FP-4: the invoice page then says the automatic payment was canceled.
    if (data?.url) { void navigateTo(`${data.url}#autopay-released`); return; }
    // R5: {paid:false} means Stripe took the money but it isn't applied to the invoice yet:
    // "received, under review", never "try again" (the client could pay twice).
    let landing: Landed = null;
    if (data?.processing) landing = 'processing';
    else if (data && 'paid' in data) landing = data.paid ? 'paid' : 'review';
    else if (data?.notNeeded) landing = 'not_needed';
    else if (result?.statusCode === 409 && result.errorDetails?.reason === 'needs_review') landing = 'review';
    else if (result?.statusCode === 409 && result.errorDetails?.reason === 'processing') landing = 'processing';
    if (landing === 'not_needed') {
      // What is still owed comes from a fresh read (the page's view predates the cancellation).
      setLanded('not_needed'); await reread();
    } else if (landing) setLanded(landing);
    // Any other refusal or a dropped connection: show the server's current state, not a guess.
    // The failure notice only appears if the payment still waits on the bank.
    else { await reread(); setError(true); }
    inFlight.current = false; setBusy(false);
  }

  // V-20: the MSP's address appears once: in the card when emailing them is the next step.
  const shell = (panel: ReactElement, branding: { partnerName?: string | null; logoUrl?: string | null; supportEmail?: string | null } = {}, contactInCard = false) =>
    <AutopayShell partnerName={branding.partnerName} logoUrl={branding.logoUrl} supportEmail={branding.supportEmail} testId="autopay-confirm-page" contactInCard={contactInCard}>{panel}</AutopayShell>;
  if (failure) return shell(<LinkStatePanel failure={failure} purpose="confirm_payment" />, failure, linkFailureContactInCard(failure, 'confirm_payment'));
  if (loadError) {
    return shell(<StatePanel title="We couldn't load this page" primary={{ label: 'Refresh', onClick: () => window.location.reload() }}>
      <p>Please refresh in a moment. Nothing has been charged by opening this page.</p>
    </StatePanel>);
  }
  if (!view) return shell(<p className="text-sm text-muted-foreground" aria-busy="true">Loading…</p>);

  const invoice = view.invoiceNumber ? `invoice ${view.invoiceNumber}` : 'this invoice';
  const msp = view.partnerName || 'your service provider';
  const viewInvoice: PanelAction | null = view.invoiceUrl ? { label: 'View invoice', href: view.invoiceUrl, variant: 'secondary' } : null;
  const stillDue = ['sent', 'partially_paid', 'overdue'].includes(view.invoiceStatus) && Number(view.balance) > 0;
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
  } else if (state === 'not_needed' && stillDue) {
    // V-3: canceled (often by the client on the invoice page) with money still due.
    panel = <StatePanel mark={{ tone: 'warning', label: 'Not paid' }} title="The automatic payment was canceled"
      primary={view.invoiceUrl ? { label: 'Pay invoice', href: view.invoiceUrl, testId: 'autopay-confirm-pay-invoice' } : null}
      summary={[...(view.invoiceNumber ? [{ label: 'Invoice', value: view.invoiceNumber }] : []),
        { label: 'Amount due', value: money(view.balance, view.currency), figure: true }]}>
      <p>{`There's nothing to confirm here any more. ${money(view.balance, view.currency)} is still due on ${invoice}. Pay it from the invoice; your bank may ask you to confirm the payment there.`}</p>
    </StatePanel>;
  } else if (state === 'not_needed') {
    panel = <StatePanel title="No action needed" primary={viewInvoice}>
      <p>{view.invoiceStatus === 'paid'
        ? `${view.invoiceNumber ? `Invoice ${view.invoiceNumber}` : 'The invoice'} is paid, so there's nothing to confirm.`
        : "This payment doesn't need confirming any more, and nothing is due on the invoice."}</p>
    </StatePanel>;
  } else if (state === 'review') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'Received' }} title="We received your payment"
      primary={view.supportEmail ? { label: `Email ${view.partnerName || 'them'}`, href: `mailto:${view.supportEmail}`, variant: 'secondary' } : null}>
      <p>{`Your payment came through, and ${msp} is reviewing how it's applied. You don't need to do anything, and they'll contact you if needed.`}</p>
    </StatePanel>;
  } else {
    const method = view.methodLabel ? ` with your ${paymentMethodInSentence(view.methodLabel)}` : '';
    const total = ((Math.round(Number(view.amount) * 100) + Math.round(Number(view.fee ?? 0) * 100)) / 100).toFixed(2);
    const withFee = Number(view.fee) > 0
      ? `an automatic payment of ${money(total, view.currency)} (${money(view.amount, view.currency)} plus a ${money(view.fee, view.currency)} processing fee)`
      : `the ${money(view.amount, view.currency)} payment`;
    panel = <div className="space-y-5">
      <StatePanel mark={{ tone: 'warning', label: 'Confirmation needed' }} titleText={`Confirm your payment for ${invoice}`}
        title={view.invoiceNumber ? <>Confirm your payment for invoice <Nowrap>{view.invoiceNumber}</Nowrap></> : 'Confirm your payment for this invoice'}
        summary={[...(view.invoiceNumber ? [{ label: 'Invoice', value: view.invoiceNumber }] : []),
          { label: 'Amount', value: money(view.amount, view.currency), figure: true },
          ...(view.methodLabel ? [{ label: 'Payment method', value: view.methodLabel }] : [])]}>
        {/* FP-4: the bank asked about the automatic payment with its fee; paying on the invoice has none. */}
        <p>{`Your bank asked you to confirm ${withFee}${method}.${error ? '' : ' Nothing has been charged yet.'}`}</p>
        <p>{Number(view.fee) > 0
          ? `On the invoice page you'll pay ${money(view.amount, view.currency)}, with no processing fee. Your bank may ask you to confirm it there.`
          : "You'll finish paying on the invoice page with Stripe."}</p>
      </StatePanel>
      {error && <Notice tone="destructive" title="We couldn't confirm the payment right now"><p>Open the invoice to check its status before paying, or try again in a moment.</p></Notice>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button type="button" className={cn(BTN_PRIMARY, BTN_BLOCK)} data-testid="autopay-confirm-submit" disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Opening…' : 'Continue to payment'}
        </button>
        {view.invoiceUrl && <a href={view.invoiceUrl} className={cn(LINK, 'self-center text-sm')}>View invoice</a>}
      </div>
    </div>;
  }
  return shell(panel, view, state === 'review' && !!view.supportEmail);
}
