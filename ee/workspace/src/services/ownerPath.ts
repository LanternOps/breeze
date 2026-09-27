import { z } from 'zod';

/**
 * A local_profile row's relPath is `<profile>/<folder>/...`, and a caller's
 * claimed owner (the helper's `helperUser`) is matched against that first
 * segment with a relPath prefix ILIKE. The claim is caller-supplied text, so
 * it is both constrained at the route (OWNER_USERNAME_PATTERN) and escaped
 * here before it becomes a LIKE pattern — a raw `%` or `_` would otherwise
 * match other profiles' rows.
 */

/**
 * Profile names are permissive (spaces, dots, hyphens, underscores,
 * apostrophes, non-ASCII letters, `name.DOMAIN.000` suffixes), so this is a
 * denylist: no path separators, no `%`, no control characters.
 */
export const OWNER_USERNAME_PATTERN = /^[^/\\%\p{Cc}]*$/u;

/** The route-level `helperUser` field: at most 100 chars of OWNER_USERNAME_PATTERN. */
export function helperUserField() {
  return z.string().max(100).regex(OWNER_USERNAME_PATTERN);
}

/** Escape LIKE metacharacters (backslash first) so the value matches literally under `ESCAPE '\'`. */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * ILIKE pattern for rows under the claimed profile: `<escaped owner>/%`.
 * Always pair it with an explicit `ESCAPE '\'` in the SQL.
 */
export function ownerRelPathPattern(ownerUsername: string): string {
  return `${escapeLikeLiteral(ownerUsername)}/%`;
}
