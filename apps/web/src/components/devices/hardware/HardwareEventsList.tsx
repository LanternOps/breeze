import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import type { HardwareEventView } from './types';
export default function HardwareEventsList({ events }: { events: HardwareEventView[] }) {
  const { t } = useTranslation('devices');
  return <details data-testid="hardware-events-list" className="border-t pt-3">
    <summary data-testid="hardware-events-toggle" className="cursor-pointer text-sm font-medium">
      {t('hardwareHealth.events')} ({events.length})
    </summary>
    {events.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t('hardwareHealth.noEvents')}</p>
      : <ol className="mt-3 space-y-3">{events.map(e => <li key={e.id}
        data-testid={`hardware-event-${e.id}`} className="grid gap-1 text-xs sm:grid-cols-[8rem_1fr]">
        <time dateTime={e.occurredAt} title={e.occurredAt}>{formatLastSeen(e.occurredAt)}</time>
        <div><p className="break-all font-medium">{e.componentKey}</p>
          <p>{e.eventType.replaceAll('_', ' ')} · {e.fromState ?? '—'} → {e.toState ?? '—'}</p>
          <p className="text-muted-foreground">{e.fromHealth ?? '—'} → {e.toHealth ?? '—'}</p>
          {Object.entries(e.detail).filter(([, value]) =>
            ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) =>
            <p key={key} className="break-words">{key}: {String(value)}</p>)}
        </div>
      </li>)}</ol>}
  </details>;
}
