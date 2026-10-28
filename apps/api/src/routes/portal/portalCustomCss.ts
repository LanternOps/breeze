import { eq } from 'drizzle-orm';
import { findUnsafePortalCssPattern, PORTAL_CUSTOM_CSS_MAX_LENGTH } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';

/**
 * Portal Custom CSS resolver (#9674).
 *
 * The portal stylesheet is layered, not inherited: the partner's Custom CSS
 * (Settings > Partner > Branding, `partners.settings.branding.customCss`)
 * applies to every child org's portal, and the org's own Custom CSS
 * (`portal_branding.custom_css`) comes after it, so an org rule overrides a
 * partner rule by normal cascade order. Both /portal/branding projections
 * return the combined text as `customCss`; the portal escapes and injects it
 * unchanged (apps/portal/src/lib/customCss.ts).
 */

/**
 * The partner's Custom CSS from its settings JSON, or null when there is none
 * or the stored value fails the portal CSS rules. The partner write path
 * validates with the same rules as the org path, but rows saved before it did
 * can hold anything, so a failing value is dropped here instead of reaching
 * every child org's portal.
 */
export function partnerPortalCustomCss(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const branding = (settings as { branding?: unknown }).branding;
  if (!branding || typeof branding !== 'object') return null;
  const css = (branding as { customCss?: unknown }).customCss;
  if (typeof css !== 'string') return null;
  const trimmed = css.trim();
  if (!trimmed) return null;
  if (css.length > PORTAL_CUSTOM_CSS_MAX_LENGTH) return null;
  if (findUnsafePortalCssPattern(trimmed) !== null) return null;
  return trimmed;
}

/**
 * Partner CSS first, org CSS second, so the org's rules win the cascade.
 * Null when neither level has CSS.
 */
export function combinePortalCustomCss(
  partnerCss: string | null | undefined,
  orgCss: string | null | undefined,
): string | null {
  const parts = [partnerCss, orgCss]
    .map((css) => css?.trim() ?? '')
    .filter((css) => css.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * The Custom CSS of the partner that owns `orgId`. `partners` is a
 * partner-axis table the portal user's org context cannot read, so this runs
 * in system scope, keyed only by the org id the caller already resolved
 * (the session org, or the org behind a verified custom domain).
 */
export async function loadPartnerPortalCustomCss(orgId: string): Promise<string | null> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ settings: partners.settings })
        .from(organizations)
        .innerJoin(partners, eq(partners.id, organizations.partnerId))
        .where(eq(organizations.id, orgId))
        .limit(1),
    ),
  );
  return partnerPortalCustomCss(row?.settings);
}
