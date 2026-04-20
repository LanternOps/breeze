/**
 * C2C route helpers — org resolution and secret masking
 */

export function resolveScopedOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId?: string | null;
    accessibleOrgIds?: string[] | null;
    canAccessOrg?: (orgId: string) => boolean;
  },
  requestedOrgId?: string | null
): string | null {
  if (requestedOrgId) {
    if (auth.canAccessOrg && !auth.canAccessOrg(requestedOrgId)) return null;
    if (
      !auth.canAccessOrg &&
      Array.isArray(auth.accessibleOrgIds) &&
      !auth.accessibleOrgIds.includes(requestedOrgId)
    ) {
      return null;
    }
    return requestedOrgId;
  }

  if (auth.orgId) return auth.orgId;

  if (
    auth.scope === 'partner' &&
    Array.isArray(auth.accessibleOrgIds) &&
    auth.accessibleOrgIds.length === 1
  ) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  return null;
}

/**
 * Mask a secret string, showing only the last 4 characters.
 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}
