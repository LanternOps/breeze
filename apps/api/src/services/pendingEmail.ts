import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';
import { advanceUserEpochs } from './authLifecycle';
import { generateVerificationToken, invalidateOpenTokens } from './emailVerification';

const { db } = dbModule;

export interface PendingEmailRequest {
  userId: string;
  partnerId: string;
  newEmail: string;
}

/**
 * SR2-17 initiation. Records the REQUESTED address in `users.pending_email` and
 * advances `email_epoch` — it does NOT move `users.email`, does NOT advance
 * `auth_epoch` and does NOT revoke refresh families. The VERIFIED address in
 * `users.email` stays authoritative for login, password reset, CF Access and
 * SSO matching until the token minted here is redeemed (Task 8's commit,
 * services/emailVerification.ts, purpose='email_change'). Keeping the user
 * signed in is deliberate: they need a live session to go click the link. The
 * session cutoff + family revoke belong to the COMMIT, when the address has
 * actually moved — not to the request, when it has not.
 *
 * Runs in the CALLER's request context — this is a self-service handler writing
 * the caller's OWN users row, which the `users` self policy admits. Deliberately
 * NOT wrapped in withSystemDbAccessContext: inside an already-active request
 * context that is a SILENT NO-OP anyway, and there is no need to escalate.
 *
 * FAILS CLOSED: a 0-row UPDATE ... RETURNING means RLS filtered the row (or the
 * user vanished) — we throw rather than mint a verification token for a state we
 * never wrote.
 */
export async function requestPendingEmailChange(
  req: PendingEmailRequest,
): Promise<{ rawToken: string; emailEpoch: number }> {
  const newEmail = req.newEmail.toLowerCase().trim();
  const now = new Date();

  const emailEpoch = await db.transaction(async (tx) => {
    const rows = await tx
      .update(users)
      .set({ pendingEmail: newEmail, pendingEmailRequestedAt: now, updatedAt: now })
      .where(eq(users.id, req.userId))
      .returning({ id: users.id });
    if (rows.length === 0) {
      throw new Error(
        `requestPendingEmailChange: pending email write matched 0 rows for ${req.userId}`,
      );
    }
    // Advancing email_epoch here invalidates every verification artifact bound
    // to the PREVIOUS generation — including an older pending-email link the
    // user is now replacing. The token minted below carries the NEW epoch.
    const epochs = await advanceUserEpochs(tx, req.userId, { email: true });
    return epochs.emailEpoch;
  });

  // Supersede any still-open token (a prior pending change, or an unfinished
  // signup link) so exactly one live link exists per user.
  await invalidateOpenTokens(req.userId);

  const rawToken = await generateVerificationToken({
    partnerId: req.partnerId,
    userId: req.userId,
    email: newEmail,
    purpose: 'email_change',
  });

  return { rawToken, emailEpoch };
}
