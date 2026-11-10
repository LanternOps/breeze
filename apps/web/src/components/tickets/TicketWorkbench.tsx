import { useRecordPageContext } from '@/hooks/useRecordPageContext';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { TicketTemplateVars } from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { fetchAllOrganizationsFrom } from '../../lib/fetchAllOrganizations';
import { listCannedResponses, type CannedResponse } from '../../lib/ticketResponseTemplatesApi';
import { runAction, ActionError } from '../../lib/runAction';
import { permanentAttachmentRejection } from './ticketAttachmentErrors';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import MergeTicketDialog from './MergeTicketDialog';
import TicketFocusHeader from './TicketFocusHeader';
import TicketConversation from './TicketConversation';
import TicketComposerZone from './TicketComposerZone';
import TicketSituationColumn from './TicketSituationColumn';
import TicketMoveOrgDialog from './TicketMoveOrgDialog';
import TicketEndpointLine from './TicketEndpointLine';
import { useTicketEndpoint } from './useTicketEndpoint';
import { useTicketAiAssist } from './useTicketAiAssist';
import { useMergedTicketRefs } from './useMergedTicketRefs';
import type { TicketType } from './ticketType';
import type { TicketDetail, TicketStatus, TicketPriority } from './ticketConfig';
import type { OrgOption, UserOption } from './ticketWorkbenchTypes';
import { fetchTicketConfig, type TicketConfig } from '../../lib/ticketConfigApi';
import { onTimerChanged, onBillingChanged } from '../../lib/timerActions';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useStableT } from '@/lib/i18n/useStableT';
import { usePageItemName } from '../layout/usePageItemName';
import WispTalkButton from '@/components/wisp/WispTalkButton';

interface Props {
  ticketId: string;
  onChanged?: () => void;       // queue refresh hook (debounced background reconcile)
  // Optimistic row patch: lets the host update the matching queue row in place
  // the instant a mutation lands, so the list reflects the change without waiting
  // for (or paying for) a full list refetch. `onChanged` still reconciles after.
  onTicketPatched?: (id: string, patch: Partial<TicketDetail>) => void;
  // Fired after a successful soft-delete, so a host holding this ticket in its
  // pane (TicketsPage's post-resolve hold, #9564) lets go of it.
  onDeleted?: (id: string) => void;
  // Fired after this ticket is merged into another (#8972). The queue host
  // moves its focus to the survivor; without a host the workbench navigates
  // to the survivor itself.
  onMerged?: (survivorId: string, survivorNumber: string | null) => void;
  // Fired once a ticket's detail has loaded (the composer is mounted), so the
  // host can finish a shortcut that opened the ticket (r / n / e from the queue).
  onReady?: (id: string) => void;
  expanded?: boolean;            // standalone full page: names the page, owns the hash, leaves on delete
  /** Names the browser tab after the ticket (the focus view). Defaults to `expanded`. */
  namesPage?: boolean;
  resolveRequestToken?: number;  // increments when the page-level `e` shortcut asks to open the resolve form
  /** Increments when the page-level `r` / `n` shortcut asks for the composer
   *  in that mode. Honoured from either tab; ignored (nothing changes) while a
   *  resolve or pending form holds the composer's place. */
  composeRequest?: { mode: 'reply' | 'internal'; token: number };
  refreshToken?: number;         // bumped by bulk actions in the queue after they mutate tickets
  // Host-supplied assignee list (TicketsPage already fetches /users for its
  // filter bar). When provided — including null for "picker hidden" — the
  // workbench skips its own /users fetch; undefined keeps the standalone
  // self-fetch.
  assignees?: UserOption[] | null;
  categories?: Array<{ id: string; name: string }>;
  /** Toast "Ticket resolved" on resolve. The queue host passes a function,
   *  asked once the resolve has landed: false when its next-ticket offer will
   *  say so instead. */
  resolveToast?: boolean | ((ticketId: string) => boolean);
}

type FocusTab = 'conversation' | 'details';

export default function TicketWorkbench({ ticketId, onChanged, onTicketPatched, onDeleted, onMerged, onReady, expanded, namesPage, resolveRequestToken, composeRequest, refreshToken, assignees: assigneesProp, categories = [], resolveToast = true }: Props) {
  const { t } = useTranslation('tickets');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  // Bumped when the caller-verification modal reports a change so the header
  // badge re-reads the server's ticket freshness projection.
  const [callerRevision, setCallerRevision] = useState(0);
  // The focus view and the standalone page name the browser tab; an embedded
  // preview must not relabel its host page.
  usePageItemName((namesPage ?? expanded) && ticket ? [ticket.internalNumber, ticket.subject].filter(Boolean).join(' ') : undefined);
  useRecordPageContext(ticket ? { kind: 'ticket', id: ticket.id, orgId: ticket.orgId, label: [ticket.internalNumber ?? ticket.id.slice(0, 8), ticket.subject].filter(Boolean).join(' ') } : null);
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
  // Checklist soft-confirm on resolve/close (#5808 W01 Task 12): a client-side
  // nudge only — never a server-side refusal. `checklistCounts` is fed by
  // TicketChecklistCard's onCountsChange; `checklistConfirm` holds the deferred
  // status-change action while the confirm prompt is shown, or null when none
  // is pending.
  const [checklistCounts, setChecklistCounts] = useState<
    { done: number; total: number; known: boolean } | null
  >(null);
  const [checklistConfirm, setChecklistConfirm] = useState<(() => void) | null>(null);
  const [moveOrgOpen, setMoveOrgOpen] = useState(false);
  // What the composer was last asked for (r / n), handed down once the
  // conversation is the visible tab.
  const [composerFocus, setComposerFocus] = useState<{ mode: 'reply' | 'internal'; token: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  // Below 1024px the conversation and the situation column are two tabs.
  const wide = useMediaQuery('(min-width: 1024px)', true);
  const [focusTab, setFocusTab] = useState<FocusTab>('conversation');
  const tabRefs = useRef<Record<FocusTab, HTMLButtonElement | null>>({ conversation: null, details: null });
  // Soft-delete is tickets:manage-gated (server re-enforces). UX-only gate.
  const { can } = usePermissions();
  const canManage = can('tickets', 'manage');
  // #7900: type edits and link add/remove need tickets:write (UX only; the API re-checks).
  const canWrite = can('tickets', 'write');
  // #8972: a merged tombstone is read-only — every ticket write answers 409
  // TICKET_MERGED. `merged` hides or disables each write control; `canEdit` is
  // the write gate for the controls that were tickets:write-gated already.
  const merged = Boolean(ticket?.mergedIntoTicketId);
  const canEdit = canWrite && !merged;
  // The device's live state, read once for the Details panel and, below
  // 1024px, the endpoint line under the header.
  const canReadDevice = can('devices', 'read');
  const canRemote = can('remote', 'access');
  const endpoint = useTicketEndpoint(ticket?.deviceId ?? null, canReadDevice);
  // GET /orgs/organizations returns the full org row for partner/system scope,
  // which carries currency_code (wave 1); the parts card needs it for catalog
  // prefill (#3775). Org-scoped callers get a name-only projection → undefined.
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  // Ticket configuration (custom statuses + priority labels). null = not loaded
  // or fetch failed; every render falls back to the static core config.
  const [config, setConfig] = useState<TicketConfig | null>(null);
  // The resolution_note draft (if any) prefilled into the currently-open
  // resolve form; sent back as `aiDraftId` so the server consumes it in the
  // same transaction as the resolve CAS.
  const [resolveDraftId, setResolveDraftId] = useState<string | null>(null);

  // Partner canned responses for the reply composer. Best-effort: an empty list
  // (or a failed/forbidden load) simply hides the picker.
  const [cannedTemplates, setCannedTemplates] = useState<CannedResponse[]>([]);
  const agentName = useAuthStore((s) => s.user?.name) ?? '';
  // #9180: offer "all organizations" when saving checklist steps as a template.
  // UI hint only — the API re-checks canManagePartnerWidePolicies.
  // Checklists are partner/system-scope only, so this flag alone is the gate.
  const canSavePartnerWideChecklist = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;

  // null = picker hidden (no USERS_READ etc.); degrade to a label + unassign-only button.
  const [fetchedAssignees, setFetchedAssignees] = useState<UserOption[] | null>(null);
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
        setError(stableT('ticketWorkbench.notFound'));
        setErrorKind('not-found');
        return;
      }
      if (!res.ok) throw new Error(stableT('ticketWorkbench.loadFailed'));
      const body = await res.json();
      setTicket(body.data);
    } catch (e) {
      if (background) return; // swallow — the mutation already succeeded
      setError(e instanceof Error ? e.message : stableT('ticketWorkbench.loadFailed'));
      setErrorKind('load');
    } finally {
      if (!background) setLoading(false);
    }
  }, [ticketId, stableT]);

  useEffect(() => { void load(); }, [load]);

  // The host finishes queue shortcuts (r / n / e) once the composer exists.
  const loadedId = ticket?.id ?? null;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => { if (loadedId) onReadyRef.current?.(loadedId); }, [loadedId]);

  // Load the partner's canned responses once; failure just leaves the picker hidden.
  useEffect(() => {
    listCannedResponses()
      .then(setCannedTemplates)
      .catch((e) => {
        // Best-effort: hide the picker on failure, but leave a breadcrumb so a
        // real load error (403 regression, malformed payload, 500) is
        // distinguishable from "this partner has no templates".
        console.debug('[TicketWorkbench] canned responses unavailable; hiding picker', e);
        setCannedTemplates([]);
      });
  }, []);

  // Merge-variable values resolved from the current ticket + signed-in agent,
  // applied when a canned response is inserted into the composer. `partner_name`
  // isn't on the ticket payload, so it's left blank client-side (the server fills
  // it for auto-replies); the picker renders unknown/blank vars as empty.
  const templateVars = useMemo<TicketTemplateVars>(() => {
    if (!ticket) return {};
    const vars: TicketTemplateVars = {
      ticket_number: ticket.internalNumber ?? '',
      ticket_subject: ticket.subject ?? '',
      requester_name: ticket.submitterName ?? '',
      requester_email: ticket.submitterEmail ?? '',
      org_name: ticket.orgName ?? '',
      partner_name: '',
      agent_name: agentName,
      current_status: String(ticket.status ?? ''),
      current_priority: String(ticket.priority ?? ''),
    };
    return vars;
  }, [ticket, agentName]);

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

  const ai = useTicketAiAssist({ ticket, ticketId, afterMutation, resolveDraftId, setResolveDraftId, t });
  const { aiDraftsRef, setAiDrafts, refetchAiDrafts } = ai;
  const { mergedInto, mergedFromNumbers } = useMergedTicketRefs(ticket, ticketId);

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
  // ticket, unmounting the composer so its mode can't leak across tickets
  // (its unsent text is kept per ticket, see TicketComposer draftKey).
  useEffect(() => {
    setTicket(null);
    setResolveOpen(false);
    setResolutionNote('');
    setPendingOpen(null);
    setPendingReason('');
    setPendingStatusId(null);
    setResolveDraftId(null);
    setDeleteOpen(false);
    setMergeOpen(false);
    setMoveOrgOpen(false);
    setChecklistCounts(null);
    setChecklistConfirm(null);
    setComposerFocus(null);
    setFocusTab('conversation');
  }, [ticketId]);

  // Opens the resolve form and, when an active `resolution_note` AI draft
  // exists, prefills the note field from it and remembers its id so
  // submitResolve can pass `aiDraftId`. Reads aiDraftsRef rather than
  // depending on `aiDrafts` directly so this callback's identity stays
  // stable across ai-drafts refetches (background reconciles re-fetch
  // drafts on every ticket change) — otherwise the resolveRequestToken
  // effect below would re-fire and reopen the form on every refetch.
  const openResolveForm = useCallback(() => {
    setResolveOpen(true);
    // The resolve form lives in the conversation's composer zone.
    setFocusTab('conversation');
    const draft = aiDraftsRef.current.find((d) => d.kind === 'resolution_note');
    setResolveDraftId(draft ? draft.id : null);
    if (draft) {
      setResolutionNote((prev) => (prev.trim() ? prev : draft.content));
    }
  }, [aiDraftsRef]);

  // Page-level `e` shortcut: open the inline resolve form (UI brief: `e` opens
  // the resolution-note form). The token a fresh workbench mounts with is an
  // old press (a previous ticket's `e`), never a new request.
  const mountResolveToken = useRef(resolveRequestToken);
  useEffect(() => {
    if (resolveRequestToken && resolveRequestToken !== mountResolveToken.current) openResolveForm();
  }, [resolveRequestToken, openResolveForm]);

  // However the form opened (`e`, or Resolved in the status select), the note
  // is the next thing to type: move focus there instead of leaving it on the
  // page body. A repeat `e` while the form is open refocuses it.
  const resolveNoteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (resolveOpen) resolveNoteRef.current?.focus();
  }, [resolveOpen, resolveRequestToken, loadedId]);

  // Page-level `r` / `n`: the composer, in that mode, from either tab. As with
  // `e`, the token a workbench mounts with is an old press. While a resolve or
  // pending form holds the composer's place the key does nothing: closing the
  // form would drop what was typed there, and flipping the hidden composer's
  // mode behind it would surface later as a surprise.
  const mountComposeToken = useRef(composeRequest?.token);
  const formOpenNow = resolveOpen || pendingOpen !== null;
  const formOpenRef = useRef(formOpenNow);
  formOpenRef.current = formOpenNow;
  const composeToken = composeRequest?.token;
  const composeMode = composeRequest?.mode;
  useEffect(() => {
    if (!composeToken || !composeMode || composeToken === mountComposeToken.current) return;
    if (formOpenRef.current) return;
    setFocusTab('conversation');
    setComposerFocus({ mode: composeMode, token: composeToken });
  }, [composeToken, composeMode]);

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
          setFetchedAssignees((rows as UserOption[]).filter((u) => u.id));
      })
      .catch(() => { /* degraded mode keeps the unassign-only affordance */ });
    return () => { cancelled = true; };
  }, [assigneesProvided]);

  // Fetch org list for the move-org picker. Fails gracefully — if unavailable
  // the picker just won't show any options (degrade to empty select).
  useEffect(() => {
    let cancelled = false;
    void fetchAllOrganizationsFrom<OrgOption>('/orgs/organizations')
      .then((rows) => {
        if (cancelled) return;
        setOrgs(rows.filter((o) => o.id && o.name));
      })
      .catch(() => { /* degrade gracefully */ });
    return () => { cancelled = true; };
  }, []);

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
  const mutate = useCallback(async (
    path: string,
    body: unknown,
    successMessage: string,
    errorFallback: string,
    optimistic?: Partial<TicketDetail>,
  ): Promise<boolean> => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}${path}`, { method: 'POST', body: JSON.stringify(body) }),
        errorFallback,
        successMessage,
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      afterMutation(optimistic);
      return true;
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      return false; // already toasted by runAction
    }
  }, [ticketId, afterMutation]);

  // Generic field PATCH — saves any { subject } / { description } / etc. patch.
  // afterMutation with the optimistic patch paints the change locally and
  // reconciles in the background.
  const patchTicket = useCallback((patch: Record<string, unknown>, errorFallback: string) => {
    void runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      errorFallback,
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    }).then(() => afterMutation(patch as Partial<TicketDetail>)).catch((err) => { if (!(err instanceof ActionError)) throw err; });
  }, [ticketId, afterMutation]);
  const handleFieldSave = useCallback((patch: Record<string, unknown>) => patchTicket(patch, t('ticketWorkbench.toast.updateFailed')), [patchTicket, t]);
  const onPriorityChange = useCallback((priority: TicketPriority) => patchTicket({ priority }, t('ticketWorkbench.toast.priorityUpdateFailed')), [patchTicket, t]);
  const onTypeChange = useCallback((ticketType: TicketType) => patchTicket({ ticketType }, t('ticketWorkbench.toast.typeUpdateFailed')), [patchTicket, t]);
  const onCategoryChange = useCallback((categoryId: string | null) => patchTicket({ categoryId }, t('ticketWorkbench.toast.categoryUpdateFailed')), [patchTicket, t]);

  const onAssign = useCallback((next: string | null) => {
    if (!ticket || next === (ticket.assignedTo ?? null)) return; // no-op guard: never write a bogus feed entry
    const picked = next ? assignees?.find((u) => u.id === next) : null;
    void mutate('/assign', { assigneeId: next }, next ? t('ticketWorkbench.toast.assigned') : t('ticketWorkbench.toast.unassigned'), t('ticketWorkbench.toast.assignFailed'), {
      assignedTo: next,
      assigneeName: picked ? (picked.name || picked.email) : null
    });
  }, [ticket, assignees, mutate, t]);

  // Soft-delete this ticket (tickets:manage). Confirm-gated by the ConfirmDialog
  // below. On success the ticket leaves every queue: the standalone page goes
  // back to the queue; a queue host hears onDeleted and returns to its board.
  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'DELETE' }),
        errorFallback: t('ticketWorkbench.delete.failed'),
        successMessage: t('ticketWorkbench.delete.deleted'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setDeleteOpen(false);
      onDeleted?.(ticketId);
      onChanged?.();
      if (expanded) void navigateTo('/tickets');
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setDeleting(false);
    }
  }, [deleting, ticketId, onChanged, onDeleted, expanded, t]);

  // The dialog already toasted "Merged into T-…". The queue host moves its
  // focus to the survivor; standalone, go to the survivor's page.
  const handleMerged = useCallback((survivor: { id: string; internalNumber: string | null }) => {
    setMergeOpen(false);
    if (onMerged) onMerged(survivor.id, survivor.internalNumber);
    else void navigateTo(`/tickets/${survivor.id}`);
  }, [onMerged]);

  // Checklist soft-confirm (#5808 W01 Task 12): a client-side NUDGE only — no
  // server-side refusal, and completion never triggers anything on its own.
  // Gated on the counts TicketChecklistCard reports via onCountsChange, so a
  // ticket the card hasn't loaded yet (`checklistCounts === null`) never blocks.
  const needsChecklistConfirm = useCallback((coreStatus: TicketStatus): boolean => {
    if (coreStatus !== 'resolved' && coreStatus !== 'closed') return false;
    if (!checklistCounts) return false;
    // Fail CLOSED when the card could not load the checklist: 0/0 from a failed
    // fetch is byte-identical to "this ticket has no checklist", so treating
    // unknown as empty would skip the prompt on a network blip — precisely when
    // the technician most needs to be asked.
    if (!checklistCounts.known) return true;
    return checklistCounts.total > 0 && checklistCounts.total - checklistCounts.done > 0;
  }, [checklistCounts]);

  // Fallback path: option values are the six core enums; POST {status}.
  const proceedStatusChange = useCallback(async (status: TicketStatus) => {
    setPendingStatusId(null);
    if (status === 'resolved') { openResolveForm(); return; }
    if (status === 'pending' || status === 'on_hold') { setPendingOpen(status); setFocusTab('conversation'); return; }
    // Core path clears any custom-status decoration the row may have carried.
    await mutate('/status', { status }, t('ticketWorkbench.toast.statusUpdated'), t('ticketWorkbench.toast.statusUpdateFailed'), { status, statusName: null, statusColor: null });
  }, [mutate, openResolveForm, t]);

  const onStatusChange = useCallback((status: TicketStatus) => {
    if (needsChecklistConfirm(status)) {
      setChecklistConfirm(() => () => void proceedStatusChange(status));
      setFocusTab('conversation');
      return;
    }
    void proceedStatusChange(status);
  }, [needsChecklistConfirm, proceedStatusChange]);

  // Config path: option values are custom-status row ids; the chosen row's
  // coreStatus drives the same resolve/pending forms, and the POST sends
  // {statusId} so resolved/pending custom statuses behave like their core peers.
  const proceedCustomStatusChange = useCallback(async (statusId: string) => {
    const row = config?.statuses.find((s) => s.id === statusId);
    if (!row) return;
    if (row.coreStatus === 'resolved') { setPendingStatusId(statusId); openResolveForm(); return; }
    if (row.coreStatus === 'pending' || row.coreStatus === 'on_hold') {
      setPendingStatusId(statusId);
      setPendingOpen(row.coreStatus);
      setFocusTab('conversation');
      return;
    }
    setPendingStatusId(null);
    await mutate('/status', { statusId }, t('ticketWorkbench.toast.statusUpdated'), t('ticketWorkbench.toast.statusUpdateFailed'), { status: row.coreStatus, statusName: row.name, statusColor: row.color ?? null });
  }, [config, mutate, openResolveForm, t]);

  const onCustomStatusChange = useCallback((statusId: string) => {
    const row = config?.statuses.find((s) => s.id === statusId);
    if (row && needsChecklistConfirm(row.coreStatus)) {
      setChecklistConfirm(() => () => void proceedCustomStatusChange(statusId));
      setFocusTab('conversation');
      return;
    }
    void proceedCustomStatusChange(statusId);
  }, [config, needsChecklistConfirm, proceedCustomStatusChange]);

  // Not routed through the shared `mutate` helper (unlike onStatusChange/
  // onCustomStatusChange/submitPending) because it needs the thrown
  // ActionError's status to tell a draft-related 409 apart from any other
  // resolve failure — `mutate` swallows that down to a bare boolean.
  const submitResolve = useCallback(async () => {
    if (!resolutionNote.trim()) return;
    const target = pendingStatusId ? { statusId: pendingStatusId } : { status: 'resolved' as const };
    const note = resolutionNote.trim();
    const body = { ...target, resolutionNote: note, ...(resolveDraftId ? { aiDraftId: resolveDraftId } : {}) };
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/status`, { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: t('ticketWorkbench.toast.resolveFailed'),
        // Asked once the POST has landed: the host knows by then whether its
        // next-ticket offer will say "resolved" instead.
        successMessage: () => ((typeof resolveToast === 'function' ? resolveToast(ticketId) : resolveToast) ? t('ticketWorkbench.toast.ticketResolved') : ''),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      // A non-401 failure while an aiDraftId was attached means the
      // resolution-note draft is no longer valid — consumed/discarded
      // elsewhere (409), OR its id is stale after a ticket switch reset it
      // out from under this submit (404, I1 #4191 final review: matches the
      // sibling send/discard recovery condition, not just 409, so a 404
      // doesn't loop forever). Drop the now-dead id (and refetch the draft
      // list, so its card disappears too) so the technician's next submit —
      // the typed note stays put — POSTs without it.
      if (err.status !== 401 && resolveDraftId) {
        setResolveDraftId(null);
        void refetchAiDrafts(ticketId);
      }
      return; // keep the form open and the typed note intact on failure
    }
    // The patch must carry the resolved status's own name/colour: the host's
    // "now under Closed" banner reads `statusName`, and omitting it left the
    // previous status name ("Open — now under Closed"). A plain core resolve
    // has no custom name (null falls back to the translated core label).
    const resolvedRow = pendingStatusId ? config?.statuses.find((s) => s.id === pendingStatusId) : undefined;
    afterMutation({
      status: 'resolved',
      resolutionNote: note,
      statusName: resolvedRow?.name ?? null,
      statusColor: resolvedRow?.color ?? null,
    });
    if (resolveDraftId) setAiDrafts((prev) => prev.filter((d) => d.id !== resolveDraftId));
    setResolveOpen(false);
    setResolutionNote('');
    setPendingStatusId(null);
    setResolveDraftId(null);
  }, [afterMutation, config, pendingStatusId, refetchAiDrafts, resolutionNote, resolveDraftId, resolveToast, setAiDrafts, t, ticketId]);

  const submitPending = useCallback(async () => {
    if (!pendingOpen) return;
    const reason = pendingReason.trim();
    const target = pendingStatusId ? { statusId: pendingStatusId } : { status: pendingOpen };
    const ok = await mutate('/status', { ...target, ...(reason ? { pendingReason: reason } : {}) }, t('ticketWorkbench.toast.statusUpdated'), t('ticketWorkbench.toast.statusUpdateFailed'), { status: pendingOpen, pendingReason: reason || null });
    if (!ok) return; // keep the form open and the typed reason intact on failure
    setPendingOpen(null);
    setPendingReason('');
    setPendingStatusId(null);
  }, [mutate, pendingOpen, pendingReason, pendingStatusId, t]);

  /**
   * W08 #3902 — one file per call. The body is FormData, so fetchWithAuth
   * deliberately leaves Content-Type unset and the browser supplies the
   * multipart boundary. A permanent refusal (415 type, 413 size, empty file)
   * is not toasted here: the composer drops the chip and names the file. A
   * transient failure (network, 429, 5xx) is toasted by runAction and the
   * composer keeps it as a retryable chip.
   */
  const uploadAttachment = useCallback(async (file: File): Promise<{ id: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/attachments`, { method: 'POST', body: form }),
      errorFallback: t('ticketWorkbench.toast.attachmentFailed'),
      // The composer explains a permanent refusal itself (localized, names the file).
      suppressErrorToast: (status, code) => permanentAttachmentRejection(status, code) !== null,
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    });
    const id = (res as { data?: { id?: string } } | undefined)?.data?.id;
    if (!id) throw new Error('upload returned no attachment id');
    return { id };
  }, [ticketId, t]);

  const sendComment = useCallback(async (content: string, isPublic: boolean, attachmentIds: string[] = []) => {
    await runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify({ content, isPublic, attachmentIds }) }),
      errorFallback: t('ticketWorkbench.toast.replyFailed'),
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    });
    // The new comment can only come from the server; reconcile in the background
    // so the composer releases the instant the POST lands (the feed fills in next).
    afterMutation();
  }, [ticketId, afterMutation, t]);

  const handleEditComment = useCallback((commentId: string, content: string) => {
    void runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
      errorFallback: t('ticketWorkbench.toast.commentEditFailed'),
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    }).then(() => void load({ background: true })).catch((err) => { if (!(err instanceof ActionError)) throw err; });
  }, [ticketId, load, t]);

  const handleDeleteComment = useCallback((commentId: string) => {
    void runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/comments/${commentId}`, { method: 'DELETE' }),
      errorFallback: t('ticketWorkbench.toast.commentDeleteFailed'),
      onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
    }).then(() => void load({ background: true })).catch((err) => { if (!(err instanceof ActionError)) throw err; });
  }, [ticketId, load, t]);

  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next: FocusTab = e.key === 'Home' ? 'conversation' : e.key === 'End' ? 'details' : focusTab === 'conversation' ? 'details' : 'conversation';
    setFocusTab(next);
    tabRefs.current[next]?.focus();
  };

  // Skeleton only on the first load of a ticket. Refreshes (send, status
  // change, refreshToken bump) keep the tree mounted so composer state —
  // the public/internal mode in particular — survives; aria-busy marks them.
  if (loading && !ticket) {
    return <div className="p-6 animate-pulse space-y-3" data-testid="ticket-workbench-loading">
      <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-4 w-1/3 rounded bg-muted/60" /><div className="h-40 rounded bg-muted/40" />
    </div>;
  }
  if (error || !ticket) {
    return (
      <div className="p-6 text-center" data-testid="ticket-workbench-error">
        <p className="text-sm text-muted-foreground">{error ?? t('ticketWorkbench.loadFailed')}</p>
        {errorKind === 'not-found' ? (
          <a href="/tickets" className="mt-2 inline-block rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="ticket-workbench-back">{t('ticketWorkbench.backToQueue')}</a>
        ) : (
          <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t('common:actions.retry')}</button>
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
  // While the resolve/pending inline confirmation form is open, keep the
  // select showing the status the user just picked instead of snapping back
  // to ticket.status — otherwise the control reads as though the click did
  // nothing. Reverts to the real status only when the form is cancelled.
  const pendingDisplayStatus: TicketStatus | null = pendingOpen ?? (resolveOpen ? 'resolved' : null);
  // Config path: the row the open form will post. The `e` shortcut opens the
  // resolve form without a pendingStatusId (it posts {status:'resolved'}), so
  // show that core state's system row rather than the ticket's old status.
  const pendingDisplayStatusId = pendingDisplayStatus
    ? pendingStatusId ?? config?.statuses.find((s) => s.coreStatus === pendingDisplayStatus && s.isSystem)?.id ?? null
    : null;
  const statusValue = config ? (pendingDisplayStatusId ?? selectedStatusId ?? '') : (pendingDisplayStatus ?? ticket.status);
  const headerStatusColor = ticket.statusColor ?? config?.statuses.find((s) => s.id === selectedStatusId)?.color ?? null;
  const mergedDate = ticket.mergedAt ? formatDateTime(ticket.mergedAt) : t('common:states.unknown');
  const closed = ticket.status === 'resolved' || ticket.status === 'closed';
  const showTabs = !wide;
  const askAi = <WispTalkButton kind="ticket" id={ticket.id} orgId={ticket.orgId} label={ticket.subject} size="sm" />;

  return (
    // Below 640px the whole view scrolls: the header goes away with the thread,
    // while the tab bar (sticky top) and the composer (sticky bottom) stay.
    <div className="flex h-full min-h-0 flex-col max-sm:overflow-y-auto" data-testid="ticket-workbench" aria-busy={loading || undefined}>
      {merged && ticket.mergedIntoTicketId && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm" role="status" data-testid="ticket-merged-banner">
          <span>
            {mergedInto?.state === 'missing'
              ? t('ticketWorkbench.mergedBanner.deleted', { date: mergedDate })
              : mergedInto?.state === 'found' && mergedInto.number
                ? t('ticketWorkbench.mergedBanner.mergedInto', { number: mergedInto.number, date: mergedDate })
                : t('ticketWorkbench.mergedBanner.pending', { date: mergedDate })}
          </span>
          {mergedInto?.state !== 'missing' && (
            <a href={`/tickets/${ticket.mergedIntoTicketId}`} className="font-medium text-primary-ink hover:underline" data-testid="ticket-merged-banner-link">
              {t('ticketWorkbench.mergedBanner.open', { number: mergedInto?.number ?? ticket.mergedIntoTicketId.slice(0, 8) })}
            </a>
          )}
          {/* A tombstone has no composer, so Ask AI stays reachable here. */}
          <span className="ml-auto">{askAi}</span>
        </div>
      )}
      <TicketFocusHeader
        ticket={ticket}
        config={config}
        assignees={assignees}
        merged={merged}
        canEdit={canEdit}
        canManage={canManage}
        statusValue={statusValue}
        statusColor={headerStatusColor}
        onStatusChange={onStatusChange}
        onCustomStatusChange={onCustomStatusChange}
        onPriorityChange={onPriorityChange}
        onAssign={onAssign}
        onSubjectSave={(subject) => handleFieldSave({ subject })}
        onOpenMove={() => setMoveOrgOpen(true)}
        onOpenMerge={() => setMergeOpen(true)}
        onOpenDelete={() => setDeleteOpen(true)}
        metaExtra={showTabs && ticket.deviceId ? (
          <TicketEndpointLine
            deviceId={ticket.deviceId}
            deviceHostname={ticket.deviceHostname}
            endpoint={endpoint}
            canRemote={canRemote}
            onOpenDetails={() => setFocusTab('details')}
          />
        ) : undefined}
      />
      {(ticket.pendingReason || (closed && ticket.resolutionNote)) && (
        <div className="space-y-0.5 border-b bg-muted/40 px-4 py-1.5 text-xs">
          {ticket.pendingReason && (
            <p data-testid="ticket-workbench-waiting-on"><span className="text-muted-foreground">{t('ticketWorkbench.waitingOn')}:</span> {ticket.pendingReason}</p>
          )}
          {closed && ticket.resolutionNote && (
            <p data-testid="ticket-workbench-resolution"><span className="text-muted-foreground">{t('ticketWorkbench.resolution')}:</span> {ticket.resolutionNote}</p>
          )}
        </div>
      )}
      {showTabs && (
        <div role="tablist" aria-label={t('ticketFocus.sections')} className="flex shrink-0 gap-1 border-b bg-background px-4 max-sm:sticky max-sm:top-0 max-sm:z-20" data-testid="ticket-workbench-tabs">
          {(['conversation', 'details'] as const).map((id) => (
            <button
              key={id}
              ref={(el) => { tabRefs.current[id] = el; }}
              type="button"
              role="tab"
              id={`ticket-tab-${id}`}
              aria-selected={focusTab === id}
              aria-controls={`ticket-panel-${id}`}
              tabIndex={focusTab === id ? 0 : -1}
              onClick={() => setFocusTab(id)}
              onKeyDown={onTabKeyDown}
              data-testid={`ticket-workbench-tab-${id}`}
              className={cn(
                '-mb-px min-h-10 border-b-2 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                focusTab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t(/* i18n-dynamic */ `ticketFocus.tabs.${id}`)}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 max-sm:shrink-0 max-sm:grow max-sm:basis-auto">
        <div
          id="ticket-panel-conversation"
          role={showTabs ? 'tabpanel' : undefined}
          aria-labelledby={showTabs ? 'ticket-tab-conversation' : undefined}
          hidden={showTabs && focusTab !== 'conversation'}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          data-testid="ticket-workbench-conversation"
        >
          <div className="min-h-0 flex-1 overflow-y-auto max-sm:overflow-visible max-sm:basis-auto">
            <TicketConversation
              ticket={ticket}
              merged={merged}
              onSaveDescription={(description) => handleFieldSave({ description })}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
              canManageAnyComment={canManage}
              mergedFromNumbers={mergedFromNumbers}
            />
          </div>
          <TicketComposerZone
            ticket={ticket}
            merged={merged}
            config={config}
            categories={categories}
            ai={ai}
            resolve={{
              open: resolveOpen,
              note: resolutionNote,
              setNote: setResolutionNote,
              noteRef: resolveNoteRef,
              onCancel: () => { setResolveOpen(false); setPendingStatusId(null); },
              onSubmit: () => void submitResolve(),
            }}
            pending={{
              open: pendingOpen,
              reason: pendingReason,
              setReason: setPendingReason,
              onCancel: () => { setPendingOpen(null); setPendingReason(''); setPendingStatusId(null); },
              onSubmit: () => void submitPending(),
            }}
            checklistConfirm={checklistConfirm}
            checklistCounts={checklistCounts}
            onChecklistConfirmCancel={() => setChecklistConfirm(null)}
            onChecklistConfirmAccept={() => { const run = checklistConfirm; setChecklistConfirm(null); run?.(); }}
            onSend={sendComment}
            onUploadAttachment={uploadAttachment}
            templates={cannedTemplates}
            templateVars={templateVars}
            toolbarExtra={askAi}
            composerFocus={composerFocus}
          />
        </div>
        <aside
          id="ticket-panel-details"
          role={showTabs ? 'tabpanel' : undefined}
          aria-labelledby={showTabs ? 'ticket-tab-details' : undefined}
          aria-label={showTabs ? undefined : t('ticketFocus.tabs.details')}
          hidden={showTabs && focusTab !== 'details'}
          className={cn('min-h-0 overflow-y-auto max-sm:overflow-visible', showTabs ? 'w-full' : 'w-[360px] shrink-0 border-l')}
          data-testid="ticket-workbench-rail"
        >
          <TicketSituationColumn
            ticket={ticket}
            merged={merged}
            canEdit={canEdit}
            mergedInto={mergedInto}
            categories={categories}
            currencyCode={orgs.find((o) => o.id === ticket.orgId)?.currencyCode}
            callerRevision={callerRevision}
            // Deep-linkable on the standalone page only: in the queue host the
            // page owns the hash (focused ticket, sort, type).
            verificationHash={expanded ? 'caller-verification' : undefined}
            onCallerChanged={() => { setCallerRevision((r) => r + 1); void load({ background: true }); }}
            onFieldSave={handleFieldSave}
            onTypeChange={onTypeChange}
            onCategoryChange={onCategoryChange}
            onChecklistCounts={setChecklistCounts}
            canSavePartnerWideChecklist={canSavePartnerWideChecklist}
            endpoint={endpoint}
          />
        </aside>
      </div>

      <TicketMoveOrgDialog
        open={moveOrgOpen && !merged}
        onClose={() => setMoveOrgOpen(false)}
        ticketId={ticket.id}
        currentOrgId={ticket.orgId}
        orgs={orgs}
        onMoved={() => void load({ background: true })}
      />
      {canEdit && mergeOpen && (
        <MergeTicketDialog
          key={ticket.id}
          open
          source={ticket}
          onClose={() => setMergeOpen(false)}
          onMerged={handleMerged}
        />
      )}
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        isLoading={deleting}
        title={t('ticketWorkbench.deleteDialog.title')}
        message={t('ticketWorkbench.deleteDialog.message')}
        confirmLabel={t('ticketWorkbench.deleteDialog.confirm')}
        confirmTestId="ticket-delete-confirm"
      />
    </div>
  );
}
