import { useMemo, useState } from 'react';
import { providerMeta, type PsaProvider } from './PsaConnectionList';

export type PsaTicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';

export type PsaTicket = {
  id: string;
  provider: PsaProvider;
  externalId: string;
  status: PsaTicketStatus;
  alertTitle?: string;
  deviceName?: string;
  updatedAt: string | null;
};

type PsaTicketListProps = {
  tickets: PsaTicket[];
};

const statusConfig: Record<PsaTicketStatus, { label: string; className: string }> = {
  open: {
    label: 'Open',
    className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-400'
  },
  in_progress: {
    label: 'In Progress',
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400'
  },
  waiting: {
    label: 'Waiting',
    className: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'
  },
  resolved: {
    label: 'Resolved',
    className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400'
  },
  closed: {
    label: 'Closed',
    className: 'border-muted bg-muted text-muted-foreground'
  }
};

export default function PsaTicketList({ tickets }: PsaTicketListProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<PsaTicketStatus | 'all'>('all');

  const formatDate = (value: string | null) => {
    if (!value) return 'Unknown';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const statusOptions = useMemo(() => {
    const uniqueStatuses = Array.from(new Set(tickets.map(ticket => ticket.status)));
    return ['all', ...uniqueStatuses] as const;
  }, [tickets]);

  const filteredTickets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return tickets.filter(ticket => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : ticket.externalId.toLowerCase().includes(normalizedQuery) ||
          (ticket.alertTitle ?? '').toLowerCase().includes(normalizedQuery) ||
          (ticket.deviceName ?? '').toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : ticket.status === statusFilter;

      return matchesQuery && matchesStatus;
    });
  }, [tickets, query, statusFilter]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Synced Tickets</h2>
          <p className="text-sm text-muted-foreground">
            {filteredTickets.length} of {tickets.length} tickets
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder="Search tickets"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as PsaTicketStatus | 'all')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
          >
            {statusOptions.map(status => (
              <option key={status} value={status}>
                {status === 'all' ? 'All statuses' : statusConfig[status as PsaTicketStatus].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Ticket</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Linked Alert</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredTickets.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <div className="space-y-2">
                    <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                      <svg className="h-6 w-6 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M7 8h10M7 12h4m1 8h6a2 2 0 002-2V6a2 2 0 00-2-2H8l-4 4v10a2 2 0 002 2h2"
                        />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-muted-foreground">No PSA tickets synced</p>
                    <p className="text-sm text-muted-foreground">
                      {tickets.length === 0
                        ? 'Sync your first PSA connection to see tickets here.'
                        : 'No tickets match your search or filters.'}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              filteredTickets.map(ticket => {
                const statusStyle = statusConfig[ticket.status];
                return (
                  <tr key={ticket.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm font-medium">
                      <div className="flex flex-col">
                        <span>{ticket.externalId}</span>
                        <span className="text-xs text-muted-foreground">
                          {providerMeta[ticket.provider].label}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyle.className}`}>
                        {statusStyle.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {ticket.alertTitle || 'Unlinked'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {ticket.deviceName || 'Unlinked'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDate(ticket.updatedAt)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
