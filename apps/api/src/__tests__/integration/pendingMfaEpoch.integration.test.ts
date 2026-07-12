/**
 * Real-Postgres proof that a pending MFA session is invalidated once
 * `mfa_epoch` advances underneath it (Task 9 of the MFA policy/assurance PR —
 * SR2-06).
 *
 * `evaluatePendingMfa`/`parsePendingMfa` are covered by mocked unit tests
 * (helpers.test.ts), which stub the "live" epoch/status entirely. This file
 * proves the live re-check in `/mfa/verify` actually re-reads the CURRENT
 * `mfa_epoch` from real Postgres — not a value captured at login time — by
 * committing a real epoch bump (via `invalidateMfaAssuranceAfterFactorChange`,
 * the same primitive every factor-change handler uses) between writing the
 * pending record and presenting it, and asserting the verify call is
 * rejected and mints no tokens.
 *
 * Run:
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/pendingMfaEpoch.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { users, refreshTokenFamilies } from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { createPartner, createUser } from './db-utils';
import { mfaRoutes } from '../../routes/auth/mfa';

describe('POST /auth/mfa/verify — pending session bound to a stale mfa_epoch is rejected (Task 9, SR2-06)', () => {
  let app: Hono;
  const tempTokens: string[] = [];

  beforeEach(() => {
    app = new Hono();
    app.route('/auth', mfaRoutes);
  });

  afterEach(async () => {
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (redis && tempTokens.length > 0) {
      await redis.del(...tempTokens.map((t) => `mfa:pending:${t}`));
    }
    tempTokens.length = 0;
  });

  it('returns 401 "Invalid or expired MFA session" and mints no tokens once mfa_epoch has advanced past the pending record', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, withMembership: true, mfaEnabled: true });

    const [before] = await getTestDb().select({ mfaEpoch: users.mfaEpoch }).from(users).where(eq(users.id, user.id));
    const pendingMfaEpoch = before!.mfaEpoch; // N — captured at "login time"
    expect(pendingMfaEpoch).toBe(1);

    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (!redis) throw new Error('Redis unavailable in integration environment');

    const tempToken = `test-pending-epoch-${user.id}`;
    tempTokens.push(tempToken);
    await redis.set(
      `mfa:pending:${tempToken}`,
      JSON.stringify({
        userId: user.id,
        mfaMethod: 'totp',
        passkeyAvailable: false,
        authEpoch: 1,
        mfaEpoch: pendingMfaEpoch, // bound to N
        statusExpectation: 'active',
        allowedMethods: { totp: true, sms: true, passkey: true },
        expiresAt: Date.now() + 5 * 60 * 1000,
      }),
      'EX',
      300
    );

    // Advance mfa_epoch to N+1 via a COMMITTED factor-change call — the same
    // primitive every real factor-add/remove/rotate handler uses, not a raw
    // test-only UPDATE.
    const result = await withSystemDbAccessContext(() =>
      invalidateMfaAssuranceAfterFactorChange(user.id, 'pending-epoch-test', async (tx) => {
        await tx.update(users).set({ mfaMethod: 'sms', updatedAt: new Date() }).where(eq(users.id, user.id));
      })
    );
    expect(result.mfaEpoch).toBe(pendingMfaEpoch + 1);

    const familiesBefore = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, user.id));
    expect(familiesBefore).toHaveLength(0); // nothing minted yet

    const res = await app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, code: '123456' }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Invalid or expired MFA session');

    // No tokens minted: still zero refresh-token families for this user, and
    // no Set-Cookie was issued.
    const familiesAfter = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, user.id));
    expect(familiesAfter).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toBeNull();

    // The pending record was consumed by the rejection — a retry with the
    // same tempToken is rejected outright (no lingering session to hammer).
    const stillPending = await redis.get(`mfa:pending:${tempToken}`);
    expect(stillPending).toBeNull();
  });
});
