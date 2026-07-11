import { useMemo, useState } from 'react';
import { providerMeta, type PsaProvider } from './PsaConnectionList';
import { useTranslation } from 'react-i18next';

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
  timezone?: string;
};

const statusConfig: Record<PsaTicketStatus, { labelKey: string; className: string }> = {
  open: {
    labelKey: 'longTail.psa.PsaTicketList.status.open',
    className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-400'
  },
  in_progress: {
    labelKey: 'longTail.psa.PsaTicketList.status.inProgress',
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400'
  },
  waiting: {
    labelKey: 'longTail.psa.PsaTicketList.status.waiting',
    className: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'
  },
  resolved: {
    labelKey: 'longTail.psa.PsaTicketList.status.resolved',
    className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400'
  },
  closed: {
    labelKey: 'longTail.psa.PsaTicketList.status.closed',
    className: 'border-muted bg-muted text-muted-foreground'
  }
};

export default function PsaTicketList({ tickets, timezone }: PsaTicketListProps) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<PsaTicketStatus | 'all'>('all');

  const formatDate = (value: string | null) => {
    if (!value) return t('common:states.unknown');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { timeZone: timezone });
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
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('longTail.psa.PsaTicketList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('longTail.psa.PsaTicketList.ticketCount', { filtered: filteredTickets.length, total: tickets.length })}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder={t('longTail.psa.PsaTicketList.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as PsaTicketStatus | 'all')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-40"
          >
            {statusOptions.map(status => (
              <option key={status} value={status}>
                {status === 'all' ? t('longTail.psa.PsaTicketList.filters.allStatuses') : t(statusConfig[status as PsaTicketStatus].labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('longTail.psa.PsaTicketList.headers.ticket')}</th>
              <th className="px-4 py-3">{t('common:labels.status')}</th>
              <th className="px-4 py-3">{t('longTail.psa.PsaTicketList.headers.linkedAlert')}</th>
              <th className="px-4 py-3">{t('common:labels.device')}</th>
              <th className="px-4 py-3">{t('longTail.psa.PsaTicketList.headers.updated')}</th>
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
                    <p className="text-sm font-medium text-muted-foreground">{t('longTail.psa.PsaTicketList.empty.title')}</p>
                    <p className="text-sm text-muted-foreground">
                      {tickets.length === 0
                        ? t('longTail.psa.PsaTicketList.empty.noTickets')
                        : t('longTail.psa.PsaTicketList.empty.noMatches')}
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
                        {t(statusStyle.labelKey)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {ticket.alertTitle || t('longTail.psa.PsaTicketList.unlinked')}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {ticket.deviceName || t('longTail.psa.PsaTicketList.unlinked')}
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
