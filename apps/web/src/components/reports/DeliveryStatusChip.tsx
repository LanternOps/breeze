import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * `report_runs.delivery_status` (multi-org report series W01, spec §3.2) —
 * mirrors `REPORT_DELIVERY_STATUSES` in `apps/api/src/db/schema/reports.ts`.
 * The web's one declaration: W03's `series/types.ts` re-exports it.
 */
export type ReportDeliveryStatus = 'sent' | 'partial' | 'no_recipients' | 'failed' | 'not_scheduled';

type WarningStatus = Extract<ReportDeliveryStatus, 'no_recipients' | 'partial' | 'failed'>;

function isWarning(status: ReportDeliveryStatus | null | undefined): status is WarningStatus {
  return status === 'no_recipients' || status === 'partial' || status === 'failed';
}

/**
 * A warning chip for a scheduled delivery that did not fully reach its
 * recipients. Renders nothing for 'sent', 'not_scheduled' (a manual run),
 * NULL (ad-hoc and pre-W01 runs) or an absent field.
 */
export function DeliveryStatusChip({
  status,
  testId,
  title,
  className,
}: {
  status: ReportDeliveryStatus | null | undefined;
  testId: string;
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation('reports');
  if (!isWarning(status)) return null;
  const label =
    status === 'no_recipients'
      ? t('reports.reportsList.delivery.noRecipients')
      : status === 'partial'
        ? t('reports.reportsList.delivery.partial')
        : t('reports.reportsList.delivery.failed');
  return (
    <span
      data-testid={testId}
      data-delivery-status={status}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning-strong',
        className,
      )}
    >
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
