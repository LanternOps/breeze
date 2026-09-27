/**
 * Whole-cycle regression: an admin-triggered incident-response credential
 * rotation (`POST /devices/:id/agent-token/rotate`, routes/devices/core.ts)
 * nulls the device's LIVE watchdog and helper hashes and mints no
 * replacement for either — there is no admin-facing "new token" for those
 * roles. Recovery instead relies on the agent's own self-heal path:
 *
 *   1. heartbeat.ts's `shouldRotateAgentToken` sees a null watchdog hash and
 *      asks the agent to rotate (`rotateToken: true`).
 *   2. the agent calls `POST /agents/:id/rotate-token` (routes/agents/
 *      token.ts), which unconditionally mints and STAGES fresh agent +
 *      watchdog + helper tokens together (never just one role).
 *   3. the staged set is PROMOTED — either explicitly via
 *      `/rotate-token/confirm` or implicitly on the next heartbeat that
 *      authenticates with the staged token — via
 *      `promotePendingAgentCredentials` (services/agentTokenPromotion.ts),
 *      which writes the pending watchdog/helper hashes to the LIVE columns.
 *
 * This test drives real, unmocked step 1 and step 3 back-to-back against a
 * device shaped exactly like the post-admin-rotate row (both live hashes
 * null) to prove the cycle actually closes end to end, not just that each
 * step passes in isolation.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { update: vi.fn() } }));
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
  and: (...args: unknown[]) => ({ __and: args }),
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
}));
// heartbeatTokenRotation.ts's only dependency is this one pure helper — stub
// it rather than pull in middleware/agentAuth.ts's full db/schema-heavy
// import graph, which this focused test has no need for.
vi.mock('../middleware/agentAuth', () => ({
  isAgentTokenRotationDue: vi.fn(() => false),
}));

import { db } from '../db';
import { shouldRotateAgentToken } from '../routes/agents/heartbeatTokenRotation';
import { promotePendingAgentCredentials } from './agentTokenPromotion';

function mockUpdate(returning: Array<{ id: string }>) {
  const where = vi.fn(() => ({ returning: vi.fn().mockResolvedValue(returning) }));
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set };
}

describe('agent-token admin rotate -> heartbeat -> sibling reissue cycle', () => {
  it('signals rotation for the post-admin-rotate device state, and promotion reissues both live siblings from null', async () => {
    // Step 1: the exact shape POST /devices/:id/agent-token/rotate leaves the
    // row in — live watchdog hash nulled, no pending rotation in flight, the
    // device not draining, and the caller authenticated with the FRESH admin
    // token (not the previous one).
    const postAdminRotateDevice = {
      watchdogTokenHash: null as string | null,
      tokenIssuedAt: new Date(),
    };
    const rotationSignaled = shouldRotateAgentToken({
      tenantDraining: false,
      authenticatedWithPreviousToken: false,
      pendingRotationLive: false,
      watchdogTokenHash: postAdminRotateDevice.watchdogTokenHash,
      tokenIssuedAt: postAdminRotateDevice.tokenIssuedAt,
    });
    expect(rotationSignaled).toBe(true);

    // Step 3 (step 2 — POST /agents/:id/rotate-token staging — is covered by
    // token.test.ts; it unconditionally mints+stages all three roles and is
    // not re-tested here): promotion must succeed and reissue BOTH live
    // watchdog and helper hashes even though both start out null, which none
    // of the existing promotion tests exercised (they all start from an
    // already-populated current hash).
    const { set } = mockUpdate([{ id: 'device-1' }]);
    const now = new Date('2026-09-25T12:00:00.000Z');

    const promoted = await promotePendingAgentCredentials({
      deviceId: 'device-1',
      pendingTokenHash: 'staged-agent-hash',
      expectedAgentTokenHash: 'current-agent-hash',
      pendingWatchdogTokenHash: 'staged-watchdog-hash',
      pendingHelperTokenHash: 'staged-helper-hash',
      watchdogTokenHash: null,
      helperTokenHash: null,
      now,
    });

    expect(promoted).toBe(true);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        watchdogTokenHash: 'staged-watchdog-hash',
        helperTokenHash: 'staged-helper-hash',
        // Nulled currents mean nothing sensible to keep as the "previous"
        // grace credential for either role.
        previousWatchdogTokenHash: null,
        previousHelperTokenHash: null,
      }),
    );
  });
});
