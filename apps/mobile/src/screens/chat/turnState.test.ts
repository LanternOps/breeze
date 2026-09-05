import { describe, expect, it } from 'vitest';

import type { ChatMessage, ToolEvent } from '../../store/aiChatSlice';
import { inFlightToolOf, isStreamLostError, isTurnComplete, isTurnSettlingError } from './turnState';

const user = (id: string): ChatMessage => ({ id, role: 'user', content: 'hi', sentAt: 't' });
const assistant = (id: string, content: string, toolEvents: ToolEvent[] = []): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  toolEvents,
  sentAt: 't',
  isStreaming: false,
});

describe('isTurnComplete', () => {
  it('is false for an empty transcript', () => {
    expect(isTurnComplete([])).toBe(false);
  });

  it('is false when the last row is the user message (no reply yet)', () => {
    expect(isTurnComplete([user('u1')])).toBe(false);
  });

  it('is false while a tool_use has no tool_result', () => {
    const msgs = [user('u1'), assistant('a1', '', [{ toolUseId: 't1', toolName: 'execute_command', state: 'started' }])];
    expect(isTurnComplete(msgs)).toBe(false);
    expect(inFlightToolOf(msgs)).toEqual({ toolUseId: 't1', toolName: 'execute_command' });
  });

  it('is false for an assistant row with neither text nor tools', () => {
    expect(isTurnComplete([user('u1'), assistant('a1', '')])).toBe(false);
  });

  it('is true once the tool completed and text landed', () => {
    const msgs = [
      user('u1'),
      assistant('a1', 'Restarted the Spooler.', [{ toolUseId: 't1', toolName: 'manage_services', state: 'completed' }]),
    ];
    expect(isTurnComplete(msgs)).toBe(true);
    expect(inFlightToolOf(msgs)).toBeNull();
  });

  it('is true for a tools-only completed turn', () => {
    expect(
      isTurnComplete([user('u1'), assistant('a1', '', [{ toolUseId: 't1', toolName: 'x', state: 'completed' }])]),
    ).toBe(true);
  });
});

describe('error classifiers', () => {
  it('recognises the 409 settle-race text', () => {
    expect(isTurnSettlingError('The assistant is wrapping up the previous turn — please try again in a moment')).toBe(true);
    expect(isTurnSettlingError('HTTP 500')).toBe(false);
  });

  it('treats a dropped socket or open-timeout as stream-lost, not failed', () => {
    expect(isStreamLostError(new Error('Network error'))).toBe(true);
    const timeout = new Error('Request timed out after 15000ms');
    timeout.name = 'FetchTimeoutError';
    expect(isStreamLostError(timeout)).toBe(true);
    expect(isStreamLostError(new Error('HTTP 401'))).toBe(false);
  });
});
