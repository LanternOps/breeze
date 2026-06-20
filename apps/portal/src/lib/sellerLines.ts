import type { SellerSnapshot } from './api';

export function sellerLines(address: SellerSnapshot['address']): string[] {
  if (!address) return [];
  const cityLine = [address.city, address.region, address.postalCode].filter(Boolean).join(', ');
  return [address.line1, address.line2, cityLine, address.country].filter(
    (s): s is string => !!s && s.trim().length > 0
  );
}
