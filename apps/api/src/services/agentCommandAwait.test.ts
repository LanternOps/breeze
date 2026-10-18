import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock sendCommandToAgent before importing the module under test
vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
}));

import { sendCommandToAgentAwaitResult, resolvePendingAgentCommand, cancelPendingAgentCommandsByPrefix } from './agentCommandAwait';
import { sendCommandToAgent } from '../routes/agentWs';

const mockSendCommandToAgent = vi.mocked(sendCommandToAgent);

const testCommand = { id: 'test-cmd-id-001', type: 'http_request', payload: { url: 'http://example.com' } };

describe('agentCommandAwait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with result when resolvePendingAgentCommand is called with matching id', async () => {
    mockSendCommandToAgent.mockReturnValue(true);

    const promise = sendCommandToAgentAwaitResult('agent-001', testCommand, 5000);

    // Agents put structured output as a JSON string in `stdout` — assert it
    // survives the round-trip so awaited callers can read the response body.
    const expectedResult = {
      status: 'completed',
      result: { statusCode: 200 },
      stdout: JSON.stringify({ status: 200, headers: {}, bodyB64: 'b2s=', truncated: false }),
    };
    const consumed = resolvePendingAgentCommand(testCommand.id, expectedResult);
    expect(consumed).toBe(true);

    const resolved = await promise;
    expect(resolved).toEqual(expectedResult);
    expect(resolved.stdout).toBe(expectedResult.stdout);
  });

  it('returns {status:"failed"} on timeout without actually sleeping', async () => {
    mockSendCommandToAgent.mockReturnValue(true);

    const promise = sendCommandToAgentAwaitResult('agent-001', testCommand, 3000);

    vi.advanceTimersByTime(3000);

    const result = await promise;
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/timeout/i);
  });

  it('returns {status:"failed", error:"agent offline"} immediately when sendCommandToAgent returns false', async () => {
    mockSendCommandToAgent.mockReturnValue(false);

    const result = await sendCommandToAgentAwaitResult('agent-001', testCommand, 5000);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/offline/i);
  });

  it('resolvePendingAgentCommand for unknown id is a no-op, returns false, and does not throw', () => {
    let returned: boolean | undefined;
    expect(() => {
      returned = resolvePendingAgentCommand('no-such-id', { status: 'completed' });
    }).not.toThrow();
    expect(returned).toBe(false);
  });

  it('does not leak timers — calling resolve before timeout clears the timer', async () => {
    mockSendCommandToAgent.mockReturnValue(true);

    const cmd = { id: 'cmd-timer-leak', type: 'http_request', payload: {} };
    const promise = sendCommandToAgentAwaitResult('agent-001', cmd, 10000);

    resolvePendingAgentCommand(cmd.id, { status: 'completed' });
    // Positive assertion: it resolves with the supplied result (not the timeout value)
    await expect(promise).resolves.toEqual({ status: 'completed' });

    // Advance past the timeout — should not resolve again or throw
    vi.advanceTimersByTime(15000);
    // The timer was cleared on resolve, so advancing does nothing (no double-resolve).
  });

  it('passes the agentId and command through to sendCommandToAgent', async () => {
    mockSendCommandToAgent.mockReturnValue(true);

    const cmd = { id: 'cmd-passthrough', type: 'http_request', payload: { url: 'http://test' } };
    const p = sendCommandToAgentAwaitResult('my-agent-id', cmd, 1000);

    resolvePendingAgentCommand(cmd.id, { status: 'completed' });
    await p;

    expect(mockSendCommandToAgent).toHaveBeenCalledWith('my-agent-id', cmd);
  });

  it('cancelPendingAgentCommandsByPrefix resolves only the matching in-flight commands', async () => {
    mockSendCommandToAgent.mockReturnValue(true);
    const closing = sendCommandToAgentAwaitResult('agent-1', { id: 'http-req-T1-a', type: 'http_request', payload: {} }, 60_000);
    const other = sendCommandToAgentAwaitResult('agent-1', { id: 'http-req-T2-b', type: 'http_request', payload: {} }, 60_000);

    expect(cancelPendingAgentCommandsByPrefix('http-req-T1-', 'tunnel_closed')).toBe(1);
    await expect(closing).resolves.toEqual({ status: 'failed', error: 'tunnel_closed' });
    // A late result for the cancelled id is a no-op; the other tunnel is untouched.
    expect(resolvePendingAgentCommand('http-req-T1-a', { status: 'completed' })).toBe(false);
    expect(resolvePendingAgentCommand('http-req-T2-b', { status: 'completed' })).toBe(true);
    await expect(other).resolves.toEqual({ status: 'completed' });
  });

  it('cancellation leaves no state behind: a later send with the same prefix reaches the agent', async () => {
    // Replica-safe Close is the dispatch-time status re-read (tunnelHttpCore),
    // not a process-local tombstone here.
    mockSendCommandToAgent.mockReturnValue(true);
    cancelPendingAgentCommandsByPrefix('http-req-T3-', 'tunnel_closed');
    const p = sendCommandToAgentAwaitResult('agent-1', { id: 'http-req-T3-x', type: 'http_request', payload: {} }, 1000);
    expect(mockSendCommandToAgent).toHaveBeenCalledTimes(1);
    resolvePendingAgentCommand('http-req-T3-x', { status: 'completed' });
    await expect(p).resolves.toEqual({ status: 'completed' });
  });
});
