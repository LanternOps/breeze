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
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { users, emailVerificationTokens } from '../../db/schema';
import { advanceUserEpochs } from '../../services/authLifecycle';
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

/** Commit an email change the way PATCH /users/me does: write + epoch advance. */
async function changeEmail(userId: string, newEmail: string) {
  await withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ email: newEmail, updatedAt: new Date() })
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

    expect(result).toEqual({ ok: false, error: 'superseded' });

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
