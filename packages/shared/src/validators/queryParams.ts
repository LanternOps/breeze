import { z } from 'zod';

/**
 * Correct tri-state boolean for QUERY-STRING params.
 *
 * `z.coerce.boolean()` is a footgun for query params: it uses JavaScript
 * truthiness, so every non-empty string — including the literal `"false"` and
 * `"0"` — coerces to `true`. A filter like `?approved=false` therefore silently
 * matched the opposite set (returned HTTP 200 with wrong results). This parses
 * the string form instead:
 *
 *   'true' | '1' | 'yes' | 'on'   -> true
 *   'false'| '0' | 'no'  | 'off'  -> false   (case-insensitive, trimmed)
 *   '' (bare `?flag`)             -> false    (preserves the old coerce
 *                                              behavior: Boolean('') === false,
 *                                              so a bare flag stays a real value)
 *   absent (undefined)            -> undefined (no filter — this is .optional())
 *   anything else                 -> ZodError (reject; the old coerce turned
 *                                              garbage like "2" into true, which
 *                                              is exactly the bug — do NOT keep it)
 *
 * The only intended behavior changes vs z.coerce.boolean() are (1) the fix
 * itself — "false"/"0"/etc now correctly parse to false — and (2) garbage now
 * 400s instead of silently meaning true. Bare/absent semantics are preserved.
 *
 * Reuse this everywhere a boolean arrives via the query string. The pre-existing
 * ad-hoc helpers (routes/networkShared, routes/backup/schemas, routes/analytics,
 * the catalog.ts enum idiom) predate it, use their own accepted-value languages,
 * and are left as-is; consolidating them onto this helper is a separate cleanup.
 */
const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off', '']);

export const optionalQueryBoolean = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (TRUE.has(v)) return true;
    if (FALSE.has(v)) return false;
  }
  return value; // fall through to z.boolean() which rejects it
}, z.boolean().optional());
