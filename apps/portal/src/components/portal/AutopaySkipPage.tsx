import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AutopaySkipView } from '@breeze/shared';
import { apiGet, apiPost } from '@/lib/api';
import { longDate, money } from '@/lib/format';
import { linkFailureOf } from '@/lib/autopay';
import { cn } from '@/lib/utils';
import { BTN_BLOCK, BTN_PRIMARY, LINK, Notice } from './ui';
import { AutopayShell } from './autopay/AutopayShell';
import { StatePanel, type PanelAction } from './autopay/StatePanel';
import { LinkStatePanel, type LinkFailureView } from './autopay/LinkStatePanel';
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

  async function skip() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setRefused(false);
    const result = await apiPost<{ status?: 'skipped' | 'pending' }>(endpoint, {}, { redirectOnUnauthorized: false }).catch(() => null);
    if (result?.data?.status === 'skipped') setOutcome('skipped');
    else if (result?.data?.status === 'pending') setOutcome('pending');
    else if (result?.statusCode === 409 && result.code === 'COLLECTION_IN_PROGRESS') {
      // The code is shared: only details.reason 'payment_processing' means the money is
      // already with Stripe (#7983). Anything else is another change already pending.
      setOutcome(result.errorDetails?.reason === 'payment_processing' ? 'processing' : 'changing');
    } else setRefused(true);
    inFlight.current = false; setBusy(false);
  }

  const shell = (panel: ReactElement, branding: { partnerName?: string | null; logoUrl?: string | null; supportEmail?: string | null } = {}) =>
    <AutopayShell partnerName={branding.partnerName} logoUrl={branding.logoUrl} supportEmail={branding.supportEmail} testId="autopay-skip-page">{panel}</AutopayShell>;
  if (failure) return shell(<LinkStatePanel failure={failure} purpose="skip_invoice" />, failure);
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
  const summary: SummaryRow[] = [
    ...(view.invoiceNumber ? [{ label: 'Invoice', value: view.invoiceNumber }] : []),
    ...(view.amount ? [{ label: 'Amount', value: money(view.amount, view.currency), figure: true }] : []),
    ...(view.fee && Number(view.fee) > 0 ? [{ label: 'Fee', value: `up to ${money(view.fee, view.currency)}` }] : []),
    ...(view.collectOn ? [{ label: 'Scheduled for', value: longDate(view.collectOn) }] : []),
    ...(view.methodLabel ? [{ label: 'Payment method', value: view.methodLabel }] : []),
  ];

  // The server's status says what the page may offer; only 'ready' offers Skip.
  const state = outcome ?? (view.status === 'skipped' ? 'skipped' : view.status === 'processing' ? 'processing'
    : view.status === 'pending' ? 'pending' : null);
  let panel: ReactElement;
  if (state === 'skipped') {
    panel = <StatePanel mark={{ tone: 'neutral', label: 'Skipped' }} title="This payment is skipped" testId="autopay-skip-done"
      primary={view.invoiceUrl ? { label: 'Pay invoice now', href: view.invoiceUrl } : null}>
      <p>{`${MSP} won't charge ${invoice} automatically.${due ? ` Please pay it by ${due}.` : ' Please pay it from the invoice.'}`}</p>
    </StatePanel>;
  } else if (state === 'processing') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'Processing' }} title="This payment has already started" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null} secondary={contact}>
      <p>{`The payment for ${invoice} has already been sent to Stripe and can't be skipped now.${bank ? ' Bank payments usually take a few business days to finish.' : ''} You'll get a receipt when it completes. If you think it's wrong, email ${msp}.`}</p>
    </StatePanel>;
  } else if (state === 'pending') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'In progress' }} title="We're trying to stop this payment" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null}>
      <p>{`A payment for ${invoice} had already started, so we've asked Stripe to cancel it. Check the invoice for the latest status.`}</p>
    </StatePanel>;
  } else if (state === 'changing') {
    panel = <StatePanel mark={{ tone: 'primary', label: 'In progress' }} title="This payment is already being changed" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null} secondary={contact}>
      <p>{`Check your email for an update, or contact ${msp}.`}</p>
    </StatePanel>;
  } else if (view.status === 'paid') {
    panel = <StatePanel mark={{ tone: 'success', label: 'Paid' }} title="This invoice is already paid" primary={viewInvoice ? { ...viewInvoice, variant: 'secondary' } : null}>
      <p>Nothing more to do. Thank you.</p>
    </StatePanel>;
  } else if (view.status === 'action_required') {
    panel = <StatePanel mark={{ tone: 'warning', label: 'Confirmation needed' }} title="This payment needs your confirmation" primary={viewInvoice ? { ...viewInvoice, variant: 'primary' } : null}>
      <p>Your bank asked you to confirm this payment. Use the "Confirm payment" link in our latest email, or open the invoice to pay it yourself.</p>
    </StatePanel>;
  } else if (view.status !== 'ready') {
    panel = <StatePanel title="This invoice won't be charged automatically" primary={viewInvoice ? { ...viewInvoice, variant: 'primary' } : null} summary={summary}>
      <p>{`There's no automatic payment to skip. Please pay ${invoice} from the invoice page.`}</p>
    </StatePanel>;
  } else {
    panel = <div className="space-y-5">
      <StatePanel title={`Skip the automatic payment for ${invoice}?`} summary={summary} mark={{ tone: 'primary', label: 'Automatic payment' }}>
        <p>{`If you skip, ${msp} won't charge this invoice automatically. ${due ? `Please pay it yourself by its due date, ${due}.` : 'Please pay it yourself from the invoice.'} Your other automatic payments stay on.`}</p>
      </StatePanel>
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
  return shell(panel, view);
}
