import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import {
  type InvoiceDetail as InvoiceDetailData,
  type InvoiceLine,
  type InvoicePayment,
  type PaymentMethod,
  PAYMENT_METHOD_LABELS,
  STATUS_ROLES,
  formatDate,
  formatMoney,
  lineTaxAmount,
  lineTitle,
  lineBlurb,
  pctFromFraction,
  sellerLines,
  computeInvoiceProfit,
} from './invoiceTypes';
import { StatusPill } from './shared/StatusPill';
import InvoiceActions from './InvoiceActions';
import { MarginPanel } from './billingUi';
import { computeChargeNow } from '@breeze/shared';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: InvoiceDetailData;
  onChanged: () => void;
  /** The workspace header owns the primary actions (Issue / Issue & Send /
   *  Download PDF / Delete draft) — suppress the rail copy so the two don't
   *  render at once (mirrors QuoteDetail.actionsInHeader). */
  actionsInHeader?: boolean;
}

export default function InvoiceDetail({ detail, onChanged, actionsInHeader = false }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;
  const invoiceStatusLabel = invoice.status === 'sent' && !invoice.sentAt
    ? t('invoice.status.issued')
    : t(/* i18n-dynamic */ `invoice.status.${invoice.status}`);
  const stripeConnected = detail.stripeConnected === true;

  const [accountingView, setAccountingView] = useState(false);
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [paymentsError, setPaymentsError] = useState(false);
  const [busy, setBusy] = useState(false);

  // Payment form
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('bank_transfer');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Payment confirm dialog
  const [payConfirmOpen, setPayConfirmOpen] = useState(false);
  // Reverse-a-payment confirm: reversing is a financial mutation, so it goes
  // through a confirm step that names the specific payment.
  const [reversePayment, setReversePayment] = useState<InvoicePayment | null>(null);
  // Void dialog
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidReissue, setVoidReissue] = useState(false);

  // Inline due-date editor (issued invoices only). Opens with the current due date;
  // Save PATCHes /invoices/:id/due-date.
  const [dueDateEditing, setDueDateEditing] = useState(false);
  const [dueDateDraft, setDueDateDraft] = useState(invoice.dueDate ?? '');
  useEffect(() => { setDueDateDraft(invoice.dueDate ?? ''); }, [invoice.dueDate]);

  const loadPayments = useCallback(async () => {
    const res = await fetchWithAuth(`/invoices/${invoice.id}/payments`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) {
      // An operator must NOT read "No payments recorded" when the fetch actually
      // failed — surface a visible error (with inline retry) and a toast.
      setPaymentsError(true);
      handleActionError(new Error(res.statusText), t('invoiceDetail.payments.loadFailed'));
      return;
    }
    setPaymentsError(false);
    const body = (await res.json()) as { data: InvoicePayment[] };
    setPayments(body.data ?? []);
  }, [invoice.id, t]);

  useEffect(() => { void loadPayments(); }, [loadPayments]);

  const refresh = useCallback(() => { onChanged(); void loadPayments(); }, [onChanged, loadPayments]);

  // In customer view, hide cost/margin columns and hidden bundle children.
  const visibleLines = useMemo(
    () => (accountingView ? lines : lines.filter((l) => l.customerVisible)),
    [accountingView, lines],
  );

  // Cost/margin is an internal read affordance, visible to anyone who can read
  // the invoice (the same read-level gate the quote rails use for `quotes:read`;
  // cost is a read affordance, not a write one). Independent of the per-line
  // Accounting view toggle below, which defaults off. Uses the shared cents math
  // so the figure is rounded + labelled identically to a quote's.
  const canSeeMargin = can('invoices', 'read');
  const profit = useMemo(() => computeInvoiceProfit(lines), [lines]);

  const lineMargin = (l: InvoiceLine): string => {
    if (l.costBasis == null) return '—';
    const revenue = Number(l.revenueAllocation ?? l.lineTotal);
    const cost = Number(l.costBasis) * Number(l.quantity);
    return formatMoney(revenue - cost, currency);
  };

  // Per-line Tax column appears only when this invoice carries tax (mirrors the
  // header Tax row), otherwise it'd be a column of dashes.
  const showTax = Number(invoice.taxTotal) > 0;

  // Payments only attach to a live invoice: a draft has no number and isn't owed
  // yet, so taking money against it would book a payment to an invoice that was
  // never issued. Gate on a non-draft, unpaid, still-owing status.
  const canRecordPayment =
    invoice.status !== 'draft' && invoice.status !== 'void' && invoice.status !== 'paid' && Number(invoice.balance) > 0;
  const canVoid = invoice.status !== 'void' && invoice.status !== 'draft';

  // Deposit-aware charge amount — matches what the server's pay route charges
  // (computeChargeNow, the single source of truth), so the deposit strip never
  // advertises a figure different from the actual charge. `depositDue` null = no deposit.
  const hasDeposit = invoice.depositDue != null;
  const chargeNow = computeChargeNow({
    depositDue: invoice.depositDue ?? null,
    amountPaid: invoice.amountPaid,
    balance: invoice.balance,
  });

  // The due date is editable once the invoice is live (issued/partially paid/overdue);
  // the /due-date route is gated on invoices:write.
  const canEditDueDate =
    can('invoices', 'write') && ['sent', 'partially_paid', 'overdue'].includes(invoice.status);

  // Re-sending an issued, part-paid invoice reads as "request payment" rather than
  // "send" — same POST /send call. Gate on a live, still-owing invoice + invoices:send.
  const partiallyPaid = Number(invoice.amountPaid) > 0 && Number(invoice.balance) > 0;
  const canRequestPayment =
    can('invoices', 'send') &&
    invoice.status !== 'draft' && invoice.status !== 'void' && invoice.status !== 'paid' &&
    Number(invoice.balance) > 0;

  const saveDueDate = useCallback(async () => {
    if (busy || !dueDateDraft) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/due-date`, {
          method: 'PATCH', body: JSON.stringify({ dueDate: dueDateDraft }),
        }),
        errorFallback: t('invoiceDetail.dueDate.updateError'),
        successMessage: t('invoiceDetail.dueDate.updateSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setDueDateEditing(false);
      refresh();
    } catch (err) {
      handleActionError(err, t('invoiceDetail.dueDate.updateError'));
    } finally {
      setBusy(false);
    }
  }, [busy, dueDateDraft, invoice.id, refresh, t]);

  const requestPayment = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // /send is honest about whether an email actually went out — only claim it
      // was sent when the API confirms an email was dispatched.
      const result = await runAction<{ data: { emailed: boolean } }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/send`, { method: 'POST' }),
        errorFallback: t('invoiceDetail.requestPayment.sendError'),
        onUnauthorized: UNAUTHORIZED,
      });
      if (result?.data?.emailed) {
        showToast({ type: 'success', message: partiallyPaid ? t('invoiceDetail.requestPayment.paymentRequestSent') : t('invoiceDetail.requestPayment.invoiceSent') });
      } else {
        showToast({ type: 'warning', message: t('invoiceDetail.requestPayment.noEmailWarning') });
      }
      refresh();
    } catch (err) {
      handleActionError(err, t('invoiceDetail.requestPayment.sendError'));
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, partiallyPaid, refresh, t]);

  const recordPayment = useCallback(async () => {
    if (busy || !payAmount) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/payments`, {
          method: 'POST',
          body: JSON.stringify({
            amount: Number(payAmount),
            method: payMethod,
            reference: payRef || undefined,
            receivedAt: payDate,
          }),
        }),
        errorFallback: t('invoiceDetail.payments.recordError'),
        successMessage: t('invoiceDetail.payments.recordSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setPayAmount(''); setPayRef('');
      refresh();
    } catch (err) {
      handleActionError(err, t('invoiceDetail.payments.recordError'));
    } finally {
      setBusy(false);
    }
  }, [busy, payAmount, payMethod, payRef, payDate, invoice.id, refresh, t]);

  const sendPayLink = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await runAction<{ data: { url: string } }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/pay-link`, { method: 'POST' }),
        errorFallback: t('invoiceDetail.payments.linkError'),
        friendly: (code) => (code === 'STRIPE_NOT_CONNECTED' ? t('invoiceDetail.payments.connectStripe') : undefined),
        onUnauthorized: UNAUTHORIZED,
      });
      const url = result?.data?.url;
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          showToast({ type: 'success', message: t('invoiceDetail.payments.linkCopied') });
        } catch {
          // Clipboard blocked (insecure context / permissions) — surface the URL.
          window.prompt(t('invoiceDetail.payments.shareLinkPrompt'), url);
        }
      } else {
        // 200 without a URL shouldn't happen (the API throws STRIPE_NO_URL), but
        // never leave a money action with no feedback.
        showToast({ type: 'error', message: t('invoiceDetail.payments.noLinkReturned') });
      }
    } catch (err) {
      handleActionError(err, t('invoiceDetail.payments.linkError'));
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, t]);

  const voidPayment = useCallback(async (paymentId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/payments/${paymentId}`, { method: 'DELETE' }),
        errorFallback: t('invoiceDetail.payments.reverseError'),
        successMessage: t('invoiceDetail.payments.reverseSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setReversePayment(null);
      refresh();
    } catch (err) {
      handleActionError(err, t('invoiceDetail.payments.reverseError'));
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, refresh, t]);

  const submitVoid = useCallback(async () => {
    if (busy || !voidReason.trim()) return;
    setBusy(true);
    try {
      const result = await runAction<{ data: { invoice: { id: string } } }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/void`, {
          method: 'POST',
          body: JSON.stringify({ reason: voidReason.trim(), reissue: voidReissue }),
        }),
        errorFallback: t('invoiceDetail.void.error'),
        successMessage: voidReissue ? t('invoiceDetail.void.reissuedSuccess') : t('invoiceDetail.void.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      setVoidOpen(false);
      const newId = result?.data?.invoice?.id;
      if (voidReissue && newId && newId !== invoice.id) {
        void navigateTo(`/billing/invoices/${newId}`);
      } else {
        refresh();
      }
    } catch (err) {
      handleActionError(err, t('invoiceDetail.void.error'));
    } finally {
      setBusy(false);
    }
  }, [busy, voidReason, voidReissue, invoice.id, refresh, t]);

  return (
    <div className="space-y-6" data-testid="invoice-detail">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Lines + accounting toggle */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox" checked={accountingView}
                onChange={(e) => setAccountingView(e.target.checked)}
                data-testid="invoice-accounting-toggle"
              />
              {t('invoiceDetail.accountingView')}
            </label>
          </div>
          <div className="rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm" data-testid="invoice-detail-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t('invoiceDetail.lines.description')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceDetail.lines.qty')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceDetail.lines.price')}</th>
                  {accountingView && <th className="px-3 py-2 text-right font-medium">{t('invoiceDetail.lines.cost')}</th>}
                  {accountingView && <th className="px-3 py-2 text-right font-medium">{t('invoiceDetail.lines.margin')}</th>}
                  {showTax && <th className="px-3 py-2 text-right font-medium">{t('invoiceDetail.lines.tax')}</th>}
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceDetail.lines.total')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLines.map((l) => {
                  const tax = showTax ? lineTaxAmount(l.lineTotal, l.taxable, invoice.taxRate) : null;
                  return (
                  <tr
                    key={l.id}
                    data-testid={`invoice-detail-line-${l.id}`}
                    className={`border-t ${l.parentLineId ? 'bg-muted/20 text-xs text-muted-foreground' : ''}`}
                  >
                    <td className={`px-3 py-2 ${l.parentLineId ? 'pl-8' : ''}`}>
                      <span className={l.parentLineId ? '' : 'font-medium text-foreground'}>
                        {l.parentLineId ? <span aria-hidden="true">↳ </span> : ''}{lineTitle(l)}
                      </span>
                      {accountingView && !l.customerVisible ? t('invoiceDetail.lines.hiddenMarker') : ''}
                      {lineBlurb(l) && <div className="text-xs text-muted-foreground">{lineBlurb(l)}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">{l.quantity}</td>
                    <td className="px-3 py-2 text-right">{formatMoney(l.unitPrice, currency)}</td>
                    {accountingView && <td className="px-3 py-2 text-right">{l.costBasis == null ? '—' : formatMoney(l.costBasis, currency)}</td>}
                    {accountingView && <td className="px-3 py-2 text-right">{lineMargin(l)}</td>}
                    {showTax && <td className="px-3 py-2 text-right text-muted-foreground">{tax === null ? '—' : formatMoney(tax, currency)}</td>}
                    <td className="px-3 py-2 text-right">{formatMoney(l.lineTotal, currency)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right rail: summary + payments + actions */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-detail-summary">
            <div className="mb-3 flex items-center justify-between">
              <StatusPill
                role={STATUS_ROLES[invoice.status].role}
                label={invoiceStatusLabel}
                className={STATUS_ROLES[invoice.status].className}
                testId="invoice-detail-status"
              />
              {canEditDueDate ? (
                dueDateEditing ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="date"
                      value={dueDateDraft}
                      onChange={(e) => setDueDateDraft(e.target.value)}
                      disabled={busy}
                      aria-label={t('invoiceDetail.dueDate.aria')}
                      data-testid="invoice-due-date-input"
                      className="h-7 rounded-md border bg-background px-1.5 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                    />
                    <button
                      type="button" onClick={() => void saveDueDate()} disabled={busy || !dueDateDraft}
                      data-testid="invoice-due-date-save"
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t('common:actions.save')}
                    </button>
                    <button
                      type="button" onClick={() => { setDueDateDraft(invoice.dueDate ?? ''); setDueDateEditing(false); }} disabled={busy}
                      data-testid="invoice-due-date-cancel"
                      className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t('common:actions.cancel')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDueDateEditing(true)}
                    data-testid="invoice-due-date-edit"
                    className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    {t('invoiceDetail.dueDate.display', { date: formatDate(invoice.dueDate) })}
                  </button>
                )
              ) : (
                <span className="text-xs text-muted-foreground">{t('invoiceDetail.dueDate.display', { date: formatDate(invoice.dueDate) })}</span>
              )}
            </div>
            <dl className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('invoiceDetail.summary.subtotal')}</dt><dd>{formatMoney(invoice.subtotal, currency)}</dd></div>
              {showTax && (
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('invoiceDetail.summary.tax')}{invoice.taxRate ? ` (${pctFromFraction(invoice.taxRate)}%)` : ''}</dt><dd>{formatMoney(invoice.taxTotal, currency)}</dd></div>
              )}
              <div className="flex min-w-0 justify-between gap-2 font-semibold"><dt>{t('invoiceDetail.summary.total')}</dt><dd className="break-words">{formatMoney(invoice.total, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('invoiceDetail.summary.paid')}</dt><dd>{formatMoney(invoice.amountPaid, currency)}</dd></div>
            </dl>
            {/* Balance-due focal number */}
            <div className="mt-3 flex min-w-0 items-end justify-between gap-2 border-t pt-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('invoiceDetail.summary.balanceDue')}</span>
              <span
                className={`break-words text-2xl font-semibold tabular-nums ${Number(invoice.balance) > 0 && invoice.status !== 'void' ? '' : 'text-muted-foreground'}`}
                data-testid="invoice-detail-balance"
              >
                {formatMoney(invoice.balance, currency)}
              </span>
            </div>
            {/* Deposit strip — mirrors the customer portal so the operator sees the
                same deposit-first framing the customer's Pay button uses. */}
            {hasDeposit && (
              <div className="mt-3 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="invoice-deposit-strip">
                {chargeNow.isDeposit ? (
                  <>{t('invoiceDetail.deposit.duePrefix')} <strong className="text-foreground">{formatMoney(invoice.depositDue!, currency)}</strong> {t('invoiceDetail.deposit.dueSuffix', { paid: formatMoney(invoice.amountPaid, currency), total: formatMoney(invoice.total, currency) })}</>
                ) : (
                  <>{t('invoiceDetail.deposit.paid', { balance: formatMoney(invoice.balance, currency) })}</>
                )}
              </div>
            )}
            {/* Internal margin summary — profitability stays visible after the
                invoice is issued and the Editor tab disappears (same reason
                QuoteDetail renders it). Never reaches the customer document. */}
            {canSeeMargin && <MarginPanel profit={profit} currency={currency} idPrefix="invoice" />}
          </div>

          {/* Seller From block */}
          {invoice.sellerSnapshot && (
            <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-detail-from">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceDetail.from')}</h3>
              <div className="space-y-0.5 text-sm">
                {invoice.sellerSnapshot.name && (
                  <p className="font-medium" data-testid="invoice-detail-from-name">{invoice.sellerSnapshot.name}</p>
                )}
                {sellerLines(invoice.sellerSnapshot.address).map((line, i) => (
                  <p key={i} className="text-muted-foreground">{line}</p>
                ))}
                {invoice.sellerSnapshot.phone && (
                  <p className="text-muted-foreground" data-testid="invoice-detail-from-phone">{invoice.sellerSnapshot.phone}</p>
                )}
                {invoice.sellerSnapshot.email && (
                  <p className="text-muted-foreground" data-testid="invoice-detail-from-email">{invoice.sellerSnapshot.email}</p>
                )}
                {invoice.sellerSnapshot.website && (
                  <p className="text-muted-foreground" data-testid="invoice-detail-from-website">{invoice.sellerSnapshot.website}</p>
                )}
              </div>
            </div>
          )}

          {/* Terms & Conditions */}
          {invoice.termsAndConditions && (
            <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-detail-terms">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceDetail.terms')}</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{invoice.termsAndConditions}</p>
            </div>
          )}

          {/* Primary actions (Issue / PDF / Delete) + void. The rail copy of
              InvoiceActions is suppressed when the workspace header owns the
              actions; Void stays here — its written-reason dialog belongs with
              the issued-lifecycle rail, not the header. */}
          <div className="space-y-2">
            {!actionsInHeader && <InvoiceActions detail={detail} onChanged={onChanged} variant="rail" />}
            {/* Re-send the issued invoice. Reads as "Request payment" once the
                customer has partially paid (same POST /send call). */}
            {canRequestPayment && (
              <button
                type="button" onClick={() => void requestPayment()} disabled={busy}
                data-testid="invoice-request-payment"
                className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {partiallyPaid ? t('invoiceDetail.requestPayment.requestPayment') : t('invoiceDetail.requestPayment.sendInvoice')}
              </button>
            )}
            {canVoid && can('invoices', 'send') && (
              <button
                type="button" onClick={() => { setVoidReason(''); setVoidReissue(false); setVoidOpen(true); }}
                data-testid="invoice-void-open"
                className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
              >
                {t('invoiceDetail.void.button')}
              </button>
            )}
          </div>

          {/* Payments */}
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-payments">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceDetail.payments.title')}</h3>
            {paymentsError ? (
              <p className="text-sm text-destructive" data-testid="invoice-payments-error">
                {t('invoiceDetail.payments.loadFailed')}{' '}
                <button type="button" onClick={() => void loadPayments()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
              </p>
            ) : payments.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="invoice-payments-empty">{t('invoiceDetail.payments.empty')}</p>
            ) : (
              <ul className="divide-y text-sm">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2" data-testid={`invoice-payment-${p.id}`}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="tabular-nums">{formatMoney(p.amount, currency)}</span>
                      <span className="text-muted-foreground">· {t(/* i18n-dynamic */ `invoiceDetail.paymentMethods.${p.method}`)} · {formatDate(p.receivedAt)}</span>
                      {p.source === 'stripe' && (
                        <span
                          className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                          data-testid={`invoice-payment-online-${p.id}`}
                        >
                          {t('invoiceDetail.payments.online')}
                        </span>
                      )}
                    </span>
                    {/* Stripe payments are refunded through Stripe, never hand-voided. */}
                    {p.source === 'stripe' ? (
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">{t('invoiceDetail.payments.viaStripe')}</span>
                    ) : can('invoices', 'send') ? (
                      <button
                        type="button" onClick={() => setReversePayment(p)} disabled={busy || invoice.status === 'void'}
                        aria-label={t('invoiceDetail.payments.reverseAria', { amount: formatMoney(p.amount, currency) })}
                        data-testid={`invoice-payment-void-${p.id}`}
                        className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        {t('invoiceDetail.payments.reverse')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {invoice.status === 'draft' && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="invoice-payments-draft-hint">
                {t('invoiceDetail.payments.draftHint')}
              </p>
            )}

            {canRecordPayment && stripeConnected && can('invoices', 'send') && (
              <button
                type="button" onClick={() => void sendPayLink()} disabled={busy}
                data-testid="invoice-pay-link"
                className="mt-3 inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {t('invoiceDetail.payments.sendLink')}
              </button>
            )}
            {canRecordPayment && !stripeConnected && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="invoice-stripe-nudge">
                {t('invoiceDetail.payments.stripeNudge')}{' '}
                <a href="/settings/billing" className="underline hover:text-foreground">{t('invoiceDetail.payments.setUp')}</a>
              </p>
            )}

            {canRecordPayment && can('invoices', 'send') && (
              <div className="mt-3 space-y-2 border-t pt-3" data-testid="invoice-payment-form">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number" min="0" step="0.01" placeholder={t('invoiceDetail.payments.amount')} value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    aria-label={t('invoiceDetail.payments.amount')}
                    data-testid="invoice-payment-amount"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <select
                    value={payMethod} onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                    aria-label={t('invoiceDetail.payments.method')}
                    data-testid="invoice-payment-method"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
                      <option key={m} value={m}>{t(/* i18n-dynamic */ `invoiceDetail.paymentMethods.${m}`)}</option>
                    ))}
                  </select>
                  <input
                    type="text" placeholder={t('invoiceDetail.payments.referencePlaceholder')} value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                    aria-label={t('invoiceDetail.payments.reference')}
                    data-testid="invoice-payment-ref"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <input
                    type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)}
                    aria-label={t('invoiceDetail.payments.date')}
                    data-testid="invoice-payment-date"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <button
                  type="button" onClick={() => setPayConfirmOpen(true)} disabled={busy || !payAmount}
                  title={!payAmount ? t('invoiceDetail.payments.amountRequired') : undefined}
                  aria-describedby={!payAmount ? 'invoice-payment-submit-hint' : undefined}
                  data-testid="invoice-payment-submit"
                  className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('invoiceDetail.payments.record')}
                </button>
                <span id="invoice-payment-submit-hint" className="sr-only">
                  {t('invoiceDetail.payments.amountRequired')}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Reverse-a-payment confirm dialog */}
      <ConfirmDialog
        open={reversePayment !== null}
        onClose={() => setReversePayment(null)}
        onConfirm={() => { if (reversePayment) void voidPayment(reversePayment.id); }}
        isLoading={busy}
        title={t('invoiceDetail.payments.reverseConfirm.title')}
        message={reversePayment ? t('invoiceDetail.payments.reverseConfirm.message', {
          amount: formatMoney(reversePayment.amount, currency),
          method: t(/* i18n-dynamic */ `invoiceDetail.paymentMethods.${reversePayment.method}`),
        }) : ''}
        confirmLabel={t('invoiceDetail.payments.reverseConfirm.label')}
        confirmTestId="invoice-payment-reverse-confirm"
      />

      {/* Record payment confirm dialog */}
      <ConfirmDialog
        open={payConfirmOpen}
        onClose={() => setPayConfirmOpen(false)}
        onConfirm={() => { setPayConfirmOpen(false); void recordPayment(); }}
        isLoading={busy}
        variant="warning"
        title={t('invoiceDetail.payments.recordConfirm.title')}
        message={t('invoiceDetail.payments.recordConfirm.message', {
          amount: formatMoney(Number(payAmount), currency),
          method: t(/* i18n-dynamic */ `invoiceDetail.paymentMethods.${payMethod}`),
          date: formatDate(payDate),
        })}
        confirmLabel={t('invoiceDetail.payments.record')}
        confirmTestId="invoice-payment-confirm"
      />

      {/* Void dialog */}
      <Dialog open={voidOpen} onClose={() => setVoidOpen(false)} title={t('invoiceDetail.void.title')} labelledBy="invoice-void-title" maxWidth="md" className="p-6">
        <div className="space-y-4" data-testid="invoice-void-dialog">
          <div>
            <h2 id="invoice-void-title" className="text-lg font-semibold">{t('invoiceDetail.void.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('invoiceDetail.void.description')}
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {t('invoiceDetail.void.reason')}
            <textarea
              value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={3}
              data-testid="invoice-void-reason"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={voidReissue} onChange={(e) => setVoidReissue(e.target.checked)} data-testid="invoice-void-reissue" />
            {t('invoiceDetail.void.reissue')}
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setVoidOpen(false)} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">{t('common:actions.cancel')}</button>
            {can('invoices', 'send') && (
              <button
                type="button" onClick={() => void submitVoid()} disabled={busy || !voidReason.trim()}
                data-testid="invoice-void-submit"
                className="inline-flex items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                {t('invoiceDetail.void.button')}
              </button>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
