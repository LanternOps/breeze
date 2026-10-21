import type { DocumentBillToAddress, DocumentSellerSnapshot } from './dto';

/** A postal address as printable lines: line1, line2, "city, region, postal
 *  code", country; blanks dropped. One implementation for seller and bill-to. */
export function documentAddressLines(a: DocumentBillToAddress | null | undefined): string[] {
  if (!a) return [];
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ');
  return [a.line1, a.line2, cityLine, a.country].filter((s): s is string => !!s && s.trim().length > 0);
}

/** The seller's postal address as printable lines: line1, line2,
 *  "city, region, postal code", country; blanks dropped. Moved from the API's
 *  `sellerAddressLines` (which re-exports this) so the screen and the PDF print
 *  the same lines. */
export function documentSellerLines(seller: Pick<DocumentSellerSnapshot, 'address'> | null | undefined): string[] {
  return documentAddressLines(seller?.address);
}
