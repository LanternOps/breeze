/**
 * Software deployment creation shared by routes/software.ts and the AI
 * software tools: target resolution, the POST /deployments request schema and
 * body (version path + package-manager path), and the #7347 commit-then-
 * deliver wrapper. Moved verbatim from the route so REST and tools run the
 * same code. Cancel/retry live in softwareDeploymentLifecycle.ts and the
 * reads in softwareDeploymentQueries.ts; both are re-exported from here so a
 * caller has one import site.
 *
 * Every function takes the caller's resolved `orgId`, its permissions (site
 * axis), `createdBy` and an `audit` callback (the route implements it with
 * writeRouteAudit) and returns `{ status, body }` — exactly what the route
 * sends with c.json(body, status).
 */
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  softwareCatalog,
  softwareVersions,
  softwareInstallMethods,
  devices,
} from '../db/schema';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import { resolveDeploymentTargets } from './deploymentTargetResolver';
import { canAccessSite, type UserPermissions } from './permissions';
import { createSoftwareDeployment } from './softwareDeployment';
import { activeCatalog } from './softwareCatalogOps';

export * from './softwareDeploymentQueries';
export * from './softwareDeploymentLifecycle';

/** A route-shaped outcome: the route answers `c.json(body, status)`. */
export type SoftwareOpResult = {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
};

/**
 * #7347 — the pushes a deferred fan-out hands back, run once its transaction
 * has committed. Each entry is a `deliver()` from `createSoftwareDeployment` /
 * `buildAndDispatchSoftwareInstalls` with `deferDelivery`; none rejects.
 */
export type PendingInstallDeliveries = Array<() => Promise<unknown>>;

/**
 * #7347 — the deployment create routes (`POST /deployments`, `POST /deploy`)
 * and `POST /deployments/:id/retry` are registered in
 * middleware/selfManagedDbContextRoutes.ts: they run with NO ambient request
 * transaction. `admit` does all the route's DB work in ONE short
 * withAuthDbAccessContext block — the same single-transaction semantics the
 * request transaction gave it — with every software_install push deferred;
 * the pushes go out only after that block commits. The agent result path reads
 * `device_commands` on its own connection, so a push made inside the
 * transaction let a fast agent answer a row it could not see yet, and its
 * result was dropped as an orphan. A block that throws (including a failed
 * commit) propagates before anything is pushed.
 */
export async function commitThenDeliverWithAuth<T>(
  auth: AuthContext,
  admit: (deliveries: PendingInstallDeliveries) => Promise<T>,
): Promise<T> {
  const deliveries: PendingInstallDeliveries = [];
  const response = await withAuthDbAccessContext(auth, () => admit(deliveries));
  for (const deliver of deliveries) await deliver();
  return response;
}

export async function resolveSoftwareTargetDeviceIds(
  orgId: string,
  permissions: UserPermissions | undefined,
  payload: {
    targetType: 'devices' | 'groups' | 'sites' | 'all' | 'filter';
    targetIds?: string[];
    targetFilter?: unknown;
  },
) {
  if (payload.targetType === 'sites') {
    return {
      error: 'Site targeting is not implemented for software deployments',
      deviceIds: [] as string[],
    };
  }

  const targetConfig =
    payload.targetType === 'devices'
      ? { type: 'devices' as const, deviceIds: payload.targetIds ?? [] }
      : payload.targetType === 'groups'
        ? { type: 'groups' as const, groupIds: payload.targetIds ?? [] }
        : payload.targetType === 'filter'
          ? { type: 'filter' as const, filter: payload.targetFilter as never }
          : { type: 'all' as const };

  const deviceIds = await resolveDeploymentTargets({ orgId, targetConfig });
  if (deviceIds.length === 0) {
    return {
      error: 'No devices resolved for the selected target scope',
      status: 400 as const,
      deviceIds,
    };
  }

  if (permissions?.allowedSiteIds) {
    const rows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

    const allowedIds = rows
      .filter((device) => typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId))
      .map((device) => device.id);

    if (payload.targetType === 'devices' && allowedIds.length !== deviceIds.length) {
      return {
        error: 'Access to one or more device sites denied',
        status: 403 as const,
        deviceIds: [] as string[],
      };
    }

    if (allowedIds.length === 0) {
      return {
        error: 'No devices resolved for the selected target scope',
        status: 400 as const,
        deviceIds: allowedIds,
      };
    }

    return { deviceIds: allowedIds };
  }

  return { deviceIds };
}

export const createDeploymentSchema = z.object({
  name: z.string().min(1).max(255),
  // Exactly one target: an uploaded/URL version, or a catalog item whose
  // package-manager install methods the route resolves (winget/Homebrew).
  softwareVersionId: z.string().guid().optional(),
  catalogId: z.string().guid().optional(),
  // Manager deploys only. 'exact' additionally requires a winget method on the
  // item (validated in the handler — brew cannot pin a version).
  versionMode: z.enum(['latest', 'exact']).optional(),
  requestedVersion: z.string().min(1).max(64).optional(),
  deploymentType: z.enum(['install', 'uninstall', 'update']),
  targetType: z.enum(['devices', 'groups', 'sites', 'all', 'filter']),
  targetIds: z.array(z.string().guid()).optional(),
  targetFilter: z.unknown().optional(),
  scheduleType: z.enum(['immediate', 'scheduled', 'maintenance']),
  scheduledAt: z.string().datetime().optional(),
  maintenanceWindowId: z.string().guid().optional(),
  options: z.record(z.string(), z.unknown()).optional()
}).superRefine((data, ctx) => {
  // Mirrors software_deployments_one_target_chk: a deployment targets a
  // version XOR a catalog item's install method.
  if ((data.softwareVersionId == null) === (data.catalogId == null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['softwareVersionId'],
      message: 'Provide exactly one of softwareVersionId or catalogId',
    });
  }
  if (data.catalogId == null && (data.versionMode || data.requestedVersion)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['versionMode'],
      message: 'versionMode/requestedVersion apply only to package-manager (catalogId) deployments',
    });
  }
  if (data.versionMode === 'exact' && !data.requestedVersion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestedVersion'],
      message: "requestedVersion is required when versionMode is 'exact'",
    });
  }
  if (data.requestedVersion && data.versionMode !== 'exact') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['versionMode'],
      message: "requestedVersion requires versionMode 'exact'",
    });
  }
  // Reject what never runs (#1.4): nothing dispatches uninstall/update
  // deployments today — accepting them inserted rows that sat pending forever.
  if (data.deploymentType === 'uninstall' || data.deploymentType === 'update') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deploymentType'],
      message: 'Uninstall/update deployments are not yet supported',
    });
  }
  // A maintenance-window deployment without a window can never be evaluated by
  // the scheduler — it would sit undispatched forever.
  if (data.scheduleType === 'maintenance' && !data.maintenanceWindowId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maintenanceWindowId'],
      message: 'maintenanceWindowId is required for maintenance-window deployments',
    });
  }
  if (data.scheduleType === 'scheduled') {
    if (!data.scheduledAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledAt'],
        message: 'scheduledAt is required for scheduled deployments',
      });
    } else if (new Date(data.scheduledAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledAt'],
        message: 'scheduledAt must be in the future',
      });
    }
  }
});

/**
 * Bucket resolved target devices by the platform whose install method will
 * serve them. `servablePlatforms` is the set of platforms the catalog item
 * actually has an ENABLED method for — a device on a platform outside that
 * set (a Mac under a winget-only item) lands in `other` exactly like a Linux
 * device does. `other` is attached to the FIRST created deployment so the
 * fan-out records an explicit "No install method for this device OS
 * (<osType>)" failure row per device; nothing is ever silently dropped.
 */
export function splitTargetsByPlatform(
  deviceRows: { id: string; osType: string | null }[],
  servablePlatforms: ReadonlyArray<'windows' | 'macos'> = ['windows', 'macos'],
): { windows: string[]; macos: string[]; other: string[] } {
  const servable = new Set(servablePlatforms);
  const windows: string[] = [];
  const macos: string[] = [];
  const other: string[] = [];
  for (const row of deviceRows) {
    if (row.osType === 'windows' && servable.has('windows')) windows.push(row.id);
    else if (row.osType === 'macos' && servable.has('macos')) macos.push(row.id);
    else other.push(row.id);
  }
  return { windows, macos, other };
}

/**
 * Deterministic method choice for a platform. A catalog item may legitimately
 * carry BOTH a homebrew_cask and a homebrew_formula for macOS; row order from
 * the DB is not defined, so the pick is spelled out rather than left to
 * whichever row came back first. Casks (GUI apps) are preferred over formulae,
 * matching what an MSP deploying a desktop app expects.
 */
export function pickInstallMethodForPlatform<
  T extends { platform: string; kind: string },
>(methods: readonly T[], platform: 'windows' | 'macos'): T | null {
  const ofPlatform = methods.filter((m) => m.platform === platform);
  if (ofPlatform.length === 0) return null;
  const preference = platform === 'windows'
    ? ['winget']
    : ['homebrew_cask', 'homebrew_formula'];
  for (const kind of preference) {
    const match = ofPlatform.find((m) => m.kind === kind);
    if (match) return match;
  }
  return ofPlatform[0]!;
}

export type ManagerDeploymentPayload = {
  name: string;
  catalogId: string;
  versionMode?: 'latest' | 'exact';
  requestedVersion?: string;
  deploymentType: 'install' | 'uninstall' | 'update';
  targetType: 'devices' | 'groups' | 'sites' | 'all' | 'filter';
  targetIds?: string[];
  targetFilter?: unknown;
  scheduleType: 'immediate' | 'scheduled' | 'maintenance';
  scheduledAt?: string;
  maintenanceWindowId?: string;
  options?: Record<string, unknown>;
};

const PLATFORM_NAME_SUFFIX: Record<'windows' | 'macos', string> = {
  windows: ' (Windows)',
  macos: ' (macOS)',
};

/**
 * A software_deployments row references exactly ONE install method
 * (software_deployments_one_target_chk), but a catalog item may carry a
 * winget method AND a Homebrew method. So when the resolved target set spans
 * both platforms this creates one deployment per platform — each with its own
 * install_method_id and a platform-suffixed name — keeping the column honest
 * and every per-device result row unambiguous.
 */
export async function createManagerDeployments(params: {
  auth: AuthContext;
  permissions: UserPermissions | undefined;
  orgId: string;
  payload: ManagerDeploymentPayload;
  createdBy: string | null;
  deliveries: PendingInstallDeliveries;
  audit: (event: RouteAuditInput) => void;
}): Promise<SoftwareOpResult> {
  const { permissions, orgId, payload, createdBy, deliveries, audit } = params;

  const [catalogItem] = await db.select({
    id: softwareCatalog.id,
    orgId: softwareCatalog.orgId,
    name: softwareCatalog.name,
    integrationProvider: softwareCatalog.integrationProvider,
  }).from(softwareCatalog)
    .where(and(eq(softwareCatalog.id, payload.catalogId), activeCatalog));
  // Same ownership guard as the version path: built-ins (org_id NULL) are
  // visible to everyone, an org-owned row must match the caller's org.
  if (!catalogItem || (catalogItem.orgId !== null && catalogItem.orgId !== orgId)) {
    return { status: 404, body: { error: 'Catalog item not found or access denied' } };
  }

  const methods = await db.select().from(softwareInstallMethods)
    .where(and(
      eq(softwareInstallMethods.catalogId, catalogItem.id),
      eq(softwareInstallMethods.enabled, true),
    ));
  if (methods.length === 0) {
    return { status: 400, body: { error: 'This catalog item has no enabled install method to deploy' } };
  }

  const versionMode = payload.versionMode ?? 'latest';
  // Only winget can install a pinned version; Homebrew always installs the
  // formula/cask's current version.
  if (versionMode === 'exact' && !methods.some((m) => m.kind === 'winget')) {
    return {
      status: 400,
      body: { error: "versionMode 'exact' requires a winget install method on this catalog item" },
    };
  }

  const resolvedTargets = await resolveSoftwareTargetDeviceIds(
    orgId,
    permissions,
    payload,
  );
  if (resolvedTargets.error) {
    return { status: resolvedTargets.status ?? 400, body: { error: resolvedTargets.error } };
  }

  const deviceRows = await db.select({ id: devices.id, osType: devices.osType })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, resolvedTargets.deviceIds)));
  // Only platforms with an enabled method can be served; devices on the other
  // platform fall into `split.other` and get failure rows.
  const pickedMethods = {
    windows: pickInstallMethodForPlatform(methods, 'windows'),
    macos: pickInstallMethodForPlatform(methods, 'macos'),
  };
  const servablePlatforms = (['windows', 'macos'] as const).filter((p) => pickedMethods[p]);
  const split = splitTargetsByPlatform(deviceRows, servablePlatforms);

  // One group per platform that has BOTH an enabled method and target devices,
  // Windows first for determinism.
  const groups: {
    platform: 'windows' | 'macos';
    method: (typeof methods)[number];
    deviceIds: string[];
  }[] = [];
  for (const platform of servablePlatforms) {
    if (split[platform].length === 0) continue;
    groups.push({ platform, method: pickedMethods[platform]!, deviceIds: [...split[platform]] });
  }
  if (groups.length === 0) {
    // Nothing the item can serve (e.g. a winget-only item aimed at Macs).
    // Still create ONE deployment so every target device gets a recorded
    // failure row rather than a 201 covering nothing. Windows-first keeps the
    // choice deterministic.
    const fallbackPlatform = servablePlatforms[0]!;
    groups.push({
      platform: fallbackPlatform,
      method: pickedMethods[fallbackPlatform]!,
      deviceIds: [],
    });
  }
  // Unservable devices ride along with the first deployment so the fan-out
  // writes their "No install method for this device OS" result rows.
  groups[0]!.deviceIds.push(...split.other);

  const isSplit = groups.length > 1;
  const results = [];
  for (const group of groups) {
    // Only winget can install a pinned version. In a split request the
    // Homebrew half silently falls back to 'latest' rather than failing the
    // whole request — brew is latest-only in phase 1.
    const groupVersionMode = group.method.kind === 'winget' ? versionMode : 'latest';
    const result = await createSoftwareDeployment({
      orgId,
      installMethodId: group.method.id,
      versionMode: groupVersionMode,
      requestedVersion: groupVersionMode === 'exact' ? payload.requestedVersion : undefined,
      deploymentType: payload.deploymentType,
      deviceIds: group.deviceIds,
      scheduleType: payload.scheduleType,
      createdBy,
      name: isSplit ? `${payload.name}${PLATFORM_NAME_SUFFIX[group.platform]}` : payload.name,
      scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
      maintenanceWindowId: payload.maintenanceWindowId ?? null,
      // A split deployment records the devices it actually owns; an unsplit one
      // preserves the caller's raw selection, same as the version path.
      targetType: isSplit ? 'devices' : payload.targetType,
      targetIds: isSplit ? group.deviceIds : payload.targetIds ?? null,
      options:
        payload.targetType === 'filter'
          ? { ...(payload.options ?? {}), targetFilter: payload.targetFilter ?? null }
          : payload.options ?? undefined,
      deferDelivery: true,
    });
    if (result.deliver) deliveries.push(result.deliver);
    results.push(result);

    audit({
      orgId,
      action: 'software.deployment.create',
      resourceType: 'software_deployment',
      resourceId: result.deploymentId,
      resourceName: payload.name,
      details: {
        deploymentType: payload.deploymentType,
        targetType: payload.targetType,
        deviceCount: group.deviceIds.length,
        installMethodId: group.method.id,
        platform: group.platform,
        kind: group.method.kind,
        versionMode: groupVersionMode,
      },
    });
  }

  const deployments = results.map((r) => r.deployment);
  if (results.every((r) => r.status === 'failed')) {
    return {
      status: 200,
      body: {
        data: { id: results[0]!.deploymentId, status: 'failed', message: results[0]!.message },
        deployments,
      },
    };
  }
  // `data` stays the (first) deployment object for parity with the version
  // path; `deployments` carries every row a split produced.
  return { status: 201, body: { data: deployments[0], deployments } };
}

export type CreateDeploymentPayload = z.infer<typeof createDeploymentSchema>;

/**
 * The body of POST /deployments after org resolution: the package-manager
 * path when the payload names a catalog item, otherwise the version path.
 * Must run inside commitThenDeliverWithAuth (or the route's commitThenDeliver):
 * every software_install push is appended to `deliveries` and sent only after
 * the surrounding transaction commits (#7347).
 */
export async function createSoftwareDeploymentFromRequest(params: {
  auth: AuthContext;
  permissions: UserPermissions | undefined;
  orgId: string;
  payload: CreateDeploymentPayload;
  createdBy: string | null;
  deliveries: PendingInstallDeliveries;
  audit: (event: RouteAuditInput) => void;
}): Promise<SoftwareOpResult> {
  const { permissions, orgId, payload, createdBy, deliveries, audit } = params;

  // Package-manager path: the request names a catalog item, not a version.
  if (payload.catalogId) {
    return createManagerDeployments({ ...params, payload: payload as ManagerDeploymentPayload });
  }

  // Verify version exists and get catalog info
  const [versionRecord] = await db.select().from(softwareVersions)
    .where(eq(softwareVersions.id, payload.softwareVersionId!));
  if (!versionRecord) return { status: 404, body: { error: 'Software version not found' } };

  const [catalogItem] = await db.select({
    id: softwareCatalog.id,
    orgId: softwareCatalog.orgId,
    name: softwareCatalog.name,
    integrationProvider: softwareCatalog.integrationProvider,
  }).from(softwareCatalog)
    .where(and(eq(softwareCatalog.id, versionRecord.catalogId), activeCatalog));
  // RLS already restricts visibility to the caller's org rows + partner-scoped
  // NULL-org rows (built-in EDR packages, and — for partner-scope tokens —
  // partner-wide custom packages, #2135). Extra guard: an org-owned row must
  // match the authenticated org; NULL-org rows are allowed and the deployment
  // itself is stamped with the resolved context org.
  if (!catalogItem || (catalogItem.orgId !== null && catalogItem.orgId !== orgId)) {
    return { status: 404, body: { error: 'Catalog item not found or access denied' } };
  }

  const resolvedTargets = await resolveSoftwareTargetDeviceIds(orgId, permissions, payload);
  if (resolvedTargets.error) {
    const status = resolvedTargets.status ?? 400;
    return { status, body: { error: resolvedTargets.error } };
  }
  const targetDeviceIds = resolvedTargets.deviceIds;

  const result = await createSoftwareDeployment({
    orgId,
    softwareVersionId: payload.softwareVersionId,
    deploymentType: payload.deploymentType,
    deviceIds: targetDeviceIds,
    scheduleType: payload.scheduleType,
    createdBy,
    name: payload.name,
    scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
    maintenanceWindowId: payload.maintenanceWindowId ?? null,
    targetType: payload.targetType,
    targetIds: payload.targetIds ?? null,
    options:
      payload.targetType === 'filter'
        ? { ...(payload.options ?? {}), targetFilter: payload.targetFilter ?? null }
        : payload.options ?? undefined,
    deferDelivery: true,
  });
  if (result.deliver) deliveries.push(result.deliver);

  if (result.status === 'failed') {
    return { status: 200, body: { data: { id: result.deploymentId, status: result.status, message: result.message } } };
  }

  audit({
    orgId,
    action: 'software.deployment.create',
    resourceType: 'software_deployment',
    resourceId: result.deploymentId,
    resourceName: payload.name,
    details: {
      deploymentType: payload.deploymentType,
      targetType: payload.targetType,
      deviceCount: targetDeviceIds.length,
    },
  });

  return { status: 201, body: { data: result.deployment } };
}
