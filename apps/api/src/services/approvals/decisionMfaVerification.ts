/**
 * A second factor the SERVER verified for one approve request, so the decide
 * core can count it alongside the session's MFA claim (`hasSatisfiedMfa`).
 *
 * The approve route mints one only after `requireFreshMfaStepUp` accepted a
 * fresh one-time code for the signed-in user (TOTP, single-use step). The value
 * is an opaque object registered in a module-private WeakSet: a JSON body, a
 * spread copy or any object built elsewhere is not in the set, so nothing a
 * client sends can stand in for it. It is bound to the user it was verified
 * for and is consumed by the first decide that reads it, so one verified code
 * authorizes one decide call.
 */
export interface DecisionMfaVerification {
  readonly userId: string;
  readonly method: 'totp';
}

const issued = new WeakSet<DecisionMfaVerification>();

/** Call only after the server verified a fresh code for `userId` in this request. */
export function recordDecisionMfaVerification(userId: string): DecisionMfaVerification {
  const verification: DecisionMfaVerification = Object.freeze({ userId, method: 'totp' as const });
  issued.add(verification);
  return verification;
}

/**
 * True exactly once for a verification minted by `recordDecisionMfaVerification`
 * for `userId`. Anything else (undefined, a look-alike object, another user's
 * verification, a second read) is false.
 */
export function consumeDecisionMfaVerification(
  verification: DecisionMfaVerification | undefined,
  userId: string,
): boolean {
  if (!verification || typeof verification !== 'object' || !issued.has(verification)) return false;
  issued.delete(verification);
  return verification.userId === userId;
}
