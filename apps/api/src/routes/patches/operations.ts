import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { queueCommandForExecution } from '../../services/commandQueue';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { queuePatchRollbacks } from '../../services/patchRollback';
import {
  patches,
  patchJobs,
  patchJobResults,
  devices,
  users
} from '../../db/schema';
import { scanSchema, listJobsSchema, jobIdParamSchema, patchIdParamSchema, rollbackSchema } from './schemas';
import { getPagination, writePatchAuditForOrgIds } from './helpers';

export const operationsRoutes = new Hono();

function canAccessDeviceSite(device: { siteId?: string | null }, permissions: UserPermissions | undefined): boolean {
  if (!permissions?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId);
}

function targetDeviceIds(targets: unknown): string[] {
  const ids = (targets as { deviceIds?: unknown } | null)?.deviceIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * A job's `targets.deviceIds` can span the whole org. For a caller limited to
 * a subset of sites, keep only the devices in those sites (the same rule the
 * per-device results already follow). Unrestricted callers get rows unchanged.
 */
async function narrowJobTargetsToSites<T extends { targets: unknown }>(
  jobs: T[],
  permissions: UserPermissions | undefined
): Promise<T[]> {
  if (!permissions?.allowedSiteIds) return jobs;

  const allIds = [...new Set(jobs.flatMap((job) => targetDeviceIds(job.targets)))];
  const visible = new Set<string>();
  if (allIds.length > 0) {
    const rows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(inArray(devices.id, allIds));
    for (const row of rows) {
      if (canAccessDeviceSite(row, permissions)) visible.add(row.id);
    }
  }

  return jobs.map((job) => {
    const targets = job.targets;
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
      return { ...job, targets: { deviceIds: [] } };
    }
    return {
      ...job,
      targets: {
        ...(targets as Record<string, unknown>),
        deviceIds: targetDeviceIds(targets).filter((id) => visible.has(id)),
      },
    };
  });
}

// POST /patches/scan - Trigger patch scan for devices
operationsRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', scanSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const requestedDevices = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId
      })
      .from(devices)
      .where(inArray(devices.id, data.deviceIds));

    const foundDeviceIDs = new Set(requestedDevices.map((d) => d.id));
    const missingDeviceIDs = data.deviceIds.filter((id) => !foundDeviceIDs.has(id));

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const accessibleDevices = requestedDevices.filter((device) =>
      auth.canAccessOrg(device.orgId) && canAccessDeviceSite(device, permissions)
    );
    const inaccessibleDeviceIDs = requestedDevices
      .filter((device) => !auth.canAccessOrg(device.orgId) || !canAccessDeviceSite(device, permissions))
      .map((device) => device.id);

    const queueResults = await Promise.all(
      accessibleDevices.map(async (device) => {
        try {
          const queued = await queueCommandForExecution(
            device.id,
            'patch_scan',
            { source: data.source ?? null },
            {
              userId: auth.user.id,
              preferHeartbeat: false
            }
          );

          if (!queued.command) {
            return { ok: false as const, deviceId: device.id };
          }

          return {
            ok: true as const,
            commandId: queued.command.id,
            commandStatus: queued.command.status
          };
        } catch {
          return { ok: false as const, deviceId: device.id };
        }
      })
    );

    const queuedCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok)
      .map((r) => r.commandId);
    const dispatchedCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok && r.commandStatus === 'sent')
      .map((r) => r.commandId);
    const pendingCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok && r.commandStatus !== 'sent')
      .map((r) => r.commandId);
    const failedDeviceIDs = queueResults
      .filter((r): r is { ok: false; deviceId: string } => !r.ok)
      .map((r) => r.deviceId);

    writePatchAuditForOrgIds(
      c,
      accessibleDevices.map((d) => d.orgId),
      {
        action: 'patch.scan.trigger',
        resourceType: 'patch',
        details: {
          source: data.source ?? null,
          deviceCount: accessibleDevices.length,
          queuedCommandIds,
          dispatchedCommandIds,
          pendingCommandIds,
          failedDeviceIds: failedDeviceIDs
        }
      }
    );

    return c.json({
      success: failedDeviceIDs.length === 0,
      jobId: `scan-${Date.now()}`,
      deviceCount: accessibleDevices.length,
      queuedCommandIds,
      dispatchedCommandIds,
      pendingCommandIds,
      failedDeviceIds: failedDeviceIDs,
      skipped: {
        missingDeviceIds: missingDeviceIDs,
        inaccessibleDeviceIds: inaccessibleDeviceIDs
      }
    });
  }
);

// GET /patches/jobs - List patch deployment jobs
operationsRoutes.get(
  '/jobs',
  requireScope('organization', 'partner', 'system'),
  // Same RBAC bar as every sibling patch READ (list.ts, compliance.ts,
  // approvals.ts) — job history is exactly the kind of read DEVICES_READ was
  // meant to gate. This route previously had no permission check at all
  // (issue #2606).
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listJobsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const allowedSiteIds = permissions?.allowedSiteIds;

    if (allowedSiteIds && allowedSiteIds.length === 0) {
      return c.json({ data: [], pagination: { page, limit, total: 0 } });
    }

    const conditions = [];
    const orgCond = auth.orgCondition(patchJobs.orgId);
    if (orgCond) conditions.push(orgCond);
    if (query.status) conditions.push(eq(patchJobs.status, query.status));
    if (allowedSiteIds) {
      // Site-restricted callers only see jobs that target at least one device
      // in their sites. `jsonb_exists` (the `?` operator) is false rather than
      // an error when `targets.deviceIds` is missing or not an array.
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${devices}
        WHERE ${devices.orgId} = ${patchJobs.orgId}
          AND ${inArray(devices.siteId, allowedSiteIds)}
          AND jsonb_exists(${patchJobs.targets}->'deviceIds', ${devices.id}::text)
      )`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const jobs = await db
      .select({
        id: patchJobs.id,
        orgId: patchJobs.orgId,
        policyId: patchJobs.policyId,
        ringId: patchJobs.ringId,
        configPolicyId: patchJobs.configPolicyId,
        name: patchJobs.name,
        patches: patchJobs.patches,
        targets: patchJobs.targets,
        status: patchJobs.status,
        scheduledAt: patchJobs.scheduledAt,
        startedAt: patchJobs.startedAt,
        completedAt: patchJobs.completedAt,
        devicesTotal: patchJobs.devicesTotal,
        devicesCompleted: patchJobs.devicesCompleted,
        devicesFailed: patchJobs.devicesFailed,
        devicesPending: patchJobs.devicesPending,
        devicesQueued: patchJobs.devicesQueued,
        createdBy: patchJobs.createdBy,
        createdByName: users.name,
        createdAt: patchJobs.createdAt
      })
      .from(patchJobs)
      .leftJoin(users, eq(users.id, patchJobs.createdBy))
      .where(whereClause)
      .orderBy(desc(patchJobs.createdAt), desc(patchJobs.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patchJobs)
      .where(whereClause);

    return c.json({
      data: await narrowJobTargetsToSites(jobs, permissions),
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// GET /patches/jobs/:id - Patch job detail with per-device results
operationsRoutes.get(
  '/jobs/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', jobIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');

    // patch_jobs carries FORCE RLS keyed on org_id (breeze_has_org_access), so
    // this select is already tenant-scoped at the database level via the
    // request's withDbAccessContext — an org-scoped caller simply gets zero
    // rows for a job outside their org, same as any other cross-tenant probe.
    const [job] = await db
      .select({
        id: patchJobs.id,
        orgId: patchJobs.orgId,
        policyId: patchJobs.policyId,
        ringId: patchJobs.ringId,
        configPolicyId: patchJobs.configPolicyId,
        name: patchJobs.name,
        patches: patchJobs.patches,
        targets: patchJobs.targets,
        status: patchJobs.status,
        scheduledAt: patchJobs.scheduledAt,
        startedAt: patchJobs.startedAt,
        completedAt: patchJobs.completedAt,
        devicesTotal: patchJobs.devicesTotal,
        devicesCompleted: patchJobs.devicesCompleted,
        devicesFailed: patchJobs.devicesFailed,
        devicesPending: patchJobs.devicesPending,
        devicesQueued: patchJobs.devicesQueued,
        createdBy: patchJobs.createdBy,
        createdByName: users.name,
        createdAt: patchJobs.createdAt
      })
      .from(patchJobs)
      .leftJoin(users, eq(users.id, patchJobs.createdBy))
      .where(eq(patchJobs.id, id))
      .limit(1);

    if (!job) {
      return c.json({ error: 'Patch job not found' }, 404);
    }

    // patch_job_results has no org_id column and no RLS policy of its own
    // (device-join RLS shape — see schema comment); scope it explicitly by
    // joining devices for the job's own org rather than trusting job_id alone,
    // since job_id is a plain (unscoped) equality filter under RLS.
    const results = await db
      .select({
        id: patchJobResults.id,
        deviceId: patchJobResults.deviceId,
        deviceHostname: devices.hostname,
        deviceSiteId: devices.siteId,
        patchId: patchJobResults.patchId,
        patchTitle: patches.title,
        status: patchJobResults.status,
        startedAt: patchJobResults.startedAt,
        completedAt: patchJobResults.completedAt,
        exitCode: patchJobResults.exitCode,
        output: patchJobResults.output,
        errorMessage: patchJobResults.errorMessage,
        rebootRequired: patchJobResults.rebootRequired,
        rebootedAt: patchJobResults.rebootedAt,
        createdAt: patchJobResults.createdAt
      })
      .from(patchJobResults)
      .innerJoin(devices, and(eq(devices.id, patchJobResults.deviceId), eq(devices.orgId, job.orgId)))
      .leftJoin(patches, eq(patches.id, patchJobResults.patchId))
      .where(eq(patchJobResults.jobId, job.id))
      .orderBy(desc(patchJobResults.createdAt));

    // Site-restricted callers only see per-device results and target devices
    // in their allowed sites (the job row itself is org-scoped; results are not).
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const visibleResults = results
      .filter((r) => canAccessDeviceSite({ siteId: r.deviceSiteId }, permissions))
      .map(({ deviceSiteId: _deviceSiteId, ...rest }) => rest);
    const [visibleJob] = await narrowJobTargetsToSites([job], permissions);
    // Same visibility rule as the jobs list: a site-restricted caller does not
    // see a job that touches none of their devices.
    if (
      permissions?.allowedSiteIds &&
      visibleResults.length === 0 &&
      targetDeviceIds(visibleJob?.targets).length === 0
    ) {
      return c.json({ error: 'Patch job not found' }, 404);
    }

    return c.json({ data: { ...visibleJob, results: visibleResults } });
  }
);

// POST /patches/:id/rollback - Queue rollback commands for a patch
operationsRoutes.post(
  '/:id/rollback',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', patchIdParamSchema),
  zValidator('json', rollbackSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (data.scheduleType === 'scheduled') {
      return c.json({ error: 'Scheduled rollback is not supported yet' }, 400);
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const rollback = await queuePatchRollbacks({
      patchId: id,
      deviceIds: data.deviceIds,
      reason: data.reason ?? null,
      initiatedBy: auth.user.id,
      canAccess: (device) => auth.canAccessOrg(device.orgId) && canAccessDeviceSite(device, permissions),
      queue: (device, type, payload) =>
        queueCommandForExecution(device.id, type, payload, { userId: auth.user.id, preferHeartbeat: false })
    });

    if (!rollback) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    const { patch, accessibleDevices, queued, failed, skipped } = rollback;
    if (accessibleDevices.length === 0) {
      return c.json({ error: 'No accessible devices found for rollback', skipped }, 404);
    }

    const queuedCommandIds = queued.map((entry) => entry.commandId);
    const dispatchedCommandIds = queued
      .filter((entry) => entry.commandStatus === 'sent')
      .map((entry) => entry.commandId);
    const pendingCommandIds = queued
      .filter((entry) => entry.commandStatus !== 'sent')
      .map((entry) => entry.commandId);
    const failedDeviceIds = failed.map((entry) => entry.deviceId);

    writePatchAuditForOrgIds(
      c,
      accessibleDevices.map((d) => d.orgId),
      {
        action: 'patch.rollback',
        resourceType: 'patch',
        resourceId: id,
        resourceName: patch.title,
        result: queued.length === 0 ? 'failure' : 'success',
        details: {
          queuedCommandIds,
          dispatchedCommandIds,
          pendingCommandIds,
          deviceCount: accessibleDevices.length,
          failedDeviceIds,
          reason: data.reason ?? null
        }
      }
    );

    return c.json({
      success: failedDeviceIds.length === 0,
      patchId: id,
      queuedCommandIds,
      dispatchedCommandIds,
      pendingCommandIds,
      deviceCount: accessibleDevices.length,
      failedDeviceIds,
      skipped
    });
  }
);
