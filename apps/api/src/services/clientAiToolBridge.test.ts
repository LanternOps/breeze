import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requestClientToolExecution,
  resolveClientToolResult,
  failPendingForSession,
  CLIENT_TOOL_TIMEOUT_MS,
  CLIENT_MUTATING_TOOL_TIMEOUT_MS,
  _pendingCountForTests,
} from './clientAiToolBridge';
import type { ActiveSession } from './streamingSessionManager';

function fakeSession(id: string) {
  const publish = vi.fn();
  return {
    session: { breezeSessionId: id, eventBus: { publish } } as unknown as ActiveSession,
    publish,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain anything a test left pending so timers don't leak across tests.
  failPendingForSession('sess-1');
  failPendingForSession('sess-2');
  vi.useRealTimers();
});

describe('requestClientToolExecution', () => {
  it('publishes the pinned tool_request event payload and resolves on resolveClientToolResult', async () => {
    const { session, publish } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-1', 'read_range', { address: 'A1:B2' }, false);

    expect(publish).toHaveBeenCalledWith({
      type: 'tool_request',
      toolUseId: 'tu-1',
      toolName: 'read_range',
      input: { address: 'A1:B2' },
      mutating: false,
    });

    expect(resolveClientToolResult('sess-1', 'tu-1', { status: 'success', output: { cells: [[1]] } })).toBe(true);
    await expect(p).resolves.toEqual({ status: 'success', output: { cells: [[1]] } });
    expect(_pendingCountForTests()).toBe(0);
  });

  it('rejects resolution from a different session (cross-session guard)', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-2', 'read_selection', {}, false);

    expect(resolveClientToolResult('sess-2', 'tu-2', { status: 'success', output: null })).toBe(false);
    expect(resolveClientToolResult('sess-1', 'tu-2', { status: 'error', output: { error: 'x' } })).toBe(true);
    await expect(p).resolves.toEqual({ status: 'error', output: { error: 'x' } });
  });

  it('returns false for unknown toolUseIds and for double resolution', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-3', 'read_selection', {}, false);
    expect(resolveClientToolResult('sess-1', 'nope', { status: 'success', output: null })).toBe(false);
    expect(resolveClientToolResult('sess-1', 'tu-3', { status: 'success', output: 1 })).toBe(true);
    expect(resolveClientToolResult('sess-1', 'tu-3', { status: 'success', output: 2 })).toBe(false);
    await p;
  });

  it('times out non-mutating tools after 60s with a timeout-error result', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-4', 'read_range', { address: 'A1' }, false);

    vi.advanceTimersByTime(CLIENT_TOOL_TIMEOUT_MS - 1);
    expect(_pendingCountForTests()).toBe(1);
    vi.advanceTimersByTime(1);

    const result = await p;
    expect(result.status).toBe('timeout');
    expect(JSON.stringify(result.output)).toContain('timed out');
    expect(_pendingCountForTests()).toBe(0);
  });

  it('gives mutating tools the 300s window (pending write approval in the task pane)', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-5', 'write_range', { address: 'A1', cells: [[1]] }, true);

    vi.advanceTimersByTime(CLIENT_TOOL_TIMEOUT_MS); // 60s: still pending
    expect(_pendingCountForTests()).toBe(1);
    vi.advanceTimersByTime(CLIENT_MUTATING_TOOL_TIMEOUT_MS - CLIENT_TOOL_TIMEOUT_MS);
    await expect(p).resolves.toMatchObject({ status: 'timeout' });
  });
});

describe('failPendingForSession', () => {
  it('fails every pending request of the session (and only that session)', async () => {
    const a = fakeSession('sess-1');
    const b = fakeSession('sess-2');
    const p1 = requestClientToolExecution(a.session, 'tu-6', 'read_range', {}, false);
    const p2 = requestClientToolExecution(b.session, 'tu-7', 'read_range', {}, false);

    expect(failPendingForSession('sess-1', 'session_closed')).toBe(1);
    await expect(p1).resolves.toEqual({ status: 'error', output: { error: 'session_closed' } });
    expect(_pendingCountForTests()).toBe(1);

    expect(resolveClientToolResult('sess-2', 'tu-7', { status: 'success', output: null })).toBe(true);
    await p2;
  });
});
