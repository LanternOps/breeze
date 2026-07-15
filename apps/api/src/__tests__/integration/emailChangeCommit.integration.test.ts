/**
 * Real-Postgres coverage for the SR2-17 email_change COMMIT
 * (services/emailVerification.ts, purpose='email_change').
 *
 * A mock cannot prove the two properties that matter most here:
 *   1. ATOMICITY — the swap, the pending clear, the auth+email epoch advance and
 *      the refresh-family revoke either all commit or all roll back. Forcing a
 *      mid-transaction failure (the uniqueness collision) and observing that the
 *      token-claim UPDATE that ran BEFORE it was also undone is the only way to
 *      prove the token claim and the swap share one atomic unit.
 *   2. The uniqueness collision is FAIL-CLOSED — pending_email is deliberately
 *      non-unique (two accounts can hold the same pending address), so the swap
 *      races against users_email_unique. The loser must get a clean 'email_taken'
 *      with its OWN row entirely untouched.
 *
 * Run:
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/emailChangeCommit.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { users, emailVerificationTokens, refreshTokenFamilies } from '../../db/schema';
import { consumeVerificationToken } from '../../services/emailVerification';
import { requestPendingEmailChange } from '../../services/pendingEmail';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { createPartner, createUser, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * requestPendingEmailChange runs in the CALLER's request context in production
 * (PATCH /users/me establishes it). These tests exercise the COMMIT, not the
 * request, so we drive the realistic initiation under a system context to write
 * the pending state past RLS — a contextless call is silently filtered to 0 rows.
 */
function initiate(userId: string, partnerId: string, newEmail: string) {
  return withSystemDbAccessContext(() =>
    requestPendingEmailChange({ userId, partnerId, newEmail })
  );
}

async function readUser(userId: string) {
  const [row] = await getTestDb()
    .select({
      email: users.email,
      pendingEmail: users.pendingEmail,
      pendingEmailRequestedAt: users.pendingEmailRequestedAt,
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

async function tokenState(userId: string) {
  const [row] = await getTestDb()
    .select({ consumedAt: emailVerificationTokens.consumedAt, purpose: emailVerificationTokens.purpose })
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, userId))
    .limit(1);
  return row;
}

async function familyRevoked(familyId: string) {
  const [row] = await getTestDb()
    .select({ revokedAt: refreshTokenFamilies.revokedAt, reason: refreshTokenFamilies.revokedReason })
    .from(refreshTokenFamilies)
    .where(eq(refreshTokenFamilies.familyId, familyId))
    .limit(1);
  return row;
}

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('email_change initiation — RLS context (SR2-17, real Postgres)', () => {
  // PATCH /users/me runs requestPendingEmailChange inside the CALLER's own RLS
  // context (scope + userId set by the auth middleware), not a system context.
  // email_verification_tokens was partner-axis-only, so an ORG-scoped caller
  // (breeze_has_partner_access false) had the token INSERT rejected (42501) and
  // the whole request 500'd — a headline feature broken for every org-scoped
  // user. The 2026-07-20 migration adds a breeze_current_user_id() branch so the
  // caller can mint their OWN token in-context. This drives that exact context
  // (org scope + the caller's userId, matching the real route) and asserts the
  // mint succeeds.
  it('initiates under an ORG-scoped caller context without an RLS denial', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const newEmail = `orgscope-new-${uniq()}@example.com`;

    const { rawToken } = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: env.organization.id,
        accessibleOrgIds: [env.organization.id],
        userId: env.user.id,
      } as Parameters<typeof withDbAccessContext>[0],
      () =>
        requestPendingEmailChange({
          userId: env.user.id,
          partnerId: env.partner.id,
          newEmail,
        }),
    );

    expect(rawToken).toBeTruthy();
    const t = await tokenState(env.user.id);
    expect(t?.purpose).toBe('email_change');
  });
});

describe('email_change commit — atomic swap + sign-out (SR2-17, real Postgres)', () => {
  it('PROPERTY 1: swaps address, clears pending, advances auth+email epochs, revokes family, consumes token — all committed together', async () => {
    const partner = await createPartner();
    const oldEmail = `commit-old-${uniq()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: oldEmail, withMembership: true });

    const family = await mintRefreshTokenFamily(user.id);
    const before = await readUser(user.id);

    // Real initiation: writes pending_email, advances email_epoch, mints the
    // purpose='email_change' token bound to the pending address + new epoch.
    const newEmail = `commit-new-${uniq()}@example.com`;
    const { rawToken } = await initiate(user.id, partner.id, newEmail);

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
    expect(after.pendingEmailRequestedAt).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    // Epochs: email advanced twice (once at request, once at commit); auth once.
    expect(after.emailEpoch).toBe(before.emailEpoch + 2);
    expect(after.authEpoch).toBe(before.authEpoch + 1);
    // Family revoked (the deferred #2428 sign-out).
    const fam = await familyRevoked(family);
    expect(fam!.revokedAt).not.toBeNull();
    expect(fam!.reason).toBe('email-change-committed');
    // Token consumed.
    expect((await tokenState(user.id))!.consumedAt).not.toBeNull();
  });

  it('PROPERTY 2 + rollback: two accounts share a pending address — first commits, second gets email_taken and is ENTIRELY unchanged', async () => {
    const partner = await createPartner();
    const shared = `shared-${uniq()}@example.com`;

    const winnerOld = `winner-${uniq()}@example.com`;
    const loserOld = `loser-${uniq()}@example.com`;
    const winner = await createUser({ partnerId: partner.id, email: winnerOld, withMembership: true });
    const loser = await createUser({ partnerId: partner.id, email: loserOld, withMembership: true });

    const loserFamily = await mintRefreshTokenFamily(loser.id);

    // Both request the SAME new address (pending_email is non-unique).
    const win = await initiate(winner.id, partner.id, shared);
    const lose = await initiate(loser.id, partner.id, shared);

    const loserBefore = await readUser(loser.id);

    // Winner commits first — now holds `shared`.
    expect((await consumeVerificationToken(win.rawToken)).ok).toBe(true);
    expect((await readUser(winner.id)).email).toBe(shared);

    // Loser's swap now collides on users_email_unique.
    const loserResult = await consumeVerificationToken(lose.rawToken);
    expect(loserResult).toEqual({ ok: false, error: 'email_taken' });

    // The decisive rollback assertions: the loser's row is UNTOUCHED. If the
    // token-claim UPDATE (which ran before the swap) had NOT rolled back, its
    // consumed_at would be set — proving the two are one atomic unit.
    const loserAfter = await readUser(loser.id);
    expect(loserAfter.email).toBe(loserOld); // email NOT moved
    expect(loserAfter.pendingEmail).toBe(shared); // pending NOT cleared
    expect(loserAfter.emailEpoch).toBe(loserBefore.emailEpoch); // epoch NOT advanced at commit
    expect(loserAfter.authEpoch).toBe(loserBefore.authEpoch); // no sign-out
    expect((await tokenState(loser.id))!.consumedAt).toBeNull(); // token NOT consumed
    expect((await familyRevoked(loserFamily))!.revokedAt).toBeNull(); // family NOT revoked
  });

  it('PROPERTY 3: an already-consumed email_change token cannot be replayed', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, email: `replay-${uniq()}@example.com`, withMembership: true });
    const { rawToken } = await initiate(user.id, partner.id, `replay-new-${uniq()}@example.com`);

    expect((await consumeVerificationToken(rawToken)).ok).toBe(true);
    // Replay: the same token is now consumed.
    expect(await consumeVerificationToken(rawToken)).toEqual({ ok: false, error: 'consumed' });
  });

  it('PROPERTY 4 + 5: a stale token is refused after a newer request supersedes it; the old address is NOT resurrected', async () => {
    const partner = await createPartner();
    const original = `stale-orig-${uniq()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: original, withMembership: true });

    // First request → address A, token A (bound to the epoch after request #1).
    const addrA = `stale-a-${uniq()}@example.com`;
    const first = await initiate(user.id, partner.id, addrA);

    // Second request → address B. This advances email_epoch again AND supersedes
    // token A (invalidateOpenTokens). pending_email is now B.
    const addrB = `stale-b-${uniq()}@example.com`;
    await initiate(user.id, partner.id, addrB);

    // Redeeming the STALE token A must fail closed. It was superseded by the
    // resend AND its epoch is now behind — either way, no swap.
    const staleResult = await consumeVerificationToken(first.rawToken);
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(['superseded', 'address_changed']).toContain(staleResult.error);
    }

    // The account still points at the original verified address; pending is B,
    // never resurrected to A.
    const after = await readUser(user.id);
    expect(after.email).toBe(original);
    expect(after.pendingEmail).toBe(addrB);
  });

  it('PROPERTY 3 (purpose boundary): a signup token does NOT swap a pending address', async () => {
    const partner = await createPartner();
    const original = `boundary-${uniq()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: original, withMembership: true });

    // Set a pending change (also mints an email_change token we won't use).
    const pendingAddr = `boundary-pending-${uniq()}@example.com`;
    await initiate(user.id, partner.id, pendingAddr);

    // Hand-mint a SIGNUP token for the CURRENT address at the live epoch. A
    // signup token matches users.email, so it verifies the current address —
    // it must NEVER swap pending_email in.
    const live = await readUser(user.id);
    const { createHash } = await import('crypto');
    const raw = `signup-${uniq()}`;
    await getTestDb()
      .insert(emailVerificationTokens)
      .values({
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        partnerId: partner.id,
        userId: user.id,
        email: original,
        emailEpoch: live.emailEpoch,
        purpose: 'signup',
        expiresAt: new Date(Date.now() + 3_600_000),
      });

    const result = await consumeVerificationToken(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.purpose).toBe('signup');

    // The pending address is still pending — the signup path did NOT swap it.
    const after = await readUser(user.id);
    expect(after.email).toBe(original);
    expect(after.pendingEmail).toBe(pendingAddr);
  });
});
