import { revokeAllUserOauthArtifacts, type UserOauthRevocationResult } from '../oauth/grantRevocation';

/**
 * Called by any code path that flips `users.status` to a non-active value
 * (currently `disabled`). Revokes every OAuth artifact so existing bearer
 * tokens held by MCP clients, connected apps, etc. stop working immediately
 * rather than surviving until natural JWT expiry.
 *
 * This is post-commit cleanup only. Callers must first advance the user's
 * durable auth epoch and revoke refresh-token families in the same transaction
 * as the status/membership/role mutation. OAuth or cache failure here cannot
 * restore those PostgreSQL-invalidated credentials.
 *
 * Reactivation may call this idempotently when the caller wants to clear any
 * artifacts created before the transition; it never owns the transaction.
 */
export async function revokeUserAccess(userId: string): Promise<UserOauthRevocationResult> {
  return revokeAllUserOauthArtifacts(userId);
}
