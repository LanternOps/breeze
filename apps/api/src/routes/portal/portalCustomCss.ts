import { eq } from 'drizzle-orm';
import { portalCustomCssSchema } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { captureException } from '../../services/sentry';

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

type PartnerCssRead = { css: string | null; rejected: boolean };

function readPartnerPortalCustomCss(settings: unknown): PartnerCssRead {
  const none: PartnerCssRead = { css: null, rejected: false };
  if (!settings || typeof settings !== 'object') return none;
  const branding = (settings as { branding?: unknown }).branding;
  if (!branding || typeof branding !== 'object') return none;
  const css = (branding as { customCss?: unknown }).customCss;
  if (typeof css !== 'string' || !css.trim()) return none;
  // The write schema itself, so the read side can never disagree with what a
  // save accepts (including how size is counted).
  if (!portalCustomCssSchema.safeParse(css).success) return { css: null, rejected: true };
  return { css: css.trim(), rejected: false };
}

/**
 * The partner's Custom CSS from its settings JSON, or null when there is none
 * or the stored value fails the portal CSS rules. The partner write path
 * validates with the same schema as the org path, but rows saved before it did
 * can hold anything, so a failing value is dropped here instead of reaching
 * every child org's portal.
 */
export function partnerPortalCustomCss(settings: unknown): string | null {
  return readPartnerPortalCustomCss(settings).css;
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

// One warning per partner per process: the lookup runs on every portal page
// view, and the stored value only changes when the partner saves again (which
// now validates). Bounded by the number of partners holding such a value.
const warnedPartners = new Set<string>();

export type PartnerPortalDefaults = {
  /** The partner's validated Custom CSS, or null. */
  customCss: string | null;
  /** The raw `partners.settings`, for resolveDocumentBrand / partnerDocumentBrand
   *  (#9673), which validate what they read. Null when the partner is unknown. */
  settings: unknown;
  /** True when the lookup failed, so the answer lacks the partner's defaults
   *  and must not be cached. */
  degraded: boolean;
};

const NO_PARTNER_DEFAULTS: PartnerPortalDefaults = { customCss: null, settings: null, degraded: false };

/**
 * What the partner that owns `orgId` contributes to its portal: Custom CSS and
 * the Branding the logo and colours fall back to. `partners` is a partner-axis
 * table the portal user's org context cannot read, so this runs in system
 * scope, keyed only by the org id the caller already resolved (the session org,
 * or the org behind a verified custom domain).
 */
export async function loadPartnerPortalDefaults(orgId: string): Promise<PartnerPortalDefaults> {
  let row: { partnerId: string; settings: unknown } | undefined;
  try {
    [row] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ partnerId: partners.id, settings: partners.settings })
          .from(organizations)
          .innerJoin(partners, eq(partners.id, organizations.partnerId))
          .where(eq(organizations.id, orgId))
          .limit(1),
      ),
    );
  } catch (err) {
    // Partner defaults must not take the branding response (the org's own
    // values, visibility flags) down with them: degrade to the org's row alone.
    captureException(err, undefined, { area: 'portal-branding-partner-css' });
    return { ...NO_PARTNER_DEFAULTS, degraded: true };
  }
  if (!row) return NO_PARTNER_DEFAULTS;
  const { css, rejected } = readPartnerPortalCustomCss(row.settings);
  if (rejected && !warnedPartners.has(row.partnerId)) {
    warnedPartners.add(row.partnerId);
    // Never the CSS itself: the id is enough to find and fix the value.
    console.warn('[portal] partner Custom CSS fails the portal CSS rules; not applied', { partnerId: row.partnerId });
  }
  return { customCss: css, settings: row.settings, degraded: false };
}
