import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { update: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    agentTokenHash: 'agentTokenHash',
    tokenIssuedAt: 'tokenIssuedAt',
    previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt',
    watchdogTokenHash: 'watchdogTokenHash',
    watchdogTokenIssuedAt: 'watchdogTokenIssuedAt',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt',
    helperTokenHash: 'helperTokenHash',
    helperTokenIssuedAt: 'helperTokenIssuedAt',
    previousHelperTokenHash: 'previousHelperTokenHash',
    previousHelperTokenExpiresAt: 'previousHelperTokenExpiresAt',
    pendingTokenHash: 'pendingTokenHash',
    pendingWatchdogTokenHash: 'pendingWatchdogTokenHash',
    pendingHelperTokenHash: 'pendingHelperTokenHash',
    pendingTokenExpiresAt: 'pendingTokenExpiresAt',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
}));

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { promotePendingAgentCredentials } from './agentTokenPromotion';

const NOW = new Date('2026-03-31T18:45:00.000Z');

function mockUpdate(returning: Array<{ id: string }>) {
  const where = vi.fn(() => ({ returning: vi.fn().mockResolvedValue(returning) }));
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where };
}

const BASE = {
  deviceId: 'device-1',
  pendingTokenHash: 'pending-hash',
  expectedAgentTokenHash: 'current-hash',
  pendingWatchdogTokenHash: 'pending-watchdog-hash',
  pendingHelperTokenHash: 'pending-helper-hash',
  watchdogTokenHash: 'current-watchdog-hash',
  helperTokenHash: 'current-helper-hash',
  now: NOW,
};

// Issue #2621 — this is the single point where a staged credential becomes the
// device's real identity. Both the explicit confirm route and the heartbeat's
// implicit promotion go through it, so its compare-and-swap is what stands
// between a normal rotation and a silently rolled-back credential revocation.
describe('promotePendingAgentCredentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('promotes pending to current, demotes current to previous, and clears the staged set', async () => {
    const { set } = mockUpdate([{ id: 'device-1' }]);

    await expect(promotePendingAgentCredentials(BASE)).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith({
      previousTokenHash: 'current-hash',
      previousTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      agentTokenHash: 'pending-hash',
      tokenIssuedAt: NOW,
      previousWatchdogTokenHash: 'current-watchdog-hash',
      previousWatchdogTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      watchdogTokenHash: 'pending-watchdog-hash',
      watchdogTokenIssuedAt: NOW,
      previousHelperTokenHash: 'current-helper-hash',
      previousHelperTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      helperTokenHash: 'pending-helper-hash',
      helperTokenIssuedAt: NOW,
      pendingTokenHash: null,
      pendingWatchdogTokenHash: null,
      pendingHelperTokenHash: null,
      pendingTokenExpiresAt: null,
      updatedAt: NOW,
    });
  });

  // The revocation-rollback guard. If the CAS bound only to the staged hash, a
  // credential staged BEFORE an admin rotation or re-enrollment could promote
  // itself over the replacement and quietly undo the revocation.
  it('binds the compare-and-swap to the observed current hash as well as the staged hash', async () => {
    mockUpdate([{ id: 'device-1' }]);

    await promotePendingAgentCredentials(BASE);

    expect(eq).toHaveBeenCalledWith('pendingTokenHash', 'pending-hash');
    expect(eq).toHaveBeenCalledWith('agentTokenHash', 'current-hash');
  });

  // Zero rows means the row moved underneath us — a concurrent re-stage, or the
  // revocation above. Reporting false keeps the caller from telling the agent a
  // promotion happened when it did not.
  it('reports failure when the compare-and-swap matches no rows', async () => {
    mockUpdate([]);

    await expect(promotePendingAgentCredentials(BASE)).resolves.toBe(false);
  });
});
