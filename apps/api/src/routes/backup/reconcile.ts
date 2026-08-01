import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  BackupReconcileError,
  RECONCILE_MAX_LIMIT,
  reconcileOrphanedBackupSnapshots,
} from '../../services/backupSnapshotReconcile';
import { resolveScopedOrgId } from './helpers';

export const reconcileRoutes = new Hono();

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
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const body = c.req.valid('json');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);

    let result;
    try {
      result = await reconcileOrphanedBackupSnapshots({
        orgId,
        configId: body.configId,
        dryRun: body.dryRun,
        limit: body.limit,
        allowedDeviceIds,
      });
    } catch (error) {
      if (error instanceof BackupReconcileError) {
        return c.json(
          { error: error.message, code: error.code },
          error.code === 'config_not_found' ? 404 : 400
        );
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
        adoptedSnapshotIds: result.candidates.filter((x) => x.adopted).map((x) => x.snapshotId),
      },
    });

    return c.json({ data: result });
  }
);
