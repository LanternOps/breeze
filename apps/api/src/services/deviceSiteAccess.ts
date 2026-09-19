import type { Context } from 'hono';
import type { UserPermissions } from './permissions';

/** Site authority only; an API key must never masquerade as full user permissions. */
export type DeviceSitePermissions = Pick<UserPermissions, 'allowedSiteIds'>;

export function resolvePrincipalSitePermissions(c: Context): DeviceSitePermissions | undefined {
  const apiKey = c.get('apiKey');
  if (apiKey) {
    // Human keys carry the creator's live restriction. Service-principal keys
    // intentionally have no site axis: undefined means unrestricted within
    // their authorized org, while [] denies every site.
    return { allowedSiteIds: apiKey.allowedSiteIds };
  }
  return c.get('permissions') as DeviceSitePermissions | undefined;
}

export function canAccessDeviceSite(
  permissions: DeviceSitePermissions | undefined,
  siteId: string | null | undefined,
): boolean {
  if (!permissions) return false;
  if (permissions.allowedSiteIds === undefined) return true;
  return typeof siteId === 'string' && permissions.allowedSiteIds.includes(siteId);
}
