import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { devices } from '../../db/schema';
import {
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
} from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  BackupReconcileError,
  RECONCILE_MAX_LIMIT,
  reconcileOrphanedBackupSnapshots,
} from '../../services/backupSnapshotReconcile';
import { resolveScopedOrgId } from './helpers';

export const reconcileRoutes = new Hono();

/**
 * One short request-scoped DB context per phase.
 *
 * This route is registered in SELF_MANAGED_DB_CONTEXT_ROUTES (#1448), so the
 * auth middleware does NOT wrap the handler in a request transaction: the
 * handler pages a whole S3 bucket listing and fetches multi-MB manifests from a
 * tenant-controlled endpoint host, and pinning a pooled connection idle across
 * that is the #1105 pool-poison class against a 25-connection prod pool. The
 * wrapper is `withAuthDbAccessContext` (middleware/auth.ts).
 */

const reconcileRequestSchema = z.object({
  /** The destination to enumerate. Must belong to the caller's org. */
  configId: z.string().guid(),
  /** Report what WOULD be adopted without writing anything. */
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).max(RECONCILE_MAX_LIMIT).optional(),
});

/**
 * Site scope is an app-layer-only authz axis (`permissions.allowedSiteIds`) —
 * RLS does not defend it — so a site-restricted caller must not be able to
 * adopt a snapshot onto a device outside their sites. Returns null when the
 * caller is unrestricted.
 */
async function resolveSiteAllowedDeviceIds(
  orgId: string,
  perms: UserPermissions | undefined
): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((device) => typeof device.siteId === 'string' && canAccessSite(perms, device.siteId))
    .map((device) => device.id);
}

/**
 * Adopt snapshots that exist in a destination but have no restore point
 * (#3006). A backup whose terminal result was lost in transit leaves its
 * uploaded objects stranded: not restorable, and invisible to retention, so
 * they accrue storage cost forever. This walks the destination's
 * `snapshots/<id>/manifest.json` objects and links the unclaimed ones back to
 * the job that produced them.
 *
 * Org-scoped in three layers — see the tenancy note at the top of
 * services/backupSnapshotReconcile.ts. In short: the config must be the
 * caller's, adoption requires one of the caller's own job rows, and a bucket
 * shared with another org disables everything but exact snapshot-id matches.
 */
reconcileRoutes.post(
  '/reconcile',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('json', reconcileRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope', code: 'org_scope_required' }, 400);
    }

    const body = c.req.valid('json');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const allowedDeviceIds = await withAuthDbAccessContext(auth, () =>
      resolveSiteAllowedDeviceIds(orgId, perms)
    );

    let result;
    try {
      result = await reconcileOrphanedBackupSnapshots({
        orgId,
        configId: body.configId,
        dryRun: body.dryRun,
        limit: body.limit,
        allowedDeviceIds,
        runInDbContext: (fn) => withAuthDbAccessContext(auth, fn),
      });
    } catch (error) {
      if (error instanceof BackupReconcileError) {
        // A destination we cannot read is an upstream/credential failure, not a
        // malformed request — 502 so clients and monitoring can tell it apart
        // from `provider_unsupported`, which really is the caller's problem.
        const status =
          error.code === 'config_not_found' ? 404 : error.code === 'destination_unreadable' ? 502 : 400;
        return c.json({ error: error.message, code: error.code }, status);
      }
      throw error;
    }

    // Audited even on a dry run: enumerating a customer destination and
    // learning which snapshots exist is itself worth a trail.
    writeRouteAudit(c, {
      orgId,
      action: result.dryRun ? 'backup.reconcile.preview' : 'backup.reconcile.adopt',
      resourceType: 'backup_config',
      resourceId: body.configId,
      details: {
        dryRun: result.dryRun,
        sharedDestination: result.sharedDestination,
        snapshotsInStorage: result.snapshotsInStorage,
        adopted: result.adopted,
        remaining: result.remaining,
        // Without these, a run that recovered nothing from 50 stranded
        // snapshots leaves an audit record indistinguishable from a run
        // against a healthy destination.
        skipped: result.skipped,
        skippedByReason: result.skippedByReason,
        adoptedSnapshotIds: result.candidates.filter((x) => x.adopted).map((x) => x.snapshotId),
      },
    });

    return c.json({ data: result });
  }
);
