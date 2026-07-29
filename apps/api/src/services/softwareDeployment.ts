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
import {
  evaluateManagedSoftwareDispatch,
  type ManagedSoftwareDispatchDenialReason,
  getManagedSoftwarePolicyMode,
} from './managedSoftwareDispatchPolicy';
import { getEffectiveSoftwareDownloadPolicy } from './softwareDownloadPolicy';
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
  if (scheduleType === 'immediate' && deploymentType === 'install' && deviceIds.length > 0) {
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
          .where(eq(deploymentResults.deploymentId, deployment.id));
        return {
          deploymentId: deployment.id,
          deployment,
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
        .where(eq(deploymentResults.deploymentId, deployment.id));
      return {
        deploymentId: deployment.id,
        deployment,
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
        // Wave 6 Task 5: the agent's outbound-network-policy capability, written
        // from the heartbeat handshake. 0 = pre-Wave-6 agent with no dial-time
        // destination policy.
        outboundNetworkPolicyVersion: devices.outboundNetworkPolicyVersion,
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

    // Managed software destination policy (Wave 6 Task 5). The mode is read
    // ONCE per dispatch batch so every device in one deployment is decided
    // under the same rules, and the effective org ∪ site allowlist is fetched
    // once per distinct site rather than once per device.
    const policyMode = getManagedSoftwarePolicyMode();
    const policyBySite = new Map<string, Promise<{ approvedPrivateOrigins: string[] }>>();
    const effectivePolicyFor = (siteId: string | null | undefined) => {
      const key = siteId ?? '';
      let pending = policyBySite.get(key);
      if (!pending) {
        pending = getEffectiveSoftwareDownloadPolicy(orgId, siteId ?? undefined).then((policy) => ({
          approvedPrivateOrigins: [...policy.approvedPrivateOrigins],
        }));
        policyBySite.set(key, pending);
      }
      return pending;
    };

    const dispatchedDeviceIds: string[] = [];
    let variableFailureCount = 0;
    let policyDenialCount = 0;
    // Bounded reasons only (see managedSoftwareDispatchPolicy) — safe to
    // interpolate into the aggregate message, unlike a URL or host.
    const policyDenialReasons = new Set<ManagedSoftwareDispatchDenialReason>();
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
                eq(deploymentResults.deploymentId, deployment.id),
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

      // Destination gate — BEFORE sendCommandToAgent. A denied device gets a
      // failed result carrying the bounded reason and NO enqueued command; the
      // agent's dial-time policy remains the authoritative defense for the
      // devices that do receive one.
      const { approvedPrivateOrigins } = await effectivePolicyFor(device.siteId);
      const decision = evaluateManagedSoftwareDispatch({
        downloadUrl: deviceDownloadUrl,
        approvedPrivateOrigins,
        outboundNetworkPolicyVersion: device.outboundNetworkPolicyVersion,
        mode: policyMode,
      });
      if (!decision.allowed) {
        await db
          .update(deploymentResults)
          .set({ status: 'failed', errorMessage: decision.reason, completedAt: new Date() })
          .where(
            and(
              eq(deploymentResults.deploymentId, deployment.id),
              eq(deploymentResults.deviceId, device.id),
            ),
          );
        policyDenialCount++;
        policyDenialReasons.add(decision.reason);
        continue;
      }

      const command: AgentCommand = {
        id: `sw-install-${deployment.id}-${device.id}`,
        type: 'software_install',
        payload: {
          deploymentId: deployment.id,
          downloadUrl: deviceDownloadUrl,
          downloadPolicy: {
            version: 1,
            approvedPrivateOrigins,
          },
          checksum: versionRecord.checksum,
          fileName:
            versionRecord.originalFileName ?? `package.${versionRecord.fileType ?? 'exe'}`,
          fileType: versionRecord.fileType ?? 'exe',
          silentInstallArgs: deviceSilentInstallArgs,
          softwareName: catalogItem.name,
          version: versionRecord.version,
          ...(detectionRules ? { detectionRules } : {}),
          forceReinstall,
        },
      };
      sendCommandToAgent(device.agentId, command);
      dispatchedDeviceIds.push(device.id);
    }

    // If NOTHING dispatched because every target failed variable resolution or
    // was denied by the destination policy, report failure — mirrors the
    // EDR/no-installer paths rather than reporting a false 'pending' success to
    // the caller.
    if (dispatchedDeviceIds.length === 0 && (variableFailureCount > 0 || policyDenialCount > 0)) {
      return {
        deploymentId: deployment.id,
        deployment,
        status: 'failed',
        message:
          variableFailureCount > 0
            ? 'All target devices failed installer variable resolution'
            : 'All target devices denied by the managed software network policy: ' +
              [...policyDenialReasons].sort().join(', '),
        dispatchedDeviceIds: [],
      };
    }
    return { deploymentId: deployment.id, deployment, status: 'pending', dispatchedDeviceIds };
  }

  return { deploymentId: deployment.id, deployment, status: 'pending', dispatchedDeviceIds: [] };
}
