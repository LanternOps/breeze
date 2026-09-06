import type { BrandingConfig } from './api';

export interface PortalNavItem {
  label: string;
  href: string;
}

/**
 * Nav entries for the portal shell, honoring per-org feature toggles from the
 * branding payload (#2345, #4562). Order matters: a portal customer comes to
 * approve a proposal or pay a bill, so those lead once Dashboard (opt-in) is
 * out of the way.
 *
 * "Proposals", not "Quotes": every page this leads to is titled Proposal, and
 * a customer does not connect the two labels.
 *
 * Fail-open flags (existing behavior, unchanged): Tickets and Devices stay
 * visible unless explicitly disabled — the API column defaults to true /
 * self-service defaults on, and the server-side 403 gate on the underlying
 * routes is the real enforcement.
 *
 * Fail-closed flags (new, #4562): Dashboard, Security, Backups, Reports, and
 * Equipment (asset checkout) only earn a slot once explicitly turned on. A
 * missing branding row or an undefined flag hides them — this is new surface
 * area with no legacy "always on" expectation to preserve, unlike Tickets.
 * Equipment stays fail-closed for the reason it always was: the assets route
 * reads the same `devices` table as `/devices` minus a column, so without
 * checkout it is a second nav word for the same machines.
 */
export function buildPortalNavItems(
  branding: Pick<
    BrandingConfig,
    | 'enableTickets'
    | 'enableAssetCheckout'
    | 'enableSelfService'
    | 'enablePasswordReset'
    | 'enableDashboard'
    | 'enableSecurity'
    | 'enableBackups'
    | 'enableReports'
    | 'enableSupportUsage'
  >
): PortalNavItem[] {
  return [
    branding.enableDashboard === true
      ? { href: '/dashboard', label: 'Dashboard' }
      : null,
    { href: '/quotes', label: 'Proposals' },
    { href: '/invoices', label: 'Invoices' },
    branding.enableTickets !== false
      ? { href: '/tickets', label: 'Support' }
      : null,
    branding.enableSelfService !== false
      ? { href: '/devices', label: 'Devices' }
      : null,
    branding.enableSecurity === true
      ? { href: '/security', label: 'Security' }
      : null,
    branding.enableBackups === true
      ? { href: '/backups', label: 'Backups' }
      : null,
    branding.enableReports === true
      ? { href: '/reports', label: 'Reports' }
      : null,
    branding.enableAssetCheckout === true
      ? { href: '/assets', label: 'Equipment' }
      : null,
    { href: '/profile', label: 'Profile' }
  ].filter((item): item is PortalNavItem => item !== null);
}
