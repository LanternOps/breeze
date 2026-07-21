import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalBranding } from '../../db/schema';

type PortalBooleanSetting = 'enableAssetCheckout' | 'enableSelfService';

type PortalFeatureGateOptions = {
  setting: PortalBooleanSetting;
  error: string;
  code: string;
};

/**
 * Build an org-scoped portal feature gate. A missing settings row preserves the
 * schema default behavior (enabled); only an explicit false disables access.
 */
export function createPortalFeatureGate({ setting, error, code }: PortalFeatureGateOptions): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('portalAuth');
    if (!auth) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const [row] = await db
      .select({ [setting]: portalBranding[setting] })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, auth.user.orgId))
      .limit(1);

    if (row?.[setting] === false) {
      return c.json({ error, code }, 403);
    }

    return next();
  };
}

export const portalAssetCheckoutEnabledMiddleware = createPortalFeatureGate({
  setting: 'enableAssetCheckout',
  error: 'Asset checkout is not enabled for this portal',
  code: 'PORTAL_ASSET_CHECKOUT_DISABLED',
});

export const portalSelfServiceEnabledMiddleware = createPortalFeatureGate({
  setting: 'enableSelfService',
  error: 'Self-service device access is not enabled for this portal',
  code: 'PORTAL_SELF_SERVICE_DISABLED',
});
