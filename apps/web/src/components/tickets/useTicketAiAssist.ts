import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AiAgentRunTicketProposalDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import type { TicketDetail } from './ticketConfig';
import type { TFunction, TicketAiDraft, TicketTriageSuggestion } from './ticketWorkbenchTypes';

interface Args {
  ticket: TicketDetail | null;
  ticketId: string;
  afterMutation: (optimistic?: Partial<TicketDetail>) => void;
  /** The resolution_note draft prefilled into the open resolve form (owned by the workbench). */
  resolveDraftId: string | null;
  setResolveDraftId: Dispatch<SetStateAction<string | null>>;
  t: TFunction;
}

/**
 * The ticket's AI assistance: the ML triage suggestion, the active AI drafts
 * (#4191) and the newest triage run's proposal card (#4211). Moved out of
 * TicketWorkbench unchanged; every write goes through runAction.
 */
export function useTicketAiAssist({ ticket, ticketId, afterMutation, resolveDraftId, setResolveDraftId, t }: Args) {
  const [triageSuggestion, setTriageSuggestion] = useState<TicketTriageSuggestion | null>(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [applyingTriage, setApplyingTriage] = useState(false);
  const [rejectingTriage, setRejectingTriage] = useState(false);

  // P2-4 (#4191), Task 11 — active AI drafts (at most one `reply` + one
  // `resolution_note`, per ticket_drafts_active_uq). `draftContent` holds the
  // per-draft editable textarea value, seeded from the fetched content and
  // diverging only when the technician edits before sending.
  const [aiDrafts, setAiDrafts] = useState<TicketAiDraft[]>([]);
  const [draftContent, setDraftContent] = useState<Record<string, string>>({});
  const [sendingDraftId, setSendingDraftId] = useState<string | null>(null);
  const [discardingDraftId, setDiscardingDraftId] = useState<string | null>(null);
  // Read by openResolveForm via a ref (not a direct closure/dependency) so
  // that helper's identity stays stable across ai-drafts refetches — see the
  // comment above openResolveForm for why that stability matters.
  const aiDraftsRef = useRef<TicketAiDraft[]>([]);
  // Synced in a LAYOUT effect, not a passive one. openResolveForm reads this
  // ref from a discrete event handler, and a passive effect is flushed in a
  // later macrotask than the commit that painted the draft — so a status
  // change fired in between (RTL's post-waitFor drain vs React's scheduler
  // under CI load, or a fast user) saw the pre-fetch [] and opened the resolve
  // form with an empty note. A layout effect runs inside the same commit, so
  // there is no window in which the DOM shows the draft but the ref lacks it.
  useLayoutEffect(() => { aiDraftsRef.current = aiDrafts; }, [aiDrafts]);

  useEffect(() => {
    if (!ticket || ticket.mergedIntoTicketId) {
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

  // Loads the (fresh) active-draft list for `forTicketId` from the server —
  // the shared loader behind both the mount/ticket-change effect below AND
  // the post-conflict recovery calls in sendAiDraft/discardAiDraft/
  // submitResolve. Guarded against a ticket switch racing an in-flight fetch
  // via `ticketIdRef` rather than an effect-local `cancelled` flag, since
  // this is also called imperatively outside any effect.
  const ticketIdRef = useRef(ticketId);
  useEffect(() => { ticketIdRef.current = ticketId; }, [ticketId]);

  const refetchAiDrafts = useCallback(async (forTicketId: string) => {
    try {
      const res = await fetchWithAuth(`/tickets/${forTicketId}/ai-drafts`);
      if (!res.ok) return;
      const body = await res.json();
      if (ticketIdRef.current !== forTicketId) return; // ticket switched mid-flight
      const drafts: TicketAiDraft[] = Array.isArray(body?.data) ? body.data : [];
      setAiDrafts(drafts);
      setDraftContent((prev) => {
        const next = { ...prev };
        for (const draft of drafts) {
          if (!(draft.id in next)) next[draft.id] = draft.content;
        }
        return next;
      });
    } catch {
      // Best-effort — leave the existing (possibly stale) list rather than
      // clearing it out from under an in-progress edit on a network blip.
    }
  }, []);

  // P2-4 (#4191), Task 11 — active AI drafts, fetched alongside the triage
  // suggestion above. A draft the API stops returning (sent/discarded/
  // consumed elsewhere) simply drops out of `aiDrafts` on the next fetch,
  // which is the only thing the card list renders from.
  useEffect(() => {
    if (!ticket || ticket.mergedIntoTicketId) {
      setAiDrafts([]);
      setDraftContent({});
      return;
    }
    void refetchAiDrafts(ticketId);
  }, [ticket, ticketId, refetchAiDrafts]);

  // #4211 (W01) — the newest triage run's ticketProposal, fetched alongside
  // the AI drafts above. Cleared to null after a successful post (the note
  // is now on the feed; there's nothing left to "post as me").
  const [aiProposal, setAiProposal] = useState<{ runId: string; proposal: AiAgentRunTicketProposalDto } | null>(null);
  const [postingProposal, setPostingProposal] = useState(false);

  const refetchAiProposal = useCallback(async (forTicketId: string) => {
    // #4211 review: same "best-effort, never clear on failure" contract as
    // refetchAiDrafts above — the guard against a stale response applies to
    // EVERY exit path (not just the success one), and a failed fetch/parse
    // leaves the existing (possibly stale) card rather than nulling it out.
    try {
      const res = await fetchWithAuth(`/tickets/${forTicketId}/ai-proposal`);
      if (ticketIdRef.current !== forTicketId) return; // ticket switched mid-flight
      if (!res.ok) return;
      const body = await res.json();
      if (ticketIdRef.current !== forTicketId) return; // switched while awaiting .json()
      setAiProposal(body?.data ?? null);
    } catch {
      // Best-effort — leave the existing (possibly stale) card rather than
      // clearing it out from under an in-progress "post as note" action on
      // a network blip.
    }
  }, []);

  useEffect(() => {
    if (!ticket || ticket.mergedIntoTicketId) {
      setAiProposal(null);
      return;
    }
    void refetchAiProposal(ticketId);
  }, [ticket, ticketId, refetchAiProposal]);

  // I2 (#4191 final review): without this, ticket A's AI-draft cards (and
  // any in-progress per-draft edits) stayed visible until the new ticket's
  // `refetchAiDrafts` call resolved — a stale card could even be
  // sent/discarded against the wrong ticket. Clear both eagerly on a switch
  // rather than waiting on the `[ticket, ticketId]` refetch effect. #4211
  // (W01) — the proposal card is the same stale-card class.
  useEffect(() => {
    setAiDrafts([]);
    setDraftContent({});
    setAiProposal(null);
  }, [ticketId]);

  // #4211 (W01) — "Post as private note": posts aiProposal's summary as an
  // internal note under the calling technician's own identity, then clears
  // the card (the note is now on the feed; nothing left to post).
  const postAiProposalNote = useCallback(async (content: string) => {
    if (!aiProposal || postingProposal) return;
    setPostingProposal(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/ai-proposal/post-note`, {
          method: 'POST',
          body: JSON.stringify({ runId: aiProposal.runId, content })
        }),
        errorFallback: t('tickets:ticketWorkbench.aiProposal.postFailed'),
        successMessage: t('tickets:ticketWorkbench.aiProposal.posted'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setAiProposal(null);
      // The post created a new private note — refresh the feed.
      afterMutation();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setPostingProposal(false);
    }
  }, [afterMutation, aiProposal, postingProposal, ticketId, t]);

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
        errorFallback: t('tickets:ticketWorkbench.triage.applyFailed'),
        successMessage: t('tickets:ticketWorkbench.triage.applied'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setTriageSuggestion(null);
      afterMutation(body);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setApplyingTriage(false);
    }
  }, [afterMutation, applyingTriage, ticketId, triageSuggestion, t]);

  const rejectTriageSuggestion = useCallback(async () => {
    if (!triageSuggestion || rejectingTriage) return;
    setRejectingTriage(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/triage-suggestion/reject`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        errorFallback: t('tickets:ticketWorkbench.triage.feedbackFailed'),
        successMessage: t('tickets:ticketWorkbench.triage.feedbackSaved'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setTriageSuggestion(null);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setRejectingTriage(false);
    }
  }, [rejectingTriage, ticketId, triageSuggestion, t]);

  // "Send as me" — posts the (possibly technician-edited) draft content as a
  // PUBLIC comment under the calling technician's own identity. Reply drafts
  // only; the API 409s a resolution_note draft here (it's consumed only via
  // the resolve flow's aiDraftId).
  const sendAiDraft = useCallback(async (draft: TicketAiDraft) => {
    // Scoped to this draft's own id — each draft card is an independent
    // operation (#4469). Guarding on "any in-flight action" blocked acting on
    // one card while the other was mid-request, even though the button
    // itself wasn't visually disabled.
    if (sendingDraftId === draft.id || discardingDraftId === draft.id) return;
    const content = (draftContent[draft.id] ?? draft.content).trim();
    if (!content) return;
    setSendingDraftId(draft.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/ai-drafts/${draft.id}/send`, {
          method: 'POST',
          body: JSON.stringify({ content }),
        }),
        errorFallback: t('tickets:ticketWorkbench.aiDraft.sendFailed'),
        successMessage: t('tickets:ticketWorkbench.aiDraft.sent'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setAiDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      // The send created a new public comment — refresh the feed.
      afterMutation();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      // A non-401 failure (typically a 409 — someone else already sent or
      // discarded this exact draft) would otherwise leave the card mounted
      // and interactive on stale local state, looping the same 409 on every
      // retry. Refetch the real active-draft list so a now-gone draft's
      // card actually disappears.
      if (err.status !== 401) void refetchAiDrafts(ticketId);
    } finally {
      setSendingDraftId(null);
    }
  }, [afterMutation, discardingDraftId, draftContent, refetchAiDrafts, sendingDraftId, ticketId, t]);

  // Discards a draft (either kind) without acting on it.
  const discardAiDraft = useCallback(async (draft: TicketAiDraft) => {
    // Scoped to this draft's own id — see sendAiDraft above (#4469).
    if (sendingDraftId === draft.id || discardingDraftId === draft.id) return;
    setDiscardingDraftId(draft.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/ai-drafts/${draft.id}/discard`, { method: 'POST' }),
        errorFallback: t('tickets:ticketWorkbench.aiDraft.discardFailed'),
        successMessage: t('tickets:ticketWorkbench.aiDraft.discarded'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setAiDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      if (resolveDraftId === draft.id) setResolveDraftId(null);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      // Same stale-card recovery as sendAiDraft — a non-401 failure here is
      // typically a 409 (already sent/discarded/consumed elsewhere).
      if (err.status !== 401) {
        void refetchAiDrafts(ticketId);
        if (resolveDraftId === draft.id) setResolveDraftId(null);
      }
    } finally {
      setDiscardingDraftId(null);
    }
  }, [discardingDraftId, refetchAiDrafts, resolveDraftId, sendingDraftId, setResolveDraftId, ticketId, t]);

  return {
    triageSuggestion,
    triageLoading,
    applyingTriage,
    rejectingTriage,
    applyTriageSuggestion,
    rejectTriageSuggestion,
    aiDrafts,
    setAiDrafts,
    aiDraftsRef,
    draftContent,
    setDraftContent,
    sendingDraftId,
    discardingDraftId,
    sendAiDraft,
    discardAiDraft,
    refetchAiDrafts,
    aiProposal,
    postingProposal,
    postAiProposalNote,
  };
}

export type TicketAiAssist = ReturnType<typeof useTicketAiAssist>;
