import { and, eq, inArray } from 'drizzle-orm';
import { findVariableTokens, isSoftwareFileType, variableToken } from '@breeze/shared';
import { db } from '../db';
import {
  deploymentResults,
  devices,
  organizations,
  sites,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwareVersions,
} from '../db/schema';
import { resolveEdrInstaller, type ResolvedInstaller } from './edrInstallerResolver';
import { resolveInstallerVariables, type InstallerVariableContext } from './installerVariables';
import { loadTenantVariableScope, resolveForOrg } from './tenantVariableResolution';
import { getPresignedUrl, isS3Configured, isS3NotFound } from './s3Storage';
import { queueCommand } from './commandQueue';
import {
  evaluateManagedSoftwareDispatch,
  type ManagedSoftwareDispatchDenialReason,
  getManagedSoftwarePolicyMode,
} from './managedSoftwareDispatchPolicy';
import { getEffectiveSoftwareDownloadPolicy } from './softwareDownloadPolicy';
import { sendCommandToAgent, type AgentCommand } from '../routes/agentWs';

export interface CreateSoftwareDeploymentInput {
  orgId: string;
  /**
   * Uploaded/URL target. EXACTLY ONE of softwareVersionId / installMethodId
   * must be set (mirrors the DB's software_deployments_one_target_chk).
   */
  softwareVersionId?: string;
  /**
   * Package-manager target: a software_install_methods row id. The route
   * resolves the catalog item's enabled methods and creates one deployment
   * per platform, so a deployment always references exactly one method.
   */
  installMethodId?: string;
  /** Manager deploys only: 'latest' (default) or a pinned 'exact' version. */
  versionMode?: 'latest' | 'exact';
  /** Required by the route when versionMode is 'exact'. */
  requestedVersion?: string;
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
  deviceResults: SoftwareInstallFanoutDeviceResult[];
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
 *
 * `retryCount` is the CURRENT attempt number at dispatch time (0 for the
 * first attempt) and is baked into the WS command id
 * (`sw-install-<deployment>-<device>-<retryCount>`) so a late result from a
 * superseded attempt — the id the FIRST dispatch used — can never be
 * misattributed to a later retry: applySoftwareInstallResult rejects any
 * result whose attempt doesn't match the row's current retryCount. The
 * caller (routes/software.ts retry endpoint) MUST bump retryCount in the DB
 * before calling this, and pass that same post-bump value here.
 */
export async function dispatchSoftwareInstallToDevice(
  deploymentId: string,
  device: { id: string; agentId: string },
  payload: AgentCommand['payload'],
  createdBy?: string | null,
  retryCount = 0,
): Promise<SoftwareInstallDispatchOutcome> {
  const command: AgentCommand = {
    id: `sw-install-${deploymentId}-${device.id}-${retryCount}`,
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

/**
 * Structural subset of a software_install_methods row the manager fan-out
 * needs. Exactly one method drives one deployment (see
 * CreateSoftwareDeploymentInput.installMethodId).
 */
export interface SoftwareInstallFanoutMethod {
  id: string;
  platform: string;
  kind: string;
  packageId: string;
}

export interface BuildAndDispatchSoftwareInstallsInput {
  deploymentId: string;
  orgId: string;
  /** URL/upload path. Omitted (with `installMethod` set) for manager deploys. */
  versionRecord?: SoftwareInstallFanoutVersionRecord | null;
  /**
   * Package-manager path. When set the fan-out skips presign, EDR resolution,
   * download-policy evaluation, checksum and `{{...}}` variable substitution —
   * all of them URL-path concerns — and ships an installMethod payload the
   * agent resolves through winget/brew.
   */
  installMethod?: SoftwareInstallFanoutMethod | null;
  /** Manager deploys only; defaults to 'latest'. */
  versionMode?: 'latest' | 'exact';
  /** Manager deploys only; sent only when versionMode is 'exact'. */
  requestedVersion?: string | null;
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
  /**
   * Retry path (#1.6): restrict the fan-out to a device subset. When set,
   * every failure pre-write (EDR resolution error, missing installer URL,
   * unresolvable `{{...}}` variables) additionally filters
   * `inArray(deploymentResults.deviceId, scopeToDeviceIds)` and the dispatch
   * loop only targets these devices — so previously COMPLETED result rows of
   * the deployment are never clobbered to 'failed'. When unset, behavior is
   * unchanged: deployment-wide pre-writes are fine for the create/scheduler
   * paths where every result row is still pending.
   */
  scopeToDeviceIds?: string[];
  /**
   * Per-device retryCount at dispatch time, keyed by deviceId. The retry
   * endpoint (routes/software.ts) bumps deployment_results.retryCount BEFORE
   * calling this function and passes the post-bump values here so the WS
   * command id / payload this fan-out builds carry the NEW attempt number —
   * see dispatchSoftwareInstallToDevice. Devices absent from the map (the
   * create and scheduler paths, which are always a device's first attempt)
   * default to 0.
   */
  deviceRetryCounts?: Record<string, number>;
  /** Exact rows created/claimed for this fan-out, keyed by device id. */
  deploymentResultIdsByDevice?: ReadonlyMap<string, string>;
}

export interface SoftwareInstallFanoutResult {
  status: 'pending' | 'failed';
  message?: string;
  dispatchedDeviceIds: string[];
  deviceResults: SoftwareInstallFanoutDeviceResult[];
}

export interface SoftwareInstallFanoutDeviceResult {
  deviceId: string;
  deploymentResultId: string;
  status: 'queued' | 'delivered' | 'failed';
  deviceCommandId: string | null;
  message?: string;
}

function fanoutDeviceResult(
  input: BuildAndDispatchSoftwareInstallsInput,
  deviceId: string,
  status: SoftwareInstallFanoutDeviceResult['status'],
  deviceCommandId: string | null,
  message?: string,
): SoftwareInstallFanoutDeviceResult | null {
  const deploymentResultId = input.deploymentResultIdsByDevice?.get(deviceId);
  if (!deploymentResultId) return null;
  return {
    deviceId,
    deploymentResultId,
    status,
    deviceCommandId,
    ...(message ? { message } : {}),
  };
}

/**
 * Build per-device software_install payloads and dispatch them — the shared
 * fan-out used by the immediate path (createSoftwareDeployment), the
 * scheduler (jobs/softwareDeploymentScheduler), and the retry endpoint
 * (routes/software.ts, which passes scopeToDeviceIds so failure pre-writes
 * never touch completed rows). Covers everything between
 * "deployment + result rows exist" and "commands are on the wire":
 * S3 presign, built-in EDR installer resolution, `{{...}}` installer-variable
 * substitution, detection rules / forceReinstall, the failure pre-writes
 * (EDR error, missing installer, unresolvable variables), and per-device
 * WS-vs-queue delivery via dispatchSoftwareInstallToDevice.
 */
/** Error text a device gets when its OS doesn't match the deployment's method. */
export const NO_INSTALL_METHOD_FOR_OS = 'No install method for this device OS';

/**
 * Error text for a target that no longer resolves at dispatch time (#3603) —
 * the device row was deleted, or moved to another org, between deployment
 * creation and dispatch.
 */
export const DEVICE_NO_LONGER_AVAILABLE =
  'Device no longer exists or is no longer in this organization';

/** Result statuses that a dispatch-time failure may still overwrite. */
const NON_TERMINAL_RESULT_STATUSES = ['pending', 'running', 'downloading', 'installing'] as const;

/**
 * Terminally fail the result rows of requested targets that the target-devices
 * SELECT did not return (#3603).
 *
 * Both dispatch paths iterate the resolved device ROWS, so a device that
 * disappeared between create and dispatch was simply absent from the loop and
 * its result row stayed 'pending' forever — the deployment showed fewer
 * results than targets and never reached a terminal state.
 *
 * Two ways a target goes missing, and the UPDATE is the right shape for both:
 *   - moved to another org: the device row still exists but fails the
 *     `devices.org_id = orgId` predicate; its result row is still there and is
 *     what this fails;
 *   - deleted outright: the device cascade (CORE_DEVICE_CASCADE_DELETE_TABLES)
 *     already took `deployment_results` with it, so this matches zero rows —
 *     and an INSERT would be impossible anyway, `deployment_results.device_id`
 *     being a NOT NULL FK to a row that is gone.
 *
 * Restricted to non-terminal statuses so the retry path can never clobber a
 * previously completed row.
 *
 * Returns the number of requested ids that went missing (NOT the row count) —
 * the caller uses it to decide whether a fan-out that dispatched nothing
 * should report 'failed' rather than a false 'pending'.
 */
async function failMissingTargetDevices(
  deploymentId: string,
  fanoutDeviceIds: string[],
  resolvedDevices: ReadonlyArray<{ id: string }>,
): Promise<number> {
  const resolved = new Set(resolvedDevices.map((d) => d.id));
  const missing = fanoutDeviceIds.filter((id) => !resolved.has(id));
  if (missing.length === 0) return 0;

  await db
    .update(deploymentResults)
    .set({
      status: 'failed',
      errorMessage: DEVICE_NO_LONGER_AVAILABLE,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentResults.deploymentId, deploymentId),
        inArray(deploymentResults.deviceId, missing),
        inArray(deploymentResults.status, [...NON_TERMINAL_RESULT_STATUSES]),
      ),
    );
  return missing.length;
}

/**
 * Package-manager fan-out (winget / Homebrew). Deliberately NOT a variant of
 * the URL path: there is no installer binary, so presign, EDR resolution,
 * checksum, the managed-download destination policy and `{{...}}` variable
 * substitution are all inapplicable — the agent asks the OS package manager
 * for `installMethod.packageId`.
 *
 * A deployment references exactly ONE install method, so a device whose
 * osType doesn't match `installMethod.platform` can never be served by it.
 * Those devices get their result row failed in place (same UPDATE shape as
 * the unresolved-variable branch above) rather than being silently dropped;
 * when that's every device, the whole deployment reports 'failed'.
 */
async function dispatchManagerInstalls(
  input: BuildAndDispatchSoftwareInstallsInput,
  installMethod: SoftwareInstallFanoutMethod,
  fanoutDeviceIds: string[],
): Promise<SoftwareInstallFanoutResult> {
  const { deploymentId, orgId, catalogItem, options, createdBy, markDispatched, deviceRetryCounts } = input;
  const versionMode = input.versionMode ?? 'latest';
  const forceReinstall = options?.forceReinstall === true;

  const targetDevices = await db
    .select({
      id: devices.id,
      agentId: devices.agentId,
      osType: devices.osType,
    })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, fanoutDeviceIds)));

  const missingDeviceCount = await failMissingTargetDevices(
    deploymentId,
    fanoutDeviceIds,
    targetDevices,
  );

  if (markDispatched) {
    await db
      .update(softwareDeployments)
      .set({ dispatchedAt: new Date() })
      .where(eq(softwareDeployments.id, deploymentId));
  }

  const dispatchedDeviceIds: string[] = [];
  const deviceResults: SoftwareInstallFanoutDeviceResult[] = [];
  for (const deviceId of fanoutDeviceIds) {
    if (!targetDevices.some((device) => device.id === deviceId)) {
      const result = fanoutDeviceResult(input, deviceId, 'failed', null, DEVICE_NO_LONGER_AVAILABLE);
      if (result) deviceResults.push(result);
    }
  }
  let osMismatchCount = 0;
  for (const device of targetDevices) {
    if (device.osType !== installMethod.platform) {
      await db
        .update(deploymentResults)
        .set({
          status: 'failed',
          errorMessage: `${NO_INSTALL_METHOD_FOR_OS} (${device.osType})`,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(deploymentResults.deploymentId, deploymentId),
            eq(deploymentResults.deviceId, device.id),
          ),
        );
      osMismatchCount++;
      const result = fanoutDeviceResult(
        input,
        device.id,
        'failed',
        null,
        `${NO_INSTALL_METHOD_FOR_OS} (${device.osType})`,
      );
      if (result) deviceResults.push(result);
      continue;
    }

    const retryCount = deviceRetryCounts?.[device.id] ?? 0;
    const payload: AgentCommand['payload'] = {
      deploymentId,
      retryCount,
      installMethod: { kind: installMethod.kind, packageId: installMethod.packageId },
      versionMode,
      ...(versionMode === 'exact' && input.requestedVersion
        ? { requestedVersion: input.requestedVersion }
        : {}),
      softwareName: catalogItem.name,
      forceReinstall,
    };
    const dispatch = await dispatchSoftwareInstallToDevice(deploymentId, device, payload, createdBy, retryCount);
    dispatchedDeviceIds.push(device.id);
    const result = fanoutDeviceResult(
      input,
      device.id,
      dispatch.transport === 'ws' ? 'delivered' : 'queued',
      dispatch.deviceCommandId,
    );
    if (result) deviceResults.push(result);
  }

  if (dispatchedDeviceIds.length === 0 && (osMismatchCount > 0 || missingDeviceCount > 0)) {
    return {
      status: 'failed',
      message:
        osMismatchCount > 0
          ? `${NO_INSTALL_METHOD_FOR_OS} on any target device`
          : 'No target device is still available',
      dispatchedDeviceIds: [],
      deviceResults,
    };
  }
  return { status: 'pending', dispatchedDeviceIds, deviceResults };
}

export async function buildAndDispatchSoftwareInstalls(
  input: BuildAndDispatchSoftwareInstallsInput,
): Promise<SoftwareInstallFanoutResult> {
  const { deploymentId, orgId, versionRecord, installMethod, catalogItem, deviceIds, options, createdBy, markDispatched, scopeToDeviceIds, deviceRetryCounts } = input;

  // WHERE clause for the deployment-wide failure pre-writes below. Scoped to
  // the retried subset when scopeToDeviceIds is set (retry path); otherwise
  // the whole deployment, byte-for-byte the pre-existing behavior.
  const failurePreWriteScope = scopeToDeviceIds
    ? and(
        eq(deploymentResults.deploymentId, deploymentId),
        inArray(deploymentResults.deviceId, scopeToDeviceIds),
      )
    : eq(deploymentResults.deploymentId, deploymentId);

  // Device ids the dispatch loop targets: intersection with the scope when set.
  const scopeSet = scopeToDeviceIds ? new Set(scopeToDeviceIds) : null;
  const fanoutDeviceIds = scopeSet ? deviceIds.filter((id) => scopeSet.has(id)) : deviceIds;

  // Package-manager deploys take a completely different (and much shorter)
  // path: no installer to presign, no checksum, no destination policy to
  // evaluate and no `{{...}}` templates to resolve.
  if (installMethod) {
    return dispatchManagerInstalls(input, installMethod, fanoutDeviceIds);
  }
  if (!versionRecord) {
    throw new Error(
      `Software deployment ${deploymentId} has neither a version record nor an install method`,
    );
  }

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
        .where(failurePreWriteScope);
      return {
        status: 'failed',
        message: resolved.error,
        dispatchedDeviceIds: [],
        deviceResults: fanoutDeviceIds.flatMap((deviceId) => {
          const result = fanoutDeviceResult(input, deviceId, 'failed', null, resolved.error);
          return result ? [result] : [];
        }),
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
      .where(failurePreWriteScope);
    return {
      status: 'failed',
      message: 'No installer available for this version',
      dispatchedDeviceIds: [],
      deviceResults: fanoutDeviceIds.flatMap((deviceId) => {
        const result = fanoutDeviceResult(
          input,
          deviceId,
          'failed',
          null,
          'No installer available for this version',
        );
        return result ? [result] : [];
      }),
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
        inArray(devices.id, fanoutDeviceIds),
      ),
    );

  const missingDeviceCount = await failMissingTargetDevices(
    deploymentId,
    fanoutDeviceIds,
    targetDevices,
  );

  // When a template references variables, load the org name + ALL of the org's
  // site names once here (gated below) rather than per-device inside the loop —
  // avoids an N+1 across the dispatch fan-out.
  const templatesUseVariables =
    (finalDownloadUrl?.includes('{{') ?? false) ||
    (finalSilentInstallArgs?.includes('{{') ?? false);

  let orgName = '';
  const siteNames = new Map<string, string>();
  // Tenant variables (#3409 PR2): flattened KEY -> non-secret VALUE map for
  // the `var.<key>` arm of installerVariables.ts's resolveKey. Secret
  // variables never enter this map — a deploy template is substituted into a
  // download URL / install args that ride the command payload in the clear.
  //
  // #3409 PR4c-2: a template that references a secret is an EXPLICIT failure,
  // not a silent omission. Before PR4c-2 the secret was merely left out of
  // the map so the token fell through to the generic `unresolved` branch,
  // which read as "unknown variable" and sent the author looking for a typo.
  // `secretTemplateKeys` holds the secret KEYS the templates reference (keys
  // only — never values); when non-empty every device fails through the same
  // per-device channel the `unresolved` branch uses, with a message that
  // names the rule instead. The script path's declared-delivery arm
  // (`source: 'tenantSecret'`) has no deploy-template equivalent by design.
  const tenantVars: Record<string, string> = {};
  const secretTemplateKeys: string[] = [];
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

    const referencedTemplateKeys = new Set([
      ...findVariableTokens(finalDownloadUrl ?? ''),
      ...findVariableTokens(finalSilentInstallArgs ?? ''),
    ]);
    const variableScope = await loadTenantVariableScope([orgId]);
    for (const [key, variable] of resolveForOrg(variableScope, orgId)) {
      if (variable.isSecret) {
        if (referencedTemplateKeys.has(key)) secretTemplateKeys.push(key);
      } else {
        tenantVars[key] = variable.value;
      }
    }
    secretTemplateKeys.sort();
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
  // once per distinct site rather than once per device. Applied uniformly
  // here in the shared fan-out so the create, scheduler, AND retry paths all
  // get the same gate — previously this only lived in one of the callers.
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
  const deviceResults: SoftwareInstallFanoutDeviceResult[] = [];
  for (const deviceId of fanoutDeviceIds) {
    if (!targetDevices.some((device) => device.id === deviceId)) {
      const result = fanoutDeviceResult(input, deviceId, 'failed', null, DEVICE_NO_LONGER_AVAILABLE);
      if (result) deviceResults.push(result);
    }
  }
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
      // Secret-referencing templates fail every device identically (the
      // check is template-level, not device-level) through the same
      // deployment_results write + counter as an unresolvable token, so the
      // batch-level outcome below is unchanged. Keys only in the message.
      if (secretTemplateKeys.length > 0) {
        await db
          .update(deploymentResults)
          .set({
            status: 'failed',
            errorMessage:
              'Software deployment templates cannot use secret variable(s) ' +
              secretTemplateKeys.map(variableToken).join(', '),
            completedAt: new Date(),
          })
          .where(
            and(
              eq(deploymentResults.deploymentId, deploymentId),
              eq(deploymentResults.deviceId, device.id),
            ),
          );
        variableFailureCount++;
        const result = fanoutDeviceResult(
          input,
          device.id,
          'failed',
          null,
          `Software deployment templates cannot use secret variable(s) ${secretTemplateKeys.map(variableToken).join(', ')}`,
        );
        if (result) deviceResults.push(result);
        continue;
      }
      const ctx: InstallerVariableContext = {
        org: { id: orgId, name: orgName },
        site: { id: device.siteId, name: siteNames.get(device.siteId) ?? '' },
        device: {
          hostname: device.hostname,
          customFields: (device.customFields as Record<string, unknown> | null) ?? {},
        },
        vars: tenantVars,
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
        const result = fanoutDeviceResult(
          input,
          device.id,
          'failed',
          null,
          `Could not resolve installer variable(s): ${resolved.unresolved.join(', ')}`,
        );
        if (result) deviceResults.push(result);
        continue;
      }
      // Substituting a non-null template yields a non-null string; the ?? keeps
      // the type as string (finalDownloadUrl is non-null past the guard above).
      deviceDownloadUrl = resolved.downloadUrl ?? finalDownloadUrl;
      deviceSilentInstallArgs = resolved.silentInstallArgs;
    }

    // Destination gate — BEFORE dispatchSoftwareInstallToDevice. A denied
    // device gets a failed result carrying the bounded reason and NO
    // enqueued command; the agent's dial-time policy remains the
    // authoritative defense for the devices that do receive one.
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
            eq(deploymentResults.deploymentId, deploymentId),
            eq(deploymentResults.deviceId, device.id),
          ),
        );
      policyDenialCount++;
      policyDenialReasons.add(decision.reason);
      const result = fanoutDeviceResult(input, device.id, 'failed', null, decision.reason);
      if (result) deviceResults.push(result);
      continue;
    }

    // Attempt number for THIS dispatch — 0 unless the caller (the retry
    // endpoint) already bumped retryCount for this device and passed it
    // through. Threaded into both the payload (queued-transport result
    // reconciliation keys on it) and the WS command id.
    const retryCount = deviceRetryCounts?.[device.id] ?? 0;


    // deploymentId MUST be in the payload: the WS transport tracks it via
    // the sw-install-<deployment>-<device>-<attempt> command id, but the
    // queued fallback's device_commands row only has the payload to key
    // result reconciliation on (deploymentId AND retryCount).
    // file_type is a plain nullable varchar with no CHECK constraint, so the
    // column can hold anything a future route, import or manual UPDATE puts
    // there. Narrow on read: an unrecognized value would otherwise be
    // dispatched verbatim and only rejected by the agent AFTER the download,
    // as `unsupported fileType`. 'exe' remains the historical fallback for a
    // NULL — see deriveSoftwareFileTypeFromUrl on why we never guess better.
    //
    // Deliberately NOT inferred from deviceDownloadUrl here. Doing so would fix
    // dispatch for legacy URL-only rows created before #3571 stamped file_type,
    // but it reverses an explicit decision in that PR, so it is left as a
    // separate call rather than smuggled in by a rebase.
    const effectiveFileType = isSoftwareFileType(versionRecord.fileType)
      ? versionRecord.fileType
      : 'exe';
    const payload: AgentCommand['payload'] = {
      deploymentId,
      retryCount,
      downloadUrl: deviceDownloadUrl,
      downloadPolicy: {
        version: 1,
        approvedPrivateOrigins,
      },
      checksum: versionRecord.checksum,
      // fileName and fileType are a COUPLED pair, not two independent fields:
      // the agent's validateInstallFileName rejects the command outright when
      // the filename's extension doesn't equal '.' + fileType. Building the
      // fallback name from the same resolved type is what keeps them in step.
      fileName:
        versionRecord.originalFileName ?? `package.${effectiveFileType}`,
      fileType: effectiveFileType,
      silentInstallArgs: deviceSilentInstallArgs,
      softwareName: catalogItem.name,
      version: versionRecord.version,
      ...(detectionRules ? { detectionRules } : {}),
      forceReinstall,
    };
    const dispatch = await dispatchSoftwareInstallToDevice(deploymentId, device, payload, createdBy, retryCount);
    dispatchedDeviceIds.push(device.id);
    const result = fanoutDeviceResult(
      input,
      device.id,
      dispatch.transport === 'ws' ? 'delivered' : 'queued',
      dispatch.deviceCommandId,
    );
    if (result) deviceResults.push(result);
  }

  // If NOTHING dispatched because every target failed variable resolution or
  // was denied by the destination policy, report failure — mirrors the
  // EDR/no-installer paths rather than reporting a false 'pending' success to
  // the caller.
  if (
    dispatchedDeviceIds.length === 0 &&
    (variableFailureCount > 0 || policyDenialCount > 0 || missingDeviceCount > 0)
  ) {
    return {
      status: 'failed',
      message:
        variableFailureCount > 0
          ? 'All target devices failed installer variable resolution'
          : policyDenialCount > 0
            ? 'All target devices denied by the managed software network policy: ' +
              [...policyDenialReasons].sort().join(', ')
            : 'No target device is still available',
      dispatchedDeviceIds: [],
      deviceResults,
    };
  }
  return { status: 'pending', dispatchedDeviceIds, deviceResults };
}

export async function createSoftwareDeployment(
  input: CreateSoftwareDeploymentInput,
): Promise<CreateSoftwareDeploymentResult> {
  const {
    orgId,
    softwareVersionId,
    installMethodId,
    versionMode,
    requestedVersion,
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

  // Mirrors the DB CHECK (software_deployments_one_target_chk): a deployment
  // targets an uploaded/URL version OR a package-manager method, never both
  // and never neither.
  if ((softwareVersionId == null) === (installMethodId == null)) {
    throw new Error(
      'createSoftwareDeployment requires exactly one of softwareVersionId / installMethodId',
    );
  }

  // Look up the deployment target — a version row or an install-method row.
  let versionRecord: typeof softwareVersions.$inferSelect | null = null;
  let installMethod: SoftwareInstallFanoutMethod | null = null;
  let catalogId: string;
  if (installMethodId) {
    const [method] = await db
      .select()
      .from(softwareInstallMethods)
      .where(eq(softwareInstallMethods.id, installMethodId));
    if (!method) {
      throw new Error(`Install method not found: ${installMethodId}`);
    }
    installMethod = method;
    catalogId = method.catalogId;
  } else {
    const [record] = await db
      .select()
      .from(softwareVersions)
      .where(eq(softwareVersions.id, softwareVersionId!));
    if (!record) {
      throw new Error(`Software version not found: ${softwareVersionId}`);
    }
    versionRecord = record;
    catalogId = record.catalogId;
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
    .where(eq(softwareCatalog.id, catalogId));

  if (!catalogItem) {
    throw new Error(
      `Catalog item not found for ${installMethodId ? `install method ${installMethodId}` : `version ${softwareVersionId}`}`,
    );
  }

  // Manager deploys persist their version intent in `options` so the
  // scheduler and the retry endpoint can rebuild the same payload later
  // without new columns.
  const storedOptions = installMethodId
    ? {
        ...(options ?? {}),
        versionMode: versionMode ?? 'latest',
        ...(requestedVersion ? { requestedVersion } : {}),
      }
    : options ?? null;

  // Insert deployment
  const [deployment] = await db
    .insert(softwareDeployments)
    .values({
      orgId,
      name: name ?? 'Software Deployment',
      softwareVersionId: softwareVersionId ?? null,
      installMethodId: installMethodId ?? null,
      deploymentType,
      targetType: targetType ?? 'devices',
      targetIds: targetIds !== undefined ? targetIds : deviceIds,
      scheduleType,
      scheduledAt: scheduledAt ?? null,
      maintenanceWindowId: maintenanceWindowId ?? null,
      createdBy,
      options: storedOptions,
    })
    .returning();

  if (!deployment) {
    throw new Error('Failed to create deployment record');
  }

  // Insert per-device results
  const insertedDeviceResults = deviceIds.length > 0
    ? await db.insert(deploymentResults).values(
      deviceIds.map((deviceId) => ({
        deploymentId: deployment.id,
        deviceId,
        status: 'pending' as const,
      })),
    ).returning({ id: deploymentResults.id, deviceId: deploymentResults.deviceId })
    : [];
  const deploymentResultIdsByDevice = new Map(
    insertedDeviceResults.map((result) => [result.deviceId, result.id]),
  );

  // For immediate installs, dispatch software_install commands to online agents
  // via the shared fan-out (presign, EDR resolution, variable substitution,
  // detection rules, failure pre-writes, WS-vs-queue delivery).
  if (scheduleType === 'immediate' && deploymentType === 'install' && deviceIds.length > 0) {
    // Wave 6 Task 5's managed-software destination-policy gate (presign, EDR
    // resolution, {{...}} variables, the policy gate itself, WS-vs-queue
    // dispatch) now lives once inside buildAndDispatchSoftwareInstalls so
    // create/scheduler/retry apply it identically instead of each caller
    // carrying its own copy — see that function for the full gate.
    const fanout = await buildAndDispatchSoftwareInstalls({
      deploymentId: deployment.id,
      orgId,
      versionRecord,
      installMethod,
      versionMode,
      requestedVersion,
      catalogItem,
      deviceIds,
      options: options ?? null,
      createdBy,
      markDispatched: true,
      deploymentResultIdsByDevice,
    });
    return { deploymentId: deployment.id, deployment, ...fanout };
  }

  return {
    deploymentId: deployment.id,
    deployment,
    status: 'pending',
    dispatchedDeviceIds: [],
    deviceResults: [],
  };
}
