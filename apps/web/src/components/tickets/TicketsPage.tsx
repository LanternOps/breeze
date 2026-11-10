import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { useHashState } from '@/lib/useHashState';
import { OverflowTabs, type OverflowTab } from '../shared/OverflowTabs';
import { loginPathWithNext } from '../../lib/authScope';
import TicketQueueList, { queueOptionId } from './TicketQueueList';
import TicketArchivedList from './TicketArchivedList';
import TicketWorkbench from './TicketWorkbench';
import InboundReviewQueue from './InboundReviewQueue';
import TicketQueueFilters from './TicketQueueFilters';
import TicketBulkBar from './TicketBulkBar';
import { TicketFocusStrip, TicketNextOffer } from './TicketFocusStrip';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { usePermissions } from '../../lib/permissions';
import { useQueueKeyboard } from './useQueueKeyboard';
import { formatRelative, NEUTRAL_CHIP_TEXT, slaState, ticketDisplayNumber, type TicketPriority, type TicketStatus, type TicketSummary } from './ticketConfig';
import { useUiStore } from '../../stores/uiStore';
import { fetchTicketConfig, type TicketConfig } from '../../lib/ticketConfigApi';
import { useStableT } from '@/lib/i18n/useStableT';
import { pushUrl, replaceUrl, URL_CHANGE_EVENT } from '../../lib/replaceUrl';
import { claimSamePageHistory } from '../../lib/samePageHistory';
import { TICKET_FOCUS_SUBJECT_ID } from './TicketFocusHeader';
import type { TicketType } from './ticketType';
import { showBulkOutcomeToast, type BulkResult } from './ticketBulkOutcome';
import { useFillAvailableHeight } from './useFillAvailableHeight';
import {
  DEFAULT_QUEUE_HASH, TABS, hashFor, isLiveTab, isUuid, parseQueueHash, readStoredQueueTab, storeQueueTab, tabQuery,
  type LiveTab, type QueueHash, type Tab, type TicketSort,
} from './ticketsPageHash';

type TFunction = ReturnType<typeof useTranslation>['t'];

function translatedPriorityLabel(config: TicketConfig | null, priority: TicketPriority, t: TFunction): string {
  return config?.priorities[priority]?.label ?? t(/* i18n-dynamic */ `ticketsPage.priority.${priority}`);
}

/** What the queue's live region says when j/k lands on a ticket:
 *  "<number> <subject>, <priority> priority[, <SLA state>]". */
function queueAnnouncement(ticket: TicketSummary, config: TicketConfig | null, t: TFunction): string {
  const parts = {
    number: ticketDisplayNumber(ticket),
    subject: ticket.subject,
    priority: translatedPriorityLabel(config, ticket.priority, t),
  };
  const sla = slaState(ticket);
  const slaText =
    sla.kind === 'ok' ? t('ticketsPage.announce.sla.ok', { relative: formatRelative(sla.minutesLeft) })
    : sla.kind === 'at-risk' ? t('ticketsPage.announce.sla.atRisk', { relative: formatRelative(sla.minutesLeft) })
    : sla.kind === 'paused' ? t('ticketsPage.announce.sla.paused', { relative: formatRelative(sla.minutesLeft) })
    : sla.kind === 'breached' ? t('ticketsPage.announce.sla.breached')
    : null;
  return slaText
    ? t('ticketsPage.announce.ticketWithSla', { ...parts, sla: slaText })
    : t('ticketsPage.announce.ticket', parts);
}

function translatedStatusLabel(config: TicketConfig | null, status: TicketStatus, t: TFunction): string {
  const systemRow = config?.statuses.find((s) => s.coreStatus === status && s.isSystem);
  return systemRow?.name ?? t(/* i18n-dynamic */ `ticketsPage.status.${status}`);
}

const isClosedStatus = (status: TicketStatus): boolean => status === 'resolved' || status === 'closed';

/** Marks, in history.state, the entry openFocus pushed when it opened a ticket
 *  from the board: the entry before it is that board. Kept in the entry
 *  itself so it survives Back / Forward, a remount and a reload. */
const FOCUS_ENTRY_MARK = 'breezeTicketsFocus';
const onFocusEntryFromBoard = (): boolean =>
  (window.history.state as Record<string, unknown> | null)?.[FOCUS_ENTRY_MARK] === true;

/** The open ticket the next-ticket offer names after `id` closes: the next one
 *  below it in the list, else the first open one above. */
function nextOpenAfter(list: TicketSummary[], id: string): TicketSummary | null {
  const idx = list.findIndex((t) => t.id === id);
  const isNext = (t: TicketSummary) => t.id !== id && !isClosedStatus(t.status);
  return (idx >= 0 ? list.slice(idx + 1).find(isNext) : undefined) ?? list.find(isNext) ?? null;
}

/** Escape inside a dialog or menu belongs to it, never to "back to the queue". */
const OVERLAY = '[aria-modal="true"],[role="dialog"],[role="alertdialog"],[role="menu"]';
function isEditable(el: Element | null): boolean {
  if (!el || el === document.body) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || (el as HTMLElement).isContentEditable;
}

// SSR-safe stand-in for useLayoutEffect.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface Props {
  /** /tickets/[id]: open straight into focus on this ticket (id or number). */
  routeTicketId?: string;
}

/**
 * The ticket workspace: a full-width triage board, and one ticket in focus
 * in its place. The URL hash carries the focused ticket (`#T-1001`), so the
 * tab, filters and scroll position survive the round trip.
 */
export default function TicketsPage({ routeTicketId }: Props = {}) {
  const { t } = useTranslation('tickets');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  // Soft-delete / restore / archived queue are all tickets:manage-gated (server
  // re-enforces). UX-only: hides controls the caller can't use. Partner/Org Admin.
  const { can } = usePermissions();
  const canManage = can('tickets', 'manage');

  const [tab, setTabState] = useState<Tab>('open');
  // /tickets/[id] opens in the queue tab the tech last worked in; the first
  // list fetch waits for that so it is not thrown away.
  const [tabReady, setTabReady] = useState(!routeTicketId);
  useIsomorphicLayoutEffect(() => {
    if (!routeTicketId) return;
    const stored = readStoredQueueTab();
    if (stored) setTabState(stored);
    setTabReady(true);
  }, []);
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    if (isLiveTab(next)) storeQueueTab(next);
  }, []);

  const [resolveToken, setResolveToken] = useState(0);
  // r / n for the focus view's composer, honoured by the workbench (see its
  // composeRequest): it switches to the Conversation tab first.
  const [composeRequest, setComposeRequest] = useState<{ mode: 'reply' | 'internal'; token: number }>({ mode: 'reply', token: 0 });
  const requestCompose = useCallback((mode: 'reply' | 'internal') => {
    setComposeRequest((prev) => ({ mode, token: prev.token + 1 }));
  }, []);
  const [paneRefresh, setPaneRefresh] = useState(0);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [stats, setStats] = useState<{ open: number; unassigned: number; mine: number; breached: number; atRisk?: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // SSR-safe hash adoption + hashchange subscription live in the hook (#2421).
  // One hook for the whole hash so an external change lands atomically (see
  // QueueHash). Ticket-type filter (#7900): '' = All. Hash-backed so the
  // Service Desk nav entries (`/tickets#type=<type>`) and bookmarks deep-link in.
  const [queueHash, setQueueHash] = useHashState<QueueHash>(DEFAULT_QUEUE_HASH, parseQueueHash);
  const { selection: hashFocus, sort, type: typeFilter, showMerged } = queueHash;
  // The route id stands in for the hash until the first in-page move, which
  // rewrites the URL to the canonical /tickets#<key>.
  const [routeFocus, setRouteFocus] = useState<string | null>(routeTicketId ?? null);
  const focusKey = hashFocus ?? routeFocus;
  const [search, setSearch] = useState('');
  // Debounced twin of `search` — only this drives the list fetch, so typing
  // doesn't fire a 100-row query per keystroke (the input itself stays instant).
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Org scoping is the header switcher's job (fetchWithAuth injects the
  // selected org); a page-local org filter would silently disagree with it.
  const [priorityFilter, setPriorityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  // null = assignee select hidden (e.g. caller lacks USERS_READ); graceful degradation, no error UI.
  const [assignees, setAssignees] = useState<Array<{ id: string; name: string | null; email: string }> | null>(null);
  // Bulk selection (UI brief §6): checkbox column + slide-up action bar.
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  // The board's active row (roving focus): j/k move it, Enter opens it.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Polite live-region text: set on keyboard moves and `x` toggles only, so
  // pointer clicks stay silent.
  const [announcement, setAnnouncement] = useState('');
  const [bulkAssignee, setBulkAssignee] = useState(''); // '' = none; 'unassign' sentinel = null assignee
  const [bulkStatus, setBulkStatus] = useState('');
  // Bulk delete is confirm-gated (soft-delete hides from all queues).
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Ids with an in-flight restore (archived queue) — disables their row button.
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  // Ticket config (custom statuses + priority labels). null = not loaded / fetch
  // failed; chips and bulk-status options fall back to the static core config.
  const [config, setConfig] = useState<TicketConfig | null>(null);
  // Inbound review queue: only admins can read it, so the tab is hidden unless a
  // probe of the queue endpoint returns 200 (non-admins / org-scoped users 403).
  // `reviewTotal` drives the tab's pending-count badge.
  const [reviewAvailable, setReviewAvailable] = useState(false);
  const [reviewTotal, setReviewTotal] = useState(0);
  // After a resolve in focus: the next ticket, offered (never opened for you).
  const [nextOffer, setNextOffer] = useState<{ fromId: string; ticket: TicketSummary } | null>(null);
  const fetchSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  // This page's own path + query, kept current by writeHash: a popstate that
  // stays on it is a step between the board and a ticket opened from it.
  const pagePath = useRef<string | null>(null);
  useEffect(() => { pagePath.current = window.location.pathname + window.location.search; }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillAvailableHeight(rootRef);

  // 'mine'/'unassigned' tabs already pin the assignee param; the filter select is locked there.
  const assigneeLocked = tab === 'mine' || tab === 'unassigned';
  const filtersActive = Boolean(priorityFilter || categoryFilter || assigneeFilter || typeFilter);

  // Single writer for the hash: state and URL always move together, so focus,
  // sort, type and the merged toggle never clobber each other. `mergedValue`
  // defaults to the current toggle so the three-field callers keep it.
  // `push` adds a history entry (opening a ticket from the board); every other
  // write replaces the current one.
  const writeHash = useCallback((selection: string | null, sortValue: TicketSort, typeValue: TicketType | '', mergedValue: boolean = showMerged, opts?: { push?: boolean }) => {
    setRouteFocus(null);
    setQueueHash({ selection, sort: sortValue, type: typeValue, showMerged: mergedValue });
    const hash = hashFor(selection, sortValue, typeValue || null, mergedValue);
    // From /tickets/[id] the first move lands on the canonical /tickets URL.
    const url = routeTicketId ? `/tickets${window.location.search}${hash}` : (hash || window.location.pathname + window.location.search);
    if (opts?.push) pushUrl(url, { [FOCUS_ENTRY_MARK]: true });
    else replaceUrl(url);
    pagePath.current = window.location.pathname + window.location.search;
  }, [setQueueHash, showMerged, routeTicketId]);

  const clearFilters = useCallback(() => {
    setPriorityFilter('');
    setCategoryFilter('');
    setAssigneeFilter('');
    if (typeFilter) writeHash(focusKey, sort, '');
  }, [typeFilter, focusKey, sort, writeHash]);

  // Filter options load once; failures degrade per-select (these are filters, not critical path).
  useEffect(() => {
    let cancelled = false;
    const readJson = async (res: Response): Promise<unknown> => (res.ok ? res.json() : null);
    void (async () => {
      const [catRes, userRes] = await Promise.allSettled([
        fetchWithAuth('/ticket-categories').then(readJson),
        fetchWithAuth('/users').then(readJson)
      ]);
      if (cancelled) return;
      if (catRes.status === 'fulfilled' && catRes.value) {
        const body = catRes.value as { data?: Array<{ id: string; name: string; isActive?: boolean }> };
        setCategories((body.data ?? []).filter((cat) => cat.isActive !== false));
      }
      if (userRes.status === 'fulfilled' && userRes.value) {
        const body = userRes.value as { data?: Array<{ id: string; name: string | null; email: string }> };
        const rows = Array.isArray(body) ? body : body.data;
        if (Array.isArray(rows)) setAssignees(rows.filter((u) => u.id));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The /tickets query string for the current tab + filters; null on the
  // review tab, which isn't a ticket query (InboundReviewQueue loads its own data).
  const ticketQuery = useMemo(() => {
    if (tab === 'review' || !tabReady) return null;
    // The archived tab is a normal ticket query with deleted=only (the server
    // gates it on tickets:manage and stamps each row with deletedAt).
    const params = tab === 'archived'
      ? new URLSearchParams({ deleted: 'only' })
      : new URLSearchParams(tabQuery(tab));
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (priorityFilter) params.set('priority', priorityFilter);
    if (categoryFilter) params.set('categoryId', categoryFilter);
    // Omit for "All": the API rejects a blank ticketType= with 400.
    if (typeFilter) params.set('ticketType', typeFilter);
    // The 'mine'/'unassigned' tabs already set assignee; the filter applies only on the other tabs.
    if (assigneeFilter && tab !== 'mine' && tab !== 'unassigned') params.set('assignee', assigneeFilter);
    // 'triage' is the server default, so it's omitted — which also lets the
    // closed tab keep its tabQuery() sort=newest until the user picks a sort.
    if (sort !== 'triage') params.set('sort', sort);
    // #8972: merged tombstones are hidden server-side unless asked for. Sent on
    // every tab; it only changes results where closed tickets can appear.
    if (showMerged) params.set('showMerged', 'true');
    params.set('limit', '100');
    return params.toString();
  }, [tab, tabReady, debouncedSearch, priorityFilter, categoryFilter, assigneeFilter, typeFilter, sort, showMerged]);
  // The query the rows in `tickets` were fetched for (null until the first load).
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const listIsCurrent = ticketQuery !== null && loadedQuery === ticketQuery;

  const fetchTickets = useCallback(async () => {
    if (ticketQuery === null) { setLoading(tab !== 'review' && !tabReady); return; }
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth(`/tickets?${ticketQuery}`);
      if (!res.ok) {
        if (res.status === 401) { void navigateTo(loginPathWithNext(), { replace: true }); return; }
        throw new Error(stableT('ticketsPage.loadFailed'));
      }
      const body = await res.json();
      if (seq !== fetchSeq.current) return;
      setTickets(body.data ?? []);
      setLoadedQuery(ticketQuery);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : stableT('ticketsPage.loadFailed'));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [ticketQuery, stableT, tab, tabReady]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/tickets/stats');
      if (!res.ok) { setStats(null); return; }
      const body = await res.json();
      setStats(body.data ?? null);
    } catch {
      // Stats are decorative tab badges — intentionally swallowed; null hides stale counts.
      setStats(null);
    }
  }, []);

  useEffect(() => { void fetchTickets(); void fetchStats(); }, [fetchTickets, fetchStats]);

  // Trailing debounce: commit the typed search to the fetch-driving value 300ms
  // after the last keystroke. An empty box applies immediately (clearing search
  // should feel instant). Cleared on every change so only the final value lands.
  useEffect(() => {
    if (search === '') { setDebouncedSearch(''); return; }
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Patch a single queue row in place after a focus-view mutation — instant list
  // feedback without a full /tickets refetch (the heavy 100-row query that, on
  // the connection-capped US droplet, also contended for DB connections).
  const patchTicketRow = useCallback((id: string, patch: Partial<TicketSummary>) => {
    setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // #9564: the ticket the user just changed in focus, held so a reconcile that
  // drops it from the current view (resolving from "All open", reassigning out
  // of "Mine") doesn't take it away from under them. It keeps its place until
  // the user moves on or switches tabs. A snapshot, not a fetch: the focus view
  // loads its own detail.
  const [heldTicket, setHeldTicket] = useState<TicketSummary | null>(null);
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;
  const heldRef = useRef(heldTicket);
  heldRef.current = heldTicket;

  // Whether `id` was already resolved/closed before the change now landing.
  const wasClosed = useCallback((id: string): boolean => {
    const before = ticketsRef.current.find((t) => t.id === id) ?? (heldRef.current?.id === id ? heldRef.current : null);
    return Boolean(before && isClosedStatus(before.status));
  }, []);

  const onWorkbenchPatched = useCallback((id: string, patch: Partial<TicketSummary>) => {
    const closing = Boolean(patch.status && isClosedStatus(patch.status)) && !wasClosed(id);
    patchTicketRow(id, patch);
    setHeldTicket((prev) => {
      const base = prev?.id === id ? prev : ticketsRef.current.find((t) => t.id === id);
      return base ? { ...base, ...patch } : prev;
    });
    // Resolving (or closing) offers the next ticket; it never opens it.
    if (closing) {
      const next = nextOpenAfter(ticketsRef.current, id);
      setNextOffer(next ? { fromId: id, ticket: next } : null);
    }
  }, [patchTicketRow, wasClosed]);

  // The workbench asks, once a resolve has landed and before the row is
  // patched, whether to toast "Ticket resolved": not when the next-ticket
  // offer is about to say so, otherwise (nothing left to offer, a ticket that
  // was already closed) yes.
  const resolveToastFor = useCallback(
    (id: string): boolean => wasClosed(id) || nextOpenAfter(ticketsRef.current, id) === null,
    [wasClosed]
  );

  // Debounced background reconcile after a mutation: coalesces bursts (rapid
  // status/assignee changes) into one list+stats refresh instead of one per click.
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReconcile = useCallback(() => {
    if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
    reconcileTimer.current = setTimeout(() => { void fetchTickets(); void fetchStats(); }, 300);
  }, [fetchTickets, fetchStats]);
  useEffect(() => () => { if (reconcileTimer.current) clearTimeout(reconcileTimer.current); }, []);

  // Fetch ticket config once (module-cached). Failure leaves config null, so
  // chips and the bulk-status menu keep using the static core labels.
  useEffect(() => {
    let cancelled = false;
    void fetchTicketConfig().then((c) => {
      if (!cancelled && c) setConfig(c);
    });
    return () => { cancelled = true; };
  }, []);

  // Probe the inbound review queue once: a 200 means the caller is an admin who
  // can act on it, so we reveal the tab + seed its badge count. A 403 (non-admin
  // / org-scoped) or any error leaves the tab hidden. This is UX-only gating —
  // the endpoint re-enforces admin access server-side.
  const refreshReviewBadge = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/ticket-config/email-inbound?page=1&limit=1');
      if (!res.ok) return;
      setReviewAvailable(true);
      const body = (await res.json()) as { pagination?: { total?: number } };
      setReviewTotal(body.pagination?.total ?? 0);
    } catch {
      // Network error — leave the tab hidden rather than risk a broken surface.
    }
  }, []);
  useEffect(() => { void refreshReviewBadge(); }, [refreshReviewBadge]);

  // Selection survives tab switches (POST /tickets/bulk takes raw ids; the bar's
  // count chip reports off-view rows) but clears when a filter or the search
  // changes — those genuinely change what the result set means.
  useEffect(() => {
    setBulkSelectedIds(new Set());
    setBulkAssignee('');
    setBulkStatus('');
  }, [search, priorityFilter, categoryFilter, assigneeFilter, typeFilter]);

  const heldMatchesFocus = heldTicket !== null && focusKey !== null
    && (heldTicket.internalNumber === focusKey || heldTicket.id === focusKey);
  const focusedInList = useMemo(
    () => (focusKey === null ? null : tickets.find((t) => t.internalNumber === focusKey || t.id === focusKey) ?? null),
    [tickets, focusKey]
  );
  // Fall back to the held ticket when the list no longer contains it.
  const focused = focusedInList ?? (heldMatchesFocus ? heldTicket : null);
  const heldDroppedFromView = focusedInList === null && heldMatchesFocus;
  const inFocus = focusKey !== null && tab !== 'review' && tab !== 'archived';
  // A route/hash id renders at once; a number waits for the list or the lookup.
  const focusTicketId = focused?.id ?? (inFocus && focusKey && isUuid(focusKey) ? focusKey : null);

  // Release the hold once the user moves on: another ticket, or a tab switch.
  // Switching to Closed keeps a resolved/closed hold — that is where the
  // ticket now lives, and the "View in Closed" link lands there.
  useEffect(() => {
    if (heldTicket && !heldMatchesFocus) setHeldTicket(null);
  }, [heldTicket, heldMatchesFocus]);
  const prevTab = useRef(tab);
  useEffect(() => {
    if (prevTab.current === tab) return;
    prevTab.current = tab;
    setHeldTicket((prev) => (prev && tab === 'closed' && isClosedStatus(prev.status) ? prev : null));
  }, [tab]);
  // The focused ticket is sticky: once its key has resolved to a listed row,
  // that row is held for as long as the key stays, so a refetch that drops it
  // from the view never unmounts the open workbench (assigned with `a` out of
  // Unassigned, a first public reply out of Breaching, resolved out of an open
  // tab, #9564). Declared after the release effects above so a fresh key's
  // row is not released in the same pass.
  useEffect(() => {
    if (inFocus && focusedInList) setHeldTicket(focusedInList);
  }, [inFocus, focusedInList]);

  // The board's active row follows the ticket in focus, so going back lands on it.
  const focusedId = focused?.id;
  useEffect(() => { if (focusedId) setActiveId(focusedId); }, [focusedId]);

  // An offer belongs to the ticket that was resolved; moving on retires it.
  useEffect(() => {
    if (nextOffer && (!inFocus || focusTicketId !== nextOffer.fromId)) setNextOffer(null);
  }, [nextOffer, inFocus, focusTicketId]);

  // A focus key the list does not hold (a link to a ticket outside this view,
  // or one that has since left it) is looked up directly, never swapped for
  // another ticket (sweep G10).
  const focusAbsent = inFocus && focusKey !== null && !focused;
  // null = nothing to look up; 'missing' = lookup finished, caller cannot see it.
  const [absentLookup, setAbsentLookup] = useState<{ key: string; status: 'pending' | 'missing' } | null>(null);
  useEffect(() => {
    if (loading || !listIsCurrent || !focusAbsent || focusKey === null) return;
    const key = focusKey;
    let cancelled = false;
    setAbsentLookup({ key, status: 'pending' });
    void (async () => {
      let found: TicketSummary | null = null;
      try {
        if (isUuid(key)) {
          const res = await fetchWithAuth(`/tickets/${key}`);
          if (res.ok) found = ((await res.json()) as { data?: TicketSummary }).data ?? null;
        } else {
          // No by-number endpoint: the list search matches internalNumber; the
          // exact match is picked client-side. Status-agnostic (no statusGroup).
          const res = await fetchWithAuth(`/tickets?${new URLSearchParams({ search: key, limit: '5' })}`);
          if (res.ok) {
            const rows = ((await res.json()) as { data?: TicketSummary[] }).data ?? [];
            found = rows.find((r) => r.internalNumber?.toLowerCase() === key.toLowerCase()) ?? null;
          }
        }
      } catch {
        found = null;
      }
      if (cancelled) return;
      if (found) {
        setHeldTicket(found);
        setAbsentLookup(null);
      } else {
        setAbsentLookup({ key, status: 'missing' });
      }
    })();
    return () => { cancelled = true; };
  }, [loading, listIsCurrent, focusAbsent, focusKey]);
  const absentNotice = focusAbsent && !focusTicketId && absentLookup?.key === focusKey && absentLookup.status === 'missing'
    ? focusKey
    : null;

  // Where the focused ticket sits in the list: "3 of 9" and the j/k anchor.
  const focusIndex = focusTicketId ? tickets.findIndex((t) => t.id === focusTicketId) : -1;
  // Remembered while the ticket is listed, so j/k still step from its place
  // after a reconcile drops it (resolved out of an open-only tab).
  const lastFocusIndex = useRef(-1);
  useEffect(() => { if (focusIndex >= 0) lastFocusIndex.current = focusIndex; }, [focusIndex]);
  const stepTarget = (delta: 1 | -1): TicketSummary | null => {
    if (tickets.length === 0) return null;
    const anchor = focusIndex >= 0 ? focusIndex + delta
      : lastFocusIndex.current >= 0 ? (delta === 1 ? lastFocusIndex.current : lastFocusIndex.current - 1)
      : (delta === 1 ? 0 : -1);
    const next = anchor >= 0 && anchor < tickets.length ? tickets[anchor] : null;
    return next && next.id !== focusTicketId ? next : null;
  };

  // What to do once the focus view's detail has loaded: move keyboard focus to
  // its subject (every open), or finish a board shortcut (r / n / e).
  const pendingIntent = useRef<{ id: string; kind: 'heading' | 'reply' | 'internal' | 'resolve' } | null>(null);

  // Open a ticket in focus, in place. The board keeps its scroll offset.
  const openFocusWith = useCallback((ticket: TicketSummary, kind: 'heading' | 'reply' | 'internal' | 'resolve') => {
    const fromBoard = !inFocus;
    if (fromBoard && scrollRef.current) savedScroll.current = scrollRef.current.scrollTop;
    setActiveId(ticket.id);
    // The row (or ticket) that had focus is going away: say where the user is
    // now, outside the board that is about to be hidden.
    pendingIntent.current = { id: ticket.id, kind };
    setAnnouncement(queueAnnouncement(ticket, config, t));
    // From the board, a new (marked) history entry: Back returns to the board
    // instead of leaving /tickets. Inside focus (j/k, the next-ticket offer)
    // it is replaced, mark and all, so Back never walks through every ticket seen.
    writeHash(ticket.internalNumber ?? ticket.id, sort, typeFilter, showMerged, { push: fromBoard });
  }, [inFocus, sort, typeFilter, showMerged, writeHash, config, t]);
  const openFocus = useCallback((ticket: TicketSummary) => openFocusWith(ticket, 'heading'), [openFocusWith]);

  const backToTriage = useCallback(() => {
    if (focusTicketId) setActiveId(focusTicketId);
    setNextOffer(null);
    if (onFocusEntryFromBoard()) {
      // Step back through the entry openFocus pushed (the popstate claim
      // below shows the board), so Esc, Back and Forward agree. The mark is
      // read from the entry, so it holds after Back then Forward too.
      window.history.back();
      return;
    }
    writeHash(null, sort, typeFilter);
  }, [focusTicketId, sort, typeFilter, writeHash]);

  // Back / Forward between the board and a ticket opened from it. Astro's
  // router would take the step for a navigation and, unless the location it
  // last moved to carries a hash, re-fetch and swap this page, remounting the
  // board without its row, scroll or filters. Its listener runs before any an
  // island adds (Chromium: registration order), so the step is claimed
  // through the hook that runs before the router (lib/samePageHistory.ts).
  useEffect(() => claimSamePageHistory((e) => {
    // Leaving this page (another path or query) is the router's job.
    if (window.location.pathname + window.location.search !== pagePath.current) return false;
    setRouteFocus(null);
    setQueueHash(parseQueueHash(window.location.hash.replace(/^#/, '')));
    // The sidebar mirrors the URL; its own popstate listener is skipped.
    window.dispatchEvent(new CustomEvent(URL_CHANGE_EVENT));
    // Entries without state (a plain hash assignment) the router ignores
    // anyway; leave those to every other listener.
    return e.state !== null;
  }), [setQueueHash]);

  // Back on the board (Esc, the back button, browser Back): put the scroll
  // offset and the keyboard focus back on the row the tech left from.
  const wasInFocus = useRef(inFocus);
  useIsomorphicLayoutEffect(() => {
    const left = wasInFocus.current && !inFocus;
    wasInFocus.current = inFocus;
    if (!left) return;
    if (scrollRef.current) scrollRef.current.scrollTop = savedScroll.current;
    const row = activeId ? document.getElementById(queueOptionId(activeId)) : null;
    if (!row) return;
    row.focus({ preventScroll: true });
    // After many j/k in focus the active row can sit outside the restored
    // offset; bring it just into view (no jump when it already is). Absent in jsdom.
    row.scrollIntoView?.({ block: 'nearest' });
  }, [inFocus, activeId]);

  // #8972: after a merge the source is a closed tombstone; follow the survivor
  // (by number when the dialog knew it, else by id).
  const onWorkbenchMerged = useCallback((survivorId: string, survivorNumber: string | null) => {
    writeHash(survivorNumber ?? survivorId, sort, typeFilter);
    scheduleReconcile();
  }, [sort, typeFilter, writeHash, scheduleReconcile]);

  const onWorkbenchDeleted = useCallback((id: string) => {
    setHeldTicket((prev) => (prev?.id === id ? null : prev));
    backToTriage();
  }, [backToTriage]);

  const activeTicket = useMemo(() => tickets.find((tk) => tk.id === activeId) ?? null, [tickets, activeId]);

  // Triage j/k: move the active row (and DOM focus with it — roving tab stop),
  // announce it, never open it.
  const moveActive = useCallback((delta: 1 | -1) => {
    if (tickets.length === 0) return;
    const idx = activeTicket ? tickets.findIndex((tk) => tk.id === activeTicket.id) : -1;
    const next = tickets[idx < 0 ? 0 : Math.min(tickets.length - 1, Math.max(0, idx + delta))];
    if (!next) return;
    setActiveId(next.id);
    document.getElementById(queueOptionId(next.id))?.focus();
    setAnnouncement(queueAnnouncement(next, config, t));
  }, [tickets, activeTicket, config, t]);

  const assignMe = useCallback(async (target: TicketSummary | null) => {
    if (!target) return;
    const me = useAuthStore.getState().user;
    const userId = me?.id;
    if (!userId) {
      showToast({ type: 'error', message: t('ticketsPage.assignFailed') });
      return;
    }
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${target.id}/assign`, { method: 'POST', body: JSON.stringify({ assigneeId: userId }) }),
        errorFallback: t('ticketsPage.assignFailed'),
        successMessage: t('ticketsPage.assignedToYou'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      patchTicketRow(target.id, { assignedTo: userId, assigneeName: me?.name ?? me?.email ?? null });
      scheduleReconcile();
      // The focus view reads its own detail; a page-level assign must reach it.
      if (inFocus) setPaneRefresh((n) => n + 1);
    } catch (err) {
      // ActionError is already toasted by runAction; surface anything else too.
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('ticketsPage.assignFailed') });
    }
  }, [patchTicketRow, scheduleReconcile, inFocus, t]);

  const toggleBulkSelect = useCallback((id: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // `x`: the keyboard path to bulk selection (row checkboxes are pointer-only).
  const toggleActiveBulk = useCallback(() => {
    if (!activeTicket) return;
    const count = bulkSelectedIds.size + (bulkSelectedIds.has(activeTicket.id) ? -1 : 1);
    toggleBulkSelect(activeTicket.id);
    setAnnouncement(t('ticketsPage.selectedCount', { count }));
  }, [activeTicket, bulkSelectedIds, toggleBulkSelect, t]);

  const clearBulkSelection = useCallback(() => {
    setBulkSelectedIds(new Set());
    setBulkAssignee('');
    setBulkStatus('');
  }, []);

  const applyBulk = useCallback(async () => {
    const ticketIds = Array.from(bulkSelectedIds);
    if (ticketIds.length === 0 || (!bulkAssignee && !bulkStatus)) return;
    const body = bulkStatus
      ? { ticketIds, action: 'status', status: bulkStatus }
      : { ticketIds, action: 'assign', assigneeId: bulkAssignee === 'unassign' ? null : bulkAssignee };
    try {
      const result = await runAction<{ data: BulkResult }>({
        request: () => fetchWithAuth('/tickets/bulk', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: t('ticketsPage.bulk.updateFailed'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      showBulkOutcomeToast(result.data, t('ticketsPage.bulk.updatedPast'), t);
      // The snapshot may now be stale (or deleted).
      setHeldTicket(null);
      clearBulkSelection();
      setPaneRefresh((n) => n + 1);
      void fetchTickets();
      void fetchStats();
    } catch (err) {
      // ActionError is already toasted by runAction; surface anything else too.
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('ticketsPage.bulk.updateFailed') });
    }
  }, [bulkSelectedIds, bulkAssignee, bulkStatus, clearBulkSelection, fetchTickets, fetchStats, t]);

  // Bulk soft-delete (tickets:manage). Confirm-gated by the ConfirmDialog below;
  // this runs on confirm. Same aggregate-result toast + refresh as applyBulk.
  const applyBulkDelete = useCallback(async () => {
    const ticketIds = Array.from(bulkSelectedIds);
    if (ticketIds.length === 0) return;
    setBulkDeleteOpen(false);
    try {
      const result = await runAction<{ data: BulkResult }>({
        request: () => fetchWithAuth('/tickets/bulk', { method: 'POST', body: JSON.stringify({ ticketIds, action: 'delete' }) }),
        errorFallback: t('ticketsPage.bulk.deleteFailed'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      showBulkOutcomeToast(result.data, t('ticketsPage.bulk.deletedPast'), t);
      setHeldTicket(null);
      clearBulkSelection();
      setPaneRefresh((n) => n + 1);
      void fetchTickets();
      void fetchStats();
    } catch (err) {
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('ticketsPage.bulk.deleteFailed') });
    }
  }, [bulkSelectedIds, clearBulkSelection, fetchTickets, fetchStats, t]);

  // Restore a soft-deleted ticket from the archived queue (tickets:manage).
  const restoreTicket = useCallback(async (id: string) => {
    setRestoringIds((prev) => new Set(prev).add(id));
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${id}/restore`, { method: 'POST' }),
        errorFallback: t('ticketsPage.restoreFailed'),
        successMessage: t('ticketsPage.ticketRestored'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      void fetchTickets();
      void fetchStats();
    } catch (err) {
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('ticketsPage.restoreFailed') });
    } finally {
      setRestoringIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, [fetchTickets, fetchStats, t]);

  // r / n / e from the board open the active ticket first; the focus view
  // finishes the action once its detail (and composer) has loaded.
  const actFromBoard = useCallback((kind: 'reply' | 'internal' | 'resolve') => {
    if (!activeTicket) return;
    openFocusWith(activeTicket, kind);
  }, [activeTicket, openFocusWith]);
  const onWorkbenchReady = useCallback((id: string) => {
    const intent = pendingIntent.current;
    if (!intent || intent.id !== id) return;
    pendingIntent.current = null;
    if (intent.kind === 'heading') document.getElementById(TICKET_FOCUS_SUBJECT_ID)?.focus();
    else if (intent.kind === 'resolve') setResolveToken((n) => n + 1);
    else requestCompose(intent.kind);
  }, [requestCompose]);

  const onEscape = useCallback((e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(OVERLAY) || document.querySelector('[aria-modal="true"]')) return;
    const active = document.activeElement;
    // First Escape leaves the text field; only a second one leaves the ticket.
    if (isEditable(active) || isEditable(target)) { (active as HTMLElement | null)?.blur(); return; }
    if (inFocus) { backToTriage(); return; }
    (active as HTMLElement | null)?.blur();
  }, [inFocus, backToTriage]);

  const onPrevious = () => { const next = stepTarget(-1); if (next) openFocus(next); };
  const onNext = () => { const next = stepTarget(1); if (next) openFocus(next); };

  const liveTab = tab !== 'review' && tab !== 'archived';
  useQueueKeyboard({
    onMove: (delta) => (inFocus ? (delta === 1 ? onNext() : onPrevious()) : moveActive(delta)),
    onOpen: () => {
      if (inFocus) { if (nextOffer) openFocus(nextOffer.ticket); return; }
      if (activeTicket && liveTab) openFocus(activeTicket);
    },
    onAssignMe: () => void assignMe(inFocus ? focused : activeTicket),
    onFocusReply: () => (inFocus ? focusTicketId && requestCompose('reply') : liveTab && actFromBoard('reply')),
    onFocusInternal: () => (inFocus ? focusTicketId && requestCompose('internal') : liveTab && actFromBoard('internal')),
    onResolve: () => (inFocus ? (focusTicketId && setResolveToken((n) => n + 1)) : liveTab && actFromBoard('resolve')),
    // Bulk selection lives on the board of the live queue tabs only.
    onToggleBulk: inFocus || !liveTab ? undefined : toggleActiveBulk,
    onEscape,
  });

  const tabCount = (id: Tab): number | null => {
    // The review badge is independent of /tickets/stats; show it only when non-empty.
    if (id === 'review') return reviewTotal > 0 ? reviewTotal : null;
    if (!stats) return null;
    if (id === 'mine') return stats.mine;
    if (id === 'unassigned') return stats.unassigned;
    if (id === 'open') return stats.open;
    // Matches the tab's server definition (breached ∪ at-risk). Older /tickets/stats
    // payloads may lack atRisk — treat as 0 rather than hiding the badge.
    if (id === 'breaching') return stats.breached + (stats.atRisk ?? 0);
    return null;
  };

  const trueEmpty = !loading && tickets.length === 0 && tab === 'open' && !search && !filtersActive && !error;
  const tabLabel = (id: LiveTab) => t(/* i18n-dynamic */ `ticketsPage.tabs.${id}`);
  const prevTarget = inFocus ? stepTarget(-1) : null;
  const nextTarget = inFocus ? stepTarget(1) : null;
  const movedNotice = inFocus && focused && heldDroppedFromView && tab !== 'closed' && isClosedStatus(focused.status);
  // Held but no longer in this view for another reason (assigned out of
  // Unassigned, replied out of Breaching): say so instead of leaving "N of M"
  // to vanish silently. Only once the list is the current view's.
  const leftViewNotice = inFocus && focused && heldDroppedFromView && listIsCurrent && !movedNotice
    ? ticketDisplayNumber(focused)
    : null;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col" style={fillHeight ? { height: fillHeight } : undefined} data-testid="tickets-page">
      {/* Outside the board, which is hidden in focus: j/k on the board and
          every ticket opened (from the board, j/k in focus, the next-ticket
          offer) are announced here. */}
      <p role="status" className="sr-only" data-testid="tickets-queue-announcer">{announcement}</p>
      <div hidden={inFocus} className="flex min-h-0 flex-1 flex-col" data-testid="tickets-triage">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold" data-testid="tickets-heading">{t('ticketsPage.title')}</h1>
          <a
            href="/tickets/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
            data-testid="tickets-create-button"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> {t('ticketsPage.createTicket')}
          </a>
        </div>

        <div className="mb-3 space-y-2">
          <OverflowTabs
            tabs={[
              // These five are plain informational counts (muted text,
              // including "0") — not the "needs attention" signal
              // `OverflowTab.count`/`CountBadge` renders (amber pill, hidden on
              // a falsy count). Appending the number onto the label keeps that
              // plain meaning. Only Review queue is a genuine "needs
              // attention" count and uses the real prop.
              ...TABS.map((tabItem): OverflowTab => {
                const label = tabLabel(tabItem.id);
                const count = tabCount(tabItem.id);
                return { id: tabItem.id, label: count !== null ? `${label} ${count}` : label, icon: null };
              }),
              ...(reviewAvailable
                ? [{ id: 'review', label: t('ticketsPage.reviewQueue'), icon: null, count: tabCount('review') ?? undefined } satisfies OverflowTab]
                : []),
              // Soft-deleted queue. tickets:manage only (server re-enforces via
              // deleted=only → 403 for non-managers), so the tab stays hidden otherwise.
              ...(canManage
                ? [{ id: 'archived', label: t('ticketsPage.archived'), icon: null } satisfies OverflowTab]
                : []),
            ]}
            activeTab={tab}
            onTabChange={(id) => setTab(id as Tab)}
            testIdPrefix="tickets-tab-"
          />
          {tab !== 'review' && (
            <TicketQueueFilters
              search={search}
              onSearch={setSearch}
              priority={priorityFilter}
              onPriority={setPriorityFilter}
              category={categoryFilter}
              onCategory={setCategoryFilter}
              categories={categories}
              type={typeFilter}
              onType={(next) => writeHash(focusKey, sort, next)}
              assignees={assignees}
              assignee={assigneeFilter}
              onAssignee={setAssigneeFilter}
              assigneeLocked={assigneeLocked}
              sort={sort}
              onSort={(next) => writeHash(focusKey, next, typeFilter)}
              showMerged={showMerged}
              onShowMerged={(next) => writeHash(focusKey, sort, typeFilter, next)}
              config={config}
            />
          )}
        </div>

        {tab === 'review' ? (
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="tickets-review-pane">
            <InboundReviewQueue onTotalChange={setReviewTotal} />
          </div>
        ) : tab === 'archived' ? (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border" data-testid="tickets-archived-pane">
            {error ? (
              <div className="flex h-full items-center justify-center" data-testid="tickets-archived-error">
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">{error}</p>
                  <button type="button" onClick={() => void fetchTickets()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t('common:actions.retry')}</button>
                </div>
              </div>
            ) : (
              <TicketArchivedList
                tickets={tickets}
                loading={loading}
                config={config}
                onRestore={(tk) => void restoreTicket(tk.id)}
                restoringIds={restoringIds}
              />
            )}
          </div>
        ) : trueEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center" data-testid="tickets-empty">
            <h2 className="text-base font-medium">{t('ticketsPage.empty.title')}</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {t('ticketsPage.empty.description')}
            </p>
            <div className="mt-3 flex gap-2">
              <a href="/tickets/new" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90" data-testid="tickets-empty-create">{t('ticketsPage.createTicket')}</a>
              <a href="/settings/ticketing" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="tickets-empty-settings">{t('ticketsPage.ticketingSettings')}</a>
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center" data-testid="tickets-error">
            <div className="text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <button type="button" onClick={() => void fetchTickets()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="tickets-error-retry">{t('common:actions.retry')}</button>
            </div>
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <button
                type="button"
                onClick={() => setBulkSelectedIds((prev) => new Set([...prev, ...tickets.map((tk) => tk.id)]))}
                data-testid="tickets-select-all-header"
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {t('ticketsPage.selectAll')}
              </button>
              {/* The queue's single keys are otherwise undiscoverable: this
                  opens the global `?` card, which lists them. */}
              <button
                type="button"
                onClick={() => useUiStore.getState().openShortcutsHelp()}
                aria-label={t('common:layout.shortcuts.title')}
                aria-keyshortcuts="?"
                data-testid="tickets-shortcuts-hint"
                className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {t('ticketsPage.shortcutsButton')}
                <kbd aria-hidden="true" className={cn('inline-flex min-w-4 items-center justify-center rounded border bg-muted px-1 font-mono text-xs font-semibold leading-4', NEUTRAL_CHIP_TEXT)}>?</kbd>
              </button>
            </div>
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto"
              data-testid="tickets-queue-scroll"
              onScroll={(e) => { if (!inFocus) savedScroll.current = e.currentTarget.scrollTop; }}
            >
              <TicketQueueList
                tickets={tickets}
                selectedId={activeId}
                onSelect={openFocus}
                onRowFocus={(tk) => setActiveId(tk.id)}
                loading={loading}
                config={config}
                onClearFilters={filtersActive ? clearFilters : undefined}
                bulkSelectedIds={bulkSelectedIds}
                onToggleSelect={toggleBulkSelect}
                hostHandlesArrowKeys
              />
            </div>
            {bulkSelectedIds.size > 0 && (
              <TicketBulkBar
                count={bulkSelectedIds.size}
                assignees={assignees}
                config={config}
                bulkAssignee={bulkAssignee}
                bulkStatus={bulkStatus}
                onBulkAssignee={(value) => { setBulkAssignee(value); if (value) setBulkStatus(''); }}
                onBulkStatus={(value) => { setBulkStatus(value); if (value) setBulkAssignee(''); }}
                onSelectAll={() => setBulkSelectedIds((prev) => new Set([...prev, ...tickets.map((tk) => tk.id)]))}
                onApply={() => void applyBulk()}
                onDelete={canManage ? () => setBulkDeleteOpen(true) : undefined}
                onClear={clearBulkSelection}
              />
            )}
          </div>
        )}
      </div>

      {inFocus && (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="tickets-focus">
          <TicketFocusStrip
            tabLabel={isLiveTab(tab) ? tabLabel(tab) : tabLabel('open')}
            position={focusIndex >= 0 ? { index: focusIndex + 1, total: tickets.length } : null}
            onBack={backToTriage}
            onPrevious={onPrevious}
            onNext={onNext}
            canPrevious={prevTarget !== null}
            canNext={nextTarget !== null}
          />
          {(movedNotice || leftViewNotice || nextOffer) && (
            // One ruled band on the header's gutter: where the ticket went, and what is next.
            <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b bg-muted/40 px-4 py-2" data-testid="ticket-focus-notice-band">
              {movedNotice && focused && (
                // #9564: the ticket left this view (resolved/closed from an
                // open-only tab); say where it went instead of vanishing it.
                <p role="status" className="flex items-center gap-2 text-sm" data-testid="tickets-moved-to-closed">
                  <span>
                    {t('ticketsPage.movedToClosed.message', {
                      status: focused.statusName || translatedStatusLabel(config, focused.status, t),
                      tab: t('ticketsPage.tabs.closed'),
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTab('closed')}
                    className="font-medium text-primary-ink hover:underline"
                    data-testid="tickets-moved-to-closed-view"
                  >
                    {t('ticketsPage.movedToClosed.view', { tab: t('ticketsPage.tabs.closed') })}
                  </button>
                </p>
              )}
              {leftViewNotice && (
                <p role="status" className="text-sm" data-testid="tickets-left-view">
                  {t('ticketsPage.ticketNotInView', { number: leftViewNotice })}
                </p>
              )}
              {nextOffer && <TicketNextOffer ticket={nextOffer.ticket} onOpen={() => openFocus(nextOffer.ticket)} />}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {focusTicketId ? (
              <TicketWorkbench
                ticketId={focusTicketId}
                namesPage
                resolveToast={resolveToastFor}
                resolveRequestToken={resolveToken}
                composeRequest={composeRequest}
                refreshToken={paneRefresh}
                assignees={assignees}
                categories={categories}
                onTicketPatched={onWorkbenchPatched}
                onDeleted={onWorkbenchDeleted}
                onMerged={onWorkbenchMerged}
                onChanged={scheduleReconcile}
                onReady={onWorkbenchReady}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="tickets-no-selection">
                {absentNotice ? (
                  <p role="status" data-testid="tickets-deeplink-absent">{t('ticketsPage.ticketNotInView', { number: absentNotice })}</p>
                ) : (
                  <div className="w-full max-w-xl animate-pulse space-y-3 p-6" data-testid="tickets-focus-loading">
                    <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-4 w-1/3 rounded bg-muted/60" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => void applyBulkDelete()}
        title={t('ticketsPage.bulkDeleteDialog.title', { count: bulkSelectedIds.size })}
        message={t('ticketsPage.bulkDeleteDialog.message')}
        confirmLabel={t('ticketsPage.bulkDeleteDialog.confirm')}
        confirmTestId="tickets-bulk-delete-confirm"
      />
    </div>
  );
}
