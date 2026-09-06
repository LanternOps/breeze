import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalBranding } from '../../db/schema';
import type { PortalVisibilityFlag } from '../../services/portal/portalFlags';

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

// Strict W03 visibility gates (Task 3.3): unlike createPortalFeatureGate above
// (missing row/default = enabled), these fail CLOSED — a missing
// portal_branding row or an explicit false both return 403. Every existing
// org defaults to false on all five columns (Task 3.1), so this is the
// correct default-deny posture for newly introduced portal sections.
const STRICT_PORTAL_FEATURES: Record<PortalVisibilityFlag, { error: string; code: string }> = {
  enableDashboard: {
    error: 'Dashboard is not enabled for this portal',
    code: 'PORTAL_DASHBOARD_DISABLED',
  },
  enableSecurity: {
    error: 'Security visibility is not enabled for this portal',
    code: 'PORTAL_SECURITY_DISABLED',
  },
  enableBackups: {
    error: 'Backup visibility is not enabled for this portal',
    code: 'PORTAL_BACKUPS_DISABLED',
  },
  enableReports: {
    error: 'Reports are not enabled for this portal',
    code: 'PORTAL_REPORTS_DISABLED',
  },
  enableSupportUsage: {
    error: 'Support usage is not enabled for this portal',
    code: 'PORTAL_SUPPORT_USAGE_DISABLED',
  },
};

export function createPortalFeatureGateStrict(flag: PortalVisibilityFlag): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('portalAuth');
    if (!auth) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const [row] = await db
      .select({ [flag]: portalBranding[flag] })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, auth.user.orgId))
      .limit(1);

    if (row?.[flag] !== true) {
      return c.json(STRICT_PORTAL_FEATURES[flag], 403);
    }

    return next();
  };
}
