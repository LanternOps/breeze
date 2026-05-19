import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

export { getPagination } from '../../utils/pagination';

/**
 * SR-008 (systemic twin of the MCP breeze://devices/{id} leak): device-detail
 * endpoints spread the full `devices` row to the client. These columns are
 * credential verifiers / mTLS material and must never be serialized to any
 * client. `getDeviceWithOrgCheck` still returns the full row so internal
 * handler logic keeps working; strip only at the response boundary.
 */
const SENSITIVE_DEVICE_FIELDS = [
  'agentTokenHash', 'tokenIssuedAt',
  'previousTokenHash', 'previousTokenExpiresAt',
  'watchdogTokenHash', 'watchdogTokenIssuedAt',
  'previousWatchdogTokenHash', 'previousWatchdogTokenExpiresAt',
  'helperTokenHash', 'helperTokenIssuedAt',
  'previousHelperTokenHash', 'previousHelperTokenExpiresAt',
  'mtlsCertSerialNumber', 'mtlsCertExpiresAt', 'mtlsCertIssuedAt', 'mtlsCertCfId',
] as const;

export function stripSensitiveDeviceFields<T extends Record<string, unknown>>(
  device: T
): Omit<T, (typeof SENSITIVE_DEVICE_FIELDS)[number]> {
  const clone = { ...device };
  for (const field of SENSITIVE_DEVICE_FIELDS) {
    delete clone[field];
  }
  return clone;
}

export async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

export async function getDeviceWithOrgCheck(
  deviceId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}
