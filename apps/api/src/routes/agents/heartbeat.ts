import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceCommands,
  deviceMetrics,
  agentVersions,
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

export const heartbeatRoutes = new Hono();

heartbeatRoutes.post('/:id/heartbeat', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', heartbeatSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const deviceUpdates: Record<string, unknown> = {
    lastSeenAt: new Date(),
    status: 'online',
    agentVersion: data.agentVersion,
    lastUser: data.lastUser ?? null,
    uptimeSeconds: data.uptime ?? null,
    updatedAt: new Date()
  };

  // Only update deviceRole if agent provides one and current source is 'auto'
  if (data.deviceRole && device.deviceRoleSource === 'auto') {
    deviceUpdates.deviceRole = data.deviceRole;
  }

  await db
    .update(devices)
    .set(deviceUpdates)
    .where(eq(devices.id, device.id));

  if (data.metrics) {
    await db
      .insert(deviceMetrics)
      .values({
        deviceId: device.id,
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

  const commands = await db
    .select()
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, device.id),
        eq(deviceCommands.status, 'pending')
      )
    )
    .orderBy(deviceCommands.createdAt)
    .limit(10);

  if (commands.length > 0) {
    for (const cmd of commands) {
      await db
        .update(deviceCommands)
        .set({ status: 'sent' })
        .where(eq(deviceCommands.id, cmd.id));
    }
  }

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
            eq(agentVersions.isLatest, true)
          )
        )
        .limit(1);

      if (latestVersion && compareAgentVersions(latestVersion.version, data.agentVersion) > 0) {
        upgradeTo = latestVersion.version;
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate upgrade target for ${agentId}:`, err);
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

  return c.json({
    commands: commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: cmd.payload
    })),
    configUpdate: mergedConfigUpdate,
    upgradeTo,
    renewCert: renewCert || undefined,
    helperEnabled: helperSettings?.enabled ?? false,
    helperSettings: helperSettings ?? undefined,
  });
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
