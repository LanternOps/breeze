import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import SlaChip from './SlaChip';
import { statusConfig, priorityConfig, type TicketSummary } from './ticketConfig';
import { cn } from '@/lib/utils';

export default function DeviceTicketsTab({ deviceId }: { deviceId: string }) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth(`/tickets?deviceId=${deviceId}&limit=50&sort=newest`);
      if (res.ok) {
        const body = await res.json();
        setTickets((body.data ?? []) as TicketSummary[]);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground" data-testid="device-tickets-loading">Loading tickets...</p>;
  }
  if (error) {
    return (
      <div className="p-4 text-center" data-testid="device-tickets-error">
        <p className="text-sm text-muted-foreground">Tickets failed to load.</p>
        <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="device-tickets-retry">Retry</button>
      </div>
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
