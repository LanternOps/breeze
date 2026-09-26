import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AiTopologyProgressPhase, TopologyAiExplanation, TopologyAiSelection } from '@breeze/shared';
import { topologyAiExplanationSchema } from '@breeze/shared/validators/topologyAi';
import { useAiStore } from '../../stores/aiStore';
import type { PendingApproval } from '../../stores/processStreamEvent';

/**
 * Topology M4 Task 5 (#6000): one "Explain this" investigation over the
 * EXISTING AI chat session transport (aiStore) — no second session API, no
 * second stream.
 *
 * - `explain()` is the ONLY model-start path: it creates a site-pinned session
 *   from the selection (IDs only) and sends one fixed question. Nothing calls
 *   the model on mount, on selection or on reopen.
 * - Only the server-validated `topology_explanation` is exposed, re-validated
 *   here; anything else (raw text, a malformed answer) is the deterministic
 *   fallback, never displayed prose.
 * - A selection change while a turn runs cancels it and forgets it, so a
 *   delayed response for the previous selection can never land on the new one.
 *   A COMPLETED answer stays visible, explicitly historical (proposals
 *   disabled), so following a citation does not lose it. Unmount (inspector
 *   closed, site changed, logout) interrupts a running turn.
 * - A reopened investigation (hash) is re-read under current access and is
 *   historical when its stored selection is not the current one.
 */

/** Fixed question: the answer cache is keyed by it, and the model never sees user prose here. */
export const TOPOLOGY_EXPLAIN_QUESTION = 'Explain the selected device or connection using only the cited evidence.';
export const DIAGNOSE_CONNECTIVITY_TOOL = 'diagnose_connectivity';

export type TopologyInvestigationStatus = 'idle' | 'starting' | 'running' | 'complete' | 'fallback' | 'error';
export type TopologyInvestigationError = { code: string | null; message: string };

export type TopologyInvestigation = {
  explain: () => Promise<void>;
  cancel: () => void;
  status: TopologyInvestigationStatus;
  phase: AiTopologyProgressPhase | 'starting' | null;
  explanation: TopologyAiExplanation | null;
  error: TopologyInvestigationError | null;
  /** The pending diagnose_connectivity approval of THIS investigation, if any. */
  proposal: PendingApproval | null;
  /** Accepted run of an approved proposal (live, or resumed from the hash). */
  runId: string | null;
  /** The shown answer belongs to another selection or graph revision: display only, no proposals. */
  historical: boolean;
  sessionId: string | null;
};

/** Identity of a selection for cancellation. The graph revision is NOT part of it: a revision change makes an answer historical, not void. */
export function topologySelectionKey(selection: TopologyAiSelection | null): string {
  return selection ? `${selection.siteId}/${selection.subject.kind}/${selection.subject.id}/${selection.view}` : '';
}

export function useTopologyInvestigation(selection: TopologyAiSelection | null, options: {
  /** Investigation to reopen (from the hash); re-read, never re-run. */
  initialSessionId?: string;
  initialRunId?: string;
  onSession?: (sessionId: string | undefined) => void;
} = {}): TopologyInvestigation {
  const [sessionId, setSessionId] = useState<string | null>(options.initialSessionId ?? null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<TopologyInvestigationError | null>(null);
  const key = topologySelectionKey(selection);
  const startedFor = useRef<string | null>(null);
  const firstKey = useRef(key);

  const store = useAiStore(useShallow((s) => ({
    sessionId: s.sessionId, messages: s.messages, isStreaming: s.isStreaming, isLoading: s.isLoading, error: s.error, errorCode: s.errorCode,
    topologySiteId: s.topologySiteId, topologySelection: s.topologySelection, topologyPhase: s.topologyPhase, topologyRunId: s.topologyRunId,
    pendingApproval: s.pendingApproval,
  })));
  const owned = sessionId !== null && store.sessionId === sessionId;

  // Reopen from the hash: read the stored investigation (no model call).
  useEffect(() => {
    const id = options.initialSessionId;
    // After a page reload only the persisted session id survives (not its
    // messages), so "is it the store's session" is not "is it loaded".
    const state = useAiStore.getState();
    if (id && (state.sessionId !== id || state.hydratedSessionId !== id)) void state.loadSession(id);
  }, []);

  const forget = useCallback(() => {
    const state = useAiStore.getState();
    if (sessionId && state.sessionId === sessionId && state.isStreaming) void state.interruptResponse();
    startedFor.current = null;
    setSessionId(null); setStarting(false); setStartError(null);
    options.onSession?.(undefined);
  }, [sessionId, options.onSession]);

  // A different selection voids a running or failed investigation; a completed
  // one is kept as a historical answer (see `historical`).
  const live = useRef({ sessionId, starting });
  live.current = { sessionId, starting };
  useEffect(() => {
    if (key === firstKey.current) return;
    firstKey.current = key;
    const state = useAiStore.getState();
    const running = starting || (sessionId !== null && state.sessionId === sessionId && state.isStreaming);
    if (running || startError) forget();
  }, [key]);
  useEffect(() => () => {
    const { sessionId: id } = live.current;
    const state = useAiStore.getState();
    // A pending explain() checks this before sending, so a session created
    // after unmount is never asked anything.
    startedFor.current = null;
    if (id && state.sessionId === id && state.isStreaming) void state.interruptResponse();
  }, []);

  const explain = useCallback(async () => {
    if (!selection || starting) return;
    const state = useAiStore.getState();
    if (owned && state.isStreaming) return;
    const requestKey = key;
    startedFor.current = requestKey;
    setStarting(true); setStartError(null); setSessionId(null);
    await state.createSession({ pageContext: { type: 'topology', ...selection } });
    const created = useAiStore.getState();
    if (startedFor.current !== requestKey) return; // selection changed while starting
    if (!created.sessionId || created.error || created.topologySiteId !== selection.siteId) {
      setStartError({ code: created.errorCode, message: created.error ?? '' });
      setStarting(false);
      return;
    }
    const id = created.sessionId;
    setSessionId(id); setStarting(false);
    options.onSession?.(id);
    await created.sendMessage(TOPOLOGY_EXPLAIN_QUESTION);
  }, [selection, key, starting, owned, options.onSession]);

  const assistant = owned ? [...store.messages].reverse().find((m) => m.role === 'assistant' && (m.topologyExplanation || m.topologyExplanationInvalid)) : undefined;
  const parsed = assistant?.topologyExplanation ? topologyAiExplanationSchema.safeParse(assistant.topologyExplanation) : null;
  const explanation = parsed?.success ? parsed.data : null;
  const turnSent = owned && store.messages.some((m) => m.role === 'user');

  let status: TopologyInvestigationStatus = 'idle';
  if (starting) status = 'starting';
  else if (startError) status = 'error';
  else if (owned && store.isStreaming) status = 'running';
  else if (explanation) status = 'complete';
  else if (owned && store.error) status = 'error';
  else if (assistant?.topologyExplanationInvalid || (parsed && !parsed.success)) status = 'fallback';
  else if (turnSent && !store.isLoading) status = 'fallback';

  const error = startError ?? (owned && store.error ? { code: store.errorCode, message: store.error } : null);
  const stored = owned ? store.topologySelection : null;
  const historical = !!explanation && (!selection || !stored || stored.siteId !== selection.siteId
    || stored.subject.id !== selection.subject.id || stored.subject.kind !== selection.subject.kind || stored.graphRevision !== selection.graphRevision);
  const proposal = owned && store.pendingApproval?.toolName === DIAGNOSE_CONNECTIVITY_TOOL ? store.pendingApproval : null;
  const runId = (owned ? store.topologyRunId : null) ?? options.initialRunId ?? null;

  return {
    explain, cancel: forget, status,
    phase: status === 'starting' ? 'starting' : status === 'running' ? store.topologyPhase : null,
    explanation, error, proposal, runId, historical, sessionId,
  };
}
