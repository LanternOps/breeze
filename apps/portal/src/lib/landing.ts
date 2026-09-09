import type { BrandingConfig } from './api';

/**
 * Where a signed-in customer belongs. They come to read a proposal or pay a
 * bill; `/dashboard` is only the landing page when the org has explicitly
 * turned it on for the portal (fail-closed — a missing/undefined flag lands
 * on `/quotes`, same as every other new visibility flag).
 */
export function portalLandingPath(
  branding: Pick<BrandingConfig, 'enableDashboard'>
): '/dashboard' | '/quotes' {
  return branding.enableDashboard === true ? '/dashboard' : '/quotes';
}

/**
 * Where a signed-in customer belongs, accounting for a disabled account
 * (sweep 2026-09-08 G5-6). `/quotes` is the one signed-in page no visibility
 * flag can turn off (lib/visibilityGate.ts), so a disabled account bounced
 * from `/login` used to land right back on a page that immediately 403'd —
 * the middleware's login-redirect guard must check this FIRST, before
 * consulting branding at all.
 */
export function resolveAuthenticatedLanding(status: {
  accountDisabled: boolean;
  branding: Pick<BrandingConfig, 'enableDashboard'>;
}): '/dashboard' | '/quotes' | '/account-disabled' {
  if (status.accountDisabled) {
    return '/account-disabled';
  }
  return portalLandingPath(status.branding);
}
