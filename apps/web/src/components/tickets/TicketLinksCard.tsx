import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { Link2, Plus, X } from 'lucide-react';
import { ticketLinkLabel, type TicketLinkLabel, type TicketLinkType } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { cn } from '@/lib/utils';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { statusConfig, type TicketStatus } from './ticketConfig';
import TicketTypeChip from './TicketTypeChip';
import { isTicketType, type TicketType } from './ticketType';

/**
 * Web-side view of GET /tickets/:id/links (`TicketLinkView` in the API's
 * ticketLinkService; kept local on purpose so the API service is not a web
 * dependency). Counterparts the caller cannot see are already omitted
 * server-side; a soft-deleted one is listed with `deleted: true` (#8679) so the
 * link stays removable.
 */
interface TicketLinkRow {
  id: string;
  direction: 'outgoing' | 'incoming';
  linkType: TicketLinkType;
  other: {
    id: string;
    ticketNumber: string;
    subject: string;
    status: TicketStatus;
    ticketType: TicketType | string | null;
    /** Soft-deleted counterpart (#8679): shown, not linked, still removable. */
    deleted?: boolean;
  };
}

interface SearchHit {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: TicketStatus;
  ticketType?: TicketType;
}

interface Props {
  ticketId: string;
  /** The ticket's org: link targets are same-org only, so the search is scoped to it. */
  orgId: string;
  ticketType?: TicketType;
  /** tickets:write. Read-only users see the links but no add/remove controls. */
  canWrite: boolean;
}

// Display order of the derived labels (one group each).
const GROUP_ORDER: TicketLinkLabel[] = [
  'caused_by',
  'causes',
  'resolves',
  'resolved_by',
  'duplicate_of',
  'duplicates',
  'related',
];

// Link types a user can create, as read from THIS ticket ("this ticket is <x>
// the picked one"). Order is the dialog's option order.
const ADD_TYPES: TicketLinkType[] = ['related', 'caused_by', 'resolves', 'duplicate_of'];

// API error codes (TicketLinkErrorCode) → localized message key. Anything else
// falls through to the server message / generic fallback.
const ERROR_KEYS: Record<string, string> = {
  ALREADY_LINKED: 'ticketLinks.errors.ALREADY_LINKED',
  LINK_CYCLE: 'ticketLinks.errors.LINK_CYCLE',
  LINK_LIMIT: 'ticketLinks.errors.LINK_LIMIT',
  SOURCE_ALREADY_DUPLICATE: 'ticketLinks.errors.SOURCE_ALREADY_DUPLICATE',
  SOURCE_HAS_DUPLICATES: 'ticketLinks.errors.SOURCE_HAS_DUPLICATES',
  DUPLICATE_TARGET_IS_DUPLICATE: 'ticketLinks.errors.DUPLICATE_TARGET_IS_DUPLICATE',
  CROSS_ORG: 'ticketLinks.errors.CROSS_ORG',
  SELF_LINK: 'ticketLinks.errors.SELF_LINK',
  NOT_FOUND: 'ticketLinks.errors.NOT_FOUND',
};

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_LIMIT = 10;

export default function TicketLinksCard({ ticketId, orgId, ticketType, canWrite }: Props) {
  const { t } = useTranslation('tickets');
  const [links, setLinks] = useState<TicketLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadSeq = useRef(0);

  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<TicketLinkType>('related');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [picked, setPicked] = useState<SearchHit | null>(null);
  const [adding, setAdding] = useState(false);

  const [removing, setRemoving] = useState<TicketLinkRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/tickets/${encodeURIComponent(ticketId)}/links`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) throw new Error('malformed');
      if (seq !== loadSeq.current) return;
      setLinks(body.data as TicketLinkRow[]);
      setLoadFailed(false);
    } catch (err) {
      console.error('[TicketLinksCard] failed to load links', err);
      // A failed load must not read as "no links": that would hide the very
      // links that explain a later LINK_LIMIT / duplicate refusal.
      if (seq !== loadSeq.current) return;
      setLoadFailed(true);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    setLinks([]);
    setLoadFailed(false);
    setAddOpen(false);
    setRemoving(null);
    void load();
  }, [load]);

  // Reset the add dialog whenever it opens.
  useEffect(() => {
    if (!addOpen) return;
    setAddType('related');
    setQuery('');
    setHits([]);
    setPicked(null);
    setSearchFailed(false);
  }, [addOpen]);

  // Debounced, org-scoped ticket search. Excludes the current ticket client-side
  // (the endpoint has no exclude param).
  useEffect(() => {
    if (!addOpen || picked) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ orgId, search: q, limit: String(SEARCH_RESULT_LIMIT * 2) });
          const res = await fetchWithAuth(`/tickets?${params.toString()}`);
          if (!res.ok) throw new Error(String(res.status));
          const body = (await res.json()) as { data?: SearchHit[] };
          if (cancelled) return;
          if (!Array.isArray(body.data)) throw new Error('malformed');
          const rows = body.data.filter((r) => r.id !== ticketId);
          setHits(rows.slice(0, SEARCH_RESULT_LIMIT));
          setSearchFailed(false);
        } catch {
          if (cancelled) return;
          setHits([]);
          setSearchFailed(true);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [addOpen, picked, query, orgId, ticketId]);

  const friendly = useCallback(
    (code: string) => (ERROR_KEYS[code] ? t(/* i18n-dynamic */ ERROR_KEYS[code]) : undefined),
    [t],
  );
  const onUnauthorized = () => void navigateTo(loginPathWithNext(), { replace: true });

  const submitAdd = async () => {
    if (!picked || adding) return;
    setAdding(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/tickets/${encodeURIComponent(ticketId)}/links`, {
            method: 'POST',
            body: JSON.stringify({ targetTicketId: picked.id, linkType: addType }),
          }),
        errorFallback: t('ticketLinks.addFailed'),
        successMessage: t('ticketLinks.added'),
        friendly,
        onUnauthorized,
      });
      setAddOpen(false);
      await load();
    } catch (err) {
      // runAction already toasted ActionErrors; the dialog stays open so the
      // user can pick another ticket or type. A 404/409 means our list is out
      // of date (another user changed the links), so refresh it behind the dialog.
      handleActionError(err, t('ticketLinks.addFailed'));
      if (err instanceof ActionError && (err.status === 404 || err.status === 409)) void load();
    } finally {
      setAdding(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing || removeBusy) return;
    const target = removing;
    setRemoveBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/tickets/${encodeURIComponent(ticketId)}/links/${encodeURIComponent(target.id)}`, {
            method: 'DELETE',
          }),
        errorFallback: t('ticketLinks.removeFailed'),
        successMessage: t('ticketLinks.removed'),
        // A 404 on DELETE means the LINK is gone (removed by someone else), not a ticket.
        friendly: (code, message, body) =>
          code === 'NOT_FOUND' ? t('ticketLinks.errors.LINK_GONE') : friendly(code),
        onUnauthorized,
      });
      setRemoving(null);
      await load();
    } catch (err) {
      handleActionError(err, t('ticketLinks.removeFailed'));
      setRemoving(null);
      // The link may already be gone or changed; show the real state.
      void load();
    } finally {
      setRemoveBusy(false);
    }
  };

  const groups = useMemo(() => {
    const byLabel = new Map<TicketLinkLabel, TicketLinkRow[]>();
    for (const row of links) {
      const label = ticketLinkLabel(row.linkType, row.direction);
      const list = byLabel.get(label) ?? [];
      list.push(row);
      byLabel.set(label, list);
    }
    return GROUP_ORDER.filter((l) => byLabel.has(l)).map((label) => ({ label, rows: byLabel.get(label)! }));
  }, [links]);

  // Decision 4: no server rollup; the count is computed from the visible links.
  const incidentCount = useMemo(
    () => links.filter((l) => l.other.ticketType === 'incident').length,
    [links],
  );

  const inputClass = 'w-full rounded-md border bg-background px-2 py-1.5 text-sm';

  return (
    <section className="rounded-lg border p-3" data-testid="ticket-links-card" aria-label={t('ticketLinks.title')}>
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{t('ticketLinks.title')}</h3>
        {ticketType === 'problem' && !loadFailed && (
          <span className="text-xs text-muted-foreground" data-testid="ticket-links-incident-count">
            {t('ticketLinks.linkedIncidents', { count: incidentCount })}
          </span>
        )}
        {canWrite && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
            data-testid="ticket-links-add"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('ticketLinks.add')}
          </button>
        )}
      </div>

      {loading && links.length === 0 && !loadFailed && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="ticket-links-loading">{t('ticketLinks.loading')}</p>
      )}

      {loadFailed && (
        <div className="mt-2 flex items-center gap-2 text-xs" data-testid="ticket-links-error">
          <span className="text-destructive">{t('ticketLinks.loadFailed')}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border px-2 py-0.5 hover:bg-muted"
            data-testid="ticket-links-retry"
          >
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!loading && !loadFailed && links.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="ticket-links-empty">{t('ticketLinks.empty')}</p>
      )}

      {groups.map(({ label, rows }) => (
        <div key={label} className="mt-3" data-testid={`ticket-links-group-${label}`}>
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(/* i18n-dynamic */ `ticketLinks.group.${label}`)}
          </h4>
          <ul className="mt-1 space-y-1">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                data-testid={`ticket-link-row-${row.id}`}
              >
                {row.other.deleted ? (
                  // A deleted ticket's page 404s, so it is not a link; it is
                  // still listed because the link keeps counting toward the
                  // cap and the duplicate/cycle rules until it is removed.
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
                    <span className="shrink-0 font-mono text-xs">{row.other.ticketNumber}</span>
                    <span className="truncate line-through">{row.other.subject}</span>
                    <span
                      className="shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-medium"
                      data-testid={`ticket-link-deleted-${row.id}`}
                    >
                      {t('ticketLinks.deleted')}
                    </span>
                  </span>
                ) : (
                  <a
                    // The full-page view by id: the queue (`/tickets#<number>`) only holds
                    // the open tab, so a resolved/closed counterpart would not be found.
                    href={`/tickets/${encodeURIComponent(row.other.id)}`}
                    className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
                    data-testid={`ticket-link-open-${row.id}`}
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.other.ticketNumber}</span>
                    <span className="truncate">{row.other.subject}</span>
                  </a>
                )}
                <span
                  className={cn(
                    'shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-medium',
                    statusConfig[row.other.status]?.color,
                  )}
                  data-testid={`ticket-link-status-${row.id}`}
                >
                  {t(/* i18n-dynamic */ `ticketsPage.status.${row.other.status}`)}
                </span>
                <TicketTypeChip type={row.other.ticketType} testId={`ticket-link-type-${row.id}`} className="shrink-0" />
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => setRemoving(row)}
                    aria-label={t('ticketLinks.remove', { ticket: row.other.ticketNumber })}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    data-testid={`ticket-link-remove-${row.id}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <Dialog open={addOpen} onClose={() => !adding && setAddOpen(false)} title={t('ticketLinks.addTitle')} maxWidth="md" className="p-6">
        <div className="space-y-3" data-testid="ticket-link-dialog">
          <h2 className="text-base font-semibold">{t('ticketLinks.addTitle')}</h2>
          <label className="block text-xs text-muted-foreground">
            {t('ticketLinks.linkType')}
            <select
              value={addType}
              onChange={(e) => setAddType(e.target.value as TicketLinkType)}
              className={`${inputClass} mt-1`}
              data-testid="ticket-link-type-select"
            >
              {ADD_TYPES.map((type) => (
                <option key={type} value={type}>{t(/* i18n-dynamic */ `ticketLinks.addType.${type}`)}</option>
              ))}
            </select>
          </label>

          {picked ? (
            <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm" data-testid="ticket-link-picked">
              <span className="font-mono text-xs text-muted-foreground">{picked.internalNumber ?? '·'}</span>
              <span className="min-w-0 flex-1 truncate">{picked.subject}</span>
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={t('ticketLinks.changePick')}
                data-testid="ticket-link-unpick"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-muted-foreground" htmlFor="ticket-link-search">
                {t('ticketLinks.searchLabel')}
              </label>
              <input
                id="ticket-link-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('ticketLinks.searchPlaceholder')}
                className={`${inputClass} mt-1`}
                data-testid="ticket-link-search"
              />
              {searching && <p className="mt-1 text-xs text-muted-foreground">{t('ticketLinks.searching')}</p>}
              {searchFailed && (
                <p className="mt-1 text-xs text-destructive" data-testid="ticket-link-search-error">{t('ticketLinks.searchFailed')}</p>
              )}
              {!searching && !searchFailed && query.trim() !== '' && hits.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="ticket-link-no-results">{t('ticketLinks.noResults')}</p>
              )}
              {hits.length > 0 && (
                <ul className="mt-1 max-h-56 divide-y overflow-y-auto rounded-md border" data-testid="ticket-link-results">
                  {hits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => setPicked(hit)}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
                        data-testid={`ticket-link-result-${hit.id}`}
                      >
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{hit.internalNumber ?? '·'}</span>
                        <span className="min-w-0 flex-1 truncate">{hit.subject}</span>
                        {isTicketType(hit.ticketType) && <TicketTypeChip type={hit.ticketType} className="shrink-0" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              disabled={adding}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              data-testid="ticket-link-cancel"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void submitAdd()}
              disabled={!picked || adding}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              data-testid="ticket-link-submit"
            >
              {adding ? t('ticketLinks.adding') : t('ticketLinks.addSubmit')}
            </button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => !removeBusy && setRemoving(null)}
        onConfirm={() => void confirmRemove()}
        title={t('ticketLinks.removeTitle')}
        message={removing ? t('ticketLinks.removeMessage', { ticket: removing.other.ticketNumber }) : ''}
        confirmLabel={t('ticketLinks.removeConfirm')}
        isLoading={removeBusy}
        confirmTestId="ticket-link-remove-confirm"
      />
    </section>
  );
}
