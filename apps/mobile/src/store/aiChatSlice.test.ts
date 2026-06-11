import { describe, expect, it } from 'vitest';

import reducer, {
  addPendingAssistantMessage,
  addUserMessage,
  appendDelta,
  appendToolEvent,
  failAssistantMessage,
  finishAssistantMessage,
  loadHistory,
  resetChat,
  type AiChatState,
  type ChatMessage,
} from './aiChatSlice';

const INITIAL: AiChatState = {
  sessionId: null,
  messages: [],
  streamingMessageId: null,
  inFlightTool: null,
  status: 'idle',
  error: null,
};

describe('aiChatSlice', () => {
  it('addUserMessage pushes a user-typed message', () => {
    const next = reducer(
      INITIAL,
      addUserMessage({ id: 'u1', content: 'hello', sentAt: '2026-05-07T00:00:00Z' }),
    );
    expect(next.messages).toHaveLength(1);
    const msg = next.messages[0];
    expect(msg.role).toBe('user');
    if (msg.role === 'user') {
      expect(msg.id).toBe('u1');
      expect(msg.content).toBe('hello');
      expect(msg.sentAt).toBe('2026-05-07T00:00:00Z');
    }
  });

  it('addPendingAssistantMessage pushes a streaming assistant placeholder', () => {
    const next = reducer(
      INITIAL,
      addPendingAssistantMessage({ id: 'a1', sentAt: '2026-05-07T00:00:01Z' }),
    );
    expect(next.messages).toHaveLength(1);
    const msg = next.messages[0];
    expect(msg.role).toBe('assistant');
    if (msg.role === 'assistant') {
      expect(msg.content).toBe('');
      expect(msg.toolEvents).toEqual([]);
      expect(msg.isStreaming).toBe(true);
    }
    expect(next.streamingMessageId).toBe('a1');
    expect(next.status).toBe('streaming');
    expect(next.error).toBeNull();
  });

  it('appendDelta concatenates onto the matching assistant message', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, appendDelta({ id: 'a1', delta: 'Hel' }));
    s = reducer(s, appendDelta({ id: 'a1', delta: 'lo' }));
    const msg = s.messages.find((m) => m.id === 'a1');
    expect(msg?.role).toBe('assistant');
    if (msg && msg.role === 'assistant') {
      expect(msg.content).toBe('Hello');
    }
  });

  it('appendDelta is a no-op when targeting an unknown id', () => {
    const s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    const next = reducer(s, appendDelta({ id: 'does-not-exist', delta: 'x' }));
    const msg = next.messages.find((m) => m.id === 'a1');
    if (msg && msg.role === 'assistant') {
      expect(msg.content).toBe('');
    }
  });

  it('appendToolEvent pushes a new event when toolUseId is unseen', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(
      s,
      appendToolEvent({
        messageId: 'a1',
        event: { toolUseId: 'tu1', toolName: 'list_devices', state: 'started' },
      }),
    );
    const msg = s.messages[0];
    if (msg.role === 'assistant') {
      expect(msg.toolEvents).toHaveLength(1);
      expect(msg.toolEvents[0]).toMatchObject({
        toolUseId: 'tu1',
        toolName: 'list_devices',
        state: 'started',
      });
    }
  });

  it('appendToolEvent merges by toolUseId — existing event is updated, not duplicated', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(
      s,
      appendToolEvent({
        messageId: 'a1',
        event: { toolUseId: 'tu1', toolName: 'list_devices', state: 'started' },
      }),
    );
    s = reducer(
      s,
      appendToolEvent({
        messageId: 'a1',
        event: {
          toolUseId: 'tu1',
          toolName: 'list_devices',
          state: 'completed',
          output: { count: 3 },
          isError: false,
        },
      }),
    );
    const msg = s.messages[0];
    if (msg.role === 'assistant') {
      expect(msg.toolEvents).toHaveLength(1);
      expect(msg.toolEvents[0].state).toBe('completed');
      expect(msg.toolEvents[0].output).toEqual({ count: 3 });
      expect(msg.toolEvents[0].isError).toBe(false);
    }
  });

  it('finishAssistantMessage with failIfEmpty flips an empty message to failed', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(
      s,
      finishAssistantMessage({ id: 'a1', failIfEmpty: { error: 'No content' } }),
    );
    const msg = s.messages[0];
    if (msg.role === 'assistant') {
      expect(msg.isStreaming).toBe(false);
      expect(msg.failed).toBe(true);
    }
    expect(s.streamingMessageId).toBeNull();
    expect(s.status).toBe('error');
    expect(s.error).toBe('No content');
    expect(s.inFlightTool).toBeNull();
  });

  it('finishAssistantMessage with content just clears streaming state', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, appendDelta({ id: 'a1', delta: 'done' }));
    s = reducer(
      s,
      finishAssistantMessage({ id: 'a1', failIfEmpty: { error: 'No content' } }),
    );
    const msg = s.messages[0];
    if (msg.role === 'assistant') {
      expect(msg.isStreaming).toBe(false);
      expect(msg.failed).toBeUndefined();
      expect(msg.content).toBe('done');
    }
    expect(s.streamingMessageId).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
  });

  it('finishAssistantMessage clears streaming state when no failIfEmpty was passed even on empty content', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, finishAssistantMessage({ id: 'a1' }));
    const msg = s.messages[0];
    if (msg.role === 'assistant') {
      expect(msg.isStreaming).toBe(false);
      expect(msg.failed).toBeUndefined();
    }
    expect(s.status).toBe('idle');
  });

  it('failAssistantMessage flips streaming + sets error', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, failAssistantMessage({ id: 'a1', error: 'boom' }));
    const msg = s.messages[0];
    if (msg.role === 'assistant') {
      expect(msg.isStreaming).toBe(false);
      expect(msg.failed).toBe(true);
    }
    expect(s.streamingMessageId).toBeNull();
    expect(s.inFlightTool).toBeNull();
    expect(s.status).toBe('error');
    expect(s.error).toBe('boom');
  });

  it('loadHistory replaces messages and clears streaming/in-flight state', () => {
    const dirty: AiChatState = {
      sessionId: 'old',
      messages: [
        {
          id: 'a-old',
          role: 'assistant',
          content: 'old',
          toolEvents: [],
          sentAt: 't',
          isStreaming: true,
        },
      ],
      streamingMessageId: 'a-old',
      inFlightTool: { toolUseId: 'tu', toolName: 'x' },
      status: 'streaming',
      error: 'previous',
    };
    const fresh: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', sentAt: 't' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'hello',
        toolEvents: [],
        sentAt: 't',
        isStreaming: false,
      },
    ];
    const next = reducer(dirty, loadHistory({ sessionId: 'sess-new', messages: fresh }));
    expect(next.sessionId).toBe('sess-new');
    expect(next.messages).toEqual(fresh);
    expect(next.streamingMessageId).toBeNull();
    expect(next.inFlightTool).toBeNull();
    expect(next.status).toBe('idle');
    expect(next.error).toBeNull();
  });

  it('resetChat returns to initial state', () => {
    let s = reducer(INITIAL, addUserMessage({ id: 'u1', content: 'hi', sentAt: 't' }));
    s = reducer(s, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, resetChat());
    expect(s).toEqual(INITIAL);
  });
});
