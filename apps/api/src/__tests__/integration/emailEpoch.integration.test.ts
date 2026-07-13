/**
 * Real-Postgres coverage for the email-generation gate (#2428).
 *
 * `users.email_epoch` shipped inert: nothing advanced it and nothing read it.
 * A verification link issued for the OLD address therefore stayed redeemable
 * after the address moved — consuming it stamped `users.email_verified_at` and
 * marked the NEW, never-proven address verified.
 *
 * Mocked unit tests cannot prove this end to end: they stub the query builder,
 * so a missing `email_epoch` column, a non-advancing counter, or a consume that
 * silently writes zero rows under RLS all look identical to success. These
 * exercise the real migration + the real service against real Postgres.
 *
 * Run:
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/emailEpoch.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { users, emailVerificationTokens, refreshTokenFamilies } from '../../db/schema';
import { advanceUserEpochs } from '../../services/authLifecycle';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import {
  generateVerificationToken,
  consumeVerificationToken,
} from '../../services/emailVerification';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

async function readUser(userId: string) {
  const [row] = await getTestDb()
    .select({
      email: users.email,
      emailEpoch: users.emailEpoch,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row;
}

/**
 * Commit an email change the way PATCH /users/me does: the address write, the
 * verification-flag clear, and the epoch advance in one transaction.
 */
async function changeEmail(userId: string, newEmail: string) {
  await withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ email: newEmail, emailVerifiedAt: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await advanceUserEpochs(tx, userId, { auth: true, email: true });
    })
  );
}

describe('email_epoch generation gate — real Postgres (#2428)', () => {
  it('mints a verification token bound to the current email_epoch', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, email: `mint-${Date.now()}@example.com` });

    const raw = await generateVerificationToken({
      partnerId: partner.id,
      userId: user.id,
      email: user.email,
    });
    expect(raw).toBeTruthy();

    const [row] = await getTestDb()
      .select({ emailEpoch: emailVerificationTokens.emailEpoch })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, user.id))
      .limit(1);

    // Proves the migration column exists AND the mint reads the live counter.
    const live = await readUser(user.id);
    expect(row?.emailEpoch).toBe(live.emailEpoch);
  });

  it('advances email_epoch on a committed email change', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, email: `adv-${Date.now()}@example.com` });

    const before = await readUser(user.id);
    await changeEmail(user.id, `adv-new-${Date.now()}@example.com`);
    const after = await readUser(user.id);

    expect(after.emailEpoch).toBe(before.emailEpoch + 1);
  });

  // The whole point of the issue: this is what used to succeed.
  it('REJECTS a verification link issued before an email change, leaving the new address unverified', async () => {
    const partner = await createPartner();
    const oldEmail = `stale-old-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: oldEmail });

    // Link mailed to the OLD address...
    const staleToken = await generateVerificationToken({
      partnerId: partner.id,
      userId: user.id,
      email: oldEmail,
    });

    // ...then the account moves to an address nobody has proven control of.
    const newEmail = `stale-new-${Date.now()}@example.com`;
    await changeEmail(user.id, newEmail);

    const result = await consumeVerificationToken(staleToken);

    // 'address_changed', not 'superseded' — no newer link was sent.
    expect(result).toEqual({ ok: false, error: 'address_changed' });

    // The decisive assertion: the never-proven address must NOT be verified,
    // and the stale token must not have consumed itself either.
    const after = await readUser(user.id);
    expect(after.email).toBe(newEmail);
    expect(after.emailVerifiedAt).toBeNull();

    const [token] = await getTestDb()
      .select({ consumedAt: emailVerificationTokens.consumedAt })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, user.id))
      .limit(1);
    expect(token?.consumedAt).toBeNull();
  });

  it('still accepts a link issued for the CURRENT address (no false rejection)', async () => {
    const partner = await createPartner();
    const email = `happy-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email });

    const token = await generateVerificationToken({
      partnerId: partner.id,
      userId: user.id,
      email,
    });

    const result = await consumeVerificationToken(token);

    expect(result.ok).toBe(true);
    const after = await readUser(user.id);
    expect(after.emailVerifiedAt).not.toBeNull();
  });

  it('leaves the new address UNVERIFIED after a change (it must be re-proven)', async () => {
    const partner = await createPartner();
    const email = `carry-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email });

    // Verify the ORIGINAL address for real, through the service.
    const token = await generateVerificationToken({ partnerId: partner.id, userId: user.id, email });
    expect((await consumeVerificationToken(token)).ok).toBe(true);
    expect((await readUser(user.id)).emailVerifiedAt).not.toBeNull();

    await changeEmail(user.id, `carry-new-${Date.now()}@example.com`);

    // Verification must NOT carry over to an address nobody has proven. If it
    // did, the DB would assert the new address is verified AND
    // /auth/resend-verification would refuse to mint a link for it — stranding
    // the user with no path to verify at all.
    expect((await readUser(user.id)).emailVerifiedAt).toBeNull();
  });

  it('accepts a re-issued link after the email change (the user CAN verify the new address)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, email: `reissue-${Date.now()}@example.com` });

    await generateVerificationToken({ partnerId: partner.id, userId: user.id, email: user.email });

    const newEmail = `reissue-new-${Date.now()}@example.com`;
    await changeEmail(user.id, newEmail);

    // A link minted AFTER the change carries the new generation and redeems.
    const fresh = await generateVerificationToken({
      partnerId: partner.id,
      userId: user.id,
      email: newEmail,
    });

    const result = await consumeVerificationToken(fresh);

    expect(result.ok).toBe(true);
    const after = await readUser(user.id);
    expect(after.emailVerifiedAt).not.toBeNull();
  });
});

// ============================================================================
// Real HTTP-route coverage for PATCH /users/me. The suites above exercise the
// service gate; this one exercises the ROUTE, and specifically its RLS claim:
// the email write, the epoch advance and the refresh-family revoke all run in
// the CALLER's request context (not a system context). Mocked tests cannot
// prove that — under a wrong context `revokeAllRefreshFamilies` is silently
// RLS-filtered to zero rows and returns success, which is exactly the trap the
// route comment says it avoids. middleware/auth is mocked ONLY to inject a
// pre-built auth context; every write below still goes through real Postgres
// RLS via the real withDbAccessContext. Pattern mirrors
// authLifecycle.integration.test.ts.
// ============================================================================
type AuthCtx = {
  scope: 'partner' | 'organization';
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  accessiblePartnerIds: string[] | null;
  userId: string;
  email: string;
};

let activeAuthContext: AuthCtx | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      const ctx = activeAuthContext;
      c.set('auth', {
        scope: ctx.scope,
        partnerId: ctx.partnerId,
        orgId: ctx.orgId,
        accessibleOrgIds: ctx.accessibleOrgIds ?? [],
        user: { id: ctx.userId, email: ctx.email },
      });
      return withDbAccessContext(
        {
          scope: ctx.scope,
          orgId: ctx.orgId,
          accessibleOrgIds: ctx.accessibleOrgIds,
          accessiblePartnerIds: ctx.accessiblePartnerIds,
          userId: ctx.userId,
        },
        () => next(),
      );
    },
    // The caller is passwordless below, so PATCH /me takes the MFA step-up
    // branch — no Redis-backed password step-up needed.
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

async function buildUsersApp() {
  const { userRoutes } = await import('../../routes/users');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/users', userRoutes);
  return app;
}

describe('PATCH /users/me email change — real route, real RLS (#2428)', () => {
  beforeEach(() => {
    activeAuthContext = null;
  });

  afterEach(() => {
    activeAuthContext = null;
    vi.clearAllMocks();
  });

  it('advances both epochs, clears verification, and REALLY revokes the refresh family under the caller request context', async () => {
    const partner = await createPartner();
    const oldEmail = `route-old-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: oldEmail, withMembership: true });

    // Passwordless (SSO-less) user → the handler's MFA step-up branch, which
    // the mocked hasSatisfiedMfa satisfies. Also verify the original address so
    // the flag has something to clear.
    await withSystemDbAccessContext(() =>
      db
        .update(users)
        .set({ passwordHash: null, emailVerifiedAt: new Date() })
        .where(eq(users.id, user.id))
    );

    const familyId = await mintRefreshTokenFamily(user.id);
    const before = await readUser(user.id);

    activeAuthContext = {
      scope: 'partner',
      partnerId: partner.id,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partner.id],
      userId: user.id,
      email: oldEmail,
    };

    const app = await buildUsersApp();
    const newEmail = `route-new-${Date.now()}@example.com`;
    const res = await app.request('/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail }),
    });

    expect(res.status).toBe(200);

    const after = await readUser(user.id);
    expect(after.email).toBe(newEmail);
    expect(after.emailEpoch).toBe(before.emailEpoch + 1);
    expect(after.emailVerifiedAt).toBeNull();

    const [authEpochRow] = await getTestDb()
      .select({ authEpoch: users.authEpoch })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    expect(authEpochRow!.authEpoch).toBeGreaterThan(1);

    // The decisive one: the revoke was NOT silently filtered to zero rows.
    const [family] = await getTestDb()
      .select({ revokedAt: refreshTokenFamilies.revokedAt, reason: refreshTokenFamilies.revokedReason })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId))
      .limit(1);
    expect(family!.revokedAt).not.toBeNull();
    expect(family!.reason).toBe('email-change');

    // And the stale link for the old address is now dead end-to-end.
    const stale = await generateVerificationTokenForOldAddress(partner.id, user.id, oldEmail);
    expect(await consumeVerificationToken(stale)).toEqual({ ok: false, error: 'address_changed' });
  });

  it('a name-only PATCH does NOT revoke the refresh family or touch the epochs', async () => {
    const partner = await createPartner();
    const email = `route-name-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email, withMembership: true });

    const familyId = await mintRefreshTokenFamily(user.id);
    const before = await readUser(user.id);

    activeAuthContext = {
      scope: 'partner',
      partnerId: partner.id,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partner.id],
      userId: user.id,
      email,
    };

    const app = await buildUsersApp();
    const res = await app.request('/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed User' }),
    });

    expect(res.status).toBe(200);

    const after = await readUser(user.id);
    expect(after.emailEpoch).toBe(before.emailEpoch);

    // A rename must never sign the user out everywhere.
    const [family] = await getTestDb()
      .select({ revokedAt: refreshTokenFamilies.revokedAt })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId))
      .limit(1);
    expect(family!.revokedAt).toBeNull();
  });
});

/**
 * Mint a token bound to an address the user no longer holds. Done by hand (not
 * via generateVerificationToken, which reads the LIVE epoch and would bind the
 * post-change generation) to reproduce the pre-change link exactly.
 */
async function generateVerificationTokenForOldAddress(
  partnerId: string,
  userId: string,
  oldEmail: string
): Promise<string> {
  const { createHash } = await import('crypto');
  const raw = `stale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tokenHash = createHash('sha256').update(raw).digest('hex');

  await withSystemDbAccessContext(() =>
    db.insert(emailVerificationTokens).values({
      tokenHash,
      partnerId,
      userId,
      email: oldEmail,
      emailEpoch: 1, // the generation in force before the change
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
  );

  return raw;
}
