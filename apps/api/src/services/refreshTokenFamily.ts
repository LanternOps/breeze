/**
 * Refresh-Token Family Mint Helper (Task 7 follow-up)
 *
 * Centralises the family-creation dance so every authenticated token-mint
 * path uses one source of truth. Without this helper, /login, /mfa/verify,
 * /register-partner, /accept-invite, and /sso/callback all had to repeat
 * the same 4-step sequence — and missing it on any path (most importantly
 * /mfa/verify) silently disabled reuse-detection for that cohort of users.
 *
 * Sequence (single-source-of-truth, OAuth 2.1 / RFC 9700 §4.13.2):
 *   1. Generate a fresh familyId UUID.
 *   2. INSERT into refresh_token_families under system scope (audit row).
 *   3. Caller mints the token pair with `{ refreshFam: familyId }`.
 *   4. Caller calls bindRefreshJtiToFamily(refreshJti, familyId) so the
 *      jti → family mapping is hot in Redis for the next /refresh.
 *
 * Steps 1+2 live here; 3+4 stay in the route handler so each path can apply
 * its own surrounding logic (db wrapping, audit trail, etc).
 */
import { randomUUID } from 'crypto';
import * as dbModule from '../db';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { rememberJtiFamily } from './tokenRevocation';

/**
 * Mints a fresh refresh-token family for a user and persists the audit row
 * to refresh_token_families under system scope (matches the existing /login
 * pattern — RLS Shape 6, system-scope OR branch).
 *
 * Returns the new familyId, which the caller must pass to createTokenPair
 * via `{ refreshFam: familyId }` and then to bindRefreshJtiToFamily once the
 * pair is minted.
 *
 * If the insert fails this throws — callers should let the error propagate
 * (no token has been minted yet, so failing the request is the right
 * outcome; the alternative is a token without a family, which is exactly
 * the bug this helper exists to prevent).
 */
export async function mintRefreshTokenFamily(userId: string): Promise<string> {
  const familyId = randomUUID();
  await dbModule.withSystemDbAccessContext(async () => {
    await dbModule.db.insert(refreshTokenFamilies).values({
      familyId,
      userId,
    });
  });
  return familyId;
}

/**
 * Best-effort bind of the newly-minted refresh jti to its family in Redis.
 * Mirrors the /login post-mint dance. Failure here is non-fatal: the family
 * id is also encoded in the JWT `fam` claim, so the family-revocation check
 * still works from the verified payload.
 */
export async function bindRefreshJtiToFamily(jti: string, familyId: string): Promise<void> {
  await rememberJtiFamily(jti, familyId);
}
