import type { InvoiceStatus } from '@/lib/api';

// Customer-facing invoice status display, shared by InvoiceList and
// InvoiceDetailView (previously duplicated in both). Keyed by the SSOT
// InvoiceStatus (@breeze/shared) so an added status fails to compile here.
export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partially_paid: 'Partially paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

// Keyed by the SSOT InvoiceStatus (not a switch/default) so adding a status is a
// compile error here rather than silently falling through to the muted style.
const STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-warning/10 text-warning',
  partially_paid: 'bg-warning/10 text-warning',
  overdue: 'bg-destructive/10 text-destructive',
  paid: 'bg-success/10 text-success',
  void: 'bg-muted text-muted-foreground',
};

export function statusColor(status: InvoiceStatus): string {
  return STATUS_COLORS[status];
}
