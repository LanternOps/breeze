import type { BrandingConfig } from './api';

export interface PortalNavItem {
  label: string;
  href: string;
}

// Order matters: a portal customer comes to approve a proposal or pay a bill,
// so those lead. Devices is a read-only inventory of the MSP's work and used to
// be both the first nav entry and the landing page.
//
// "Proposals", not "Quotes": every page this leads to is titled Proposal, and a
// customer does not connect the two labels.
const ALL_NAV_ITEMS: PortalNavItem[] = [
  { label: 'Proposals', href: '/quotes' },
  { label: 'Invoices', href: '/invoices' },
  { label: 'Support', href: '/tickets' },
  { label: 'Devices', href: '/devices' },
  { label: 'Equipment', href: '/assets' },
  { label: 'Profile', href: '/profile' }
];

/**
 * Nav entries for the portal shell, honoring per-org feature toggles from the
 * branding payload (#2345). Fail-OPEN: a missing branding row / undefined flag
 * keeps Tickets visible — the API column defaults to true, and the server-side
 * 403 gate on `/portal/tickets/*` is the real enforcement. Only an explicit
 * `enableTickets: false` hides the entry.
 *
 * Equipment (`/assets`) is gated the same way, but fail-CLOSED. The assets route
 * reads the same `devices` table as `/devices` minus a column, so with checkout
 * switched off the entry is a second word for the same machines and a customer
 * cannot guess which one holds their thing. It only earns a slot once checkout
 * is actually enabled, which is the one thing that makes it distinct.
 */
export function buildPortalNavItems(
  branding: Pick<BrandingConfig, 'enableTickets' | 'enableAssetCheckout'>
): PortalNavItem[] {
  return ALL_NAV_ITEMS.filter((item) => {
    if (item.href === '/tickets') return branding.enableTickets !== false;
    if (item.href === '/assets') return branding.enableAssetCheckout === true;
    return true;
  });
}
