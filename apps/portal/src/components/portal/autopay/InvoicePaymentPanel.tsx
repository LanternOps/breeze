import { paymentMethodInSentence } from '@breeze/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { CreditCard } from 'lucide-react';
import type { CustomerInvoiceAutopayStatus } from '@breeze/shared';
import type { ApiResponse, AutopayConfirmationRelease, BankAutopayOffer, InvoiceAutopayDisclosure } from '@/lib/api';
import { withBase } from '@/lib/basePath';
import { longDate, money } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BTN_BLOCK, BTN_PRIMARY, BTN_SECONDARY, LINK, Notice, StatusMark, type MarkTone } from '../ui';
import BankAutopayPayment from '../BankAutopayPayment';
import { AutopayConfirmationNotice } from '../AutopayConfirmationNotice';
import { AuthorizationBox } from './AuthorizationBox';
import { MethodChoice, type MethodOption } from './MethodChoice';
import { SummaryList } from './SummaryList';

type Option = 'card' | 'card_save' | 'bank';
type PayKind = 'pay' | 'pay_now_instead' | 'pay_now_primary' | 'none';
type StatusCopy = { mark?: { tone: MarkTone; label: string }; text: string; extra?: ReactNode; summary?: boolean; pay: PayKind; testId?: string };

export interface InvoicePaymentPanelProps {
  /** Portal (signed-in) pages may link to Payment methods. */
  portal?: boolean;
  currency: string; balance: string; dueDate: string | null; status: string; paidAt?: string | null;
  /** The invoice can be paid online now (server-payable, balance > 0, online payment available). */
  canPay: boolean;
  onlinePaymentUnavailable?: boolean;
  charge: { amount: string; isDeposit: boolean };
  autopayStatus?: CustomerInvoiceAutopayStatus | null;
  autopayEnrolled?: boolean;
  saveOffer?: InvoiceAutopayDisclosure | null;
  bankTarget: { invoiceId: string; publicToken?: string };
  bankOffer?: BankAutopayOffer | null;
  collectionInProgress?: { amount: string; actionRequired?: boolean } | null;
  partnerName?: string | null;
  paying: boolean;
  /** Start a card checkout; `save` = the client agreed to save the card. */
  onPay: (save: boolean) => void;
  payTestId: string; processingTestId: string;
  release: () => Promise<ApiResponse<AutopayConfirmationRelease>>;
  /** Re-read the invoice after a release; false when that failed. */
  reload?: () => Promise<boolean>;
  /** Payment errors, checkout-return and settle notices from the page. */
  notices?: ReactNode;
  /** Arrived from the emailed confirm link, which already canceled the automatic payment (FP-4). */
  releasedOnArrival?: boolean;
  download: ReactNode;
}

const NOT_INCLUDED: Record<string, string> = {
  enrolled_after_issue: 'This invoice was issued before you set up automatic payments, so please pay it here.',
  over_cap: 'This invoice is over your automatic payment limit, so please pay it here.',
  above_authorized_cap: 'This invoice is over the limit you authorized for automatic payments, so please pay it here.',
  // F-8: the newer authorization covers it, but it was issued before; it stays manual.
  issued_before_authorization: "This invoice was issued before your updated authorization, so it isn't paid automatically. Please pay it here.",
  cap_currency_mismatch: "This invoice's currency can't be paid automatically, so please pay it here.",
  ach_currency_unsupported: "This invoice's currency can't be paid automatically from a bank account, so please pay it here.",
};

const cents = (value: string | null | undefined) => Math.round(Number(value ?? 0) * 100);
const sum = (a: string | null | undefined, b: string | null | undefined) => ((cents(a) + cents(b)) / 100).toFixed(2);

function statusCopy(s: CustomerInvoiceAutopayStatus, msp: string, portal: boolean): StatusCopy | null {
  const method = s.methodLabel ? `your ${paymentMethodInSentence(s.methodLabel)}` : 'your saved payment method';
  const date = s.chargeDate ? longDate(s.chargeDate) : null;
  switch (s.state) {
    case 'scheduled':
      return { mark: { tone: 'primary', label: 'Automatic payment' }, summary: true, pay: s.canPayNow ? 'pay_now_instead' : 'none',
        text: date ? `This invoice will be paid automatically on ${date} with ${method}.` : `This invoice will be paid automatically with ${method}.` };
    case 'awaiting_notice':
      return { mark: { tone: 'primary', label: 'Automatic payment' }, pay: s.canPayNow ? 'pay_now_instead' : 'none',
        text: `This invoice will be paid automatically with ${method}. We'll email you the payment date first.` };
    case 'delayed':
      if (s.reason === 'pending_verification') {
        return { mark: { tone: 'warning', label: 'Verify your bank' }, pay: 'pay_now_instead',
          text: 'This invoice will be paid automatically once your bank account is verified. Stripe will email you instructions.' };
      }
      if (s.reason === 'on_hold') {
        return { mark: { tone: 'neutral', label: 'On hold' }, pay: 'pay_now_instead',
          text: `Automatic payment for this invoice is on hold at ${msp}. You can pay it now instead.` };
      }
      return { mark: { tone: 'warning', label: 'Needs attention' }, pay: 'pay',
        text: `We couldn't charge ${method.replace(/^your /, 'your saved ')}, so this invoice is waiting. Please pay it now so it doesn't become overdue.`,
        extra: portal ? <a className={cn(LINK, 'text-sm')} href={withBase('/payment-methods')}>Update your payment method</a>
          : <p className="text-sm text-muted-foreground">{`To keep automatic payments working, update your payment method with the link in your latest email from ${msp}.`}</p> };
    case 'retry_scheduled':
      return { mark: { tone: 'warning', label: "Payment didn't go through" }, pay: 'pay_now_primary',
        text: `The last attempt didn't go through. We'll try ${method} again${date ? ` on ${date}` : ''}, or you can pay now.` };
    case 'processing': {
      // V-5: the money actually moving (the API describes the in-flight attempt), fee included.
      const fee = cents(s.fee) > 0 ? s.fee : null;
      const moving = fee ? `${money(sum(s.amount, fee), s.currency)} is being collected from ${method} (${money(s.amount ?? '0', s.currency)} for this invoice plus a ${money(fee, s.currency)} fee).`
        : `${money(s.amount ?? '0', s.currency)} is being collected from ${method}.`;
      return { mark: { tone: 'primary', label: 'Processing' }, pay: 'none', testId: 'processing',
        text: `${moving}${s.methodType === 'us_bank_account' ? ' Bank payments usually take a few business days to clear.' : ''} No action needed.` };
    }
    case 'failed':
      return { mark: { tone: 'destructive', label: "Payment didn't go through" }, pay: 'pay', text: "Automatic payment didn't go through. Please pay this invoice below.",
        // FP-5: a client whose automatic payments are on is told how to keep them working.
        extra: !s.enrollmentActive ? undefined : portal ? <a className={cn(LINK, 'text-sm')} href={withBase('/payment-methods')}>Update your payment method</a>
          : <p className="text-sm text-muted-foreground">{`To keep automatic payments working, update your payment method with the link in your latest email from ${msp}.`}</p> };
    case 'reversed':
      // FP-6: refunded or returned after it succeeded: the invoice is due again.
      return { mark: { tone: 'warning', label: 'Due again' }, pay: 'pay',
        text: `The automatic payment for this invoice was refunded or returned, so ${money(s.amount ?? '0', s.currency)} is due again. Please pay it below.` };
    case 'skipped':
      return { mark: { tone: 'neutral', label: 'Skipped' }, pay: 'pay', text: 'You skipped the automatic payment for this invoice. Please pay it below.' };
    case 'not_included':
      return { pay: 'pay', text: s.reason?.startsWith('excluded') ? `${msp} asked for this invoice to be paid directly.`
        : NOT_INCLUDED[s.reason ?? ''] ?? 'This invoice is not paid automatically, so please pay it here.' };
    case 'unapplied':
      // F-9: the client was charged; the MSP applies it. No Pay.
      return { mark: { tone: 'primary', label: 'Payment received' }, pay: 'none',
        text: `We received a payment of ${money(s.amount ?? '0', s.currency)} for this invoice. ${msp} is applying it, so you don't need to pay again.` };
    case 'paid_by_bank':
      return { mark: { tone: 'success', label: 'Paid' }, pay: 'none',
        text: `Paid by bank${s.paidAt ? ` on ${longDate(s.paidAt)}` : ''}${s.methodLabel ? ` from your ${paymentMethodInSentence(s.methodLabel)}` : ''}. Thank you.` };
    case 'paid_automatically':
      return { mark: { tone: 'success', label: 'Paid' }, pay: 'none',
        text: `Paid automatically${s.paidAt ? ` on ${longDate(s.paidAt)}` : ''} with ${method}. Thank you.` };
    default:
      return null;
  }
}

/** The invoice pages' two-column grid: the paper, and the payment rail beside it at lg,
 *  wider at xl so a bank authorization isn't a 30-line column (V-14). */
export const INVOICE_GRID = 'lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start xl:grid-cols-[minmax(0,1fr)_24rem]'
  // FP-5 (V-14): the bank option's summary and full authorization need a wider rail, not a taller one.
  + ' lg:has-[[data-bank-chosen]]:grid-cols-[minmax(0,1fr)_26rem] xl:has-[[data-bank-chosen]]:grid-cols-[minmax(0,1fr)_30rem]';
/** The rail's grid item is what sticks (V-4): the aside inside it is only as tall as
 *  itself, so sticky on the aside never engaged. A rail taller than the viewport
 *  scrolls on its own, so Pay is always reachable. */
export const RAIL = 'lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1 lg:self-start lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto';

/**
 * The invoice pages' payment panel: the balance first, then how this invoice gets
 * paid. A client who isn't enrolled picks one way to pay; consent appears only for
 * the options that save a method. An enrolled client is told the date and method
 * of the automatic payment, with a quiet "Pay now instead" (D-4).
 */
export function InvoicePaymentPanel(p: InvoicePaymentPanelProps) {
  const msp = p.partnerName || 'your service provider';
  const [option, setOption] = useState<Option>('card');
  const [accepted, setAccepted] = useState(false);
  const [released, setReleased] = useState<null | 'ok' | 'reload_failed'>(p.releasedOnArrival ? 'ok' : null);
  // Fresh consent whenever the offered terms change.
  useEffect(() => { setAccepted(false); }, [p.saveOffer?.disclosureHash]);

  const s = p.autopayStatus ?? null;
  const inFlight = released ? null : p.collectionInProgress ?? null;
  const waitingOnBank = !released && (inFlight?.actionRequired === true || s?.state === 'action_required');
  const processing = !waitingOnBank && (!!inFlight || s?.state === 'processing');
  const copy = s && !waitingOnBank && !(released && s.state === 'action_required')
    // An in-flight amount without the API's processing status: the schedule's noticed fee is a
    // maximum, not what is moving, so don't print it as the fee.
    ? statusCopy(processing && s.state !== 'processing' ? { ...s, state: 'processing', amount: inFlight?.amount ?? s.amount, fee: null } : s, msp, !!p.portal)
    : processing && inFlight ? statusCopy({ state: 'processing', amount: inFlight.amount, currency: p.currency, chargeDate: null, fee: null,
      methodLabel: null, methodType: null, reason: null, paidAt: null, canPayNow: false }, msp, !!p.portal) : null;
  const pay: PayKind = !p.canPay ? 'none' : waitingOnBank || processing ? 'none' : copy?.pay ?? 'pay';
  const offers = pay === 'pay' && !p.autopayEnrolled;
  const saveAvailable = offers && !!p.saveOffer?.eligible;
  const bankAvailable = offers && !!p.bankOffer;
  const chosen: Option = (option === 'card_save' && !saveAvailable) || (option === 'bank' && !bankAvailable) ? 'card' : option;

  const amount = money(p.charge.amount, p.currency);
  const paid = p.status === 'paid';
  const overdue = p.status === 'overdue';
  const deposit = p.charge.isDeposit && !paid;
  // V-15: automatic payments are already on (this invoice has a live schedule), so saving
  // a method replaces it rather than turning automatic payments on.
  const autopayOn = !!s && (s.enrollmentActive ?? ['scheduled', 'awaiting_notice', 'delayed', 'retry_scheduled', 'skipped', 'not_included'].includes(s.state));
  const what = deposit ? 'the deposit' : 'this invoice';
  const bankPays = p.bankOffer && cents(p.bankOffer.principal) !== cents(p.charge.amount)
    ? `Pays the full balance of ${money(p.bankOffer.principal, p.bankOffer.currency)}` : 'Pays this invoice';
  const options: MethodOption<Option>[] = [
    { value: 'card', name: 'Card', detail: `Pay ${what} once.`, testId: 'autopay-option-card' },
    ...(saveAvailable ? [{ value: 'card_save' as const, name: 'Card, and save it for future invoices', testId: 'autopay-option-card_save',
      detail: `Pays ${what} now and ${autopayOn ? 'uses this card for your automatic payments from now on' : 'saves the card for automatic payments'}.` }] : []),
    ...(bankAvailable ? [{ value: 'bank' as const, name: 'Bank account', testId: 'autopay-option-bank',
      fee: Number(p.bankOffer!.fee) > 0 ? `${money(p.bankOffer!.fee, p.bankOffer!.currency)} fee` : 'No fee',
      detail: `${bankPays} and ${autopayOn ? 'uses this bank account for your automatic payments from now on' : 'turns on automatic payments for future invoices'}.` }] : []),
  ];
  const payLabel = pay === 'pay_now_instead' || pay === 'pay_now_primary' ? 'Pay now instead'
    : chosen === 'card_save' ? `Pay ${amount} and save card`
    : p.charge.isDeposit ? `Pay deposit ${amount}` : `Pay ${amount}`;
  const needsConsent = chosen === 'card_save';

  const onRelease = async () => {
    setReleased('ok');
    const ok = p.reload ? await p.reload().catch(() => false) : true;
    if (!ok) setReleased('reload_failed');
  };

  return (
    <aside aria-label="Payment" className="space-y-5 rounded-xl border border-border bg-card p-5 sm:p-6" data-testid="invoice-payment-panel"
      data-bank-chosen={chosen === 'bank' && pay !== 'none' ? 'true' : undefined}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{paid ? 'Balance' : deposit ? 'Deposit due' : 'Balance due'}</p>
        <p className="mt-1 font-display text-[1.75rem] font-semibold leading-tight text-figures text-foreground" data-testid="invoice-panel-amount">
          {money(deposit ? p.charge.amount : p.balance, p.currency)}
        </p>
        {/* V-13: the headline is what the button charges; the balance stays in view. */}
        {deposit && <p className="mt-1 text-sm text-muted-foreground">{`of ${money(p.balance, p.currency)} balance due`}</p>}
        {!paid && p.dueDate && (
          <p className={cn('mt-1 text-sm', overdue ? 'font-medium text-destructive-on-tint' : 'text-muted-foreground')}>
            {overdue ? `Was due ${longDate(p.dueDate)}` : `Due ${longDate(p.dueDate)}`}
          </p>
        )}
      </div>
      {p.notices}
      {released && (
        <Notice tone="primary" title="The automatic payment was canceled." data-testid="autopay-confirmation-released">
          <p>Pay below. Your bank will ask you to confirm the payment.</p>
          {released === 'reload_failed' && <p>We couldn't refresh the invoice. Refresh the page if anything looks out of date.</p>}
        </Notice>
      )}
      {waitingOnBank && p.canPay && (
        <AutopayConfirmationNotice amount={inFlight?.amount ?? s?.amount ?? p.charge.amount} fee={s?.fee ?? null} currency={p.currency}
          release={p.release} onReleased={onRelease} />
      )}
      {copy && (
        <div className="space-y-3" role="status" data-testid={copy.testId === 'processing' ? p.processingTestId : 'invoice-autopay-status'}>
          {copy.mark && <StatusMark tone={copy.mark.tone}>{copy.mark.label}</StatusMark>}
          <p className="text-sm leading-relaxed text-foreground">{copy.text}</p>
          {/* V-28: the balance is already above; state the fee and what will actually be charged. */}
          {copy.summary && s && cents(s.fee) > 0 && (
            <SummaryList rows={[{ label: 'Processing fee', value: `up to ${money(s.fee!, s.currency)}` },
              { label: 'Total charged', value: `up to ${money(sum(s.amount ?? p.balance, s.fee), s.currency)}`, figure: true }]} />
          )}
          {copy.extra}
        </div>
      )}
      {!p.canPay && p.onlinePaymentUnavailable && !paid && (
        <p className="text-sm text-muted-foreground">{`Online payment isn't available for this invoice. Please contact ${msp} to pay.`}</p>
      )}
      {pay !== 'none' && (
        <div className="space-y-4">
          {options.length > 1 && offers && (
            <MethodChoice legend="How would you like to pay?" name="invoice-pay-option" options={options} value={chosen}
              onChange={next => { setOption(next); setAccepted(false); }} disabled={p.paying} />
          )}
          {chosen === 'bank' ? (
            <BankAutopayPayment target={p.bankTarget} offer={p.bankOffer} partnerName={p.partnerName} />
          ) : (
            <>
              {needsConsent && p.saveOffer && (
                <AuthorizationBox id="autopay-save" text={p.saveOffer.consentText} checked={accepted} onChange={setAccepted} disabled={p.paying}
                  testIds={{ text: 'autopay-save-card-text', checkbox: 'autopay-save-card' }} />
              )}
              <button type="button" data-testid={p.payTestId} disabled={p.paying || (needsConsent && !accepted)}
                onClick={() => p.onPay(needsConsent && accepted)}
                className={cn(pay === 'pay_now_instead' ? BTN_SECONDARY : BTN_PRIMARY, 'w-full')}>
                <CreditCard className="h-4 w-4" aria-hidden="true" />
                {p.paying ? 'Opening secure checkout…' : payLabel}
              </button>
              {needsConsent && !accepted && <p className="text-sm text-muted-foreground">Tick the box above to continue.</p>}
              <p className="text-xs text-muted-foreground">Secure payment by Stripe.</p>
            </>
          )}
        </div>
      )}
      <div className={cn('pt-1', BTN_BLOCK)}>{p.download}</div>
    </aside>
  );
}

export default InvoicePaymentPanel;
