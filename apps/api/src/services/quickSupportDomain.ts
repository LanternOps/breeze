import { eq } from 'drizzle-orm';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { partners } from '../db/schema';

/**
 * Per-partner custom Quick Support domain (`partners.settings.quickSupportDomain`).
 *
 * An MSP can point a hostname of their own (e.g. `support.yourmsp.com`) at the
 * Breeze web server; when set, the landing URL minted at support-session
 * creation uses it instead of the global PUBLIC_WEB_URL. Storage is a single
 * key inside the existing `partners.settings` JSONB — deliberately no new
 * table: the value is one short string, partner-owned by construction (the
 * partners row IS the partner axis), and it rides the write path
 * (PATCH /orgs/partners/me) and RLS policy that already exist.
 *
 * DNS/TLS routing for the hostname is the operator's responsibility. Breeze
 * neither verifies the record nor provisions a certificate — see the settings
 * card's helper text.
 */

/** Max length of a DNS name (RFC 1035). */
export const QUICK_SUPPORT_DOMAIN_MAX_LENGTH = 253;

/**
 * Bare hostname only: lowercase labels, at least two of them, no scheme, port,
 * path, userinfo or whitespace. Anything looser would be interpolated straight
 * into `https://<value>/quick?code=…`, where a `/`, `@` or `?` would silently
 * re-target the link at a host the partner did not configure.
 */
const QUICK_SUPPORT_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const QUICK_SUPPORT_DOMAIN_ERROR =
  'quickSupportDomain must be a bare hostname such as support.example.com — no scheme, port, path, or spaces';

/** True when `value` is a hostname safe to interpolate into a landing URL. */
export function isValidQuickSupportDomain(value: string): boolean {
  return value.length > 0
    && value.length <= QUICK_SUPPORT_DOMAIN_MAX_LENGTH
    && QUICK_SUPPORT_DOMAIN_PATTERN.test(value);
}

/**
 * Canonical write-time form: trimmed and lowercased; empty (or whitespace-only)
 * clears the setting. Returns `null` for "no custom domain"; the caller is
 * responsible for rejecting a non-null value that fails
 * `isValidQuickSupportDomain`.
 */
export function normalizeQuickSupportDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

/**
 * Read the partner's configured Quick Support domain, or `null` when unset or
 * unusable.
 *
 * Defense in depth: the stored value is re-validated here before any caller
 * interpolates it into a URL, so a row that predates the write-path validation
 * (or was written by some other path) degrades to the PUBLIC_WEB_URL fallback
 * rather than minting a link to an attacker-chosen host.
 *
 * `partnerId` must come from the verified auth context — the read runs under
 * `readWithPartnerAxisVisibility` (system context) because an org-scoped or
 * agent context would silently return zero rows for a partner-axis table.
 */
export async function getPartnerQuickSupportDomain(partnerId: string): Promise<string | null> {
  const [row] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1)
  );

  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  const raw = settings.quickSupportDomain;
  if (typeof raw !== 'string') return null;

  const normalized = normalizeQuickSupportDomain(raw);
  if (!normalized || !isValidQuickSupportDomain(normalized)) return null;
  return normalized;
}
