import { useCallback, useEffect, useMemo, useState } from 'react';
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
  STATUS_COLORS,
  statusLabel,
  formatDate,
  formatMoney,
  lineTaxAmount,
  lineTitle,
  lineBlurb,
  pctFromFraction,
  sellerLines,
  computeInvoiceProfit,
} from './invoiceTypes';
import { MarginPanel } from './billingUi';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: InvoiceDetailData;
  onChanged: () => void;
}

export default function InvoiceDetail({ detail, onChanged }: Props) {
  const { can } = usePermissions();
  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;
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
  // Delete dialog
  const [delOpen, setDelOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidReissue, setVoidReissue] = useState(false);

  const loadPayments = useCallback(async () => {
    const res = await fetchWithAuth(`/invoices/${invoice.id}/payments`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) {
      // An operator must NOT read "No payments recorded" when the fetch actually
      // failed — surface a visible error (with inline retry) and a toast.
      setPaymentsError(true);
      handleActionError(new Error(res.statusText), 'Failed to load payments.');
      return;
    }
    setPaymentsError(false);
    const body = (await res.json()) as { data: InvoicePayment[] };
    setPayments(body.data ?? []);
  }, [invoice.id]);

  useEffect(() => { void loadPayments(); }, [loadPayments]);

  const refresh = useCallback(() => { onChanged(); void loadPayments(); }, [onChanged, loadPayments]);

  // In customer view, hide cost/margin columns and hidden bundle children.
  const visibleLines = useMemo(
    () => (accountingView ? lines : lines.filter((l) => l.customerVisible)),
    [accountingView, lines],
  );

  // Cost/margin is an internal read affordance, visible to anyone who can read
  // the invoice (mirrors the always-on Accounting view toggle and the quote
  // rails' `quotes:read` gate). Same shared cents math as quotes so an invoice
  // margin can't drift from the quote it was issued from.
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

  const downloadPdf = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth(`/invoices/${invoice.id}/pdf`);
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) { handleActionError(new Error('pdf'), 'Could not download the invoice PDF.'); return; }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.invoiceNumber ?? `invoice-${invoice.id}`}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      handleActionError(err, 'Could not download the invoice PDF.');
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, invoice.invoiceNumber]);

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
        errorFallback: 'Could not record the payment.',
        successMessage: 'Payment recorded',
        onUnauthorized: UNAUTHORIZED,
      });
      setPayAmount(''); setPayRef('');
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not record the payment.');
    } finally {
      setBusy(false);
    }
  }, [busy, payAmount, payMethod, payRef, payDate, invoice.id, refresh]);

  const sendPayLink = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await runAction<{ data: { url: string } }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/pay-link`, { method: 'POST' }),
        errorFallback: 'Could not create a payment link.',
        friendly: (code) => (code === 'STRIPE_NOT_CONNECTED' ? 'Connect Stripe to accept online payments.' : undefined),
        onUnauthorized: UNAUTHORIZED,
      });
      const url = result?.data?.url;
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          showToast({ type: 'success', message: 'Payment link copied to clipboard' });
        } catch {
          // Clipboard blocked (insecure context / permissions) — surface the URL.
          window.prompt('Share this payment link with your customer:', url);
        }
      } else {
        // 200 without a URL shouldn't happen (the API throws STRIPE_NO_URL), but
        // never leave a money action with no feedback.
        showToast({ type: 'error', message: 'No payment link was returned. Try again.' });
      }
    } catch (err) {
      handleActionError(err, 'Could not create a payment link.');
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id]);

  const voidPayment = useCallback(async (paymentId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/payments/${paymentId}`, { method: 'DELETE' }),
        errorFallback: 'Could not reverse the payment.',
        successMessage: 'Payment reversed',
        onUnauthorized: UNAUTHORIZED,
      });
      setReversePayment(null);
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not reverse the payment.');
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, refresh]);

  const submitVoid = useCallback(async () => {
    if (busy || !voidReason.trim()) return;
    setBusy(true);
    try {
      const result = await runAction<{ data: { invoice: { id: string } } }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/void`, {
          method: 'POST',
          body: JSON.stringify({ reason: voidReason.trim(), reissue: voidReissue }),
        }),
        errorFallback: 'Could not void the invoice.',
        successMessage: voidReissue ? 'Invoice voided and reissued as a draft' : 'Invoice voided',
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
      handleActionError(err, 'Could not void the invoice.');
    } finally {
      setBusy(false);
    }
  }, [busy, voidReason, voidReissue, invoice.id, refresh]);

  const remove = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, { method: 'DELETE' }),
        errorFallback: 'Could not delete the draft.',
        successMessage: 'Draft deleted',
        onUnauthorized: UNAUTHORIZED,
      });
      setDelOpen(false);
      void navigateTo('/billing/invoices');
    } catch (err) {
      handleActionError(err, 'Could not delete the draft.');
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id]);

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
              Accounting view (cost, margin, hidden components)
            </label>
          </div>
          <div className="rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm" data-testid="invoice-detail-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  {accountingView && <th className="px-3 py-2 text-right font-medium">Cost</th>}
                  {accountingView && <th className="px-3 py-2 text-right font-medium">Margin</th>}
                  {showTax && <th className="px-3 py-2 text-right font-medium">Tax</th>}
                  <th className="px-3 py-2 text-right font-medium">Total</th>
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
                      {accountingView && !l.customerVisible ? ' (hidden)' : ''}
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
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[invoice.status]}`} data-testid="invoice-detail-status" aria-label={`Status: ${statusLabel(invoice)}`}>
                {statusLabel(invoice)}
              </span>
              <span className="text-xs text-muted-foreground">Due {formatDate(invoice.dueDate)}</span>
            </div>
            <dl className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd>{formatMoney(invoice.subtotal, currency)}</dd></div>
              {showTax && (
                <div className="flex justify-between"><dt className="text-muted-foreground">Tax{invoice.taxRate ? ` (${pctFromFraction(invoice.taxRate)}%)` : ''}</dt><dd>{formatMoney(invoice.taxTotal, currency)}</dd></div>
              )}
              <div className="flex min-w-0 justify-between gap-2 font-semibold"><dt>Total</dt><dd className="break-words">{formatMoney(invoice.total, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Paid</dt><dd>{formatMoney(invoice.amountPaid, currency)}</dd></div>
            </dl>
            {/* Balance-due focal number */}
            <div className="mt-3 flex min-w-0 items-end justify-between gap-2 border-t pt-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Balance due</span>
              <span
                className={`break-words text-2xl font-semibold tabular-nums ${Number(invoice.balance) > 0 && invoice.status !== 'void' ? '' : 'text-muted-foreground'}`}
                data-testid="invoice-detail-balance"
              >
                {formatMoney(invoice.balance, currency)}
              </span>
            </div>
            {/* Internal margin summary — profitability stays visible after the
                invoice is issued and the Editor tab disappears (same reason
                QuoteDetail renders it). Never reaches the customer document. */}
            {canSeeMargin && <MarginPanel profit={profit} currency={currency} idPrefix="invoice" />}
          </div>

          {/* Seller From block */}
          {invoice.sellerSnapshot && (
            <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-detail-from">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</h3>
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
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{invoice.termsAndConditions}</p>
            </div>
          )}

          {/* PDF + void */}
          <div className="space-y-2">
            {can('invoices', 'export') && (
              <button
                type="button" onClick={() => void downloadPdf()} disabled={busy}
                data-testid="invoice-download-pdf"
                className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Download PDF
              </button>
            )}
            {canVoid && can('invoices', 'send') && (
              <button
                type="button" onClick={() => { setVoidReason(''); setVoidReissue(false); setVoidOpen(true); }}
                data-testid="invoice-void-open"
                className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
              >
                Void invoice
              </button>
            )}
            {invoice.status === 'draft' && can('invoices', 'write') && (
              <button
                type="button"
                onClick={() => setDelOpen(true)}
                data-testid="invoice-delete-open"
                className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
              >
                Delete draft
              </button>
            )}
          </div>

          {/* Payments */}
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-payments">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payments</h3>
            {paymentsError ? (
              <p className="text-sm text-destructive" data-testid="invoice-payments-error">
                Could not load payments.{' '}
                <button type="button" onClick={() => void loadPayments()} className="underline hover:text-foreground">Retry</button>
              </p>
            ) : payments.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="invoice-payments-empty">No payments recorded.</p>
            ) : (
              <ul className="divide-y text-sm">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2" data-testid={`invoice-payment-${p.id}`}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="tabular-nums">{formatMoney(p.amount, currency)}</span>
                      <span className="text-muted-foreground">· {PAYMENT_METHOD_LABELS[p.method]} · {formatDate(p.receivedAt)}</span>
                      {p.source === 'stripe' && (
                        <span
                          className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                          data-testid={`invoice-payment-online-${p.id}`}
                        >
                          Online
                        </span>
                      )}
                    </span>
                    {/* Stripe payments are refunded through Stripe, never hand-voided. */}
                    {p.source === 'stripe' ? (
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">via Stripe</span>
                    ) : can('invoices', 'send') ? (
                      <button
                        type="button" onClick={() => setReversePayment(p)} disabled={busy || invoice.status === 'void'}
                        aria-label={`Reverse payment of ${formatMoney(p.amount, currency)}`}
                        data-testid={`invoice-payment-void-${p.id}`}
                        className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        Reverse
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {invoice.status === 'draft' && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="invoice-payments-draft-hint">
                Issue this invoice to record payments.
              </p>
            )}

            {canRecordPayment && stripeConnected && can('invoices', 'send') && (
              <button
                type="button" onClick={() => void sendPayLink()} disabled={busy}
                data-testid="invoice-pay-link"
                className="mt-3 inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Send payment link
              </button>
            )}
            {canRecordPayment && !stripeConnected && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="invoice-stripe-nudge">
                Connect Stripe to accept online card payments.{' '}
                <a href="/settings/billing" className="underline hover:text-foreground">Set up</a>
              </p>
            )}

            {canRecordPayment && can('invoices', 'send') && (
              <div className="mt-3 space-y-2 border-t pt-3" data-testid="invoice-payment-form">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number" min="0" step="0.01" placeholder="Amount" value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    aria-label="Amount"
                    data-testid="invoice-payment-amount"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <select
                    value={payMethod} onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                    aria-label="Payment method"
                    data-testid="invoice-payment-method"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
                      <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                    ))}
                  </select>
                  <input
                    type="text" placeholder="Reference (optional)" value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                    aria-label="Reference"
                    data-testid="invoice-payment-ref"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <input
                    type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)}
                    aria-label="Payment date"
                    data-testid="invoice-payment-date"
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <button
                  type="button" onClick={() => setPayConfirmOpen(true)} disabled={busy || !payAmount}
                  title={!payAmount ? 'Enter a payment amount to record it' : undefined}
                  aria-describedby={!payAmount ? 'invoice-payment-submit-hint' : undefined}
                  data-testid="invoice-payment-submit"
                  className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Record payment
                </button>
                <span id="invoice-payment-submit-hint" className="sr-only">
                  Enter a payment amount to record it
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
        title="Reverse this payment?"
        message={reversePayment ? `This reverses the ${formatMoney(reversePayment.amount, currency)} ${PAYMENT_METHOD_LABELS[reversePayment.method]} payment and removes it from the invoice balance. This can't be undone.` : ''}
        confirmLabel="Reverse payment"
        confirmTestId="invoice-payment-reverse-confirm"
      />

      {/* Record payment confirm dialog */}
      <ConfirmDialog
        open={payConfirmOpen}
        onClose={() => setPayConfirmOpen(false)}
        onConfirm={() => { setPayConfirmOpen(false); void recordPayment(); }}
        isLoading={busy}
        variant="warning"
        title="Record payment"
        message={`Record a ${formatMoney(Number(payAmount), currency)} payment (${PAYMENT_METHOD_LABELS[payMethod]}) dated ${formatDate(payDate)}?`}
        confirmLabel="Record payment"
        confirmTestId="invoice-payment-confirm"
      />

      {/* Delete draft dialog */}
      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        onConfirm={() => void remove()}
        isLoading={busy}
        title="Delete draft invoice"
        message="This permanently deletes the draft invoice. This cannot be undone."
        confirmLabel="Delete draft"
        confirmTestId="invoice-delete-confirm"
      />

      {/* Void dialog */}
      <Dialog open={voidOpen} onClose={() => setVoidOpen(false)} title="Void invoice" labelledBy="invoice-void-title" maxWidth="md" className="p-6">
        <div className="space-y-4" data-testid="invoice-void-dialog">
          <div>
            <h2 id="invoice-void-title" className="text-lg font-semibold">Void invoice</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Voiding releases billed work so it can be re-invoiced. This cannot be undone.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Reason
            <textarea
              value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={3}
              data-testid="invoice-void-reason"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={voidReissue} onChange={(e) => setVoidReissue(e.target.checked)} data-testid="invoice-void-reissue" />
            Reissue as a new draft
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setVoidOpen(false)} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
            {can('invoices', 'send') && (
              <button
                type="button" onClick={() => void submitVoid()} disabled={busy || !voidReason.trim()}
                data-testid="invoice-void-submit"
                className="inline-flex items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                Void invoice
              </button>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
