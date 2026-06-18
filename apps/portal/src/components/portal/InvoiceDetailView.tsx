import { withBase } from '@/lib/basePath';
import { useState } from 'react';
import { ArrowLeft, AlertCircle, Download, CreditCard } from 'lucide-react';
import { type InvoiceDetail, type InvoiceStatus, buildPortalApiUrl, portalApi } from '@/lib/api';
import { cn } from '@/lib/utils';

// Invoice statuses that can be paid online (mirrors the API's PAYABLE set).
const PAYABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(['sent', 'partially_paid', 'overdue']);

interface InvoiceDetailViewProps {
  detail: InvoiceDetail | null;
  error?: string | null;
}

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partially_paid: 'Partially paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

function statusColor(status: InvoiceStatus): string {
  switch (status) {
    case 'paid':
      return 'bg-success/10 text-success';
    case 'overdue':
      return 'bg-destructive/10 text-destructive';
    case 'partially_paid':
    case 'sent':
      return 'bg-warning/10 text-warning';
    default:
      return 'bg-muted text-muted-foreground';
  }
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

      {payError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="invoice-pay-error">{payError}</div>
      )}
      {downloadError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{downloadError}</div>
      )}

      {invoice.billToName && (
        <div className="rounded-lg border p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bill to</p>
          <p className="mt-1 text-sm">{invoice.billToName}</p>
        </div>
      )}

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
    </div>
  );
}

export default InvoiceDetailView;
