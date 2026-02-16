import { Hono } from 'hono';
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
} from './helpers';

export const heartbeatRoutes = new Hono();

heartbeatRoutes.post('/:id/heartbeat', zValidator('json', heartbeatSchema), async (c) => {
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
      networkInBytes: data.metrics.networkInBytes != null ? BigInt(data.metrics.networkInBytes) : null,
      networkOutBytes: data.metrics.networkOutBytes != null ? BigInt(data.metrics.networkOutBytes) : null,
      bandwidthInBps: data.metrics.bandwidthInBps != null ? BigInt(data.metrics.bandwidthInBps) : null,
      bandwidthOutBps: data.metrics.bandwidthOutBps != null ? BigInt(data.metrics.bandwidthOutBps) : null,
      interfaceStats: data.metrics.interfaceStats ?? null,
      processCount: data.metrics.processCount
    });

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

  return c.json({
    commands: commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: cmd.payload
    })),
    configUpdate,
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
