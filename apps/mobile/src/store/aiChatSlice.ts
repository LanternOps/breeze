import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type ChatStatus = 'idle' | 'creating-session' | 'streaming' | 'error';

export interface ToolEvent {
  toolUseId: string;
  toolName: string;
  state: 'started' | 'completed';
  output?: unknown;
  isError?: boolean;
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
    };

export interface AiChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  // The id of the assistant message currently being streamed (if any).
  // Lets the UI render a streaming pulse on the right row without scanning.
  streamingMessageId: string | null;
  // Tracks the in-flight tool name for the mid-stream caption ("CHECKING FLEET").
  inFlightTool: { toolUseId: string; toolName: string } | null;
  status: ChatStatus;
  error: string | null;
}

const initialState: AiChatState = {
  sessionId: null,
  messages: [],
  streamingMessageId: null,
  inFlightTool: null,
  status: 'idle',
  error: null,
};

const aiChatSlice = createSlice({
  name: 'aiChat',
  initialState,
  reducers: {
    sessionCreated(state, action: PayloadAction<{ sessionId: string }>) {
      state.sessionId = action.payload.sessionId;
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
    appendDelta(state, action: PayloadAction<{ id: string; delta: string }>) {
      const msg = state.messages.find((m) => m.id === action.payload.id);
      if (msg && msg.role === 'assistant') {
        msg.content += action.payload.delta;
      }
    },
    setInFlightTool(state, action: PayloadAction<{ toolUseId: string; toolName: string } | null>) {
      state.inFlightTool = action.payload;
    },
    appendToolEvent(state, action: PayloadAction<{ messageId: string; event: ToolEvent }>) {
      const msg = state.messages.find((m) => m.id === action.payload.messageId);
      if (msg && msg.role === 'assistant') {
        const existing = msg.toolEvents.find((t) => t.toolUseId === action.payload.event.toolUseId);
        if (existing) {
          existing.state = action.payload.event.state;
          if (action.payload.event.output !== undefined) existing.output = action.payload.event.output;
          if (action.payload.event.isError !== undefined) existing.isError = action.payload.event.isError;
        } else {
          msg.toolEvents.push(action.payload.event);
        }
      }
    },
    finishAssistantMessage(
      state,
      action: PayloadAction<{ id: string; failIfEmpty?: { error: string } }>,
    ) {
      const msg = state.messages.find((m) => m.id === action.payload.id);
      if (msg && msg.role === 'assistant') {
        const empty = !msg.content && msg.toolEvents.length === 0;
        if (empty && action.payload.failIfEmpty) {
          msg.isStreaming = false;
          msg.failed = true;
          state.status = 'error';
          state.error = action.payload.failIfEmpty.error;
        } else {
          msg.isStreaming = false;
          if (state.status !== 'error') state.status = 'idle';
        }
      }
      if (state.streamingMessageId === action.payload.id) {
        state.streamingMessageId = null;
      }
      state.inFlightTool = null;
    },
    failAssistantMessage(state, action: PayloadAction<{ id: string; error: string }>) {
      const msg = state.messages.find((m) => m.id === action.payload.id);
      if (msg && msg.role === 'assistant') {
        msg.isStreaming = false;
        msg.failed = true;
      }
      if (state.streamingMessageId === action.payload.id) {
        state.streamingMessageId = null;
      }
      state.inFlightTool = null;
      state.status = 'error';
      state.error = action.payload.error;
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
      action: PayloadAction<{ sessionId: string; messages: ChatMessage[] }>,
    ) {
      state.sessionId = action.payload.sessionId;
      state.messages = action.payload.messages;
      state.streamingMessageId = null;
      state.inFlightTool = null;
      state.status = 'idle';
      state.error = null;
    },
  },
});

export const {
  sessionCreated,
  addUserMessage,
  addPendingAssistantMessage,
  appendDelta,
  setInFlightTool,
  appendToolEvent,
  finishAssistantMessage,
  failAssistantMessage,
  setStatus,
  setError,
  clearError,
  resetChat,
  loadHistory,
} = aiChatSlice.actions;

export default aiChatSlice.reducer;
