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

/**
 * One-line address: `line1, line2 · city, region postalCode · country`.
 * Empty (or non-string) parts are skipped without leaving separators.
 */
export function formatAddress(parts: AddressParts | null | undefined): string {
  if (!parts) return '';

  const street = [clean(parts.line1), clean(parts.line2)].filter(Boolean).join(', ');

  const cityRegion = [clean(parts.city), clean(parts.region)].filter(Boolean).join(', ');
  const locality = [cityRegion, clean(parts.postalCode)].filter(Boolean).join(' ');

  return [street, locality, clean(parts.country)].filter(Boolean).join(' · ');
}
