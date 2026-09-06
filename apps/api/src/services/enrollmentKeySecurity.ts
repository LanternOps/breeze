import { createHash, randomBytes } from 'crypto';
import { getDefaultEnrollmentKeyTtlMinutes as getSharedDefaultEnrollmentKeyTtlMinutes } from './enrollmentKeyTtlDefault';

/**
 * Mints a raw enrollment key value (64-char hex) for the Partner API
 * provisioning route (#3243). Identical format/entropy to the human route's
 * local generator in routes/enrollmentKeys.ts (which stays local because a
 * dozen test suites mock this module with only the hash functions).
 */
export function generateEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Default lifetime applied when a create request supplies neither
 * `ttlMinutes` nor `expiresAt`. Same env knob the human route has always
 * read (`ENROLLMENT_KEY_DEFAULT_TTL_MINUTES`), and the same 43200-minute
 * (30-day) fallback — see enrollmentKeyTtlDefault.ts for why this delegates
 * instead of hard-coding its own number (#4126 follow-up: this function used
 * to fall back to 60 on its own, drifting from the human route's 30 days).
 * Resolved per call so tests can vary the env.
 */
export function getDefaultEnrollmentKeyTtlMinutes(): number {
  return getSharedDefaultEnrollmentKeyTtlMinutes();
}

// Primary pepper used for ALL new enrollment-key hashes. Required in production.
function getPrimaryPepper(): string {
  const pepper = process.env.ENROLLMENT_KEY_PEPPER?.trim();
  if (pepper) return pepper;

  if (process.env.NODE_ENV === 'test') {
    return 'test-enrollment-key-pepper';
  }

  throw new Error('No enrollment key pepper configured. Set ENROLLMENT_KEY_PEPPER.');
}

// Legacy peppers — only consulted on the read/lookup path so that enrollment keys
// hashed under the older "fall back to APP_ENCRYPTION_KEY/JWT_SECRET" code path
// remain matchable after operators upgrade without first running a re-hash migration.
// New writes always use the primary pepper.
function getLegacyPeppers(): string[] {
  const fallbacks = [
    process.env.APP_ENCRYPTION_KEY,
    process.env.SSO_ENCRYPTION_KEY,
    process.env.SECRET_ENCRYPTION_KEY,
    process.env.JWT_SECRET,
    process.env.SESSION_SECRET,
  ];
  const primary = process.env.ENROLLMENT_KEY_PEPPER?.trim();
  return fallbacks
    .map((value) => value?.trim())
    .filter((value): value is string => !!value && value !== primary);
}

function hashWithPepper(pepper: string, rawKey: string): string {
  return createHash('sha256').update(`${pepper}:${rawKey}`).digest('hex');
}

export function hashEnrollmentKey(rawKey: string): string {
  return hashWithPepper(getPrimaryPepper(), rawKey);
}

/**
 * Hash for `enrollment_keys.key_secret_hash` and for the secret an enrolling
 * agent presents.
 *
 * Deliberately unpeppered plain SHA-256, unlike {@link hashEnrollmentKey}: the
 * comparison also has to work against the global AGENT_ENROLLMENT_SECRET,
 * which is hashed on the fly at verification time. Changing this breaks every
 * already-issued per-key secret.
 */
export function hashEnrollmentSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// Returns every hash a stored enrollment-key row could match — primary first,
// then any legacy peppers. Use with `inArray(enrollmentKeys.key, candidates)`
// on lookup paths. Order is significant: callers that do per-row comparison
// (e.g. `row.key === candidates[0]`) get the modern hash first.
export function hashEnrollmentKeyCandidates(rawKey: string): string[] {
  const primary = hashWithPepper(getPrimaryPepper(), rawKey);
  const legacy = getLegacyPeppers().map((pepper) => hashWithPepper(pepper, rawKey));
  // De-dupe in case two env vars share a value.
  return Array.from(new Set([primary, ...legacy]));
}
