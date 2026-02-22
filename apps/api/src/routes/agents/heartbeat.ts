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
  getOrgHelperSettings,
  buildEventLogConfigUpdate,
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

  await db
    .update(devices)
    .set({
      lastSeenAt: new Date(),
      status: 'online',
      agentVersion: data.agentVersion,
      lastUser: data.lastUser ?? null,
      uptimeSeconds: data.uptime ?? null,
      updatedAt: new Date()
    })
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

  let helperEnabled = false;
  try {
    const helperSettings = await getOrgHelperSettings(device.orgId);
    helperEnabled = helperSettings.enabled;
  } catch (err) {
    console.error(`[agents] failed to read helper settings for ${agentId}:`, err);
  }

  let eventLogSettings: Record<string, unknown> | null = null;
  try {
    eventLogSettings = await buildEventLogConfigUpdate(device.id);
  } catch (err) {
    console.error(`[agents] failed to build event log config update for ${agentId}:`, err);
  }

  let mergedConfigUpdate: Record<string, unknown> | null = null;
  if (configUpdate || eventLogSettings) {
    mergedConfigUpdate = { ...(configUpdate ?? {}) };
    if (eventLogSettings) {
      mergedConfigUpdate.event_log_settings = eventLogSettings;
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
    helperEnabled,
  });
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
