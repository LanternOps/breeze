import { and, eq, isNull } from 'drizzle-orm';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { db, withSystemDbAccessContext } from '../db';
import { emailVerificationTokens, partners, users } from '../db/schema';
import {
  activatePendingPartnerAndInvalidateSessions,
  shouldActivatePendingPartner,
} from './partnerActivation';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface GenerateTokenInput {
  partnerId: string;
  userId: string;
  email: string;
}

/**
 * Issue a fresh verification token. Returns the raw token (only shown
 * once — the DB stores the SHA-256 hash). Caller is responsible for
 * sending it via email.
 */
export async function generateVerificationToken(input: GenerateTokenInput): Promise<string> {
  const rawToken = nanoid(48);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await withSystemDbAccessContext(() =>
    db.insert(emailVerificationTokens).values({
      tokenHash,
      partnerId: input.partnerId,
      userId: input.userId,
      email: input.email.toLowerCase(),
      expiresAt,
    })
  );

  return rawToken;
}

export type ConsumeFailureReason = 'invalid' | 'expired' | 'consumed' | 'superseded';

export type ConsumeResult =
  | { ok: true; partnerId: string; userId: string; email: string; autoActivated: boolean }
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

  return withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: emailVerificationTokens.id,
          partnerId: emailVerificationTokens.partnerId,
          userId: emailVerificationTokens.userId,
          email: emailVerificationTokens.email,
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

      // Always stamp email_verified_at. When both preconditions are met, the
      // activation helper flips status and invalidates pre-activation sessions
      // inside this same transaction.
      await tx
        .update(partners)
        .set({ emailVerifiedAt: now, updatedAt: now })
        .where(eq(partners.id, row.partnerId));

      const activation = shouldAutoActivate
        ? await activatePendingPartnerAndInvalidateSessions(tx, row.partnerId, now)
        : { activated: false };

      return {
        ok: true as const,
        partnerId: row.partnerId,
        userId: row.userId,
        email: row.email,
        autoActivated: activation.activated,
      };
    })
  );
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
