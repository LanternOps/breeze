export interface AddressParts {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface FormatAddressOptions {
  /** The viewer's own country (e.g. the partner's): a matching `country` is
   *  left off, because "· US" on every customer of a US MSP is noise (#9024).
   *  Compared case-insensitively. A country-only address still renders it. */
  homeCountry?: string | null;
}

/**
 * One-line address: `line1, line2 · city, region postalCode · country`.
 * Empty (or non-string) parts are skipped without leaving separators. The
 * country is left off when it equals `options.homeCountry` and at least one
 * other segment remains.
 */
export function formatAddress(parts: AddressParts | null | undefined, options: FormatAddressOptions = {}): string {
  if (!parts) return '';

  const street = [clean(parts.line1), clean(parts.line2)].filter(Boolean).join(', ');

  const cityRegion = [clean(parts.city), clean(parts.region)].filter(Boolean).join(', ');
  const locality = [cityRegion, clean(parts.postalCode)].filter(Boolean).join(' ');

  const country = clean(parts.country);
  const home = clean(options.homeCountry);
  const isHome = country !== '' && home !== '' && country.toUpperCase() === home.toUpperCase();
  const rest = [street, locality].filter(Boolean);
  if (isHome && rest.length > 0) return rest.join(' · ');
  return [...rest, country].filter(Boolean).join(' · ');
}
