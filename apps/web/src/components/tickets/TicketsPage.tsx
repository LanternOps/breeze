import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { useHashState } from '@/lib/useHashState';
import { loginPathWithNext } from '../../lib/authScope';
import TicketQueueList from './TicketQueueList';
import TicketArchivedList from './TicketArchivedList';
import TicketWorkbench from './TicketWorkbench';
import InboundReviewQueue from './InboundReviewQueue';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { usePermissions } from '../../lib/permissions';
import { useQueueKeyboard } from './useQueueKeyboard';
import { type TicketPriority, type TicketStatus, type TicketSummary } from './ticketConfig';
import { fetchTicketConfig, type TicketConfig } from '../../lib/ticketConfigApi';

// Aggregate outcome of a POST /tickets/bulk call.
interface BulkResult { updated: number; skipped: number; failed: number; total: number; skippedReasons?: Record<string, number> }

type TFunction = ReturnType<typeof useTranslation>['t'];

// Human-readable labels for bulk-skip reason codes returned by POST /tickets/bulk.
function skipReasonLabel(code: string, t: TFunction): string {
  const labels: Record<string, string> = {
    OUT_OF_SCOPE: t('ticketsPage.bulk.reason.outOfScope'),
    INVALID_TRANSITION: t('ticketsPage.bulk.reason.invalidTransition'),
    ASSIGNEE_NOT_FOUND: t('ticketsPage.bulk.reason.assigneeNotFound'),
    ASSIGNEE_WRONG_PARTNER: t('ticketsPage.bulk.reason.assigneeWrongPartner'),
    CONCURRENT_MODIFICATION: t('ticketsPage.bulk.reason.concurrentModification'),
    TICKET_PARTNER_UNRESOLVABLE: t('ticketsPage.bulk.reason.ticketPartnerUnresolvable'),
    OTHER: t('ticketsPage.bulk.reason.other'),
  };
  return labels[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

function translatedPriorityLabel(config: TicketConfig | null, priority: TicketPriority, t: TFunction): string {
  return config?.priorities[priority]?.label ?? t(/* i18n-dynamic */ `ticketsPage.priority.${priority}`);
}

function translatedStatusLabel(config: TicketConfig | null, status: TicketStatus, t: TFunction): string {
  const systemRow = config?.statuses.find((s) => s.coreStatus === status && s.isSystem);
  return systemRow?.name ?? t(/* i18n-dynamic */ `ticketsPage.status.${status}`);
}

// Shared toast for a POST /tickets/bulk aggregate result. `verb` is the past-
// tense action word ('updated' for status/assign, 'deleted' for delete) so the
// message reads naturally. Failures are reported distinctly from skips: "skipped"
// implies pre-validation, "failed" means the write itself errored.
function showBulkOutcomeToast(result: BulkResult, verb: string, t: TFunction): void {
  const { updated, skipped, failed, skippedReasons } = result;
  if (skipped + failed > 0) {
    const reasons = Object.entries(skippedReasons ?? {})
      .map(([code, n]) => t('ticketsPage.bulk.reasonCount', { count: n, reason: skipReasonLabel(code, t) }))
      .join(', ');
    showToast({
      type: 'warning',
      message: t('ticketsPage.bulk.partialToast', {
        updated,
        verb,
        skipped,
        failedSuffix: failed ? t('ticketsPage.bulk.failedSuffix', { failed }) : '',
        reasonsSuffix: reasons ? t('ticketsPage.bulk.reasonsSuffix', { reasons }) : '',
      }),
    });
  } else {
    showToast({ type: 'success', message: t('ticketsPage.bulk.successToast', { updated, verb }) });
  }
}

// 'review' is the inbound email review queue — a sibling surface, not a ticket
// query. It renders InboundReviewQueue instead of the queue/workbench split, and
// is only present for admins (visibility gated by a 200 from the queue endpoint).
// 'archived' is the soft-deleted queue (GET /tickets?deleted=only) — a ticket
// query, but rendered as a restore-only list (no workbench). tickets:manage-gated.
type Tab = 'mine' | 'unassigned' | 'open' | 'breaching' | 'closed' | 'review' | 'archived';
type TicketSort = 'triage' | 'newest' | 'oldest' | 'due';

const SORT_OPTIONS: Array<{ value: TicketSort; labelKey: string }> = [
  { value: 'triage', labelKey: 'triage' },
  { value: 'newest', labelKey: 'newest' },
  { value: 'oldest', labelKey: 'oldest' },
  { value: 'due', labelKey: 'due' }
];

const isTicketSort = (value: string): value is TicketSort =>
  SORT_OPTIONS.some((o) => o.value === value);

const PRIORITY_ORDER: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

// Bulk status options exclude 'resolved': resolving requires a per-ticket
// resolution note, so it stays a per-ticket action (workbench).
const BULK_STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'closed'];

const TABS: Array<{ id: Tab; labelKey: string }> = [
  { id: 'mine', labelKey: 'mine' },
  { id: 'unassigned', labelKey: 'unassigned' },
  { id: 'open', labelKey: 'open' },
  { id: 'breaching', labelKey: 'breaching' },
  { id: 'closed', labelKey: 'closed' }
];

function tabQuery(tab: Exclude<Tab, 'review' | 'archived'>): string {
  switch (tab) {
    case 'mine': return 'statusGroup=open&assignee=me';
    case 'unassigned': return 'statusGroup=open&assignee=unassigned';
    case 'open': return 'statusGroup=open';
    // Server-defined: breached ∪ at-risk (pause-aware — paused clocks are frozen, so
    // paused tickets are intentionally excluded). Rows arrive pre-filtered.
    case 'breaching': return 'statusGroup=open&slaState=breaching';
    case 'closed': return 'statusGroup=closed&sort=newest';
  }
}

// Hash layout (hash-based UI state per CLAUDE.md): `#<selection>&sort=<sort>`.
// The bare segment is the selected ticket key (internal number or id); the
// `sort=` segment carries the queue sort. Both are optional, and the default
// sort ('triage') is omitted so plain `#T-2026-0001` hashes keep working.
// Pure: takes the raw hash (leading `#` already stripped by useHashState, #2421).
function parseHash(hash: string): { selection: string | null; sort: TicketSort } {
  let selection: string | null = null;
  let sort: TicketSort = 'triage';
  for (const part of hash.split('&')) {
    if (!part) continue;
    if (part.startsWith('sort=')) {
      const value = part.slice('sort='.length);
      if (isTicketSort(value)) sort = value;
    } else {
      selection = part;
    }
  }
  return { selection, sort };
}

function hashFor(selection: string | null, sort: TicketSort): string {
  const parts: string[] = [];
  if (selection) parts.push(selection);
  if (sort !== 'triage') parts.push(`sort=${sort}`);
  return parts.length > 0 ? `#${parts.join('&')}` : '';
}

export default function TicketsPage() {
  const { t } = useTranslation('tickets');
  // Soft-delete / restore / archived queue are all tickets:manage-gated (server
  // re-enforces). UX-only: hides controls the caller can't use. Partner/Org Admin.
  const { can } = usePermissions();
  const canManage = can('tickets', 'manage');

  const [tab, setTab] = useState<Tab>('open');
  const [resolveToken, setResolveToken] = useState(0);
  const [paneRefresh, setPaneRefresh] = useState(0);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [stats, setStats] = useState<{ open: number; unassigned: number; mine: number; breached: number; atRisk?: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // SSR-safe hash adoption + hashchange subscription live in the hook (#2421).
  // parse → undefined falls back to the null default, preserving "no selection".
  const [selectedNumber, setSelectedNumber] = useHashState<string | null>(null, (h) => parseHash(h).selection ?? undefined);
  const [sort, setSort] = useHashState<TicketSort>('triage', (h) => parseHash(h).sort);
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
  const fetchSeq = useRef(0);

  // 'mine'/'unassigned' tabs already pin the assignee param; the filter select is locked there.
  const assigneeLocked = tab === 'mine' || tab === 'unassigned';
  const filtersActive = Boolean(priorityFilter || categoryFilter || assigneeFilter);

  const clearFilters = useCallback(() => {
    setPriorityFilter('');
    setCategoryFilter('');
    setAssigneeFilter('');
  }, []);

  // Filter options load once; failures degrade per-select (these are filters, not critical path).
  useEffect(() => {
    let cancelled = false;
    const readJson = async (res: Response): Promise<unknown> => (res.ok ? res.json() : null);
    void (async () => {
      // Load categories + users to populate the filter selects.
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

  const fetchTickets = useCallback(async () => {
    // The review tab isn't a ticket query — it renders InboundReviewQueue, which
    // loads its own data. Skip the /tickets fetch so tabQuery never sees 'review'.
    if (tab === 'review') { setLoading(false); return; }
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(undefined);
    try {
      // The archived tab is a normal ticket query with deleted=only (the server
      // gates it on tickets:manage and stamps each row with deletedAt).
      const params = tab === 'archived'
        ? new URLSearchParams({ deleted: 'only' })
        : new URLSearchParams(tabQuery(tab));
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (priorityFilter) params.set('priority', priorityFilter);
      if (categoryFilter) params.set('categoryId', categoryFilter);
      // The 'mine'/'unassigned' tabs already set assignee; the filter applies only on the other tabs.
      if (assigneeFilter && tab !== 'mine' && tab !== 'unassigned') params.set('assignee', assigneeFilter);
      // 'triage' is the server default, so it's omitted — which also lets the
      // closed tab keep its tabQuery() sort=newest until the user picks a sort.
      if (sort !== 'triage') params.set('sort', sort);
      params.set('limit', '100');
      const res = await fetchWithAuth(`/tickets?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 401) { void navigateTo(loginPathWithNext(), { replace: true }); return; }
        throw new Error(t('ticketsPage.loadFailed'));
      }
      const body = await res.json();
      if (seq !== fetchSeq.current) return;
      setTickets(body.data ?? []);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : t('ticketsPage.loadFailed'));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [tab, debouncedSearch, priorityFilter, categoryFilter, assigneeFilter, sort, t]);

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

  // Patch a single queue row in place after a workbench mutation — instant list
  // feedback without a full /tickets refetch (the heavy 100-row query that, on
  // the connection-capped US droplet, also contended for DB connections).
  const patchTicketRow = useCallback((id: string, patch: Partial<TicketSummary>) => {
    setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

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
  }, [search, priorityFilter, categoryFilter, assigneeFilter]);

  // Single writer for the hash so selection and sort never clobber each other.
  const writeHash = useCallback((selection: string | null, sortValue: TicketSort) => {
    history.replaceState(null, '', hashFor(selection, sortValue) || window.location.pathname + window.location.search);
  }, []);

  const selected = useMemo(
    () => tickets.find((t) => t.internalNumber === selectedNumber || t.id === selectedNumber) ?? null,
    [tickets, selectedNumber]
  );

  // Auto-select first row when nothing valid is selected (UI brief: no-selection state auto-selects)
  useEffect(() => {
    // The review + archived tabs have no ticket selection / workbench pane.
    if (tab === 'review' || tab === 'archived') return;
    if (!loading && tickets.length > 0 && !selected) {
      const first = tickets[0];
      const key = first.internalNumber ?? first.id;
      writeHash(key, sort);
      setSelectedNumber(key);
    }
  }, [tab, loading, tickets, selected, sort, writeHash]);

  const select = useCallback((t: TicketSummary) => {
    // Below the split-pane breakpoint the workbench pane is hidden; navigate
    // to the full-page ticket view instead (list-then-detail navigation).
    if (window.innerWidth < 1100) {
      void navigateTo(`/tickets/${t.id}`);
      return;
    }
    const key = t.internalNumber ?? t.id;
    writeHash(key, sort);
    setSelectedNumber(key);
  }, [sort, writeHash]);

  const move = useCallback((delta: 1 | -1) => {
    if (tickets.length === 0) return;
    const idx = selected ? tickets.findIndex((t) => t.id === selected.id) : -1;
    const next = tickets[Math.min(tickets.length - 1, Math.max(0, idx + delta))];
    if (next) select(next);
  }, [tickets, selected, select]);

  const assignMe = useCallback(async () => {
    if (!selected) return;
    const me = useAuthStore.getState().user;
    const userId = me?.id;
    if (!userId) {
      showToast({ type: 'error', message: t('ticketsPage.assignFailed') });
      return;
    }
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${selected.id}/assign`, { method: 'POST', body: JSON.stringify({ assigneeId: userId }) }),
        errorFallback: t('ticketsPage.assignFailed'),
        successMessage: t('ticketsPage.assignedToYou'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      patchTicketRow(selected.id, { assignedTo: userId, assigneeName: me?.name ?? me?.email ?? null });
      scheduleReconcile();
    } catch (err) {
      // ActionError is already toasted by runAction; surface anything else too.
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('ticketsPage.assignFailed') });
    }
  }, [selected, patchTicketRow, scheduleReconcile, t]);

  const toggleBulkSelect = useCallback((id: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
      clearBulkSelection();
      setPaneRefresh((t) => t + 1);
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
      clearBulkSelection();
      setPaneRefresh((t) => t + 1);
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

  const focusComposer = useCallback((internal: boolean) => {
    const tabBtn = document.querySelector<HTMLButtonElement>(
      internal ? '[data-testid="ticket-composer-tab-internal"]' : '[data-testid="ticket-composer-tab-reply"]'
    );
    tabBtn?.click();
    document.querySelector<HTMLTextAreaElement>('[data-testid="ticket-composer-input"]')?.focus();
  }, []);

  useQueueKeyboard({
    onMove: move,
    onOpen: () => { if (selected) void navigateTo(`/tickets/${selected.id}`); },
    onAssignMe: () => void assignMe(),
    onFocusReply: () => focusComposer(false),
    onFocusInternal: () => focusComposer(true),
    onResolve: () => { if (selected) setResolveToken((t) => t + 1); },
    onEscape: () => (document.activeElement as HTMLElement | null)?.blur()
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

  const filterSelectClass = (active: boolean) =>
    cn(
      // py-1 + leading-tight overrides the @tailwindcss/forms base padding
      // (0.5rem) + 1.5rem line-height that otherwise overflow the fixed h-8
      // box and clip descenders on the displayed value (e.g. "All categories").
      'h-8 max-w-[180px] rounded-md border bg-background px-2 py-1 text-sm leading-tight focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
      active ? 'text-foreground' : 'text-muted-foreground'
    );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tickets-page">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold" data-testid="tickets-heading">{t('ticketsPage.title')}</h1>
        <a
          href="/tickets/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
          data-testid="tickets-create-button"
        >
          <Plus className="h-4 w-4" /> {t('ticketsPage.createTicket')}
        </a>
      </div>

      <div className="mb-3 flex items-center gap-1 border-b">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.id}
            type="button"
            onClick={() => setTab(tabItem.id)}
            data-testid={`tickets-tab-${tabItem.id}`}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium -mb-px',
              tab === tabItem.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t(/* i18n-dynamic */ `ticketsPage.tabs.${tabItem.labelKey}`)}
            {tabCount(tabItem.id) !== null && <span className="ml-1.5 text-xs text-muted-foreground">{tabCount(tabItem.id)}</span>}
          </button>
        ))}
        {reviewAvailable && (
          <button
            type="button"
            onClick={() => setTab('review')}
            data-testid="tickets-tab-review"
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium -mb-px',
              tab === 'review' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t('ticketsPage.reviewQueue')}
            {tabCount('review') !== null && (
              <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-xs font-semibold text-amber-800 dark:bg-amber-500/30 dark:text-amber-200" data-testid="tickets-tab-review-badge">
                {tabCount('review')}
              </span>
            )}
          </button>
        )}
        {canManage && (
          // Soft-deleted queue. tickets:manage only (server re-enforces via
          // deleted=only → 403 for non-managers), so the tab stays hidden otherwise.
          <button
            type="button"
            onClick={() => setTab('archived')}
            data-testid="tickets-tab-archived"
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium -mb-px',
              tab === 'archived' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t('ticketsPage.archived')}
          </button>
        )}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('ticketsPage.searchPlaceholder')}
          data-testid="tickets-search-input"
          className="ml-auto mb-1 w-56 rounded-md border bg-background px-2.5 py-1.5 text-sm"
        />
      </div>

      {tab !== 'review' && (
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="tickets-filter-bar">
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          aria-label={t('ticketsPage.filterByPriority')}
          data-testid="tickets-filter-priority"
          className={filterSelectClass(!!priorityFilter)}
        >
          <option value="">{t('ticketsPage.allPriorities')}</option>
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>{translatedPriorityLabel(config, p, t)}</option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label={t('ticketsPage.filterByCategory')}
          data-testid="tickets-filter-category"
          className={filterSelectClass(!!categoryFilter)}
        >
          <option value="">{t('ticketsPage.allCategories')}</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>{cat.name}</option>
          ))}
        </select>
        {assignees !== null && (
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            disabled={assigneeLocked}
            title={assigneeLocked ? t('ticketsPage.assigneeLockedTitle') : undefined}
            aria-label={t('ticketsPage.filterByAssignee')}
            data-testid="tickets-filter-assignee"
            className={filterSelectClass(!!assigneeFilter)}
          >
            <option value="">{t('ticketsPage.allAssignees')}</option>
            {assignees.map((u) => (
              <option key={u.id} value={u.id}>{u.name || u.email}</option>
            ))}
          </select>
        )}
        <select
          value={sort}
          onChange={(e) => {
            const value = e.target.value;
            if (!isTicketSort(value)) return;
            setSort(value);
            writeHash(selectedNumber, value);
          }}
          aria-label={t('ticketsPage.sortTickets')}
          data-testid="ticket-sort"
          className={filterSelectClass(sort !== 'triage')}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(/* i18n-dynamic */ `ticketsPage.sort.${o.labelKey}`)}</option>
          ))}
        </select>
      </div>
      )}

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
              onRestore={(t) => void restoreTicket(t.id)}
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
            <a href="/settings/partner#ticketing" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="tickets-empty-settings">{t('ticketsPage.ticketingSettings')}</a>
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
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
          <div className="relative flex w-full flex-col min-[1100px]:w-2/5 min-[1100px]:min-w-[320px] min-[1100px]:max-w-[480px] min-[1100px]:border-r">
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <button
                type="button"
                onClick={() => setBulkSelectedIds((prev) => new Set([...prev, ...tickets.map((t) => t.id)]))}
                data-testid="tickets-select-all-header"
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {t('ticketsPage.selectAll')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TicketQueueList
                tickets={tickets}
                selectedId={selected?.id ?? null}
                onSelect={select}
                loading={loading}
                config={config}
                onClearFilters={filtersActive ? clearFilters : undefined}
                bulkSelectedIds={bulkSelectedIds}
                onToggleSelect={toggleBulkSelect}
              />
            </div>
            {bulkSelectedIds.size > 0 && (
              // Slide-up bar at the bottom of the list pane (brief §6). Reuses the
              // global fade-up keyframes (translate-y + fade) at 180ms ease-out.
              <div
                className="absolute inset-x-0 bottom-0 z-10 border-t bg-background px-3 py-2 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.15)] animate-[fade-up_0.18s_ease-out_both]"
                data-testid="tickets-bulk-bar"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">{t('ticketsPage.selectedCount', { count: bulkSelectedIds.size })}</span>
                  <button
                    type="button"
                    // Union, not replace: cross-tab selections off-view must survive.
                    onClick={() => setBulkSelectedIds((prev) => new Set([...prev, ...tickets.map((t) => t.id)]))}
                    data-testid="tickets-bulk-select-all"
                    className="text-sm text-primary hover:underline"
                  >
                    {t('ticketsPage.selectAll')}
                  </button>
                  <select
                    value={bulkAssignee}
                    onChange={(e) => { setBulkAssignee(e.target.value); if (e.target.value) setBulkStatus(''); }}
                    aria-label={t('ticketsPage.bulk.assignToAria')}
                    data-testid="tickets-bulk-assignee"
                    className="h-8 max-w-[150px] rounded-md border bg-background px-2 py-1 text-sm leading-tight"
                  >
                    <option value="">{t('ticketsPage.bulk.assignTo')}</option>
                    <option value="unassign">{t('ticketsPage.bulk.unassign')}</option>
                    {(assignees ?? []).map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                  <select
                    value={bulkStatus}
                    onChange={(e) => { setBulkStatus(e.target.value); if (e.target.value) setBulkAssignee(''); }}
                    aria-label={t('ticketsPage.bulk.setStatusAria')}
                    data-testid="tickets-bulk-status"
                    className="h-8 max-w-[130px] rounded-md border bg-background px-2 py-1 text-sm leading-tight"
                  >
                    <option value="">{t('ticketsPage.bulk.setStatus')}</option>
                    {BULK_STATUSES.map((s) => (
                      <option key={s} value={s}>{translatedStatusLabel(config, s, t)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void applyBulk()}
                    disabled={!bulkAssignee && !bulkStatus}
                    data-testid="tickets-bulk-apply"
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('common:actions.apply')}
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setBulkDeleteOpen(true)}
                      data-testid="tickets-bulk-delete"
                      className="rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10"
                    >
                      {t('common:actions.delete')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={clearBulkSelection}
                    data-testid="tickets-bulk-clear"
                    className="ml-auto rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
                  >
                    {t('ticketsPage.clearSelection')}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="hidden min-w-0 flex-1 min-[1100px]:block">
            {selected ? (
              <TicketWorkbench ticketId={selected.id} resolveRequestToken={resolveToken} refreshToken={paneRefresh} assignees={assignees} categories={categories} onTicketPatched={patchTicketRow} onChanged={scheduleReconcile} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="tickets-no-selection">
                <p>{t('ticketsPage.noSelection')}</p>
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
