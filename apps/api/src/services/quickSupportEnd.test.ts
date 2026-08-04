import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Session teardown. The ordering assertions are the point: the self-destruct
 * command must reach a still-authenticated socket BEFORE its credentials are
 * revoked, and the socket must be dropped AFTER, or a client whose command was
 * lost stays connected until the 8h hard cap.
 */

const { sendCommandToAgent, disconnectAgent } = vi.hoisted(() => ({
  sendCommandToAgent: vi.fn(() => true),
  disconnectAgent: vi.fn(() => 'closed' as const),
}));

vi.mock('../routes/agentWs', () => ({ sendCommandToAgent, disconnectAgent }));

const selectResults: unknown[][] = [];
const updates: Array<{ values: Record<string, unknown> }> = [];
/** Every mutating/IO step in call order, so ordering can be asserted. */
const callOrder: string[] = [];

vi.mock('../db', () => {
  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'where']) builder[m] = vi.fn(() => builder);
    builder.limit = vi.fn(() => Promise.resolve(rows));
    return builder;
  });

  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push({ values });
      callOrder.push('status' in values && values.status === 'decommissioned' ? 'revoke' : 'session-update');
      return { where: vi.fn(() => Promise.resolve([])) };
    }),
  }));

  return {
    db: { select, update },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
  };
});

vi.mock('../db/schema', () => ({
  supportSessions: { id: 'supportSessions.id' },
  devices: { id: 'devices.id', agentId: 'devices.agentId' },
}));

import { endSupportSession } from './quickSupportEnd';

const READY_SESSION = {
  id: 'sess-1',
  orgId: 'qs-org',
  status: 'ready',
  deviceId: 'dev-1',
};

beforeEach(() => {
  selectResults.length = 0;
  updates.length = 0;
  callOrder.length = 0;
  vi.clearAllMocks();
  sendCommandToAgent.mockImplementation(() => { callOrder.push('command'); return true; });
  disconnectAgent.mockImplementation(() => { callOrder.push('disconnect'); return 'closed'; });
});

describe('endSupportSession', () => {
  it('sends the self-destruct, revokes credentials, then drops the socket — in that order', async () => {
    selectResults.push([READY_SESSION]);
    selectResults.push([{ agentId: 'agent-1' }]);

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toMatchObject({ ended: true, disconnect: 'closed', commandDelivered: true });
    expect(callOrder).toEqual(['command', 'revoke', 'disconnect', 'session-update']);
  });

  it('sends the exact command shape the Go client parses', async () => {
    selectResults.push([READY_SESSION]);
    selectResults.push([{ agentId: 'agent-1' }]);

    await endSupportSession('sess-1', 'tech');

    expect(sendCommandToAgent).toHaveBeenCalledWith('agent-1', {
      id: 'support-end-sess-1',
      type: 'support_end',
      payload: { sessionId: 'sess-1' },
    });
  });

  it('revokes all three token hashes and decommissions the device', async () => {
    selectResults.push([READY_SESSION]);
    selectResults.push([{ agentId: 'agent-1' }]);

    await endSupportSession('sess-1', 'tech');

    expect(updates[0].values).toEqual({
      agentTokenHash: null,
      watchdogTokenHash: null,
      helperTokenHash: null,
      status: 'decommissioned',
    });
  });

  it('still revokes when the command could not be delivered', async () => {
    sendCommandToAgent.mockImplementation(() => { callOrder.push('command'); return false; });
    selectResults.push([READY_SESSION]);
    selectResults.push([{ agentId: 'agent-1' }]);

    const result = await endSupportSession('sess-1', 'tech');

    expect(result.commandDelivered).toBe(false);
    expect(result.ended).toBe(true);
    expect(callOrder).toContain('revoke'); // revocation is not conditional on delivery
  });

  it('reports a failed socket close rather than claiming success', async () => {
    disconnectAgent.mockImplementation(() => { callOrder.push('disconnect'); return 'close-failed'; });
    selectResults.push([READY_SESSION]);
    selectResults.push([{ agentId: 'agent-1' }]);

    const result = await endSupportSession('sess-1', 'tech');

    expect(result.disconnect).toBe('close-failed');
    expect(result.ended).toBe(true);
  });

  it("records 'expired' as its own terminal state for reaper hard-cap kills", async () => {
    selectResults.push([READY_SESSION]);
    selectResults.push([{ agentId: 'agent-1' }]);

    await endSupportSession('sess-1', 'expired');

    expect(updates[1].values).toMatchObject({ status: 'expired', endedReason: 'expired' });
  });

  it("records a non-expired reason as 'ended'", async () => {
    selectResults.push([READY_SESSION]);
    selectResults.push([{ agentId: 'agent-1' }]);

    await endSupportSession('sess-1', 'end_user');

    expect(updates[1].values).toMatchObject({ status: 'ended', endedReason: 'end_user' });
  });

  it('is idempotent — an already-ended session does nothing', async () => {
    selectResults.push([{ ...READY_SESSION, status: 'ended' }]);

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toEqual({ ended: false, disconnect: null, commandDelivered: false });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('does nothing for an unknown session', async () => {
    selectResults.push([]);
    const result = await endSupportSession('nope', 'tech');
    expect(result.ended).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('ends a pending session that never enrolled a device, touching no agent', async () => {
    selectResults.push([{ ...READY_SESSION, status: 'pending', deviceId: null }]);

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toMatchObject({ ended: true, disconnect: null, commandDelivered: false });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(disconnectAgent).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1); // session row only
  });
});
