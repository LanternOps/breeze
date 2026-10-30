/**
 * Software deployment cancel and retry, shared by routes/software.ts and the
 * AI software tools. Moved verbatim from POST /software/deployments/:id/cancel
 * and /retry (after org resolution) so REST and tools run the same code. Each
 * returns `{ status, body }`, exactly what the route sends.
 */
import { z } from 'zod';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  softwareCatalog,
  softwareVersions,
  softwareDeployments,
  deploymentResults,
  softwareInstallMethods,
  devices,
  deviceCommands,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import { canAccessSite, type UserPermissions } from './permissions';
import { buildAndDispatchSoftwareInstalls } from './softwareDeployment';
import {
  dependencyFingerprintError,
  fingerprintSoftwareInstallMethodDependency,
  fingerprintSoftwareVersionDependency,
} from './softwareDependencyIdentity';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import { applyAutomationActionTerminal } from './automationActionResults';
import {
  emptyStatusCounts,
  getDeploymentStatusMap,
  loadScopedSoftwareDeployment,
} from './softwareDeploymentQueries';
import type { PendingInstallDeliveries, SoftwareOpResult } from './softwareDeploymentOps';

export const retryDeploymentSchema = z.object({
  deviceIds: z.array(z.string().guid()).max(1000).optional(),
});

export const cancelDeploymentSchema = z.object({
  reason: z.string().max(500).optional()
});

/**
 * POST /deployments/:id/cancel after org resolution: flip pending results to
 * cancelled, settle their automation actions, purge still-queued offline
 * commands, audit, and return the re-aggregated deployment.
 */
export async function cancelSoftwareDeployment(params: {
  auth: AuthContext;
  permissions: UserPermissions | undefined;
  orgId: string;
  deploymentId: string;
  payload: z.infer<typeof cancelDeploymentSchema>;
  audit: (event: RouteAuditInput) => void;
}): Promise<SoftwareOpResult> {
  const { auth, permissions, orgId, deploymentId: id, audit } = params;

  const deployment = await loadScopedSoftwareDeployment({ permissions, orgId, deploymentId: id });
  if (!deployment) return { status: 404, body: { error: 'Deployment not found' } };

  // Update pending results to cancelled. `.returning()` surfaces which rows
  // carried a queued device_commands link (offline-queue fallback) so the
  // not-yet-delivered commands can be purged below.
  const cancellationCompletedAt = new Date();
  const flipped = await db.update(deploymentResults)
    .set({ status: 'cancelled', completedAt: cancellationCompletedAt })
    .where(and(
      eq(deploymentResults.deploymentId, id),
      eq(deploymentResults.status, 'pending')
    ))
    .returning({
      id: deploymentResults.id,
      deviceCommandId: deploymentResults.deviceCommandId,
    });

  for (const result of flipped) {
    await applyAutomationActionTerminal({
      source: 'cancellation',
      deploymentResultId: result.id,
      terminalStatus: 'cancelled',
      completedAt: cancellationCompletedAt,
    });
  }

  // Honest cancel: a queued-offline install must not execute when the agent
  // eventually reconnects. Cancel the linked device_commands rows that are
  // STILL 'pending' (not yet claimed by the agent) — mirrors the stale
  // reaper's tier-2 guarded cancel, same result payload shape. Delivered
  // ('sent') commands are left alone: in-flight installs run to completion
  // by design, and their late results no-op against the already-cancelled
  // result rows via the pending-status guard.
  const queuedCommandIds = [
    ...new Set(
      flipped
        .map((row) => row.deviceCommandId)
        .filter((commandId): commandId is string => typeof commandId === 'string'),
    ),
  ];
  let cancelledQueuedCommands = 0;
  if (queuedCommandIds.length > 0) {
    const cancelledCommands = await db.update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        result: {
          status: 'cancelled',
          error: 'Deployment cancelled before delivery',
          cancelledBy: auth.user?.id ?? 'software-deployment-cancel',
        },
        ...terminalPayloadErasureSet(),
      })
      .where(and(
        inArray(deviceCommands.id, queuedCommandIds),
        eq(deviceCommands.status, 'pending'),
      ))
      .returning({ id: deviceCommands.id });
    cancelledQueuedCommands = cancelledCommands.length;
  }

  audit({
    orgId,
    action: 'software.deployment.cancel',
    resourceType: 'software_deployment',
    resourceId: id,
    resourceName: deployment.name,
    details: {
      cancelledResultCount: flipped.length,
      cancelledQueuedCommands,
    },
  });

  const statusMap = await getDeploymentStatusMap([id]);
  const entry = statusMap.get(id);

  return {
    status: 200,
    body: {
      data: {
        ...deployment,
        status: entry?.status ?? 'cancelled',
        counts: entry?.counts ?? emptyStatusCounts(),
      },
      cancelledQueuedCommands,
    },
  };
}

// ---------------------------------------------------------------------------
// Retry dispatch helper
// ---------------------------------------------------------------------------

// Re-dispatch a retried device subset through the shared fan-out
// (services/softwareDeployment.ts). `scopeToDeviceIds` restricts the shared
// builder's failure pre-writes (EDR resolution error, missing installer,
// unresolvable `{{...}}` variables) to the retried rows only — previously
// COMPLETED rows are never clobbered to failed. The version/catalog lookups
// live here because the builder takes them as inputs; if either row has been
// deleted since the original dispatch, fail just the retried rows.
export async function redispatchSoftwareInstall(opts: {
  deployment: typeof softwareDeployments.$inferSelect;
  orgId: string;
  deviceIds: string[];
  createdBy: string | null;
  /** Post-bump retryCount per device, keyed by deviceId — see the caller. */
  deviceRetryCounts: Record<string, number>;
  /** #7347 — collects the fan-out's deferred push; the route runs it after commit. */
  deliveries: PendingInstallDeliveries;
}): Promise<{ dispatchedDeviceIds: string[]; error?: string }> {
  const { deployment, orgId, deviceIds, createdBy, deviceRetryCounts, deliveries } = opts;

  const failTargets = async (errorMessage: string) => {
    await db.update(deploymentResults)
      .set({ status: 'failed', errorMessage, completedAt: new Date() })
      .where(and(
        eq(deploymentResults.deploymentId, deployment.id),
        inArray(deploymentResults.deviceId, deviceIds),
      ));
  };

  // Package-manager deployment: re-resolve the install method instead of a
  // version. The version intent lives in `options` (written at create).
  if (deployment.installMethodId) {
    const [method] = await db.select().from(softwareInstallMethods)
      .where(eq(softwareInstallMethods.id, deployment.installMethodId));
    if (!method) {
      const error = 'Install method no longer exists for this deployment';
      await failTargets(error);
      return { dispatchedDeviceIds: [], error };
    }
    const [managerCatalogItem] = await db.select({
      id: softwareCatalog.id,
      orgId: softwareCatalog.orgId,
      name: softwareCatalog.name,
      integrationProvider: softwareCatalog.integrationProvider,
    }).from(softwareCatalog)
      // Deliberately NOT filtered on deletedAt: a deployment created before its
      // package was archived (#4980) still dispatches.
      .where(eq(softwareCatalog.id, method.catalogId));
    if (!managerCatalogItem) {
      const error = 'Catalog item no longer exists for this deployment';
      await failTargets(error);
      return { dispatchedDeviceIds: [], error };
    }
    const dependencyError = dependencyFingerprintError(
      deployment.dependencyFingerprint,
      fingerprintSoftwareInstallMethodDependency(method, managerCatalogItem),
    );
    if (dependencyError) {
      await failTargets(dependencyError);
      return { dispatchedDeviceIds: [], error: dependencyError };
    }
    const opts = (deployment.options ?? null) as Record<string, unknown> | null;
    const fanout = await buildAndDispatchSoftwareInstalls({
      deploymentId: deployment.id,
      orgId,
      installMethod: method,
      versionMode: opts?.versionMode === 'exact' ? 'exact' : 'latest',
      requestedVersion: typeof opts?.requestedVersion === 'string' ? opts.requestedVersion : null,
      catalogItem: managerCatalogItem,
      deviceIds,
      scopeToDeviceIds: deviceIds,
      options: opts,
      createdBy,
      markDispatched: false,
      deviceRetryCounts,
      deferDelivery: true,
    });
    if (fanout.deliver) deliveries.push(fanout.deliver);
    return {
      dispatchedDeviceIds: fanout.dispatchedDeviceIds,
      ...(fanout.status === 'failed' && fanout.message ? { error: fanout.message } : {}),
    };
  }

  const [versionRecord] = await db.select().from(softwareVersions)
    .where(eq(softwareVersions.id, deployment.softwareVersionId!));
  if (!versionRecord) {
    const error = 'Software version no longer exists for this deployment';
    await failTargets(error);
    return { dispatchedDeviceIds: [], error };
  }

  const [catalogItem] = await db.select({
    id: softwareCatalog.id,
    orgId: softwareCatalog.orgId,
    name: softwareCatalog.name,
    integrationProvider: softwareCatalog.integrationProvider,
  }).from(softwareCatalog)
    // Deliberately NOT filtered on deletedAt — see the manager branch above.
    .where(eq(softwareCatalog.id, versionRecord.catalogId));
  if (!catalogItem) {
    const error = 'Catalog item no longer exists for this deployment';
    await failTargets(error);
    return { dispatchedDeviceIds: [], error };
  }

  const dependencyError = dependencyFingerprintError(
    deployment.dependencyFingerprint,
    fingerprintSoftwareVersionDependency(versionRecord, catalogItem),
  );
  if (dependencyError) {
    await failTargets(dependencyError);
    return { dispatchedDeviceIds: [], error: dependencyError };
  }

  // markDispatched: false — the deployment already carries its dispatched_at
  // claim from the original run; a retry must not re-stamp it.
  const fanout = await buildAndDispatchSoftwareInstalls({
    deploymentId: deployment.id,
    orgId,
    versionRecord,
    catalogItem,
    deviceIds,
    scopeToDeviceIds: deviceIds,
    options: (deployment.options ?? null) as Record<string, unknown> | null,
    createdBy,
    markDispatched: false,
    deviceRetryCounts,
    deferDelivery: true,
  });
  if (fanout.deliver) deliveries.push(fanout.deliver);

  return {
    dispatchedDeviceIds: fanout.dispatchedDeviceIds,
    ...(fanout.status === 'failed' && fanout.message ? { error: fanout.message } : {}),
  };
}
/**
 * POST /deployments/:id/retry after org resolution: flip the targeted failed
 * rows back to pending (bumping retryCount), re-dispatch them through the
 * shared fan-out with every push deferred into `deliveries`, audit, and report
 * retried/skipped devices. Must run inside commitThenDeliverWithAuth (or the
 * route's commitThenDeliver) so the pushes go out only after commit (#7347).
 */
export async function retrySoftwareDeployment(params: {
  auth: AuthContext;
  permissions: UserPermissions | undefined;
  orgId: string;
  deploymentId: string;
  payload: z.infer<typeof retryDeploymentSchema>;
  createdBy: string | null;
  deliveries: PendingInstallDeliveries;
  audit: (event: RouteAuditInput) => void;
}): Promise<SoftwareOpResult> {
  const { permissions, orgId, deploymentId: id, createdBy, deliveries, audit } = params;
  const { deviceIds } = params.payload;

  // Strict parent, same as list/summary/get/cancel. The per-device retry
  // narrowing below is not sufficient on its own: without this the parent
  // still resolves for a site-restricted caller, so a deployment that
  // `GET /deployments/:id` refuses to show is still confirmed to exist here
  // (and remains mutable) — an existence oracle around the gate.
  const deployment = await loadScopedSoftwareDeployment({ permissions, orgId, deploymentId: id });
  if (!deployment) return { status: 404, body: { error: 'Deployment not found' } };

  // Retrying an undispatched scheduled/maintenance deployment makes no sense —
  // its rows are pending because the scheduler hasn't run it yet, not failed.
  if (!deployment.dispatchedAt) {
    return {
      status: 409,
      body: { error: 'Deployment has not been dispatched yet — only deployments that already ran can be retried' },
    };
  }

  // Site is an app-layer concept only — RLS doesn't defend it — so a
  // site-restricted caller must not be able to re-trigger installs on
  // devices in sites outside their allowlist (see PR #864/#868).
  let siteAllowedDeviceIds: string[] | null = null;
  if (permissions?.allowedSiteIds) {
    const orgDevices = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.orgId, orgId));
    siteAllowedDeviceIds = orgDevices
      .filter((device) => typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId))
      .map((device) => device.id);
    if (siteAllowedDeviceIds.length === 0) {
      return { status: 200, body: { retriedDeviceIds: [], skippedDeviceIds: deviceIds ?? [] } };
    }
  }

  // Flip targeted failed rows back to pending, bumping retryCount and
  // clearing prior-attempt fields. .returning() tells us which rows actually
  // flipped — requested devices that were not in failed status (or not part
  // of this deployment), or outside the caller's site scope, are reported as
  // skipped.
  const conditions = [
    eq(deploymentResults.deploymentId, id),
    eq(deploymentResults.status, 'failed'),
  ];
  if (deviceIds && deviceIds.length > 0) {
    conditions.push(inArray(deploymentResults.deviceId, deviceIds));
  }
  if (siteAllowedDeviceIds) {
    conditions.push(inArray(deploymentResults.deviceId, siteAllowedDeviceIds));
  }

  // .returning() also carries the post-increment retryCount per device
  // (not just deviceId) — the re-dispatch below MUST bake this NEW attempt
  // number into the WS command id it builds so a late result from the
  // attempt being retried can never be misattributed to this one (see
  // dispatchSoftwareInstallToDevice / applySoftwareInstallResult). This
  // UPDATE...RETURNING is the ordering guarantee: retryCount is bumped in
  // the DB before redispatchSoftwareInstall (and therefore the new command
  // id) is ever constructed.
  const flipped = await db.update(deploymentResults)
    .set({
      status: 'pending',
      retryCount: sql`${deploymentResults.retryCount} + 1`,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      output: null,
      errorMessage: null,
      deviceCommandId: null,
    })
    .where(and(...conditions))
    .returning({ deviceId: deploymentResults.deviceId, retryCount: deploymentResults.retryCount });

  const retriedDeviceIds = flipped.map((row) => row.deviceId);
  const retriedSet = new Set(retriedDeviceIds);
  const skippedDeviceIds = (deviceIds ?? []).filter((deviceId) => !retriedSet.has(deviceId));
  const deviceRetryCounts = Object.fromEntries(
    flipped.map((row) => [row.deviceId, row.retryCount]),
  );

  let dispatchError: string | undefined;
  if (retriedDeviceIds.length > 0) {
    const dispatchResult = await redispatchSoftwareInstall({
      deployment,
      orgId,
      deviceIds: retriedDeviceIds,
      createdBy,
      deviceRetryCounts,
      deliveries,
    });
    dispatchError = dispatchResult.error;
  }

  audit({
    orgId,
    action: 'software.deployment.retry',
    resourceType: 'software_deployment',
    resourceId: id,
    resourceName: deployment.name,
    details: {
      retriedCount: retriedDeviceIds.length,
      skippedCount: skippedDeviceIds.length,
      ...(deviceIds && deviceIds.length > 0 ? { requestedDeviceIds: deviceIds } : {}),
    },
  });

  return {
    status: 200,
    body: {
      retriedDeviceIds,
      skippedDeviceIds,
      ...(dispatchError ? { message: dispatchError } : {}),
    },
  };
}
