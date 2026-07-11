import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
}));

import { db } from '../../db';
import { computeInvariantSignals } from './invariants';

beforeEach(() => vi.clearAllMocks());

describe('computeInvariantSignals', () => {
  it('emits alert signals for each invariant breach', async () => {
    vi.mocked(db.execute)
      // active_unverified_email
      .mockResolvedValueOnce([{ id: 'p1', name: 'Acme', created_at: '2026-07-01' }] as never)
      // active_no_payment
      .mockResolvedValueOnce([] as never)
      // inactive_partner_with_agents
      .mockResolvedValueOnce([{ id: 'p2', name: 'Bad Co', status: 'suspended', device_count: '4' }] as never);

    const signals = await computeInvariantSignals();
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      partnerId: 'p1',
      signalKey: 'invariant.active_unverified_email',
      severity: 'alert',
      score: 100,
    });
    expect(signals[1]).toMatchObject({
      partnerId: 'p2',
      signalKey: 'invariant.inactive_partner_with_agents',
      severity: 'alert',
      evidence: expect.objectContaining({ deviceCount: 4, partnerStatus: 'suspended' }),
    });
  });

  it('returns empty when all invariants hold', async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    expect(await computeInvariantSignals()).toEqual([]);
  });
});
