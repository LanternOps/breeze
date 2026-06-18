import { withBase } from '@/lib/basePath';
import { Receipt, AlertCircle } from 'lucide-react';
import { type InvoiceSummary, type InvoiceStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

interface InvoiceListProps {
  invoices: InvoiceSummary[];
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

export function InvoiceList({ invoices, error }: InvoiceListProps) {
  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-center text-destructive">
        <AlertCircle className="mx-auto h-8 w-8" />
        <p className="mt-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Invoices</h2>
      </div>

      {invoices.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center">
          <Receipt className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium">No invoices</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You don't have any invoices yet.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Number</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Issued</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Due</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">Total</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">Balance</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <a className="font-medium hover:underline" href={withBase(`/invoices/${inv.id}`)}>
                      {inv.invoiceNumber ?? inv.id.slice(0, 8)}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{shortDate(inv.issueDate)}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{shortDate(inv.dueDate)}</td>
                  <td className="px-4 py-3 text-right text-sm">{money(inv.total, inv.currencyCode)}</td>
                  <td className="px-4 py-3 text-right text-sm">{money(inv.balance, inv.currencyCode)}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex rounded-full px-2 py-1 text-xs font-medium', statusColor(inv.status))}>
                      {STATUS_LABELS[inv.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default InvoiceList;
