/**
 * Validation for the `?next=` deep-link destination.
 *
 * Emailed portal links (an invoice, a proposal) land on the login wall when the
 * session has expired. Before this, the wall redirected to a bare `/login` and
 * the form always navigated to a fixed landing page, so the thing the customer
 * clicked was simply lost — the single most common way into the portal was also
 * the one the portal discarded.
 *
 * `next` arrives from the query string, so it is attacker-controllable and is a
 * classic open-redirect sink: `?next=https://evil.test` or `?next=//evil.test`
 * must never leave the origin. Only app-internal absolute paths pass, and only
 * for routes the portal actually owns.
 */

/** Route prefixes a customer can be sent back to after signing in. */
const ALLOWED_PREFIXES = ['/quotes', '/invoices', '/tickets', '/devices', '/assets', '/profile'];

/** Control characters can smuggle a scheme past naive prefix checks. */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

/**
 * Narrow a raw `next` value to a safe in-app path, or null when it is missing,
 * malformed, or points anywhere but a known portal route. Callers fall back to
 * the default landing page on null.
 *
 * NB: the returned path is app-relative (no base prefix). Pass it through
 * `withBase()` before navigating.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let value = raw.trim();
  if (!value) return null;

  // A browser may hand back a percent-encoded value; decode once so the checks
  // below see the real shape. A malformed escape sequence is simply rejected.
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }

  // Must be a plain absolute path. This rejects "https://evil.test",
  // "//evil.test" (protocol-relative), "javascript:..." and the backslash
  // variants some browsers normalise to "//".
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  if (CONTROL_OR_SPACE.test(value)) return null;

  const pathOnly = value.split(/[?#]/)[0];
  if (pathOnly.includes('..')) return null;

  const allowed = ALLOWED_PREFIXES.some(
    (prefix) => pathOnly === prefix || pathOnly.startsWith(`${prefix}/`)
  );
  return allowed ? value : null;
}
