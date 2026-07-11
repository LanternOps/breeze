import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { useOrgStore } from '../../stores/orgStore';
import { usePdfDownload } from './shared/usePdfDownload';
import {
  type InvoiceDetail as InvoiceDetailData,
  type InvoiceLine,
  STATUS_ROLES,
  formatDate,
  formatMoney,
  lineTaxAmount,
  lineTitle,
  lineBlurb,
  pctFromFraction,
  sellerLines,
} from './invoiceTypes';
import { StatusPill } from './shared/StatusPill';

function LineRow({ line, currency, taxRate, showTax }: { line: InvoiceLine; currency: string; taxRate: string | null; showTax: boolean }) {
  const child = !!line.parentLineId;
  const tax = showTax ? lineTaxAmount(line.lineTotal, line.taxable, taxRate) : null;
  return (
    <tr className="border-b align-top last:border-0">
      <td className={`px-4 py-3 sm:px-5 ${child ? 'pl-8 text-muted-foreground' : 'text-foreground'}`}>
        <span className={child ? '' : 'font-medium'}>{child ? <span aria-hidden="true">↳ </span> : ''}{lineTitle(line)}</span>
        {lineBlurb(line) && <p className="mt-0.5 text-xs text-muted-foreground">{lineBlurb(line)}</p>}
      </td>
      <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{line.quantity}</td>
      <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{formatMoney(line.unitPrice, currency)}</td>
      {showTax && (
        <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{tax === null ? '—' : formatMoney(tax, currency)}</td>
      )}
      <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-foreground sm:px-5">{formatMoney(line.lineTotal, currency)}</td>
    </tr>
  );
}

interface DocumentProps {
  detail: InvoiceDetailData;
  /** Resolved customer/bill-to name (parent looks it up against the org list). */
  customerName: string;
}

/** Pure, presentational customer-facing invoice document. Renders the same
 *  customer-visible lines and totals the customer receives on their invoice,
 *  using the seller snapshot and the app accent. The sibling of QuoteDocument;
 *  works for drafts without a portal round-trip. */
export function InvoiceDocument({ detail, customerName }: DocumentProps) {
  const { t } = useTranslation('billing');
  const { invoice, lines, branding } = detail;
  const currency = branding?.currencyCode ?? invoice.currencyCode;
  const seller = branding?.seller ?? invoice.sellerSnapshot;
  // Partner brand accent when resolved; otherwise the app's primary accent.
  const accent = branding?.primaryColor || 'hsl(var(--primary))';
  const accentStyle = { ['--doc-accent']: accent } as CSSProperties;
  // Wordmark/logo identity: partner logo → partner name → seller name. The
  // letterhead rule renders whenever any identity is shown. Same source and
  // precedence as QuoteDocument so invoices and quotes brand identically.
  const wordmark = branding?.partnerName || seller?.name || null;

  // Customers only ever see customer-visible lines — cost/margin and hidden
  // bundle components never reach the document.
  const visibleLines = useMemo(
    () => lines.filter((l) => l.customerVisible).sort((a, b) => a.sortOrder - b.sortOrder),
    [lines],
  );
  const isEmpty = visibleLines.length === 0;
  const invoiceStatusLabel = invoice.status === 'sent' && !invoice.sentAt
    ? t('invoice.status.issued')
    : t(`invoice.status.${invoice.status}`);
  const amountPaid = Number(invoice.amountPaid);
  // Only surface the per-line Tax column when this invoice carries tax — mirrors
  // the header Tax row's visibility (otherwise it's a column of dashes).
  const showTax = Number(invoice.taxTotal) > 0;

  return (
    <div
      style={accentStyle}
      data-testid="invoice-document"
      className="mx-auto max-w-3xl overflow-hidden rounded-xl border bg-card shadow-xs"
    >
      <div className="space-y-10 px-4 py-7 sm:px-12 sm:py-10">
        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            {/* Partner logo (or wordmark) + letterhead rule, mirroring the quote
                document. An unbranded invoice with no seller name lets the
                right-hand "Invoice" meta carry identity instead. */}
            {branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.partnerName} className="h-11 w-auto max-w-[220px] object-contain" />
            ) : wordmark ? (
              <p className="text-xl font-semibold tracking-tight text-foreground" data-testid="invoice-document-wordmark">
                {wordmark}
              </p>
            ) : null}
            {(branding?.logoUrl || wordmark) && (
              /* Brand letterhead rule — a short, deliberate accent mark, not a full-bleed stripe. */
              <div className="h-0.5 w-10 rounded-full" style={{ backgroundColor: 'var(--doc-accent)' }} aria-hidden />
            )}
            {seller && (
              <address className="space-y-0.5 text-xs not-italic leading-relaxed text-muted-foreground">
                {sellerLines(seller.address).map((line, i) => <p key={i}>{line}</p>)}
                {seller.phone && <p>{seller.phone}</p>}
                {seller.email && <p>{seller.email}</p>}
                {seller.website && <p>{seller.website}</p>}
              </address>
            )}
          </div>

          <div className="space-y-2 sm:text-right">
            <p className="text-[1.75rem] font-semibold leading-none tracking-tight text-foreground" data-testid="invoice-document-number">
              {invoice.invoiceNumber ?? t('invoiceDocument.fallbackTitle')}
            </p>
            {/* The "Invoice" type label is redundant on an unnumbered draft, where the
                heading above already reads "Invoice" and the status pill reads "Draft". */}
            {invoice.invoiceNumber && <p className="text-sm font-medium text-muted-foreground">{t('invoiceDocument.documentType')}</p>}
            <StatusPill
              role={STATUS_ROLES[invoice.status].role}
              label={invoiceStatusLabel}
              className={STATUS_ROLES[invoice.status].className}
            />
            <dl className="space-y-0.5 pt-1 text-xs text-muted-foreground sm:flex sm:flex-col sm:items-end">
              {invoice.issueDate && (
                <div className="flex gap-2"><dt>{t('invoiceDocument.issued')}</dt><dd className="font-medium text-foreground/80">{formatDate(invoice.issueDate)}</dd></div>
              )}
              {invoice.dueDate && (
                <div className="flex gap-2"><dt>{t('invoiceDocument.due')}</dt><dd className="font-medium text-foreground/80">{formatDate(invoice.dueDate)}</dd></div>
              )}
            </dl>
          </div>
        </header>

        {/* ── Bill to + notes ────────────────────────────────────── */}
        <section className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceDocument.billTo')}</p>
            <p className="mt-1 text-base font-medium text-foreground" data-testid="invoice-document-customer">{customerName}</p>
          </div>
          {invoice.notes?.trim() && (
            <p className="max-w-prose whitespace-pre-wrap text-pretty text-sm leading-relaxed text-foreground/90">
              {invoice.notes.trim()}
            </p>
          )}
        </section>

        {/* ── Lines ──────────────────────────────────────────────── */}
        {isEmpty ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
            {t('invoiceDocument.empty')}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm" data-testid="invoice-document-lines">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-medium sm:px-5">{t('invoiceDocument.table.description')}</th>
                    <th className="px-2 py-2.5 text-right font-medium">{t('invoiceDocument.table.qty')}</th>
                    <th className="px-2 py-2.5 text-right font-medium">{t('invoiceDocument.table.unitPrice')}</th>
                    {showTax && <th className="px-2 py-2.5 text-right font-medium">{t('invoiceDocument.table.tax')}</th>}
                    <th className="px-4 py-2.5 text-right font-medium sm:px-5">{t('invoiceDocument.table.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLines.map((l) => <LineRow key={l.id} line={l} currency={currency} taxRate={invoice.taxRate} showTax={showTax} />)}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Totals ─────────────────────────────────────────────── */}
        {!isEmpty && (
          <section className="flex justify-end">
            <div className="w-full max-w-xs space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('invoiceDocument.totals.subtotal')}</span>
                <span className="tabular-nums text-foreground">{formatMoney(invoice.subtotal, currency)}</span>
              </div>
              {showTax && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('invoiceDocument.totals.tax')}{invoice.taxRate ? ` (${pctFromFraction(invoice.taxRate)}%)` : ''}</span>
                  <span className="tabular-nums text-foreground">{formatMoney(invoice.taxTotal, currency)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('invoiceDocument.totals.total')}</span>
                <span className="tabular-nums text-foreground">{formatMoney(invoice.total, currency)}</span>
              </div>
              {amountPaid > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('invoiceDocument.totals.paid')}</span>
                  <span className="tabular-nums text-foreground">{formatMoney(invoice.amountPaid, currency)}</span>
                </div>
              )}
              <div
                className="flex items-baseline justify-between border-t pt-3"
                style={{ borderColor: 'var(--doc-accent)' }}
              >
                <span className="text-sm font-semibold text-foreground">{t('invoiceDocument.totals.amountDue')}</span>
                <span
                  className="text-2xl font-semibold tabular-nums"
                  style={{ color: 'var(--doc-accent)' }}
                  data-testid="invoice-document-due"
                >
                  {formatMoney(invoice.balance, currency)}
                </span>
              </div>
            </div>
          </section>
        )}

        {/* ── Terms ──────────────────────────────────────────────── */}
        {invoice.termsAndConditions?.trim() && (
          <section className="space-y-2 border-t pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceDocument.terms')}</h3>
            <p className="max-w-prose whitespace-pre-wrap text-pretty text-xs leading-relaxed text-muted-foreground">
              {invoice.termsAndConditions.trim()}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

/** Preview-tab wrapper: resolves the customer name from the loaded org list (same
 *  source as InvoiceDetail), renders the document, and offers a PDF download. */
export default function InvoiceDocumentPreview({ detail }: { detail: InvoiceDetailData }) {
  const { t } = useTranslation('billing');
  const { invoice } = detail;
  const organizations = useOrgStore((s) => s.organizations);

  const customerName = useMemo(() => {
    const billTo = invoice.billToName?.trim();
    if (billTo) return billTo;
    const resolved = organizations.find((o) => o.id === invoice.orgId)?.name?.trim();
    // Never leak a raw org UUID fragment onto a customer-facing document — if the
    // org store hasn't resolved a name yet, show a neutral em-dash instead.
    return resolved || '—';
  }, [invoice.billToName, invoice.orgId, organizations]);

  const { download: downloadPdf, downloading: busy } = usePdfDownload({
    path: `/invoices/${invoice.id}/pdf`,
    filename: `${invoice.invoiceNumber ?? `invoice-${invoice.id}`}.pdf`,
    errorMessage: t('invoiceDocument.preview.downloadError'),
  });

  return (
    <div className="space-y-4" data-testid="invoice-preview">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('invoiceDocument.preview.description')}</p>
        <button
          type="button"
          onClick={() => void downloadPdf()}
          disabled={busy}
          data-testid="invoice-preview-download-pdf"
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? t('invoiceDocument.preview.preparing') : t('invoiceDocument.preview.downloadPdf')}
        </button>
      </div>
      <div className="rounded-xl bg-muted/30 p-2 sm:p-8">
        <InvoiceDocument detail={detail} customerName={customerName} />
      </div>
    </div>
  );
}
