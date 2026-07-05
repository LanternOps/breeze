/**
 * Real-DB regression lock for the passkey MFA verify write-context fix (#2210).
 *
 * Drives the actual POST /auth/mfa/passkey/verify handler against real
 * Postgres (breeze_app, RLS-enforced) + Redis. Only the WebAuthn assertion
 * verification is stubbed (verifyPasskeyAuthentication) — the pending-MFA
 * redis record, the user_passkeys read/write, RLS, token minting and audit
 * are all real, the same pattern as ssoPartnerLogin.integration.test.ts.
 *
 * The bug: passkey MFA runs BEFORE the user is authenticated, so the handler
 * has no user RLS context. The `user_passkeys` update that persists the
 * WebAuthn signature counter + last_used_at was issued with a bare `db.update`,
 * which under breeze_app matches 0 rows (Shape 6: user_id = current_user OR
 * scope = 'system'). Result: last_used_at stayed `Never` AND the counter never
 * advanced — silently defeating clone detection. The fix wraps the update in
 * withSystemDbAccessContext, mirroring the users.last_login_at update in the
 * same handler. Without the fix this test fails (counter/last_used_at unchanged).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/passkeyMfaVerify.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { userPasskeys } from '../../db/schema';
import { createPartner, createUser } from './db-utils';

vi.mock('../../services/passkeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/passkeys')>();
  return {
    ...actual,
    verifyPasskeyAuthentication: vi.fn()
  };
});

import { verifyPasskeyAuthentication } from '../../services/passkeys';
import { passkeyRoutes } from '../../routes/auth/passkeys';

describe('POST /auth/mfa/passkey/verify — passkey metadata persists under RLS (#2210)', () => {
  let app: Hono;
  const tempTokens: string[] = [];

  beforeEach(() => {
    app = new Hono();
    app.route('/auth', passkeyRoutes);
    vi.mocked(verifyPasskeyAuthentication).mockReset();
  });

  afterEach(async () => {
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (redis && tempTokens.length > 0) {
      await redis.del(...tempTokens.map((t) => `mfa:pending:${t}`));
    }
    tempTokens.length = 0;
  });

  it('persists last_used_at and the WebAuthn counter after a successful verify', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    // withMembership so resolveCurrentUserTokenContext can mint a real token.
    const user = await createUser({ partnerId: partner.id, withMembership: true });

    const credentialId = `cred-${user.id}`;
    const [passkey] = await db
      .insert(userPasskeys)
      .values({
        userId: user.id,
        credentialId,
        publicKey: 'dGVzdC1wdWJsaWMta2V5', // base64url placeholder; verifier is stubbed
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        lastUsedAt: null
      })
      .returning();

    if (!passkey) throw new Error('failed to insert test passkey');
    expect(passkey.lastUsedAt).toBeNull();
    expect(passkey.counter).toBe(0);

    // Seed the pre-auth pending MFA session the login path would have written.
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (!redis) throw new Error('Redis unavailable in integration environment');
    const tempToken = `test-passkey-mfa-${user.id}`;
    tempTokens.push(tempToken);
    await redis.set(
      `mfa:pending:${tempToken}`,
      JSON.stringify({ userId: user.id, mfaMethod: 'passkey', passkeyAvailable: true }),
      'EX',
      300
    );

    // The authenticator reports an advanced signature counter.
    vi.mocked(verifyPasskeyAuthentication).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 42,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true
      }
    } as Awaited<ReturnType<typeof verifyPasskeyAuthentication>>);

    const res = await app.request('/auth/mfa/passkey/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, credential: { id: credentialId } })
    });

    expect(res.status).toBe(200);

    // The whole point of #2210: the metadata must actually land in the DB.
    const [after] = await db
      .select()
      .from(userPasskeys)
      .where(eq(userPasskeys.id, passkey.id))
      .limit(1);

    if (!after) throw new Error('passkey row missing after verify');
    expect(after.lastUsedAt).not.toBeNull();
    expect(after.counter).toBe(42);
    expect(after.deviceType).toBe('multiDevice');
    expect(after.backedUp).toBe(true);
  });
});
