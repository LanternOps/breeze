import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceMetrics,
  deviceCommands,
  deviceFilesystemSnapshots,
  automationPolicies,
  agentVersions
} from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { queueCommandForExecution } from '../../services/commandQueue';
import { filesystemAnalysisCommandType } from './schemas';
import { isObject, asBoolean, asInt, asString, parseEnvBoundedNumber } from './helpers';

export const heartbeatRoutes = new Hono();

const heartbeatSchema = z.object({
  metrics: z.object({
    cpuPercent: z.number(),
    ramPercent: z.number(),
    ramUsedMb: z.number().int(),
    diskPercent: z.number(),
    diskUsedGb: z.number(),
    networkInBytes: z.number().int().optional(),
    networkOutBytes: z.number().int().optional(),
    bandwidthInBps: z.number().int().min(0).optional(),
    bandwidthOutBps: z.number().int().min(0).optional(),
    interfaceStats: z.array(z.object({
      name: z.string().min(1),
      inBytesPerSec: z.number().int().min(0),
      outBytesPerSec: z.number().int().min(0),
      inBytes: z.number().int().min(0),
      outBytes: z.number().int().min(0),
      inPackets: z.number().int().min(0),
      outPackets: z.number().int().min(0),
      inErrors: z.number().int().min(0),
      outErrors: z.number().int().min(0),
      speed: z.number().int().min(0).optional()
    })).max(100).optional(),
    processCount: z.number().int().optional()
  }),
  status: z.enum(['ok', 'warning', 'error']),
  agentVersion: z.string(),
  pendingReboot: z.boolean().optional(),
  lastUser: z.string().max(255).optional(),
  uptime: z.number().int().min(0).optional()
});

const filesystemDiskThresholdPercent = parseEnvBoundedNumber(
  process.env.FILESYSTEM_ANALYSIS_DISK_THRESHOLD,
  85,
  50,
  100
);
const filesystemThresholdCooldownMinutes = parseEnvBoundedNumber(
  process.env.FILESYSTEM_ANALYSIS_THRESHOLD_COOLDOWN_MINUTES,
  120,
  5,
  1440
);

type PolicyRegistryProbeUpdate = {
  registry_path: string;
  value_name: string;
};

type PolicyConfigProbeUpdate = {
  file_path: string;
  config_key: string;
};

type PolicyProbeConfigUpdate = {
  policy_registry_state_probes: PolicyRegistryProbeUpdate[];
  policy_config_state_probes: PolicyConfigProbeUpdate[];
};

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sortPolicyRegistryProbes(probes: PolicyRegistryProbeUpdate[]): PolicyRegistryProbeUpdate[] {
  return [...probes].sort((left, right) => {
    const pathCompare = left.registry_path.localeCompare(right.registry_path);
    if (pathCompare !== 0) return pathCompare;
    return left.value_name.localeCompare(right.value_name);
  });
}

function sortPolicyConfigProbes(probes: PolicyConfigProbeUpdate[]): PolicyConfigProbeUpdate[] {
  return [...probes].sort((left, right) => {
    const pathCompare = left.file_path.localeCompare(right.file_path);
    if (pathCompare !== 0) return pathCompare;
    return left.config_key.localeCompare(right.config_key);
  });
}

function derivePolicyStateProbesFromRules(rules: unknown): {
  registry: PolicyRegistryProbeUpdate[];
  config: PolicyConfigProbeUpdate[];
} {
  if (!Array.isArray(rules)) {
    return { registry: [], config: [] };
  }

  const registryProbes = new Map<string, PolicyRegistryProbeUpdate>();
  const configProbes = new Map<string, PolicyConfigProbeUpdate>();

  for (const rawRule of rules) {
    if (!isObject(rawRule)) {
      continue;
    }

    const type = readTrimmedString(rawRule.type ?? rawRule.name)?.toLowerCase();
    if (type === 'registry_check') {
      const registryPath = readTrimmedString(rawRule.registryPath ?? rawRule.registry_path);
      const valueName = readTrimmedString(rawRule.registryValueName ?? rawRule.registry_value_name);
      if (!registryPath || !valueName) {
        continue;
      }

      const dedupeKey = `${registryPath.toLowerCase()}::${valueName.toLowerCase()}`;
      if (!registryProbes.has(dedupeKey)) {
        registryProbes.set(dedupeKey, {
          registry_path: registryPath,
          value_name: valueName
        });
      }
      continue;
    }

    if (type === 'config_check') {
      const filePath = readTrimmedString(rawRule.configFilePath ?? rawRule.config_file_path);
      const configKey = readTrimmedString(rawRule.configKey ?? rawRule.config_key);
      if (!filePath || !configKey) {
        continue;
      }

      const dedupeKey = `${filePath.toLowerCase()}::${configKey.toLowerCase()}`;
      if (!configProbes.has(dedupeKey)) {
        configProbes.set(dedupeKey, {
          file_path: filePath,
          config_key: configKey
        });
      }
    }
  }

  return {
    registry: sortPolicyRegistryProbes(Array.from(registryProbes.values())),
    config: sortPolicyConfigProbes(Array.from(configProbes.values()))
  };
}

async function buildPolicyProbeConfigUpdate(orgId: string | null | undefined): Promise<PolicyProbeConfigUpdate | null> {
  if (!orgId) {
    return null;
  }

  const policyRows = await db
    .select({ rules: automationPolicies.rules })
    .from(automationPolicies)
    .where(
      and(
        eq(automationPolicies.orgId, orgId),
        eq(automationPolicies.enabled, true)
      )
    );

  const registryByKey = new Map<string, PolicyRegistryProbeUpdate>();
  const configByKey = new Map<string, PolicyConfigProbeUpdate>();

  for (const row of policyRows) {
    const probes = derivePolicyStateProbesFromRules(row.rules);
    for (const probe of probes.registry) {
      const key = `${probe.registry_path.toLowerCase()}::${probe.value_name.toLowerCase()}`;
      if (!registryByKey.has(key)) {
        registryByKey.set(key, probe);
      }
    }
    for (const probe of probes.config) {
      const key = `${probe.file_path.toLowerCase()}::${probe.config_key.toLowerCase()}`;
      if (!configByKey.has(key)) {
        configByKey.set(key, probe);
      }
    }
  }

  return {
    policy_registry_state_probes: sortPolicyRegistryProbes(Array.from(registryByKey.values())),
    policy_config_state_probes: sortPolicyConfigProbes(Array.from(configByKey.values()))
  };
}

function normalizeAgentArchitecture(architecture: string | null | undefined): 'amd64' | 'arm64' | null {
  if (!architecture) return null;
  const normalized = architecture.trim().toLowerCase();
  if (normalized === 'amd64' || normalized === 'x86_64' || normalized === 'x64') {
    return 'amd64';
  }
  if (normalized === 'arm64' || normalized === 'aarch64') {
    return 'arm64';
  }
  return null;
}

function parseComparableVersion(raw: string): { core: number[]; prerelease: string | null } | null {
  const trimmed = raw.trim().replace(/^v/i, '');
  if (!trimmed) return null;

  const [rawCorePart, prereleasePart] = trimmed.split('-', 2);
  const corePart = rawCorePart ?? '';
  if (!corePart) return null;
  const coreTokens = corePart.split('.');
  if (coreTokens.length === 0) return null;

  const core: number[] = [];
  for (const token of coreTokens) {
    if (!/^\d+$/.test(token)) return null;
    core.push(Number.parseInt(token, 10));
  }

  return {
    core,
    prerelease: prereleasePart ?? null,
  };
}

function compareAgentVersions(leftRaw: string, rightRaw: string): number {
  const left = parseComparableVersion(leftRaw);
  const right = parseComparableVersion(rightRaw);
  if (!left || !right) return 0;

  const maxLen = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < maxLen; i += 1) {
    const leftPart = left.core[i] ?? 0;
    const rightPart = right.core[i] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function getFilesystemThresholdScanPath(osType: unknown): string {
  if (osType === 'windows') return 'C:\\';
  return '/';
}

async function maybeQueueThresholdFilesystemAnalysis(
  device: Pick<typeof devices.$inferSelect, 'id' | 'osType'>,
  diskPercent: number
): Promise<{ queued: boolean; path?: string; thresholdPercent?: number }> {
  if (!Number.isFinite(diskPercent) || diskPercent < filesystemDiskThresholdPercent) {
    return { queued: false };
  }

  const cooldownStart = new Date(Date.now() - filesystemThresholdCooldownMinutes * 60 * 1000);
  const [recentSnapshot] = await db
    .select({ id: deviceFilesystemSnapshots.id })
    .from(deviceFilesystemSnapshots)
    .where(
      and(
        eq(deviceFilesystemSnapshots.deviceId, device.id),
        gte(deviceFilesystemSnapshots.capturedAt, cooldownStart)
      )
    )
    .orderBy(desc(deviceFilesystemSnapshots.capturedAt))
    .limit(1);

  if (recentSnapshot) {
    return { queued: false };
  }

  const [recentCommand] = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, device.id),
        eq(deviceCommands.type, filesystemAnalysisCommandType),
        gte(deviceCommands.createdAt, cooldownStart)
      )
    )
    .orderBy(desc(deviceCommands.createdAt))
    .limit(1);

  if (recentCommand) {
    return { queued: false };
  }

  const path = getFilesystemThresholdScanPath(device.osType);
  await db.insert(deviceCommands).values({
    deviceId: device.id,
    type: filesystemAnalysisCommandType,
    payload: {
      path,
      trigger: 'threshold',
      thresholdPercent: filesystemDiskThresholdPercent,
      maxDepth: 32,
      topFiles: 50,
      topDirs: 30,
      maxEntries: 10_000_000,
      workers: 6,
      timeoutSeconds: 300,
      scanMode: 'baseline',
      autoContinue: true,
      resumeAttempt: 0,
      followSymlinks: false,
    },
    status: 'pending',
  });

  return {
    queued: true,
    path,
    thresholdPercent: filesystemDiskThresholdPercent,
  };
}

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

  return c.json({
    commands: commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: cmd.payload
    })),
    configUpdate,
    upgradeTo,
    renewCert: renewCert || undefined
  });
});
