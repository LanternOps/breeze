import type { useTranslation } from 'react-i18next';
import { showToast } from '../shared/Toast';

/** Aggregate outcome of a POST /tickets/bulk call. */
export interface BulkResult { updated: number; skipped: number; failed: number; total: number; skippedReasons?: Record<string, number> }

type TFunction = ReturnType<typeof useTranslation>['t'];

// Human-readable labels for bulk-skip reason codes returned by POST /tickets/bulk.
function skipReasonLabel(code: string, t: TFunction): string {
  const labels: Record<string, string> = {
    OUT_OF_SCOPE: t('tickets:ticketsPage.bulk.reason.outOfScope'),
    INVALID_TRANSITION: t('tickets:ticketsPage.bulk.reason.invalidTransition'),
    ASSIGNEE_NOT_FOUND: t('tickets:ticketsPage.bulk.reason.assigneeNotFound'),
    ASSIGNEE_WRONG_PARTNER: t('tickets:ticketsPage.bulk.reason.assigneeWrongPartner'),
    CONCURRENT_MODIFICATION: t('tickets:ticketsPage.bulk.reason.concurrentModification'),
    TICKET_PARTNER_UNRESOLVABLE: t('tickets:ticketsPage.bulk.reason.ticketPartnerUnresolvable'),
    OTHER: t('tickets:ticketsPage.bulk.reason.other'),
  };
  return labels[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

// Shared toast for a POST /tickets/bulk aggregate result. `verb` is the past-
// tense action word ('updated' for status/assign, 'deleted' for delete) so the
// message reads naturally. Failures are reported distinctly from skips: "skipped"
// implies pre-validation, "failed" means the write itself errored.
export function showBulkOutcomeToast(result: BulkResult, verb: string, t: TFunction): void {
  const { updated, skipped, failed, skippedReasons } = result;
  if (skipped + failed > 0) {
    const reasons = Object.entries(skippedReasons ?? {})
      .map(([code, n]) => t('tickets:ticketsPage.bulk.reasonCount', { count: n, reason: skipReasonLabel(code, t) }))
      .join(', ');
    showToast({
      type: 'warning',
      message: t('tickets:ticketsPage.bulk.partialToast', {
        updated,
        verb,
        skipped,
        failedSuffix: failed ? t('tickets:ticketsPage.bulk.failedSuffix', { failed }) : '',
        reasonsSuffix: reasons ? t('tickets:ticketsPage.bulk.reasonsSuffix', { reasons }) : '',
      }),
    });
  } else {
    showToast({ type: 'success', message: t('tickets:ticketsPage.bulk.successToast', { updated, verb }) });
  }
}
