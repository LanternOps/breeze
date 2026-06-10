import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import SlaChip from './SlaChip';
import { statusConfig, priorityConfig, type TicketSummary } from './ticketConfig';
import { cn } from '@/lib/utils';

export default function DeviceTicketsTab({ deviceId }: { deviceId: string }) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(false);
      try {
        const res = await fetchWithAuth(`/tickets?deviceId=${deviceId}&limit=50&sort=newest`);
        if (res.ok) {
          const body = await res.json();
          if (!cancelled) setTickets((body.data ?? []) as TicketSummary[]);
        } else if (!cancelled) {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground" data-testid="device-tickets-loading">Loading tickets...</p>;
  }
  if (error) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="device-tickets-error">
        Tickets failed to load.
      </p>
    );
  }
  if (tickets.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="device-tickets-empty">
        No tickets for this device.
      </p>
    );
  }

  return (
    <ul className="divide-y" data-testid="device-tickets-list">
      {tickets.map((t) => (
        <li key={t.id}>
          <a
            href={`/tickets/${t.id}`}
            className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/50"
            data-testid={`device-ticket-row-${t.id}`}
          >
            <span className="font-mono text-xs text-muted-foreground">{t.internalNumber}</span>
            <span className="truncate font-medium">{t.subject}</span>
            <span className={cn('ml-auto inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium', statusConfig[t.status].color)}>
              {statusConfig[t.status].label}
            </span>
            <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium', priorityConfig[t.priority].color)}>
              {priorityConfig[t.priority].label}
            </span>
            <SlaChip ticket={t} />
          </a>
        </li>
      ))}
    </ul>
  );
}
