import { and, eq, isNull } from 'drizzle-orm';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { db, withSystemDbAccessContext } from '../db';
import { emailVerificationTokens, partners, users } from '../db/schema';
import { shouldActivatePendingPartner, activatePartnerRow } from './partnerActivation';
import { advanceUserEpochs, revokeAllRefreshFamilies } from './authLifecycle';
import { isPgUniqueViolation } from '../utils/pgErrors';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface GenerateTokenInput {
  partnerId: string;
  userId: string;
  email: string;
  // 'signup' (prove the address on a brand-new partner — the historical
  // behaviour) or 'email_change' (prove control of users.pending_email on an
  // existing account, SR2-17). Defaults to 'signup' so every existing caller
  // is unchanged. Task 8 builds the consume-time branch that reads this column.
  purpose?: 'signup' | 'email_change';
}

/**
 * Issue a fresh verification token. Returns the raw token (only shown
 * once — the DB stores the SHA-256 hash). Caller is responsible for
 * sending it via email.
 *
 * The row is bound to the user's CURRENT `email_epoch` (#2428): any later
 * committed email change advances that counter, and `consumeVerificationToken`
 * refuses a token whose epoch has moved on. Same fail-closed generation binding
 * the password-reset envelope uses for `password_reset_epoch`.
 *
 * A user row that cannot be READ is a hard error, never a NULL epoch. NULL is
 * reserved for rows minted before the 2026-07-16 migration, and consume treats
 * it as "skip the generation check" — so silently minting one here would hand
 * out a permanently weaker token. `users.email_epoch` is NOT NULL, so a missing
 * value can only mean the row is invisible in the current DB context. Note
 * `withSystemDbAccessContext` does NOT escalate when a context is already
 * active (see db/index.ts), so on the authenticated resend path this runs under
 * the CALLER's context and is admitted only because `users`' policy grants the
 * caller their own row. A future caller under a narrower context must fail
 * loudly rather than mint an unbound token.
 *
 * The epoch read is not in a transaction with the insert: a concurrent email
 * change landing in between mints a token stamped with the pre-change epoch,
 * which then fails closed at consume (the strict direction) — never the reverse.
 */
export async function generateVerificationToken(input: GenerateTokenInput): Promise<string> {
  const rawToken = nanoid(48);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({ emailEpoch: users.emailEpoch })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    if (!user) {
      throw new Error(
        `generateVerificationToken: user ${input.userId} not readable in the current DB context`
      );
    }

    await db.insert(emailVerificationTokens).values({
      tokenHash,
      partnerId: input.partnerId,
      userId: input.userId,
      email: input.email.toLowerCase(),
      emailEpoch: user.emailEpoch,
      purpose: input.purpose ?? 'signup',
      expiresAt,
    });
  });

  return rawToken;
}

export type ConsumeFailureReason =
  | 'invalid'
  | 'expired'
  | 'consumed'
  | 'superseded'
  // The account's address moved on after this link was issued (#2428). Distinct
  // from 'superseded' (a NEWER link was sent) on purpose: no newer link exists,
  // so telling the user "use the most recent email" would send them looking for
  // one that was never sent. The caller must offer a resend instead.
  | 'address_changed'
  // SR2-17 (email_change only). The user has no pending_email at commit — the
  // pending state was cancelled or already committed by another link. Nothing
  // to swap; fail closed rather than resurrect a stale address.
  | 'no_pending_email'
  // SR2-17 (email_change only). The pending address was claimed by another
  // account between request and click. The swap hit users_email_unique (23505)
  // and the WHOLE transaction rolled back — this row is untouched (pending NOT
  // cleared, email NOT moved, no session revocation).
  | 'email_taken';

export type ConsumeResult =
  | {
      ok: true;
      // 'signup' proved a brand-new partner's address; 'email_change' swapped a
      // pending address in on an existing account. The route branches on this to
      // fire the post-commit sign-out cleanup + completion notice only for the
      // change path.
      purpose: 'signup' | 'email_change';
      partnerId: string;
      userId: string;
      email: string;
      // Only on the 'email_change' branch: the address that was authoritative
      // BEFORE the swap. The completion notice is sent to it (the abandoned
      // mailbox's owner must hear that the change committed).
      previousEmail?: string;
      autoActivated: boolean;
    }
  | { ok: false; error: ConsumeFailureReason };

/**
 * Atomically consume a verification token. On success, marks the token
 * row consumed and stamps `partners.email_verified_at` and
 * `users.email_verified_at`. If the partner already has a payment method
 * attached and is still in `pending`, also flips it to `active` and
 * clears the "Awaiting email verification" status banner so the
 * verify-after-pay path doesn't strand the tenant with stale UI.
 *
 * Atomicity is bound to this function via an explicit `db.transaction`
 * so the single-claim guarantee holds regardless of caller scope.
 */
export async function consumeVerificationToken(rawToken: string): Promise<ConsumeResult> {
  const tokenHash = hashToken(rawToken);

  return withSystemDbAccessContext(async () => {
    try {
      return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: emailVerificationTokens.id,
          partnerId: emailVerificationTokens.partnerId,
          userId: emailVerificationTokens.userId,
          email: emailVerificationTokens.email,
          emailEpoch: emailVerificationTokens.emailEpoch,
          purpose: emailVerificationTokens.purpose,
          expiresAt: emailVerificationTokens.expiresAt,
          consumedAt: emailVerificationTokens.consumedAt,
          supersededAt: emailVerificationTokens.supersededAt,
        })
        .from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.tokenHash, tokenHash))
        .limit(1);

      if (!row) {
        return { ok: false, error: 'invalid' as const };
      }
      // Order matters: a superseded token can also be expired, but the
      // user-facing copy ("a newer link was sent") is more useful than
      // "expired" since the newer link probably is not.
      if (row.supersededAt) {
        return { ok: false, error: 'superseded' as const };
      }
      if (row.consumedAt) {
        return { ok: false, error: 'consumed' as const };
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return { ok: false, error: 'expired' as const };
      }

      // SR2-17 commit. A purpose='email_change' token proves control of the
      // PENDING address only; redeeming it SWAPS pending_email into email and
      // signs the user out (the sign-out #2428 deferred at request time, now
      // that the change is proven). All of it — token claim, swap, epoch
      // advance, family revoke — is ONE transaction: any failure rolls the
      // whole thing back, never a half-committed "email moved but sessions
      // survived" (or vice versa) state. The `purpose` branch is a security
      // boundary: a signup token can never drive this path and vice versa,
      // because they check DIFFERENT live-row columns.
      if (row.purpose === 'email_change') {
        const now = new Date();

        // FOR UPDATE is load-bearing (same reason the signup branch takes it):
        // without it, an email change committing concurrently is a check-then-
        // act and this stale token could swap in an address the user has since
        // abandoned. Locking the row serializes the two.
        const [liveUser] = await tx
          .select({
            email: users.email,
            pendingEmail: users.pendingEmail,
            emailEpoch: users.emailEpoch,
            name: users.name,
          })
          .from(users)
          .where(eq(users.id, row.userId))
          .limit(1)
          .for('update');

        if (!liveUser) {
          return { ok: false, error: 'superseded' as const };
        }

        // The pending state must still exist, must still be the address this
        // token was issued for, and must still be the generation it was issued
        // under. Any cancellation/replacement advanced email_epoch and fails
        // here — a stale link cannot resurrect an abandoned address.
        if (!liveUser.pendingEmail) {
          return { ok: false, error: 'no_pending_email' as const };
        }
        if (
          liveUser.pendingEmail.toLowerCase() !== row.email.toLowerCase() ||
          row.emailEpoch === null ||
          row.emailEpoch !== liveUser.emailEpoch
        ) {
          // Unlike the signup branch, a NULL token epoch is NOT tolerated here.
          // No purpose='email_change' row can predate the 2026-07-18 migration,
          // so a NULL epoch on one is corruption — fail closed.
          return { ok: false, error: 'address_changed' as const };
        }

        const claimed = await tx
          .update(emailVerificationTokens)
          .set({ consumedAt: now })
          .where(
            and(
              eq(emailVerificationTokens.id, row.id),
              isNull(emailVerificationTokens.consumedAt),
              isNull(emailVerificationTokens.supersededAt)
            )
          )
          .returning({ id: emailVerificationTokens.id });
        if (claimed.length === 0) {
          return { ok: false, error: 'consumed' as const };
        }

        const previousEmail = liveUser.email;

        // THE SWAP. Global email uniqueness is enforced by users_email_unique —
        // if another account took this address while the link sat in a mailbox,
        // this UPDATE raises 23505 and the WHOLE transaction (including the
        // token claim above) rolls back. We do NOT pre-check-then-write: the
        // constraint is the "exactly one winner" arbiter. The raised 23505
        // propagates out of db.transaction so the rollback is unconditional;
        // the outer catch below maps it to the fail-closed 'email_taken'.
        await tx
          .update(users)
          .set({
            email: liveUser.pendingEmail,
            emailVerifiedAt: now,
            pendingEmail: null,
            pendingEmailRequestedAt: null,
            updatedAt: now,
          })
          .where(eq(users.id, row.userId));

        // The recovery surface has NOW moved. Advance auth_epoch (every access
        // token minted for the old identity dies on its next request) and
        // email_epoch (every other outstanding artifact bound to this address
        // dies), and durably revoke every refresh family — all inside THIS
        // transaction, so a rollback undoes the sign-out with the swap.
        await advanceUserEpochs(tx, row.userId, { auth: true, email: true });
        await revokeAllRefreshFamilies(tx, row.userId, 'email-change-committed');

        return {
          ok: true as const,
          purpose: 'email_change' as const,
          partnerId: row.partnerId,
          userId: row.userId,
          email: liveUser.pendingEmail,
          previousEmail,
          autoActivated: false,
        };
      }

      // #2428: the token only proves control of the address it was ISSUED for.
      // Reload the live user and require both the email generation and the
      // exact address to still match, or a link mailed to the old address would
      // stamp `email_verified_at` on an address nobody ever proved (change
      // a@x → b@y, then click the stale a@x link ⇒ b@y silently "verified").
      // The address check alone would miss an a → b → a round-trip; the epoch
      // catches that because it never goes backwards. Fails closed exactly like
      // the reset-token envelope's password_reset_epoch + email check.
      //
      // A NULL token epoch is a row minted before the 2026-07-16 migration:
      // no generation was recorded, so it is held to the address match only
      // rather than hard-failing every in-flight signup link at deploy.
      //
      // FOR UPDATE is load-bearing, not decoration. Without it this is a
      // check-then-act that fails OPEN: the claim UPDATE below guards only
      // consumed_at/superseded_at, so under READ COMMITTED an email change
      // committing between this SELECT and that UPDATE would let the stale
      // token claim itself and stamp email_verified_at on the address that just
      // moved — precisely the bug this gate exists to stop. Locking the `users`
      // row makes the concurrent email-change transaction (which UPDATEs that
      // same row) block until we commit, so the two serialize.
      const [liveUser] = await tx
        .select({ email: users.email, emailEpoch: users.emailEpoch })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1)
        .for('update');

      if (!liveUser) {
        return { ok: false, error: 'superseded' as const };
      }

      if (
        liveUser.email.toLowerCase() !== row.email.toLowerCase() ||
        (row.emailEpoch !== null && row.emailEpoch !== liveUser.emailEpoch)
      ) {
        return { ok: false, error: 'address_changed' as const };
      }

      const now = new Date();

      // Single-claim guarantee: only one concurrent caller will see
      // returning() come back non-empty. The `superseded_at IS NULL`
      // clause closes the SELECT/UPDATE race window where invalidate-
      // by-resend might land between our SELECT above and this UPDATE.
      const claimed = await tx
        .update(emailVerificationTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(emailVerificationTokens.id, row.id),
            isNull(emailVerificationTokens.consumedAt),
            isNull(emailVerificationTokens.supersededAt)
          )
        )
        .returning({ id: emailVerificationTokens.id });

      if (claimed.length === 0) {
        return { ok: false, error: 'consumed' as const };
      }

      await tx
        .update(users)
        .set({ emailVerifiedAt: now })
        .where(eq(users.id, row.userId));

      const [partnerBefore] = await tx
        .select({
          id: partners.id,
          status: partners.status,
          paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
        })
        .from(partners)
        .where(eq(partners.id, row.partnerId))
        .limit(1);

      // Pay-then-verify ordering (#718): email is being verified now, so
      // evaluate the shared activation predicate as if email_verified_at were
      // already set (it is, in this same transaction). The predicate keeps the
      // gate identical to partnerGuard's verify-then-pay self-heal — both
      // require status=pending AND a confirmed payment attachment, never time.
      const shouldAutoActivate =
        !!partnerBefore &&
        shouldActivatePendingPartner({
          status: partnerBefore.status,
          emailVerifiedAt: now,
          paymentMethodAttachedAt: partnerBefore.paymentMethodAttachedAt,
        });

      // Always stamp email_verified_at. When both preconditions are met,
      // activatePartnerRow additionally flips status and clears the inactive
      // banner (shared with partnerGuard so the two paths can't drift).
      await tx
        .update(partners)
        .set({ emailVerifiedAt: now, updatedAt: now })
        .where(eq(partners.id, row.partnerId));

      if (shouldAutoActivate) {
        await activatePartnerRow(tx, row.partnerId, now);
      }

      return {
        ok: true as const,
        purpose: 'signup' as const,
        partnerId: row.partnerId,
        userId: row.userId,
        email: row.email,
        autoActivated: shouldAutoActivate,
      };
      });
    } catch (err) {
      // The only unique-violating write reachable inside the transaction is the
      // email_change swap against users_email_unique. A 23505 there aborts and
      // rolls back the whole transaction (token claim + swap together), so the
      // loser's row is left entirely untouched. Map it to the fail-closed
      // 'email_taken'; any other error is a real fault and propagates.
      if (isPgUniqueViolation(err, 'users_email_unique')) {
        return { ok: false, error: 'email_taken' as const };
      }
      throw err;
    }
  });
}

/**
 * Marks all unconsumed tokens for a user as superseded. Old links stop
 * working immediately and the verify endpoint reports 'superseded' so
 * the user gets accurate copy ("a newer link was sent") rather than
 * the misleading "you already verified".
 *
 * Returns the number of rows marked.
 */
export async function invalidateOpenTokens(userId: string): Promise<number> {
  const now = new Date();
  return withSystemDbAccessContext(async () => {
    const result = await db
      .update(emailVerificationTokens)
      .set({ supersededAt: now })
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.consumedAt),
          isNull(emailVerificationTokens.supersededAt)
        )
      )
      .returning({ id: emailVerificationTokens.id });
    return result.length;
  });
}
