import type { InvoiceStatus } from '@/lib/api';
import type { MarkTone } from '@/components/portal/ui';

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
// compile error here rather than silently falling through to neutral.
//
// Amber is reserved for states the customer should actually act on (overdue,
// partially paid). 'sent' is informational: a freshly issued invoice that isn't
// due for another 30 days must not read as a warning to the person who owes it.
// The list renders the tone as a StatusMark dot; documents keep a stamped chip
// (markChipClass) — same tone, two presentations.
const STATUS_TONES: Record<InvoiceStatus, MarkTone> = {
  draft: 'neutral',
  sent: 'primary',
  partially_paid: 'warning',
  overdue: 'destructive',
  paid: 'success',
  void: 'neutral',
};

export function statusTone(status: InvoiceStatus): MarkTone {
  return STATUS_TONES[status];
}
