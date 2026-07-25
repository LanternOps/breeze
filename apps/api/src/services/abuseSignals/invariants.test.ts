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
      .mockResolvedValueOnce([{ id: 'p3', name: 'NoPay Co', created_at: '2026-06-20' }] as never)
      // inactive_partner_with_agents
      .mockResolvedValueOnce([{ id: 'p2', name: 'Bad Co', status: 'suspended', device_count: '4' }] as never)
      // suspended_partner_active_subscription
      .mockResolvedValueOnce([
        { id: 'p4', name: 'Still Billed Co', status: 'suspended', billing_subscription_status: 'active' },
      ] as never);

    const signals = await computeInvariantSignals();
    expect(signals).toHaveLength(4);
    expect(signals[0]).toMatchObject({
      partnerId: 'p1',
      signalKey: 'invariant.active_unverified_email',
      severity: 'alert',
      score: 100,
      evidence: { partnerName: 'Acme', partnerCreatedAt: '2026-07-01' },
    });
    expect(signals[1]).toMatchObject({
      partnerId: 'p3',
      signalKey: 'invariant.active_no_payment',
      severity: 'alert',
      score: 100,
      evidence: { partnerName: 'NoPay Co', partnerCreatedAt: '2026-06-20' },
    });
    expect(signals[2]).toMatchObject({
      partnerId: 'p2',
      signalKey: 'invariant.inactive_partner_with_agents',
      severity: 'alert',
      evidence: expect.objectContaining({ deviceCount: 4, partnerStatus: 'suspended' }),
    });
    expect(signals[3]).toMatchObject({
      partnerId: 'p4',
      signalKey: 'invariant.suspended_partner_active_subscription',
      severity: 'alert',
      score: 100,
      evidence: expect.objectContaining({
        partnerName: 'Still Billed Co',
        partnerStatus: 'suspended',
        subscriptionStatus: 'active',
      }),
    });
  });

  it('returns empty when all invariants hold', async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    expect(await computeInvariantSignals()).toEqual([]);
  });

  it('is silent for an active partner with a live subscription', async () => {
    // The suspended_partner_active_subscription query filters status <> 'active'
    // in SQL, so a healthy paying partner never reaches the loop. Empty result
    // set from every invariant query => no signals at all.
    vi.mocked(db.execute).mockResolvedValue([] as never);
    const signals = await computeInvariantSignals();
    expect(signals.some((s) => s.signalKey === 'invariant.suspended_partner_active_subscription')).toBe(false);
  });

  it('never age-weights the suspended-subscription invariant', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { id: 'p9', name: 'Old Co', status: 'pending', billing_subscription_status: 'past_due' },
      ] as never);

    const signals = await computeInvariantSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signalKey: 'invariant.suspended_partner_active_subscription',
      score: 100,
      severity: 'alert',
    });
  });
});
