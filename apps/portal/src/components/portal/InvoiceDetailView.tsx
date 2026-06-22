import { withBase } from '@/lib/basePath';
import { useEffect, useState } from 'react';
import { ArrowLeft, AlertCircle, Download, CreditCard } from 'lucide-react';
import { type InvoiceDetail, type InvoiceStatus, buildPortalApiUrl, portalApi } from '@/lib/api';
import { STATUS_LABELS, statusColor } from '@/lib/invoiceStatus';
import { sellerLines } from '@/lib/sellerLines';
import { cn } from '@/lib/utils';

// Invoice statuses that can be paid online (mirrors the API's PAYABLE set).
const PAYABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(['sent', 'partially_paid', 'overdue']);

interface InvoiceDetailViewProps {
  detail: InvoiceDetail | null;
  error?: string | null;
}

function money(value: string | number, currencyCode: string): string {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return safe.toLocaleString('en-US', { style: 'currency', currency: currencyCode || 'USD' });
  } catch {
    return `${safe.toFixed(2)} ${currencyCode || ''}`.trim();
  }
}

function shortDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

export function InvoiceDetailView({ detail, error }: InvoiceDetailViewProps) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  // Verify-on-return settle state. 'idle' until we detect the post-Checkout return.
  const [settleState, setSettleState] = useState<'idle' | 'settling' | 'pending'>('idle');

  // Instant settle on return from Stripe Checkout. success_url lands the customer back
  // here as ?paid=1&session_id=cs_… — POST that session to the settle route so the
  // status flips to Paid immediately (the API-key model has no inbound webhook; the
  // reconcile sweep is the eventual backstop). Idempotent, so a stray re-run is safe.
  useEffect(() => {
    if (!detail) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('paid') !== '1') return;
    const sessionId = params.get('session_id');
    if (!sessionId) return;

    const invoiceId = detail.invoice.id;
    let cancelled = false;
    setSettleState('settling');
    void portalApi.settleInvoice(invoiceId, sessionId)
      .then((res) => {
        if (cancelled) return;
        if (res.data?.settled) {
          // Reload WITHOUT the return params (replace, not push) so the page re-fetches
          // fresh server data showing Paid — and a manual refresh won't re-trigger settle.
          window.location.replace(withBase(`/invoices/${invoiceId}`));
        } else {
          // Not yet settled (async method, or instant-settle hiccup) — the sweep will
          // catch it. Tell the customer rather than silently leaving it "Sent".
          setSettleState('pending');
        }
      })
      .catch(() => { if (!cancelled) setSettleState('pending'); });
    return () => { cancelled = true; };
  }, [detail]);

  if (error || !detail) {
    return (
      <div className="text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
        <h3 className="mt-4 text-lg font-medium">Invoice not found</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {error || 'The invoice you are looking for does not exist.'}
        </p>
        <a href={withBase("/invoices")} className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" />
          Back to invoices
        </a>
      </div>
    );
  }

  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;
  const canPay = PAYABLE_STATUSES.has(invoice.status) && Number(invoice.balance) > 0;

  const seller = invoice.sellerSnapshot ?? null;
  const sellerAddressLines = sellerLines(seller?.address ?? null);

  const payInvoice = async () => {
    if (paying) return;
    setPaying(true);
    setPayError(null);
    const result = await portalApi.payInvoice(invoice.id);
    if (result.data?.url) {
      window.location.href = result.data.url;
      return; // keep the button disabled while the browser navigates to Checkout
    }
    if (result.statusCode === 409) {
      // Terminal condition (online payment unavailable / invoice not payable). Show the
      // server's reason verbatim — "Please try again" would mislead since a retry won't help.
      setPayError(result.error || 'Online payment is not available for this invoice.');
    } else {
      setPayError(result.error || 'Could not start the payment. Please try again.');
    }
    setPaying(false);
  };

  const downloadPdf = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(buildPortalApiUrl(`/portal/invoices/${invoice.id}/pdf`), {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) {
        setDownloadError('Could not download the invoice PDF.');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.invoiceNumber ?? `invoice-${invoice.id}`}.pdf`;
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

  return (
    <div className="space-y-6">
      <a href={withBase("/invoices")} className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" />
        Back to invoices
      </a>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{invoice.invoiceNumber ?? 'Invoice'}</h1>
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <span className={cn('inline-flex rounded-full px-2 py-1 text-xs font-medium', statusColor(invoice.status))}>
              {STATUS_LABELS[invoice.status]}
            </span>
            <span>Issued {shortDate(invoice.issueDate)}</span>
            <span>·</span>
            <span>Due {shortDate(invoice.dueDate)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canPay && (
            <button
              type="button"
              onClick={() => void payInvoice()}
              disabled={paying}
              data-testid="invoice-pay-button"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <CreditCard className="h-4 w-4" />
              {paying ? 'Redirecting…' : 'Pay now'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void downloadPdf()}
            disabled={downloading}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50',
              canPay
                ? 'border text-foreground hover:bg-muted'
                : 'bg-primary text-primary-foreground'
            )}
          >
            <Download className="h-4 w-4" />
            {downloading ? 'Preparing…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {settleState === 'settling' && (
        <div className="rounded-md bg-warning/10 p-3 text-sm text-warning" data-testid="invoice-settle-confirming">
          Confirming your payment…
        </div>
      )}
      {settleState === 'pending' && (
        <div className="rounded-md bg-warning/10 p-3 text-sm text-warning" data-testid="invoice-settle-pending">
          Thanks! We're still confirming your payment — this can take a moment. Refresh shortly to see it applied.
        </div>
      )}
      {payError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="invoice-pay-error">{payError}</div>
      )}
      {downloadError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{downloadError}</div>
      )}

      <div className="flex flex-wrap gap-4">
        {invoice.billToName && (
          <div className="flex-1 rounded-lg border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bill to</p>
            <p className="mt-1 text-sm">{invoice.billToName}</p>
          </div>
        )}

        {seller?.name && (
          <div className="flex-1 rounded-lg border p-4" data-testid="invoice-from">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">From</p>
            <p className="mt-1 text-sm font-medium">{seller.name}</p>
            {sellerAddressLines.map((l, i) => <p key={i} className="text-sm text-muted-foreground">{l}</p>)}
            {seller.phone && <p className="text-sm text-muted-foreground">{seller.phone}</p>}
            {seller.email && <p className="text-sm text-muted-foreground">{seller.email}</p>}
            {seller.website && <p className="text-sm text-muted-foreground">{seller.website}</p>}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Description</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">Qty</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">Price</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-3 text-sm">{l.description}</td>
                <td className="px-4 py-3 text-right text-sm">{l.quantity}</td>
                <td className="px-4 py-3 text-right text-sm">{money(l.unitPrice, currency)}</td>
                <td className="px-4 py-3 text-right text-sm">{money(l.lineTotal, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ml-auto max-w-xs space-y-1 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{money(invoice.subtotal, currency)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>{money(invoice.taxTotal, currency)}</span></div>
        <div className="flex justify-between border-t pt-1 font-semibold"><span>Total</span><span>{money(invoice.total, currency)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span>{money(invoice.amountPaid, currency)}</span></div>
        <div className="flex justify-between border-t pt-1 font-semibold"><span>Balance due</span><span>{money(invoice.balance, currency)}</span></div>
      </div>

      {invoice.notes && (
        <div className="rounded-lg border p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{invoice.notes}</p>
        </div>
      )}

      {invoice.termsAndConditions && (
        <div className="rounded-lg border p-4" data-testid="invoice-terms-conditions">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Terms &amp; Conditions</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{invoice.termsAndConditions}</p>
        </div>
      )}
    </div>
  );
}

export default InvoiceDetailView;
