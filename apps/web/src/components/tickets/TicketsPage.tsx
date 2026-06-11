import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims, loginPathWithNext } from '../../lib/authScope';
import TicketQueueList from './TicketQueueList';
import TicketWorkbench from './TicketWorkbench';
import { useQueueKeyboard } from './useQueueKeyboard';
import { priorityConfig, statusConfig, slaState, type TicketPriority, type TicketStatus, type TicketSummary } from './ticketConfig';

// Human-readable labels for bulk-skip reason codes returned by POST /tickets/bulk.
const SKIP_REASON_LABELS: Record<string, string> = {
  OUT_OF_SCOPE: 'out of your scope',
  INVALID_TRANSITION: 'invalid status change',
  ASSIGNEE_NOT_FOUND: 'assignee not found',
  ASSIGNEE_WRONG_PARTNER: 'assignee belongs to another partner',
  CONCURRENT_MODIFICATION: 'modified by someone else',
  TICKET_PARTNER_UNRESOLVABLE: 'ticket partner unresolvable',
  OTHER: 'other errors'
};

type Tab = 'mine' | 'unassigned' | 'open' | 'breaching' | 'closed';

const PRIORITY_ORDER: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

// Bulk status options exclude 'resolved': resolving requires a per-ticket
// resolution note, so it stays a per-ticket action (workbench).
const BULK_STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'closed'];

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'mine', label: 'My tickets' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'open', label: 'All open' },
  { id: 'breaching', label: 'Breaching soon' },
  { id: 'closed', label: 'Closed' }
];

function tabQuery(tab: Tab): string {
  switch (tab) {
    case 'mine': return 'statusGroup=open&assignee=me';
    case 'unassigned': return 'statusGroup=open&assignee=unassigned';
    case 'open': return 'statusGroup=open';
    case 'breaching': return 'statusGroup=open'; // client-filters to at-risk/breached below
    case 'closed': return 'statusGroup=closed&sort=newest';
  }
}

function selectionFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location.hash.replace('#', '') || null;
}

export default function TicketsPage() {
  // Re-read per render to hide the org filter for org-scoped users. On a cold
  // page load the memory-only access token may not exist yet, so this can read
  // null scope before token bootstrap — the options effect below re-reads the
  // claims after its first fetches bootstrap the token, and `orgs.length > 1`
  // keeps the filter hidden either way (belt and braces).
  const orgScoped = getJwtClaims().scope === 'organization';

  const [tab, setTab] = useState<Tab>('open');
  const [resolveToken, setResolveToken] = useState(0);
  const [paneRefresh, setPaneRefresh] = useState(0);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [stats, setStats] = useState<{ open: number; unassigned: number; mine: number; breached: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedNumber, setSelectedNumber] = useState<string | null>(selectionFromHash);
  const [search, setSearch] = useState('');
  const [orgFilter, setOrgFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  // null = assignee select hidden (e.g. caller lacks USERS_READ); graceful degradation, no error UI.
  const [assignees, setAssignees] = useState<Array<{ id: string; name: string | null; email: string }> | null>(null);
  // Bulk selection (UI brief §6): checkbox column + slide-up action bar.
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAssignee, setBulkAssignee] = useState(''); // '' = none; 'unassign' sentinel = null assignee
  const [bulkStatus, setBulkStatus] = useState('');
  const fetchSeq = useRef(0);

  // 'mine'/'unassigned' tabs already pin the assignee param; the filter select is locked there.
  const assigneeLocked = tab === 'mine' || tab === 'unassigned';
  const filtersActive = Boolean(orgFilter || priorityFilter || categoryFilter || assigneeFilter);

  const clearFilters = useCallback(() => {
    setOrgFilter('');
    setPriorityFilter('');
    setCategoryFilter('');
    setAssigneeFilter('');
  }, []);

  // Filter options load once; failures degrade per-select (these are filters, not critical path).
  useEffect(() => {
    let cancelled = false;
    const readJson = async (res: Response): Promise<unknown> => (res.ok ? res.json() : null);
    void (async () => {
      // Categories + users first: access tokens are memory-only, so on a cold
      // load the JWT claims are unreadable at mount — these fetches bootstrap
      // the token before we decide whether the orgs fetch is allowed.
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
      // Token is bootstrapped by the fetches above, so the claims read is reliable now.
      // Org-scoped users can't list organizations (403 console spam) and don't need
      // the filter — their queue is already single-org.
      const orgScopedNow = getJwtClaims().scope === 'organization';
      if (!orgScopedNow) {
        const orgBody = await fetchWithAuth('/orgs/organizations?limit=100').then(readJson).catch(() => null);
        if (cancelled || !orgBody) return;
        const body = orgBody as { data?: Array<{ id: string; name: string }>; organizations?: Array<{ id: string; name: string }> };
        setOrgs((body.data ?? body.organizations ?? []).filter((o) => o.id && o.name));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const fetchTickets = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams(tabQuery(tab));
      if (search) params.set('search', search);
      if (orgFilter) params.set('orgId', orgFilter);
      if (priorityFilter) params.set('priority', priorityFilter);
      if (categoryFilter) params.set('categoryId', categoryFilter);
      // The 'mine'/'unassigned' tabs already set assignee; the filter applies only on the other tabs.
      if (assigneeFilter && tab !== 'mine' && tab !== 'unassigned') params.set('assignee', assigneeFilter);
      params.set('limit', '100');
      const res = await fetchWithAuth(`/tickets?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 401) { void navigateTo(loginPathWithNext(), { replace: true }); return; }
        throw new Error('Tickets failed to load.');
      }
      const body = await res.json();
      if (seq !== fetchSeq.current) return;
      setTickets(body.data ?? []);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : 'Tickets failed to load.');
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [tab, search, orgFilter, priorityFilter, categoryFilter, assigneeFilter]);

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

  // Selection is per-view: switching tab or changing any filter/search clears it.
  useEffect(() => {
    setBulkSelectedIds(new Set());
    setBulkAssignee('');
    setBulkStatus('');
  }, [tab, search, orgFilter, priorityFilter, categoryFilter, assigneeFilter]);

  useEffect(() => {
    const onHash = () => setSelectedNumber(selectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const visible = useMemo(() => {
    if (tab !== 'breaching') return tickets;
    return tickets.filter((t) => ['at-risk', 'breached'].includes(slaState(t).kind));
  }, [tickets, tab]);

  const selected = useMemo(
    () => visible.find((t) => t.internalNumber === selectedNumber || t.id === selectedNumber) ?? null,
    [visible, selectedNumber]
  );

  // Auto-select first row when nothing valid is selected (UI brief: no-selection state auto-selects)
  useEffect(() => {
    if (!loading && visible.length > 0 && !selected) {
      const first = visible[0];
      const key = first.internalNumber ?? first.id;
      history.replaceState(null, '', `#${key}`);
      setSelectedNumber(key);
    }
  }, [loading, visible, selected]);

  const select = useCallback((t: TicketSummary) => {
    // Below the split-pane breakpoint the workbench pane is hidden; navigate
    // to the full-page ticket view instead (list-then-detail navigation).
    if (window.innerWidth < 1100) {
      void navigateTo(`/tickets/${t.id}`);
      return;
    }
    const key = t.internalNumber ?? t.id;
    history.replaceState(null, '', `#${key}`);
    setSelectedNumber(key);
  }, []);

  const move = useCallback((delta: 1 | -1) => {
    if (visible.length === 0) return;
    const idx = selected ? visible.findIndex((t) => t.id === selected.id) : -1;
    const next = visible[Math.min(visible.length - 1, Math.max(0, idx + delta))];
    if (next) select(next);
  }, [visible, selected, select]);

  const assignMe = useCallback(async () => {
    if (!selected) return;
    const userId = useAuthStore.getState().user?.id;
    if (!userId) {
      showToast({ type: 'error', message: 'Assign failed. Retry.' });
      return;
    }
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${selected.id}/assign`, { method: 'POST', body: JSON.stringify({ assigneeId: userId }) }),
        errorFallback: 'Assign failed. Retry.',
        successMessage: 'Assigned to you',
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      void fetchTickets();
      void fetchStats();
    } catch (err) {
      // ActionError is already toasted by runAction; surface anything else too.
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Assign failed. Retry.' });
    }
  }, [selected, fetchTickets, fetchStats]);

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
      const result = await runAction<{ data: { updated: number; skipped: number; failed: number; total: number; skippedReasons?: Record<string, number> } }>({
        request: () => fetchWithAuth('/tickets/bulk', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: 'Bulk update failed. Retry.',
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      const { updated, skipped, failed, skippedReasons } = result.data;
      if (skipped + failed > 0) {
        const reasons = Object.entries(skippedReasons ?? {})
          .map(([code, n]) => `${n} ${SKIP_REASON_LABELS[code] ?? code.toLowerCase().replace(/_/g, ' ')}`)
          .join(', ');
        // Failures are reported distinctly from skips — "skipped" implies a
        // pre-validation outcome, "failed" means the write itself errored.
        showToast({ type: 'warning', message: `${updated} updated, ${skipped} skipped${failed ? `, ${failed} failed` : ''}${reasons ? ` — ${reasons}` : ''}` });
      } else {
        showToast({ type: 'success', message: `${updated} updated` });
      }
      clearBulkSelection();
      setPaneRefresh((t) => t + 1);
      void fetchTickets();
      void fetchStats();
    } catch (err) {
      // ActionError is already toasted by runAction; surface anything else too.
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Bulk update failed. Retry.' });
    }
  }, [bulkSelectedIds, bulkAssignee, bulkStatus, clearBulkSelection, fetchTickets, fetchStats]);

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
    if (!stats) return null;
    if (id === 'mine') return stats.mine;
    if (id === 'unassigned') return stats.unassigned;
    if (id === 'open') return stats.open;
    // No badge for 'breaching': the server stat counts only breached, but the tab also shows at-risk — no honest count available cheaply.
    return null;
  };

  const trueEmpty = !loading && tickets.length === 0 && tab === 'open' && !search && !filtersActive && !error;

  const filterSelectClass = (active: boolean) =>
    cn(
      'h-8 max-w-[180px] rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
      active ? 'text-foreground' : 'text-muted-foreground'
    );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tickets-page">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold" data-testid="tickets-heading">Tickets</h1>
        <a
          href="/tickets/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
          data-testid="tickets-create-button"
        >
          <Plus className="h-4 w-4" /> Create ticket
        </a>
      </div>

      <div className="mb-3 flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`tickets-tab-${t.id}`}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium -mb-px',
              tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
            {tabCount(t.id) !== null && <span className="ml-1.5 text-xs text-muted-foreground">{tabCount(t.id)}</span>}
          </button>
        ))}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tickets"
          data-testid="tickets-search-input"
          className="ml-auto mb-1 w-56 rounded-md border bg-background px-2.5 py-1.5 text-sm"
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="tickets-filter-bar">
        {!orgScoped && orgs.length > 1 && (
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            aria-label="Filter by organization"
            data-testid="tickets-filter-org"
            className={filterSelectClass(!!orgFilter)}
          >
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        )}
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          aria-label="Filter by priority"
          data-testid="tickets-filter-priority"
          className={filterSelectClass(!!priorityFilter)}
        >
          <option value="">All priorities</option>
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>{priorityConfig[p].label}</option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by category"
          data-testid="tickets-filter-category"
          className={filterSelectClass(!!categoryFilter)}
        >
          <option value="">All categories</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>{cat.name}</option>
          ))}
        </select>
        {assignees !== null && (
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            disabled={assigneeLocked}
            title={assigneeLocked ? 'Tab already filters by assignee' : undefined}
            aria-label="Filter by assignee"
            data-testid="tickets-filter-assignee"
            className={filterSelectClass(!!assigneeFilter)}
          >
            <option value="">All assignees</option>
            {assignees.map((u) => (
              <option key={u.id} value={u.id}>{u.name || u.email}</option>
            ))}
          </select>
        )}
      </div>

      {trueEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center" data-testid="tickets-empty">
          <h2 className="text-base font-medium">No tickets yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Tickets arrive from the customer portal, from alert rules, and from technicians. Create the first one, or wire an alert rule to open tickets automatically.
          </p>
          <div className="mt-3 flex gap-2">
            <a href="/tickets/new" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90" data-testid="tickets-empty-create">Create ticket</a>
            <a href="/settings/ticketing" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="tickets-empty-settings">Ticketing settings</a>
          </div>
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center" data-testid="tickets-error">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <button type="button" onClick={() => void fetchTickets()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="tickets-error-retry">Retry</button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
          <div className="relative flex w-full flex-col min-[1100px]:w-2/5 min-[1100px]:min-w-[320px] min-[1100px]:max-w-[480px] min-[1100px]:border-r">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TicketQueueList
                tickets={visible}
                selectedId={selected?.id ?? null}
                onSelect={select}
                loading={loading}
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
                  <span className="text-sm font-medium tabular-nums">{bulkSelectedIds.size} selected</span>
                  <button
                    type="button"
                    onClick={() => setBulkSelectedIds(new Set(visible.map((t) => t.id)))}
                    data-testid="tickets-bulk-select-all"
                    className="text-sm text-primary hover:underline"
                  >
                    Select all
                  </button>
                  <select
                    value={bulkAssignee}
                    onChange={(e) => { setBulkAssignee(e.target.value); if (e.target.value) setBulkStatus(''); }}
                    aria-label="Bulk assign to"
                    data-testid="tickets-bulk-assignee"
                    className="h-8 max-w-[150px] rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">Assign to…</option>
                    <option value="unassign">Unassign</option>
                    {(assignees ?? []).map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                  <select
                    value={bulkStatus}
                    onChange={(e) => { setBulkStatus(e.target.value); if (e.target.value) setBulkAssignee(''); }}
                    aria-label="Bulk set status"
                    data-testid="tickets-bulk-status"
                    className="h-8 max-w-[130px] rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">Set status…</option>
                    {BULK_STATUSES.map((s) => (
                      <option key={s} value={s}>{statusConfig[s].label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void applyBulk()}
                    disabled={!bulkAssignee && !bulkStatus}
                    data-testid="tickets-bulk-apply"
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={clearBulkSelection}
                    data-testid="tickets-bulk-clear"
                    className="ml-auto rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="hidden min-w-0 flex-1 min-[1100px]:block">
            {selected ? (
              <TicketWorkbench ticketId={selected.id} resolveRequestToken={resolveToken} refreshToken={paneRefresh} assignees={assignees} onChanged={() => { void fetchTickets(); void fetchStats(); }} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="tickets-no-selection">
                <p>Select a ticket. Use j/k to move, Enter to expand.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
