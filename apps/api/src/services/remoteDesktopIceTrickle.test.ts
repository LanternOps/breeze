import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
}));

import {
  DESKTOP_ICE_TRICKLE_CAPABILITY,
  MAX_ICE_ENTRIES_PER_SOURCE,
  agentIceCandidateMessageSchema,
  agentIceCandidatesForViewer,
  appendAgentIceCandidate,
  submitViewerIceCandidate,
} from './remoteDesktopIceTrickle';

// #9182: trickle ICE through remote_sessions.ice_candidates.

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const RELAY = 'candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 50000';
const dialect = new PgDialect();

function riggedUpdate(rows: unknown[]) {
  const returningMock = vi.fn().mockResolvedValue(rows);
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  updateMock.mockReturnValue({ set: setMock });
  return { setMock, whereMock, returningMock };
}

function render(fragment: unknown) {
  return dialect.sqlToQuery(fragment as SQL);
}

beforeEach(() => {
  updateMock.mockReset();
});

describe('agent desktop_ice_candidate frame schema', () => {
  it('accepts a candidate and a completion marker', () => {
    expect(agentIceCandidateMessageSchema.safeParse({
      type: 'desktop_ice_candidate', sessionId: SESSION_ID, startGeneration: '7', seq: 0,
      candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 },
    }).success).toBe(true);
    expect(agentIceCandidateMessageSchema.safeParse({
      type: 'desktop_ice_candidate', sessionId: SESSION_ID, startGeneration: '7', seq: 3, complete: true,
    }).success).toBe(true);
  });

  it.each([
    ['neither candidate nor completion', { seq: 0 }],
    ['both candidate and completion', { seq: 0, complete: true, candidate: { candidate: RELAY } }],
    ['an empty candidate line', { seq: 0, candidate: { candidate: '' } }],
    ['an oversized candidate line', { seq: 0, candidate: { candidate: 'a'.repeat(1025) } }],
    ['a non-decimal generation', { seq: 0, startGeneration: '7e3', candidate: { candidate: RELAY } }],
    ['a generation beyond bigint range', { seq: 0, startGeneration: '9999999999999999999', candidate: { candidate: RELAY } }],
    ['a negative seq', { seq: -1, candidate: { candidate: RELAY } }],
  ])('rejects %s', (_label, overrides) => {
    expect(agentIceCandidateMessageSchema.safeParse({
      type: 'desktop_ice_candidate', sessionId: SESSION_ID, startGeneration: '7', ...overrides,
    }).success).toBe(false);
  });

  it('names the capability agents look for', () => {
    expect(DESKTOP_ICE_TRICKLE_CAPABILITY).toBe('desktop_ice_trickle');
  });
});

describe('appendAgentIceCandidate', () => {
  it('appends a tagged entry, bound to the authenticated device, the live start generation and the agent cap', async () => {
    const { setMock, whereMock } = riggedUpdate([{ id: SESSION_ID }]);

    const appended = await appendAgentIceCandidate({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      startGeneration: '9007199254740993',
      seq: 2,
      candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 },
    });

    expect(appended).toBe(true);
    const set = render(setMock.mock.calls[0]![0].iceCandidates);
    expect(set.sql).toContain('||');
    expect(JSON.parse(set.params[0] as string)).toEqual([{
      source: 'agent',
      generation: '9007199254740993',
      seq: 2,
      candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 },
    }]);

    const where = render(whereMock.mock.calls[0]![0]);
    expect(where.sql).toContain('"remote_sessions"."device_id" = $');
    expect(where.sql).toContain('"remote_sessions"."desktop_start_generation" = $');
    expect(where.sql).toContain('"remote_sessions"."termination_phase" = $');
    expect(where.sql).toContain('"remote_sessions"."status" in');
    expect(where.sql).toContain('"remote_sessions"."type" = $');
    expect(where.sql).toContain('jsonb_array_elements');
    expect(where.params).toContain(DEVICE_ID);
    // The generation must reach Postgres exactly — never via a JS Number.
    expect(where.params).toContain(9007199254740993n);
    expect(where.params).toContain('agent');
    expect(where.params).toContain(MAX_ICE_ENTRIES_PER_SOURCE);
  });

  it('stores the completion marker', async () => {
    const { setMock } = riggedUpdate([{ id: SESSION_ID }]);
    await appendAgentIceCandidate({ deviceId: DEVICE_ID, sessionId: SESSION_ID, startGeneration: '7', seq: 4, complete: true });
    expect(JSON.parse(render(setMock.mock.calls[0]![0].iceCandidates).params[0] as string)).toEqual([
      { source: 'agent', generation: '7', seq: 4, complete: true },
    ]);
  });

  it('reports a frame that matched no live session', async () => {
    riggedUpdate([]);
    expect(await appendAgentIceCandidate({
      deviceId: DEVICE_ID, sessionId: SESSION_ID, startGeneration: '7', seq: 0, candidate: { candidate: RELAY },
    })).toBe(false);
  });
});

describe('submitViewerIceCandidate', () => {
  const session = {
    id: SESSION_ID,
    status: 'active',
    desktopStartGeneration: 12n,
  };

  it('stores the candidate and relays it to the agent with the current generation', async () => {
    const { setMock, whereMock } = riggedUpdate([{ iceCandidates: [{}, {}] }]);
    const send = vi.fn(() => true);

    const result = await submitViewerIceCandidate({
      session,
      agentId: 'agent-1',
      candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
      send,
    });

    expect(result).toEqual({ ok: true, forwarded: true, iceCandidatesCount: 2 });
    expect(JSON.parse(render(setMock.mock.calls[0]![0].iceCandidates).params[0] as string)).toEqual([{
      source: 'viewer',
      generation: '12',
      candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
    }]);
    const where = render(whereMock.mock.calls[0]![0]);
    expect(where.params).toContain(12n);
    expect(where.params).toContain('viewer');
    expect(send).toHaveBeenCalledWith('agent-1', {
      type: 'desktop_ice_candidate',
      sessionId: SESSION_ID,
      startGeneration: '12',
      candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
    });
  });

  it('refuses a session that is not connecting or active, without writing or relaying', async () => {
    const send = vi.fn(() => true);
    const result = await submitViewerIceCandidate({
      session: { ...session, status: 'pending' },
      agentId: 'agent-1',
      candidate: { candidate: RELAY },
      send,
    });
    expect(result).toEqual({ ok: false, reason: 'state' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not relay a candidate the guarded write refused (moved on, terminal, or over cap)', async () => {
    riggedUpdate([]);
    const send = vi.fn(() => true);
    const result = await submitViewerIceCandidate({ session, agentId: 'agent-1', candidate: { candidate: RELAY }, send });
    expect(result).toEqual({ ok: false, reason: 'rejected' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports an unreachable agent', async () => {
    riggedUpdate([{ iceCandidates: [{}] }]);
    const result = await submitViewerIceCandidate({ session, agentId: null, candidate: { candidate: RELAY }, send: vi.fn() });
    expect(result).toEqual({ ok: true, forwarded: false, iceCandidatesCount: 1 });
  });
});

describe('agentIceCandidatesForViewer', () => {
  it('returns only the agent entries of the current start, ordered by seq', () => {
    const stored = [
      { source: 'agent', generation: '11', seq: 0, candidate: { candidate: 'stale' } },
      { source: 'viewer', generation: '12', candidate: { candidate: 'mine' } },
      { source: 'agent', generation: '12', seq: 1, complete: true },
      { source: 'agent', generation: '12', seq: 0, candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } },
      { candidate: 'legacy-untagged' },
      'garbage',
    ];
    expect(agentIceCandidatesForViewer(stored, 12n)).toEqual([
      { seq: 0, candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } },
      { seq: 1, complete: true },
    ]);
  });

  it('tolerates a non-array column', () => {
    expect(agentIceCandidatesForViewer(null, 1n)).toEqual([]);
    expect(agentIceCandidatesForViewer({}, 1n)).toEqual([]);
  });
});
