import type { MarkTone } from '@/components/portal/ui';

/**
 * One tone per proposal status, shared by the list (dot mark), the signed-in
 * detail, and the public quote page (paper chips via markChipClass).
 *
 * A proposal that has merely been sent or opened needs nothing from the
 * customer yet, so those read informational, never amber. Declined and
 * expired are both terminal red; converted counts as accepted.
 */
export function quoteStatusTone(status: string): MarkTone {
  switch (status) {
    case 'accepted':
    case 'converted':
      return 'success';
    case 'declined':
    case 'expired':
      return 'destructive';
    case 'viewed':
    case 'sent':
      return 'primary';
    default:
      return 'neutral';
  }
}
