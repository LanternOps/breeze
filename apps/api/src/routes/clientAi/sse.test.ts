import { describe, it, expect } from 'vitest';
import { CLIENT_AI_SSE_EVENTS, toClientSseEvent } from './sse';
import type { AiStreamEvent } from '@breeze/shared/types/ai';

describe('CLIENT_AI_SSE_EVENTS — pinned names (Plan 5 mirrors this list)', () => {
  it('exposes exactly the pinned event names', () => {
    expect(CLIENT_AI_SSE_EVENTS).toEqual([
      'message_delta', 'tool_request', 'tool_completed', 'turn_complete', 'session_error', 'ping',
    ]);
  });
});

describe('toClientSseEvent', () => {
  it('content_delta → message_delta { text }', () => {
    expect(toClientSseEvent({ type: 'content_delta', delta: 'Hello' })).toEqual({
      event: 'message_delta',
      data: JSON.stringify({ text: 'Hello' }),
    });
  });

  it('tool_request passes through with the pinned payload', () => {
    const out = toClientSseEvent({
      type: 'tool_request', toolUseId: 'tu-1', toolName: 'read_range',
      input: { address: 'A1' }, mutating: false,
    });
    expect(out!.event).toBe('tool_request');
    expect(JSON.parse(out!.data)).toEqual({
      toolUseId: 'tu-1', toolName: 'read_range', input: { address: 'A1' }, mutating: false,
    });
  });

  it('tool_completed carries status, redactions, blockReason', () => {
    const out = toClientSseEvent({
      type: 'tool_completed', toolUseId: 'tu-1', toolName: 'read_range', status: 'success',
      redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
    });
    expect(out!.event).toBe('tool_completed');
    expect(JSON.parse(out!.data)).toEqual({
      toolUseId: 'tu-1', toolName: 'read_range', status: 'success',
      redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
      blockReason: null,
    });
  });

  it('done → turn_complete with usage (null when absent)', () => {
    expect(toClientSseEvent({ type: 'done', usage: { inputTokens: 100, outputTokens: 50, costCents: 3 } })).toEqual({
      event: 'turn_complete',
      data: JSON.stringify({ usage: { inputTokens: 100, outputTokens: 50, costCents: 3 } }),
    });
    expect(toClientSseEvent({ type: 'done' })).toEqual({
      event: 'turn_complete',
      data: JSON.stringify({ usage: null }),
    });
  });

  it('error → session_error { message }', () => {
    expect(toClientSseEvent({ type: 'error', message: 'boom' })).toEqual({
      event: 'session_error',
      data: JSON.stringify({ message: 'boom' }),
    });
  });

  it('drops internal/technician events (no RMM leakage to the add-in)', () => {
    const internal: AiStreamEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      { type: 'message_end', inputTokens: 0, outputTokens: 5 },
      { type: 'tool_use_start', toolName: 'read_range', toolUseId: 'tu-1', input: {} },
      { type: 'title_updated', title: 'T' },
      { type: 'approval_mode_changed', mode: 'per_step' },
    ];
    for (const event of internal) {
      expect(toClientSseEvent(event)).toBeNull();
    }
  });
});
