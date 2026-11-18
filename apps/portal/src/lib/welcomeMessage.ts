import type { BrandingConfig } from './api';
import { portalLandingPath } from './landing';

/**
 * The org's portal welcome message (Settings > Organization > Customer portal),
 * normalised for display, or null when there is nothing to show (#9675).
 *
 * It is plain text the MSP typed into a textarea: the caller renders it as an
 * escaped text node with `white-space: pre-line` so line breaks survive. It is
 * never HTML — do not hand it to `set:html` or `dangerouslySetInnerHTML`.
 */
export function portalWelcomeMessage(
  branding: Pick<BrandingConfig, 'welcomeMessage'>
): string | null {
  const text = branding.welcomeMessage?.replace(/\r\n?/g, '\n').trim();
  return text ? text : null;
}

/**
 * The welcome message for the signed-in shell, shown only on the customer's
 * landing page — the page they arrive on after signing in, which is the
 * dashboard when the org turned it on and the proposals list otherwise
 * (lib/landing.ts). Every other page gets null so it is a greeting, not a
 * banner repeated on every screen.
 */
export function landingWelcomeMessage(
  branding: Pick<BrandingConfig, 'welcomeMessage' | 'enableDashboard'>,
  pathname: string
): string | null {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (normalizedPath !== portalLandingPath(branding)) return null;
  return portalWelcomeMessage(branding);
}
