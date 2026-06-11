import { z } from 'zod';

// Rejects ASCII control characters (code points 0x00-0x1F and 0x7F), matching
// the client getSafeNext guard. Implemented as a char-code scan rather than a
// regex literal so the source carries no raw control bytes (which editors and
// diff tooling can mangle) and needs no eslint no-control-regex exception.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True only for a safe same-origin relative path: a single leading slash (not
 * `//` or `/\`, both of which browsers can resolve to an absolute host), with
 * no embedded control characters.
 *
 * This is the server-side mirror of the client `getSafeNext` guard
 * (apps/web/src/lib/authNext.ts). Persisting only values that pass this check
 * means a stored notification `link` can never become an open redirect when the
 * client later navigates to it — defense-in-depth even if the client guard is
 * ever weakened. Absolute URLs, protocol-relative URLs, and custom schemes
 * (javascript:, data:, ...) are all rejected.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!value.startsWith('/')) return false;
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return false;
  if (hasControlChar(value)) return false;
  return true;
}

/**
 * Returns `value` when it is a safe relative path, otherwise `fallback`.
 * Server-side analogue of getSafeNext — use at write time so hostile or
 * malformed link values collapse to a known-safe internal path.
 */
export function toSafeRelativePath(value: unknown, fallback: string): string {
  return isSafeRelativePath(value) ? value : fallback;
}

/** Zod schema accepting only safe same-origin relative paths. */
export const safeRelativePathSchema = z
  .string()
  .refine(isSafeRelativePath, {
    message: 'must be a same-origin relative path starting with "/" (no //, no backslash, no control chars)',
  });

export type SafeRelativePath = z.infer<typeof safeRelativePathSchema>;
