import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import {
  devices,
  deviceMetrics,
  agentVersions,
  agentLogs,
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
} from './helpers';
import { processDeviceIPHistoryUpdate } from '../../services/deviceIpHistory';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { publishEvent } from '../../services/eventBus';
import { isAgentTokenRotationDue } from '../../middleware/agentAuth';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { captureException } from '../../services/sentry';
import { resolveRemoteAccessForDevice } from '../../services/remoteAccessPolicy';
import { getActiveTrustKeyset, type ManifestTrustKey } from '../../services/manifestSigning';

export const heartbeatRoutes = new Hono();

heartbeatRoutes.post('/:id/heartbeat', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', heartbeatSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as AgentAuthContext | undefined;

  if (!agent?.deviceId) {
    return c.json({ error: 'Agent context not found' }, 401);
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
      }, 'heartbeat-watchdog-branch', { priority: 'high' }).catch((err) => {
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

    // Claim watchdog-targeted commands (marks as sent to prevent duplicate delivery)
    const watchdogCommands = await claimPendingCommandsForDevice(device.id, 10, 'watchdog');

    // Check for watchdog upgrade
    let watchdogUpgradeTo: string | undefined;
    const normalizedArch = normalizeAgentArchitecture(device.architecture);
    if (normalizedArch) {
      try {
        const [latestWatchdog] = await db
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(
            and(
              eq(agentVersions.platform, device.osType),
              eq(agentVersions.architecture, normalizedArch),
              eq(agentVersions.component, 'watchdog'),
              eq(agentVersions.isLatest, true)
            )
          )
          .orderBy(desc(agentVersions.createdAt)) // newest first if multiple isLatest rows exist
          .limit(1);

        if (latestWatchdog) {
          if (!data.agentVersion.startsWith('dev-')) {
            const cmp = compareAgentVersions(latestWatchdog.version, data.agentVersion);
            if (cmp > 0) {
              watchdogUpgradeTo = latestWatchdog.version;
            }
          }
        }
      } catch (err) {
        console.error(`[agents] failed to evaluate watchdog upgrade target for ${agentId}:`, err);
      }
    }

    return c.json({
      commands: watchdogCommands.map(cmd => ({
        id: cmd.id,
        type: cmd.type,
        payload: cmd.payload,
      })),
      watchdogUpgradeTo,
    });
  }

  const deviceUpdates: Record<string, unknown> = {
    lastSeenAt: new Date(),
    status: 'online',
    agentVersion: data.agentVersion,
    lastUser: data.lastUser ?? null,
    uptimeSeconds: data.uptime ?? null,
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
    }, 'heartbeat').catch(err => {
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

  const commands = await claimPendingCommandsForDevice(device.id, 10);

  let configUpdate: PolicyProbeConfigUpdate | null = null;
  try {
    configUpdate = await buildPolicyProbeConfigUpdate(device.orgId);
  } catch (err) {
    console.error(`[agents] failed to build policy probe config update for ${agentId}:`, err);
  }

  let upgradeTo: string | null = null;
  const normalizedArch = normalizeAgentArchitecture(device.architecture);
  if (normalizedArch) {
    try {
      const [latestVersion] = await db
        .select({ version: agentVersions.version })
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.platform, device.osType),
            eq(agentVersions.architecture, normalizedArch),
            eq(agentVersions.component, 'agent'),
            eq(agentVersions.isLatest, true)
          )
        )
        .orderBy(desc(agentVersions.createdAt))
        .limit(1);

      if (latestVersion) {
        // Dev builds (dev-*) are local dev-push binaries — never auto-upgrade
        // them back to a release version. The dev-push flow disables auto_update
        // on the agent side; the server also refrains from sending upgradeTo.
        if (data.agentVersion.startsWith('dev-')) {
          // no-op: leave upgradeTo null so agent stays on the dev build
        } else {
          const cmp = compareAgentVersions(latestVersion.version, data.agentVersion);
          if (cmp > 0) {
            upgradeTo = latestVersion.version;
          }
        }
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate upgrade target for ${agentId}:`, err);
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
        // or recovers from broken helper that never wrote its status file)
        if (!data.helperVersion || compareAgentVersions(latestHelper.version, data.helperVersion) > 0) {
          helperUpgradeTo = latestHelper.version;
        }
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate helper upgrade target for ${agentId}:`, err);
    }
  }

  let watchdogUpgradeTo: string | null = null;
  if (normalizedArch) {
    try {
      const [latestWatchdog] = await db
        .select({ version: agentVersions.version })
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.platform, device.osType),
            eq(agentVersions.architecture, normalizedArch),
            eq(agentVersions.component, 'watchdog'),
            eq(agentVersions.isLatest, true)
          )
        )
        .orderBy(desc(agentVersions.createdAt))
        .limit(1);

      if (latestWatchdog && device.watchdogVersion) {
        if (!device.watchdogVersion.startsWith('dev-')) {
          const cmp = compareAgentVersions(latestWatchdog.version, device.watchdogVersion);
          if (cmp > 0) {
            watchdogUpgradeTo = latestWatchdog.version;
          }
        }
      } else if (latestWatchdog && !device.watchdogVersion) {
        // Watchdog not yet installed — signal to agent to install it
        watchdogUpgradeTo = latestWatchdog.version;
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate watchdog upgrade target for ${agentId}:`, err);
    }
  }

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

  let mergedConfigUpdate: Record<string, unknown> | null = null;
  if (configUpdate || eventLogSettings || monitoringSettings) {
    mergedConfigUpdate = { ...(configUpdate ?? {}) };
    if (eventLogSettings) {
      mergedConfigUpdate.event_log_settings = eventLogSettings;
    }
    if (monitoringSettings) {
      mergedConfigUpdate.monitoring_settings = monitoringSettings;
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
      watchdogUpgradeTo: watchdogUpgradeTo ?? undefined,
      renewCert: renewCert || undefined,
      rotateToken: rotateToken || undefined,
      helperEnabled: helperSettings?.enabled ?? false,
      helperSettings: helperSettings ?? undefined,
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
            'agent-monitoring'
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
              'agent-monitoring'
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
