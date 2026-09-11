import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  backupChains,
  backupSnapshots,
  devices,
  hypervVms,
  recoveryBootMediaArtifacts,
  recoveryMediaArtifacts,
  recoveryTokens,
  restoreJobs,
  sqlInstances,
} from '../db/schema';
import type { PrincipalKind } from '../middleware/auth';
import {
  canAccessSite,
  hasPermission,
  type UserPermissions,
} from './permissions';

export type ResilienceResourceRef = {
  kind:
    | 'device'
    | 'vm'
    | 'sql_instance'
    | 'backup_chain'
    | 'snapshot'
    | 'recovery_token'
    | 'media_artifact'
    | 'boot_media_artifact'
    | 'restore_job';
  id: string;
  role: 'source' | 'target';
};

export type ResilienceOperation =
  | 'read'
  | 'restore'
  | 'verify'
  | 'token'
  | 'media'
  | 'revoke';

/**
 * The authorization subject supplied by request paths and re-hydrated workers.
 * The principal kind is deliberately separate from its effective RBAC grants.
 */
export interface AuthorizationPrincipal {
  kind: PrincipalKind['kind'];
  permissions: UserPermissions;
}

export type AuthorizedResilienceResource = ResilienceResourceRef & {
  orgId: string;
  deviceId: string;
  siteId: string;
};

export interface AuthorizedResilienceResources {
  resources: AuthorizedResilienceResource[];
}

export type ResilienceAuthorizationErrorCode =
  | 'site_access_denied'
  | 'resource_not_found';

export class ResilienceAuthorizationError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: ResilienceAuthorizationErrorCode,
  ) {
    super(code);
    this.name = 'ResilienceAuthorizationError';
  }
}

type Lineage = {
  orgId: string;
  deviceId: string | null;
  siteId: string | null;
};

const SITE_RESTRICTED_PRINCIPAL_KINDS = new Set<PrincipalKind['kind']>([
  'user_session',
  'client_user',
  'api_key',
  'oauth_grant',
  'ai_agent',
]);

const SITE_UNRESTRICTED_PRINCIPAL_KINDS = new Set<PrincipalKind['kind']>([
  'system',
]);

/**
 * Whether a principal of this kind is subject to the site grant at all.
 *
 * Exported so route-level adapters share one list with the resolver below: a
 * kind present here but missing there (or the reverse) is a silent hole in an
 * app-layer-only boundary, since RLS does not enforce the site axis.
 */
export function isSiteRestrictedPrincipalKind(kind: PrincipalKind['kind'] | undefined): boolean {
  return kind !== undefined && SITE_RESTRICTED_PRINCIPAL_KINDS.has(kind);
}

function siteAccessAllowed(principal: AuthorizationPrincipal, siteId: string): boolean {
  if (SITE_RESTRICTED_PRINCIPAL_KINDS.has(principal.kind)) {
    return canAccessSite(principal.permissions, siteId);
  }
  if (SITE_UNRESTRICTED_PRINCIPAL_KINDS.has(principal.kind)) {
    return true;
  }
  // Agent/helper identities are device-bound and `unknown` is not an
  // authorization subject. They need a dedicated binding contract before this
  // user-RBAC service may accept them.
  return false;
}

async function resolveLineage(
  orgId: string,
  ref: ResilienceResourceRef,
): Promise<Lineage | undefined> {
  switch (ref.kind) {
    case 'device': {
      const [row] = await db
        .select({ orgId: devices.orgId, deviceId: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(and(eq(devices.id, ref.id), eq(devices.orgId, orgId)))
        .limit(1);
      return row;
    }
    case 'vm': {
      const [row] = await db
        .select({ orgId: hypervVms.orgId, deviceId: hypervVms.deviceId, siteId: devices.siteId })
        .from(hypervVms)
        .leftJoin(devices, and(
          eq(devices.id, hypervVms.deviceId),
          eq(devices.orgId, hypervVms.orgId),
        ))
        .where(and(eq(hypervVms.id, ref.id), eq(hypervVms.orgId, orgId)))
        .limit(1);
      return row;
    }
    case 'sql_instance': {
      const [row] = await db
        .select({ orgId: sqlInstances.orgId, deviceId: sqlInstances.deviceId, siteId: devices.siteId })
        .from(sqlInstances)
        .leftJoin(devices, and(
          eq(devices.id, sqlInstances.deviceId),
          eq(devices.orgId, sqlInstances.orgId),
        ))
        .where(and(eq(sqlInstances.id, ref.id), eq(sqlInstances.orgId, orgId)))
        .limit(1);
      return row;
    }
    case 'backup_chain': {
      const [row] = await db
        .select({ orgId: backupChains.orgId, deviceId: backupChains.deviceId, siteId: devices.siteId })
        .from(backupChains)
        .leftJoin(devices, and(
          eq(devices.id, backupChains.deviceId),
          eq(devices.orgId, backupChains.orgId),
        ))
        .where(and(eq(backupChains.id, ref.id), eq(backupChains.orgId, orgId)))
        .limit(1);
      return row;
    }
    case 'snapshot': {
      const [row] = await db
        .select({ orgId: backupSnapshots.orgId, deviceId: backupSnapshots.deviceId, siteId: devices.siteId })
        .from(backupSnapshots)
        .leftJoin(devices, and(
          eq(devices.id, backupSnapshots.deviceId),
          eq(devices.orgId, backupSnapshots.orgId),
        ))
        .where(and(eq(backupSnapshots.id, ref.id), eq(backupSnapshots.orgId, orgId)))
        .limit(1);
      return row;
    }
    case 'recovery_token':
      return resolveRecoveryTokenLineage(orgId, ref);
    case 'media_artifact':
      return resolveMediaArtifactLineage(orgId, ref);
    case 'boot_media_artifact':
      return resolveBootMediaArtifactLineage(orgId, ref);
    case 'restore_job':
      return resolveRestoreJobLineage(orgId, ref);
  }
}

/**
 * D17 (2026-10-15-140004): restore_jobs.snapshot_id and
 * recovery_tokens.snapshot_id are now ON DELETE SET NULL, so a still-alive
 * history row can point at a snapshot retention already deleted. A SOURCE-role
 * lineage query that only ever resolves device/site THROUGH the snapshot
 * (leftJoin on `backupSnapshots.id = <row>.snapshotId`) then gets
 * deviceId: null / siteId: null, and `authorizeResilienceResources` denies a
 * principal who plainly owns the row's own device.
 *
 * Resolves siteId for a device the caller already knows is this row's OWN
 * device (never anything broader — this must not widen access past what the
 * row itself is scoped to). Scoped by orgId, same as every other lineage
 * lookup in this file.
 */
async function resolveOwnDeviceSiteId(orgId: string, deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row?.siteId ?? null;
}

/**
 * Applies the D17 own-device fallback to a SOURCE-role lineage row that
 * selected `ownDeviceId` (the row's own device column, or — for media/boot
 * media artifacts — its token's device column) alongside the
 * snapshot-derived deviceId/siteId. When the snapshot resolved (deviceId AND
 * siteId both present), returns it unchanged — no extra query. Otherwise
 * falls back to ownDeviceId and a fresh siteId lookup for it.
 */
async function withOwnDeviceFallback(
  row: { orgId: string; deviceId: string | null; siteId: string | null; ownDeviceId: string | null } | undefined,
): Promise<Lineage | undefined> {
  if (!row) return undefined;
  if (row.deviceId && row.siteId) {
    return { orgId: row.orgId, deviceId: row.deviceId, siteId: row.siteId };
  }
  if (!row.ownDeviceId) {
    return { orgId: row.orgId, deviceId: row.deviceId, siteId: row.siteId };
  }
  const siteId = await resolveOwnDeviceSiteId(row.orgId, row.ownDeviceId);
  return { orgId: row.orgId, deviceId: row.ownDeviceId, siteId };
}

async function resolveRecoveryTokenLineage(
  orgId: string,
  ref: ResilienceResourceRef,
): Promise<Lineage | undefined> {
  if (ref.role === 'target') {
    const [row] = await db
      .select({ orgId: recoveryTokens.orgId, deviceId: recoveryTokens.deviceId, siteId: devices.siteId })
      .from(recoveryTokens)
      .leftJoin(devices, and(
        eq(devices.id, recoveryTokens.deviceId),
        eq(devices.orgId, recoveryTokens.orgId),
      ))
      .where(and(eq(recoveryTokens.id, ref.id), eq(recoveryTokens.orgId, orgId)))
      .limit(1);
    return row;
  }
  const [row] = await db
    .select({
      orgId: recoveryTokens.orgId,
      deviceId: backupSnapshots.deviceId,
      siteId: devices.siteId,
      // D17 fallback when the snapshot is gone (SET NULL) — the token's own device.
      ownDeviceId: recoveryTokens.deviceId,
    })
    .from(recoveryTokens)
    .leftJoin(backupSnapshots, and(
      eq(backupSnapshots.id, recoveryTokens.snapshotId),
      eq(backupSnapshots.orgId, recoveryTokens.orgId),
    ))
    .leftJoin(devices, and(
      eq(devices.id, backupSnapshots.deviceId),
      eq(devices.orgId, recoveryTokens.orgId),
    ))
    .where(and(eq(recoveryTokens.id, ref.id), eq(recoveryTokens.orgId, orgId)))
    .limit(1);
  return withOwnDeviceFallback(row);
}

async function resolveMediaArtifactLineage(
  orgId: string,
  ref: ResilienceResourceRef,
): Promise<Lineage | undefined> {
  if (ref.role === 'target') {
    const [row] = await db
      .select({ orgId: recoveryMediaArtifacts.orgId, deviceId: recoveryTokens.deviceId, siteId: devices.siteId })
      .from(recoveryMediaArtifacts)
      .leftJoin(recoveryTokens, and(
        eq(recoveryTokens.id, recoveryMediaArtifacts.tokenId),
        eq(recoveryTokens.orgId, recoveryMediaArtifacts.orgId),
      ))
      .leftJoin(devices, and(
        eq(devices.id, recoveryTokens.deviceId),
        eq(devices.orgId, recoveryMediaArtifacts.orgId),
      ))
      .where(and(eq(recoveryMediaArtifacts.id, ref.id), eq(recoveryMediaArtifacts.orgId, orgId)))
      .limit(1);
    return row;
  }
  const [row] = await db
    .select({
      orgId: recoveryMediaArtifacts.orgId,
      deviceId: backupSnapshots.deviceId,
      siteId: devices.siteId,
      // D17 fallback: recoveryMediaArtifacts.snapshotId is still CASCADE (not
      // SET NULL), so this row is deleted along with its snapshot in
      // practice — but resolve via the row's own token's device anyway for
      // defense in depth, matching the target-role join just above.
      ownDeviceId: recoveryTokens.deviceId,
    })
    .from(recoveryMediaArtifacts)
    .leftJoin(backupSnapshots, and(
      eq(backupSnapshots.id, recoveryMediaArtifacts.snapshotId),
      eq(backupSnapshots.orgId, recoveryMediaArtifacts.orgId),
    ))
    .leftJoin(devices, and(
      eq(devices.id, backupSnapshots.deviceId),
      eq(devices.orgId, recoveryMediaArtifacts.orgId),
    ))
    .leftJoin(recoveryTokens, and(
      eq(recoveryTokens.id, recoveryMediaArtifacts.tokenId),
      eq(recoveryTokens.orgId, recoveryMediaArtifacts.orgId),
    ))
    .where(and(eq(recoveryMediaArtifacts.id, ref.id), eq(recoveryMediaArtifacts.orgId, orgId)))
    .limit(1);
  return withOwnDeviceFallback(row);
}

async function resolveBootMediaArtifactLineage(
  orgId: string,
  ref: ResilienceResourceRef,
): Promise<Lineage | undefined> {
  if (ref.role === 'target') {
    const [row] = await db
      .select({ orgId: recoveryBootMediaArtifacts.orgId, deviceId: recoveryTokens.deviceId, siteId: devices.siteId })
      .from(recoveryBootMediaArtifacts)
      .leftJoin(recoveryTokens, and(
        eq(recoveryTokens.id, recoveryBootMediaArtifacts.tokenId),
        eq(recoveryTokens.orgId, recoveryBootMediaArtifacts.orgId),
      ))
      .leftJoin(devices, and(
        eq(devices.id, recoveryTokens.deviceId),
        eq(devices.orgId, recoveryBootMediaArtifacts.orgId),
      ))
      .where(and(eq(recoveryBootMediaArtifacts.id, ref.id), eq(recoveryBootMediaArtifacts.orgId, orgId)))
      .limit(1);
    return row;
  }
  const [row] = await db
    .select({
      orgId: recoveryBootMediaArtifacts.orgId,
      deviceId: backupSnapshots.deviceId,
      siteId: devices.siteId,
      // D17 fallback: recoveryBootMediaArtifacts.snapshotId is still CASCADE
      // (not SET NULL), so this row is deleted along with its snapshot in
      // practice — but resolve via the row's own token's device anyway for
      // defense in depth, matching the target-role join just above.
      ownDeviceId: recoveryTokens.deviceId,
    })
    .from(recoveryBootMediaArtifacts)
    .leftJoin(backupSnapshots, and(
      eq(backupSnapshots.id, recoveryBootMediaArtifacts.snapshotId),
      eq(backupSnapshots.orgId, recoveryBootMediaArtifacts.orgId),
    ))
    .leftJoin(devices, and(
      eq(devices.id, backupSnapshots.deviceId),
      eq(devices.orgId, recoveryBootMediaArtifacts.orgId),
    ))
    .leftJoin(recoveryTokens, and(
      eq(recoveryTokens.id, recoveryBootMediaArtifacts.tokenId),
      eq(recoveryTokens.orgId, recoveryBootMediaArtifacts.orgId),
    ))
    .where(and(eq(recoveryBootMediaArtifacts.id, ref.id), eq(recoveryBootMediaArtifacts.orgId, orgId)))
    .limit(1);
  return withOwnDeviceFallback(row);
}

async function resolveRestoreJobLineage(
  orgId: string,
  ref: ResilienceResourceRef,
): Promise<Lineage | undefined> {
  if (ref.role === 'target') {
    const [row] = await db
      .select({ orgId: restoreJobs.orgId, deviceId: restoreJobs.deviceId, siteId: devices.siteId })
      .from(restoreJobs)
      .leftJoin(devices, and(
        eq(devices.id, restoreJobs.deviceId),
        eq(devices.orgId, restoreJobs.orgId),
      ))
      .where(and(eq(restoreJobs.id, ref.id), eq(restoreJobs.orgId, orgId)))
      .limit(1);
    return row;
  }
  const [row] = await db
    .select({
      orgId: restoreJobs.orgId,
      deviceId: backupSnapshots.deviceId,
      siteId: devices.siteId,
      // D17 fallback when the snapshot is gone (SET NULL) — the job's own device.
      ownDeviceId: restoreJobs.deviceId,
    })
    .from(restoreJobs)
    .leftJoin(backupSnapshots, and(
      eq(backupSnapshots.id, restoreJobs.snapshotId),
      eq(backupSnapshots.orgId, restoreJobs.orgId),
    ))
    .leftJoin(devices, and(
      eq(devices.id, backupSnapshots.deviceId),
      eq(devices.orgId, restoreJobs.orgId),
    ))
    .where(and(eq(restoreJobs.id, ref.id), eq(restoreJobs.orgId, orgId)))
    .limit(1);
  return withOwnDeviceFallback(row);
}

export async function authorizeResilienceResources(input: {
  orgId: string;
  principal: AuthorizationPrincipal;
  refs: readonly ResilienceResourceRef[];
  operation: ResilienceOperation;
}): Promise<AuthorizedResilienceResources> {
  const resources: AuthorizedResilienceResource[] = [];

  for (const ref of input.refs) {
    const lineage = await resolveLineage(input.orgId, ref);
    if (!lineage) {
      throw new ResilienceAuthorizationError(404, 'resource_not_found');
    }
    if (
      lineage.orgId !== input.orgId
      || typeof lineage.deviceId !== 'string'
      || typeof lineage.siteId !== 'string'
      || !siteAccessAllowed(input.principal, lineage.siteId)
    ) {
      throw new ResilienceAuthorizationError(403, 'site_access_denied');
    }
    resources.push({ ...ref, ...lineage } as AuthorizedResilienceResource);
  }

  if (input.operation === 'restore') {
    const sourceSites = new Set(resources.filter((resource) => resource.role === 'source').map((resource) => resource.siteId));
    const targetSites = new Set(resources.filter((resource) => resource.role === 'target').map((resource) => resource.siteId));
    const isCrossSite = [...sourceSites].some((sourceSite) =>
      [...targetSites].some((targetSite) => sourceSite !== targetSite));

    if (
      isCrossSite
      && !hasPermission(input.principal.permissions, 'backup', 'cross_site_restore')
    ) {
      throw new ResilienceAuthorizationError(403, 'site_access_denied');
    }
  }

  return { resources };
}
