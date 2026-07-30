import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/agentCommandAwait', () => ({
  sendCommandToAgentAwaitResult: vi.fn(),
}));

import { parseLiveSessionsStdout } from './sessions';

describe('live sessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses and validates agent stdout', () => {
    const stdout = JSON.stringify({
      sessions: [
        { sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: 7 },
        { sessionId: 1, username: 'bob', state: 'disconnected', type: 'rdp', helperConnected: false },
      ],
    });
    const sessions = parseLiveSessionsStdout(stdout);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!).toEqual({ sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: 7 });
    expect(sessions[1]!.idleMinutes).toBeNull();
  });

  it('drops malformed entries instead of failing the request', () => {
    const stdout = JSON.stringify({ sessions: [{ sessionId: 99999999, username: 'x' }, { sessionId: 2, username: 'ok', state: 'active', type: 'console' }] });
    const sessions = parseLiveSessionsStdout(stdout);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe(2);
  });

  it('returns [] on unparseable stdout', () => {
    expect(parseLiveSessionsStdout('not-json')).toEqual([]);
    expect(parseLiveSessionsStdout(undefined)).toEqual([]);
  });
});
