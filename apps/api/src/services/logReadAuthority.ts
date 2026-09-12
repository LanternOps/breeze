import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../db';
import { devices, users } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { hasSatisfiedMfa, isInteractiveUserSession } from '../middleware/auth';
import { ENABLE_2FA } from '../routes/auth/schemas';
import { canAccessOrg, getUserPermissions, hasPermission, PERMISSIONS } from './permissions';

export interface LogReadAuthorityEnvelope {
  version: 1;
  requesterId: string;
  partnerId: string | null;
  orgId: string;
  scope: 'system' | 'partner' | 'organization';
  siteIds: string[] | null;
  authEpoch: number;
  mfaEpoch: number;
  mfaClaim: boolean;
  fingerprint: string;
}

type UnsignedEnvelope = Omit<LogReadAuthorityEnvelope, 'fingerprint'>;

function normalizedSiteIds(siteIds: string[] | undefined): string[] | null {
  return siteIds === undefined ? null : Array.from(new Set(siteIds)).sort();
}

/**
 * Unkeyed integrity check, NOT a signature: it only proves the envelope's
 * fields have not been edited in transit through the queue. Authenticity comes
 * entirely from `revalidateLogReadAuthority`, which re-reads the live `users`
 * row (status, partner, auth/MFA epochs) and re-runs `canAccessOrg` +
 * `devices:execute` against uncached permissions before any read is authorized.
 */
function fingerprintAuthority(authority: UnsignedEnvelope): string {
  return createHash('sha256').update(JSON.stringify(authority)).digest('hex');
}

/** Thrown when a caller may not open a deferred log read. Routes map this to 403. */
export class LogReadAuthorityDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogReadAuthorityDeniedError';
  }
}

export function captureLogReadAuthority(auth: AuthContext, orgId: string): LogReadAuthorityEnvelope {
  if (!isInteractiveUserSession(auth) || !auth.canAccessOrg(orgId) || !hasSatisfiedMfa(auth)) {
    throw new LogReadAuthorityDeniedError('Log detection authority denied');
  }
  const authEpoch = auth.token?.aep;
  const mfaEpoch = auth.token?.mep;
  if (!Number.isSafeInteger(authEpoch) || !Number.isSafeInteger(mfaEpoch)) {
    throw new LogReadAuthorityDeniedError('Log detection authority is missing current authentication state');
  }
  const unsigned: UnsignedEnvelope = {
    version: 1,
    requesterId: auth.user.id,
    partnerId: auth.partnerId,
    orgId,
    scope: auth.scope,
    siteIds: normalizedSiteIds(auth.allowedSiteIds),
    authEpoch: authEpoch!,
    mfaEpoch: mfaEpoch!,
    mfaClaim: auth.token?.mfa === true,
  };
  return { ...unsigned, fingerprint: fingerprintAuthority(unsigned) };
}

function parseEnvelope(value: unknown): LogReadAuthorityEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LogReadAuthorityEnvelope>;
  if (candidate.version !== 1
    || typeof candidate.requesterId !== 'string'
    || (candidate.partnerId !== null && typeof candidate.partnerId !== 'string')
    || typeof candidate.orgId !== 'string'
    || !['system', 'partner', 'organization'].includes(String(candidate.scope))
    || (candidate.siteIds !== null && (!Array.isArray(candidate.siteIds) || candidate.siteIds.some((id) => typeof id !== 'string')))
    || !Number.isSafeInteger(candidate.authEpoch)
    || !Number.isSafeInteger(candidate.mfaEpoch)
    || typeof candidate.mfaClaim !== 'boolean'
    || typeof candidate.fingerprint !== 'string') return null;
  const unsigned: UnsignedEnvelope = {
    version: 1,
    requesterId: candidate.requesterId,
    partnerId: candidate.partnerId,
    orgId: candidate.orgId,
    scope: candidate.scope as UnsignedEnvelope['scope'],
    siteIds: candidate.siteIds === null ? null : Array.from(new Set(candidate.siteIds)).sort(),
    authEpoch: candidate.authEpoch!,
    mfaEpoch: candidate.mfaEpoch!,
    mfaClaim: candidate.mfaClaim,
  };
  if (candidate.fingerprint !== fingerprintAuthority(unsigned)) return null;
  return { ...unsigned, fingerprint: candidate.fingerprint };
}

function intersectCeilings(captured: string[] | null, live: string[] | undefined): string[] | null {
  if (captured === null && live === undefined) return null;
  if (captured === null) return Array.from(new Set(live!)).sort();
  if (live === undefined) return captured;
  const liveSet = new Set(live);
  return captured.filter((id) => liveSet.has(id));
}

async function deviceIdsForSites(orgId: string, siteIds: string[] | null): Promise<string[] | null> {
  if (siteIds === null) return null;
  if (siteIds.length === 0) return [];
  const rows = await db.select({ id: devices.id }).from(devices).where(and(
    eq(devices.orgId, orgId),
    inArray(devices.siteId, siteIds),
  ));
  return rows.map((row) => row.id);
}

export async function resolveCurrentLogReadDeviceIds(auth: AuthContext, orgId?: string): Promise<string[] | null> {
  // Partner/system callers are fleet-wide unless they explicitly address one
  // organization. They have no single auth.orgId to bind, and treating that
  // absence as deny-all silently empties every otherwise-authorized fleet read.
  if (orgId === undefined && (auth.scope === 'partner' || auth.scope === 'system')) {
    return null;
  }
  const boundOrgId = orgId ?? auth.orgId;
  if (!boundOrgId || !auth.canAccessOrg(boundOrgId)) return [];
  return deviceIdsForSites(boundOrgId, currentLogReadSiteCeiling(auth, boundOrgId));
}

export function currentLogReadSiteCeiling(auth: AuthContext, orgId: string): string[] | null {
  if (!auth.canAccessOrg(orgId)) return [];
  return normalizedSiteIds(auth.allowedSiteIds);
}

export function intersectLogReadSiteCeilings(
  left: string[] | null,
  right: string[] | null,
): string[] | null {
  if (left === null) return right;
  if (right === null) return left;
  const rightSet = new Set(right);
  return left.filter((id) => rightSet.has(id));
}

export async function revalidateLogReadAuthority(value: unknown): Promise<{
  authority: LogReadAuthorityEnvelope;
  allowedDeviceIds: string[] | null;
  allowedSiteIds: string[] | null;
} | null> {
  const authority = parseEnvelope(value);
  if (!authority) return null;
  if (ENABLE_2FA && !authority.mfaClaim) return null;
  const rows = await db.select({
    id: users.id,
    partnerId: users.partnerId,
    status: users.status,
    isPlatformAdmin: users.isPlatformAdmin,
    authEpoch: users.authEpoch,
    mfaEpoch: users.mfaEpoch,
  }).from(users).where(eq(users.id, authority.requesterId)).limit(1);
  const user = rows[0];
  if (!user || user.status !== 'active' || user.partnerId !== authority.partnerId
    || user.authEpoch !== authority.authEpoch || user.mfaEpoch !== authority.mfaEpoch) return null;

  if (authority.scope === 'system') {
    if (!user.isPlatformAdmin) return null;
    return {
      authority,
      allowedDeviceIds: await deviceIdsForSites(authority.orgId, authority.siteIds),
      allowedSiteIds: authority.siteIds,
    };
  }

  // Re-resolve the exact captured authority axis. Passing orgId for a partner
  // envelope lets getUserPermissions' intentional org-first precedence select
  // a lower organization membership instead of the captured partner role.
  const permissions = await getUserPermissions(authority.requesterId, authority.scope === 'partner'
    ? { partnerId: authority.partnerId ?? undefined }
    : { partnerId: authority.partnerId ?? undefined, orgId: authority.orgId },
  { bypassCache: true });
  if (!permissions || permissions.scope !== authority.scope
    || !canAccessOrg(permissions, authority.orgId)
    || !hasPermission(permissions, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)) return null;
  const effectiveSites = intersectCeilings(authority.siteIds, permissions.allowedSiteIds);
  return {
    authority,
    allowedDeviceIds: await deviceIdsForSites(authority.orgId, effectiveSites),
    allowedSiteIds: effectiveSites,
  };
}

export async function correlationResultWithinCurrentDeviceCeiling(
  result: unknown,
  orgId: string,
  allowedSiteIds: string[] | null,
): Promise<boolean> {
  if (result == null) return true;
  if (typeof result !== 'object') return false;
  const detection = (result as { result?: unknown }).result;
  if (detection == null) return true;
  if (typeof detection !== 'object') return false;
  const affected = (detection as { affectedDevices?: unknown }).affectedDevices;
  const samples = (detection as { sampleLogs?: unknown }).sampleLogs;
  if (!Array.isArray(affected) || !Array.isArray(samples)) return false;
  const items = [...affected, ...samples];
  if (items.some((item) => !item || typeof item !== 'object'
    || typeof (item as { deviceId?: unknown }).deviceId !== 'string')) return false;
  const ids = Array.from(new Set(items.map((item) => (item as { deviceId: string }).deviceId)));
  if (ids.length === 0) return true;
  const conditions = [eq(devices.orgId, orgId), inArray(devices.id, ids)];
  if (allowedSiteIds !== null) {
    if (allowedSiteIds.length === 0) return false;
    conditions.push(inArray(devices.siteId, allowedSiteIds));
  }
  const current = await db.select({ id: devices.id }).from(devices).where(and(...conditions));
  return current.length === ids.length;
}
