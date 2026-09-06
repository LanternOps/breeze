import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { navigateTo } from '@/lib/navigation';
import { fetchTicketConfig, type TicketConfig } from '@/lib/ticketConfigApi';
import TicketQueueList from '../../tickets/TicketQueueList';
import type { TicketSummary } from '../../tickets/ticketConfig';
import { useLatest, type OrgFetch } from './orgRecordFetch';

export interface OrgTicketsTabProps {
  orgId: string;
  orgFetch: OrgFetch;
}

type StatusTab = 'open' | 'all' | 'closed';
const STATUS_TABS: readonly StatusTab[] = ['open', 'all', 'closed'] as const;

// Mirrors `tabQuery` in TicketsPage.tsx, collapsed to the three groupings this
// embedded queue offers (the full page's mine/unassigned/breaching splits
// don't make sense scoped to a single org's ticket count).
function tabQuery(tab: StatusTab): string {
  switch (tab) {
    case 'open': return 'statusGroup=open';
    case 'closed': return 'statusGroup=closed&sort=newest';
    case 'all': return 'sort=newest';
  }
}

const PAGE_LIMIT = 100;

/** `'failed'` = a genuine load error (network/non-2xx other than 403);
 *  `'forbidden'` = the caller lacks `tickets:read` for this org — retrying
 *  cannot succeed, so it gets its own non-retryable message (mirrors the
 *  `forbidden` state InvoicesPage/QuotesPage already carry). */
type LoadOutcome = TicketSummary[] | 'failed' | 'forbidden';

/**
 * The record's Tickets tab (#5075 W03).
 *
 * Every request is pinned to the record's org via `orgFetch`, never the
 * ambient switcher — same guarantee OrgOverviewTab's feeds hold.
 *
 * `GET /ticket-config` is deliberately fetched through the shared, ambient-
 * scoped `fetchTicketConfig()` cache rather than `orgFetch`: ticket
 * configuration (custom statuses, priority labels) is partner-wide, not
 * per-org, so pinning it to this org would just bypass the module cache for a
 * result that's identical either way.
 */
export default function OrgTicketsTab({ orgId, orgFetch }: OrgTicketsTabProps) {
  const { t } = useTranslation('organizations');
  const [tab, setTab] = useState<StatusTab>('open');
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'failed' | 'forbidden' | null>(null);
  const [config, setConfig] = useState<TicketConfig | null>(null);
  const ticketsLatest = useLatest<LoadOutcome>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams(tabQuery(tab));
    params.set('limit', String(PAGE_LIMIT));
    // The `.catch` is chained INSIDE the promise handed to `run` — not after
    // it — so a rejection from an already-superseded request (e.g. the user
    // flipped tabs again while this one was still in flight) is caught before
    // `useLatest`'s seq/mounted check runs, and is correctly dropped as stale
    // rather than clobbering a newer, successful render with a stale error.
    const result = await ticketsLatest.run(
      orgFetch(`/tickets?${params.toString()}`)
        .then(async (res) => {
          if (res.status === 403) return 'forbidden' as const;
          if (!res.ok) return 'failed' as const;
          const body = (await res.json()) as { data?: TicketSummary[]; pagination?: { total?: number } };
          setTotal(body.pagination?.total ?? null);
          return (body.data ?? []) as TicketSummary[];
        })
        .catch(() => 'failed' as const),
    );
    if (result === undefined) return; // superseded by a later call
    if (result === 'failed' || result === 'forbidden') {
      setError(result);
      setTickets([]);
      setTotal(null);
    } else {
      setTickets(result);
    }
    setLoading(false);
  }, [orgFetch, tab, ticketsLatest]);

  useEffect(() => {
    void load();
  }, [load, orgId]);

  useEffect(() => {
    let cancelled = false;
    void fetchTicketConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const newTicketHref = `/tickets/new#orgId=${orgId}`;
  const truncated = total !== null && total > tickets.length;

  return (
    <div data-testid="org-tickets-tab" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div
          className="flex items-center gap-1 border-b"
          data-testid="org-tickets-status-tabs"
          role="tablist"
        >
          {STATUS_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              data-testid={`org-tickets-tab-${id}`}
              className={cn(
                'border-b-2 px-3 py-2 text-sm font-medium -mb-px',
                tab === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(/* i18n-dynamic */ `orgRecord.tickets.tabs.${id}`)}
            </button>
          ))}
        </div>
        <a
          href={newTicketHref}
          data-testid="org-tickets-new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> {t('orgRecord.tickets.newTicket')}
        </a>
      </div>

      {error === 'forbidden' ? (
        <div className="rounded-lg border px-4 py-8 text-center" data-testid="org-tickets-forbidden">
          <p className="text-sm text-muted-foreground">{t('orgRecord.tickets.forbidden')}</p>
        </div>
      ) : error === 'failed' ? (
        <div className="rounded-lg border px-4 py-8 text-center" data-testid="org-tickets-error">
          <p className="text-sm text-muted-foreground">{t('orgRecord.tickets.loadFailed')}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('orgRecord.actions.retry')}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border">
          <TicketQueueList
            tickets={tickets}
            selectedId={null}
            onSelect={(ticket) => void navigateTo(`/tickets/${ticket.id}`)}
            loading={loading}
            config={config}
            hideOrg
          />
          {truncated && (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground" data-testid="org-tickets-truncated-note">
              {t('orgRecord.tickets.truncated', { shown: tickets.length, total })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
