import { describe, expect, it } from 'vitest';

import reducer, {
  reconcileHistory,
  setInFlightTool,
  addPendingAssistantMessage,
  addUserMessage,
  appendDelta,
  appendToolEvent,
  discardTurn,
  failAssistantMessage,
  finishAssistantMessage,
  loadHistory,
  resetChat,
  sessionCreated,
  planDecision,
  planNoLongerPending,
  planProposed,
  planStreamEvent,
  setTurnModel,
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
  sessionOrgId: null,
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
      sessionOrgId: 'org-old',
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
    // No org on the payload: the old chat's org must not linger.
    expect(next.sessionOrgId).toBeNull();
  });

  it("tracks the open chat's org from create, history load and catch-up", () => {
    let s = reducer(INITIAL, sessionCreated({ sessionId: 's1', orgId: 'org-a' }));
    expect(s.sessionOrgId).toBe('org-a');
    s = reducer(s, loadHistory({ sessionId: 's2', messages: [], orgId: 'org-b' }));
    expect(s.sessionOrgId).toBe('org-b');
    s = reducer(s, reconcileHistory({ sessionId: 's2', messages: [], complete: true, orgId: 'org-c' }));
    expect(s.sessionOrgId).toBe('org-c');
    s = reducer(s, resetChat());
    expect(s.sessionOrgId).toBeNull();
  });

  it('resetChat returns to initial state', () => {
    let s = reducer(INITIAL, addUserMessage({ id: 'u1', content: 'hi', sentAt: 't' }));
    s = reducer(s, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, resetChat());
    expect(s).toEqual(INITIAL);
  });
});

describe('reconcileHistory', () => {
  const started = { toolUseId: 't1', toolName: 'manage_services', state: 'started' as const };

  it('keeps the turn streaming with the running tool captioned when incomplete', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'local-a', sentAt: 't' }));
    s = reducer(
      s,
      reconcileHistory({
        sessionId: 's1',
        messages: [
          { id: 'u1', role: 'user', content: 'restart spooler', sentAt: 't' },
          { id: 'a1', role: 'assistant', content: '', toolEvents: [started], sentAt: 't', isStreaming: false },
        ],
        complete: false,
      }),
    );
    expect(s.sessionId).toBe('s1');
    expect(s.status).toBe('streaming');
    expect(s.streamingMessageId).toBe('a1');
    expect(s.inFlightTool).toEqual({ toolUseId: 't1', toolName: 'manage_services' });
    const last = s.messages[s.messages.length - 1];
    expect(last.role === 'assistant' && last.isStreaming).toBe(true);
    // The local placeholder is replaced by the server transcript, not appended to.
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('settles to idle when the transcript is complete', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'local-a', sentAt: 't' }));
    s = reducer(s, setInFlightTool({ toolUseId: 't1', toolName: 'manage_services' }));
    s = reducer(
      s,
      reconcileHistory({
        sessionId: 's1',
        messages: [
          { id: 'u1', role: 'user', content: 'restart spooler', sentAt: 't' },
          { id: 'a1', role: 'assistant', content: 'Done.', toolEvents: [{ ...started, state: 'completed' }], sentAt: 't', isStreaming: false },
        ],
        complete: true,
      }),
    );
    expect(s.status).toBe('idle');
    expect(s.streamingMessageId).toBeNull();
    expect(s.inFlightTool).toBeNull();
    expect(s.error).toBeNull();
  });
});

describe('aiChatSlice action plans', () => {
  const STEPS = [
    { toolName: 'manage_services', input: {}, reasoning: 'Restart', status: 'pending' },
    { toolName: 'run_script', input: {}, reasoning: 'Clear', status: 'pending' },
  ];

  function streaming(): AiChatState {
    return reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 'now' }));
  }

  function planOf(s: AiChatState) {
    const msg = s.messages.find((m) => m.id === 'a1');
    return msg && msg.role === 'assistant' ? msg.plan : undefined;
  }

  it('planProposed + plan_approval_required build an awaiting plan on the streaming message', () => {
    let s = reducer(streaming(), planProposed({ messageId: 'a1', toolUseId: 'tu-plan' }));
    expect(planOf(s)).toMatchObject({ toolUseId: 'tu-plan', status: 'awaiting', steps: [] });
    s = reducer(s, planStreamEvent({
      messageId: 'a1',
      event: { type: 'plan_approval_required', planId: 'plan-1', steps: STEPS },
    }));
    expect(planOf(s)).toMatchObject({ toolUseId: 'tu-plan', planId: 'plan-1', status: 'awaiting' });
    expect(planOf(s)?.steps).toHaveLength(2);
  });

  it('step events find the plan by planId even when the messageId is stale', () => {
    let s = reducer(streaming(), planStreamEvent({
      messageId: 'a1',
      event: { type: 'plan_approval_required', planId: 'plan-1', steps: STEPS },
    }));
    s = reducer(s, planDecision({ messageId: 'a1', decision: 'approved' }));
    s = reducer(s, planStreamEvent({
      messageId: 'other',
      event: { type: 'plan_step_complete', planId: 'plan-1', stepIndex: 0, isError: false },
    }));
    expect(planOf(s)?.status).toBe('executing');
    expect(planOf(s)?.steps[0]?.status).toBe('completed');
  });

  it('planDecision rejected and planNoLongerPending settle the plan', () => {
    const base = reducer(streaming(), planStreamEvent({
      messageId: 'a1',
      event: { type: 'plan_approval_required', planId: 'plan-1', steps: STEPS },
    }));
    expect(planOf(reducer(base, planDecision({ messageId: 'a1', decision: 'rejected' })))?.status).toBe('rejected');
    expect(planOf(reducer(base, planNoLongerPending({ messageId: 'a1' })))?.status).toBe('expired');
  });

  it('the plan tool_result settles the plan through appendToolEvent', () => {
    let s = reducer(streaming(), appendToolEvent({
      messageId: 'a1',
      event: { toolUseId: 'tu-plan', toolName: 'propose_action_plan', state: 'started' },
    }));
    s = reducer(s, planProposed({ messageId: 'a1', toolUseId: 'tu-plan' }));
    s = reducer(s, appendToolEvent({
      messageId: 'a1',
      event: { toolUseId: 'tu-plan', toolName: 'tool', state: 'completed', output: { result: 'rejected' } },
    }));
    expect(planOf(s)?.status).toBe('rejected');
  });
});

describe('aiChatSlice model provenance (W05)', () => {
  const turnModel = {
    requestedModel: 'm', requestedDisplayName: 'Opus', servedModel: 'm', servedDisplayName: 'Opus',
    fallbackUsed: false, appliedOptions: { effort: 'high' as const }, fastDowngraded: false,
  };

  it('setTurnModel stamps what ran on that assistant message only', () => {
    let s = reducer(INITIAL, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, addPendingAssistantMessage({ id: 'a2', sentAt: 't' }));
    s = reducer(s, setTurnModel({ messageId: 'a2', turnModel }));
    const [a1, a2] = s.messages;
    expect(a1.role === 'assistant' && a1.turnModel).toBeFalsy();
    expect(a2.role === 'assistant' && a2.turnModel).toEqual(turnModel);
  });

  it('discardTurn drops the optimistic rows of a refused turn and returns to idle', () => {
    let s = reducer(INITIAL, addUserMessage({ id: 'u0', content: 'keep', sentAt: 't' }));
    s = reducer(s, addUserMessage({ id: 'u1', content: 'switch', sentAt: 't' }));
    s = reducer(s, addPendingAssistantMessage({ id: 'a1', sentAt: 't' }));
    s = reducer(s, setInFlightTool({ toolUseId: 't', toolName: 'x' }));
    s = reducer(s, discardTurn({ ids: ['u1', 'a1'] }));
    expect(s.messages.map((m) => m.id)).toEqual(['u0']);
    expect(s.streamingMessageId).toBeNull();
    expect(s.inFlightTool).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
  });
});
