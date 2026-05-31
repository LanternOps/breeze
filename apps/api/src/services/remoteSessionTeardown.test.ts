import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    activeRows: [] as Array<{ id: string; type: string; agentId: string | null }>,
    enumerateError: null as Error | null,
    updateError: null as Error | null,
  };

  return {
    state,
    revokeViewerSessionMock: vi.fn(async () => undefined),
    sendCommandToAgentMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    dbMock: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => {
              if (state.enumerateError) {
                throw state.enumerateError;
              }
              return Promise.resolve(state.activeRows);
            }),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => {
            if (state.updateError) {
              throw state.updateError;
            }
            return Promise.resolve(undefined);
          }),
        })),
      })),
    },
  };
});

vi.mock('../db', () => ({
  db: mocks.dbMock,
  runOutsideDbContext: vi.fn((fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remote_sessions.id',
    type: 'remote_sessions.type',
    deviceId: 'remote_sessions.device_id',
    userId: 'remote_sessions.user_id',
    status: 'remote_sessions.status',
  },
  devices: {
    id: 'devices.id',
    agentId: 'devices.agent_id',
  },
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: mocks.sendCommandToAgentMock,
}));

vi.mock('./viewerTokenRevocation', () => ({
  revokeViewerSession: mocks.revokeViewerSessionMock,
}));

vi.mock('./sentry', () => ({
  captureException: mocks.captureExceptionMock,
}));

import { sendCommandToAgent } from '../routes/agentWs';
import { revokeViewerSession } from './viewerTokenRevocation';
import { captureException } from './sentry';
import { TEARDOWN_FAILED, terminateUserRemoteSessions } from './remoteSessionTeardown';

describe('terminateUserRemoteSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeRows = [];
    mocks.state.enumerateError = null;
    mocks.state.updateError = null;
  });

  it('returns the active-session count, revokes each viewer session, and stops desktop sessions with agents', async () => {
    mocks.state.activeRows = [
      { id: 'session-1', type: 'desktop', agentId: 'agent-1' },
      { id: 'session-2', type: 'terminal', agentId: 'agent-2' },
      { id: 'session-3', type: 'desktop', agentId: null },
    ];

    const result = await terminateUserRemoteSessions('user-1');

    expect(result).toBe(3);
    expect(revokeViewerSession).toHaveBeenCalledTimes(3);
    expect(revokeViewerSession).toHaveBeenCalledWith('session-1');
    expect(revokeViewerSession).toHaveBeenCalledWith('session-2');
    expect(revokeViewerSession).toHaveBeenCalledWith('session-3');
    expect(sendCommandToAgent).toHaveBeenCalledTimes(1);
    expect(sendCommandToAgent).toHaveBeenCalledWith('agent-1', {
      id: 'desk-stop-session-1',
      type: 'stop_desktop',
      payload: { sessionId: 'session-1' },
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('returns TEARDOWN_FAILED, reports to Sentry, and skips per-row teardown when enumerate/disconnect throws', async () => {
    const error = new Error('database unavailable');
    mocks.state.enumerateError = error;
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await terminateUserRemoteSessions('user-1');

      expect(result).toBe(TEARDOWN_FAILED);
      expect(result).toBe(-1);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(error);
      expect(revokeViewerSession).not.toHaveBeenCalled();
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('returns 0 when there are no active sessions', async () => {
    mocks.state.activeRows = [];

    const result = await terminateUserRemoteSessions('user-1');

    expect(result).toBe(0);
    expect(revokeViewerSession).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
