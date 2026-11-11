import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Session teardown, in three phases (#4142 W2). The ordering assertions are
 * the point: the self-destruct command must reach a still-authenticated
 * socket BEFORE its credentials are revoked, it must be sent outside any DB
 * context (the relay refuses to wait on Redis inside one), and the socket must
 * be dropped only AFTER the revocation commits, or a client whose command was
 * lost stays connected until the 8h hard cap (and a reconnect before the
 * commit would pass re-auth).
 */

const { dispatchCommandToAgent, evictAgentSockets } = vi.hoisted(() => ({
  dispatchCommandToAgent: vi.fn(),
  evictAgentSockets: vi.fn(),
}));

vi.mock('./agentCommandRelay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentCommandRelay')>()),
  dispatchCommandToAgent,
}));
vi.mock('./agentCommandRelayEvict', () => ({ evictAgentSockets }));
vi.mock('../routes/agentWs', () => {
  throw new Error('quickSupportEnd must not load the socket-local agentWs module');
});

const selectResults: unknown[][] = [];
const updates: Array<{ table: string; values: Record<string, unknown>; where: unknown }> = [];
/** Session CAS results, consumed in order; default: the CAS wins, device dev-1 bound. */
const casResults: unknown[][] = [];
/** Every mutating/IO step in call order, so ordering can be asserted. */
const callOrder: string[] = [];
const ctx = vi.hoisted(() => ({ depth: 0 }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((l: unknown, r: unknown) => ({ eq: [l, r] })),
  notInArray: vi.fn((c: unknown, v: unknown) => ({ notInArray: [c, v] })),
}));

vi.mock('../db', () => {
  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'where']) builder[m] = vi.fn(() => builder);
    builder.limit = vi.fn(() => Promise.resolve(rows));
    return builder;
  });

  const update = vi.fn((table: { _name: string }) => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn((where: unknown) => {
        updates.push({ table: table._name, values, where });
        const isRevoke = table._name === 'devices';
        callOrder.push(isRevoke ? 'revoke' : 'session-cas');
        const result = Promise.resolve([]);
        return Object.assign(result, {
          returning: vi.fn(() => Promise.resolve(isRevoke ? [] : (casResults.shift() ?? [{ id: 'sess-1', deviceId: 'dev-1' }]))),
        });
      }),
    })),
  }));

  return {
    db: { select, update },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => {
      ctx.depth += 1;
      callOrder.push('tx-open');
      try {
        return await fn();
      } finally {
        ctx.depth -= 1;
        callOrder.push('tx-commit');
      }
    }),
    runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
    hasDbAccessContext: vi.fn(() => ctx.depth > 0),
  };
});

vi.mock('../db/schema', () => ({
  supportSessions: {
    _name: 'supportSessions', id: 'supportSessions.id', status: 'supportSessions.status', deviceId: 'supportSessions.deviceId',
  },
  devices: { _name: 'devices', id: 'devices.id', agentId: 'devices.agentId' },
}));

import { endSupportSession } from './quickSupportEnd';

const READY_SESSION = {
  id: 'sess-1',
  orgId: 'qs-org',
  status: 'ready',
  deviceId: 'dev-1',
};

function readySessionWithAgent() {
  selectResults.push([READY_SESSION]);
  selectResults.push([{ agentId: 'agent-1' }]);
}

beforeEach(() => {
  selectResults.length = 0;
  updates.length = 0;
  casResults.length = 0;
  callOrder.length = 0;
  ctx.depth = 0;
  vi.clearAllMocks();
  dispatchCommandToAgent.mockImplementation(async () => {
    callOrder.push(ctx.depth === 0 ? 'command' : 'command-inside-context');
    return { status: 'sent', via: 'local' };
  });
  evictAgentSockets.mockImplementation(async (requests: Array<{ agentId: string }>) => {
    callOrder.push(ctx.depth === 0 ? 'evict' : 'evict-inside-context');
    return new Map(requests.map((r) => [r.agentId, { status: 'closed', via: 'local' }]));
  });
});

describe('endSupportSession', () => {
  it('order: support_end dispatched before the revoking transaction opens; eviction runs after it commits', async () => {
    readySessionWithAgent();

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toEqual({ ended: true, disconnect: 'closed', commandDelivered: true });
    expect(callOrder).toEqual([
      'tx-open', 'tx-commit', // A: read the session and device
      'command', // outside any context
      'tx-open', 'session-cas', 'revoke', 'tx-commit', // B: CAS, revoke, decommission
      'evict', // after B committed
    ]);
  });

  it('sends the exact command shape the Go client parses, through the relay facade', async () => {
    readySessionWithAgent();

    await endSupportSession('sess-1', 'tech');

    expect(dispatchCommandToAgent).toHaveBeenCalledWith('agent-1', {
      id: 'support-end-sess-1',
      type: 'support_end',
      payload: { sessionId: 'sess-1' },
    });
  });

  it('evicts with code 4041 and waits for the answer (default awaitAck)', async () => {
    readySessionWithAgent();

    await endSupportSession('sess-1', 'tech');

    expect(evictAgentSockets).toHaveBeenCalledTimes(1);
    expect(evictAgentSockets.mock.calls[0]).toEqual([
      [{ agentId: 'agent-1', code: 4041, reason: 'quick support session ended' }],
    ]);
  });

  it('revokes all three token hashes and decommissions the device', async () => {
    readySessionWithAgent();

    await endSupportSession('sess-1', 'tech');

    // decommissionedAt (#2787 item 4): a quick-support device ending its
    // session IS a removed device, and the retention job measures its purge
    // window from this stamp. Without it every ephemeral support device stays
    // forever under an org whose policy says to purge removed devices.
    const revoke = updates.find((u) => u.table === 'devices');
    expect(revoke?.values).toEqual({
      agentTokenHash: null,
      watchdogTokenHash: null,
      helperTokenHash: null,
      status: 'decommissioned',
      decommissionedAt: expect.any(Date),
    });
    expect(revoke?.where).toEqual({ eq: ['devices.id', 'dev-1'] });
  });

  it('the revoking write is a CAS on non-terminal status; losing the race returns ended:false and evicts nothing', async () => {
    readySessionWithAgent();
    casResults.push([]); // another end (tech, reaper) won between read and write

    const result = await endSupportSession('sess-1', 'tech');

    expect(result.ended).toBe(false);
    expect(result.disconnect).toBeNull();
    const cas = updates.find((u) => u.table === 'supportSessions');
    expect(cas?.where).toEqual({
      and: [
        { eq: ['supportSessions.id', 'sess-1'] },
        { notInArray: ['supportSessions.status', ['ended', 'expired']] },
      ],
    });
    expect(updates.some((u) => u.table === 'devices')).toBe(false);
    expect(evictAgentSockets).not.toHaveBeenCalled();
  });

  it('relay eviction outcome indeterminate → disconnect unconfirmed (audited, not collapsed into success)', async () => {
    readySessionWithAgent();
    evictAgentSockets.mockResolvedValueOnce(new Map([['agent-1', { status: 'indeterminate' }]]));

    const result = await endSupportSession('sess-1', 'tech');

    expect(result.disconnect).toBe('unconfirmed');
    expect(result.ended).toBe(true);
  });

  it.each([
    [{ status: 'closed', via: 'local' }, 'closed'],
    [{ status: 'closed', via: 'relay' }, 'closed'],
    [{ status: 'close_failed', via: 'relay' }, 'close-failed'],
    [{ status: 'not_connected' }, 'not-connected'],
    [{ status: 'owner_mismatch' }, 'unconfirmed'],
    [{ status: 'expired' }, 'unconfirmed'],
    [{ status: 'queued' }, 'unconfirmed'],
    [{ status: 'unavailable', reason: 'presence_unavailable' }, 'unconfirmed'],
  ])('eviction outcome %j → disconnect %s', async (outcome, disconnect) => {
    readySessionWithAgent();
    evictAgentSockets.mockResolvedValueOnce(new Map([['agent-1', outcome]]));

    const result = await endSupportSession('sess-1', 'tech');

    expect(result.disconnect).toBe(disconnect);
  });

  it.each([
    [{ status: 'sent', via: 'relay' }, true],
    [{ status: 'indeterminate' }, false],
    [{ status: 'offline' }, false],
    [{ status: 'infrastructure_error', message: 'x' }, false],
  ])('dispatch outcome %j → commandDelivered %s', async (outcome, delivered) => {
    dispatchCommandToAgent.mockResolvedValueOnce(outcome);
    readySessionWithAgent();

    const result = await endSupportSession('sess-1', 'tech');

    expect(result.commandDelivered).toBe(delivered);
    expect(result.ended).toBe(true);
    expect(callOrder).toContain('revoke'); // revocation is not conditional on delivery
  });

  it("records 'expired' as its own terminal state for reaper hard-cap kills", async () => {
    readySessionWithAgent();

    await endSupportSession('sess-1', 'expired');

    expect(updates.find((u) => u.table === 'supportSessions')?.values)
      .toMatchObject({ status: 'expired', endedReason: 'expired', endedAt: expect.any(Date) });
  });

  it("records a non-expired reason as 'ended'", async () => {
    readySessionWithAgent();

    await endSupportSession('sess-1', 'end_user');

    expect(updates.find((u) => u.table === 'supportSessions')?.values)
      .toMatchObject({ status: 'ended', endedReason: 'end_user' });
  });

  it('is idempotent — an already-ended session does nothing', async () => {
    selectResults.push([{ ...READY_SESSION, status: 'ended' }]);

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toEqual({ ended: false, disconnect: null, commandDelivered: false });
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(evictAgentSockets).not.toHaveBeenCalled();
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
    casResults.push([{ id: 'sess-1', deviceId: null }]);

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toEqual({ ended: true, disconnect: null, commandDelivered: false });
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(evictAgentSockets).not.toHaveBeenCalled();
    expect(updates.map((u) => u.table)).toEqual(['supportSessions']); // session row only
  });

  it('a session whose device row is gone ends without signalling an agent', async () => {
    selectResults.push([READY_SESSION]);
    selectResults.push([]); // device already purged

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toEqual({ ended: true, disconnect: null, commandDelivered: false });
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(evictAgentSockets).not.toHaveBeenCalled();
  });

  it('a device that enrolled between the read and the CAS is still revoked and evicted', async () => {
    // Read: claimed, no device yet. By the CAS, enrollment bound dev-2.
    selectResults.push([{ ...READY_SESSION, status: 'claimed', deviceId: null }]);
    casResults.push([{ id: 'sess-1', deviceId: 'dev-2' }]);
    selectResults.push([{ agentId: 'agent-2' }]); // dev-2's agent, read inside the CAS transaction

    const result = await endSupportSession('sess-1', 'tech');

    expect(result).toEqual({ ended: true, disconnect: 'closed', commandDelivered: false });
    expect(updates.find((u) => u.table === 'devices')?.where).toEqual({ eq: ['devices.id', 'dev-2'] });
    expect(evictAgentSockets).toHaveBeenCalledWith([
      { agentId: 'agent-2', code: 4041, reason: 'quick support session ended' },
    ]);
    // No support_end: the device was not bound when the command phase ran.
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
  });
});
