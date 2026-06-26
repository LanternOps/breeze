import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { listCannedResponses, type CannedResponse } from '../../lib/ticketResponseTemplatesApi';
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
import { formatDateTime } from '@/lib/dateTimeFormat';

// ─── TagEditor ───────────────────────────────────────────────────────────────

interface TagEditorProps {
  value: string[];
  max?: number;
  onChange: (tags: string[]) => void;
  'data-testid'?: string;
}

function TagEditor({ value, max = 20, onChange, 'data-testid': testId }: TagEditorProps) {
  const [input, setInput] = useState('');

  const addTag = () => {
    const trimmed = input.trim().slice(0, 50);
    if (!trimmed || value.includes(trimmed) || value.length >= max) return;
    onChange([...value, trimmed]);
    setInput('');
  };

  return (
    <div data-testid={testId} className="flex flex-wrap gap-1">
      {value.map((tag) => (
        <span key={tag} className="flex items-center gap-0.5 rounded border bg-muted px-1.5 py-0.5 text-xs">
          {tag}
          <button
            type="button"
            data-testid={`ticket-workbench-tag-remove-${tag}`}
            className="ml-0.5 hover:text-destructive"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag}`}
          >
            ×
          </button>
        </span>
      ))}
      {value.length < max && (
        <input
          type="text"
          data-testid="ticket-workbench-tag-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addTag(); }
          }}
          onBlur={addTag}
          placeholder="Add tag…"
          maxLength={50}
          className="rounded border bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          aria-label="Add tag"
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  ticketId: string;
  onChanged?: () => void;       // queue refresh hook (debounced background reconcile)
  // Optimistic row patch: lets the host update the matching queue row in place
  // the instant a mutation lands, so the list reflects the change without waiting
  // for (or paying for) a full list refetch. `onChanged` still reconciles after.
  onTicketPatched?: (id: string, patch: Partial<TicketDetail>) => void;
  expanded?: boolean;            // full-page mode
  resolveRequestToken?: number;  // increments when the page-level `e` shortcut asks to open the resolve form
  refreshToken?: number;         // bumped by bulk actions in the queue after they mutate tickets
  // Host-supplied assignee list (TicketsPage already fetches /users for its
  // filter bar). When provided — including null for "picker hidden" — the
  // workbench skips its own /users fetch; undefined keeps the standalone
  // self-fetch (full-page /tickets/[id] view).
  assignees?: Array<{ id: string; name: string | null; email: string }> | null;
  categories?: Array<{ id: string; name: string }>;
}

const STATUS_OPTIONS: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];
const PRIORITY_OPTIONS: TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

// Sentinel for the "type a requester manually" choice in the requester editor.
const MANUAL_REQUESTER = '__manual__';

type TicketTriageSuggestion = {
  modelVersion: string;
  confidence: number;
  priority: TicketPriority | null;
  categoryId: string | null;
  categoryName: string | null;
  reasons: string[];
};

export default function TicketWorkbench({ ticketId, onChanged, onTicketPatched, expanded, resolveRequestToken, refreshToken, assignees: assigneesProp, categories = [] }: Props) {
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
  const [moveOrgOpen, setMoveOrgOpen] = useState(false);
  const [moveOrgTargetId, setMoveOrgTargetId] = useState('');
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  // Ticket configuration (custom statuses + priority labels). null = not loaded
  // or fetch failed; every render falls back to the static core config.
  const [config, setConfig] = useState<TicketConfig | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const descriptionTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Requester editor: picker options (portal users for the org) + edit state.
  const [requesters, setRequesters] = useState<Array<{ id: string; name: string | null; email: string }>>([]);
  const [editingRequester, setEditingRequester] = useState(false);
  const [reqSel, setReqSel] = useState('');
  const [reqName, setReqName] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [triageSuggestion, setTriageSuggestion] = useState<TicketTriageSuggestion | null>(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [applyingTriage, setApplyingTriage] = useState(false);
  const [rejectingTriage, setRejectingTriage] = useState(false);

  // Partner canned responses for the reply composer. Best-effort: an empty list
  // (or a failed/forbidden load) simply hides the picker.
  const [cannedTemplates, setCannedTemplates] = useState<CannedResponse[]>([]);
  const agentName = useAuthStore((s) => s.user?.name) ?? '';

  // null = picker hidden (no USERS_READ etc.); degrade to a label + unassign-only button.
  const [fetchedAssignees, setFetchedAssignees] = useState<Array<{ id: string; name: string | null; email: string }> | null>(null);
  const assigneesProvided = assigneesProp !== undefined;
  const assignees = assigneesProvided ? assigneesProp : fetchedAssignees;

  // `background: true` reconciles after a mutation without the loading flag — no
  // skeleton, no aria-busy, and a failed reconcile is swallowed so it can't wipe
  // out an already-applied optimistic update or surface a spurious error pane.
  const load = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background ?? false;
    if (!background) {
      setLoading(true);
      setError(undefined);
      setErrorKind(undefined);
    }
    try {
      const res = await fetchWithAuth(`/tickets/${ticketId}`);
      if (res.status === 404 || res.status === 403) {
        if (background) return; // keep the current view; a reconcile 404 isn't a load failure
        setTicket(null);
        setError('Ticket not found. It may have been deleted, or you may not have access to it.');
        setErrorKind('not-found');
        return;
      }
      if (!res.ok) throw new Error('Ticket failed to load.');
      const body = await res.json();
      setTicket(body.data);
    } catch (e) {
      if (background) return; // swallow — the mutation already succeeded
      setError(e instanceof Error ? e.message : 'Ticket failed to load.');
      setErrorKind('load');
    } finally {
      if (!background) setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => { void load(); }, [load]);

  // Load the partner's canned responses once; failure just leaves the picker hidden.
  useEffect(() => {
    listCannedResponses().then(setCannedTemplates).catch(() => setCannedTemplates([]));
  }, []);

  // Merge-variable values resolved from the current ticket + signed-in agent,
  // applied when a canned response is inserted into the composer. `partner_name`
  // isn't on the ticket payload, so it's left blank client-side (the server fills
  // it for auto-replies); the picker renders unknown/blank vars as empty.
  const templateVars = useMemo<Record<string, string>>(
    () =>
      ticket
        ? {
            ticket_number: ticket.internalNumber ?? '',
            ticket_subject: ticket.subject ?? '',
            requester_name: ticket.submitterName ?? '',
            requester_email: ticket.submitterEmail ?? '',
            org_name: ticket.orgName ?? '',
            partner_name: '',
            agent_name: agentName,
            current_status: String(ticket.status ?? ''),
            current_priority: String(ticket.priority ?? ''),
          }
        : {},
    [ticket, agentName],
  );

  useEffect(() => {
    if (!ticket) {
      setTriageSuggestion(null);
      return;
    }
    let cancelled = false;
    setTriageLoading(true);
    void fetchWithAuth(`/tickets/${ticketId}/triage-suggestion`)
      .then(async (res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        setTriageSuggestion(body?.enabled ? (body.suggestion ?? null) : null);
      })
      .catch(() => {
        if (!cancelled) setTriageSuggestion(null);
      })
      .finally(() => {
        if (!cancelled) setTriageLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticket, ticketId]);

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

  // Fetch org list for the move-org picker. Fails gracefully — if unavailable
  // the picker just won't show any options (degrade to empty select).
  useEffect(() => {
    let cancelled = false;
    void fetchWithAuth('/orgs/organizations?limit=100')
      .then(async (r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const rows = (body as { data?: Array<{ id: string; name: string }>; organizations?: Array<{ id: string; name: string }> }).data
          ?? (body as { data?: Array<{ id: string; name: string }>; organizations?: Array<{ id: string; name: string }> }).organizations
          ?? [];
        if (Array.isArray(rows)) setOrgs((rows as Array<{ id: string; name: string }>).filter((o) => o.id && o.name));
      })
      .catch(() => { /* degrade gracefully */ });
    return () => { cancelled = true; };
  }, []);

  // Requester options track the ticket's org (a portal user is org-scoped).
  // Failure degrades the editor to free-text only.
  useEffect(() => {
    const orgId = ticket?.orgId;
    if (!orgId) return;
    let cancelled = false;
    void fetchWithAuth(`/tickets/requesters?orgId=${orgId}`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const rows = (body as { data?: Array<{ id: string; name: string | null; email: string }> }).data;
        if (Array.isArray(rows)) setRequesters(rows.filter((u) => u.id));
      })
      .catch(() => { /* free-text fallback */ });
    return () => { cancelled = true; };
  }, [ticket?.orgId]);

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

  // Shared post-mutation path: paint the change locally for instant feedback,
  // tell the host to patch its queue row, then reconcile in the background. The
  // controlled selects bind to `ticket.*`, so without the optimistic patch they
  // snap back to the old value until the reconcile GET lands — the visible lag.
  const afterMutation = useCallback((optimistic?: Partial<TicketDetail>) => {
    if (optimistic) {
      setTicket((t) => (t ? { ...t, ...optimistic } : t));
      onTicketPatched?.(ticketId, optimistic);
    }
    void load({ background: true });
    onChanged?.();
  }, [ticketId, load, onChanged, onTicketPatched]);

  // Returns true on success, false on a swallowed ActionError — callers with
  // form state (resolve/pending) must only close/clear when the POST landed.
  const mutate = useCallback(async (path: string, body: unknown, success: string, optimistic?: Partial<TicketDetail>): Promise<boolean> => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}${path}`, { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: `${success} failed. Retry.`,
        successMessage: success,
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      afterMutation(optimistic);
      return true;
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      return false; // already toasted by runAction
    }
  }, [ticketId, afterMutation]);

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

  const handleMoveOrg = useCallback((targetOrgId: string) => {
    void runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/move-org`, { method: 'POST', body: JSON.stringify({ orgId: targetOrgId }) }),
      errorFallback: 'Move failed. Retry.',
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    }).then(() => void load({ background: true })).catch((err) => { if (!(err instanceof ActionError)) throw err; });
  }, [ticketId, load]);

  const applyTriageSuggestion = useCallback(async () => {
    if (!triageSuggestion || applyingTriage) return;
    const body: Partial<Pick<TicketDetail, 'categoryId' | 'priority'>> = {};
    if (triageSuggestion.categoryId !== null) body.categoryId = triageSuggestion.categoryId;
    if (triageSuggestion.priority !== null) body.priority = triageSuggestion.priority;
    if (Object.keys(body).length === 0) return;

    setApplyingTriage(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/triage-suggestion/apply`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        errorFallback: 'Could not apply ticket triage suggestion.',
        successMessage: 'Ticket triage suggestion applied',
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setTriageSuggestion(null);
      afterMutation(body);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setApplyingTriage(false);
    }
  }, [afterMutation, applyingTriage, ticketId, triageSuggestion]);

  const rejectTriageSuggestion = useCallback(async () => {
    if (!triageSuggestion || rejectingTriage) return;
    setRejectingTriage(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/triage-suggestion/reject`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        errorFallback: 'Could not save ticket triage feedback.',
        successMessage: 'Ticket triage feedback saved',
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setTriageSuggestion(null);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setRejectingTriage(false);
    }
  }, [rejectingTriage, ticketId, triageSuggestion]);

  // Fallback path: option values are the six core enums; POST {status}.
  const onStatusChange = useCallback(async (status: TicketStatus) => {
    setPendingStatusId(null);
    if (status === 'resolved') { setResolveOpen(true); return; }
    if (status === 'pending' || status === 'on_hold') { setPendingOpen(status); return; }
    // Core path clears any custom-status decoration the row may have carried.
    await mutate('/status', { status }, 'Status updated', { status, statusName: null, statusColor: null });
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
    await mutate('/status', { statusId }, 'Status updated', { status: row.coreStatus, statusName: row.name, statusColor: row.color ?? null });
  }, [config, mutate]);

  const submitResolve = useCallback(async () => {
    if (!resolutionNote.trim()) return;
    const target = pendingStatusId ? { statusId: pendingStatusId } : { status: 'resolved' as const };
    const note = resolutionNote.trim();
    const ok = await mutate('/status', { ...target, resolutionNote: note }, 'Ticket resolved', { status: 'resolved', resolutionNote: note });
    if (!ok) return; // keep the form open and the typed note intact on failure
    setResolveOpen(false);
    setResolutionNote('');
    setPendingStatusId(null);
  }, [mutate, resolutionNote, pendingStatusId]);

  const submitPending = useCallback(async () => {
    if (!pendingOpen) return;
    const reason = pendingReason.trim();
    const target = pendingStatusId ? { statusId: pendingStatusId } : { status: pendingOpen };
    const ok = await mutate('/status', { ...target, ...(reason ? { pendingReason: reason } : {}) }, 'Status updated', { status: pendingOpen, pendingReason: reason || null });
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
    // The new comment can only come from the server; reconcile in the background
    // so the composer releases the instant the POST lands (the feed fills in next).
    afterMutation();
  }, [ticketId, afterMutation]);

  // Generic field PATCH — saves any { subject } / { description } / etc. patch.
  // afterMutation with the optimistic patch paints the change locally and
  // reconciles in the background (same pattern as priority/category PATCHes).
  const handleFieldSave = useCallback((patch: Record<string, unknown>) => {
    void runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      errorFallback: 'Update failed. Retry.',
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    }).then(() => afterMutation(patch as Partial<TicketDetail>)).catch((err) => { if (!(err instanceof ActionError)) throw err; });
  }, [ticketId, afterMutation]);

  const openRequesterEditor = useCallback(() => {
    if (!ticket) return;
    setReqSel(ticket.submittedBy ?? ((ticket.submitterName || ticket.submitterEmail) ? MANUAL_REQUESTER : ''));
    setReqName(ticket.submitterName ?? '');
    setReqEmail(ticket.submitterEmail ?? '');
    setEditingRequester(true);
  }, [ticket]);

  const saveRequester = useCallback(() => {
    if (reqSel && reqSel !== MANUAL_REQUESTER) {
      // Picked a portal user — send its name/email too so the local optimistic
      // patch shows the new requester immediately (the API backfills the same).
      const opt = requesters.find((r) => r.id === reqSel);
      handleFieldSave({ submittedBy: reqSel, submitterName: opt?.name ?? null, submitterEmail: opt?.email ?? null });
    } else if (reqSel === MANUAL_REQUESTER) {
      handleFieldSave({ submittedBy: null, submitterName: reqName.trim() || null, submitterEmail: reqEmail.trim() || null });
    } else {
      handleFieldSave({ submittedBy: null, submitterName: null, submitterEmail: null });
    }
    setEditingRequester(false);
  }, [reqSel, reqName, reqEmail, requesters, handleFieldSave]);

  const handleEditComment = useCallback((commentId: string, content: string) => {
    void runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
      errorFallback: 'Comment edit failed. Retry.',
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    }).then(() => void load({ background: true })).catch((err) => { if (!(err instanceof ActionError)) throw err; });
  }, [ticketId, load]);

  const handleDeleteComment = useCallback((commentId: string) => {
    void runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/comments/${commentId}`, { method: 'DELETE' }),
      errorFallback: 'Comment delete failed. Retry.',
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    }).then(() => void load({ background: true })).catch((err) => { if (!(err instanceof ActionError)) throw err; });
  }, [ticketId, load]);

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
  const suggestedCategoryName = triageSuggestion?.categoryId
    ? (categories.find((category) => category.id === triageSuggestion.categoryId)?.name ?? triageSuggestion.categoryName ?? 'Suggested category')
    : null;
  const triageReasons = triageSuggestion?.reasons.filter((reason) => reason.trim().length > 0) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ticket-workbench" aria-busy={loading || undefined}>
      {/* Header */}
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground" data-testid="ticket-workbench-number">{ticket.internalNumber ?? ticket.id.slice(0, 8)}</span>
          <input
            type="text"
            defaultValue={ticket.subject}
            key={ticket.subject}
            className="min-w-0 flex-1 truncate bg-transparent text-base font-semibold outline-none hover:bg-muted/30 focus:bg-muted/30 focus:ring-1 focus:ring-ring rounded px-1 -mx-1"
            data-testid="ticket-workbench-subject-edit"
            aria-label="Ticket subject"
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (!next || next === ticket.subject) return;
              handleFieldSave({ subject: next });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const next = (e.target as HTMLInputElement).value.trim();
                if (!next || next === ticket.subject) return;
                handleFieldSave({ subject: next });
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === 'Escape') {
                (e.target as HTMLInputElement).value = ticket.subject;
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
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
              const priority = e.target.value as TicketPriority;
              void runAction({
                request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ priority }) }),
                errorFallback: 'Priority update failed. Retry.',
                onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
              }).then(() => afterMutation({ priority })).catch((err) => { if (!(err instanceof ActionError)) throw err; });
            }}
            className={cn('rounded-md border px-2 py-1 text-xs font-medium', priorityConfig[ticket.priority].color)}
            data-testid="ticket-workbench-priority"
            aria-label="Priority"
          >
            {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{priorityLabel(config, p)}</option>)}
          </select>
          {categories.length > 0 && (
            <select
              value={ticket.categoryId ?? ''}
              onChange={(e) => {
                const categoryId = e.target.value || null;
                if (categoryId === (ticket.categoryId ?? null)) return;
                void runAction({
                  request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ categoryId }) }),
                  errorFallback: 'Category update failed. Retry.',
                  onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
                }).then(() => afterMutation({ categoryId })).catch((err) => { if (!(err instanceof ActionError)) throw err; });
              }}
              className="max-w-[180px] rounded-md border bg-background px-2 py-1 text-xs text-foreground"
              data-testid="ticket-workbench-category"
              aria-label="Category"
            >
              <option value="">No category</option>
              {ticket.categoryId && !categories.some((category) => category.id === ticket.categoryId) && (
                <option value={ticket.categoryId}>Current category</option>
              )}
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          )}
          {assignees !== null ? (
            <select
              value={ticket.assignedTo ?? ''}
              onChange={(e) => {
                const next = e.target.value || null;
                if (next === (ticket.assignedTo ?? null)) return; // no-op guard: never write a bogus feed entry
                const picked = next ? assignees?.find((u) => u.id === next) : null;
                void mutate('/assign', { assigneeId: next }, next ? 'Assigned' : 'Unassigned', {
                  assignedTo: next,
                  assigneeName: picked ? (picked.name || picked.email) : null
                });
              }}
              className="max-w-[180px] rounded-md border bg-background px-2 py-1 text-xs text-foreground"
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
              onClick={() => void mutate('/assign', { assigneeId: null }, 'Unassigned', { assignedTo: null, assigneeName: null })}
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
          <button
            type="button"
            data-testid="ticket-workbench-move-org"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => { setMoveOrgOpen(true); setMoveOrgTargetId(''); }}
          >
            Move to another org…
          </button>
        </div>
        {moveOrgOpen && (
          <div className="mt-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-workbench-move-org-form">
            <label className="text-xs font-medium" htmlFor="move-org-select">Move to organization</label>
            <select
              id="move-org-select"
              data-testid="ticket-workbench-move-org-select"
              value={moveOrgTargetId}
              onChange={(e) => setMoveOrgTargetId(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-xs"
            >
              <option value="">Select organization…</option>
              {orgs.filter((o) => o.id !== ticket.orgId).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            <div className="mt-1.5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="ticket-workbench-move-org-cancel"
                onClick={() => setMoveOrgOpen(false)}
                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="ticket-workbench-move-org-confirm"
                disabled={!moveOrgTargetId}
                onClick={() => { if (moveOrgTargetId) { handleMoveOrg(moveOrgTargetId); setMoveOrgOpen(false); } }}
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Move
              </button>
            </div>
          </div>
        )}
        {(triageSuggestion || triageLoading) && (
          <div className="mt-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-triage-suggestion">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  Suggested triage
                </div>
                {triageLoading ? (
                  <p className="mt-1 text-xs text-muted-foreground">Checking ticket signals…</p>
                ) : triageSuggestion ? (
                  <>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                      {triageSuggestion.priority && <span>Priority: {priorityLabel(config, triageSuggestion.priority)}</span>}
                      {suggestedCategoryName && <span>Category: {suggestedCategoryName}</span>}
                      <span>{Math.round(triageSuggestion.confidence * 100)}% confidence</span>
                    </div>
                    {triageReasons.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="ticket-triage-reasons">
                        {triageReasons.map((reason) => (
                          <span
                            key={reason}
                            className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {reason}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
              {triageSuggestion && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void rejectTriageSuggestion()}
                    disabled={applyingTriage || rejectingTriage}
                    className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid="ticket-triage-reject"
                  >
                    {rejectingTriage ? 'Saving…' : 'Not right'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void applyTriageSuggestion()}
                    disabled={applyingTriage || rejectingTriage}
                    className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid="ticket-triage-apply"
                  >
                    {applyingTriage ? 'Applying…' : 'Apply'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
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
            <div className="border-b p-4">
              {editingDescription ? (
                <div className="space-y-2">
                  <textarea
                    ref={descriptionTextareaRef}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    rows={4}
                    defaultValue={ticket.description ?? ''}
                    data-testid="ticket-workbench-description-textarea"
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingDescription(false)}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                      data-testid="ticket-workbench-description-cancel-btn"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const next = descriptionTextareaRef.current?.value ?? '';
                        handleFieldSave({ description: next });
                        setEditingDescription(false);
                      }}
                      className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white"
                      data-testid="ticket-workbench-description-save-btn"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="group flex items-start gap-2">
                  {ticket.description ? (
                    <p className="flex-1 whitespace-pre-wrap text-sm">{ticket.description}</p>
                  ) : (
                    <p className="flex-1 text-sm text-muted-foreground italic">No description.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => { setEditingDescription(true); }}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                    data-testid="ticket-workbench-description-edit-btn"
                  >
                    {ticket.description ? 'Edit' : 'Add description'}
                  </button>
                </div>
              )}
            </div>
            <TicketFeed
              comments={ticket.comments}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
              canManageComment={(c) => !c.portalUserId}
            />
          </div>
          <TicketComposer
            requesterName={ticket.submitterName}
            onSend={sendComment}
            templates={cannedTemplates}
            templateVars={templateVars}
          />
        </div>
        {railOpen && (
          <aside className="w-64 shrink-0 overflow-y-auto border-l p-3 text-sm hidden lg:block" data-testid="ticket-workbench-rail">
            <div className="space-y-3">
              {/* Per-target SLA timers; renders nothing (no gap) when the ticket has no SLA targets. */}
              <SlaTimers ticket={ticket} />
              <TicketTimeBilling ticketId={ticket.id} />
              <TicketPartsCard ticketId={ticket.id} />
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Requester</dt>
                  <dd>
                    {editingRequester ? (
                      <div className="space-y-2">
                        <select
                          value={reqSel}
                          onChange={(e) => setReqSel(e.target.value)}
                          className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                          data-testid="ticket-workbench-requester-select"
                          aria-label="Requester"
                        >
                          <option value="">Unknown</option>
                          {requesters.map((r) => (
                            <option key={r.id} value={r.id}>{r.name ? `${r.name} (${r.email})` : r.email}</option>
                          ))}
                          <option value={MANUAL_REQUESTER}>Someone else…</option>
                        </select>
                        {reqSel === MANUAL_REQUESTER && (
                          <div className="space-y-1">
                            <input
                              value={reqName}
                              onChange={(e) => setReqName(e.target.value)}
                              maxLength={255}
                              placeholder="Name"
                              aria-label="Requester name"
                              className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                              data-testid="ticket-workbench-requester-name"
                            />
                            <input
                              type="email"
                              value={reqEmail}
                              onChange={(e) => setReqEmail(e.target.value)}
                              maxLength={255}
                              placeholder="Email (optional)"
                              aria-label="Requester email"
                              className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                              data-testid="ticket-workbench-requester-email"
                            />
                          </div>
                        )}
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingRequester(false)}
                            className="rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
                            data-testid="ticket-workbench-requester-cancel"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={saveRequester}
                            className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-white"
                            data-testid="ticket-workbench-requester-save"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="group flex items-start gap-2">
                        <span className="flex-1" data-testid="ticket-workbench-requester">
                          {ticket.submitterName ?? ticket.submitterEmail ?? 'Unknown'}
                        </span>
                        <button
                          type="button"
                          onClick={openRequesterEditor}
                          className="shrink-0 rounded px-1 text-xs text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                          data-testid="ticket-workbench-requester-edit"
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </dd>
                </div>
                <div><dt className="text-xs text-muted-foreground">Source</dt><dd className="capitalize">{ticket.source}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Created</dt><dd>{formatDateTime(ticket.createdAt)}</dd></div>
                <div>
                  <dt className="text-xs text-muted-foreground">Due date</dt>
                  <dd>
                    <input
                      type="date"
                      data-testid="ticket-workbench-due"
                      aria-label="Due date"
                      value={ticket.dueDate ? ticket.dueDate.slice(0, 10) : ''}
                      onChange={(e) => handleFieldSave({ dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
                      className="rounded-md border bg-background px-2 py-1 text-xs"
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Tags</dt>
                  <dd>
                    <TagEditor
                      data-testid="ticket-workbench-tags"
                      value={ticket.tags ?? []}
                      max={20}
                      onChange={(tags) => handleFieldSave({ tags })}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Device</dt>
                  <dd>
                    <div data-testid="ticket-workbench-device" className="flex items-center gap-2 text-xs">
                      {ticket.deviceId ? (
                        <a
                          href={`/devices/${ticket.deviceId}`}
                          className="text-primary hover:underline"
                          data-testid="ticket-workbench-device-link"
                        >
                          {ticket.deviceHostname ?? ticket.deviceId}
                        </a>
                      ) : (
                        <span>No device</span>
                      )}
                      {ticket.deviceId && (
                        <button
                          type="button"
                          data-testid="ticket-workbench-device-unlink"
                          className="hover:text-destructive"
                          onClick={() => handleFieldSave({ deviceId: null })}
                        >
                          Unlink
                        </button>
                      )}
                    </div>
                  </dd>
                </div>
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
