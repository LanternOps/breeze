/**
 * Coerce a stored OS fingerprint to display text. The discovery worker has
 * persisted it as a jsonb `{ os: '<name>' }` object while the API contract is
 * a plain string, so anything non-string must never reach a React child (#9645).
 */
export function normalizeOsFingerprint(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    const os = (value as { os?: unknown }).os;
    return typeof os === 'string' && os ? os : null;
  }
  return null;
}
