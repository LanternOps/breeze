import { InvoicePaymentPanel } from './autopay/InvoicePaymentPanel';
import { Notice } from './ui';
import { runAction } from '@/lib/runAction';
import { invoiceAutopayInput } from '@/lib/api';
import { Fragment, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { withBase } from '@/lib/basePath';
import { portalApi, buildPortalApiUrl, type PublicInvoiceDetail, lineWorkedVsBilledNote } from '@/lib/api';
import { groupInvoiceLinesByTicket } from '@/lib/invoiceLineGroups';
import { STATUS_LABELS, statusTone } from '@/lib/invoiceStatus';
import { DocumentPaper, DocumentHeader, DocumentTerms, DocumentTermsCollapsible, type DocSeller } from './documentShell';
import { money } from '@/lib/money';
import { longDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, BTN_SECONDARY } from './ui';

/**
 * The public (token-gated) invoice page — the customer's durable no-login
 * view-and-pay view, mirroring PublicQuoteView's composition and reusing the
 * authenticated InvoiceDetailView's table/totals rhythm. The MSP is the brand;
 * the platform stays anonymous (matching the email envelope).
 *
 * States (spec §4): payable (deposit-aware Pay CTA) · paid (calm confirmation)
 * · overdue (amber banner, still payable) · void (no amounts, contact line) ·
 * online-payment-unavailable (view + PDF only). ?paid=1 / ?pending=1 arrive
 * from the checkout-return page (InvoiceReturn) after settle.
 */

interface PublicInvoiceViewProps {
  token: string;
  /** Test seam — production always fetches client-side (see [token].astro:
   *  SSR fetches would share one rate-limit slot for every customer). */
  initial?: PublicInvoiceDetail | null;
  error?: string | null;
}


function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

/** Per-line tax amount — same derivation as InvoiceDetailView.lineTax. */
function lineTax(lineTotal: string | number, taxable: boolean, rate: number): number | null {
  if (!taxable || !(rate > 0)) return null;
  const cents = Math.round(Number(lineTotal) * 100);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

export function PublicInvoiceView({ token, initial = null, error }: PublicInvoiceViewProps) {
  const [detail, setDetail] = useState<PublicInvoiceDetail | null>(initial);
  const [loadError, setLoadError] = useState<string | null>(error ?? null);
  const [loading, setLoading] = useState(initial == null && !error);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Client-side fetch (see [token].astro). A 401 gets ONE generic message —
  // never a login redirect for an anonymous customer.
  useEffect(() => {
    if (detail || loadError) return;
    let cancelled = false;
    void portalApi.getPublicInvoice(token, { redirectOnUnauthorized: false })
      .then((res) => {
        if (cancelled) return;
        if (res.data?.data) setDetail(res.data.data);
        else setLoadError(res.statusCode === 401 ? '' : (res.error || ''));
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setLoadError(''); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div data-testid="public-invoice-loading" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">
        Loading invoice…
      </div>
    );
  }
  if (loadError != null || !detail) {
    return (
      <div data-testid="public-invoice-error" className="mx-auto max-w-lg p-8 text-center">
        <p className="text-sm text-destructive">
          {loadError || 'This invoice link is invalid or has expired. Please contact the sender for a new one.'}
        </p>
      </div>
    );
  }

  const { invoice, lines, chargeNow, payable, branding } = detail;
  const collectionInProgress = detail.collectionInProgress ?? null; // #7824
  const releaseConfirmation = async () => {
    const response = await portalApi.releasePublicAutopayConfirmation(token);
    return { ...response, data: response.data?.data };
  };
  // After a released 3DS payment: re-read the invoice. False (not a throw) when that
  // fails, so the panel keeps the released state and says to refresh (PR #7983 review).
  const reloadAfterRelease = async (): Promise<boolean> => {
    try {
      const res = await portalApi.getPublicInvoice(token, { redirectOnUnauthorized: false });
      if (!res.data?.data) return false;
      setDetail(res.data.data);
      return true;
    } catch { return false; }
  };
  const returnFlag = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const justPaid = returnFlag.get('paid') === '1';
  const paymentPending = returnFlag.get('pending') === '1';

  // ---- Void: the calm no-amounts state -------------------------------------
  if (invoice.status === 'void') {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-5 p-2 sm:p-4">
        <DocumentPaper primaryColor={branding.primaryColor} testId="public-invoice-void" docTheme={branding.theme}>
          <DocumentHeader
            logoUrl={branding.logoUrl}
            partnerName={branding.partnerName}
            seller={null}
            eyebrow="Invoice"
            title={invoice.invoiceNumber ?? 'Invoice'}
            statusLabel="No longer due"
            statusTone="neutral"
            dates={[]}
          />
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>This invoice is no longer due.</p>
            {invoice.replaced && <p>An updated invoice has been issued — please use the link in its email.</p>}
            {branding.contactEmail && (
              <p>
                Questions? Contact{' '}
                <a href={`mailto:${branding.contactEmail}`} className="text-primary hover:underline">{branding.contactEmail}</a>.
              </p>
            )}
          </div>
        </DocumentPaper>
      </div>
    );
  }

  const currency = invoice.currencyCode ?? 'USD';
  const isPaid = invoice.status === 'paid';
  const isOverdue = invoice.status === 'overdue';
  const hasDeposit = invoice.depositDue != null;
  const taxRate = invoice.taxRate ? Number(invoice.taxRate) : 0;
  const showTax = Number(invoice.taxTotal ?? 0) > 0;
  const taxPct = taxRate > 0 ? Number((taxRate * 100).toFixed(3)) : 0;
  const seller = (invoice.sellerSnapshot ?? null) as DocSeller | null;
  const canPay = payable && chargeNow != null && !justPaid && !paymentPending;

  const headerDates = [
    { label: 'Issued', value: shortDate(invoice.issueDate ?? null) },
    { label: 'Due', value: shortDate(invoice.dueDate ?? null) },
  ];

  const pay = async (saveForAutopay: boolean) => {
    if (paying) return; setPaying(true); setPayError(null);
    const result = await runAction({
      request: () => portalApi.payPublicInvoice(token, invoiceAutopayInput(saveForAutopay, detail.autopay)),
      onOutcome: (message, error) => { if (error) setPayError(message); },
      successMessage: 'Opening secure checkout…', errorFallback: 'Could not start payment. Please try again.',
      validate: value => typeof value.data?.url === 'string' && value.data.url.startsWith('https://checkout.stripe.com/'),
    });
    if (result && typeof result.data.url === 'string') window.location.href = result.data.url; else setPaying(false);
  };

  const downloadPdf = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(buildPortalApiUrl(`/invoices/public/${encodeURIComponent(token)}/pdf`));
      if (!res.ok) { setDownloadError('Could not download the invoice PDF.'); return; }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.invoiceNumber ?? 'invoice'}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Could not download the invoice PDF.');
    } finally {
      setDownloading(false);
    }
  };

  const notices = (
    <>
      {isPaid && !detail.autopayStatus && (
        <Notice tone="success" title={`Paid${invoice.paidAt ? ` on ${longDate(invoice.paidAt)}` : ''}. Thank you.`} data-testid="public-invoice-paid-banner">
          <p>You can download a copy for your records.</p>
        </Notice>
      )}
      {justPaid && !isPaid && (
        <Notice tone="success" title="Payment received. Thank you!" data-testid="public-invoice-paid-banner">
          <p>It may take a moment to show on the invoice.</p>
        </Notice>
      )}
      {paymentPending && !isPaid && (
        <Notice tone="primary" title="Thanks! We're still confirming your payment." data-testid="public-invoice-pending-banner">
          <p>This can take a moment. Refresh shortly to see it applied.</p>
        </Notice>
      )}
      {payError && <Notice tone="destructive" title={payError} data-testid="public-invoice-pay-error" />}
      {downloadError && <Notice tone="destructive" title={downloadError} />}
    </>
  );

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 p-0 sm:p-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      {/* The panel comes first on phones (the amount and the way to pay); at lg it sits
          beside the invoice, which stays the document (D-4). */}
      <div className="lg:col-start-2 lg:row-start-1">
        <InvoicePaymentPanel
          currency={currency} balance={invoice.balance ?? '0'} dueDate={invoice.dueDate ?? null} status={invoice.status}
          paidAt={invoice.paidAt ?? null} canPay={canPay} onlinePaymentUnavailable={!payable && !isPaid}
          charge={chargeNow ?? { amount: invoice.balance ?? '0', isDeposit: false }}
          autopayStatus={detail.autopayStatus ?? null} autopayEnrolled={detail.autopayEnrolled === true}
          saveOffer={detail.autopay} bankTarget={{ invoiceId: invoice.id, publicToken: token }} bankOffer={detail.bankAutopay}
          collectionInProgress={collectionInProgress} partnerName={branding.partnerName}
          paying={paying} onPay={save => void pay(save)} payTestId="public-invoice-pay" processingTestId="public-invoice-collection-processing"
          release={releaseConfirmation} reload={reloadAfterRelease} notices={notices}
          download={(
            <button type="button" onClick={() => void downloadPdf()} disabled={downloading} data-testid="public-invoice-download"
              className={cn(canPay ? BTN_SECONDARY : BTN_PRIMARY, 'w-full')}>
              <Download className="h-4 w-4" aria-hidden="true" />
              {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
          )}
        />
      </div>

      <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-start-1">
      <DocumentPaper primaryColor={branding.primaryColor} testId="public-invoice" docTheme={branding.theme}>
        <DocumentHeader
          logoUrl={branding.logoUrl}
          partnerName={branding.partnerName}
          seller={seller}
          eyebrow="Invoice"
          title={invoice.invoiceNumber ?? 'Invoice'}
          statusLabel={STATUS_LABELS[invoice.status] ?? invoice.status}
          statusTone={statusTone(invoice.status)}
          dates={headerDates}
          preparedForLabel="Bill to"
          preparedForName={invoice.billToName ?? undefined}
        />

        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium sm:px-5">Description</th>
                  <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Qty</th>
                  <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Price</th>
                  {showTax && <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Tax</th>}
                  <th className="px-4 py-2.5 text-right font-medium sm:px-5">Amount</th>
                </tr>
              </thead>
              <tbody>
                {groupInvoiceLinesByTicket(lines).map((group) => (
                    <Fragment key={group.key}>
                      {group.ticketNumber && (
                        <tr className="border-b bg-muted/30">
                          <td colSpan={showTax ? 5 : 4} className="px-4 py-2 sm:px-5">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-semibold text-foreground">
                                {`Ticket #${group.ticketNumber}`}
                              </span>
                              {group.ticketCategory && (
                                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground font-medium">
                                  {group.ticketCategory}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                      {group.lines.map((l) => {
                        const index = lines.indexOf(l);
                        const tax = showTax ? lineTax(l.lineTotal, l.taxable, taxRate) : null;
                        const title = (l.name ?? l.description ?? '').trim() || '—';
                        const blurb = l.name ? (l.description ?? '').trim() : '';
                        // #6467: worked-vs-billed disclosure (§3.5), sourced from
                        // structured data — never from `description`.
                        const note = lineWorkedVsBilledNote(l);
                        return (
                          <tr key={`${title}-${index}`} className="border-b align-top last:border-0">
                            <td className="px-4 py-3 text-foreground sm:px-5">
                              {title}
                              {/* P-7: on phones Qty and Price fold under the description instead of clipping the table. */}
                              <div className="mt-0.5 text-xs tabular-nums text-muted-foreground sm:hidden" data-testid={`invoice-line-qty-${index}`}>{l.quantity} × {money(l.unitPrice, currency)}</div>
                              {blurb && <div className="mt-0.5 text-xs text-muted-foreground">{blurb}</div>}
                              {note && <div className="mt-0.5 text-xs text-muted-foreground" data-testid={`invoice-line-worked-vs-billed-${index}`}>{note}</div>}
                            </td>
                            <td className="hidden whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground sm:table-cell">{l.quantity}</td>
                            <td className="hidden whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground sm:table-cell">{money(l.unitPrice, currency)}</td>
                            {showTax && <td className="hidden whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground sm:table-cell">{tax === null ? '—' : money(tax, currency)}</td>}
                            <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-foreground sm:px-5">{money(l.lineTotal, currency)}</td>
                          </tr>
                        );
                      })}
                    </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <section className="flex justify-end">
          <div className="w-full max-w-xs space-y-2.5">
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums text-foreground">{money(invoice.subtotal ?? 0, currency)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Tax{taxPct ? ` (${taxPct}%)` : ''}</span><span className="tabular-nums text-foreground">{money(invoice.taxTotal ?? 0, currency)}</span></div>
            <div className="flex justify-between border-t pt-2.5 text-sm"><span className="font-medium text-foreground">Total</span><span className="font-medium tabular-nums text-foreground">{money(invoice.total ?? 0, currency)}</span></div>
            {Number(invoice.amountPaid ?? 0) > 0 && (
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-foreground">−{money(invoice.amountPaid ?? 0, currency)}</span></div>
            )}
            <div className="doc-accent-border flex items-baseline justify-between border-t pt-3">
              <span className="text-sm font-semibold text-foreground">{isPaid ? 'Balance' : 'Balance due'}</span>
              <span className="doc-accent-text text-2xl font-semibold tabular-nums" data-testid="public-invoice-balance">{money(invoice.balance ?? 0, currency)}</span>
            </div>
            {hasDeposit && chargeNow && !isPaid && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="public-invoice-deposit-strip">
                {chargeNow.isDeposit ? (
                  <>Deposit of <strong className="text-foreground">{money(invoice.depositDue!, currency)}</strong> due — {money(invoice.amountPaid ?? 0, currency)} of {money(invoice.total ?? 0, currency)} paid.</>
                ) : (
                  <>Deposit paid — remaining balance {money(invoice.balance ?? 0, currency)}.</>
                )}
              </div>
            )}
          </div>
        </section>

        {invoice.notes && <DocumentTerms label="Notes">{invoice.notes}</DocumentTerms>}
        {invoice.termsAndConditions && (
          <DocumentTermsCollapsible text={invoice.termsAndConditions} testId="public-invoice-terms" />
        )}
      </DocumentPaper>

      <p className="pb-4 text-center text-xs text-muted-foreground">
        Have a customer portal account?{' '}
        <a href={withBase('/login')} className="text-primary hover:underline">Sign in</a>{' '}
        to see all your invoices.
      </p>
      </div>
    </div>
  );
}

export default PublicInvoiceView;
