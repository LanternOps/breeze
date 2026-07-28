import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  deploymentResults,
  devices,
  organizations,
  sites,
  softwareCatalog,
  softwareDeployments,
  softwareVersions,
} from '../db/schema';
import { resolveEdrInstaller, type ResolvedInstaller } from './edrInstallerResolver';
import { resolveInstallerVariables, type InstallerVariableContext } from './installerVariables';
import { getPresignedUrl, isS3Configured, isS3NotFound } from './s3Storage';
import { queueCommand } from './commandQueue';
import { sendCommandToAgent, type AgentCommand } from '../routes/agentWs';

export interface CreateSoftwareDeploymentInput {
  orgId: string;
  softwareVersionId: string;
  deploymentType: 'install' | 'update' | 'uninstall';
  deviceIds: string[];
  scheduleType: 'immediate' | 'scheduled' | 'maintenance';
  createdBy: string | null;
  name?: string;
  scheduledAt?: Date | null;
  options?: Record<string, unknown>;
  /** Preserved from the original route; omit for automation callers. Defaults to null. */
  maintenanceWindowId?: string | null;
  /**
   * The original targetType from the HTTP payload. When provided the stored
   * row reflects the user's intent (e.g. 'all', 'groups'). When omitted
   * (automation callers that pass a pre-resolved deviceIds list) defaults to
   * 'devices'. The dispatch always uses the resolved `deviceIds` either way.
   */
  targetType?: 'devices' | 'groups' | 'sites' | 'all' | 'filter';
  /**
   * The original targetIds from the HTTP payload. When provided the stored
   * row reflects the user's raw selection. When omitted defaults to the
   * resolved `deviceIds` list.
   */
  targetIds?: string[] | null;
}

export interface CreateSoftwareDeploymentResult {
  deploymentId: string;
  /** Full deployment row returned by the DB insert — pass through to the HTTP caller. */
  deployment: typeof softwareDeployments.$inferSelect;
  status: 'pending' | 'failed';
  message?: string;
  dispatchedDeviceIds: string[];
}

export type SoftwareInstallDispatchTransport = 'ws' | 'queued';

export interface SoftwareInstallDispatchOutcome {
  /** 'ws' = delivered over the live agent socket; 'queued' = written to device_commands for pickup on next poll/reconnect. */
  transport: SoftwareInstallDispatchTransport;
  /** device_commands row id when the offline-queue fallback was used, else null. */
  deviceCommandId: string | null;
}

/**
 * Dispatch one software_install command to one device — the shared per-device
 * unit reused by the immediate path (createSoftwareDeployment), the scheduler
 * (jobs/softwareDeploymentScheduler), and the retry endpoint.
 *
 * Callers are responsible for everything that happens BEFORE dispatch
 * (presign/EDR resolution, `{{...}}` variable substitution, failure
 * pre-writes) and hand this function the fully-resolved command payload.
 * The payload MUST carry `deploymentId` — the queued-path result
 * reconciliation in routes/agents/commands.ts keys on it.
 *
 * Honest dispatch (#1.2): when the agent has no live WS socket,
 * sendCommandToAgent returns false; instead of silently dropping the command
 * (the old fire-and-forget bug), fall back to queueCommand so the agent picks
 * it up on its next poll/reconnect, and link the queued device_commands row
 * id into deployment_results.device_command_id for reconciliation, cancel
 * purge, and "queued — device offline" display.
 */
export async function dispatchSoftwareInstallToDevice(
  deploymentId: string,
  device: { id: string; agentId: string },
  payload: AgentCommand['payload'],
  createdBy?: string | null,
): Promise<SoftwareInstallDispatchOutcome> {
  const command: AgentCommand = {
    id: `sw-install-${deploymentId}-${device.id}`,
    type: 'software_install',
    payload,
  };

  if (sendCommandToAgent(device.agentId, command)) {
    return { transport: 'ws', deviceCommandId: null };
  }

  // Agent offline: queue the SAME payload as a device_commands row. The agent
  // handler dispatches on command type, so both transports hit the same code.
  const queued = await queueCommand(device.id, 'software_install', payload, createdBy ?? undefined);
  const deviceCommandId = queued?.id ?? null;
  if (deviceCommandId) {
    await db
      .update(deploymentResults)
      .set({ deviceCommandId })
      .where(
        and(
          eq(deploymentResults.deploymentId, deploymentId),
          eq(deploymentResults.deviceId, device.id),
        ),
      );
  }
  return { transport: 'queued', deviceCommandId };
}

/** Structural subset of a software_versions row the install fan-out needs. */
export interface SoftwareInstallFanoutVersionRecord {
  downloadUrl: string | null;
  s3Key: string | null;
  checksum: string | null;
  originalFileName: string | null;
  fileType: string | null;
  silentInstallArgs: string | null;
  version: string;
  detectionRules?: unknown;
}

/** Structural subset of a software_catalog row the install fan-out needs. */
export interface SoftwareInstallFanoutCatalogItem {
  name: string;
  integrationProvider: string | null;
}

export interface BuildAndDispatchSoftwareInstallsInput {
  deploymentId: string;
  orgId: string;
  versionRecord: SoftwareInstallFanoutVersionRecord;
  catalogItem: SoftwareInstallFanoutCatalogItem;
  /** Resolved target device ids (the immediate path passes the create input; the scheduler passes the pending deployment_results rows). */
  deviceIds: string[];
  options?: Record<string, unknown> | null;
  createdBy: string | null;
  /**
   * When true (immediate path) this function stamps
   * `software_deployments.dispatched_at` itself, right before the per-device
   * loop. The scheduler passes false because it already claimed the row via
   * the `dispatched_at IS NULL` conditional update.
   */
  markDispatched: boolean;
}

export interface SoftwareInstallFanoutResult {
  status: 'pending' | 'failed';
  message?: string;
  dispatchedDeviceIds: string[];
}

/**
 * Build per-device software_install payloads and dispatch them — the shared
 * fan-out used by the immediate path (createSoftwareDeployment) and the
 * scheduler (jobs/softwareDeploymentScheduler). Covers everything between
 * "deployment + result rows exist" and "commands are on the wire":
 * S3 presign, built-in EDR installer resolution, `{{...}}` installer-variable
 * substitution, detection rules / forceReinstall, the failure pre-writes
 * (EDR error, missing installer, unresolvable variables), and per-device
 * WS-vs-queue delivery via dispatchSoftwareInstallToDevice.
 */
export async function buildAndDispatchSoftwareInstalls(
  input: BuildAndDispatchSoftwareInstallsInput,
): Promise<SoftwareInstallFanoutResult> {
  const { deploymentId, orgId, versionRecord, catalogItem, deviceIds, options, createdBy, markDispatched } = input;

  // Get presigned URL for download
  let downloadUrl: string | null = null;
  if (versionRecord.s3Key && isS3Configured()) {
    try {
      downloadUrl = await getPresignedUrl(versionRecord.s3Key, 3600);
    } catch (err) {
      // Don't swallow: a transport/auth fault must be visible even though we
      // still fall back to the stored downloadUrl below (#1808).
      console[isS3NotFound(err) ? 'warn' : 'error'](
        `[software-deploy] S3 presign failed for ${versionRecord.s3Key}, falling back to stored downloadUrl:`,
        err,
      );
    }
  }
  downloadUrl = downloadUrl ?? versionRecord.downloadUrl;

  // Built-in EDR packages: resolve per-org keys server-side BEFORE the dispatch
  // gate. On resolution failure, mark every result failed and return — never
  // dispatch and never silently no-op.
  let resolvedInstaller: ResolvedInstaller | null = null;
  if (
    catalogItem.integrationProvider === 'huntress' ||
    catalogItem.integrationProvider === 'sentinelone'
  ) {
    const resolved = await resolveEdrInstaller({
      provider: catalogItem.integrationProvider,
      orgId,
      downloadUrlTemplate: versionRecord.downloadUrl,
      silentInstallArgsTemplate: versionRecord.silentInstallArgs,
    });
    if ('error' in resolved) {
      await db
        .update(deploymentResults)
        .set({ status: 'failed', errorMessage: resolved.error, completedAt: new Date() })
        .where(eq(deploymentResults.deploymentId, deploymentId));
      return {
        status: 'failed',
        message: resolved.error,
        dispatchedDeviceIds: [],
      };
    }
    resolvedInstaller = resolved;
  }

  const finalDownloadUrl = resolvedInstaller?.downloadUrl ?? downloadUrl;
  const finalSilentInstallArgs =
    resolvedInstaller?.silentInstallArgs ?? versionRecord.silentInstallArgs;

  if (!finalDownloadUrl) {
    // No installer binary/URL to dispatch — fail the results instead of leaving
    // them 'pending' forever and reporting a false success to the caller.
    await db
      .update(deploymentResults)
      .set({
        status: 'failed',
        errorMessage:
          'No installer available for this version — upload an installer (or check storage configuration) before deploying.',
        completedAt: new Date(),
      })
      .where(eq(deploymentResults.deploymentId, deploymentId));
    return {
      status: 'failed',
      message: 'No installer available for this version',
      dispatchedDeviceIds: [],
    };
  }

  // Get agentIds + variable context for target devices. hostname/siteId/
  // customFields feed deploy-time `{{...}}` variable substitution below.
  const targetDevices = await db
    .select({
      id: devices.id,
      agentId: devices.agentId,
      siteId: devices.siteId,
      hostname: devices.hostname,
      customFields: devices.customFields,
    })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, orgId),
        inArray(devices.id, deviceIds),
      ),
    );

  // When a template references variables, load the org name + ALL of the org's
  // site names once here (gated below) rather than per-device inside the loop —
  // avoids an N+1 across the dispatch fan-out.
  const templatesUseVariables =
    (finalDownloadUrl?.includes('{{') ?? false) ||
    (finalSilentInstallArgs?.includes('{{') ?? false);

  let orgName = '';
  const siteNames = new Map<string, string>();
  if (templatesUseVariables) {
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    orgName = org?.name ?? '';
    const siteRows = await db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(eq(sites.orgId, orgId));
    for (const s of siteRows) siteNames.set(s.id, s.name);
  }

  // Detection rules (#2022) and the force-reinstall toggle ride along with the
  // install command so the agent can skip-if-already-present and verify the
  // real end state. forceReinstall is a per-deployment option (default off);
  // when set the agent installs even if the package is already detected.
  const detectionRules = Array.isArray(versionRecord.detectionRules)
    ? versionRecord.detectionRules
    : undefined;
  const forceReinstall = options?.forceReinstall === true;

  // Claim marker (#1.2): the immediate dispatch path is now running for this
  // deployment. Scheduled/maintenance-window rows get theirs set by the
  // scheduler's conditional-claim update instead (markDispatched=false).
  if (markDispatched) {
    await db
      .update(softwareDeployments)
      .set({ dispatchedAt: new Date() })
      .where(eq(softwareDeployments.id, deploymentId));
  }

  const dispatchedDeviceIds: string[] = [];
  let variableFailureCount = 0;
  for (const device of targetDevices) {
    // Resolve `{{...}}` variables against this device's org/site/device context.
    // Skipped entirely unless `templatesUseVariables` (computed once above); the
    // resolver also fast-paths internally. An unresolvable token fails THIS
    // device rather than shipping a literal `{{...}}` to the agent.
    let deviceDownloadUrl = finalDownloadUrl;
    let deviceSilentInstallArgs = finalSilentInstallArgs;
    if (templatesUseVariables) {
      const ctx: InstallerVariableContext = {
        org: { id: orgId, name: orgName },
        site: { id: device.siteId, name: siteNames.get(device.siteId) ?? '' },
        device: {
          hostname: device.hostname,
          customFields: (device.customFields as Record<string, unknown> | null) ?? {},
        },
      };
      const resolved = resolveInstallerVariables(finalDownloadUrl, finalSilentInstallArgs, ctx);
      if (resolved.unresolved.length > 0) {
        await db
          .update(deploymentResults)
          .set({
            status: 'failed',
            errorMessage: `Could not resolve installer variable(s): ${resolved.unresolved.join(', ')}`,
            completedAt: new Date(),
          })
          .where(
            and(
              eq(deploymentResults.deploymentId, deploymentId),
              eq(deploymentResults.deviceId, device.id),
            ),
          );
        variableFailureCount++;
        continue;
      }
      // Substituting a non-null template yields a non-null string; the ?? keeps
      // the type as string (finalDownloadUrl is non-null past the guard above).
      deviceDownloadUrl = resolved.downloadUrl ?? finalDownloadUrl;
      deviceSilentInstallArgs = resolved.silentInstallArgs;
    }

    // deploymentId MUST be in the payload: the WS transport tracks it via
    // the sw-install-<deployment>-<device> command id, but the queued
    // fallback's device_commands row only has the payload to key result
    // reconciliation on.
    const payload: AgentCommand['payload'] = {
      deploymentId,
      downloadUrl: deviceDownloadUrl,
      checksum: versionRecord.checksum,
      fileName:
        versionRecord.originalFileName ?? `package.${versionRecord.fileType ?? 'exe'}`,
      fileType: versionRecord.fileType ?? 'exe',
      silentInstallArgs: deviceSilentInstallArgs,
      softwareName: catalogItem.name,
      version: versionRecord.version,
      ...(detectionRules ? { detectionRules } : {}),
      forceReinstall,
    };
    await dispatchSoftwareInstallToDevice(deploymentId, device, payload, createdBy);
    dispatchedDeviceIds.push(device.id);
  }

  // If installer variables were in play and NOTHING dispatched because every
  // target failed resolution, report failure — mirrors the EDR/no-installer
  // paths rather than reporting a false 'pending' success to the caller.
  if (variableFailureCount > 0 && dispatchedDeviceIds.length === 0) {
    return {
      status: 'failed',
      message: 'All target devices failed installer variable resolution',
      dispatchedDeviceIds: [],
    };
  }
  return { status: 'pending', dispatchedDeviceIds };
}

export async function createSoftwareDeployment(
  input: CreateSoftwareDeploymentInput,
): Promise<CreateSoftwareDeploymentResult> {
  const {
    orgId,
    softwareVersionId,
    deploymentType,
    deviceIds,
    scheduleType,
    createdBy,
    name,
    scheduledAt,
    options,
    maintenanceWindowId,
    targetType,
    targetIds,
  } = input;

  // Look up version record
  const [versionRecord] = await db
    .select()
    .from(softwareVersions)
    .where(eq(softwareVersions.id, softwareVersionId));
  if (!versionRecord) {
    throw new Error(`Software version not found: ${softwareVersionId}`);
  }

  // Look up catalog item
  const [catalogItem] = await db
    .select({
      id: softwareCatalog.id,
      orgId: softwareCatalog.orgId,
      name: softwareCatalog.name,
      integrationProvider: softwareCatalog.integrationProvider,
    })
    .from(softwareCatalog)
    .where(eq(softwareCatalog.id, versionRecord.catalogId));

  if (!catalogItem) {
    throw new Error(`Catalog item not found for version ${softwareVersionId}`);
  }

  // Insert deployment
  const [deployment] = await db
    .insert(softwareDeployments)
    .values({
      orgId,
      name: name ?? 'Software Deployment',
      softwareVersionId,
      deploymentType,
      targetType: targetType ?? 'devices',
      targetIds: targetIds !== undefined ? targetIds : deviceIds,
      scheduleType,
      scheduledAt: scheduledAt ?? null,
      maintenanceWindowId: maintenanceWindowId ?? null,
      createdBy,
      options: options ?? null,
    })
    .returning();

  if (!deployment) {
    throw new Error('Failed to create deployment record');
  }

  // Insert per-device results
  if (deviceIds.length > 0) {
    await db.insert(deploymentResults).values(
      deviceIds.map((deviceId) => ({
        deploymentId: deployment.id,
        deviceId,
        status: 'pending' as const,
      })),
    );
  }

  // For immediate installs, dispatch software_install commands to online agents
  // via the shared fan-out (presign, EDR resolution, variable substitution,
  // detection rules, failure pre-writes, WS-vs-queue delivery).
  if (scheduleType === 'immediate' && deploymentType === 'install' && deviceIds.length > 0) {
    const fanout = await buildAndDispatchSoftwareInstalls({
      deploymentId: deployment.id,
      orgId,
      versionRecord,
      catalogItem,
      deviceIds,
      options: options ?? null,
      createdBy,
      markDispatched: true,
    });
    return { deploymentId: deployment.id, deployment, ...fanout };
  }

  return { deploymentId: deployment.id, deployment, status: 'pending', dispatchedDeviceIds: [] };
}
