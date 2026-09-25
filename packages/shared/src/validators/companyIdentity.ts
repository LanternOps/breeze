// Shared tolerant reader for a partner's "company details" (PartnerSettings.contact /
// PartnerSettings.address, stored in partners.settings jsonb — see
// packages/shared/src/types/index.ts PartnerSettings). Used as the second fallback tier
// (after the billing letterhead override) when freezing a document's seller identity
// (apps/api/src/services/sellerSnapshot.ts buildSellerSnapshot) and by the web billing
// letterhead card to preview what an unset override would inherit.
//
// Parsing is FIELD-LEVEL and never throws: legacy rows may have a malformed shape (wrong
// type on one field, or `settings`/`settings.contact`/`settings.address` not an object at
// all), and one bad field must not discard otherwise-valid siblings.

export interface CompanyContactDetails {
  name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

export interface CompanyAddressDetails {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

/** A non-string, or whitespace-only string, is treated as absent. */
function field(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Reads PartnerSettings['contact'] tolerantly. */
export function parseCompanyContact(raw: unknown): CompanyContactDetails {
  const r = asRecord(raw);
  return {
    name: field(r.name),
    email: field(r.email),
    phone: field(r.phone),
    website: field(r.website),
  };
}

/** Reads PartnerSettings['address'] tolerantly. street1/street2 map to line1/line2 to
 *  match SellerSnapshot['address'] / BillToAddress's key shape (sellerSnapshot.ts). */
export function parseCompanyAddress(raw: unknown): CompanyAddressDetails {
  const r = asRecord(raw);
  return {
    line1: field(r.street1),
    line2: field(r.street2),
    city: field(r.city),
    region: field(r.region),
    postalCode: field(r.postalCode),
    country: field(r.country),
  };
}

export function isCompanyAddressBlank(a: CompanyAddressDetails): boolean {
  return a.line1 === null && a.line2 === null && a.city === null
    && a.region === null && a.postalCode === null && a.country === null;
}
