import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AutopaySkipView } from '@breeze/shared';
import { apiGet, apiPost } from '@/lib/api';
import { longDate, money } from '@/lib/format';
import { linkFailureOf } from '@/lib/autopay';
import { cn } from '@/lib/utils';
import { BTN_BLOCK, BTN_PRIMARY, LINK, Notice } from './ui';
import { AutopayShell } from './autopay/AutopayShell';
import { Nowrap, StatePanel, type PanelAction } from './autopay/StatePanel';
import { LinkStatePanel, linkFailureContactInCard, type LinkFailureView } from './autopay/LinkStatePanel';
import type { SummaryRow } from './autopay/SummaryList';

type Outcome = 'skipped' | 'pending' | 'processing' | 'changing' | null;

/**
 * The emailed "Skip this payment" link. Always names the invoice, amount, fee,
 * charge date and method; says plainly when the payment can no longer be skipped
 * (already with Stripe, already being changed, paid, not charged anyway).
 */
export default function AutopaySkipPage({ token }: { token: string }) {
  const [view, setView] = useState<AutopaySkipView | null>(null);
  const [failure, setFailure] = useState<LinkFailureView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const inFlight = useRef(false);
  const endpoint = `/autopay/public/${encodeURIComponent(token)}/skip`;

  const load = async () => {
    const result = await apiGet<AutopaySkipView>(endpoint, { redirectOnUnauthorized: false }).catch(() => null);
    if (result?.data) { setView(result.data); return result.data; }
    const link = result ? linkFailureOf(result) : null;
    if (link) setFailure(link); else setLoadError(true);
    return null;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [endpoint]);
  /** After a failed or refused skip: read the link again and show what is true now (R7). A
   * network failure here keeps the page as it is; the caller then says the skip failed. */
  const reread = async (): Promise<AutopaySkipView | 'link' | null> => {
    const result = await apiGet<AutopaySkipView>(endpoint, { redirectOnUnauthorized: false }).catch(() => null);
    if (result?.data) { setView(result.data); return result.data; }
    const link = result ? linkFailureOf(result) : null;
    if (link) { setFailure(link); return 'link'; }
    return null;
  };

  async function skip() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setRefused(false);
    const result = await apiPost<{ status?: 'skipped' | 'pending' }>(endpoint, {}, { redirectOnUnauthorized: false }).catch(() => null);
    if (result?.data?.status === 'skipped') setOutcome('skipped');
    else if (result?.data?.status === 'pending') setOutcome('pending');
    else if (result?.statusCode === 409 && result.code === 'COLLECTION_IN_PROGRESS') {
      // The code is shared: only details.reason 'payment_processing' means the money is
      // already with Stripe (#7983). Anything else is another change already pending:
      // re-read the link so an exclusion or stop that landed meanwhile is named (V-39).
      if (result.errorDetails?.reason === 'payment_processing') setOutcome('processing');
      else {
        const fresh = await reread();
        if (fresh !== 'link') setOutcome(!fresh || fresh.status === 'ready' ? 'changing' : null);
      }
    } else {
      // R7: a pause, stop, payment or void since the page loaded refuses the skip (404/409), and
      // a dropped connection proves nothing: re-read and show the current state.
      const fresh = await reread();
      if (fresh === 'link') { /* the link explains itself */ }
      else if (fresh && fresh.status !== 'ready') setOutcome(null);
      else setRefused(true);
    }
    inFlight.current = false; setBusy(false);
  }

  // V-20: the MSP's address appears once: in the card when emailing them is the next step.
  const shell = (panel: ReactElement, branding: { partnerName?: string | null; logoUrl?: string | null; supportEmail?: string | null } = {}, contactInCard = false) =>
    <AutopayShell partnerName={branding.partnerName} logoUrl={branding.logoUrl} supportEmail={branding.supportEmail} testId="autopay-skip-page" contactInCard={contactInCard}>{panel}</AutopayShell>;
  if (failure) return shell(<LinkStatePanel failure={failure} purpose="skip_invoice" />, failure, linkFailureContactInCard(failure, 'skip_invoice'));
  if (loadError) {
    return shell(<StatePanel title="We couldn't load this page" primary={{ label: 'Refresh', onClick: () => window.location.reload() }}>
      <p>Please refresh in a moment. Nothing about your payments has changed.</p>
    </StatePanel>);
  }
  if (!view) return shell(<p className="text-sm text-muted-foreground" aria-busy="true">Loading…</p>);

  const msp = view.partnerName || 'your service provider';
  const MSP = view.partnerName || 'Your service provider';
  const invoice = view.invoiceNumber ? `invoice ${view.invoiceNumber}` : 'this invoice';
  const due = view.dueDate ? longDate(view.dueDate) : null;
  const viewInvoice: PanelAction | null = view.invoiceUrl ? { label: 'View invoice', href: view.invoiceUrl, variant: 'link', testId: 'autopay-skip-view-invoice' } : null;
  const contact: PanelAction | null = view.supportEmail ? { label: `Email ${view.partnerName || 'them'}`, href: `mailto:${view.supportEmail}`, variant: 'link' } : null;
  const bank = view.methodType === 'us_bank_account';
  const owed = Number(view.balance) > 0 ? money(view.balance, view.currency) : null;
  const payInvoice: PanelAction | null = view.invoiceUrl ? { label: 'Pay invoice', href: view.invoiceUrl, testId: 'autopay-skip-pay-invoice' } : null;
  const pleasePay = owed ? `Please pay ${owed} from the invoice.` : 'Please pay it from the invoice.';
  // What's owed, without a schedule or method that won't be used (V-11).
  const owedSummary: SummaryRow[] = [
    ...(view.invoiceNumber ? [{ label: 'Invoice', value: view.invoiceNumber }] : []),
    ...(owed ? [{ label: 'Amount due', value: owed, figure: true }] : []),
  ];
  const summary: SummaryRow[] = [
    ...(view.invoiceNumber ? [{ label: 'Invoice', value: view.invoiceNumber }] : []),
    ...(view.amount ? [{ label: 'Amount', value: money(view.amount, view.currency), figure: true }] : []),
    ...(view.fee && Number(view.fee) > 0 ? [{ label: 'Fee', value: `up to ${money(view.fee, view.currency)}` }] : []),
    ...(view.collectOn ? [{ label: 'Scheduled for', value: longDate(view.collectOn) }] : []),
    ...(view.methodLabel ? [{ label: 'Payment method', value: view.methodLabel }] : []),
  ];

  // The server's status says what the page may offer; only 'ready' offers Skip. A paid
  // invoice is paid whatever else the link remembers (V-1).
  const paid = view.status === 'paid' || view.invoiceStatus === 'paid';
  // R4: a voided or settled invoice asks for nothing, whatever the schedule remembers.
  // (A 'not_needed' view already names its reason.)
  const closed = !paid && view.status !== 'not_needed' && (view.invoiceStatus === 'void' || !(Number(view.balance) > 0));
  const state = paid ? null : outcome ?? (view.status === 'skipped' ? 'skipped' : view.status === 'processing' ? 'processing'
    : view.status === 'pending' ? 'pending' : null);
  let panel: ReactElement;
  if (paid) {
    panel = <StatePanel mark={{ tone: 'success', label: 'Paid' }} title="This invoice is already paid" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null}>
      <p>Nothing more to do. Thank you.</p>
    </StatePanel>;
  } else if (closed && state !== 'processing' && state !== 'pending') {
    panel = notNeededPanel(view.invoiceStatus === 'void' ? 'void' : 'nothing_due', { MSP, msp, invoice, pleasePay, payInvoice, viewInvoice, contact, summary: owedSummary });
  } else if (state === 'skipped') {
    panel = <StatePanel mark={{ tone: 'neutral', label: 'Skipped' }} title="This payment is skipped" testId="autopay-skip-done"
      primary={view.invoiceUrl ? { label: 'Pay invoice now', href: view.invoiceUrl } : null}>
      <p>{`${MSP} won't charge ${invoice} automatically.${due ? ` Please pay it by ${due}.` : ' Please pay it from the invoice.'}`}</p>
    </StatePanel>;
  } else if (state === 'processing') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'Processing' }} title="This payment has already started" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null}>
      <p>{`The payment for ${invoice} has already been sent to Stripe and can't be skipped now.${bank ? ' Bank payments usually take a few business days to finish.' : ''} You'll get a receipt when it completes. If you think it's wrong, email ${msp}.`}</p>
    </StatePanel>;
  } else if (state === 'pending') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'In progress' }} title="We're trying to stop this payment" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null}>
      <p>{`A payment for ${invoice} had already started, so we've asked Stripe to cancel it. Check the invoice for the latest status.`}</p>
    </StatePanel>;
  } else if (state === 'changing') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'In progress' }} title="This payment is already being changed" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null}>
      <p>{`${MSP} is already changing how ${invoice} is paid. Check your email for an update, or contact ${msp}.`}</p>
    </StatePanel>;
  } else if (view.status === 'reversed') {
    panel = <StatePanel mark={{ tone: 'warning', label: 'Due again' }} title="This invoice is due again" primary={payInvoice} summary={owedSummary}>
      <p>{`The automatic payment for ${invoice} was refunded or reversed, so ${owed ?? 'the balance'} is due again. ${pleasePay}`}</p>
    </StatePanel>;
  } else if (view.status === 'action_required') {
    panel = <StatePanel mark={{ tone: 'warning', label: 'Confirmation needed' }} title="This payment needs your confirmation" primary={viewInvoice ? { ...viewInvoice, variant: 'primary' } : null}>
      <p>Your bank asked you to confirm this payment. Use the "Confirm payment" link in our latest email, or open the invoice to pay it yourself.</p>
    </StatePanel>;
  } else if (view.status !== 'ready') {
    panel = notNeededPanel(view.reason, { MSP, msp, invoice, pleasePay, payInvoice, viewInvoice, contact, summary: owedSummary });
  } else {
    panel = <div className="space-y-5">
      <StatePanel titleText={`Skip the automatic payment for ${invoice}?`}
        title={view.invoiceNumber ? <>Skip the automatic payment for invoice <Nowrap>{view.invoiceNumber}</Nowrap>?</> : 'Skip the automatic payment for this invoice?'}
        summary={summary} mark={{ tone: 'primary', label: 'Automatic payment' }}>
        <p>{`If you skip, ${msp} won't charge this invoice automatically. ${due ? `Please pay it yourself by its due date, ${due}.` : 'Please pay it yourself from the invoice.'} Your other automatic payments stay on.`}</p>
      </StatePanel>
      {view.onHold && (
        <Notice tone="neutral" title="Automatic payments are on hold" data-testid="autopay-skip-on-hold">
          <p>{`${MSP} has put automatic payments on hold for now, so this invoice won't be charged until they turn them back on. If you skip, it won't be charged when they do.`}</p>
        </Notice>
      )}
      {refused && <Notice tone="destructive" title="We couldn't skip this payment"><p>{`Please try again. If it keeps happening, email ${msp}.`}</p></Notice>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button type="button" className={cn(BTN_PRIMARY, BTN_BLOCK)}
          data-testid="autopay-skip-submit" disabled={busy} onClick={() => void skip()}>
          {busy ? 'Skipping…' : 'Skip this payment'}
        </button>
        {view.invoiceUrl && <a href={view.invoiceUrl} className={cn(LINK, "self-center text-sm")}>View invoice</a>}
      </div>
    </div>;
  }
  return shell(panel, view, (view.reason === 'void' && view.status === 'not_needed' || closed && view.invoiceStatus === 'void') && !!contact && !paid);
}

/** V-11: why there is nothing to skip, in the client's words, with what is owed. */
function notNeededPanel(reason: AutopaySkipView['reason'], c: { MSP: string; msp: string; invoice: string; pleasePay: string;
  payInvoice: PanelAction | null; viewInvoice: PanelAction | null; contact: PanelAction | null; summary: SummaryRow[] }): ReactElement {
  const owed = { primary: c.payInvoice, summary: c.summary };
  switch (reason) {
    case 'void':
      return <StatePanel title="This invoice was cancelled" primary={c.contact}>
        <p>{`${c.MSP} cancelled ${c.invoice}, so there's nothing to pay or skip.`}</p>
      </StatePanel>;
    case 'nothing_due':
      return <StatePanel title="Nothing is due on this invoice" primary={c.viewInvoice}>
        <p>{`${c.invoice[0]!.toUpperCase()}${c.invoice.slice(1)} has nothing left to pay, so there's no payment to skip.`}</p>
      </StatePanel>;
    case 'failed':
      return <StatePanel mark={{ tone: 'destructive', label: 'Not paid' }} title="The automatic payment didn't go through" {...owed}>
        <p>{`The automatic payment for ${c.invoice} didn't go through, so there's nothing to skip. ${c.pleasePay}`}</p>
      </StatePanel>;
    case 'stopped':
      return <StatePanel mark={{ tone: 'neutral', label: 'Off' }} title="Automatic payments are off" {...owed}>
        <p>{`Automatic payments to ${c.msp} are off, so ${c.invoice} won't be charged automatically. ${c.pleasePay}`}</p>
      </StatePanel>;
    case 'paused':
      return <StatePanel mark={{ tone: 'neutral', label: 'Paused' }} title="Automatic payments are paused" {...owed}>
        <p>{`${c.MSP} paused automatic payments, so ${c.invoice} won't be charged automatically for now. ${c.pleasePay}`}</p>
      </StatePanel>;
    case 'cancelled':
      // R2: this one payment was cancelled; automatic payments stay on for other invoices.
      return <StatePanel title="This automatic payment was cancelled" {...owed}>
        <p>{`The automatic payment for ${c.invoice} was cancelled, so there's nothing to skip. ${c.pleasePay}`}</p>
      </StatePanel>;
    case 'replaced':
      return <StatePanel title="This link was replaced" primary={c.viewInvoice}>
        <p>{`Your automatic payment details changed after this email was sent, so this link no longer controls the payment. Use the link in your most recent email from ${c.msp} about ${c.invoice}.`}</p>
      </StatePanel>;
    case 'not_included':
      return <StatePanel title="This invoice isn't paid automatically" {...owed}>
        <p>{`${c.invoice[0]!.toUpperCase()}${c.invoice.slice(1)} isn't included in your automatic payments, so there's nothing to skip. ${c.pleasePay}`}</p>
      </StatePanel>;
    case 'excluded':
      return <StatePanel title="This invoice won't be charged automatically" {...owed}>
        <p>{`${c.MSP} took ${c.invoice} out of automatic payments, so there's nothing to skip. ${c.pleasePay}`}</p>
      </StatePanel>;
    default:
      return <StatePanel title="This invoice won't be charged automatically" {...owed}>
        <p>{`There's no automatic payment to skip. ${c.pleasePay}`}</p>
      </StatePanel>;
  }
}
