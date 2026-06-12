import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports, so all mock state they reference
// must live inside vi.hoisted() (not a module-level const).
//
// The service builds two chains off the same `db` mock:
//   UPDATE: db.update(t).set(v).where(c).returning(cols)  → disconnected rows
//   SELECT: db.select(cols).from(t).where(c)              → device agent rows
// Every builder method is fluent (returns the chain). The two terminals are
// `.returning()` (UPDATE) and the SECOND `.where()` call (SELECT). We disambiguate
// `.where()` by call count within a single terminateUserRemoteSessions() call:
// the 1st `.where()` belongs to the UPDATE (stay fluent so `.returning()` works);
// the 2nd belongs to the device SELECT (resolve `deviceRowsResult`).
const h = vi.hoisted(() => {
  const state = {
    whereCalls: 0,
    whereArgs: [] as any[],
    deviceRowsResult: [] as Array<{ id: string; agentId: string | null }>,
  };
  const chain: Record<string, any> = {};
  for (const m of ['update', 'set', 'select', 'from']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.where = vi.fn((arg: unknown) => {
    state.whereArgs.push(arg);
    state.whereCalls += 1;
    // 1st where() = UPDATE (fluent); 2nd+ = device SELECT terminal.
    return state.whereCalls >= 2 ? Promise.resolve(state.deviceRowsResult) : chain;
  });
  chain.returning = vi.fn();

  return {
    chain,
    state,
    sendCommandToAgent: vi.fn(),
    revokeViewerSession: vi.fn().mockResolvedValue(undefined),
    captureException: vi.fn(),
    // closeTerminalSession returns true when a live terminal socket existed on
    // THIS instance (and was closed, incl. its own terminal_stop). Default
    // false = not local, so the teardown falls back to signalling the agent.
    closeTerminalSession: vi.fn().mockReturnValue(false),
  };
});

// Capture drizzle operator calls as inspectable tagged objects so a test can
// assert WHICH status predicate the UPDATE targets (active-only vs ne-disconnected).
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
}));

vi.mock('../db', () => ({
  db: h.chain,
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remote_sessions.id',
    type: 'remote_sessions.type',
    deviceId: 'remote_sessions.device_id',
    userId: 'remote_sessions.user_id',
    status: 'remote_sessions.status',
    endedAt: 'remote_sessions.ended_at',
  },
  devices: { id: 'devices.id', agentId: 'devices.agent_id' },
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: (...args: unknown[]) => h.sendCommandToAgent(...args),
}));

vi.mock('./viewerTokenRevocation', () => ({
  revokeViewerSession: (...args: unknown[]) => h.revokeViewerSession(...args),
}));

vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => h.captureException(...args),
}));

// teardownDisconnectedSessions dynamically imports terminalWs to break the
// import cycle; mock the closed-over closeTerminalSession.
vi.mock('../routes/terminalWs', () => ({
  closeTerminalSession: (...args: unknown[]) => h.closeTerminalSession(...args),
}));

import {
  terminateUserRemoteSessions,
  terminateDeviceRemoteSessions,
  TEARDOWN_FAILED,
} from './remoteSessionTeardown';

/**
 * Seed the UPDATE ... RETURNING result (disconnected rows) and the device
 * SELECT ... WHERE result (agent resolution).
 */
function seed(
  rows: Array<{ id: string; type: string; deviceId: string }>,
  deviceRows: Array<{ id: string; agentId: string | null }>,
) {
  h.chain.returning.mockResolvedValueOnce(rows);
  h.state.deviceRowsResult = deviceRows;
}

describe('terminateUserRemoteSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.whereCalls = 0;
    h.state.whereArgs = [];
    h.state.deviceRowsResult = [];
    // Re-establish fluent defaults wiped by clearAllMocks.
    h.chain.update.mockImplementation(() => h.chain);
    h.chain.set.mockImplementation(() => h.chain);
    h.chain.select.mockImplementation(() => h.chain);
    h.chain.from.mockImplementation(() => h.chain);
    h.chain.where.mockImplementation((arg: unknown) => {
      h.state.whereArgs.push(arg);
      h.state.whereCalls += 1;
      return h.state.whereCalls >= 2
        ? Promise.resolve(h.state.deviceRowsResult)
        : h.chain;
    });
    h.revokeViewerSession.mockResolvedValue(undefined);
    h.closeTerminalSession.mockReturnValue(false);
  });

  it('targets only active statuses (pending/connecting/active) so terminal failed/disconnected rows are never clobbered', async () => {
    seed([{ id: 's1', type: 'desktop', deviceId: 'd1' }], [{ id: 'd1', agentId: 'agent-1' }]);

    await terminateUserRemoteSessions('u1');

    // The UPDATE is the first where() call. Its predicate is and(eq(userId), <statusPredicate>).
    const updateWhere = h.state.whereArgs[0] as { op: string; args: any[] };
    expect(updateWhere.op).toBe('and');
    const statusPredicate = updateWhere.args.find(
      (a) => a?.col === 'remote_sessions.status',
    );
    expect(statusPredicate).toBeDefined();
    // Must be an allowlist of live statuses — NOT `ne(status,'disconnected')`,
    // which also matches terminal `failed` rows and would overwrite their endedAt.
    expect(statusPredicate.op).toBe('inArray');
    expect(statusPredicate.vals).toEqual(['pending', 'connecting', 'active']);
    expect(statusPredicate.vals).not.toContain('failed');
    expect(statusPredicate.vals).not.toContain('disconnected');
  });

  it('disconnects two desktop sessions: revokes each viewer token and signals stop_desktop per session, returns 2', async () => {
    seed(
      [
        { id: 's1', type: 'desktop', deviceId: 'd1' },
        { id: 's2', type: 'desktop', deviceId: 'd2' },
      ],
      [
        { id: 'd1', agentId: 'agent-1' },
        { id: 'd2', agentId: 'agent-2' },
      ],
    );

    const result = await terminateUserRemoteSessions('u1');

    expect(result).toBe(2);
    expect(h.chain.update).toHaveBeenCalledTimes(1);
    expect(h.chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disconnected' }),
    );
    expect(h.revokeViewerSession).toHaveBeenCalledTimes(2);
    expect(h.revokeViewerSession).toHaveBeenCalledWith('s1');
    expect(h.revokeViewerSession).toHaveBeenCalledWith('s2');
    expect(h.sendCommandToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendCommandToAgent).toHaveBeenCalledWith('agent-1', {
      id: 'desk-stop-s1',
      type: 'stop_desktop',
      payload: { sessionId: 's1' },
    });
    expect(h.sendCommandToAgent).toHaveBeenCalledWith('agent-2', {
      id: 'desk-stop-s2',
      type: 'stop_desktop',
      payload: { sessionId: 's2' },
    });
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('never signals stop_desktop for file_transfer or agentless-desktop rows', async () => {
    seed(
      [
        { id: 's2', type: 'file_transfer', deviceId: 'd2' }, // no streaming channel
        { id: 's3', type: 'desktop', deviceId: 'd3' }, // desktop but no agent
      ],
      [
        { id: 'd2', agentId: 'agent-2' },
        { id: 'd3', agentId: null },
      ],
    );

    const result = await terminateUserRemoteSessions('u1');

    expect(result).toBe(2);
    expect(h.revokeViewerSession).toHaveBeenCalledTimes(2);
    // file_transfer has no stream; desktop has no agent → no OS-level teardown.
    expect(h.sendCommandToAgent).not.toHaveBeenCalled();
    expect(h.closeTerminalSession).not.toHaveBeenCalled();
  });

  it('tears down a terminal session: revokes the token, closes the local socket, and does NOT double-signal when closed locally', async () => {
    // closeTerminalSession returns true → the live socket was on this instance
    // and already sent its own terminal_stop, so no fallback agent signal.
    h.closeTerminalSession.mockReturnValue(true);
    seed(
      [{ id: 's1', type: 'terminal', deviceId: 'd1' }],
      [{ id: 'd1', agentId: 'agent-1' }],
    );

    const result = await terminateUserRemoteSessions('u1');

    expect(result).toBe(1);
    expect(h.revokeViewerSession).toHaveBeenCalledWith('s1');
    expect(h.closeTerminalSession).toHaveBeenCalledWith('s1');
    // closeTerminalSession owns the terminal_stop when the socket is local.
    expect(h.sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('falls back to terminal_stop via the agent when the terminal socket is NOT on this instance', async () => {
    // closeTerminalSession returns false → socket lives elsewhere (or ended);
    // the agent must still be told to kill the PTY.
    h.closeTerminalSession.mockReturnValue(false);
    seed(
      [{ id: 's1', type: 'terminal', deviceId: 'd1' }],
      [{ id: 'd1', agentId: 'agent-1' }],
    );

    const result = await terminateUserRemoteSessions('u1');

    expect(result).toBe(1);
    expect(h.closeTerminalSession).toHaveBeenCalledWith('s1');
    expect(h.sendCommandToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendCommandToAgent).toHaveBeenCalledWith('agent-1', {
      id: 'term-stop-s1',
      type: 'terminal_stop',
      payload: { sessionId: 's1' },
    });
  });

  it('returns 0 and performs no revoke/send/device-lookup when there are no active sessions', async () => {
    h.chain.returning.mockResolvedValueOnce([]);

    const result = await terminateUserRemoteSessions('u1');

    expect(result).toBe(0);
    expect(h.revokeViewerSession).not.toHaveBeenCalled();
    expect(h.sendCommandToAgent).not.toHaveBeenCalled();
    // The device-resolution SELECT must not run when nothing was disconnected.
    expect(h.chain.select).not.toHaveBeenCalled();
  });

  it('still processes the other sessions and returns the count when one viewer revoke rejects (best-effort)', async () => {
    seed(
      [
        { id: 's1', type: 'desktop', deviceId: 'd1' },
        { id: 's2', type: 'desktop', deviceId: 'd2' },
      ],
      [
        { id: 'd1', agentId: 'agent-1' },
        { id: 'd2', agentId: 'agent-2' },
      ],
    );
    h.revokeViewerSession.mockRejectedValueOnce(new Error('boom'));

    const result = await terminateUserRemoteSessions('u1');

    expect(result).toBe(2);
    expect(h.revokeViewerSession).toHaveBeenCalledTimes(2);
    // Both desktop sessions still get their stop_desktop signal.
    expect(h.sendCommandToAgent).toHaveBeenCalledTimes(2);
  });

  it('returns the TEARDOWN_FAILED sentinel and reports to Sentry without propagating when the bulk disconnect throws', async () => {
    h.chain.returning.mockRejectedValueOnce(new Error('db down'));

    const result = await terminateUserRemoteSessions('u1');

    expect(result).toBe(TEARDOWN_FAILED);
    expect(result).toBe(-1);
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error));
    // Best-effort side effects never ran.
    expect(h.revokeViewerSession).not.toHaveBeenCalled();
    expect(h.sendCommandToAgent).not.toHaveBeenCalled();
  });
});

describe('terminateDeviceRemoteSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.whereCalls = 0;
    h.state.whereArgs = [];
    h.state.deviceRowsResult = [];
    h.chain.update.mockImplementation(() => h.chain);
    h.chain.set.mockImplementation(() => h.chain);
    h.chain.select.mockImplementation(() => h.chain);
    h.chain.from.mockImplementation(() => h.chain);
    h.chain.where.mockImplementation((arg: unknown) => {
      h.state.whereArgs.push(arg);
      h.state.whereCalls += 1;
      return h.state.whereCalls >= 2
        ? Promise.resolve(h.state.deviceRowsResult)
        : h.chain;
    });
    h.revokeViewerSession.mockResolvedValue(undefined);
    h.closeTerminalSession.mockReturnValue(false);
  });

  it('scopes the disconnect UPDATE by deviceId AND active statuses', async () => {
    seed([{ id: 's1', type: 'desktop', deviceId: 'd1' }], [{ id: 'd1', agentId: 'agent-1' }]);

    await terminateDeviceRemoteSessions('d1');

    const updateWhere = h.state.whereArgs[0] as { op: string; args: any[] };
    expect(updateWhere.op).toBe('and');
    const devicePredicate = updateWhere.args.find((a) => a?.col === 'remote_sessions.device_id');
    expect(devicePredicate).toEqual({ op: 'eq', col: 'remote_sessions.device_id', val: 'd1' });
    const statusPredicate = updateWhere.args.find((a) => a?.col === 'remote_sessions.status');
    expect(statusPredicate.op).toBe('inArray');
    expect(statusPredicate.vals).toEqual(['pending', 'connecting', 'active']);
  });

  it('tears down a live desktop session on the device (revoke + stop_desktop), returns 1', async () => {
    seed([{ id: 's1', type: 'desktop', deviceId: 'd1' }], [{ id: 'd1', agentId: 'agent-1' }]);

    const result = await terminateDeviceRemoteSessions('d1');

    expect(result).toBe(1);
    expect(h.revokeViewerSession).toHaveBeenCalledWith('s1');
    expect(h.sendCommandToAgent).toHaveBeenCalledWith('agent-1', {
      id: 'desk-stop-s1',
      type: 'stop_desktop',
      payload: { sessionId: 's1' },
    });
  });

  it('returns 0 and does nothing when the device has no active sessions', async () => {
    h.chain.returning.mockResolvedValueOnce([]);

    const result = await terminateDeviceRemoteSessions('d1');

    expect(result).toBe(0);
    expect(h.revokeViewerSession).not.toHaveBeenCalled();
    expect(h.sendCommandToAgent).not.toHaveBeenCalled();
    expect(h.chain.select).not.toHaveBeenCalled();
  });

  it('returns TEARDOWN_FAILED and reports to Sentry when the bulk disconnect throws', async () => {
    h.chain.returning.mockRejectedValueOnce(new Error('db down'));

    const result = await terminateDeviceRemoteSessions('d1');

    expect(result).toBe(TEARDOWN_FAILED);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});
