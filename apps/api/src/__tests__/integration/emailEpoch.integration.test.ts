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
import { requestPendingEmailChange } from '../../services/pendingEmail';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

async function readUser(userId: string) {
  const [row] = await getTestDb()
    .select({
      email: users.email,
      pendingEmail: users.pendingEmail,
      emailEpoch: users.emailEpoch,
      authEpoch: users.authEpoch,
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
// Real HTTP-route coverage for the SR2-17/18 TWO-PHASE email change.
//
// BEFORE (the old #2428 shape) PATCH /users/me moved users.email, advanced BOTH
// epochs and revoked the refresh family — all in the request. Tasks 7 + 8 split
// that in two:
//
//   Phase 1 (initiation, PATCH /users/me): records users.pending_email behind a
//     recovery-grade step-up, advances email_epoch ONLY. It does NOT move
//     users.email, does NOT advance auth_epoch and does NOT revoke sessions —
//     the user stays signed in to go click the link.
//   Phase 2 (commit, redeeming the purpose='email_change' token): ONE
//     db.transaction swaps pending_email→email, advances auth+email epochs and
//     revokes every refresh family with reason 'email-change-committed'.
//
// The property the OLD single-phase test guarded — that the sign-out revoke is
// NOT silently RLS-filtered to zero rows (#1105), i.e. it provably hits real
// family rows under the correct DB context — did not disappear. It MOVED to the
// commit. The Phase-2 test below is where that guard now lives: it is the
// load-bearing assertion, and removing the commit-path revoke turns it RED.
//
// middleware/auth is mocked ONLY to inject a pre-built auth context (and to run
// the handler inside the CALLER's request-scoped withDbAccessContext); the
// step-up gates are stubbed (see the mock above). Every DB write below still
// goes through real Postgres RLS. Pattern mirrors authLifecycle.integration.test.ts.
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
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

// SR2-17/18: PATCH /me email change is gated behind a recovery-grade step-up
// (current password + a fresh existing-factor grant). Those gates are the
// province of the ROUTE unit suite (routes/users.test.ts) and the step-up
// helpers' own tests — NOT this file, whose job is to prove the REAL Postgres /
// RLS behaviour of the two-phase flow. So we stub the two step-up gates to
// "satisfied" and let every DB write below hit real Postgres RLS. The Phase-1
// caller is a normal local-password user (createUser sets a real argon2 hash),
// so passing currentPassword drives the password branch; the existing-factor
// step-up is a no-op for this unprotected account anyway.
vi.mock('../../routes/auth/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/helpers')>();
  return {
    ...actual,
    requireCurrentPasswordStepUp: vi.fn(async () => null),
    enforceExistingFactorStepUp: vi.fn(async () => null),
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

describe('PATCH /users/me email change — real route, real RLS (SR2-17, SR2-18)', () => {
  beforeEach(() => {
    activeAuthContext = null;
  });

  afterEach(() => {
    activeAuthContext = null;
    vi.clearAllMocks();
  });

  // PHASE 1 — initiation. The route records a PENDING address and advances
  // email_epoch ONLY. It must NOT move users.email, must NOT advance auth_epoch
  // and must NOT revoke the refresh family: the user stays signed in to go prove
  // the new address.
  it('records a PENDING address, advances email_epoch ONLY, and does NOT move users.email or revoke the family', async () => {
    const partner = await createPartner();
    const oldEmail = `route-old-${Date.now()}@example.com`;
    // Local-password user (createUser sets a real argon2 hash). Verify the
    // original address so we can prove the flag is NOT cleared at initiation.
    const user = await createUser({
      partnerId: partner.id,
      email: oldEmail,
      password: 'TestPass123!',
      withMembership: true,
    });
    await withSystemDbAccessContext(() =>
      db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id))
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
      body: JSON.stringify({ email: newEmail, currentPassword: 'TestPass123!' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // The response surfaces the OLD (still-authoritative) address, the requested
    // address as pendingEmail, and verificationSent — never an optimistic swap.
    expect(body.email).toBe(oldEmail);
    expect(body.pendingEmail).toBe(newEmail);
    expect(body.verificationSent).toBe(true);

    const after = await readUser(user.id);
    // users.email UNCHANGED; pending recorded; email_epoch advanced by exactly 1.
    expect(after.email).toBe(oldEmail);
    expect(after.pendingEmail).toBe(newEmail);
    expect(after.emailEpoch).toBe(before.emailEpoch + 1);
    // NOT a sign-out: auth_epoch untouched, verified flag untouched.
    expect(after.authEpoch).toBe(before.authEpoch);
    expect(after.emailVerifiedAt).not.toBeNull();

    // The refresh family MUST still be live — initiation never signs the user out.
    const [family] = await getTestDb()
      .select({ revokedAt: refreshTokenFamilies.revokedAt })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId))
      .limit(1);
    expect(family!.revokedAt).toBeNull();
  });

  // PHASE 2 — commit. Redeeming the purpose='email_change' token swaps the
  // pending address in, advances auth+email epochs, and REALLY revokes the
  // refresh family. This is the RELOCATED #1105 guard: the revoke provably hits
  // real family rows under the correct DB context. If the commit-path revoke
  // were removed, family.revokedAt stays null and this test goes RED.
  it('COMMIT: redeeming the email_change token swaps the address, advances auth+email epochs, and REALLY revokes the refresh family', async () => {
    const partner = await createPartner();
    const oldEmail = `commit-old-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: oldEmail, withMembership: true });

    // Verify the original address so the swap has a real prior verified state.
    await withSystemDbAccessContext(() =>
      db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id))
    );

    const familyId = await mintRefreshTokenFamily(user.id);
    const before = await readUser(user.id);

    // Realistic initiation (what Phase 1's route does) — under a system context
    // here so the pending write lands past RLS in this contextless test, and to
    // capture the raw token the route would have emailed.
    const newEmail = `commit-new-${Date.now()}@example.com`;
    const { rawToken } = await withSystemDbAccessContext(() =>
      requestPendingEmailChange({ userId: user.id, partnerId: partner.id, newEmail })
    );

    // The commit itself.
    const result = await consumeVerificationToken(rawToken);
    expect(result).toMatchObject({
      ok: true,
      purpose: 'email_change',
      email: newEmail,
      previousEmail: oldEmail,
    });

    const after = await readUser(user.id);
    // Swap + pending clear.
    expect(after.email).toBe(newEmail);
    expect(after.pendingEmail).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    // email_epoch advanced twice total (once at initiation, once at commit);
    // auth_epoch advanced once — at the commit, never at initiation.
    expect(after.emailEpoch).toBe(before.emailEpoch + 2);
    expect(after.authEpoch).toBe(before.authEpoch + 1);

    // THE DECISIVE, RELOCATED #1105 ASSERTION: the sign-out revoke hit the real
    // family row (not silently RLS-filtered to zero) and stamped the commit
    // reason. Delete revokeAllRefreshFamilies from the commit and this fails.
    const [family] = await getTestDb()
      .select({ revokedAt: refreshTokenFamilies.revokedAt, reason: refreshTokenFamilies.revokedReason })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId))
      .limit(1);
    expect(family!.revokedAt).not.toBeNull();
    expect(family!.reason).toBe('email-change-committed');
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
