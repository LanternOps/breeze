import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import type { DeviceTimeStatusView } from './types';
export default function TimeEventsList({
  events,
}: {
  events: DeviceTimeStatusView['recentEvents'];
}) {
  const { t } = useTranslation('devices');
  return (
    <details data-testid="time-events" className="rounded-md border p-3">
      <summary
        data-testid="time-events-toggle"
        className="cursor-pointer font-medium"
      >
        {t('timeSync.events', { count: events.length })}
      </summary>
      {events.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('timeSync.noEvents')}
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {events.map((event) => (
            <li
              key={event.recordId}
              data-testid={`time-event-${event.recordId}`}
              className="text-sm"
            >
              <div className="text-muted-foreground">
                {t('timeSync.eventHeading', {
                  id: event.eventId,
                  level: event.level,
                })}
                {' · '}
                <time dateTime={event.occurredAt} title={event.occurredAt}>
                  {formatLastSeen(event.occurredAt)}
                </time>
              </div>
              <p className="whitespace-pre-wrap break-words">
                {event.message || t('timeSync.noMessage')}
              </p>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
