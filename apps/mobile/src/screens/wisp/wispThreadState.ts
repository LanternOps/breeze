// Pure state helpers for the Wisp thread screen. No React / react-native.
import type { WispThreadParams } from '../../navigation/navigationRef';
import type { WispConcern, WispConcernSeverity } from '../../services/wisp';
import type { ChatMessage, ToolEvent } from '../../store/aiChatSlice';

export type ConcernSectionKey = 'needs_you' | 'open' | 'snoozed' | 'done';
export type ConcernSection = { key: ConcernSectionKey; title: string; concerns: WispConcern[] };

const SEVERITY_RANK: Record<WispConcernSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

const SECTION_TITLES: Record<ConcernSectionKey, string> = {
  needs_you: 'Needs you',
  open: 'Open',
  snoozed: 'Snoozed',
  done: 'Done',
};

const SECTION_ORDER: ConcernSectionKey[] = ['needs_you', 'open', 'snoozed', 'done'];

function sectionOf(c: WispConcern, nowMs: number): ConcernSectionKey {
  if (c.status === 'resolved' || c.status === 'dismissed') return 'done';
  if (c.status === 'snoozed') {
    const until = c.snoozedUntil ? Date.parse(c.snoozedUntil) : NaN;
    if (Number.isFinite(until) && until > nowMs) return 'snoozed';
  }
  return c.approvalIntentId ? 'needs_you' : 'open';
}

function compareConcerns(a: WispConcern, b: WispConcern): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  const aOk = Number.isFinite(ta);
  const bOk = Number.isFinite(tb);
  if (aOk && bOk) return tb - ta;
  if (aOk) return -1;
  if (bOk) return 1;
  return 0;
}

export function concernSections(concerns: WispConcern[], now: Date): ConcernSection[] {
  const nowMs = now.getTime();
  const buckets: Record<ConcernSectionKey, WispConcern[]> = {
    needs_you: [],
    open: [],
    snoozed: [],
    done: [],
  };
  for (const c of concerns) buckets[sectionOf(c, nowMs)].push(c);
  return SECTION_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    title: SECTION_TITLES[key],
    concerns: [...buckets[key]].sort(compareConcerns),
  }));
}

export function approvalOpenTarget(c: Pick<WispConcern, 'status' | 'approvalIntentId'>): string | null {
  return c.status === 'open' && typeof c.approvalIntentId === 'string' && c.approvalIntentId.length > 0
    ? c.approvalIntentId
    : null;
}

/**
 * A concern names its approval card by ACTION INTENT id, while the mobile
 * takeover (`setFocus` / `fetchOne`) is keyed by APPROVAL REQUEST id — an
 * intent fans out to one approval row per approver. Map the intent onto this
 * user's still-pending row; null means decided elsewhere (or not this user's
 * to decide), and the caller must not focus anything (Review Focus 4).
 */
export function approvalRequestIdForIntent(
  pending: ReadonlyArray<{ id: string; status: string; intentId?: string | null }>,
  intentId: string,
): string | null {
  if (!intentId) return null;
  const row = pending.find((a) => a.intentId === intentId && a.status === 'pending');
  return row ? row.id : null;
}

export function initialExpandedConcern(params: WispThreadParams, concerns: WispConcern[]): string | null {
  const id = params.concernId;
  if (typeof id !== 'string' || id.length === 0) return null;
  return concerns.some((c) => c.id === id) ? id : null;
}

export type WispSessionStatus = 'idle' | 'creating' | 'streaming' | 'error';
export type WispSessionState = {
  sessionId: string | null;
  messages: ChatMessage[];
  status: WispSessionStatus;
  error: string | null;
};

export const INITIAL_WISP_SESSION: WispSessionState = {
  sessionId: null,
  messages: [],
  status: 'idle',
  error: null,
};

export type WispSessionEvent =
  | { type: 'creating' }
  | { type: 'created'; sessionId: string }
  | { type: 'userSent'; id: string; content: string; sentAt: string }
  | { type: 'delta'; id: string; delta: string; sentAt: string }
  | { type: 'toolEvent'; id: string; event: ToolEvent; sentAt: string }
  | { type: 'done' }
  | { type: 'failed'; error: string }
  | { type: 'reset' };

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

function updateAssistant(
  messages: ChatMessage[],
  id: string,
  sentAt: string,
  update: (m: AssistantMessage) => AssistantMessage,
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === id && m.role === 'assistant');
  if (idx === -1) {
    const fresh: AssistantMessage = {
      id,
      role: 'assistant',
      content: '',
      toolEvents: [],
      sentAt,
      isStreaming: true,
    };
    return [...messages, update(fresh)];
  }
  return messages.map((m, i) => (i === idx ? update(m as AssistantMessage) : m));
}

function mergeToolEvent(events: ToolEvent[], incoming: ToolEvent): ToolEvent[] {
  const idx = events.findIndex((e) => e.toolUseId === incoming.toolUseId);
  if (idx === -1) return [...events, incoming];
  const existing = events[idx];
  const merged: ToolEvent = { ...existing, ...incoming };
  if (incoming.toolName === 'tool') merged.toolName = existing.toolName;
  if (incoming.input === undefined && existing.input !== undefined) merged.input = existing.input;
  return events.map((e, i) => (i === idx ? merged : e));
}

export function wispSessionReducer(state: WispSessionState, event: WispSessionEvent): WispSessionState {
  switch (event.type) {
    case 'creating':
      return { ...state, status: 'creating', error: null };
    case 'created':
      return {
        ...state,
        sessionId: event.sessionId,
        status: state.status === 'creating' ? 'idle' : state.status,
      };
    case 'userSent':
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: event.id, role: 'user', content: event.content, sentAt: event.sentAt },
        ],
        status: 'streaming',
        error: null,
      };
    case 'delta':
      return {
        ...state,
        messages: updateAssistant(state.messages, event.id, event.sentAt, (m) => ({
          ...m,
          content: m.content + event.delta,
        })),
        status: 'streaming',
      };
    case 'toolEvent':
      return {
        ...state,
        messages: updateAssistant(state.messages, event.id, event.sentAt, (m) => ({
          ...m,
          toolEvents: mergeToolEvent(m.toolEvents, event.event),
        })),
        status: 'streaming',
      };
    case 'done':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.role === 'assistant' ? { ...m, isStreaming: false } : m,
        ),
        status: 'idle',
      };
    case 'failed':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.role === 'assistant' && m.isStreaming ? { ...m, isStreaming: false, failed: true } : m,
        ),
        status: 'error',
        error: event.error,
      };
    case 'reset':
      return { ...INITIAL_WISP_SESSION, messages: [] };
  }
}
