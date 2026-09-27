/**
 * AI restore tools — the same org and site authorization as the HTTP restore
 * routes.
 *
 * The routes (`routes/backup/restore.ts`, `vmrestore.ts`, `hyperv.ts`,
 * `mssql.ts`) run every restore through `authorizeResilienceResources`
 * (`operation: 'restore'`) inside ONE org: the snapshot is the source, the
 * target device the target. That gives them two properties the AI handlers
 * lacked:
 *
 *  1. Org binding. A multi-org partner caller can reach devices in several
 *     orgs, and RLS admits any of them, so a handler that only checked "can the
 *     caller see the snapshot" and "can the caller see the device" could restore
 *     one customer's backup onto another customer's machine.
 *  2. `backup:cross_site_restore`. Restoring a snapshot taken at one site onto
 *     a device at another site needs that permission on top of site access.
 *
 * Both are enforced here, with the permission set resolved from the same
 * source `requirePermission` uses on the route (`getUserPermissions`, cached),
 * so the tool requires what the route requires.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { getUserPermissions, type UserPermissions } from './permissions';
import {
  ResilienceAuthorizationError,
  authorizeResilienceResources,
} from './resilienceSiteAuthorization';

export const RESTORE_CROSS_ORG_ERROR =
  'Snapshot and target device must belong to the same organization';
export const RESTORE_TARGET_DENIED_ERROR = 'Target device not found or access denied';
export const RESTORE_SITE_DENIED_ERROR =
  'site_access_denied: the snapshot and the target device must both be in sites you can access, and restoring to a device at a different site than the backup source requires the backup:cross_site_restore permission';
export const RESTORE_RESOURCE_NOT_FOUND_ERROR = 'Snapshot or target device not found or access denied';

/**
 * The caller's live RBAC grant, as `requirePermission` resolves it for the same
 * token on an HTTP route. An AI agent principal holds no user permissions, and a
 * caller with no resolvable role gets an empty grant carrying only its site
 * allowlist — the same fallback the route adapter uses
 * (`routes/backup/resilienceAuthorization.ts`), so it fails closed on every
 * permission-gated step.
 */
export async function resolveAiCallerPermissions(auth: AuthContext): Promise<UserPermissions> {
  const fallback: UserPermissions = {
    permissions: [],
    partnerId: auth.partnerId,
    orgId: auth.orgId,
    roleId: '',
    scope: auth.scope,
    allowedSiteIds: auth.allowedSiteIds,
  };
  if (auth.principal?.kind === 'ai_agent') return fallback;
  const resolved = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
    scope: auth.scope,
  });
  return resolved ?? fallback;
}

export type AiRestoreAuthorization = { ok: true } | { ok: false; error: string; code?: string };

/**
 * Authorize restoring `snapshot` onto `targetDeviceId` for an AI caller.
 *
 * The restore always happens in the SNAPSHOT's org: the target device must be
 * in that same org (never a different org the caller also happens to reach),
 * and the snapshot/target pair must pass the route's resilience check, which
 * includes `backup:cross_site_restore` for a cross-site restore.
 */
export async function authorizeAiRestore(
  auth: AuthContext,
  input: { snapshot: { id: string; orgId: string }; targetDeviceId: string },
): Promise<AiRestoreAuthorization> {
  const conditions: SQL[] = [eq(devices.id, input.targetDeviceId)];
  const orgCondition = auth.orgCondition(devices.orgId);
  if (orgCondition) conditions.push(orgCondition);
  const [target] = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(and(...conditions))
    .limit(1);
  if (!target) return { ok: false, error: RESTORE_TARGET_DENIED_ERROR };
  if (target.orgId !== input.snapshot.orgId) {
    return { ok: false, error: RESTORE_CROSS_ORG_ERROR, code: 'cross_org_restore_denied' };
  }

  const permissions = await resolveAiCallerPermissions(auth);
  try {
    await authorizeResilienceResources({
      orgId: input.snapshot.orgId,
      principal: { kind: auth.principal.kind, permissions },
      refs: [
        { kind: 'snapshot', id: input.snapshot.id, role: 'source' },
        { kind: 'device', id: input.targetDeviceId, role: 'target' },
      ],
      operation: 'restore',
    });
  } catch (error) {
    if (error instanceof ResilienceAuthorizationError) {
      return error.code === 'site_access_denied'
        ? { ok: false, error: RESTORE_SITE_DENIED_ERROR, code: error.code }
        : { ok: false, error: RESTORE_RESOURCE_NOT_FOUND_ERROR, code: error.code };
    }
    throw error;
  }
  return { ok: true };
}
