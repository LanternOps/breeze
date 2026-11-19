import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dispatchCommandToAgent,
  revokeViewerSession,
  captureMessage,
  captureException,
  terminalIntentSet,
  dbUpdate,
  dbSelect,
} = vi.hoisted(() => ({
  dispatchCommandToAgent: vi.fn(),
  revokeViewerSession: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  terminalIntentSet: vi.fn((write: Record<string, unknown>, phase: string) => ({ ...write, phase })),
  dbUpdate: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update: dbUpdate, select: dbSelect },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../db/schema', () => ({
  remoteSessions: { id: 'remoteSessions.id', status: 'remoteSessions.status' },
}));
vi.mock('./agentCommandRelay', () => ({ dispatchCommandToAgent }));
vi.mock('./viewerTokenRevocation', () => ({ revokeViewerSession }));
vi.mock('./sentry', () => ({ captureMessage, captureException }));
vi.mock('./remoteSessionTeardown', () => ({
  ACTIVE_REMOTE_SESSION_STATUSES: ['pending', 'connecting', 'active'],
}));
vi.mock('./remoteDesktopTerminalIntent', () => ({
  runTerminalWrite: vi.fn((write: () => Promise<unknown>) => write()),
  terminalIntentSet,
  toTerminalSessionRow: vi.fn((row: { terminalGeneration: bigint }) => ({ terminalGeneration: row.terminalGeneration })),
  buildStopDesktopCommand: vi.fn((sessionId: string, generation: bigint) => ({
    id: `desk-stop-${sessionId}-${generation}`,
    type: 'stop_desktop',
    payload: { sessionId, terminalGeneration: String(generation) },
  })),
}));

import { endRemoteSessionAsOperator } from './remoteSessionOperatorEnd';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = {
  id: SESSION_ID,
  type: 'desktop',
  startedAt: new Date(Date.now() - 60_000),
  createdAt: new Date(Date.now() - 90_000),
  bytesTransferred: 5n,
  recordingUrl: null,
};
const DEVICE = { id: 'device-1', agentId: 'agent-1' };
const ENDED_ROW = { id: SESSION_ID, status: 'disconnected', terminalGeneration: 3n };

function rigUpdate(rows: unknown[]) {
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
  });
  dbUpdate.mockReturnValueOnce({ set });
  return set;
}

function rigReread(rows: unknown[]) {
  dbSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  });
}

const run = (overrides: Partial<Parameters<typeof endRemoteSessionAsOperator>[0]> = {}) =>
  endRemoteSessionAsOperator({ session: SESSION as never, device: DEVICE, logTag: 'test', ...overrides });

describe('endRemoteSessionAsOperator (#11931)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeViewerSession.mockResolvedValue(undefined);
    dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  });

  it('records operator_ended through the terminal-intent contract, revokes the viewer and stops the agent', async () => {
    rigUpdate([ENDED_ROW]);

    const result = await run();

    expect(result).toMatchObject({ ok: true, updated: ENDED_ROW, terminalGeneration: 3n });
    expect(result.ok && result.viewerRevocationError).toBeFalsy();
    expect(terminalIntentSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disconnected', endReason: 'operator_ended', bytesTransferred: 5n }),
      'pending',
    );
    expect(revokeViewerSession).toHaveBeenCalledWith(SESSION_ID);
    expect(dispatchCommandToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'stop_desktop',
      payload: { sessionId: SESSION_ID, terminalGeneration: '3' },
    }));
  });

  it('keeps the caller-supplied bytes and recording URL', async () => {
    rigUpdate([ENDED_ROW]);
    await run({ bytesTransferred: 42, recordingUrl: '/recordings/1' });
    expect(terminalIntentSet).toHaveBeenCalledWith(
      expect.objectContaining({ bytesTransferred: 42n, recordingUrl: '/recordings/1' }),
      'pending',
    );
  });

  it('surfaces a failed viewer revocation and still stops the agent', async () => {
    rigUpdate([ENDED_ROW]);
    const failure = new Error('viewer session revocation unavailable');
    revokeViewerSession.mockRejectedValueOnce(failure);

    const result = await run();

    expect(result).toMatchObject({ ok: true, viewerRevocationError: failure });
    expect(dispatchCommandToAgent).toHaveBeenCalledTimes(1);
  });

  it('reports already_ended when another terminal writer won the race', async () => {
    rigUpdate([]);
    rigReread([{ status: 'failed' }]);

    await expect(run()).resolves.toEqual({ ok: false, reason: 'already_ended', status: 'failed' });
    expect(revokeViewerSession).not.toHaveBeenCalled();
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
  });

  it('reports not_found when the row is gone', async () => {
    rigUpdate([]);
    rigReread([]);
    await expect(run()).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('sends no desktop stop for a non-desktop session or a device with no agent', async () => {
    rigUpdate([ENDED_ROW]);
    await run({ session: { ...SESSION, type: 'terminal' } as never });
    rigUpdate([ENDED_ROW]);
    await run({ device: { id: 'device-1', agentId: null } });
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(revokeViewerSession).toHaveBeenCalledTimes(2);
  });
});
