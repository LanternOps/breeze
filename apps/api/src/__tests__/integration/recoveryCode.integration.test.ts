/**
 * Real-Postgres concurrency proof for the `/mfa/verify` recovery-code path
 * (Task 9 of the MFA policy/assurance PR — SR2-09).
 *
 * `mfa.ts` removes exactly one matching hash with a RELATIVE jsonb delete
 * (`mfaRecoveryCodes - inputHash`) guarded by `@> [inputHash]`, instead of a
 * stale read-modify-write (`SET = <JS array computed from a pre-read
 * snapshot>`). Mocked unit tests cannot prove the concurrency shape actually
 * composes under real Postgres — they stub the DB round-trip entirely. This
 * file drives two genuinely concurrent HTTP requests against real Postgres +
 * real Redis and proves:
 *
 *   (a) identical-code single-winner: two concurrent submissions of the SAME
 *       valid code race on the `@>` guard — exactly one succeeds, the loser's
 *       guard fails against the winner's already-committed value (rowCount 0),
 *       and the persisted array drops by exactly one hash (no double-spend).
 *   (b) DISTINCT-code no-resurrection (the C1 regression this exists to
 *       prevent): two concurrent submissions of DIFFERENT valid codes each
 *       delete their OWN element from the row's latest committed value, so
 *       BOTH succeed and NEITHER resurrects the other's removed hash. A stale
 *       read-modify-write would have had both requests compute their `SET`
 *       value from the SAME pre-race snapshot, so whichever committed second
 *       would silently restore the first winner's already-spent code.
 *
 * Run:
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/recoveryCode.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { users } from '../../db/schema';
import { createPartner, createUser } from './db-utils';
import { hashRecoveryCode } from '../../routes/auth/helpers';
import { mfaRoutes } from '../../routes/auth/mfa';

const CODE_A = 'AAAA-1111';
const CODE_B = 'BBBB-2222';
const CODE_C = 'CCCC-3333';

function pendingRecord(userId: string) {
  return JSON.stringify({
    userId,
    mfaMethod: 'totp',
    passkeyAvailable: false,
    authEpoch: 1,
    mfaEpoch: 1,
    statusExpectation: 'active',
    allowedMethods: { totp: true, sms: true, passkey: true },
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

async function seedUserWithRecoveryCodes(): Promise<string> {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id, withMembership: true, mfaEnabled: true });
  const hashes = [CODE_A, CODE_B, CODE_C].map(hashRecoveryCode);
  await getTestDb().update(users).set({ mfaRecoveryCodes: hashes }).where(eq(users.id, user.id));
  return user.id;
}

async function readRecoveryCodes(userId: string): Promise<string[]> {
  const [row] = await getTestDb()
    .select({ mfaRecoveryCodes: users.mfaRecoveryCodes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Array.isArray(row?.mfaRecoveryCodes) ? (row!.mfaRecoveryCodes as string[]) : [];
}

async function verify(app: Hono, tempToken: string, code: string) {
  return app.request('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken, code, method: 'recovery' }),
  });
}

describe('POST /auth/mfa/verify (method: recovery) — real-PG single-use concurrency (Task 9, SR2-09)', () => {
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

  it('identical-code race: exactly one 200, one 401, persisted array has exactly 2 hashes (no double-spend)', async () => {
    const userId = await seedUserWithRecoveryCodes();
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (!redis) throw new Error('Redis unavailable in integration environment');

    // Two independent pending sessions (as two racing tabs from the same
    // login would each hold their own tempToken), both bound to the SAME
    // live epoch/status so neither is rejected by the epoch/status gate.
    const tokenX = `test-recovery-identical-x-${userId}`;
    const tokenY = `test-recovery-identical-y-${userId}`;
    tempTokens.push(tokenX, tokenY);
    await redis.set(`mfa:pending:${tokenX}`, pendingRecord(userId), 'EX', 300);
    await redis.set(`mfa:pending:${tokenY}`, pendingRecord(userId), 'EX', 300);

    const [r1, r2] = await Promise.all([verify(app, tokenX, CODE_A), verify(app, tokenY, CODE_A)]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);

    const remaining = await readRecoveryCodes(userId);
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(hashRecoveryCode(CODE_A));
    expect(remaining).toEqual(expect.arrayContaining([hashRecoveryCode(CODE_B), hashRecoveryCode(CODE_C)]));
  });

  it('DISTINCT-code race (C1 regression): both 200, persisted array is exactly [hC] — neither winner resurrects the other\'s removed hash', async () => {
    const userId = await seedUserWithRecoveryCodes();
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (!redis) throw new Error('Redis unavailable in integration environment');

    const tokenX = `test-recovery-distinct-x-${userId}`;
    const tokenY = `test-recovery-distinct-y-${userId}`;
    tempTokens.push(tokenX, tokenY);
    await redis.set(`mfa:pending:${tokenX}`, pendingRecord(userId), 'EX', 300);
    await redis.set(`mfa:pending:${tokenY}`, pendingRecord(userId), 'EX', 300);

    // Fire concurrently — no await between requests — so the two `UPDATE ...
    // WHERE mfaRecoveryCodes @> [hash]` statements genuinely race in
    // Postgres rather than serializing by test-code ordering.
    const [r1, r2] = await Promise.all([verify(app, tokenX, CODE_A), verify(app, tokenY, CODE_B)]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const remaining = await readRecoveryCodes(userId);
    // The whole point of the relative jsonb `-` delete: exactly N-2 hashes
    // remain, and it is precisely the untouched third code — hA is not
    // resurrected by hB's commit, nor vice versa.
    expect(remaining).toHaveLength(1);
    expect(remaining).toEqual([hashRecoveryCode(CODE_C)]);
    expect(remaining).not.toContain(hashRecoveryCode(CODE_A));
    expect(remaining).not.toContain(hashRecoveryCode(CODE_B));
  });
});
