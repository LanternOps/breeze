import type { BrandingConfig } from './api';

export interface PortalNavItem {
  label: string;
  href: string;
}

const ALL_NAV_ITEMS: PortalNavItem[] = [
  { label: 'Devices', href: '/devices' },
  { label: 'Tickets', href: '/tickets' },
  { label: 'Quotes', href: '/quotes' },
  { label: 'Invoices', href: '/invoices' },
  { label: 'Assets', href: '/assets' },
  { label: 'Profile', href: '/profile' }
];

/**
 * Nav entries for the portal shell, honoring per-org feature toggles from the
 * branding payload (#2345). Fail-OPEN: a missing branding row / undefined flag
 * keeps Tickets visible — the API column defaults to true, and the server-side
 * 403 gate on `/portal/tickets/*` is the real enforcement. Only an explicit
 * `enableTickets: false` hides the entry.
 */
export function buildPortalNavItems(
  branding: Pick<BrandingConfig, 'enableTickets'>
): PortalNavItem[] {
  return ALL_NAV_ITEMS.filter(
    (item) => item.href !== '/tickets' || branding.enableTickets !== false
  );
}
