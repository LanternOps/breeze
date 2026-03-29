/**
 * C2C route helpers — org resolution and secret masking
 */

export function resolveScopedOrgId(auth: {
  scope: 'system' | 'partner' | 'organization';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
}): string | null {
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
