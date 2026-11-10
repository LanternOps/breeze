/**
 * Uniform portal password-login resolution (portal registration W2, spec §6
 * invariant 8: login must not reveal that an address has more than one
 * account).
 *
 * `portal_users.email` is not unique across orgs. Before W2 a login whose
 * address matched more than one password account (and sent no `orgId`) got a
 * distinct 400 "Multiple portal accounts found" — an existence oracle. Now
 * every candidate's password is verified, and the login succeeds only when
 * EXACTLY ONE candidate verifies; anything else is the ordinary
 * invalid-credentials failure:
 *   - one person, two orgs, different passwords → the org whose password matched;
 *   - the same password in two orgs → generic failure, never an arbitrary org;
 *   - no candidate with a password (unknown address, invite pending) → one dummy
 *     verify, so the miss costs the same as a wrong password on one account;
 *   - more than PORTAL_LOGIN_CANDIDATE_CAP candidates → one dummy verify, failure.
 *
 * Verification is sequential with no short-circuit (plan D5). Residual
 * channel, accepted for W2: with N hashed candidates the request costs N
 * verifies, so latency grows with the number of accounts behind one address
 * (bounded by the cap and by the per-IP / per-account login rate limits).
 */
export const PORTAL_LOGIN_CANDIDATE_CAP = 10;

export type LoginCandidate = { id: string; passwordHash: string | null } & Record<string, unknown>;

async function verifies(verify: (hash: string, pw: string) => Promise<boolean>, hash: string, password: string): Promise<boolean> {
  try {
    return await verify(hash, password);
  } catch (error) {
    // A corrupt stored hash is a non-match, never a 500 that differs from a
    // miss. Logged by error class only (never the hash or the password).
    console.error('[portal] password verify threw:', error instanceof Error ? error.name : typeof error);
    return false;
  }
}

export async function resolveLoginCandidate<T extends LoginCandidate>(
  candidates: T[],
  password: string,
  verify: (hash: string, pw: string) => Promise<boolean>,
  dummyHash: () => Promise<string>,
): Promise<T | null> {
  const hashed = candidates.length > PORTAL_LOGIN_CANDIDATE_CAP
    ? []
    : candidates.filter((c): c is T & { passwordHash: string } => typeof c.passwordHash === 'string' && c.passwordHash.length > 0);

  if (hashed.length === 0) {
    try {
      await verifies(verify, await dummyHash(), password);
    } catch (error) {
      // Timing equalization only: the answer is "no match" either way. But a
      // miss now returns fast, which re-opens the enumeration timing channel.
      console.error('[portal] dummy password hash unavailable; login miss timing is not equalized:', error instanceof Error ? error.message : error);
    }
    return null;
  }

  let winner: T | null = null;
  let matches = 0;
  for (const candidate of hashed) {
    if (await verifies(verify, candidate.passwordHash, password)) {
      matches++;
      winner = candidate;
    }
  }
  return matches === 1 ? winner : null;
}
