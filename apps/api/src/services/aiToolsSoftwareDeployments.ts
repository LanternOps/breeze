/**
 * `manage_software_deployments` (full-control W12, #6782): the AI twin of the
 * /software/deployments routes, over the SAME services they call
 * (services/softwareDeploymentOps.ts, …Lifecycle.ts, …Queries.ts).
 *
 *  - `list` / `summary` (t1): org-wide; refused to a session bound to exact
 *    devices (quorum QW7). `get` / `results` (t1): site-filtered as REST; a
 *    device-bound session sees a deployment only when EVERY device in it is in
 *    its allowlist.
 *  - `create` (supervised): install one catalog package (a version, or the
 *    item's winget / Homebrew methods) on at most 100 NAMED devices (quorum QW3:
 *    no groups, `all` or `filter`, so the approver sees the exact set). Every
 *    device passes the route's site filter and the exact-device axis. The
 *    version / install-method fingerprint is pinned by the
 *    `manage_software_deployments:create` effect digest (W12-D12), so an
 *    installer edited between approval and release refuses the release.
 *  - `cancel` (t2): pending installs only, as REST. `retry` (supervised).
 *
 * `create` and `retry` manage their own DB context (#7347, #7128): every row
 * commits before any software_install push (`commitThenDeliverWithAuth`).
 * `created_by` is the caller only when it is a `users` row (W12-D3). Every
 * write's REST twin carries `requireMfa()` (W12-D5).
 */
import { and, eq } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext } from '../db';
import { deploymentResults, maintenanceWindows } from '../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import type { UserPermissions } from './permissions';
import type { RouteAuditInput } from './auditEvents';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { commitThenDeliverWithAuth, createDeploymentSchema, createSoftwareDeploymentFromRequest } from './softwareDeploymentOps';
import { cancelSoftwareDeployment, retrySoftwareDeployment } from './softwareDeploymentLifecycle';
import {
  getSoftwareDeployment, getSoftwareDeploymentSummary, listSoftwareDeploymentResults, listSoftwareDeployments,
} from './softwareDeploymentQueries';
import { resolveScopedOrgId } from './softwareVersionShared';
import { MAX_DEPLOYMENT_DEVICE_TARGETS, SOFTWARE_DEPLOYMENT_ACTIONS } from './aiToolSchemasSoftware';
import {
  auditToolWrite, bounded, clampLimit, clampOffset, deviceBoundDenied, httpResult, jsonError, notFound, requireFields, str,
  thrown, verifiedUserIdOrNull,
} from './aiToolsSoftwareShared';

type Action = (typeof SOFTWARE_DEPLOYMENT_ACTIONS)[number];
const TOOL = 'manage_software_deployments';

/** The route's `permissions` argument: only the site allowlist is read by these services. */
function sitePermissions(auth: AuthContext): UserPermissions | undefined {
  return auth.allowedSiteIds === undefined ? undefined : ({ allowedSiteIds: [...auth.allowedSiteIds] } as UserPermissions);
}

function inCallerContext<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return hasDbAccessContext() ? fn() : withDbAccessContext(dbAccessContextFromAuth(auth), fn);
}

/** Quorum QW7: a device-bound session reaches a deployment only when every device in it is allowed. */
async function deploymentOutsideDeviceAxis(auth: AuthContext, deploymentId: string): Promise<boolean> {
  const allowed = auth.allowedDeviceIds;
  if (allowed === undefined) return false;
  const rows = await db.select({ deviceId: deploymentResults.deviceId }).from(deploymentResults)
    .where(eq(deploymentResults.deploymentId, deploymentId));
  return rows.length === 0 || rows.some((r) => !allowed.includes(r.deviceId));
}

function auditFor(auth: AuthContext, orgId: string) {
  return (event: RouteAuditInput) => auditToolWrite(auth, {
    orgId: event.orgId ?? orgId,
    action: event.action,
    resourceType: event.resourceType,
    ...(event.resourceId ? { resourceId: event.resourceId } : {}),
    ...(event.resourceName ? { resourceName: event.resourceName } : {}),
    ...(event.details ? { details: event.details } : {}),
  });
}

export function registerSoftwareDeploymentTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'patching',
    searchHint: 'deploy or install catalog software on devices; deployment status, results, cancel, retry',
    selfManagedDbContext: ['create', 'retry'],
    deviceArgs: ['deviceIds'],
    definition: {
      name: TOOL,
      description: 'Software deployments: list/summary/get/results; create (install a catalog version or package on up to 100 deviceIds), cancel pending installs, retry failed ones. Create and retry need approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SOFTWARE_DEPLOYMENT_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (partner scope)' },
          deploymentId: { type: 'string', description: 'Deployment UUID' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'completed_with_errors', 'failed', 'cancelled'], description: 'list filter' },
          resultStatus: { type: 'string', enum: ['pending', 'running', 'paused', 'downloading', 'installing', 'completed', 'failed', 'cancelled', 'rollback'], description: 'results filter' },
          name: { type: 'string', description: 'create: deployment name' },
          softwareVersionId: { type: 'string', description: 'create: a catalog version (uploaded or URL installer)' },
          catalogId: { type: 'string', description: 'create: a catalog item installed by its winget/Homebrew methods' },
          versionMode: { type: 'string', enum: ['latest', 'exact'], description: 'create with catalogId: version to install' },
          requestedVersion: { type: 'string', description: 'create with versionMode exact (winget only)' },
          scheduleType: { type: 'string', enum: ['immediate', 'scheduled', 'maintenance'], description: 'create: when (default immediate)' },
          scheduledAt: { type: 'string', description: 'create: ISO time for scheduled' },
          maintenanceWindowId: { type: 'string', description: 'create: maintenance window UUID' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'create: target devices (max 100); retry: limit to these' },
          reason: { type: 'string', description: 'cancel: why' },
          limit: { type: 'number', description: 'Max rows; list default 25 max 100, results (default 100, max 500)' },
          offset: { type: 'number', description: 'results: rows to skip' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!SOFTWARE_DEPLOYMENT_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError(TOOL, action, auth);
      if (mfa) return mfa;
      const org = resolveScopedOrgId(auth, str(input.orgId));
      if ('error' in org) return org.status === 403 ? notFound('Organization') : jsonError(org.error, 'VALIDATION_ERROR');
      const orgId = org.orgId;
      const permissions = sitePermissions(auth);

      try {
        if (action === 'list' || action === 'summary') {
          const denied = deviceBoundDenied(auth, 'The deployment list');
          if (denied) return denied;
          if (action === 'summary') return bounded(await getSoftwareDeploymentSummary({ auth, permissions, orgId }));
          const limit = clampLimit(input.limit, 25, 100);
          return bounded(await listSoftwareDeployments({ auth, permissions, orgId, page: 1, limit }));
        }

        if (action === 'create') {
          const deviceIds = Array.isArray(input.deviceIds) ? (input.deviceIds as string[]) : [];
          if (deviceIds.length === 0) return jsonError('deviceIds is required (1-100 devices)', 'VALIDATION_ERROR');
          if (deviceIds.length > MAX_DEPLOYMENT_DEVICE_TARGETS) return jsonError('At most 100 devices per deployment', 'VALIDATION_ERROR');
          if (auth.allowedDeviceIds !== undefined && deviceIds.some((id) => !auth.allowedDeviceIds!.includes(id))) {
            return notFound('Device');
          }
          const parsed = createDeploymentSchema.safeParse({
            name: str(input.name) ?? 'AI deployment',
            ...(input.softwareVersionId !== undefined ? { softwareVersionId: input.softwareVersionId } : {}),
            ...(input.catalogId !== undefined ? { catalogId: input.catalogId } : {}),
            ...(input.versionMode !== undefined ? { versionMode: input.versionMode } : {}),
            ...(input.requestedVersion !== undefined ? { requestedVersion: input.requestedVersion } : {}),
            deploymentType: 'install',
            targetType: 'devices',
            targetIds: deviceIds,
            scheduleType: (input.scheduleType as string | undefined) ?? 'immediate',
            ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
            ...(input.maintenanceWindowId !== undefined ? { maintenanceWindowId: input.maintenanceWindowId } : {}),
          });
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid deployment', 'VALIDATION_ERROR');
          const createdBy = await verifiedUserIdOrNull(auth);
          const result = await commitThenDeliverWithAuth(auth, async (deliveries) => {
            // Quorum QW7: a referenced maintenance window must belong to the deployment's org.
            if (parsed.data.maintenanceWindowId) {
              const [window] = await db.select({ id: maintenanceWindows.id }).from(maintenanceWindows)
                .where(and(eq(maintenanceWindows.id, parsed.data.maintenanceWindowId), eq(maintenanceWindows.orgId, orgId))).limit(1);
              if (!window) return { status: 404 as const, body: { error: 'Maintenance window not found' } };
            }
            return createSoftwareDeploymentFromRequest({
              auth, permissions, orgId, payload: parsed.data, createdBy, deliveries, audit: auditFor(auth, orgId),
            });
          });
          return httpResult(result);
        }

        const missing = requireFields(input, ['deploymentId'], action);
        if (missing) return missing;
        const deploymentId = String(input.deploymentId);

        if (action === 'retry') {
          const createdBy = await verifiedUserIdOrNull(auth);
          const payload = Array.isArray(input.deviceIds) ? { deviceIds: input.deviceIds as string[] } : {};
          const result = await commitThenDeliverWithAuth(auth, async (deliveries) => {
            if (await deploymentOutsideDeviceAxis(auth, deploymentId)) return { status: 404 as const, body: { error: 'Deployment not found' } };
            return retrySoftwareDeployment({
              auth, permissions, orgId, deploymentId, payload, createdBy, deliveries, audit: auditFor(auth, orgId),
            });
          });
          return httpResult(result);
        }

        return await inCallerContext(auth, async () => {
          if (await deploymentOutsideDeviceAxis(auth, deploymentId)) return notFound('Deployment');
          if (action === 'get') {
            const deployment = await getSoftwareDeployment({ auth, permissions, orgId, deploymentId });
            return deployment ? bounded({ deployment }) : notFound('Deployment');
          }
          if (action === 'results') {
            const page = await listSoftwareDeploymentResults({
              auth, permissions, orgId, deploymentId,
              status: input.resultStatus as Parameters<typeof listSoftwareDeploymentResults>[0]['status'],
              limit: clampLimit(input.limit, 100, 500), offset: clampOffset(input.offset),
            });
            return page ? bounded(page) : notFound('Deployment');
          }
          // cancel
          const result = await cancelSoftwareDeployment({
            auth, permissions, orgId, deploymentId,
            payload: typeof input.reason === 'string' ? { reason: input.reason } : {},
            audit: auditFor(auth, orgId),
          });
          return httpResult(result);
        });
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
