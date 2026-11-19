// The one resolver for a partner's document page size (#12097) — quotes,
// invoices, agreement certificates and reports all print on the size this
// returns, and the Billing → Documents form shows its region default.
//
// Precedence:
//   1. partners.document_page_size — the partner's explicit choice. NULL means
//      "never chosen"; rows that existed before #12097 all carry a value and
//      keep it (it cannot be told apart from a deliberate choice).
//   2. The country on the billing letterhead (partners.billing_address_country),
//      the address documents print.
//   3. The company-details country (partners.settings.address.country), the
//      letterhead's own fallback tier (sellerSnapshot.ts).
//   4. The deployment fallback, supplied by the caller: the API passes A4 on
//      the EU deployment and Letter elsewhere.
//
// Region rule (owner decision on #12097): Letter for the US and Canada, A4
// everywhere else.
//
// Pure and React-free so the API and the web form share it; the deployment
// fallback is a parameter because only the server knows its region.

import type { DocumentPageSize } from '../types/publicQuote';

export type DocumentPageSizeSource = 'partner' | 'billing_address' | 'company_address' | 'deployment_region';
export type DocumentPageSizeDefaultSource = Exclude<DocumentPageSizeSource, 'partner'>;

const LETTER_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA']);

/** Page size for an ISO 3166-1 alpha-2 country; null when the country is unknown. */
export function pageSizeForCountry(country: unknown): DocumentPageSize | null {
  if (typeof country !== 'string') return null;
  const code = country.trim().toUpperCase();
  if (code === '') return null;
  return LETTER_COUNTRIES.has(code) ? 'letter' : 'a4';
}

/** The stored explicit choice, or null when the partner never chose (or the value is unrecognised). */
export function explicitDocumentPageSize(raw: unknown): DocumentPageSize | null {
  return raw === 'letter' || raw === 'a4' ? raw : null;
}

export interface PartnerPageSizeInput {
  documentPageSize?: unknown;
  billingAddressCountry?: unknown;
  settings?: unknown;
}

function companyCountry(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const address = (settings as { address?: unknown }).address;
  if (!address || typeof address !== 'object' || Array.isArray(address)) return undefined;
  return (address as { country?: unknown }).country;
}

/** What the partner prints on when it has not chosen: its region default. */
export function partnerDocumentPageSizeDefault(
  partner: PartnerPageSizeInput | null | undefined,
  deploymentFallback: DocumentPageSize,
): { pageSize: DocumentPageSize; source: DocumentPageSizeDefaultSource } {
  const fromBilling = pageSizeForCountry(partner?.billingAddressCountry);
  if (fromBilling) return { pageSize: fromBilling, source: 'billing_address' };
  const fromCompany = pageSizeForCountry(companyCountry(partner?.settings));
  if (fromCompany) return { pageSize: fromCompany, source: 'company_address' };
  return { pageSize: deploymentFallback, source: 'deployment_region' };
}

/** The page size the partner's documents print on. */
export function resolvePartnerDocumentPageSize(
  partner: PartnerPageSizeInput | null | undefined,
  deploymentFallback: DocumentPageSize,
): { pageSize: DocumentPageSize; source: DocumentPageSizeSource } {
  const explicit = explicitDocumentPageSize(partner?.documentPageSize);
  if (explicit) return { pageSize: explicit, source: 'partner' };
  return partnerDocumentPageSizeDefault(partner, deploymentFallback);
}
