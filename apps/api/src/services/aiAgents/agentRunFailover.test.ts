import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  checkBudgetDetailed: vi.fn(async (): Promise<{ message: string } | null> => null),
  markIndeterminate: vi.fn(async () => undefined),
  updates: [] as Array<Record<string, unknown>>,
  reservationRows: {} as Record<string, { id: string; status: string }>,
  lastKey: '' as string,
}));
vi.mock('../aiModels/resolveModel', () => ({ resolveModel: h.resolveModel }));
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: h.checkBudgetDetailed }));
vi.mock('../aiBudgetReservations', () => ({ markAiBudgetReservationIndeterminate: h.markIndeterminate }));
vi.mock('drizzle-orm', async (orig) => {
  const actual = await orig<typeof import('drizzle-orm')>();
  // Capture the idempotency key the select filters on.
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => {
      if (typeof value === 'string' && value.startsWith('ai-agent-run:')) h.lastKey = value;
      return actual.eq(col as never, value as never);
    },
  };
});
vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { h.updates.push(v); } }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (h.reservationRows[h.lastKey] ? [h.reservationRows[h.lastKey]] : []) }),
      }),
    }),
  },
  getCurrentDbAccessContext: () => undefined,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import { markStaleHopReservations, nextAgentHop, probeAgentHop, startHopFor } from './agentRunFailover';

const ORIGIN = { offeringId: 'p', funding: 'platform' as const, connectionId: null };
const base = {
  runId: 'run-1', orgId: 'org-1', partnerId: 'p1', role: 'triage' as const, requestedOfferingId: 'p',
  tried: ['p'], cause: 'overloaded' as const, hop: 1, origin: ORIGIN,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.updates = [];
  h.reservationRows = {};
  h.lastKey = '';
});

describe('nextAgentHop', () => {
  it('re-resolves the role with the tried offerings excluded, admits the next funding, records the hop BEFORE returning', async () => {
    h.resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'ai_agents', offering: { id: 'k', displayName: 'K' } }));
    const r = await nextAgentHop(base);
    expect(h.resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'ai_agents', role: 'triage', requested: { offeringId: 'p', origin: 'policy' },
      excludeOfferingIds: ['p'], failoverCause: 'overloaded', failoverOrigin: ORIGIN,
    }));
    expect(h.checkBudgetDetailed).toHaveBeenCalledWith('org-1', 'partner_key');
    expect(h.updates).toEqual([{ servedOfferingId: 'k', servedFundingSource: 'partner_key', servedFailoverHop: 1, servedFailoverCause: 'overloaded' }]);
    expect(r).toMatchObject({ ok: true, resolved: { offering: { id: 'k' } } });
  });

  it('records nothing when the next funding is not admitted', async () => {
    h.resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents', offering: { id: 'p2', displayName: 'P2' } }));
    h.checkBudgetDetailed.mockResolvedValueOnce({ message: 'Out of AI credits' });
    expect(await nextAgentHop(base)).toEqual({ ok: false, reason: 'admission_denied', message: 'Out of AI credits' });
    expect(h.updates).toEqual([]);
  });

  it('an already-tried or unavailable result is no next hop', async () => {
    h.resolveModel.mockResolvedValueOnce(makeResolvedModel('platform', { offering: { id: 'p', displayName: 'P' } }));
    expect(await nextAgentHop(base)).toMatchObject({ ok: false, reason: 'no_next_hop' });
    h.resolveModel.mockResolvedValueOnce({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: null, message: 'gone' });
    expect(await nextAgentHop(base)).toMatchObject({ ok: false, reason: 'no_next_hop', message: 'gone' });
    expect(h.checkBudgetDetailed).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('never records a hop past the ledger bound (MAX_FAILOVER_HOP)', async () => {
    h.resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'ai_agents', offering: { id: 'k', displayName: 'K' } }));
    expect(await nextAgentHop({ ...base, hop: 7 })).toMatchObject({ ok: false, reason: 'no_next_hop' });
    expect(h.resolveModel).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });
});

describe('probeAgentHop (PR #7775 review: gates the mid-stream abort, no side effects)', () => {
  const { runId: _runId, ...probeInput } = base;

  it('resolves and admits exactly as nextAgentHop does, but records NOTHING on the run', async () => {
    h.resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'ai_agents', offering: { id: 'k', displayName: 'K' } }));
    const r = await probeAgentHop(probeInput);
    expect(r).toMatchObject({ ok: true, resolved: { offering: { id: 'k' } } });
    expect(h.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ excludeOfferingIds: ['p'], failoverCause: 'overloaded' }));
    expect(h.checkBudgetDetailed).toHaveBeenCalledWith('org-1', 'partner_key');
    expect(h.updates).toEqual([]);
  });

  it('an unavailable or unadmitted backup probes as not ok', async () => {
    h.resolveModel.mockResolvedValueOnce({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: null, message: 'gone' });
    expect(await probeAgentHop(probeInput)).toMatchObject({ ok: false, reason: 'no_next_hop' });
    h.resolveModel.mockResolvedValueOnce(makeResolvedModel('platform', { surface: 'ai_agents', offering: { id: 'p2', displayName: 'P2' } }));
    h.checkBudgetDetailed.mockResolvedValueOnce({ message: 'Out of AI credits' });
    expect(await probeAgentHop(probeInput)).toMatchObject({ ok: false, reason: 'admission_denied' });
    expect(h.updates).toEqual([]);
  });
});

describe('markStaleHopReservations (crash between recording hop n and settling hop n-1)', () => {
  it('marks an earlier hop\'s still-active reservation indeterminate, and leaves settled ones alone', async () => {
    h.reservationRows = { 'ai-agent-run:run-1': { id: 'r0', status: 'active' } };
    expect(await markStaleHopReservations({ runId: 'run-1', orgId: 'org-1', uptoHop: 1 })).toBe(1);
    expect(h.markIndeterminate).toHaveBeenCalledWith({ orgId: 'org-1', reservationId: 'r0' });
    h.reservationRows = { 'ai-agent-run:run-1': { id: 'r0', status: 'settled' } };
    h.markIndeterminate.mockClear();
    expect(await markStaleHopReservations({ runId: 'run-1', orgId: 'org-1', uptoHop: 1 })).toBe(0);
    expect(h.markIndeterminate).not.toHaveBeenCalled();
  });

  it('checks every earlier hop key, never the current one', async () => {
    h.reservationRows = {
      'ai-agent-run:run-1': { id: 'r0', status: 'settled' },
      'ai-agent-run:run-1:hop:1': { id: 'r1', status: 'active' },
      'ai-agent-run:run-1:hop:2': { id: 'r2', status: 'active' },
    };
    expect(await markStaleHopReservations({ runId: 'run-1', orgId: 'org-1', uptoHop: 2 })).toBe(1);
    expect(h.markIndeterminate.mock.calls).toEqual([[{ orgId: 'org-1', reservationId: 'r1' }]]);
  });
});

describe('startHopFor (re-drive resume)', () => {
  it('a fresh run starts at hop 0 on the admitted offering', () => {
    expect(startHopFor({ admittedOfferingId: 'p' })).toEqual({ requestedOfferingId: 'p', hop: 0 });
  });
  it('a re-driven run resumes on the hop it last reserved', () => {
    expect(startHopFor({ admittedOfferingId: 'p', servedOfferingId: 'k', servedFailoverHop: 1 })).toEqual({ requestedOfferingId: 'k', hop: 1 });
  });
});
