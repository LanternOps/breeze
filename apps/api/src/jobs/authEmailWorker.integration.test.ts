/**
 * Real-Postgres integration coverage for the auth-email worker (SR2-22).
 *
 * THE dangerous failure mode this file exists to catch: the worker runs OUTSIDE
 * any request, so it has no ambient DB context. `users` is FORCE-RLS. A
 * contextless read/UPDATE is filtered to 0 rows — which the eligibility logic
 * reads as "no such user", so the worker would send NOTHING and silently break
 * password reset for EVERYONE. A mocked-DB unit test cannot see this: it stubs
 * the query builder, so an RLS 0-row result is indistinguishable from a real
 * miss. Only a real Postgres with forced RLS proves the worker's
 * `withSystemDbAccessContext` wrap actually lets it FIND the seeded user and
 * advance the generation.
 *
 * Only the email BOUNDARY is mocked (no SMTP in CI). DB + Redis are real.
 *
 * Run (private containers, sized tmpfs — the shared :5433 rig is contaminated):
 *   docker run -d --name breeze-pg-task5 -e POSTGRES_USER=breeze_test \
 *     -e POSTGRES_PASSWORD=breeze_test -e POSTGRES_DB=breeze_test -p 55432:5432 \
 *     --tmpfs /var/lib/postgresql/data:rw,size=512m postgres:16-alpine
 *   docker run -d --name breeze-redis-task5 -p 56380:6379 redis:7-alpine
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && \
 *   DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:55432/breeze_test \
 *   DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:55432/breeze_test \
 *   REDIS_URL=redis://localhost:56380 \
 *   pnpm vitest run --config vitest.integration.config.ts \
 *     src/jobs/authEmailWorker.integration.test.ts
 */
import '../__tests__/integration/setup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';

const sentPasswordResets: Array<{ to: string; resetUrl: string }> = [];
vi.mock('../services/email', () => ({
  getEmailService: () => ({
    sendPasswordReset: async (params: { to: string; resetUrl: string }) => {
      sentPasswordResets.push(params);
    },
  }),
}));

import { handleAuthEmailJob } from './authEmailWorker';
import { users } from '../db/schema';
import { createPartner, createUser } from '../__tests__/integration/db-utils';
import { getTestDb, getTestRedis } from '../__tests__/integration/setup';

async function readEpoch(userId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ passwordResetEpoch: users.passwordResetEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row.passwordResetEpoch;
}

describe('authEmailWorker — password reset, real Postgres (SR2-22)', () => {
  beforeEach(() => {
    sentPasswordResets.length = 0;
  });

  it('FINDS the seeded user despite running outside a request: advances the generation, writes the reset envelope, sends mail', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `eligible-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, status: 'active', email });

    const epochBefore = await readEpoch(user.id);

    await handleAuthEmailJob({ kind: 'password-reset', email });

    // 1. The worker FOUND the user under system context and advanced the
    //    generation. If the context were wrong, advanceUserEpochs would have
    //    thrown "user not found" (0 rows) and nothing below would hold.
    const epochAfter = await readEpoch(user.id);
    expect(epochAfter).toBe(epochBefore + 1);

    // 2. Exactly one reset:<hash> envelope was written, bound to the advanced
    //    generation + the exact normalized address (SR2-08 preserved).
    const redis = getTestRedis();
    const keys = await redis.keys('reset:*');
    expect(keys).toHaveLength(1);
    const raw = await redis.get(keys[0]!);
    expect(JSON.parse(raw as string)).toEqual({
      userId: user.id,
      passwordResetEpoch: epochAfter,
      email,
    });
    const ttl = await redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);

    // 3. The key is keyed by the SHA-256 of a token the worker generated — not
    //    derivable from the email (no Redis-key existence oracle).
    expect(keys[0]).toMatch(/^reset:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain(createHash('sha256').update(email).digest('hex'));

    // 4. Mail was sent to the address on the account.
    expect(sentPasswordResets).toHaveLength(1);
    expect(sentPasswordResets[0]!.to).toBe(email);
  });

  it('re-requesting supersedes the prior generation (SR2-08): the old envelope no longer matches the live epoch', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `superseded-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, status: 'active', email });

    await handleAuthEmailJob({ kind: 'password-reset', email });
    const redis = getTestRedis();
    const firstKeys = await redis.keys('reset:*');
    const firstEnvelope = JSON.parse((await redis.get(firstKeys[0]!)) as string);

    await handleAuthEmailJob({ kind: 'password-reset', email });
    const liveEpoch = await readEpoch(user.id);

    // The first envelope's generation is now stale — the live epoch has moved
    // past it, so /reset-password's generation check would reject the older
    // token even though it hasn't expired.
    expect(firstEnvelope.passwordResetEpoch).toBeLessThan(liveEpoch);
  });

  it('an UNKNOWN address: no generation advance for anyone, no envelope, no mail — and no throw', async () => {
    // Seed a real user so we can prove their generation is untouched.
    const partner = await createPartner({ status: 'active' });
    const user = await createUser({ partnerId: partner.id, status: 'active', email: `bystander-${Date.now()}@example.com` });
    const epochBefore = await readEpoch(user.id);

    await expect(
      handleAuthEmailJob({ kind: 'password-reset', email: `nobody-${Date.now()}@nowhere.test` }),
    ).resolves.toBeUndefined();

    expect(await readEpoch(user.id)).toBe(epochBefore);
    const redis = getTestRedis();
    expect(await redis.keys('reset:*')).toHaveLength(0);
    expect(sentPasswordResets).toHaveLength(0);
  });

  it('an INELIGIBLE known user (suspended partner): no envelope, no mail', async () => {
    const partner = await createPartner({ status: 'suspended' });
    const email = `suspended-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, status: 'active', email });
    const epochBefore = await readEpoch(user.id);

    await handleAuthEmailJob({ kind: 'password-reset', email });

    // Known user, but tenant is inactive — the worker FOUND them (it resolved
    // the partner status), issued no artifact, and sent nothing.
    expect(await readEpoch(user.id)).toBe(epochBefore);
    const redis = getTestRedis();
    expect(await redis.keys('reset:*')).toHaveLength(0);
    expect(sentPasswordResets).toHaveLength(0);
  });
});
