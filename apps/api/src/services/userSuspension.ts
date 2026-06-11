import { revokeAllUserOauthArtifacts, type UserOauthRevocationResult } from '../oauth/grantRevocation';

/**
 * Called by any code path that flips `users.status` to a non-active value
 * (currently `disabled`). Revokes every OAuth artifact so existing bearer
 * tokens held by MCP clients, connected apps, etc. stop working immediately
 * rather than surviving until natural JWT expiry.
 *
 * Dashboard sessions: dashboard auth uses short-lived JWTs only (no
 * server-side refresh-token store). The `users.status = 'active'` check in
 * `middleware/auth.ts` blocks new dashboard requests on the next hit. No
 * extra revocation step is needed for dashboard JWTs today.
 * TODO: if/when a dashboard refresh-token table is added, also revoke here.
 *
 * Reactivation (status flipping back to `active`) must NOT call this — a
 * re-activated user starts fresh and must re-authenticate anyway because
 * every old grant is already marked revoked in Redis.
 */
export async function revokeUserAccess(userId: string): Promise<UserOauthRevocationResult> {
  return revokeAllUserOauthArtifacts(userId);
}
