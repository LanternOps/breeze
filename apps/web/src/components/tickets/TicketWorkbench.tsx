import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import TicketFeed from './TicketFeed';
import TicketComposer from './TicketComposer';
import SlaChip from './SlaChip';
import { SlaTimers } from './SlaTimers';
import TicketTimeBilling from './TicketTimeBilling';
import TicketPartsCard from './TicketPartsCard';
import { statusConfig, priorityConfig, slaState, type TicketDetail, type TicketStatus, type TicketPriority } from './ticketConfig';
import { fetchTicketConfig, statusLabel, priorityLabel, activeStatusesByCore, type TicketConfig } from '../../lib/ticketConfigApi';
import { onTimerChanged, onBillingChanged } from '../../lib/timerActions';

interface Props {
  ticketId: string;
  onChanged?: () => void;       // queue refresh hook
  expanded?: boolean;            // full-page mode
  resolveRequestToken?: number;  // increments when the page-level `e` shortcut asks to open the resolve form
  refreshToken?: number;         // bumped by bulk actions in the queue after they mutate tickets
  // Host-supplied assignee list (TicketsPage already fetches /users for its
  // filter bar). When provided — including null for "picker hidden" — the
  // workbench skips its own /users fetch; undefined keeps the standalone
  // self-fetch (full-page /tickets/[id] view).
  assignees?: Array<{ id: string; name: string | null; email: string }> | null;
}

const STATUS_OPTIONS: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];
const PRIORITY_OPTIONS: TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

export default function TicketWorkbench({ ticketId, onChanged, expanded, resolveRequestToken, refreshToken, assignees: assigneesProp }: Props) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<'not-found' | 'load' | undefined>();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const [pendingOpen, setPendingOpen] = useState<'pending' | 'on_hold' | null>(null);
  const [pendingReason, setPendingReason] = useState('');
  // When the user picks a custom-status row (config path), its id is stashed so
  // the gated resolve/pending POST sends {statusId}; null means the core path.
  const [pendingStatusId, setPendingStatusId] = useState<string | null>(null);
  const [railOpen] = useState(true);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  // Ticket configuration (custom statuses + priority labels). null = not loaded
  // or fetch failed; every render falls back to the static core config.
  const [config, setConfig] = useState<TicketConfig | null>(null);

  // null = picker hidden (no USERS_READ etc.); degrade to a label + unassign-only button.
  const [fetchedAssignees, setFetchedAssignees] = useState<Array<{ id: string; name: string | null; email: string }> | null>(null);
  const assigneesProvided = assigneesProp !== undefined;
  const assignees = assigneesProvided ? assigneesProp : fetchedAssignees;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setErrorKind(undefined);
    try {
      const res = await fetchWithAuth(`/tickets/${ticketId}`);
      if (res.status === 404 || res.status === 403) {
        setTicket(null);
        setError('Ticket not found. It may have been deleted, or you may not have access to it.');
        setErrorKind('not-found');
        return;
      }
      if (!res.ok) throw new Error('Ticket failed to load.');
      const body = await res.json();
      setTicket(body.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ticket failed to load.');
      setErrorKind('load');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => { void load(); }, [load]);

  // Bulk actions in the queue mutate tickets behind the pane's back; the parent
  // bumps refreshToken after a bulk apply so the detail can't go stale. The ref
  // guard makes the effect fire only on an actual token bump — without it, a
  // ticketId change (new `load` identity) with a non-zero token would refetch a
  // second time on every j/k switch.
  const lastRefreshToken = useRef(refreshToken ?? 0);
  useEffect(() => {
    if (refreshToken !== undefined && refreshToken !== lastRefreshToken.current) {
      lastRefreshToken.current = refreshToken;
      void load();
    }
  }, [refreshToken, load]);

  // Reset the inline resolve form when switching tickets — otherwise ticket B
  // could be resolved with ticket A's note (`e` on A, then `j` to B).
  // Dropping the ticket also brings back the first-load skeleton for the new
  // ticket, unmounting the composer so its draft/mode can't leak across
  // tickets — same-ticket refreshes keep the tree mounted (see render below).
  useEffect(() => {
    setTicket(null);
    setResolveOpen(false);
    setResolutionNote('');
    setPendingOpen(null);
    setPendingReason('');
    setPendingStatusId(null);
  }, [ticketId]);

  // Page-level `e` shortcut: open the inline resolve form (UI brief: `e` opens the resolution-note form)
  useEffect(() => {
    if (resolveRequestToken) setResolveOpen(true);
  }, [resolveRequestToken]);

  // Fetch assignees once; degrade gracefully if the endpoint is unavailable.
  // Skipped entirely when the host already supplies the list via the prop.
  useEffect(() => {
    if (assigneesProvided) return;
    let cancelled = false;
    void fetchWithAuth('/users')
      .then(async (r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const rows = Array.isArray(body) ? body : (body as { data?: unknown }).data;
        if (Array.isArray(rows))
          setFetchedAssignees((rows as Array<{ id: string; name: string | null; email: string }>).filter((u) => u.id));
      })
      .catch(() => { /* degraded mode keeps the unassign-only affordance */ });
    return () => { cancelled = true; };
  }, [assigneesProvided]);

  // Fetch ticket config once (module-cached across islands). Failure leaves
  // config null, which keeps the six-core-status fallback select fully working.
  useEffect(() => {
    let cancelled = false;
    void fetchTicketConfig().then((c) => {
      if (!cancelled && c) setConfig(c);
    });
    return () => { cancelled = true; };
  }, []);

  // Reload the feed (time-entry lines appear) when timer stops or parts/time change.
  useEffect(() => {
    const unsubTimer = onTimerChanged(() => void load());
    const unsubBilling = onBillingChanged(() => void load());
    return () => { unsubTimer(); unsubBilling(); };
  }, [load]);

  // Returns true on success, false on a swallowed ActionError — callers with
  // form state (resolve/pending) must only close/clear when the POST landed.
  const mutate = useCallback(async (path: string, body: unknown, success: string): Promise<boolean> => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}${path}`, { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: `${success} failed. Retry.`,
        successMessage: success,
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      await load();
      onChanged?.();
      return true;
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      return false; // already toasted by runAction
    }
  }, [ticketId, load, onChanged]);

  // Assemble a draft invoice from this ticket's billable work, then jump to it.
  const createInvoice = useCallback(async () => {
    if (creatingInvoice) return;
    setCreatingInvoice(true);
    try {
      const result = await runAction<{ data: { invoice: { id: string } } }>({
        request: () => fetchWithAuth(`/tickets/${ticketId}/invoice`, { method: 'POST' }),
        errorFallback: 'Could not create an invoice from this ticket.',
        successMessage: 'Draft invoice created',
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      const newId = result?.data?.invoice?.id;
      if (newId) void navigateTo(`/billing/invoices/${newId}`);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setCreatingInvoice(false);
    }
  }, [ticketId, creatingInvoice]);

  // Fallback path: option values are the six core enums; POST {status}.
  const onStatusChange = useCallback(async (status: TicketStatus) => {
    setPendingStatusId(null);
    if (status === 'resolved') { setResolveOpen(true); return; }
    if (status === 'pending' || status === 'on_hold') { setPendingOpen(status); return; }
    await mutate('/status', { status }, 'Status updated');
  }, [mutate]);

  // Config path: option values are custom-status row ids; the chosen row's
  // coreStatus drives the same resolve/pending forms, and the POST sends
  // {statusId} so resolved/pending custom statuses behave like their core peers.
  const onCustomStatusChange = useCallback(async (statusId: string) => {
    const row = config?.statuses.find((s) => s.id === statusId);
    if (!row) return;
    if (row.coreStatus === 'resolved') { setPendingStatusId(statusId); setResolveOpen(true); return; }
    if (row.coreStatus === 'pending' || row.coreStatus === 'on_hold') {
      setPendingStatusId(statusId);
      setPendingOpen(row.coreStatus);
      return;
    }
    setPendingStatusId(null);
    await mutate('/status', { statusId }, 'Status updated');
  }, [config, mutate]);

  const submitResolve = useCallback(async () => {
    if (!resolutionNote.trim()) return;
    const target = pendingStatusId ? { statusId: pendingStatusId } : { status: 'resolved' as const };
    const ok = await mutate('/status', { ...target, resolutionNote: resolutionNote.trim() }, 'Ticket resolved');
    if (!ok) return; // keep the form open and the typed note intact on failure
    setResolveOpen(false);
    setResolutionNote('');
    setPendingStatusId(null);
  }, [mutate, resolutionNote, pendingStatusId]);

  const submitPending = useCallback(async () => {
    if (!pendingOpen) return;
    const reason = pendingReason.trim();
    const target = pendingStatusId ? { statusId: pendingStatusId } : { status: pendingOpen };
    const ok = await mutate('/status', { ...target, ...(reason ? { pendingReason: reason } : {}) }, 'Status updated');
    if (!ok) return; // keep the form open and the typed reason intact on failure
    setPendingOpen(null);
    setPendingReason('');
    setPendingStatusId(null);
  }, [mutate, pendingOpen, pendingReason, pendingStatusId]);

  const sendComment = useCallback(async (content: string, isPublic: boolean) => {
    await runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify({ content, isPublic }) }),
      errorFallback: 'Reply failed. Retry.',
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    });
    await load();
    onChanged?.();
  }, [ticketId, load, onChanged]);

  // Skeleton only on the first load of a ticket. Refreshes (send, status
  // change, refreshToken bump) keep the tree mounted so composer state —
  // the public/internal tab in particular — survives; aria-busy marks them.
  if (loading && !ticket) {
    return <div className="p-6 animate-pulse space-y-3" data-testid="ticket-workbench-loading">
      <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-4 w-1/3 rounded bg-muted/60" /><div className="h-40 rounded bg-muted/40" />
    </div>;
  }
  if (error || !ticket) {
    return (
      <div className="p-6 text-center" data-testid="ticket-workbench-error">
        <p className="text-sm text-muted-foreground">{error ?? 'Ticket failed to load.'}</p>
        {errorKind === 'not-found' ? (
          <a href="/tickets" className="mt-2 inline-block rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="ticket-workbench-back">Back to queue</a>
        ) : (
          <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Retry</button>
        )}
      </div>
    );
  }

  // Which option is selected in the config-path select: the active row whose
  // name matches the ticket's custom status within its core state, else the
  // system row for that core state (so legacy/null statusName tickets land on
  // the built-in option rather than showing an empty select).
  const selectedStatusId = config
    ? (config.statuses.find((s) => s.coreStatus === ticket.status && s.isActive && ticket.statusName && s.name === ticket.statusName)
        ?? config.statuses.find((s) => s.coreStatus === ticket.status && s.isSystem))?.id ?? null
    : null;
  const headerStatusColor = ticket.statusColor ?? config?.statuses.find((s) => s.id === selectedStatusId)?.color ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ticket-workbench" aria-busy={loading || undefined}>
      {/* Header */}
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground" data-testid="ticket-workbench-number">{ticket.internalNumber ?? ticket.id.slice(0, 8)}</span>
          <h2 className="truncate text-base font-semibold">{ticket.subject}</h2>
          {!expanded && (
            <a href={`/tickets/${ticket.id}`} className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground" title="Open full page" data-testid="ticket-workbench-expand">
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{ticket.orgName}</span>
          {ticket.deviceHostname && (
            <>
              <span>·</span>
              <a className="hover:text-foreground hover:underline" href={`/devices?device=${ticket.deviceId}`}>{ticket.deviceHostname}</a>
            </>
          )}
          {slaState(ticket).kind !== 'none' && (
            // SlaChip renders nothing for no-SLA tickets — the separator must follow suit.
            <>
              <span>·</span>
              <SlaChip ticket={ticket} />
            </>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {config ? (
            // Config path: optgroup per core state with the active custom statuses
            // (option value = row id). The selected value is the row matching the
            // ticket's custom status name within its core state, falling back to
            // the system row for that core state.
            <select
              value={selectedStatusId ?? ''}
              onChange={(e) => void onCustomStatusChange(e.target.value)}
              className={cn('rounded-md border border-l-4 px-2 py-1 text-xs font-medium', statusConfig[ticket.status].color)}
              style={headerStatusColor ? { borderLeftColor: headerStatusColor } : undefined}
              data-testid="ticket-workbench-status"
              aria-label="Status"
            >
              {activeStatusesByCore(config).map(({ coreStatus, statuses }) =>
                statuses.length > 0 ? (
                  <optgroup key={coreStatus} label={statusConfig[coreStatus].label}>
                    {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                ) : null
              )}
            </select>
          ) : (
            <select
              value={ticket.status}
              onChange={(e) => void onStatusChange(e.target.value as TicketStatus)}
              className={cn('rounded-md border px-2 py-1 text-xs font-medium', statusConfig[ticket.status].color)}
              data-testid="ticket-workbench-status"
              aria-label="Status"
            >
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusConfig[s].label}</option>)}
            </select>
          )}
          <select
            value={ticket.priority}
            onChange={(e) => {
              void runAction({
                request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ priority: e.target.value }) }),
                errorFallback: 'Priority update failed. Retry.',
                onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
              }).then(() => { void load(); onChanged?.(); }).catch((err) => { if (!(err instanceof ActionError)) throw err; });
            }}
            className={cn('rounded-md border px-2 py-1 text-xs font-medium', priorityConfig[ticket.priority].color)}
            data-testid="ticket-workbench-priority"
            aria-label="Priority"
          >
            {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{priorityLabel(config, p)}</option>)}
          </select>
          {assignees !== null ? (
            <select
              value={ticket.assignedTo ?? ''}
              onChange={(e) => {
                const next = e.target.value || null;
                if (next === (ticket.assignedTo ?? null)) return; // no-op guard: never write a bogus feed entry
                void mutate('/assign', { assigneeId: next }, next ? 'Assigned' : 'Unassigned');
              }}
              className="max-w-[180px] rounded-md border px-2 py-1 text-xs"
              data-testid="ticket-workbench-assignee"
              aria-label="Assignee"
            >
              <option value="">Unassigned</option>
              {ticket.assignedTo && !assignees.some((u) => u.id === ticket.assignedTo) && (
                // Assignee exists but is RLS-invisible to this caller (partner staff seen
                // from org scope) — show a redacted label instead of pretending unassigned.
                <option value={ticket.assignedTo}>{ticket.assigneeName ?? 'MSP staff'}</option>
              )}
              {assignees.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          ) : ticket.assignedTo ? (
            <button
              type="button"
              onClick={() => void mutate('/assign', { assigneeId: null }, 'Unassigned')}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
              data-testid="ticket-workbench-unassign"
            >
              Assignee: {ticket.assigneeName ?? 'MSP staff'} ✕
            </button>
          ) : (
            <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground" data-testid="ticket-workbench-unassigned">Unassigned</span>
          )}
          <button
            type="button"
            onClick={() => void createInvoice()}
            disabled={creatingInvoice}
            className="ml-auto rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            data-testid="ticket-workbench-create-invoice"
          >
            {creatingInvoice ? 'Creating…' : 'Create invoice'}
          </button>
        </div>
        {resolveOpen && (
          <div className="mt-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-workbench-resolve-form">
            <label className="text-xs font-medium" htmlFor="resolve-note">Resolution note (visible to requester)</label>
            <textarea
              id="resolve-note"
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              data-testid="ticket-workbench-resolve-note"
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button type="button" onClick={() => { setResolveOpen(false); setPendingStatusId(null); }} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">Cancel</button>
              <button
                type="button"
                onClick={() => void submitResolve()}
                disabled={!resolutionNote.trim()}
                className="rounded-md bg-success px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                data-testid="ticket-workbench-resolve-submit"
              >
                Resolve ticket
              </button>
            </div>
          </div>
        )}
        {pendingOpen && (
          <div className="mt-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-workbench-pending-form">
            <label className="text-xs font-medium" htmlFor="pending-reason">What are you waiting on? (optional)</label>
            <textarea
              id="pending-reason"
              value={pendingReason}
              onChange={(e) => setPendingReason(e.target.value)}
              rows={2}
              maxLength={500}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              data-testid="ticket-workbench-pending-reason"
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button type="button" onClick={() => { setPendingOpen(null); setPendingReason(''); setPendingStatusId(null); }} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">Cancel</button>
              <button
                type="button"
                onClick={() => void submitPending()}
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white"
                data-testid="ticket-workbench-pending-submit"
              >
                {pendingOpen === 'pending' ? 'Set pending' : 'Put on hold'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Body: feed + rail */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {ticket.description && (
              <div className="border-b p-4">
                <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
              </div>
            )}
            <TicketFeed comments={ticket.comments} />
          </div>
          <TicketComposer requesterName={ticket.submitterName} onSend={sendComment} />
        </div>
        {railOpen && (
          <aside className="w-64 shrink-0 overflow-y-auto border-l p-3 text-sm hidden lg:block" data-testid="ticket-workbench-rail">
            <div className="space-y-3">
              {/* Per-target SLA timers; renders nothing (no gap) when the ticket has no SLA targets. */}
              <SlaTimers ticket={ticket} />
              <TicketTimeBilling ticketId={ticket.id} />
              <TicketPartsCard ticketId={ticket.id} />
              <dl className="space-y-3">
                <div><dt className="text-xs text-muted-foreground">Requester</dt><dd>{ticket.submitterName ?? ticket.submitterEmail ?? 'Unknown'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Source</dt><dd className="capitalize">{ticket.source}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Created</dt><dd>{new Date(ticket.createdAt).toLocaleString()}</dd></div>
                {ticket.dueDate && <div><dt className="text-xs text-muted-foreground">Due</dt><dd>{new Date(ticket.dueDate).toLocaleString()}</dd></div>}
                {ticket.pendingReason && <div><dt className="text-xs text-muted-foreground">Waiting on</dt><dd>{ticket.pendingReason}</dd></div>}
                {ticket.resolutionNote && (ticket.status === 'resolved' || ticket.status === 'closed') && (
                  <div><dt className="text-xs text-muted-foreground">Resolution</dt><dd>{ticket.resolutionNote}</dd></div>
                )}
                <div>
                  <dt className="text-xs text-muted-foreground">Linked alerts</dt>
                  <dd className="space-y-1">
                    {ticket.alertLinks.length === 0 && <span className="text-muted-foreground">None</span>}
                    {ticket.alertLinks.map((l) => (
                      <a key={l.id} href={`/alerts#${l.alertId}`} className="block truncate hover:underline" data-testid={`ticket-alert-link-${l.alertId}`}>
                        {l.alertTitle ?? l.alertId}
                      </a>
                    ))}
                  </dd>
                </div>
              </dl>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
