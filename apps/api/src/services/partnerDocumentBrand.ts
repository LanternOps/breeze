// The MSP's own logo and colours for customer-facing documents (quotes).
//
// Partners set these under Settings → Partner → Branding, stored in
// `partners.settings.branding` — the same source report PDFs read
// (reportBranding.ts). The per-customer `portal_branding` row has logo/colour
// columns too, but nothing in the app writes them yet, so documents that read
// only that row printed in the default palette with a text wordmark even for
// fully branded partners (Q-2026-0027). The org row still wins field by field
// once it is populated.
//
// Pure: callers pass `partners.settings` from the partner row they already
// read under their own tenancy rules — this module never touches the DB.

export interface DocumentBrand {
  /** From the partner: a data:image/... or https:// URL, else null. An org
   *  portal_branding value overrides it as stored. */
  logoUrl: string | null;
  /** From the partner: #rgb / #rrggbb, else null. An org value overrides it as stored. */
  primaryColor: string | null;
  secondaryColor: string | null;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function hexOrNull(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim() : null;
}

/** Uploaded logos are re-encoded to data URLs by the Branding tab; a typed-in
 *  URL must be https so a customer's browser never loads it insecurely. */
function logoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return url.startsWith('data:image/') || url.startsWith('https://') ? url : null;
}

export function partnerDocumentBrand(settings: unknown): DocumentBrand {
  const branding = settings && typeof settings === 'object'
    ? (settings as { branding?: unknown }).branding
    : undefined;
  const b = branding && typeof branding === 'object' ? (branding as Record<string, unknown>) : {};
  return {
    logoUrl: logoOrNull(b.logoUrl),
    primaryColor: hexOrNull(b.primaryColor),
    secondaryColor: hexOrNull(b.secondaryColor),
  };
}

/** A customer org's portal_branding values win; the partner's branding fills
 *  whatever the org row leaves empty (null or blank). Org values pass through
 *  as stored — the web views have always rendered them directly — so only the
 *  partner fallback is validated here. */
export function resolveDocumentBrand(
  orgBrand: { logoUrl?: string | null; primaryColor?: string | null } | undefined,
  partnerSettings: unknown,
): DocumentBrand {
  const partner = partnerDocumentBrand(partnerSettings);
  return {
    logoUrl: orgBrand?.logoUrl?.trim() || partner.logoUrl,
    primaryColor: orgBrand?.primaryColor?.trim() || partner.primaryColor,
    secondaryColor: partner.secondaryColor,
  };
}
