import { createHash } from 'crypto';

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
