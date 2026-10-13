import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { TICKET_TYPE_CHIP_CLASS, isTicketType, ticketTypeLabelKey, type TicketType } from './ticketType';

interface Props {
  /** Absent/unknown reads as Incident: pre-#7900 rows and older payloads. */
  type: TicketType | string | null | undefined;
  testId?: string;
  className?: string;
}

/** Read-only ticket-type badge shared by the queue rows, workbench and links card. */
export default function TicketTypeChip({ type, testId, className }: Props) {
  const { t } = useTranslation('tickets');
  const resolved: TicketType = isTicketType(type) ? type : 'incident';
  return (
    <span
      data-testid={testId}
      data-ticket-type={resolved}
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        TICKET_TYPE_CHIP_CLASS[resolved],
        className
      )}
    >
      {t(/* i18n-dynamic */ ticketTypeLabelKey(resolved))}
    </span>
  );
}
