import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import TicketQueueList from './TicketQueueList';
import TicketWorkbench from './TicketWorkbench';
import { useQueueKeyboard } from './useQueueKeyboard';
import { slaState, type TicketSummary } from './ticketConfig';

type Tab = 'mine' | 'unassigned' | 'open' | 'breaching' | 'closed';

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
  const [tab, setTab] = useState<Tab>('open');
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [stats, setStats] = useState<{ open: number; unassigned: number; mine: number; breached: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedNumber, setSelectedNumber] = useState<string | null>(selectionFromHash);
  const [search, setSearch] = useState('');

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams(tabQuery(tab));
      if (search) params.set('search', search);
      params.set('limit', '100');
      const res = await fetchWithAuth(`/tickets?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw new Error('Tickets failed to load.');
      }
      const body = await res.json();
      setTickets(body.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tickets failed to load.');
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  const fetchStats = useCallback(async () => {
    const res = await fetchWithAuth('/tickets/stats');
    if (res.ok) {
      const body = await res.json();
      setStats(body.data ?? null);
    }
  }, []);

  useEffect(() => { void fetchTickets(); void fetchStats(); }, [fetchTickets, fetchStats]);

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
      window.location.hash = first.internalNumber ?? first.id;
      setSelectedNumber(first.internalNumber ?? first.id);
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
    window.location.hash = key;
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
    try {
      const meRes = await fetchWithAuth('/users/me');
      if (!meRes.ok) return;
      const me = await meRes.json();
      await runAction({
        request: () => fetchWithAuth(`/tickets/${selected.id}/assign`, { method: 'POST', body: JSON.stringify({ assigneeId: me.id ?? me.data?.id }) }),
        errorFallback: 'Assign failed. Retry.',
        successMessage: 'Assigned to you',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      void fetchTickets();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [selected, fetchTickets]);

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
    onResolve: () => {
      const statusSel = document.querySelector<HTMLSelectElement>('[data-testid="ticket-workbench-status"]');
      if (statusSel) { statusSel.value = 'resolved'; statusSel.dispatchEvent(new Event('change', { bubbles: true })); }
    },
    onEscape: () => (document.activeElement as HTMLElement | null)?.blur()
  });

  const tabCount = (id: Tab): number | null => {
    if (!stats) return null;
    if (id === 'mine') return stats.mine;
    if (id === 'unassigned') return stats.unassigned;
    if (id === 'open') return stats.open;
    if (id === 'breaching') return stats.breached;
    return null;
  };

  const trueEmpty = !loading && tickets.length === 0 && tab === 'open' && !search;

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

      {trueEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center" data-testid="tickets-empty">
          <h2 className="text-base font-medium">No tickets yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Tickets arrive from the customer portal, from alert rules, and from technicians. Create the first one, or wire an alert rule to open tickets automatically.
          </p>
          <div className="mt-3 flex gap-2">
            <a href="/tickets/new" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90">Create ticket</a>
            <a href="/settings/ticketing" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Ticketing settings</a>
          </div>
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center" data-testid="tickets-error">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <button type="button" onClick={() => void fetchTickets()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Retry</button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
          <div className="w-full min-[1100px]:w-2/5 min-[1100px]:min-w-[320px] min-[1100px]:max-w-[480px] overflow-y-auto min-[1100px]:border-r">
            <TicketQueueList tickets={visible} selectedId={selected?.id ?? null} onSelect={select} loading={loading} />
          </div>
          <div className="hidden min-w-0 flex-1 min-[1100px]:block">
            {selected ? (
              <TicketWorkbench ticketId={selected.id} onChanged={() => { void fetchTickets(); void fetchStats(); }} />
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
