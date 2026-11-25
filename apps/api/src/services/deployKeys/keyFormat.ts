/**
 * Deploy-key format (#8318 wave D-1, plan default): `bdk_` + 64 lowercase hex
 * (32 random bytes).
 *
 * The prefix lets enrollment route a key to the deploy-key branch before any
 * lookup, while `breeze-agent enroll <key>` and the `enrollmentKey` body field
 * stay unchanged. Org enrollment keys are bare 64-hex, so the two never
 * collide.
 *
 * Stored as the peppered hash of the WHOLE string (prefix included), through
 * the same helper as org enrollment keys (services/enrollmentKeySecurity.ts);
 * the plaintext is returned once, by mint or rotate, and never stored.
 */
import { randomBytes } from 'node:crypto';
import { hashEnrollmentKey, hashEnrollmentKeyCandidates } from '../enrollmentKeySecurity';

export const DEPLOY_KEY_PREFIX = 'bdk_';

const DEPLOY_KEY_PATTERN = /^bdk_[0-9a-f]{64}$/;

/** A fresh plaintext deploy key. */
export function generateDeployKey(): string {
  return `${DEPLOY_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
}

/**
 * Routing test for enrollment: anything carrying the prefix belongs to the
 * deploy-key branch, including a malformed value, which that branch then
 * refuses as not found instead of letting it fall through to the org-key
 * lookup.
 */
export function hasDeployKeyPrefix(raw: string): boolean {
  return raw.startsWith(DEPLOY_KEY_PREFIX);
}

/** True only for a well-formed deploy key (prefix + exactly 64 lowercase hex). */
export function isWellFormedDeployKey(raw: string): boolean {
  return DEPLOY_KEY_PATTERN.test(raw);
}

/** The value stored in `partner_deploy_keys.key_hash` (primary pepper). */
export function hashDeployKey(raw: string): string {
  return hashEnrollmentKey(raw);
}

/**
 * Every hash a stored key could carry (primary pepper first, then legacy
 * peppers), for `inArray(partnerDeployKeys.keyHash, ...)` on the lookup path.
 */
export function deployKeyHashCandidates(raw: string): string[] {
  return hashEnrollmentKeyCandidates(raw);
}
