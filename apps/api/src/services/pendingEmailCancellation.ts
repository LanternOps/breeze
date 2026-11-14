import { and, eq, isNotNull } from 'drizzle-orm';
import { users } from '../db/schema';
import type { Tx } from './authLifecycle';

/**
 * Cancel an email-address change that was requested but not confirmed yet.
 *
 * A change request parks the new address in `users.pending_email` and mails a
 * confirmation link (services/pendingEmail.ts); the address moves only when
 * that link is redeemed (services/emailVerification.ts, purpose
 * 'email_change'), which fails with 'no_pending_email' once this has run.
 *
 * Call it inside the transaction of each event that takes control of an
 * account back from whoever holds its sessions, so a change started before the
 * event cannot complete after it:
 *
 *   - password reset and password change (routes/auth/password.ts)
 *   - admin status change, e.g. disable or re-enable (routes/users.ts)
 *   - removal from a partner or organization (routes/users.ts)
 *   - partner suspension (routes/admin/abuse.ts)
 *   - revocation by a completed access review (routes/accessReviews.ts)
 *   - sign-out of every session (services/terminalLogout.ts)
 *   - MFA factor reset (services/mfaFactorReset.ts)
 *
 * This list is explicit on purpose. It is not tied to `advanceUserEpochs`:
 * signup verification, partner activation, org merge and role changes also
 * advance `auth_epoch`, and none of them should cancel the user's request.
 *
 * `email_epoch` is not advanced here. Clearing the pending address is enough to
 * void the outstanding change link, and advancing the epoch would also void an
 * unfinished signup verification link for the current address.
 */
export async function cancelPendingEmailChange(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(users)
    .set({ pendingEmail: null, pendingEmailRequestedAt: null, updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNotNull(users.pendingEmail)));
}
