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
