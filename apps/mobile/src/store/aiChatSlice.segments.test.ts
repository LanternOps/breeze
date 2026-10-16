import { describe, expect, it } from 'vitest';

import type { ServerAiMessage } from '../services/aiChat';
import { historyToMessages } from '../screens/chat/historyAdapter';
import { turnIsLive } from '../screens/chat/turnState';
import reducer, {
  addPendingAssistantMessage,
  addUserMessage,
  appendDelta,
  appendToolEvent,
  assistantMessageStarted,
  failAssistantMessage,
  finishAssistantMessage,
  planInput,
  planProposed,
  planStreamEvent,
  setTurnModel,
  type AiChatState,
  type ChatMessage,
} from './aiChatSlice';

// #8888: one reply turn is several model messages (text -> tool_use, then the
// tool result, then the next message). The server persists one assistant row
// per message; live streaming must produce the same shape, or adjacent text
// runs together ("ones.I acknowledged") and lands on the wrong side of a
// plan card relative to a history reload.

const INITIAL: AiChatState = {
  sessionId: 's1',
  messages: [],
  streamingMessageId: null,
  inFlightTool: null,
  status: 'idle',
  error: null,
  sessionOrgId: null,
};

const T = 'm-1-a';
const SENT = '2026-10-16T00:00:00Z';
const PLAN_INPUT = { title: 'Acknowledge alerts', steps: [{ toolName: 'manage_alerts', reasoning: 'ack' }] };

type LiveEvent =
  | { type: 'message_start' }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_use_start'; toolUseId: string; toolName: string }
  | { type: 'tool_use_input'; toolUseId: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: unknown }
  | { type: 'plan_approval_required'; planId: string; steps: unknown }
  | { type: 'done' };

// The same dispatches HomeScreen's `onEvent` makes, addressed by the turn id.
function play(state: AiChatState, events: LiveEvent[]): AiChatState {
  let s = state;
  for (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        s = reducer(s, assistantMessageStarted({ turnId: T, sentAt: SENT }));
        break;
      case 'content_delta':
        s = reducer(s, appendDelta({ id: T, delta: ev.delta }));
        break;
      case 'tool_use_start':
        s = reducer(s, appendToolEvent({
          messageId: T,
          event: { toolUseId: ev.toolUseId, toolName: ev.toolName, state: 'started' },
        }));
        if (ev.toolName === 'propose_action_plan') {
          s = reducer(s, planProposed({ messageId: T, toolUseId: ev.toolUseId }));
        }
        break;
      case 'tool_use_input':
        s = reducer(s, planInput({ messageId: T, toolUseId: ev.toolUseId, input: ev.input }));
        break;
      case 'tool_result':
        s = reducer(s, appendToolEvent({
          messageId: T,
          event: { toolUseId: ev.toolUseId, toolName: 'tool', state: 'completed', output: ev.output, isError: false },
        }));
        break;
      case 'plan_approval_required':
        s = reducer(s, planStreamEvent({ messageId: T, event: ev }));
        break;
      case 'done':
        s = reducer(s, finishAssistantMessage({ id: T, failIfEmpty: { error: 'No reply. Tap to retry.' } }));
        break;
    }
  }
  return s;
}

function startTurn(): AiChatState {
  let s = reducer(INITIAL, addUserMessage({ id: 'u1', content: 'ack the open alerts one at a time', sentAt: SENT }));
  s = reducer(s, addPendingAssistantMessage({ id: T, sentAt: SENT }));
  return s;
}

const LIVE: LiveEvent[] = [
  { type: 'message_start' },
  { type: 'content_delta', delta: "I'll list the open " },
  { type: 'content_delta', delta: 'alerts first.' },
  { type: 'tool_use_start', toolUseId: 'tu1', toolName: 'list_alerts' },
  { type: 'tool_result', toolUseId: 'tu1', output: { alerts: [] } },
  { type: 'message_start' },
  { type: 'tool_use_start', toolUseId: 'tu2', toolName: 'propose_action_plan' },
  { type: 'tool_use_input', toolUseId: 'tu2', input: PLAN_INPUT },
  { type: 'plan_approval_required', planId: 'p1', steps: PLAN_INPUT.steps },
  { type: 'tool_result', toolUseId: 'tu2', output: { result: 'approved' } },
  { type: 'message_start' },
  { type: 'content_delta', delta: 'Acknowledged the first two ones.' },
  { type: 'tool_use_start', toolUseId: 'tu3', toolName: 'manage_alerts' },
  { type: 'tool_result', toolUseId: 'tu3', output: { ok: true } },
  { type: 'message_start' },
  { type: 'content_delta', delta: 'I acknowledged the rest.' },
  { type: 'done' },
];

function row(r: Partial<ServerAiMessage> & Pick<ServerAiMessage, 'id' | 'role'>): ServerAiMessage {
  return { content: null, toolName: null, toolUseId: null, toolInput: null, toolOutput: null, createdAt: SENT, ...r };
}

// What the server persisted for the same turn (one assistant row per model message).
const HISTORY: ServerAiMessage[] = [
  row({ id: 'u1', role: 'user', content: 'ack the open alerts one at a time' }),
  row({ id: 'r1', role: 'assistant', content: "I'll list the open alerts first." }),
  row({ id: 'r2', role: 'tool_use', toolUseId: 'tu1', toolName: 'list_alerts' }),
  row({ id: 'r3', role: 'tool_result', toolUseId: 'tu1', toolName: 'list_alerts', toolOutput: { alerts: [] } }),
  row({ id: 'r4', role: 'assistant', content: null }),
  row({ id: 'r5', role: 'tool_use', toolUseId: 'tu2', toolName: 'propose_action_plan', toolInput: PLAN_INPUT }),
  row({ id: 'r6', role: 'tool_result', toolUseId: 'tu2', toolName: 'propose_action_plan', toolOutput: { result: 'approved' } }),
  row({ id: 'r7', role: 'assistant', content: 'Acknowledged the first two ones.' }),
  row({ id: 'r8', role: 'tool_use', toolUseId: 'tu3', toolName: 'manage_alerts' }),
  row({ id: 'r9', role: 'tool_result', toolUseId: 'tu3', toolName: 'manage_alerts', toolOutput: { ok: true } }),
  row({ id: 'r10', role: 'assistant', content: 'I acknowledged the rest.' }),
];

// The render-relevant shape: which text, tools and plan sit in which row, in order.
function shape(messages: ChatMessage[]) {
  return messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content }
      : {
          role: 'assistant',
          content: m.content,
          tools: m.toolEvents.map((t) => `${t.toolUseId}:${t.state}`),
          plan: m.plan ? `${m.plan.toolUseId}:${m.plan.title}` : null,
          streaming: m.isStreaming,
        },
  );
}

describe('aiChatSlice — one assistant row per model message (#8888)', () => {
  it('live streaming produces the same rows, in the same order, as a history reload', () => {
    const live = play(startTurn(), LIVE);
    expect(shape(live.messages)).toEqual(shape(historyToMessages(HISTORY)));
  });

  it('never concatenates text from two model messages', () => {
    const live = play(startTurn(), LIVE);
    const texts = live.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(texts).toEqual(["I'll list the open alerts first.", '', 'Acknowledged the first two ones.', 'I acknowledged the rest.']);
    expect(texts.some((t) => t.includes('ones.I'))).toBe(false);
  });

  it('keeps one row per message, so the opening sentence sits above the plan card', () => {
    const live = play(startTurn(), LIVE);
    const assistants = live.messages.filter((m) => m.role === 'assistant');
    const sentence = assistants.findIndex((m) => m.content.startsWith("I'll list"));
    const plan = assistants.findIndex((m) => m.plan);
    expect(sentence).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(sentence);
  });

  it('streams into the newest row and points streamingMessageId at it', () => {
    let s = play(startTurn(), LIVE.slice(0, 12));
    const last = s.messages[s.messages.length - 1];
    expect(last.role === 'assistant' && last.isStreaming).toBe(true);
    expect(s.streamingMessageId).toBe(last.id);
    expect(last.id).not.toBe(T);
    // Earlier rows of the turn stop pulsing once the next message begins.
    const earlier = s.messages.filter((m) => m.role === 'assistant' && m.id !== last.id);
    expect(earlier.every((m) => m.role === 'assistant' && !m.isStreaming)).toBe(true);
    s = play(s, [{ type: 'done' }]);
    expect(s.streamingMessageId).toBeNull();
    expect(s.status).toBe('idle');
  });

  it('a message_start before any output reuses the pending row', () => {
    const s = play(startTurn(), [{ type: 'message_start' }, { type: 'content_delta', delta: 'Hi.' }]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].id).toBe(T);
    expect(s.messages[1].content).toBe('Hi.');
  });

  it('drops an empty trailing row at done instead of failing the turn', () => {
    const s = play(startTurn(), [
      { type: 'message_start' },
      { type: 'content_delta', delta: 'Done.' },
      { type: 'message_start' },
      { type: 'done' },
    ]);
    const assistants = s.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: 'Done.', isStreaming: false });
    expect(assistants[0].role === 'assistant' && assistants[0].failed).toBeFalsy();
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
  });

  it('still fails a turn that produced nothing at all', () => {
    const s = play(startTurn(), [{ type: 'message_start' }, { type: 'done' }]);
    const last = s.messages[s.messages.length - 1];
    expect(last.role === 'assistant' && last.failed).toBe(true);
    expect(s.status).toBe('error');
  });

  it('a stream error marks the live row failed and stops every row of the turn', () => {
    let s = play(startTurn(), LIVE.slice(0, 7));
    s = reducer(s, failAssistantMessage({ id: T, error: 'boom' }));
    const assistants = s.messages.filter((m) => m.role === 'assistant');
    expect(assistants.every((m) => m.role === 'assistant' && !m.isStreaming)).toBe(true);
    const last = assistants[assistants.length - 1];
    expect(last.role === 'assistant' && last.failed).toBe(true);
    expect(s.streamingMessageId).toBeNull();
  });

  it('a late tool_result lands on the row that holds its tool call', () => {
    const s = play(startTurn(), [
      { type: 'message_start' },
      { type: 'tool_use_start', toolUseId: 'tu1', toolName: 'list_alerts' },
      { type: 'message_start' },
      { type: 'content_delta', delta: 'Next.' },
      { type: 'tool_result', toolUseId: 'tu1', output: { alerts: [] } },
    ]);
    const [first, second] = s.messages.filter((m) => m.role === 'assistant');
    expect(first.role === 'assistant' && first.toolEvents.map((t) => t.state)).toEqual(['completed']);
    expect(second.role === 'assistant' && second.toolEvents).toEqual([]);
  });

  it('the turn model lands on the last row, as a history reload puts it', () => {
    let s = play(startTurn(), LIVE.slice(0, -1));
    const turnModel = { servedDisplayName: 'M' } as never;
    s = reducer(s, setTurnModel({ messageId: T, turnModel }));
    const assistants = s.messages.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.role === 'assistant' && m.turnModel !== undefined)).toEqual([false, false, false, true]);
  });
});

describe('turnIsLive (#8888)', () => {
  it('is true for an earlier row of a turn that is still streaming, so its plan card keeps its controls', () => {
    const s = play(startTurn(), LIVE.slice(0, 12));
    const planIndex = s.messages.findIndex((m) => m.role === 'assistant' && m.plan);
    const planRow = s.messages[planIndex];
    expect(planRow.role === 'assistant' && planRow.isStreaming).toBe(false);
    expect(turnIsLive(s.messages, planIndex)).toBe(true);
  });

  it('is false once the turn finished, and for rows of an earlier turn', () => {
    const done = play(startTurn(), LIVE);
    const planIndex = done.messages.findIndex((m) => m.role === 'assistant' && m.plan);
    expect(turnIsLive(done.messages, planIndex)).toBe(false);

    let s = reducer(done, addUserMessage({ id: 'u2', content: 'again', sentAt: SENT }));
    s = reducer(s, addPendingAssistantMessage({ id: 'm-2-a', sentAt: SENT }));
    expect(turnIsLive(s.messages, planIndex)).toBe(false);
    expect(turnIsLive(s.messages, s.messages.length - 1)).toBe(true);
  });
});
