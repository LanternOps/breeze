import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import {
  applyPlanEvent,
  applyPlanInput,
  applyPlanToolResult,
  planDecided,
  planGone,
  proposedPlan,
  type ChatPlan,
  type PlanDecision,
  type PlanStreamEvent,
} from '../screens/chat/planState';
import type { AiTurnModel } from '../screens/chat/modelPicker';

export type ChatStatus = 'idle' | 'creating-session' | 'streaming' | 'error';

export interface ToolEvent {
  toolUseId: string;
  toolName: string;
  state: 'started' | 'completed';
  output?: unknown;
  isError?: boolean;
  /**
   * Server-asserted approval handoff (#5107) — copied straight off the SSE
   * `tool_result` event, never derived from `output`, which the tool controls.
   * See `toolIndicatorLogic.toolRowStatus` for why the distinction matters.
   */
  handoff?: string;
  /**
   * The tool call's arguments, off the SSE `tool_use_start` event (#5170).
   * Lets the row read `input.action` to tell a read-only call (`list`,
   * `get`, …) apart from a mutation with the same leading verb — see
   * `aiToolLabel`. Only ever set once, at `tool_use_start`.
   */
  input?: Record<string, unknown>;
}

export type ChatMessage =
  | { id: string; role: 'user'; content: string; sentAt: string; failed?: boolean }
  | {
      id: string;
      role: 'assistant';
      content: string;
      toolEvents: ToolEvent[];
      sentAt: string;
      isStreaming: boolean;
      failed?: boolean;
      /**
       * The action plan this turn proposed (`propose_action_plan`, plan-first
       * approval modes). The tool call also stays in `toolEvents` so turn
       * completeness still sees it running while the server waits.
       */
      plan?: ChatPlan;
      /**
       * What actually answered this turn (`turn_model` SSE event, W05). After a
       * history reload only the LAST turn has one: the server persists just
       * `ai_sessions.last_turn_model`, not a per-message record.
       */
      turnModel?: AiTurnModel;
    };

export interface AiChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  // The id of the assistant message currently being streamed (if any).
  // Lets the UI render a streaming pulse on the right row without scanning.
  streamingMessageId: string | null;
  // Tracks the in-flight tool name for the mid-stream caption ("CHECKING FLEET").
  inFlightTool: { toolUseId: string; toolName: string; input?: Record<string, unknown> } | null;
  status: ChatStatus;
  error: string | null;
  /**
   * The open chat's org. A partner-scope token has no org of its own, so
   * org-keyed reads (the approval mode on `GET /ai/usage`) need this one.
   */
  sessionOrgId: string | null;
}

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

/**
 * The rows of one live reply turn (#8888). A turn is several model messages
 * (text -> tool_use, the tool result, then the next message); the server
 * persists one assistant row per message, so the live stream keeps one row
 * per `message_start` too. The turn is addressed by its first row's id (what
 * HomeScreen holds), and its rows are that row plus the assistant rows after
 * it — a new turn always starts with a user row.
 */
function turnRows(state: AiChatState, turnId: string): AssistantMessage[] {
  const start = state.messages.findIndex((m) => m.id === turnId);
  const rows: AssistantMessage[] = [];
  for (let i = start; i >= 0 && i < state.messages.length; i++) {
    const m = state.messages[i];
    if (m.role !== 'assistant') break;
    rows.push(m);
  }
  return rows;
}

/** The row the turn is streaming into now: its newest. */
function liveRow(state: AiChatState, turnId: string): AssistantMessage | undefined {
  const rows = turnRows(state, turnId);
  return rows[rows.length - 1];
}

function rowIsEmpty(m: AssistantMessage): boolean {
  return !m.content && m.toolEvents.length === 0 && !m.plan;
}

const initialState: AiChatState = {
  sessionId: null,
  messages: [],
  streamingMessageId: null,
  inFlightTool: null,
  status: 'idle',
  error: null,
  sessionOrgId: null,
};

const aiChatSlice = createSlice({
  name: 'aiChat',
  initialState,
  reducers: {
    sessionCreated(state, action: PayloadAction<{ sessionId: string; orgId?: string | null }>) {
      state.sessionId = action.payload.sessionId;
      state.sessionOrgId = action.payload.orgId ?? null;
    },
    addUserMessage(state, action: PayloadAction<{ id: string; content: string; sentAt: string }>) {
      state.messages.push({
        id: action.payload.id,
        role: 'user',
        content: action.payload.content,
        sentAt: action.payload.sentAt,
      });
    },
    addPendingAssistantMessage(state, action: PayloadAction<{ id: string; sentAt: string }>) {
      state.messages.push({
        id: action.payload.id,
        role: 'assistant',
        content: '',
        toolEvents: [],
        sentAt: action.payload.sentAt,
        isStreaming: true,
      });
      state.streamingMessageId = action.payload.id;
      state.status = 'streaming';
      state.error = null;
    },
    /**
     * SSE `message_start`: the turn's next model message begins, so it gets
     * its own row — the same row a history reload builds from the server's
     * per-message `ai_messages` row. Text from two messages therefore never
     * runs together, and lands on the same side of a tool or plan card live
     * as it does after a reload (#8888). A message that starts before the
     * turn has produced anything reuses the pending row.
     */
    assistantMessageStarted(state, action: PayloadAction<{ turnId: string; sentAt: string }>) {
      const rows = turnRows(state, action.payload.turnId);
      const current = rows[rows.length - 1];
      if (!current || rowIsEmpty(current)) return;
      current.isStreaming = false;
      const id = `${action.payload.turnId}-${rows.length}`;
      state.messages.push({
        id,
        role: 'assistant',
        content: '',
        toolEvents: [],
        sentAt: action.payload.sentAt,
        isStreaming: true,
      });
      if (state.streamingMessageId && rows.some((r) => r.id === state.streamingMessageId)) {
        state.streamingMessageId = id;
      }
    },
    appendDelta(state, action: PayloadAction<{ id: string; delta: string }>) {
      const msg = liveRow(state, action.payload.id);
      if (msg) msg.content += action.payload.delta;
    },
    setInFlightTool(
      state,
      action: PayloadAction<{ toolUseId: string; toolName: string; input?: Record<string, unknown> } | null>,
    ) {
      state.inFlightTool = action.payload;
    },
    appendToolEvent(state, action: PayloadAction<{ messageId: string; event: ToolEvent }>) {
      // A result belongs on the row holding its call, even if a later message
      // of the turn has already started.
      const rows = turnRows(state, action.payload.messageId);
      const msg = rows.find((r) => r.toolEvents.some((t) => t.toolUseId === action.payload.event.toolUseId))
        ?? rows[rows.length - 1];
      if (msg) {
        const existing = msg.toolEvents.find((t) => t.toolUseId === action.payload.event.toolUseId);
        if (existing) {
          existing.state = action.payload.event.state;
          if (action.payload.event.output !== undefined) existing.output = action.payload.event.output;
          if (action.payload.event.isError !== undefined) existing.isError = action.payload.event.isError;
          if (action.payload.event.handoff !== undefined) existing.handoff = action.payload.event.handoff;
          if (action.payload.event.input !== undefined) existing.input = action.payload.event.input;
        } else {
          msg.toolEvents.push(action.payload.event);
        }
        if (
          action.payload.event.state === 'completed'
          && msg.plan
          && msg.plan.toolUseId === action.payload.event.toolUseId
        ) {
          msg.plan = applyPlanToolResult(msg.plan, action.payload.event.output);
        }
      }
    },
    /** A `propose_action_plan` call started on this message (live `tool_use_start`). */
    planProposed(state, action: PayloadAction<{ messageId: string; toolUseId: string }>) {
      const msg = liveRow(state, action.payload.messageId);
      if (msg) {
        msg.plan = proposedPlan(action.payload.toolUseId, undefined);
      }
    },
    /** Live `tool_use_input` for the plan tool call: brings the plan title. */
    planInput(state, action: PayloadAction<{ messageId: string; toolUseId: string; input: unknown }>) {
      const msg = turnRows(state, action.payload.messageId).find((r) => r.plan?.toolUseId === action.payload.toolUseId);
      if (msg) {
        msg.plan = applyPlanInput(msg.plan, action.payload.toolUseId, action.payload.input);
      }
    },
    /**
     * A `plan_*` SSE event. `plan_approval_required` lands on the streaming
     * message; step/complete events follow the plan by id wherever it is.
     */
    planStreamEvent(state, action: PayloadAction<{ messageId: string; event: PlanStreamEvent }>) {
      const { event } = action.payload;
      const msg = event.type === 'plan_approval_required'
        // The turn's row that proposed the plan (the newest row with one).
        ? (turnRows(state, action.payload.messageId).filter((r) => r.plan).pop()
          ?? liveRow(state, action.payload.messageId))
        : state.messages.find((m) => m.role === 'assistant' && m.plan?.planId === event.planId);
      if (msg && msg.role === 'assistant') {
        msg.plan = applyPlanEvent(msg.plan, event);
      }
    },
    /** The server accepted the user's approve/reject. */
    planDecision(state, action: PayloadAction<{ messageId: string; decision: PlanDecision }>) {
      const msg = state.messages.find((m) => m.id === action.payload.messageId);
      if (msg && msg.role === 'assistant' && msg.plan) {
        msg.plan = planDecided(msg.plan, action.payload.decision);
      }
    },
    /** The server no longer holds this plan open (timed out, aborted, decided elsewhere). */
    planNoLongerPending(state, action: PayloadAction<{ messageId: string }>) {
      const msg = state.messages.find((m) => m.id === action.payload.messageId);
      if (msg && msg.role === 'assistant' && msg.plan) {
        msg.plan = planGone(msg.plan);
      }
    },
    finishAssistantMessage(
      state,
      action: PayloadAction<{ id: string; failIfEmpty?: { error: string } }>,
    ) {
      let rows = turnRows(state, action.payload.id);
      const turnIds = new Set([action.payload.id, ...rows.map((r) => r.id)]);
      // A last message that produced nothing leaves no row, as in history —
      // unless the stream failed on it: that row carries the retry.
      const trailing = rows[rows.length - 1];
      if (rows.length > 1 && rowIsEmpty(trailing) && !trailing.failed) {
        state.messages = state.messages.filter((m) => m.id !== trailing.id);
        rows = rows.slice(0, -1);
        if (trailing.turnModel) rows[rows.length - 1].turnModel = trailing.turnModel;
      }
      const msg = rows[rows.length - 1];
      if (msg) {
        for (const r of rows) r.isStreaming = false;
        const empty = rows.every((r) => !r.content && r.toolEvents.length === 0);
        if (empty && action.payload.failIfEmpty) {
          msg.failed = true;
          state.status = 'error';
          state.error = action.payload.failIfEmpty.error;
        } else if (state.status !== 'error') {
          state.status = 'idle';
        }
      }
      if (state.streamingMessageId && turnIds.has(state.streamingMessageId)) {
        state.streamingMessageId = null;
      }
      state.inFlightTool = null;
    },
    failAssistantMessage(state, action: PayloadAction<{ id: string; error: string }>) {
      const rows = turnRows(state, action.payload.id);
      for (const r of rows) r.isStreaming = false;
      const msg = rows[rows.length - 1];
      if (msg) msg.failed = true;
      if (
        state.streamingMessageId
        && (state.streamingMessageId === action.payload.id || rows.some((r) => r.id === state.streamingMessageId))
      ) {
        state.streamingMessageId = null;
      }
      state.inFlightTool = null;
      state.status = 'error';
      state.error = action.payload.error;
    },
    setTurnModel(state, action: PayloadAction<{ messageId: string; turnModel: AiTurnModel }>) {
      // On the turn's last row, where a history reload puts it.
      const msg = liveRow(state, action.payload.messageId);
      if (msg) msg.turnModel = action.payload.turnModel;
    },
    /**
     * The server refused this turn before it ran (a model switch that needs a
     * continuation, or a model that is no longer usable): drop its optimistic
     * rows so the transcript matches the server's.
     */
    discardTurn(state, action: PayloadAction<{ ids: string[] }>) {
      const ids = new Set(action.payload.ids);
      state.messages = state.messages.filter((m) => !ids.has(m.id));
      if (state.streamingMessageId && ids.has(state.streamingMessageId)) state.streamingMessageId = null;
      state.inFlightTool = null;
      state.status = 'idle';
      state.error = null;
    },
    setStatus(state, action: PayloadAction<ChatStatus>) {
      state.status = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
      if (action.payload) state.status = 'error';
    },
    clearError(state) {
      state.error = null;
      if (state.status === 'error') state.status = 'idle';
    },
    resetChat() {
      return initialState;
    },
    loadHistory(
      state,
      action: PayloadAction<{ sessionId: string; messages: ChatMessage[]; orgId?: string | null }>,
    ) {
      state.sessionId = action.payload.sessionId;
      state.sessionOrgId = action.payload.orgId ?? null;
      state.messages = action.payload.messages;
      state.streamingMessageId = null;
      state.inFlightTool = null;
      state.status = 'idle';
      state.error = null;
    },
    /**
     * Replace the transcript with the server's persisted rows for a turn whose
     * live stream was lost (app suspended, socket dropped during an approval).
     * The server keeps running the turn and writing rows regardless, so this
     * is the phone catching up. `complete: false` keeps the streaming pulse
     * and the RUNNING caption on the last assistant row so the UI reads as
     * "still working" rather than "silently finished with a stub".
     */
    reconcileHistory(
      state,
      action: PayloadAction<{ sessionId: string; messages: ChatMessage[]; complete: boolean; orgId?: string | null }>,
    ) {
      // Same chat: an absent org keeps the one already known.
      if (action.payload.orgId) state.sessionOrgId = action.payload.orgId;
      state.sessionId = action.payload.sessionId;
      state.messages = action.payload.messages;
      state.error = null;
      const last = state.messages[state.messages.length - 1];
      if (action.payload.complete || !last || last.role !== 'assistant') {
        state.streamingMessageId = null;
        state.inFlightTool = null;
        state.status = action.payload.complete ? 'idle' : 'streaming';
        return;
      }
      last.isStreaming = true;
      state.streamingMessageId = last.id;
      const running = last.toolEvents.find((t) => t.state === 'started');
      state.inFlightTool = running
        ? { toolUseId: running.toolUseId, toolName: running.toolName, input: running.input }
        : null;
      state.status = 'streaming';
    },
  },
});

export const {
  sessionCreated,
  addUserMessage,
  addPendingAssistantMessage,
  assistantMessageStarted,
  appendDelta,
  setInFlightTool,
  appendToolEvent,
  planProposed,
  planInput,
  planStreamEvent,
  planDecision,
  planNoLongerPending,
  finishAssistantMessage,
  failAssistantMessage,
  setTurnModel,
  discardTurn,
  setStatus,
  setError,
  clearError,
  resetChat,
  loadHistory,
  reconcileHistory,
} = aiChatSlice.actions;

export default aiChatSlice.reducer;
