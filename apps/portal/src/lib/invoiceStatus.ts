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
//
// Amber is reserved for states the customer should actually act on (overdue,
// partially paid). 'sent' is informational: a freshly issued invoice that isn't
// due for another 30 days must not read as a warning to the person who owes it.
//
// Statuses render as a StatusMark (ui.tsx): a dot of the background-tuned
// status token beside text in the `-on-tint` foreground, which is the pairing
// tokenContrast.test.ts asserts AA-safe directly on the page surface.
const STATUS_DOTS: Record<InvoiceStatus, string> = {
  draft: 'bg-muted-foreground/60',
  sent: 'bg-primary',
  partially_paid: 'bg-warning',
  overdue: 'bg-destructive',
  paid: 'bg-success',
  void: 'bg-muted-foreground/60',
};

const STATUS_TEXT: Record<InvoiceStatus, string> = {
  draft: 'text-muted-foreground',
  sent: 'text-primary-on-tint',
  partially_paid: 'text-warning-on-tint',
  overdue: 'text-destructive-on-tint',
  paid: 'text-success-on-tint',
  void: 'text-muted-foreground',
};

export function statusDot(status: InvoiceStatus): string {
  return STATUS_DOTS[status];
}

export function statusText(status: InvoiceStatus): string {
  return STATUS_TEXT[status];
}

// Documents (InvoiceDetailView via documentShell) keep the tinted-chip
// presentation: they are pinned to paper ([data-doc-theme]) and a printed
// register wants a stamped chip, not the ledger's dot. Foregrounds use the
// `-on-tint` tokens because the base status tokens are tuned as backgrounds
// and fail WCAG AA as text on their own /10 tint.
const STATUS_CHIPS: Record<InvoiceStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-primary/10 text-primary-on-tint',
  partially_paid: 'bg-warning/10 text-warning-on-tint',
  overdue: 'bg-destructive/10 text-destructive-on-tint',
  paid: 'bg-success/10 text-success-on-tint',
  void: 'bg-muted text-muted-foreground',
};

export function statusColor(status: InvoiceStatus): string {
  return STATUS_CHIPS[status];
}
