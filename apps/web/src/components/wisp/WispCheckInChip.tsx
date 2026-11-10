import { useTranslation } from 'react-i18next';
import { Clock, X } from 'lucide-react';
import type { WispCheckIn } from '@breeze/shared';

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY_AND_TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The due time in the viewer's local time zone. A check-in can be up to 7
 * days out, so one due on a later day names the day too: "14:32" alone would
 * read as today.
 */
function dueLabel(dueAt: string, now: Date): string {
  const due = new Date(dueAt);
  return due.toDateString() === now.toDateString() ? TIME.format(due) : DAY_AND_TIME.format(due);
}

/**
 * Wisp check-in timers W05 (#10996, spec §5): "Wisp will check back at 14:32"
 * under the last turn, one row per `scheduled` check-in, each with a cancel ×.
 * Fired, consumed and cancelled rows are not timers any more; nothing renders
 * when no row is scheduled.
 */
export default function WispCheckInChip({
  checkIns,
  onCancel,
}: {
  checkIns: WispCheckIn[];
  onCancel: (id: string) => void;
}) {
  const { t } = useTranslation('ai');
  const scheduled = checkIns.filter((c) => c.status === 'scheduled');
  if (scheduled.length === 0) return null;
  const now = new Date();
  return (
    <ul className="mx-3 mb-2 flex flex-wrap gap-2" aria-live="polite">
      {scheduled.map((checkIn) => (
        <li
          key={checkIn.id}
          data-testid="wisp-check-in-chip"
          data-check-in-id={checkIn.id}
          title={checkIn.instruction}
          className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs text-muted-foreground"
        >
          <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{t('wisp.checkIn.scheduledAt', { time: dueLabel(checkIn.dueAt, now) })}</span>
          <button
            type="button"
            data-testid="wisp-check-in-cancel"
            aria-label={t('wisp.checkIn.cancel')}
            title={t('wisp.checkIn.cancel')}
            onClick={() => onCancel(checkIn.id)}
            className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
