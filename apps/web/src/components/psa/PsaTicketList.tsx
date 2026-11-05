import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { providerMeta, type PsaConnection } from './PsaConnectionList';
import { useTranslation } from 'react-i18next';
import { FilterSelect } from '../shared/FilterSelect';
import { secureExternalTicketUrl } from '../../lib/secureExternalTicketUrl';

/**
 * A row of GET /psa/tickets (mapTicketRow in apps/api/src/routes/psa.ts): the
 * alert-ticket ledger. It has no synced PSA status (`status` is null until a
 * worker writes one, #9655) and no provider, alert title or device name, so
 * none of those are read here. Fields are loose because the API's states are
 * open-ended strings; an unrecognized value renders as itself.
 */
export type PsaTicket = {
  id: string;
  title?: string | null;
  connectionId?: string | null;
  alertId?: string | null;
  createState?: string | null;
  externalTicketNumber?: string | null;
  externalTicketUrl?: string | null;
  syncedAt?: string | null;
  raw?: { externalTicketId?: string | null } | null;
};

type PsaTicketListProps = {
  tickets: PsaTicket[];
  /** Resolves each ticket's `connectionId` to its provider. */
  connections?: Pick<PsaConnection, 'id' | 'provider'>[];
  timezone?: string;
};

const SUCCESS_CLASS = 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400';
const WARNING_CLASS = 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400';
const ERROR_CLASS = 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400';
const NEUTRAL_CLASS = 'border-muted bg-muted text-muted-foreground';

const createStateClass = (state: string | null | undefined): string => {
  switch (state) {
    case 'created':
      return SUCCESS_CLASS;
    case 'failed':
    case 'rejected':
      return ERROR_CLASS;
    case 'needs_attention':
    case 'create_outcome_unknown':
      return WARNING_CLASS;
    default:
      return NEUTRAL_CLASS;
  }
};

export default function PsaTicketList({ tickets, connections = [], timezone }: PsaTicketListProps) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('all');

  const formatDate = (value: string | null | undefined) => {
    if (!value) return t('common:states.unknown');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { timeZone: timezone });
  };

  const createStateLabel = (state: string) =>
    t(/* i18n-dynamic */ `longTail.psa.PsaAlertTicketingActivity.states.${state}`, { defaultValue: state });

  const providerLabelByConnection = useMemo(
    () => new Map(connections.map(connection => [connection.id, providerMeta[connection.provider]?.label ?? connection.provider])),
    [connections]
  );

  const stateOptions = useMemo(
    () => Array.from(new Set(tickets.flatMap(ticket => (ticket.createState ? [ticket.createState] : [])))),
    [tickets]
  );

  const filteredTickets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return tickets.filter(ticket => {
      const searchable = [
        ticket.externalTicketNumber,
        ticket.raw?.externalTicketId,
        ticket.title,
        ticket.connectionId ? providerLabelByConnection.get(ticket.connectionId) : undefined
      ];
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : searchable.some(value => value?.toLowerCase().includes(normalizedQuery));
      const matchesState = stateFilter === 'all' ? true : ticket.createState === stateFilter;

      return matchesQuery && matchesState;
    });
  }, [tickets, query, stateFilter, providerLabelByConnection]);

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
          <FilterSelect
            label={t('longTail.psa.PsaTicketList.filters.statusFilterLabel')}
            value={stateFilter}
            onChange={event => setStateFilter(event.target.value)}
            className="w-full sm:w-40"
          >
            <option value="all">{t('longTail.psa.PsaTicketList.filters.allStatuses')}</option>
            {stateOptions.map(state => (
              <option key={state} value={state}>
                {createStateLabel(state)}
              </option>
            ))}
          </FilterSelect>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('longTail.psa.PsaTicketList.headers.ticket')}</th>
              <th className="px-4 py-3">{t('longTail.psa.PsaConnectionList.headers.provider')}</th>
              <th className="px-4 py-3">{t('common:labels.status')}</th>
              <th className="px-4 py-3">{t('longTail.psa.PsaTicketList.headers.linkedAlert')}</th>
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
                // A row whose create never reached the PSA has no external
                // identity yet; its title is then the only name it has.
                const ticketLabel = ticket.externalTicketNumber || ticket.raw?.externalTicketId;
                const href = secureExternalTicketUrl(ticket.externalTicketUrl);
                const providerLabel = ticket.connectionId ? providerLabelByConnection.get(ticket.connectionId) : undefined;
                return (
                  <tr key={ticket.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm font-medium">
                      <div className="flex flex-col">
                        {ticketLabel && href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="break-all">{ticketLabel}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          </a>
                        ) : (
                          <span className="break-all">{ticketLabel || ticket.title || t('common:states.unknown')}</span>
                        )}
                        {ticketLabel && ticket.title && (
                          <span className="text-xs font-normal text-muted-foreground">{ticket.title}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {providerLabel ?? t('common:states.unknown')}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${createStateClass(ticket.createState)}`}>
                        {ticket.createState ? createStateLabel(ticket.createState) : t('common:states.unknown')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {ticket.alertId ? (
                        <a href={`/alerts/${ticket.alertId}`} className="text-primary underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring">
                          {t('longTail.psa.PsaAlertTicketingActivity.viewAlert')}
                        </a>
                      ) : (
                        t('longTail.psa.PsaTicketList.unlinked')
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDate(ticket.syncedAt)}
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
