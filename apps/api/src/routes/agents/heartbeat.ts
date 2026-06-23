import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import {
  devices,
  deviceCommands,
  deviceMetrics,
  agentVersions,
  agentLogs,
  onedriveDeviceState,
} from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { heartbeatSchema } from './schemas';
import type { PolicyProbeConfigUpdate } from './schemas';
import {
  maybeQueueThresholdFilesystemAnalysis,
  buildPolicyProbeConfigUpdate,
  normalizeAgentArchitecture,
  compareAgentVersions,
  buildEventLogConfigUpdate,
  buildMonitoringConfigUpdate,
  buildHelperConfigUpdate,
  buildPamConfigUpdate,
  buildOnedriveHelperConfigUpdate,
  getOrgAgentUpdatePolicy,
  type OnedriveConfigUpdate,
} from './helpers';
import { normalizeAgentUpdateSettings, shouldSendAgentUpgrade } from './agentUpdatePolicy';
import {
  compareAgentReleaseVersions,
  isComparableReleaseVersion,
  resolveComponentUpdateDecision,
  type DeviceUpdateInput,
} from '../../services/agentUpdateTargets';
import { processDeviceIPHistoryUpdate } from '../../services/deviceIpHistory';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { publishEvent } from '../../services/eventBus';
import { isAgentTokenRotationDue } from '../../middleware/agentAuth';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { captureException } from '../../services/sentry';
import { resolveRemoteAccessForDevice } from '../../services/remoteAccessPolicy';
import { getActiveTrustKeyset, type ManifestTrustKey } from '../../services/manifestSigning';

/**
 * #1121 — pure collapse detector for the watchdogState tolerance gap.
 * Returns the structured-warn payload when the RAW heartbeat body carried a
 * `watchdogState` key but schema validation collapsed it to undefined (the
 * `.catch(undefined)` firing on a corrupted value), else null. Exported for
 * unit tests; the route handler owns the actual console.warn.
 */
export function detectWatchdogStateCollapse(
  rawBody: unknown,
  validatedWatchdogState: string | undefined,
): { field: 'watchdogState'; rawValue: string | undefined } | null {
  if (validatedWatchdogState !== undefined) return null;
  if (!rawBody || typeof rawBody !== 'object') return null;
  const rawState = (rawBody as Record<string, unknown>).watchdogState;
  if (rawState === undefined) return null;
  const rawValue =
    typeof rawState === 'string'
      ? rawState.slice(0, 100)
      : JSON.stringify(rawState)?.slice(0, 100);
  return { field: 'watchdogState', rawValue };
}

export const heartbeatRoutes = new Hono();

const COMMAND_LEGACY_AGENT_UPDATE = 'legacy_agent_update';
const COMMAND_SET_AUTO_UPDATE = 'set_auto_update';
const COMMAND_UPDATE_WATCHDOG = 'update_watchdog';
const LEGACY_AGENT_UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function agentVersionSatisfiesTarget(currentVersion: string | null | undefined, targetVersion: string): boolean {
  if (!currentVersion) return false;
  if (currentVersion === targetVersion) return true;
  if (isComparableReleaseVersion(currentVersion) && isComparableReleaseVersion(targetVersion)) {
    return compareAgentReleaseVersions(currentVersion, targetVersion) >= 0;
  }
  return false;
}

async function completeLegacyAgentUpdateMarker(args: {
  commandId: string;
  deviceId: string;
  targetVersion: string;
  orgAutoUpdateEnabled: boolean;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(deviceCommands)
      .set({
        status: 'completed',
        completedAt: new Date(),
        result: {
          updated_to: args.targetVersion,
          transport: 'legacy-heartbeat-upgrade',
        },
      })
      .where(eq(deviceCommands.id, args.commandId));

    await tx
      .insert(deviceCommands)
      .values({
        deviceId: args.deviceId,
        type: COMMAND_SET_AUTO_UPDATE,
        payload: {
          enabled: args.orgAutoUpdateEnabled,
          reason: 'legacy_agent_update_complete',
          sourceCommandId: args.commandId,
          targetVersion: args.targetVersion,
        },
        status: 'pending',
        targetRole: 'agent',
        createdBy: null,
      });
  });
}

async function failLegacyAgentUpdateMarker(args: {
  commandId: string;
  reason: string;
  deviceId?: string;
  targetVersion?: string;
  orgAutoUpdateEnabled?: boolean;
}): Promise<void> {
  const completedAt = new Date();
  const restoreAutoUpdate = args.deviceId !== undefined
    && args.targetVersion !== undefined
    && args.orgAutoUpdateEnabled !== undefined
    ? {
        deviceId: args.deviceId,
        targetVersion: args.targetVersion,
        enabled: args.orgAutoUpdateEnabled,
      }
    : null;

  const markFailed = async (tx: Pick<typeof db, 'update' | 'insert'>) => {
    await tx
      .update(deviceCommands)
      .set({
        status: 'failed',
        completedAt,
        result: { error: args.reason },
      })
      .where(eq(deviceCommands.id, args.commandId));

    if (restoreAutoUpdate) {
      await tx
        .insert(deviceCommands)
        .values({
          deviceId: restoreAutoUpdate.deviceId,
          type: COMMAND_SET_AUTO_UPDATE,
          payload: {
            enabled: restoreAutoUpdate.enabled,
            reason: 'legacy_agent_update_failed',
            sourceCommandId: args.commandId,
            targetVersion: restoreAutoUpdate.targetVersion,
            error: args.reason,
          },
          status: 'pending',
          targetRole: 'agent',
          createdBy: null,
        });
    }
  };

  if (restoreAutoUpdate) {
    await db.transaction(markFailed);
    return;
  }

  await markFailed(db);
}

function legacyAgentUpdateTimedOut(marker: {
  status: string | null;
  executedAt?: Date | null;
}, now = new Date()): boolean {
  if (marker.status !== 'sent' || !marker.executedAt) return false;
  return now.getTime() - marker.executedAt.getTime() > LEGACY_AGENT_UPDATE_TIMEOUT_MS;
}

async function resolveLegacyAgentHeartbeatUpgrade(args: {
  deviceId: string;
  reportedAgentVersion: string | null | undefined;
  orgAutoUpdateEnabled: boolean;
}): Promise<string | null> {
  const [marker] = await db
    .select({
      id: deviceCommands.id,
      payload: deviceCommands.payload,
      status: deviceCommands.status,
      executedAt: deviceCommands.executedAt,
    })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, args.deviceId),
        eq(deviceCommands.type, COMMAND_LEGACY_AGENT_UPDATE),
        eq(deviceCommands.targetRole, 'server'),
        inArray(deviceCommands.status, ['pending', 'sent']),
      ),
    )
    .orderBy(desc(deviceCommands.createdAt))
    .limit(1);
  if (!marker || typeof marker.id !== 'string') return null;

  const targetVersion = payloadString(marker.payload, 'version');
  const setAutoUpdateCommandId = payloadString(marker.payload, 'setAutoUpdateCommandId');
  if (!targetVersion || !setAutoUpdateCommandId) {
    await failLegacyAgentUpdateMarker({
      commandId: marker.id,
      reason: 'invalid legacy update marker payload',
    });
    return null;
  }

  if (agentVersionSatisfiesTarget(args.reportedAgentVersion, targetVersion)) {
    await completeLegacyAgentUpdateMarker({
      commandId: marker.id,
      deviceId: args.deviceId,
      targetVersion,
      orgAutoUpdateEnabled: args.orgAutoUpdateEnabled,
    });
    return null;
  }

  if (legacyAgentUpdateTimedOut(marker)) {
    await failLegacyAgentUpdateMarker({
      commandId: marker.id,
      reason: 'legacy agent update timed out',
      deviceId: args.deviceId,
      targetVersion,
      orgAutoUpdateEnabled: args.orgAutoUpdateEnabled,
    });
    return null;
  }

  const [setAutoUpdateCommand] = await db
    .select({
      id: deviceCommands.id,
      type: deviceCommands.type,
      status: deviceCommands.status,
      result: deviceCommands.result,
    })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, setAutoUpdateCommandId))
    .limit(1);
  if (!setAutoUpdateCommand || setAutoUpdateCommand.type !== COMMAND_SET_AUTO_UPDATE) {
    await failLegacyAgentUpdateMarker({
      commandId: marker.id,
      reason: 'set_auto_update command missing',
    });
    return null;
  }
  if (setAutoUpdateCommand.status === 'failed') {
    await failLegacyAgentUpdateMarker({
      commandId: marker.id,
      reason: 'set_auto_update command failed',
      deviceId: args.deviceId,
      targetVersion,
      orgAutoUpdateEnabled: args.orgAutoUpdateEnabled,
    });
    return null;
  }
  if (setAutoUpdateCommand.status !== 'completed') {
    return null;
  }

  if (marker.status === 'pending') {
    await db
      .update(deviceCommands)
      .set({ status: 'sent', executedAt: new Date() })
      .where(eq(deviceCommands.id, marker.id));
  }

  return targetVersion;
}

async function queuePolicyWatchdogUpdateCommand(args: {
  c: Parameters<typeof writeAuditEvent>[0];
  deviceId: string;
  orgId: string;
  agentId: string;
  targetVersion: string;
  reason: 'missing' | 'outdated';
}): Promise<void> {
  const existing = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, args.deviceId),
        eq(deviceCommands.type, COMMAND_UPDATE_WATCHDOG),
        eq(deviceCommands.targetRole, 'agent'),
        inArray(deviceCommands.status, ['pending', 'sent']),
      ),
    )
    .limit(1);

  if (existing[0]) return;

  await db
    .insert(deviceCommands)
    .values({
      deviceId: args.deviceId,
      type: COMMAND_UPDATE_WATCHDOG,
      payload: {
        component: 'watchdog',
        version: args.targetVersion,
        requestedVersion: null,
        manual: false,
        automatic: true,
        source: 'policy-autoheal',
        reason: args.reason,
      },
      status: 'pending',
      targetRole: 'agent',
      createdBy: null,
    });

  writeAuditEvent(args.c, {
    orgId: args.orgId,
    actorType: 'system',
    initiatedBy: 'schedule',
    action: 'device.component_update.autoheal_queued',
    resourceType: 'device',
    resourceId: args.deviceId,
    details: {
      deviceId: args.deviceId,
      agentId: args.agentId,
      component: 'watchdog',
      targetVersion: args.targetVersion,
      targetRole: 'agent',
      reason: args.reason,
    },
  });
}

heartbeatRoutes.post('/:id/heartbeat', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', heartbeatSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as AgentAuthContext | undefined;

  if (!agent?.deviceId) {
    return c.json({ error: 'Agent context not found' }, 401);
  }

  // #1121 — observability for the #1065 tolerance trade-off. watchdogState is
  // an optional informational field guarded by .catch(undefined) in
  // heartbeatSchema; if a corrupted value collapses to undefined, the
  // `data.watchdogState === 'FAILOVER'` mapping below silently records
  // watchdogStatus='connected', masking a genuine failover as healthy
  // (pre-#1065 the same corruption produced a loud 400). Detect the collapse
  // — raw body carried the key but the validated payload lost it — and emit
  // a structured warn so it lands in logs/Sentry breadcrumbs instead of
  // being indistinguishable from a healthy heartbeat. Hono caches the parsed
  // JSON body (zValidator already consumed it), so the re-read is free; the
  // check is gated to watchdog-role heartbeats, the only senders of the field.
  if (agent.role === 'watchdog' && data.watchdogState === undefined) {
    try {
      const raw: unknown = await c.req.json();
      const collapse = detectWatchdogStateCollapse(raw, data.watchdogState);
      if (collapse) {
        console.warn(
          '[heartbeat] watchdogState collapsed by schema .catch — possible masked failover (#1121)',
          { deviceId: agent.deviceId, agentId, ...collapse },
        );
      }
    } catch {
      // Raw body unavailable — nothing to report.
    }
  }

  // #1105 — run the RLS-scoped DB work in a SHORT-LIVED context that is
  // released before the manifest-trust-keyset fetch at the end. The heartbeat
  // opts out of agentAuthMiddleware's request-long withDbAccessContext wrap
  // (see agentAuth.ts) and self-manages here, so the org transaction is held
  // only across this block — not across getActiveTrustKeyset(), which acquires
  // its OWN (second) pooled connection. Holding both at once self-deadlocks the
  // pool under a mass agent reconnect (idle-in-transaction → killed → outage).
  const dbContext = {
    scope: 'organization' as const,
    orgId: agent.orgId,
    accessibleOrgIds: [agent.orgId],
    accessiblePartnerIds: [],
    // Agent path; no partner in scope and agents don't browse the catalog
    // as org users. null disables the partner-wide read branch (safe).
    currentPartnerId: null,
  };

  const scoped = await withDbAccessContext(
    dbContext,
    async (): Promise<Response | { mainResponse: Record<string, unknown> }> => {

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, agent.deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (data.role && data.role !== agent.role) {
    // Return 401 with re_enrollment_required so the watchdog/agent can drop its
    // stale token and re-provision via IPC or /rotate-token. A 403 here causes
    // a stale pre-#568 watchdog binary (using the main agent token but declaring
    // role=watchdog) to retry forever; the agent's authstate.Monitor only backs
    // off on 401, so this is what breaks the loop.
    console.warn('[heartbeat] Agent credential role mismatch', {
      deviceId: agent.deviceId,
      expected: agent.role,
      declared: data.role,
    });
    return c.json({
      error: 'Agent credential role mismatch',
      code: 're_enrollment_required',
      expected: agent.role,
      declared: data.role,
    }, 401);
  }

  const isWatchdog = agent.role === 'watchdog';

  if (isWatchdog) {
    // #800 Layer C — asymmetry detector. When this watchdog heartbeat
    // arrives, check whether the MAIN agent's lastSeenAt is past the
    // silence threshold. If so, mark the device as
    // `mainAgentSilentSince=NOW()` (idempotent across subsequent
    // watchdog ticks) and emit `device.main_agent_silent` on the first
    // transition. The flag is cleared by the main-agent branch below
    // when the agent recovers.
    //
    // Threshold: 15 minutes = 3x the default 5-min offline-detector
    // window per the issue's "3 * heartbeat_interval" guidance. Stays
    // comfortably above transient network blips while remaining well
    // inside the typical "operator notices something is off" window.
    const MAIN_AGENT_SILENT_THRESHOLD_MS = 15 * 60 * 1000;
    const now = new Date();
    const mainAgentSilent = device.lastSeenAt
      ? now.getTime() - device.lastSeenAt.getTime() > MAIN_AGENT_SILENT_THRESHOLD_MS
      : false;
    const transitioningIntoSilent = mainAgentSilent && !device.mainAgentSilentSince;

    const watchdogUpdates: Record<string, unknown> = {
      watchdogStatus: data.watchdogState === 'FAILOVER' ? 'failover' : 'connected',
      watchdogLastSeen: now,
      watchdogVersion: data.agentVersion,
      updatedAt: now,
    };
    if (transitioningIntoSilent) {
      watchdogUpdates.mainAgentSilentSince = now;
    }

    try {
      await db.update(devices)
        .set(watchdogUpdates)
        .where(eq(devices.id, device.id));
    } catch (err) {
      console.error('Failed to update watchdog status:', err);
    }

    // Emit only on the silence→silent transition so subscribers (alerts,
    // webhooks) don't fire once per watchdog tick during the outage.
    // The clear-side event fires from the main-agent branch on recovery.
    // (#800 Layer C)
    if (transitioningIntoSilent) {
      publishEvent('device.main_agent_silent', device.orgId, {
        deviceId: device.id,
        hostname: device.hostname,
        mainAgentLastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        watchdogStatus: data.watchdogState === 'FAILOVER' ? 'failover' : 'connected',
        silenceDurationSeconds: device.lastSeenAt
          ? Math.round((now.getTime() - device.lastSeenAt.getTime()) / 1000)
          : null,
      }, 'heartbeat-watchdog-branch', { priority: 'high', siteId: device.siteId }).catch((err) => {
        console.error('[heartbeat] device.main_agent_silent publish failed:', err);
      });
    }

    // #799 Layer B — record any non-zero main-agent restart activity into
    // agent_logs so on-call has a queryable trail of flap-loop scenarios.
    // Do not block the heartbeat path on logging failure.
    const restartCount = data.mainAgentRestartCount24h ?? 0;
    if (restartCount > 0 || data.flapDetected === true) {
      try {
        await db.insert(agentLogs).values({
          deviceId: device.id,
          orgId: device.orgId,
          timestamp: new Date(),
          level: data.flapDetected ? 'error' : 'warn',
          component: 'watchdog',
          message: data.flapDetected
            ? `Main agent restart flap detected (${restartCount} restarts in 24h)`
            : `Main agent restart activity: ${restartCount} in 24h`,
          fields: {
            count24h: restartCount,
            lastRestartAt: data.mainAgentLastRestartAt ?? null,
            flapDetected: data.flapDetected === true,
            watchdogState: data.watchdogState ?? null,
          },
          agentVersion: data.agentVersion,
        });
      } catch (err) {
        console.error('Failed to write watchdog restart-activity log:', err);
      }
    }

    // Claim watchdog-targeted commands (marks as sent to prevent duplicate
    // delivery). Command dispatch must not make the watchdog health heartbeat
    // fail: the heartbeat is also how we mark watchdog presence/version.
    let watchdogCommands: Awaited<ReturnType<typeof claimPendingCommandsForDevice>> = [];
    try {
      watchdogCommands = await claimPendingCommandsForDevice(device.id, 10, 'watchdog');
    } catch (err) {
      console.error(`[agents] failed to claim watchdog commands for ${agentId}:`, err);
      captureException(err);
    }

    const normalizedArch = normalizeAgentArchitecture(device.architecture);
    // Fail closed on policy lookup errors. Treating an unreadable org policy as
    // automatic would bypass Manual mode during transient DB/settings failures.
    let updateSettings = normalizeAgentUpdateSettings({ agentUpdateMode: 'manual' });
    try {
      updateSettings = await getOrgAgentUpdatePolicy(device.orgId);
    } catch (err) {
      console.error(`[agents] failed to resolve watchdog-branch update policy for ${agentId}:`, err);
    }

    // Do not send watchdog self-update directives on the watchdog heartbeat
    // branch. On Windows the shared updater restart helper is agent-service
    // oriented; policy-driven watchdog repair/update is owned by the main
    // agent through targetRole='agent' update_watchdog commands.
    const watchdogBranchInput: DeviceUpdateInput = {
      id: device.id,
      orgId: device.orgId,
      osType: device.osType,
      architecture: device.architecture,
      agentVersion: device.agentVersion,
      watchdogVersion: data.agentVersion,
    };

    // #1104 — agent recovery via the watchdog. A live watchdog whose main
    // agent is wedged (silent past the #800 threshold) and behind the latest
    // release has no other recovery path: the watchdog's failover loop routes
    // an agent `upgradeTo` into doUpdateAgent(), which replaces the wedged
    // binary. Compute it off the device's RECORDED main-agent version
    // (`device.agentVersion`) — `data.agentVersion` in this branch is the
    // WATCHDOG's own version. Gated on `mainAgentSilent` so a healthy main
    // agent (which self-updates from its own heartbeat) and the watchdog never
    // both write the same binary.
    let agentUpgradeTo: string | undefined;
    if (
      mainAgentSilent &&
      normalizedArch &&
      device.agentVersion &&
      !device.agentVersion.startsWith('dev-')
    ) {
      try {
        const agentDecision = await resolveComponentUpdateDecision({
          device: watchdogBranchInput,
          component: 'agent',
          settings: updateSettings,
        });
        if (agentDecision.available && agentDecision.autoInstall && agentDecision.targetVersion) {
          agentUpgradeTo = agentDecision.targetVersion;
        }
      } catch (err) {
        console.error(`[agents] failed to evaluate watchdog-branch agent recovery target for ${agentId}:`, err);
      }
    }

    return c.json({
      commands: watchdogCommands.map(cmd => ({
        id: cmd.id,
        type: cmd.type,
        payload: cmd.payload,
      })),
      upgradeTo: agentUpgradeTo,
    });
  }

  const deviceUpdates: Record<string, unknown> = {
    lastSeenAt: new Date(),
    status: 'online',
    agentVersion: data.agentVersion,
    lastUser: data.lastUser ?? null,
    uptimeSeconds: data.uptime ?? null,
    // OS-level pending-reboot flag. Absent (old agents) means false — the
    // conservative default — and writing unconditionally lets the flag
    // self-clear on the first post-reboot heartbeat.
    pendingReboot: data.pendingReboot ?? false,
    updatedAt: new Date()
  };

  // #800 Layer C — recovery side. If the asymmetry detector previously
  // set mainAgentSilentSince (watchdog kept reporting while we went
  // dark), clear it now that the main agent is heartbeating again. No
  // event emitted on the clear path — the natural `device.online`/
  // status flip already conveys the recovery to subscribers.
  if (device.mainAgentSilentSince) {
    deviceUpdates.mainAgentSilentSince = null;
  }

  // Only update deviceRole if agent provides one and current source is 'auto'
  if (data.deviceRole && device.deviceRoleSource === 'auto') {
    deviceUpdates.deviceRole = data.deviceRole;
  }

  // Orthogonal virtualization attribute (issue #1387). Old agents omit
  // isVirtual entirely (undefined) — leave the stored value untouched in that
  // case. A present value (true/false) is authoritative; the platform is
  // cleared when the agent reports virtual=false or sends no platform, so a
  // box that stops reporting a hypervisor doesn't keep a stale platform.
  if (data.isVirtual !== undefined) {
    deviceUpdates.isVirtual = data.isVirtual;
    deviceUpdates.virtualizationPlatform = data.isVirtual
      ? (data.virtualizationPlatform ?? null)
      : null;
  }

  // Update hostname/OS version when agent reports changes
  if (data.hostname && data.hostname !== device.hostname) {
    deviceUpdates.hostname = data.hostname;
  }
  if (data.osVersion && data.osVersion !== device.osVersion) {
    deviceUpdates.osVersion = data.osVersion;
  }
  if (data.osBuild !== undefined && data.osBuild !== device.osBuild) {
    deviceUpdates.osBuild = data.osBuild;
  }
  if (data.tccPermissions) {
    deviceUpdates.tccPermissions = data.tccPermissions;
  }
  if (data.desktopAccess) {
    deviceUpdates.desktopAccess = data.desktopAccess;
  }
  if (data.isHeadless !== undefined) {
    // On Windows and macOS, the agent runs as a service/daemon but the machine
    // still has interactive user sessions with displays. The session broker +
    // helper handles Session 0 / LaunchDaemon limitations. Only trust the
    // agent's headless flag on Linux where it checks for graphical sessions.
    const osType = data.osType ?? device.osType;
    if (osType === 'windows' || osType === 'macos' || osType === 'darwin') {
      deviceUpdates.isHeadless = false;
    } else {
      deviceUpdates.isHeadless = data.isHeadless;
    }
  }

  await db
    .update(devices)
    .set(deviceUpdates)
    .where(eq(devices.id, device.id));

  // Publish event when agent version changes (for real-time UI updates)
  if (data.agentVersion && data.agentVersion !== device.agentVersion) {
    publishEvent('device.updated', device.orgId, {
      deviceId: device.id,
      fields: ['agentVersion'],
      agentVersion: data.agentVersion,
    }, 'heartbeat', { siteId: device.siteId }).catch(err => {
      console.error('[Heartbeat] Failed to publish device.updated:', err);
      captureException(err);
    });
  }

  if (data.metrics) {
    await db
      .insert(deviceMetrics)
      .values({
        deviceId: device.id,
        orgId: device.orgId,
        timestamp: new Date(),
        cpuPercent: data.metrics.cpuPercent,
        ramPercent: data.metrics.ramPercent,
        ramUsedMb: data.metrics.ramUsedMb,
        diskPercent: data.metrics.diskPercent,
        diskUsedGb: data.metrics.diskUsedGb,
        diskActivityAvailable: data.metrics.diskActivityAvailable ?? null,
        diskReadBytes: data.metrics.diskReadBytes != null ? BigInt(data.metrics.diskReadBytes) : null,
        diskWriteBytes: data.metrics.diskWriteBytes != null ? BigInt(data.metrics.diskWriteBytes) : null,
        diskReadBps: data.metrics.diskReadBps != null ? BigInt(data.metrics.diskReadBps) : null,
        diskWriteBps: data.metrics.diskWriteBps != null ? BigInt(data.metrics.diskWriteBps) : null,
        diskReadOps: data.metrics.diskReadOps != null ? BigInt(data.metrics.diskReadOps) : null,
        diskWriteOps: data.metrics.diskWriteOps != null ? BigInt(data.metrics.diskWriteOps) : null,
        networkInBytes: data.metrics.networkInBytes != null ? BigInt(data.metrics.networkInBytes) : null,
        networkOutBytes: data.metrics.networkOutBytes != null ? BigInt(data.metrics.networkOutBytes) : null,
        bandwidthInBps: data.metrics.bandwidthInBps != null ? BigInt(data.metrics.bandwidthInBps) : null,
        bandwidthOutBps: data.metrics.bandwidthOutBps != null ? BigInt(data.metrics.bandwidthOutBps) : null,
        interfaceStats: data.metrics.interfaceStats ?? null,
        processCount: data.metrics.processCount
      });
  }

  if (data.ipHistoryUpdate) {
    if (data.ipHistoryUpdate.deviceId && data.ipHistoryUpdate.deviceId !== device.id) {
      console.warn(`[agents] rejecting mismatched ipHistoryUpdate.deviceId for ${agentId}: sent=${data.ipHistoryUpdate.deviceId} expected=${device.id}`);
    } else {
      try {
        await processDeviceIPHistoryUpdate(device.id, device.orgId, {
          ...data.ipHistoryUpdate,
          currentIPs: data.ipHistoryUpdate.currentIPs ?? undefined,
          changedIPs: data.ipHistoryUpdate.changedIPs ?? undefined,
          removedIPs: data.ipHistoryUpdate.removedIPs ?? undefined,
        });
      } catch (err) {
        const errorCode = (err as Record<string, unknown>)?.code ?? 'UNKNOWN';
        console.error(`[agents] failed to process ip history update for ${agentId} (device=${device.id}, org=${device.orgId}, dbError=${errorCode}):`, err);
      }
    }
  }

  if (data.metrics) {
    try {
      const thresholdScan = await maybeQueueThresholdFilesystemAnalysis(
        { id: device.id, osType: device.osType },
        data.metrics.diskPercent
      );
      if (thresholdScan.queued) {
        writeAuditEvent(c, {
          orgId: device.orgId,
          actorType: 'agent',
          actorId: agentId,
          action: 'agent.filesystem.threshold_scan.queued',
          resourceType: 'device',
          resourceId: device.id,
          details: {
            diskPercent: data.metrics.diskPercent,
            thresholdPercent: thresholdScan.thresholdPercent,
            path: thresholdScan.path,
          },
        });
      }
    } catch (err) {
      console.error(`[agents] failed to queue threshold filesystem scan for ${device.id}:`, err);
    }
  }

  if (data.onedriveDeviceState) {
    const s = data.onedriveDeviceState;
    try {
      await db.insert(onedriveDeviceState).values({
        deviceId: device.id,
        orgId: device.orgId,
        signedIn: s.signedIn,
        oneDriveVersion: s.oneDriveVersion ?? null,
        filesOnDemandOn: s.filesOnDemandOn,
        kfmFolderStates: s.kfmFolderStates,
        mountedLibraries: s.mountedLibraries,
        entitledLibraries: s.entitledLibraries,
        driftEntries: s.driftEntries,
        lastReportedAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: onedriveDeviceState.deviceId,
        set: {
          signedIn: s.signedIn,
          oneDriveVersion: s.oneDriveVersion ?? null,
          filesOnDemandOn: s.filesOnDemandOn,
          kfmFolderStates: s.kfmFolderStates,
          mountedLibraries: s.mountedLibraries,
          entitledLibraries: s.entitledLibraries,
          driftEntries: s.driftEntries,
          lastReportedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    } catch (err) {
      console.error(`[agents] failed to upsert onedrive device state for ${agentId}:`, err);
      captureException(err);
    }
  }

  let configUpdate: PolicyProbeConfigUpdate | null = null;
  try {
    configUpdate = await buildPolicyProbeConfigUpdate(device.orgId);
  } catch (err) {
    console.error(`[agents] failed to build policy probe config update for ${agentId}:`, err);
  }

  // Org > General > Agent update settings. Governs whether we may hand the
  // agent/watchdog an auto-upgrade or auto-repair target right now. Manual
  // blocks automatic upgrades and missing-watchdog autoheal; operators can
  // still request an explicit manual component update from the UI/API.
  // Helper is intentionally left on its existing path because the structured
  // pin/manual controls only apply to agent + watchdog components.
  // Fail closed on policy lookup errors. Manual mode is an update trust
  // boundary, so an unreadable org policy must not silently become automatic.
  let updateSettings = normalizeAgentUpdateSettings({ agentUpdateMode: 'manual' });
  let updateGateAllows = false;
  try {
    updateSettings = await getOrgAgentUpdatePolicy(device.orgId);
    const gate = shouldSendAgentUpgrade(updateSettings, new Date());
    updateGateAllows = gate.allow;
  } catch (err) {
    console.error(`[agents] failed to resolve agent update policy for ${agentId}:`, err);
  }

  const deviceUpdateInput: DeviceUpdateInput = {
    id: device.id,
    orgId: device.orgId,
    osType: device.osType,
    architecture: device.architecture,
    agentVersion: data.agentVersion,
    watchdogVersion: device.watchdogVersion,
  };

  let upgradeTo: string | null = null;
  const normalizedArch = normalizeAgentArchitecture(device.architecture);
  try {
    const agentDecision = await resolveComponentUpdateDecision({
      device: deviceUpdateInput,
      component: 'agent',
      settings: updateSettings,
    });
    if (agentDecision.available && agentDecision.autoInstall && agentDecision.targetVersion) {
      upgradeTo = agentDecision.targetVersion;
    }
  } catch (err) {
    console.error(`[agents] failed to evaluate upgrade target for ${agentId}:`, err);
  }

  if (!upgradeTo) {
    try {
      upgradeTo = await resolveLegacyAgentHeartbeatUpgrade({
        deviceId: device.id,
        reportedAgentVersion: data.agentVersion,
        orgAutoUpdateEnabled: updateSettings.mode === 'automatic',
      });
    } catch (err) {
      console.error(`[agents] failed to evaluate legacy agent update marker for ${agentId}:`, err);
    }
  }

  let helperUpgradeTo: string | null = null;
  // Check for helper upgrade even if agent doesn't report a version yet
  // (bootstraps the first install or recovers from a broken helper that never wrote status)
  if (normalizedArch) {
    try {
      const [latestHelper] = await db
        .select({ version: agentVersions.version })
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.platform, device.osType),
            eq(agentVersions.architecture, normalizedArch),
            eq(agentVersions.component, 'helper'),
            eq(agentVersions.isLatest, true)
          )
        )
        .orderBy(desc(agentVersions.createdAt))
        .limit(1);

if (latestHelper) {
        // If agent reports no helper version, always upgrade (bootstraps first install
        // or recovers from broken helper that never wrote its status file) — bootstrap
        // is NOT subject to the org update policy. Version-to-version upgrades are.
        if (!data.helperVersion) {
          helperUpgradeTo = latestHelper.version;
        } else if (updateGateAllows && compareAgentVersions(latestHelper.version, data.helperVersion) > 0) {
          helperUpgradeTo = latestHelper.version;
        }
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate helper upgrade target for ${agentId}:`, err);
    }
  }

  try {
    const watchdogDecision = await resolveComponentUpdateDecision({
      device: deviceUpdateInput,
      component: 'watchdog',
      settings: updateSettings,
    });
    if (watchdogDecision.available && watchdogDecision.autoInstall && watchdogDecision.targetVersion) {
      await queuePolicyWatchdogUpdateCommand({
        c,
        deviceId: device.id,
        orgId: device.orgId,
        agentId,
        targetVersion: watchdogDecision.targetVersion,
        reason: watchdogDecision.missing ? 'missing' : 'outdated',
      });
    }
  } catch (err) {
    console.error(`[agents] failed to evaluate watchdog upgrade target for ${agentId}:`, err);
  }

  const commands = await claimPendingCommandsForDevice(device.id, 10);

  let renewCert = false;
  if (device.mtlsCertExpiresAt && device.mtlsCertIssuedAt) {
    const now = Date.now();
    const issuedMs = device.mtlsCertIssuedAt.getTime();
    const expiresMs = device.mtlsCertExpiresAt.getTime();
    const renewalThreshold = issuedMs + ((expiresMs - issuedMs) * 2) / 3;
    if (now >= renewalThreshold) {
      renewCert = true;
    }
  }

  let helperSettings: { enabled: boolean; showOpenPortal: boolean; showDeviceInfo: boolean; showRequestSupport: boolean; portalUrl?: string } | null = null;
  try {
    helperSettings = await buildHelperConfigUpdate(device.id, device.orgId);
  } catch (err) {
    console.error(`[agents] failed to read helper settings for ${agentId}:`, err);
  }

  let eventLogSettings: Record<string, unknown> | null = null;
  try {
    eventLogSettings = await buildEventLogConfigUpdate(device.id);
  } catch (err) {
    console.error(`[agents] failed to build event log config update for ${agentId}:`, err);
  }

  let monitoringSettings: Record<string, unknown> | null = null;
  try {
    monitoringSettings = await buildMonitoringConfigUpdate(device.id) as Record<string, unknown> | null;
  } catch (err) {
    console.error(`[agents] failed to build monitoring config update for ${agentId}:`, err);
  }

  let pamSettings: { uacInterceptionEnabled: boolean } | null = null;
  try {
    pamSettings = await buildPamConfigUpdate(device.id);
  } catch (err) {
    console.error(`[agents] failed to build pam config update for ${agentId}:`, err);
    captureException(err);
  }

  let onedriveSettings: OnedriveConfigUpdate | null = null;
  try {
    onedriveSettings = await buildOnedriveHelperConfigUpdate(device.id);
  } catch (err) {
    console.error(`[agents] failed to build onedrive_helper config update for ${agentId}:`, err);
    captureException(err);
  }

  let mergedConfigUpdate: Record<string, unknown> | null = null;
  if (configUpdate || eventLogSettings || monitoringSettings || onedriveSettings) {
    mergedConfigUpdate = { ...(configUpdate ?? {}) };
    if (eventLogSettings) {
      mergedConfigUpdate.event_log_settings = eventLogSettings;
    }
    if (monitoringSettings) {
      mergedConfigUpdate.monitoring_settings = monitoringSettings;
    }
    if (onedriveSettings) {
      mergedConfigUpdate.onedrive_helper_settings = onedriveSettings;
    }
  }

  const authenticatedWithPreviousToken = c.get('agentTokenRotationRequired') === true;
  const rotateToken =
    !authenticatedWithPreviousToken &&
    (!device.watchdogTokenHash || isAgentTokenRotationDue(device.tokenIssuedAt));

  let manageRemoteManagement = false;
  try {
    const remoteAccess = await resolveRemoteAccessForDevice(device.id);
    manageRemoteManagement = remoteAccess.settings.vncRelay === true;
  } catch (err) {
    console.error('[heartbeat] Failed to resolve remote access policy:', err);
  }

  // Main-branch response payload — built inside the org context, but the
  // manifest-trust-keyset is fetched AFTER this context closes (see below).
  return {
    mainResponse: {
      commands: commands.map(cmd => ({
        id: cmd.id,
        type: cmd.type,
        payload: cmd.payload
      })),
      configUpdate: mergedConfigUpdate,
      upgradeTo,
      helperUpgradeTo: helperUpgradeTo ?? undefined,
      renewCert: renewCert || undefined,
      rotateToken: rotateToken || undefined,
      helperEnabled: helperSettings?.enabled ?? false,
      helperSettings: helperSettings ?? undefined,
      uacInterceptionEnabled: pamSettings?.uacInterceptionEnabled ?? true,
      manageRemoteManagement: manageRemoteManagement || undefined,
    },
  };
    },
  );

  // 404 / 401 / watchdog branches returned a Response directly from the scoped
  // block — pass it through.
  if (scoped instanceof Response) return scoped;

  // #1105 — the org transaction is now released. Fetch the manifest trust
  // keyset OUTSIDE it: getActiveTrustKeyset opens its own system-scoped
  // context/connection, so no withDbAccessContext(org) is held while it
  // acquires a second connection. (Returns the active signing keyset from
  // manifest_signing_keys; empty on hosted SaaS — see
  // docs/deploy/agent-update-trust-bootstrap.md, #625.)
  let manifestTrustKeys: ManifestTrustKey[] = [];
  try {
    manifestTrustKeys = await getActiveTrustKeyset();
  } catch (err) {
    console.error(`[heartbeat] Failed to load manifest trust keyset for agentId=${agentId}:`, err);
    captureException(err);
  }

  return c.json({ ...scoped.mainResponse, manifestTrustKeys });
});

// Receive service/process monitoring check results from agent
heartbeatRoutes.put('/:id/monitoring-results', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), async (c) => {
  const agentId = c.req.param('id');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  let body: { results: Array<Record<string, unknown>> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body?.results) || body.results.length === 0) {
    return c.json({ error: 'results array required' }, 400);
  }

  const { serviceProcessCheckResults } = await import('../../db/schema');
  const { getRedis } = await import('../../services/redis');
  const { publishEvent } = await import('../../services/eventBus');

  const insertValues = body.results.map((r) => ({
    orgId: device.orgId,
    deviceId: device.id,
    watchType: (r.watchType === 'service' ? 'service' : 'process') as 'service' | 'process',
    name: String(r.name ?? ''),
    status: (['running', 'stopped', 'not_found', 'error'].includes(r.status as string) ? r.status : 'error') as 'running' | 'stopped' | 'not_found' | 'error',
    cpuPercent: typeof r.cpuPercent === 'number' ? r.cpuPercent : null,
    memoryMb: typeof r.memoryMb === 'number' ? r.memoryMb : null,
    pid: typeof r.pid === 'number' ? r.pid : null,
    details: (r.details && typeof r.details === 'object') ? r.details : null,
    autoRestartAttempted: r.autoRestartAttempted === true,
    autoRestartSucceeded: typeof r.autoRestartSucceeded === 'boolean' ? r.autoRestartSucceeded : null,
  }));

  // Batch insert results
  try {
    await db.insert(serviceProcessCheckResults).values(insertValues);
  } catch (err) {
    console.error(`[monitoring] failed to insert check results for device ${device.id}:`, err);
    return c.json({ error: 'Failed to store results' }, 500);
  }

  // Track consecutive failures in Redis and manage alerts
  const redis = getRedis();
  for (const result of insertValues) {
    const failureKey = `svc-mon:${device.id}:${result.name}:failures`;

    if (result.status !== 'running') {
      // Increment consecutive failure counter
      if (redis) {
        try {
          const count = await redis.incr(failureKey);
          await redis.expire(failureKey, 3600); // TTL 1h
          // Publish event for real-time UI updates
          publishEvent(
            'monitoring.check_failed',
            device.orgId,
            { deviceId: device.id, name: result.name, watchType: result.watchType, status: result.status, consecutiveFailures: count },
            'agent-monitoring',
            { siteId: device.siteId }
          );
        } catch (err) {
          console.warn(`[monitoring] Redis failure counter error for ${device.id}/${result.name}:`, err);
        }
      }
    } else {
      // Reset failure counter on recovery
      if (redis) {
        try {
          const prevCount = await redis.get(failureKey);
          await redis.del(failureKey);
          if (prevCount && Number(prevCount) > 0) {
            publishEvent(
              'monitoring.check_recovered',
              device.orgId,
              { deviceId: device.id, name: result.name, watchType: result.watchType, previousFailures: Number(prevCount) },
              'agent-monitoring',
              { siteId: device.siteId }
            );
          }
        } catch (err) {
          console.warn(`[monitoring] Redis failure reset error for ${device.id}/${result.name}:`, err);
        }
      }
    }
  }

  return c.json({ accepted: insertValues.length });
});

// Get agent config
heartbeatRoutes.get('/:id/config', async (c) => {
  const agentId = c.req.param('id');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  return c.json({
    heartbeatIntervalSeconds: 60,
    metricsCollectionIntervalSeconds: 30,
    enabledCollectors: ['hardware', 'software', 'metrics', 'network']
  });
});
