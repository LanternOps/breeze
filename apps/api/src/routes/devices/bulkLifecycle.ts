/**
 * Bulk lifecycle operations on REMOVED devices (#2787).
 *
 * Split out of core.ts rather than added to it for two reasons: every path here
 * is STATIC (`/bulk/...`) and must therefore be mounted ahead of core's `/:id`
 * matcher — pinned by `bulkLifecycle.mountorder.test.ts` — and the bulk restore
 * route opts out of the ambient request transaction
 * (`middleware/selfManagedDbContextRoutes.ts`), which is a per-route property
 * that is much easier to reason about in a file of its own.
 *
 * Both mutating routes carry `devices:delete` + `requireMfa()`, identical to
 * their single-device siblings: a 500-device destructive operation must never
 * sit behind a weaker gate than the one-device one.
 *
 * Neither route re-implements any lifecycle rule. Authorisation goes through
 * the same `getDeviceWithOrgAndSiteCheck` chokepoint the single routes use, and
 * the state machine lives entirely in `services/deviceLifecycle.ts`.
 */
import { Hono } from 'hono';
import { db } from '../../db';
import { zValidator } from '../../lib/validation';
import { runBulkIsolated } from '../../lib/bulkOps';
import {
  authMiddleware,
  requireScope,
  requirePermission,
  requireMfa,
  dbAccessContextFromAuth,
  type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { restoreRemovedDevice, DeviceLifecycleError } from '../../services/deviceLifecycle';
import { bulkDeviceIdsSchema } from './schemas';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const bulkLifecycleRoutes = new Hono();

bulkLifecycleRoutes.use('*', authMiddleware);

type BulkFailCode =
  | 'NOT_FOUND'
  | 'NOT_REMOVED'
  | 'UNINSTALL_PENDING'
  | 'SITE_ACCESS_DENIED'
  | 'ERROR';

interface BulkFailed {
  deviceId: string;
  code: BulkFailCode;
  message: string;
}

/**
 * POST /devices/bulk/restore — restore up to 500 removed devices.
 *
 * SYNCHRONOUS, unlike bulk permanent delete: a restore is two small writes per
 * device (cancel the queued uninstall, flip the status), so 500 of them finish
 * inside a normal request while a purge of the same 500 would not.
 *
 * Each device runs in its OWN short RLS transaction via `runBulkIsolated`. This
 * route is listed in `selfManagedDbContextRoutes`, so there is no ambient
 * request transaction to hold across the loop — holding one would pin a single
 * pooled connection, plus every `devices`/`device_commands` row lock it takes,
 * until the last item finished (#1105), and a Postgres-level error on item 400
 * would silently roll back the 399 restores already reported as successful.
 *
 * `runBulkIsolated`'s `BulkResult` counts are deliberately ignored: the web
 * needs per-device ids (to name what failed and to warn about machines whose
 * uninstall already went out), not tallies. Per-item failures are caught inside
 * `perItem` and recorded here.
 */
bulkLifecycleRoutes.post(
  '/bulk/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  zValidator('json', bulkDeviceIdsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const ids = [...new Set(c.req.valid('json').deviceIds)];
    const ctx = dbAccessContextFromAuth(auth);

    const succeeded: Array<{ deviceId: string; uninstallAlreadyDispatched: boolean }> = [];
    const failed: BulkFailed[] = [];

    await runBulkIsolated(ctx, ids, async (deviceId) => {
      const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
      if (device === SITE_ACCESS_DENIED) {
        failed.push({
          deviceId,
          code: 'SITE_ACCESS_DENIED',
          message: 'Access to this site denied',
        });
        return;
      }
      if (!device) {
        failed.push({ deviceId, code: 'NOT_FOUND', message: 'Device not found' });
        return;
      }

      try {
        const result = await db.transaction((tx) => restoreRemovedDevice(tx, deviceId));
        succeeded.push({
          deviceId,
          uninstallAlreadyDispatched: result.uninstallAlreadyDispatched,
        });
        writeRouteAudit(c, {
          orgId: device.orgId,
          action: 'device.restore',
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: result.device?.hostname ?? device.hostname,
          details: {
            uninstallAlreadyDispatched: result.uninstallAlreadyDispatched,
            bulk: true,
          },
        });
      } catch (err) {
        if (err instanceof DeviceLifecycleError) {
          failed.push({ deviceId, code: err.code, message: err.message });
          return;
        }
        // Swallowed on purpose so one bad row cannot abort the batch — but
        // never silently: this is the only server-side record of which device
        // failed and why.
        console.error(`[devices] bulk restore failed for ${deviceId}:`, err);
        failed.push({ deviceId, code: 'ERROR', message: 'Restore failed' });
      }
    });

    return c.json({ succeeded, failed });
  },
);
