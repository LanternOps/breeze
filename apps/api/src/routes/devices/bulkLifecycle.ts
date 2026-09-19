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
import { randomUUID } from 'node:crypto';
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
import {
  enqueueDeviceBulkPurge,
  deviceBulkPurgeJobId,
  getDeviceBulkPurgeQueue,
  type DeviceBulkPurgeJobPayload,
  type DeviceBulkPurgeResult,
} from '../../jobs/deviceBulkPurge';
import { bulkDeviceIdsSchema } from './schemas';
import {
  getDeviceWithOrgAndSiteCheck,
  getDevicesWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
} from './helpers';

export const bulkLifecycleRoutes = new Hono();

bulkLifecycleRoutes.use('*', authMiddleware);

type BulkFailCode =
  | 'NOT_FOUND'
  | 'NOT_REMOVED'
  | 'UNINSTALL_PENDING'
  | 'SITE_ACCESS_DENIED'
  | 'STATE_CHANGED'
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

/**
 * POST /devices/bulk/permanent-delete — start an async purge of up to 500
 * removed devices. `202 { jobId, accepted, rejected }`.
 *
 * ASYNC, unlike bulk restore: `deleteDeviceCascade` touches ~40 tables per
 * device, so 500 of them cannot run inside a request without pinning a pooled
 * connection for minutes (see jobs/deviceBulkPurge.ts). This handler only does
 * the CHEAP checks — can the caller see the device, and is it removed — then
 * enqueues. The caller's site ceiling is copied into the durable payload so
 * the system-scoped worker cannot dissolve a group across that boundary.
 *
 * A pending agent uninstall is deliberately NOT pre-checked here. The worker
 * refuses it under the devices row lock, which keeps ONE source of truth for
 * that rule; a copy in this route would be the thing that drifts, and it would
 * be checking a fact that can change between enqueue and execution anyway.
 *
 * `accepted === 0` returns 409 rather than a job: a run with zero targets
 * completes instantly reporting "0 purged", which reads to the operator as
 * though the delete had happened.
 *
 * NOT registered in `selfManagedDbContextRoutes` — this handler only reads and
 * enqueues, so the ambient request transaction is correct for it (same call as
 * `quotes/bulk-send`).
 */
bulkLifecycleRoutes.post(
  '/bulk/permanent-delete',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  zValidator('json', bulkDeviceIdsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const ids = [...new Set(c.req.valid('json').deviceIds)];

    const targets: DeviceBulkPurgeJobPayload['targets'] = [];
    const rejected: BulkFailed[] = [];

    // ONE query for the whole selection. Per-device lookups here would be up
    // to 500 sequential single-row round-trips inside the ambient request
    // transaction, pinning a pooled connection for the duration (#1105) — and
    // unlike bulk restore, this handler has no per-item transaction to hide
    // behind. Same verdicts as the single chokepoint: the batched helper
    // delegates to the same ensureOrgAccess / canAccessSite predicates.
    const lookups = await getDevicesWithOrgAndSiteCheck(c, ids, auth);

    for (const deviceId of ids) {
      const device = lookups.get(deviceId) ?? null;
      if (device === SITE_ACCESS_DENIED) {
        rejected.push({
          deviceId,
          code: 'SITE_ACCESS_DENIED',
          message: 'Access to this site denied',
        });
        continue;
      }
      if (!device) {
        rejected.push({ deviceId, code: 'NOT_FOUND', message: 'Device not found' });
        continue;
      }
      if (device.status !== 'decommissioned') {
        rejected.push({
          deviceId,
          code: 'NOT_REMOVED',
          message: 'Device must be removed before permanent deletion',
        });
        continue;
      }
      // hostname is snapshotted for the worker's audit row: the devices row is
      // gone by the time that row is written.
      targets.push({
        deviceId,
        orgId: device.orgId,
        hostname: device.hostname ?? device.displayName ?? deviceId,
      });
    }

    if (targets.length === 0) {
      return c.json({ error: 'No selected device can be permanently deleted', rejected }, 409);
    }

    const jobId = randomUUID();
    await enqueueDeviceBulkPurge({
      jobId,
      targets,
      authorization: {
        version: 1,
        siteAccess: auth.allowedSiteIds === undefined
          ? { mode: 'unrestricted' }
          : { mode: 'restricted', allowedSiteIds: [...auth.allowedSiteIds] },
      },
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      partnerId: auth.partnerId ?? null,
    });

    // The per-device audit rows are written by the worker as each delete
    // commits. This one records the DECISION — who asked, for how many, when —
    // which is the part that would otherwise be lost if the job never ran.
    writeRouteAudit(c, {
      orgId: targets[0]!.orgId,
      action: 'device.bulk_permanent_delete.enqueued',
      resourceType: 'device_bulk_purge',
      resourceId: jobId,
      details: {
        accepted: targets.length,
        rejected: rejected.length,
        orgIds: [...new Set(targets.map((t) => t.orgId))],
      },
    });

    return c.json({ jobId, accepted: targets.length, rejected }, 202);
  },
);

/**
 * GET /devices/bulk/purge-runs/:jobId — poll a purge run.
 *
 * `DEVICES_READ`, not `DEVICES_DELETE`: reading the outcome of a run is not
 * itself destructive, and the operator who started it may not be the one
 * watching the tab.
 *
 * The jobId is a UUID the caller was handed, not a secret, and BullMQ enforces
 * nothing — so ownership is re-derived here (mirrors routes/orgMerge.ts).
 *
 * TWO checks, and both matter:
 *
 *  - **Every target org must be accessible**, for partner scope as well as org
 *    scope. Partner-id equality alone is not enough: a partner member with
 *    `org_access = 'selected'` shares the partner id with every org under that
 *    partner, so the partner arm passes while their selection may exclude the
 *    orgs this run actually touched. `routes/orgMerge.ts:126` adds exactly this
 *    check, for exactly this case.
 *  - **A run whose payload cannot be read is DENIED**, not waved through. The
 *    org arm used to be guarded by `&& payload &&`, so an absent `job.data`
 *    skipped the tenancy check and returned the run to any caller — failing
 *    OPEN, while the partner arm failed closed on the same input. An
 *    unverifiable owner is not an authorised one.
 *
 * System scope is the one exemption: it already spans every partner and org, so
 * "cannot verify ownership" is not a denial for it.
 *
 * Both denials are reported as "not found", never "forbidden", so a cross-tenant
 * probe cannot learn that the run exists.
 */
bulkLifecycleRoutes.get(
  '/bulk/purge-runs/:jobId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const jobId = c.req.param('jobId')!;

    const job = await getDeviceBulkPurgeQueue().getJob(deviceBulkPurgeJobId(jobId));
    if (!job) return c.json({ error: 'Purge run not found' }, 404);

    const payload = job.data as DeviceBulkPurgeJobPayload | undefined;
    if (auth.scope === 'partner' && payload?.partnerId !== auth.partnerId) {
      return c.json({ error: 'Purge run not found' }, 404);
    }
    if (
      auth.scope !== 'system'
      && (!payload || !payload.targets.every((t) => auth.canAccessOrg(t.orgId)))
    ) {
      return c.json({ error: 'Purge run not found' }, 404);
    }

    const state = await job.getState();
    // BullMQ's initial progress is the number 0, not an object; reporting that
    // raw would render "0 of undefined".
    const progress = job.progress as { done: number; total: number } | number;

    return c.json({
      state,
      progress:
        typeof progress === 'object' && progress !== null
          ? progress
          : { done: 0, total: payload?.targets.length ?? 0 },
      result: (job.returnvalue as DeviceBulkPurgeResult | null) ?? null,
      failedReason: job.failedReason ?? null,
    });
  },
);
