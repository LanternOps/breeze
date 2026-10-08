import { Hono } from 'hono';
import { requireScope, requirePermission } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import { getLocationSuggestionSettings, LOCATION_SUGGESTION_DEFAULTS } from '../../services/timeSuggestionSettings';
import { listLocationSites } from '../../services/siteLocation';

// #4186. One call hands the phone the partner flag, the default radius, whether
// it may pin a site, and its candidate sites. Same gates as every time-entry
// route: partner|system scope + TIME_ENTRIES_READ; the hub applies authMiddleware.
export const locationSitesRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action);

locationSitesRoutes.get('/', scopes, readPerm, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;

  const settings = auth.partnerId
    ? await getLocationSuggestionSettings(auth.partnerId)
    : { ...LOCATION_SUGGESTION_DEFAULTS };
  if (!settings.enabled) {
    return c.json({
      enabled: false,
      defaultRadiusM: settings.defaultRadiusM,
      canSetLocation: false,
      sites: [],
      truncated: false,
    });
  }

  const canSetLocation = perms ? hasPermission(perms, 'sites', 'set_location') : false;
  const canReadSites = perms ? hasPermission(perms, 'sites', 'read') : false;
  const listed = canReadSites
    ? await listLocationSites({ accessibleOrgIds: auth.accessibleOrgIds, allowedSiteIds: perms?.allowedSiteIds })
    : { sites: [], truncated: false };

  return c.json({
    enabled: true,
    defaultRadiusM: settings.defaultRadiusM,
    canSetLocation,
    sites: listed.sites,
    truncated: listed.truncated,
  });
});
