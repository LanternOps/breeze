import { autopayReasonKey } from './autopayReason';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import ChangeCurrencyDialog, { type CurrencyChangeMode } from './ChangeCurrencyDialog';
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
  lineWorkedVsBilledNote,
  pctFromFraction,
  sellerLines,
  computeInvoiceProfit,
} from './invoiceTypes';
import { StatusPill } from './shared/StatusPill';
import { LineItemsTable } from './shared/LineItemsTable';
import InvoiceActions from './InvoiceActions';
import AccountingSyncCard from './AccountingSyncCard';
import { MarginPanel, MarginToggle, useShowMargin } from './billingUi';
import { computeChargeNow } from '@breeze/shared';
import InvoiceLineDevices from './InvoiceLineDevices';
import { useStableT } from '@/lib/i18n/useStableT';
import {
  ACCOUNTING_PROVIDER_NAMES,
  isAccountingProviderId,
  useActivePushProvider,
} from '../../lib/accountingProviders';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: InvoiceDetailData;
  /** Refetch the invoice. May return a promise — AccountingSyncCard's sync
   *  watch awaits it so its polls cannot overlap. */
  onChanged: () => void | Promise<void>;
  /** The workspace header owns the primary actions (Issue / Issue & Send /
   *  Download PDF / Delete draft) — suppress the rail copy so the two don't
   *  render at once (mirrors QuoteDetail.actionsInHeader). */
  actionsInHeader?: boolean;
}

export default function InvoiceDetail({ detail, onChanged, actionsInHeader = false }: Props) {
  const { t } = useTranslation('billing');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const { can } = usePermissions();
  const { invoice, lines } = detail;
  const canPushInvoices = can('invoices', 'write');
  // Where a push from the sync card goes when the invoice has no mapping row
  // yet: the partner's active connection, iff it can push invoices. Only asked
  // when a push could actually be made — the push route also requires
  // accounting:manage (same gate as the InvoicesPage bulk push), and a mapped
  // invoice already names its provider. `null` hides only the push action;
  // the card itself (status + post-Issue watch) always mounts.
  const pushProvider = useActivePushProvider(
    canPushInvoices && can('accounting', 'manage') && !detail.accountingSync,
  );
  const syncProvider = detail.accountingSync?.provider ?? pushProvider;
  // Display name for the {{provider}} interpolation on payment-row sync
  // badges, used as a fallback when a payment's own accountingSync carries no
  // provider (an older API response — see paymentBadgeProvider below).
  // Deliberately no brand fallback (never guess "QuickBooks"): when the
  // provider genuinely isn't known, the interpolation is left blank rather
  // than naming the wrong one.
  const syncProviderName = syncProvider ? ACCOUNTING_PROVIDER_NAMES[syncProvider] : '';
  // A pushed payment's badge names the provider it was pushed to (W01d "Invoice
  // badge" deferral); the invoice-level name only for an older API response.
  const paymentBadgeProvider = (p: InvoicePayment): string =>
    p.accountingSync?.provider ? ACCOUNTING_PROVIDER_NAMES[p.accountingSync.provider] : syncProviderName;
  const currency = invoice.currencyCode;
  const invoiceStatusLabel = invoice.status === 'sent' && !invoice.sentAt
    ? t('invoice.status.issued')
    : t(/* i18n-dynamic */ `invoice.status.${invoice.status}`);
  const stripeConnected = detail.stripeConnected === true;
  // Warn-don't-block (#3777): only the API's cached account currency decides
  // this — never recomputed client-side, never gates the pay-link action.
  const currencyWarning = stripeConnected ? detail.currencyWarning ?? null : null;

  // The billing-wide persisted "internal costs on screen?" preference — the SAME
  // key the quote editor/detail toggles write, so "hide cost & margin" holds
  // when a screen-sharing tech moves between a quote and an invoice. It gates
  // the cost/margin columns, the hidden (internal-only) lines, and the margin
  // panel as one internal view (previously the margin panel rendered
  // unconditionally for anyone with read access, and the per-line "Accounting
  // view" checkbox was a separate, unpersisted control — so hiding margin on a
  // quote didn't carry over here).
  const [chargePending, setChargePending] = useState(false);
  async function startAutopayCharge() {
    if (chargePending) return;
    setChargePending(true);
    try {
      await runAction({ request: () => fetchWithAuth(`/invoices/${invoice.id}/autopay/charge-now`, { method: 'POST' }),
        errorFallback: t('autopay.chargeFailed'), successMessage: t('autopay.chargeStarted'), onUnauthorized: UNAUTHORIZED });
      await onChanged();
    } catch (error) { handleActionError(error, t('autopay.chargeFailed')); }
    finally { setChargePending(false); }
  }
  const [autopaySaving, setAutopaySaving] = useState(false);
  const setAutopayExcluded = async (excluded: boolean) => {
    if (autopaySaving) return;
    setAutopaySaving(true);
    try {
      await runAction<{status?:string}>({ request: () => fetchWithAuth(`/invoices/${invoice.id}/autopay`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ excluded }),
      }), errorFallback: t('autopay.failed'), successMessage: result => result.status === 'pending'
        ? t(/* i18n-dynamic */ autopayReasonKey('control_pending:exclude'),{nsSeparator:false}) : t('autopay.saved') });
      await onChanged();
    } catch (error) { handleActionError(error, t('autopay.failed')); }
    finally { setAutopaySaving(false); }
  };

  const [showMargin, toggleMargin] = useShowMargin();
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
  // Reset-link confirm dialog (revokes every issued public invoice link)
  const [resetLinkOpen, setResetLinkOpen] = useState(false);
  // Void dialog
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidReissue, setVoidReissue] = useState(false);

  // Draft-only currency restamp (#4416, ports the ContractDetail #3778
  // pattern). The server (changeInvoiceCurrency, invoiceService.ts) is the
  // authority: it re-checks invoices:write, the draft status and the row
  // lock, so this dialog is a convenience, never a gate.
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [currencyBusy, setCurrencyBusy] = useState(false);
  const [targetCurrency, setTargetCurrency] = useState(currency);
  const [currencyMode, setCurrencyMode] = useState<CurrencyChangeMode | null>(null);
  const [currencyConfirmed, setCurrencyConfirmed] = useState(false);
  const [currencyError, setCurrencyError] = useState<string | null>(null);

  // Inline due-date editor (issued invoices only). Opens with the current due date;
  // Save PATCHes /invoices/:id/due-date.
  const [dueDateEditing, setDueDateEditing] = useState(false);
  const [dueDateDraft, setDueDateDraft] = useState(invoice.dueDate ?? '');
  // Re-seed from the prop DURING RENDER, never from a passive effect (#4807;
  // same defect and remedy as InvoiceEditor's notes/terms drafts — #2925,
  // #3219, #3277, #3980, #4033 — and AiBudgetThresholdsInput, #4659/#4805). A
  // passive effect flushes AFTER commit, so a keystroke landing between the
  // prop's commit and the effect's later run gets silently overwritten by the
  // stale date the effect captured.
  const dueDateSeed = invoice.dueDate ?? '';
  const [dueDateSeededFrom, setDueDateSeededFrom] = useState(dueDateSeed);
  if (dueDateSeededFrom !== dueDateSeed) {
    setDueDateSeededFrom(dueDateSeed);
    setDueDateDraft(dueDateSeed);
  }

  const loadPayments = useCallback(async () => {
    const res = await fetchWithAuth(`/invoices/${invoice.id}/payments`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) {
      // An operator must NOT read "No payments recorded" when the fetch actually
      // failed — surface a visible error (with inline retry) and a toast.
      setPaymentsError(true);
      handleActionError(new Error(res.statusText), stableT('invoiceDetail.payments.loadFailed'));
      return;
    }
    setPaymentsError(false);
    const body = (await res.json()) as { data: InvoicePayment[] };
    setPayments(body.data ?? []);
  }, [invoice.id, stableT]);

  useEffect(() => { void loadPayments(); }, [loadPayments]);

  const refresh = useCallback(() => { onChanged(); void loadPayments(); }, [onChanged, loadPayments]);

  // Cost/margin is an internal read affordance, visible to anyone who can read
  // the invoice (the same read-level gate the quote rails use for `quotes:read`;
  // cost is a read affordance, not a write one). Uses the shared cents math
  // so the figure is rounded + labelled identically to a quote's.
  const canSeeMargin = can('invoices', 'read');
  const internalView = canSeeMargin && showMargin;

  // In customer view, hide cost/margin columns and hidden bundle children.
  const visibleLines = useMemo(
    () => (internalView ? lines : lines.filter((l) => l.customerVisible)),
    [internalView, lines],
  );
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
  }, invoice.currencyCode);

  // The due date is editable once the invoice is live (issued/partially paid/overdue);
  // the /due-date route is gated on invoices:write.
  const canEditDueDate =
    can('invoices', 'write') && ['sent', 'partially_paid', 'overdue'].includes(invoice.status);

  // The email action on a live invoice (Send invoice / Request payment /
  // Re-send) moved into InvoiceActions when invoices gained the quote composer:
  // it belongs beside Issue & Send, and only there is it reachable from the
  // workspace header as well as this rail.

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

  // Client-side mirror of the server's OVERPAYMENT check (kept server-side too):
  // compare in whole cents so 0.1 + 0.2 style float noise can't misfire.
  const payOverBalance = payAmount !== '' && Math.round(Number(payAmount) * 100) > Math.round(Number(invoice.balance) * 100);

  const recordPayment = useCallback(async () => {
    if (busy || !payAmount || payOverBalance) return;
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
  }, [busy, payAmount, payOverBalance, payMethod, payRef, payDate, invoice.id, refresh, t]);

  const voidPayment = useCallback(async (paymentId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await runAction<{ providerRecordUntouched?: boolean; quickbooksRecordUntouched?: boolean }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/payments/${paymentId}`, { method: 'DELETE' }),
        errorFallback: t('invoiceDetail.payments.reverseError'),
        onUnauthorized: UNAUTHORIZED,
      });
      // The payment being reversed names its own provider when it originated
      // there (`p.source` is an accounting-provider id) — a more precise
      // signal than the invoice-level `syncProviderName` for THIS specific
      // payment, and available even when the invoice itself has no known
      // active connection.
      const reversalProviderName = reversePayment?.source && isAccountingProviderId(reversePayment.source)
        ? ACCOUNTING_PROVIDER_NAMES[reversePayment.source]
        : syncProviderName;
      const untouched = result.providerRecordUntouched ?? result.quickbooksRecordUntouched ?? false;
      showToast(untouched
        ? { type: 'warning', message: t('invoiceDetail.payments.reverseInProviderToo', { provider: reversalProviderName }) }
        : { type: 'success', message: t('invoiceDetail.payments.reverseSuccess') });
      setReversePayment(null);
      refresh();
    } catch (err) {
      handleActionError(err, t('invoiceDetail.payments.reverseError'));
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, refresh, t, syncProviderName, reversePayment]);

  // Revoke every issued public view-and-pay link; the next send/copy dispenses
  // a fresh url. Rare action — for a link forwarded to the wrong hands.
  const submitResetLink = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/reset-link`, { method: 'POST' }),
        errorFallback: t('invoiceDetail.resetLink.error'),
        successMessage: t('invoiceDetail.resetLink.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      setResetLinkOpen(false);
    } catch (err) {
      handleActionError(err, t('invoiceDetail.resetLink.error'));
    } finally {
      setBusy(false);
    }
  }, [busy, invoice.id, t]);

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

  const openCurrencyDialog = useCallback(() => {
    setTargetCurrency(currency);
    setCurrencyMode(null);
    setCurrencyConfirmed(false);
    setCurrencyError(null);
    setCurrencyOpen(true);
  }, [currency]);

  const submitCurrency = useCallback(async () => {
    if (currencyBusy || !currencyMode || !currencyConfirmed || targetCurrency === currency) return;
    setCurrencyBusy(true);
    // A retry starts from a clean slate — a stale error would read as a fresh
    // rejection of the SAME attempt.
    setCurrencyError(null);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/currency`, {
          method: 'POST',
          body: JSON.stringify({
            currencyCode: targetCurrency,
            ...(currencyMode === 'clear' ? { clearLines: true } : { reprice: true }),
          }),
        }),
        errorFallback: t('invoiceDetail.currency.errors.change'),
        successMessage: t('invoiceDetail.currency.toast.changed', { currency: targetCurrency }),
        onUnauthorized: UNAUTHORIZED,
      });
      setCurrencyOpen(false);
      refresh();
    } catch (err) {
      // A 409 CURRENCY_LOCKED names why (line count) in its message — keep the
      // dialog open and show it inline rather than losing it to a toast alone.
      if (err instanceof ActionError && err.status === 409) {
        setCurrencyError(err.message);
      } else {
        handleActionError(err, t('invoiceDetail.currency.errors.change'));
      }
    } finally {
      setCurrencyBusy(false);
    }
  }, [currencyBusy, currencyMode, currencyConfirmed, targetCurrency, currency, invoice.id, refresh, t]);

  const canChangeCurrency = can('invoices', 'write') && invoice.status === 'draft';
  const currencySubmittable = !!currencyMode && currencyConfirmed && targetCurrency !== currency;

  return (
    <div className="space-y-6" data-testid="invoice-detail">
      {/* xl (not lg): matches the editor tab and QuoteDetail — below xl the rail
          stacks under the content so the lines table isn't starved into sideways
          scrolling. min-w-0 lets this 1fr track shrink below the table's content
          width so the page doesn't scroll horizontally on a phone. */}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        {/* Lines + internal-view toggle */}
        <div className="min-w-0 space-y-4">
          {canSeeMargin && lines.length > 0 && (
            <div className="flex items-center justify-end">
              <MarginToggle show={showMargin} onToggle={toggleMargin} testId="invoice-detail-toggle-margin" />
            </div>
          )}
          {lines.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card p-8 text-center" data-testid="invoice-detail-empty">
              <p className="text-sm text-muted-foreground">{t('invoiceDetail.empty')}</p>
              {invoice.status === 'draft' && can('invoices', 'write') && (
                <button
                  type="button"
                  onClick={() => { if (typeof window !== 'undefined') window.location.hash = '#editor'; }}
                  data-testid="invoice-detail-empty-edit"
                  className="mt-3 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  {t('invoiceDetail.addContentInEditor')}
                </button>
              )}
            </div>
          ) : (
          <LineItemsTable<InvoiceLine>
            header={invoice.evidenceVersion === null ? (
              // #3205 W07: invoice-level provenance, rendered once.
              <p className="mb-2 px-3 pt-2 text-xs text-muted-foreground" data-testid="invoice-devices-not-recorded">
                {t('invoiceDetail.devices.notRecorded')}
              </p>
            ) : undefined}
            rows={visibleLines}
            keyFor={(l) => l.id}
            rowTestId={(l) => `invoice-detail-line-${l.id}`}
            tableTestId="invoice-detail-lines"
            scrollAriaLabel={t('invoiceDetail.linesScrollAria')}
            descriptionHeader={t('invoiceDetail.lines.description')}
            // Lines exist but every one is internal-only and the internal view
            // is off — say so instead of rendering a bare header.
            emptyMessage={t('invoiceDetail.lines.allHidden')}
            emptyTestId="invoice-detail-all-hidden"
            rowClassName={(l) => (l.parentLineId ? 'bg-muted/20 text-xs text-muted-foreground' : '')}
            descriptionCellClassName={(l) => (l.parentLineId ? 'pl-8' : '')}
            renderDescription={(l) => {
              const workedVsBilledNote = lineWorkedVsBilledNote(l, t);
              return (
                <>
                  {/* sweep F9: Preview/PDF/portal already show the frozen
                      `ticketLabel` (#6940) via this same `ticketNumber`
                      API field — the default view was the one surface
                      still silent about it. */}
                  {l.ticketNumber && (
                    <div className="mb-1 text-xs">
                      <span
                        data-testid={`invoice-detail-line-ticket-${l.id}`}
                        className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary"
                      >
                        {t('invoiceDocument.ticketHeader', { number: l.ticketNumber })}
                      </span>
                    </div>
                  )}
                  <span className={l.parentLineId ? '' : 'font-medium text-foreground'}>
                    {l.parentLineId ? <span aria-hidden="true">↳ </span> : ''}{lineTitle(l)}
                  </span>
                  {internalView && !l.customerVisible ? t('invoiceDetail.lines.hiddenMarker') : ''}
                  {lineBlurb(l) && <div className="text-xs text-muted-foreground">{lineBlurb(l)}</div>}
                  {workedVsBilledNote && (
                    <div className="text-xs text-muted-foreground" data-testid={`invoice-detail-line-worked-vs-billed-${l.id}`}>
                      {workedVsBilledNote}
                    </div>
                  )}
                  <InvoiceLineDevices invoiceId={invoice.id} line={l} />
                </>
              );
            }}
            columns={[
              { key: 'qty', header: t('invoiceDetail.lines.qty'), align: 'right' as const, cell: (l: InvoiceLine) => l.quantity },
              { key: 'price', header: t('invoiceDetail.lines.price'), align: 'right' as const, cell: (l: InvoiceLine) => formatMoney(l.unitPrice, currency) },
              ...(internalView ? [
                { key: 'cost', header: t('invoiceDetail.lines.cost'), align: 'right' as const, cell: (l: InvoiceLine) => (l.costBasis == null ? '—' : formatMoney(l.costBasis, currency)) },
                { key: 'margin', header: t('invoiceDetail.lines.margin'), align: 'right' as const, cell: (l: InvoiceLine) => lineMargin(l) },
              ] : []),
              ...(showTax ? [
                {
                  key: 'tax',
                  header: t('invoiceDetail.lines.tax'),
                  align: 'right' as const,
                  cellClassName: 'text-muted-foreground',
                  cell: (l: InvoiceLine) => {
                    const tax = lineTaxAmount(l.lineTotal, l.taxable, invoice.taxRate);
                    return tax === null ? '—' : formatMoney(tax, currency);
                  },
                },
              ] : []),
              { key: 'total', header: t('invoiceDetail.lines.total'), align: 'right' as const, cell: (l: InvoiceLine) => formatMoney(l.lineTotal, currency) },
            ]}
          />
          )}
        </div>

        {/* Right rail: summary + payments + actions. The summary card keeps the
            shadow and the large Balance-Due figure so it reads as the anchor; the
            surrounding from/terms/payments cards are flatter (border only) so the
            rail isn't a stack of equal-weight boxes (mirrors QuoteDetail). */}
        <div className="space-y-4">
          {detail.autopay && <section className="space-y-2 rounded-lg border bg-card p-4" data-testid="autopay-invoice-panel" aria-label={t('autopay.title')} aria-busy={autopaySaving}>
            <h3 className="font-semibold">{t('autopay.title')}</h3>
            <p className="text-sm">{t(/* i18n-dynamic */ `autopay.states.${detail.autopay.state}`, { defaultValue: detail.autopay.state })}</p>
            {detail.autopay.reason && <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ autopayReasonKey(detail.autopay.reason), {nsSeparator:false})}</p>}
            {detail.autopay.collectOn && <p className="text-sm">{t('autopay.chargeDate', { date: formatDate(detail.autopay.collectOn) })}</p>}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" data-testid="autopay-invoice-excluded"
              checked={detail.autopay.excluded} disabled={autopaySaving || !can('invoices', 'write') || !detail.autopay.canExclude}
              onChange={event => void setAutopayExcluded(event.target.checked)} />{t('autopay.excludeInvoice')}</label>
            <button type="button" data-testid="autopay-charge-now" className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
              disabled={chargePending || !can('invoices', 'write') || !detail.autopay.canChargeNow}
              onClick={() => void startAutopayCharge()}>{t('autopay.chargeNow')}</button>
          </section>}
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
              {invoice.status === 'void' ? (
                // A void invoice owes nothing — show the state, not a stale balance.
                <span className="text-2xl font-semibold uppercase tracking-wide text-muted-foreground" data-testid="invoice-detail-void-state">
                  {invoiceStatusLabel}
                </span>
              ) : (
                <>
                  <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('invoiceDetail.summary.balanceDue')}</span>
                  <span
                    className={`break-words text-2xl font-semibold tabular-nums ${Number(invoice.balance) > 0 ? '' : 'text-muted-foreground'}`}
                    data-testid="invoice-detail-balance"
                  >
                    {formatMoney(invoice.balance, currency)}
                  </span>
                </>
              )}
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
                QuoteDetail renders it). Never reaches the customer document.
                Gated on the SAME persisted toggle as the cost/margin columns so
                "hide cost & margin" holds across the whole surface. */}
            {internalView && <MarginPanel profit={profit} currency={currency} idPrefix="invoice" />}
          </div>

          {/* Seller From block */}
          {invoice.sellerSnapshot && (
            <div className="rounded-lg border bg-card p-4" data-testid="invoice-detail-from">
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

          {/* Accounting push status (Phase C). Always mounted: with no mapping
              row it renders nothing, but its post-Issue watch still polls until
              the auto-push lands the row. `provider` null (no push-capable
              connection known to this caller) hides only the push action. */}
          <AccountingSyncCard
            provider={syncProvider}
            invoiceId={invoice.id}
            sync={detail.accountingSync}
            invoiceStatus={invoice.status}
            invoiceTouchedAt={invoice.updatedAt}
            canPush={canPushInvoices}
            onChanged={onChanged}
          />

          {/* Terms & Conditions */}
          {invoice.termsAndConditions && (
            <div className="rounded-lg border bg-card p-4" data-testid="invoice-detail-terms">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceDetail.terms')}</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{invoice.termsAndConditions}</p>
            </div>
          )}

          {/* Primary actions (Issue / Send / Copy payment link / PDF / Delete)
              + void. The rail copy of InvoiceActions is suppressed when the
              workspace header owns the actions; Void stays here — its
              written-reason dialog belongs with the issued-lifecycle rail, not
              the header. */}
          <div className="space-y-2">
            {!actionsInHeader && <InvoiceActions detail={detail} onChanged={onChanged} variant="rail" />}
            {invoice.status !== 'draft' && invoice.status !== 'void' && can('invoices', 'send') && (
              <button
                type="button" onClick={() => setResetLinkOpen(true)}
                data-testid="invoice-reset-link-open"
                className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                {t('invoiceDetail.resetLink.button')}
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
            {/* Change stamped currency (DRAFT only, #4416). The server
                re-checks permission, the draft status and eligibility under
                the row lock. */}
            {canChangeCurrency && (
              <button
                type="button"
                onClick={openCurrencyDialog}
                disabled={currencyBusy}
                data-testid="invoice-currency-open"
                className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {t('invoiceDetail.currency.actions.change')}
              </button>
            )}
          </div>

          {/* Payments */}
          <div className="rounded-lg border bg-card p-4" data-testid="invoice-payments">
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
                      {p.source && isAccountingProviderId(p.source) && (
                        <span
                          className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                          data-testid={`invoice-payment-${p.source}-${p.id}`}
                        >
                          {ACCOUNTING_PROVIDER_NAMES[p.source]}
                        </span>
                      )}
                      {p.accountingSync && (
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                            p.accountingSync.status === 'error'
                              ? 'border-destructive/40 bg-destructive/10 text-destructive'
                              : 'border-border bg-muted text-muted-foreground'
                          }`}
                          data-testid={`invoice-payment-qbosync-${p.id}`}
                          title={p.accountingSync.lastError ?? undefined}
                        >
                          {p.accountingSync.status === 'error'
                            ? t('invoiceDetail.payments.providerSyncFailed', { provider: paymentBadgeProvider(p) })
                            : p.accountingSync.status === 'pending'
                              ? t('invoiceDetail.payments.syncingToProvider', { provider: paymentBadgeProvider(p) })
                              : t('invoiceDetail.payments.inProvider', { provider: paymentBadgeProvider(p) })}
                        </span>
                      )}
                    </span>
                    {/* Stripe refunds belong in Stripe. The API decides whether a
                        QuickBooks reversal is allowed based on current pull settings. */}
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

            {currencyWarning && (
              <p
                className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
                role="status"
                data-testid="invoice-stripe-currency-warning"
              >
                {currencyWarning.code === 'STRIPE_ACCOUNT_CURRENCY_UNKNOWN'
                  ? t('invoiceDetail.payments.currencyUnknown', {
                      documentCurrency: currencyWarning.documentCurrency,
                    })
                  : t('invoiceDetail.payments.currencyMismatch', {
                      documentCurrency: currencyWarning.documentCurrency,
                      accountCurrency: currencyWarning.accountCurrency,
                    })}
              </p>
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
                {payOverBalance && (
                  <p role="alert" className="text-xs text-destructive" data-testid="invoice-payment-overpayment">
                    {t('invoiceDetail.payments.overpayment', { balance: formatMoney(invoice.balance, currency) })}
                  </p>
                )}
                <button
                  type="button" onClick={() => setPayConfirmOpen(true)} disabled={busy || !payAmount || payOverBalance}
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

      {/* Reset-link confirm dialog */}
      <Dialog open={resetLinkOpen} onClose={() => setResetLinkOpen(false)} title={t('invoiceDetail.resetLink.title')} labelledBy="invoice-reset-link-title" maxWidth="md" className="p-6">
        <div className="space-y-4" data-testid="invoice-reset-link-dialog">
          <div>
            <h2 id="invoice-reset-link-title" className="text-lg font-semibold">{t('invoiceDetail.resetLink.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('invoiceDetail.resetLink.description')}</p>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setResetLinkOpen(false)} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">{t('common:actions.cancel')}</button>
            <button
              type="button" onClick={() => void submitResetLink()} disabled={busy}
              data-testid="invoice-reset-link-submit"
              className="inline-flex items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {t('invoiceDetail.resetLink.confirm')}
            </button>
          </div>
        </div>
      </Dialog>

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

      <ChangeCurrencyDialog
        open={currencyOpen}
        onClose={() => setCurrencyOpen(false)}
        busy={currencyBusy}
        currentCurrency={currency}
        targetCurrency={targetCurrency}
        onTargetCurrencyChange={setTargetCurrency}
        mode={currencyMode}
        onModeChange={setCurrencyMode}
        confirmed={currencyConfirmed}
        onConfirmedChange={setCurrencyConfirmed}
        error={currencyError}
        onSubmit={() => void submitCurrency()}
        submittable={currencySubmittable}
        testIdPrefix="invoice-currency"
        copy={{
          title: t('invoiceDetail.currency.dialog.title'),
          description: t('invoiceDetail.currency.dialog.description', { currency }),
          currencyLabel: t('invoiceDetail.currency.dialog.currencyLabel'),
          modeLegend: t('invoiceDetail.currency.dialog.modeLegend'),
          modeClearLabel: t('invoiceDetail.currency.dialog.modeClear'),
          modeClearHint: t('invoiceDetail.currency.dialog.modeClearHint'),
          modeRepriceLabel: t('invoiceDetail.currency.dialog.modeReprice'),
          modeRepriceHint: t('invoiceDetail.currency.dialog.modeRepriceHint'),
          confirmLabel: t('invoiceDetail.currency.dialog.confirm'),
          submitLabel: t('invoiceDetail.currency.dialog.submit'),
          cancelLabel: t('common:actions.cancel'),
        }}
      />
    </div>
  );
}
