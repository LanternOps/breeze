import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceDisks,
  deviceRegistryState,
  deviceConfigState,
  deviceMetrics,
  deviceCommands,
  automationPolicies,
  deviceConnections,
  enrollmentKeys,
  softwareInventory,
  patches,
  devicePatches,
  deviceEventLogs,
  securityStatus,
  securityThreats,
  securityScans,
  deviceFilesystemSnapshots,
  deviceSessions,
  agentVersions,
  organizations
} from '../db/schema';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentAuthMiddleware } from '../middleware/agentAuth';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { writeAuditEvent } from '../services/auditEvents';
import { queueCommandForExecution } from '../services/commandQueue';
import {
  getFilesystemScanState,
  mergeFilesystemAnalysisPayload,
  parseFilesystemAnalysisStdout,
  readCheckpointPendingDirectories,
  readHotDirectories,
  saveFilesystemSnapshot,
  upsertFilesystemScanState,
} from '../services/filesystemAnalysis';
import { publishEvent } from '../services/eventBus';
import { hashEnrollmentKey } from '../services/enrollmentKeySecurity';
import { CloudflareMtlsService } from '../services/cloudflareMtls';
import { orgMtlsSettingsSchema } from '@breeze/shared';

export const agentRoutes = new Hono();

// Apply agent auth to all parameterized routes.
// Skip for endpoints that handle their own authentication:
// - /enroll, /renew-cert, /quarantined (special endpoints matched as /:id)
// - /org/* (org settings, uses user JWT auth)
// - /:id/approve, /:id/deny (admin endpoints, use user JWT auth)
agentRoutes.use('/:id/*', async (c, next) => {
  const id = c.req.param('id');
  if (id === 'enroll' || id === 'renew-cert' || id === 'quarantined' || id === 'org' || id === 'download') {
    return next();
  }
  // Check if the sub-path is an admin endpoint that uses user JWT auth
  const path = c.req.path;
  if (path.endsWith('/approve') || path.endsWith('/deny')) {
    return next();
  }
  return agentAuthMiddleware(c, next);
});

// Enrollment request schema
const enrollSchema = z.object({
  enrollmentKey: z.string().min(1),
  enrollmentSecret: z.string().min(1).optional(),
  hostname: z.string().min(1),
  osType: z.enum(['windows', 'macos', 'linux']),
  osVersion: z.string().min(1),
  architecture: z.string().min(1),
  agentVersion: z.string().min(1),
  hardwareInfo: z.object({
    cpuModel: z.string().optional(),
    cpuCores: z.number().int().optional(),
    cpuThreads: z.number().int().optional(),
    ramTotalMb: z.number().int().optional(),
    diskTotalGb: z.number().int().optional(),
    serialNumber: z.string().optional(),
    manufacturer: z.string().optional(),
    model: z.string().optional(),
    biosVersion: z.string().optional(),
    gpuModel: z.string().optional()
  }).optional(),
  networkInfo: z.array(z.object({
    name: z.string(),
    mac: z.string().optional(),
    ip: z.string().optional(),
    isPrimary: z.boolean().optional()
  })).optional()
});

// Heartbeat request schema
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
  lastUser: z.string().optional(),
  uptime: z.number().int().optional()
});

const commandResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().int(),
  error: z.string().optional()
});

const securityProviderValues = [
  'windows_defender',
  'bitdefender',
  'sophos',
  'sentinelone',
  'crowdstrike',
  'malwarebytes',
  'eset',
  'kaspersky',
  'other'
] as const;

type SecurityProviderValue = (typeof securityProviderValues)[number];

const securityStatusIngestSchema = z.object({
  provider: z.string().optional(),
  providerVersion: z.string().optional(),
  definitionsVersion: z.string().optional(),
  definitionsDate: z.string().optional(),
  lastScan: z.string().optional(),
  lastScanType: z.string().optional(),
  realTimeProtection: z.boolean().optional(),
  threatCount: z.number().int().min(0).optional(),
  firewallEnabled: z.boolean().optional(),
  encryptionStatus: z.string().optional(),
  encryptionDetails: z.record(z.unknown()).optional(),
  localAdminSummary: z.record(z.unknown()).optional(),
  passwordPolicySummary: z.record(z.unknown()).optional(),
  gatekeeperEnabled: z.boolean().optional(),
  guardianEnabled: z.boolean().optional(),
  windowsSecurityCenterAvailable: z.boolean().optional(),
  avProducts: z.array(
    z.object({
      displayName: z.string().optional(),
      provider: z.string().optional(),
      realTimeProtection: z.boolean().optional(),
      definitionsUpToDate: z.boolean().optional(),
      productState: z.number().int().optional()
    }).passthrough()
  ).optional()
}).passthrough();

type SecurityStatusPayload = z.infer<typeof securityStatusIngestSchema>;

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const securityCommandTypes = {
  collectStatus: 'security_collect_status',
  scan: 'security_scan',
  quarantine: 'security_threat_quarantine',
  remove: 'security_threat_remove',
  restore: 'security_threat_restore'
} as const;

const filesystemAnalysisCommandType = 'filesystem_analysis';
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
const filesystemAutoResumeMaxRuns = parseEnvBoundedNumber(
  process.env.FILESYSTEM_ANALYSIS_AUTO_RESUME_MAX_RUNS,
  200,
 1,
 5000
);

function parseEnvBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

function asInt(value: unknown, defaultValue = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return defaultValue;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

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

function normalizeProvider(raw: unknown): SecurityProviderValue {
  if (typeof raw !== 'string') return 'other';
  const value = raw.trim().toLowerCase();
  switch (value) {
    case 'windows_defender':
    case 'microsoft_defender':
    case 'defender':
    case 'prov-defender':
      return 'windows_defender';
    case 'bitdefender':
    case 'prov-bitdefender':
      return 'bitdefender';
    case 'sophos':
      return 'sophos';
    case 'sentinelone':
    case 'sentinel_one':
    case 'sentinel':
    case 'prov-sentinelone':
      return 'sentinelone';
    case 'crowdstrike':
    case 'prov-crowdstrike':
      return 'crowdstrike';
    case 'malwarebytes':
      return 'malwarebytes';
    case 'eset':
      return 'eset';
    case 'kaspersky':
      return 'kaspersky';
    default:
      return 'other';
  }
}

function normalizeEncryptionStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (value === 'encrypted' || value === 'partial' || value === 'unencrypted' || value === 'unknown') {
    return value;
  }
  if (value.includes('encrypt')) return 'encrypted';
  if (value.includes('unencrypt')) return 'unencrypted';
  return value.slice(0, 50);
}

function normalizeSeverity(raw: unknown): 'low' | 'medium' | 'high' | 'critical' {
  if (typeof raw !== 'string') return 'medium';
  const value = raw.trim().toLowerCase();
  if (value === 'critical') return 'critical';
  if (value === 'high') return 'high';
  if (value === 'low') return 'low';
  return 'medium';
}

function normalizeKnownOsType(raw: unknown): 'windows' | 'macos' | 'linux' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'windows' || value === 'macos' || value === 'linux') {
    return value;
  }
  return null;
}

function inferPatchOsType(source: string, deviceOs: unknown): 'windows' | 'macos' | 'linux' | null {
  const normalizedDeviceOs = normalizeKnownOsType(deviceOs);
  if (normalizedDeviceOs) {
    return normalizedDeviceOs;
  }

  switch (source) {
    case 'microsoft':
      return 'windows';
    case 'apple':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return null;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidRegex.test(value);
}

function parseResultJson(stdout: string | undefined): Record<string, unknown> | undefined {
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    console.warn('[agents] Failed to parse command result JSON:', stdout?.slice(0, 500));
    return undefined;
  }
}

function getSecurityStatusFromResult(resultData: Record<string, unknown> | undefined): SecurityStatusPayload | undefined {
  if (!resultData) return undefined;

  const nested = isObject(resultData.status) ? resultData.status : undefined;
  const candidate = nested ?? resultData;
  const parsed = securityStatusIngestSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data;
}

async function upsertSecurityStatusForDevice(deviceId: string, payload: SecurityStatusPayload): Promise<void> {
  const avProducts = Array.isArray(payload.avProducts) ? payload.avProducts : [];
  const preferredProduct = avProducts.find((p) => p.realTimeProtection) ?? avProducts[0];
  const provider = normalizeProvider(payload.provider ?? preferredProduct?.provider);

  await db
    .insert(securityStatus)
    .values({
      deviceId,
      provider,
      providerVersion: asString(payload.providerVersion) ?? null,
      definitionsVersion: asString(payload.definitionsVersion) ?? null,
      definitionsDate: parseDate(payload.definitionsDate),
      realTimeProtection: payload.realTimeProtection ?? preferredProduct?.realTimeProtection ?? false,
      lastScan: parseDate(payload.lastScan),
      lastScanType: asString(payload.lastScanType) ?? null,
      threatCount: payload.threatCount ?? 0,
      firewallEnabled: payload.firewallEnabled ?? null,
      encryptionStatus: normalizeEncryptionStatus(payload.encryptionStatus),
      encryptionDetails: payload.encryptionDetails ?? null,
      localAdminSummary: payload.localAdminSummary ?? null,
      passwordPolicySummary: payload.passwordPolicySummary ?? null,
      gatekeeperEnabled: payload.gatekeeperEnabled ?? payload.guardianEnabled ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: securityStatus.deviceId,
      set: {
        provider,
        providerVersion: asString(payload.providerVersion) ?? null,
        definitionsVersion: asString(payload.definitionsVersion) ?? null,
        definitionsDate: parseDate(payload.definitionsDate),
        realTimeProtection: payload.realTimeProtection ?? preferredProduct?.realTimeProtection ?? false,
        lastScan: parseDate(payload.lastScan),
        lastScanType: asString(payload.lastScanType) ?? null,
        threatCount: payload.threatCount ?? 0,
        firewallEnabled: payload.firewallEnabled ?? null,
        encryptionStatus: normalizeEncryptionStatus(payload.encryptionStatus),
        encryptionDetails: payload.encryptionDetails ?? null,
        localAdminSummary: payload.localAdminSummary ?? null,
        passwordPolicySummary: payload.passwordPolicySummary ?? null,
        gatekeeperEnabled: payload.gatekeeperEnabled ?? payload.guardianEnabled ?? null,
        updatedAt: new Date()
      }
    });
}

async function updateThreatStatusForAction(command: typeof deviceCommands.$inferSelect): Promise<void> {
  const payload = isObject(command.payload) ? command.payload : {};
  const threatId = payload.threatId;
  const threatPath = asString(payload.path);

  let targetId: string | undefined;
  if (isUuid(threatId)) {
    targetId = threatId;
  } else if (threatPath) {
    const [threat] = await db
      .select({ id: securityThreats.id })
      .from(securityThreats)
      .where(and(eq(securityThreats.deviceId, command.deviceId), eq(securityThreats.filePath, threatPath)))
      .orderBy(desc(securityThreats.detectedAt))
      .limit(1);
    targetId = threat?.id;
  }

  if (!targetId) return;

  const now = new Date();
  if (command.type === securityCommandTypes.quarantine) {
    await db
      .update(securityThreats)
      .set({ status: 'quarantined', resolvedAt: null, resolvedBy: null })
      .where(eq(securityThreats.id, targetId));
    return;
  }

  if (command.type === securityCommandTypes.remove) {
    await db
      .update(securityThreats)
      .set({ status: 'removed', resolvedAt: now, resolvedBy: 'agent' })
      .where(eq(securityThreats.id, targetId));
    return;
  }

  if (command.type === securityCommandTypes.restore) {
    await db
      .update(securityThreats)
      .set({ status: 'allowed', resolvedAt: now, resolvedBy: 'agent' })
      .where(eq(securityThreats.id, targetId));
  }
}

async function handleSecurityCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  const resultJson = parseResultJson(resultData.stdout);
  const parsedStatus = getSecurityStatusFromResult(resultJson);
  if (parsedStatus) {
    await upsertSecurityStatusForDevice(command.deviceId, parsedStatus);
  }

  if (command.type === securityCommandTypes.collectStatus) {
    return;
  }

  if (command.type === securityCommandTypes.scan) {
    const payload = isObject(command.payload) ? command.payload : {};
    const scanType = asString(resultJson?.scanType) ?? asString(payload.scanType) ?? 'quick';
    const scanRecordId = asString(resultJson?.scanRecordId) ?? asString(payload.scanRecordId);
    const threatsValue = Array.isArray(resultJson?.threats) ? resultJson.threats : [];
    const threatsFoundRaw = resultJson?.threatsFound;
    const threatsFound = typeof threatsFoundRaw === 'number'
      ? Math.max(0, Math.floor(threatsFoundRaw))
      : threatsValue.length;
    const completedAt = new Date();
    const durationSeconds = Math.max(0, Math.round(resultData.durationMs / 1000));

    let existingScan: { id: string } | undefined;
    if (isUuid(scanRecordId)) {
      [existingScan] = await db
        .select({ id: securityScans.id })
        .from(securityScans)
        .where(and(eq(securityScans.id, scanRecordId), eq(securityScans.deviceId, command.deviceId)))
        .limit(1);
    }

    if (existingScan) {
      await db
        .update(securityScans)
        .set({
          status: resultData.status === 'completed' ? 'completed' : 'failed',
          completedAt,
          duration: durationSeconds,
          threatsFound
        })
        .where(eq(securityScans.id, existingScan.id));
    } else {
      await db.insert(securityScans).values({
        ...(isUuid(scanRecordId) ? { id: scanRecordId } : {}),
        deviceId: command.deviceId,
        scanType,
        status: resultData.status === 'completed' ? 'completed' : 'failed',
        startedAt: command.createdAt ?? new Date(),
        completedAt,
        threatsFound,
        duration: durationSeconds
      });
    }

    if (resultData.status === 'completed' && threatsValue.length > 0) {
      const provider = normalizeProvider(parsedStatus?.provider);
      const inserts: Array<typeof securityThreats.$inferInsert> = [];

      for (const threat of threatsValue) {
        if (!isObject(threat)) continue;
        inserts.push({
          deviceId: command.deviceId,
          provider,
          threatName: asString(threat.name) ?? asString(threat.threatName) ?? 'Unknown Threat',
          threatType: asString(threat.type) ?? asString(threat.threatType) ?? asString(threat.category) ?? null,
          severity: normalizeSeverity(threat.severity),
          status: 'detected',
          filePath: asString(threat.path) ?? asString(threat.filePath) ?? null,
          processName: asString(threat.processName) ?? null,
          detectedAt: completedAt,
          details: threat
        });
      }

      if (inserts.length > 0) {
        await db.insert(securityThreats).values(inserts);
      }
    }

    return;
  }

  if (
    command.type === securityCommandTypes.quarantine ||
    command.type === securityCommandTypes.remove ||
    command.type === securityCommandTypes.restore
  ) {
    if (resultData.status === 'completed') {
      await updateThreatStatusForAction(command);
    }
  }
}

async function handleFilesystemAnalysisCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  if (resultData.status !== 'completed') {
    return;
  }

  const payload = isObject(command.payload) ? command.payload : {};
  const trigger = asString(payload.trigger);
  const snapshotTrigger = trigger === 'threshold' ? 'threshold' : 'on_demand';
  const scanMode = asString(payload.scanMode) === 'incremental' ? 'incremental' : 'baseline';

  const parsed = parseFilesystemAnalysisStdout(resultData.stdout ?? '');
  if (Object.keys(parsed).length === 0) {
    return;
  }

  const currentState = await getFilesystemScanState(command.deviceId);
  const existingAggregate = isObject(currentState?.aggregate) ? currentState.aggregate : {};
  const mergedPayload = scanMode === 'baseline'
    ? mergeFilesystemAnalysisPayload(existingAggregate, parsed)
    : parsed;
  const pendingDirs = readCheckpointPendingDirectories(mergedPayload.checkpoint, 50_000);
  const hasCheckpoint = scanMode === 'baseline' && pendingDirs.length > 0;
  const snapshotPayload = hasCheckpoint
    ? {
      ...mergedPayload,
      partial: true,
      reason: `checkpoint pending ${pendingDirs.length} directories`,
      checkpoint: { pendingDirs },
      scanMode,
    }
    : {
      ...mergedPayload,
      scanMode,
    };

  await saveFilesystemSnapshot(command.deviceId, snapshotTrigger, snapshotPayload);

  const [disk] = await db
    .select({ usedPercent: deviceDisks.usedPercent })
    .from(deviceDisks)
    .where(eq(deviceDisks.deviceId, command.deviceId))
    .limit(1);
  const currentDiskUsedPercent = typeof disk?.usedPercent === 'number' ? disk.usedPercent : null;

  const hotFromRun = extractHotDirectoriesFromSnapshotPayload(snapshotPayload, 24);
  const mergedHotDirectories = Array.from(
    new Set([
      ...hotFromRun,
      ...readHotDirectories(currentState?.hotDirectories, 24),
    ])
  ).slice(0, 24);

  const snapshotIsPartial = 'partial' in snapshotPayload ? Boolean(snapshotPayload.partial) : false;
  const baselineCompleted = scanMode === 'baseline' && pendingDirs.length === 0 && !snapshotIsPartial;
  await upsertFilesystemScanState(command.deviceId, {
    lastRunMode: scanMode,
    lastBaselineCompletedAt: baselineCompleted
      ? new Date()
      : currentState?.lastBaselineCompletedAt ?? null,
    lastDiskUsedPercent: currentDiskUsedPercent ?? currentState?.lastDiskUsedPercent ?? null,
    checkpoint: hasCheckpoint ? { pendingDirs } : {},
    aggregate: scanMode === 'baseline' && !baselineCompleted ? mergedPayload : {},
    hotDirectories: mergedHotDirectories,
  });

  if (!hasCheckpoint || scanMode !== 'baseline') {
    return;
  }

  const autoContinue = asBoolean(payload.autoContinue, true);
  if (!autoContinue) {
    return;
  }

  const resumeAttempt = Math.max(0, asInt(payload.resumeAttempt, 0));
  if (resumeAttempt >= filesystemAutoResumeMaxRuns) {
    return;
  }

  const [inFlightScan] = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, command.deviceId),
        eq(deviceCommands.type, filesystemAnalysisCommandType),
        sql`${deviceCommands.status} IN ('pending', 'sent')`
      )
    )
    .limit(1);

  if (inFlightScan) {
    return;
  }

  const nextPayload: Record<string, unknown> = {
    ...(isObject(payload) ? payload : {}),
    scanMode: 'baseline',
    checkpoint: { pendingDirs },
    autoContinue: true,
    resumeAttempt: resumeAttempt + 1,
  };
  delete nextPayload.targetDirectories;

  const queued = await queueCommandForExecution(
    command.deviceId,
    filesystemAnalysisCommandType,
    nextPayload,
    {
      userId: command.createdBy ?? undefined,
      preferHeartbeat: false,
    }
  );
  if (queued.command) {
    return;
  }

  await db.insert(deviceCommands).values({
    deviceId: command.deviceId,
    type: filesystemAnalysisCommandType,
    payload: nextPayload,
    status: 'pending',
    createdBy: command.createdBy,
  });
}

function extractHotDirectoriesFromSnapshotPayload(payload: Record<string, unknown>, limit: number): string[] {
  const rootPath = asString(payload.path);
  const rawDirs = Array.isArray(payload.topLargestDirectories) ? payload.topLargestDirectories : [];
  const paths = rawDirs
    .map((entry) => {
      if (!isObject(entry)) return null;
      return asString(entry.path) ?? null;
    })
    .filter((path): path is string => path !== null && path !== rootPath);
  return Array.from(new Set(paths)).slice(0, limit);
}

// Generate a unique agent ID
function generateAgentId(): string {
  return randomBytes(32).toString('hex');
}

// Generate API key for agent
function generateApiKey(): string {
  return `brz_${randomBytes(32).toString('hex')}`;
}

/** Read org mTLS settings from the organizations.settings JSONB. */
async function getOrgMtlsSettings(orgId: string): Promise<{ certLifetimeDays: number; expiredCertPolicy: 'auto_reissue' | 'quarantine' }> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const settings = isObject(org?.settings) ? org.settings : {};
  const mtls = isObject(settings.mtls) ? settings.mtls : {};
  const certLifetimeDays = typeof mtls.certLifetimeDays === 'number' && mtls.certLifetimeDays >= 1 && mtls.certLifetimeDays <= 365
    ? Math.round(mtls.certLifetimeDays)
    : 90;
  const expiredCertPolicy = mtls.expiredCertPolicy === 'quarantine' ? 'quarantine' : 'auto_reissue';
  return { certLifetimeDays, expiredCertPolicy };
}

/** Issue an mTLS cert for a device and update its DB columns. Returns the cert data or null. */
async function issueMtlsCertForDevice(deviceId: string, orgId: string): Promise<{
  certificate: string;
  privateKey: string;
  expiresAt: string;
  serialNumber: string;
} | null> {
  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) return null;

  let cert;
  try {
    const mtlsSettings = await getOrgMtlsSettings(orgId);
    cert = await cfService.issueCertificate(mtlsSettings.certLifetimeDays);
  } catch (err) {
    console.error('[agents] mTLS cert issuance failed, falling back to bearer-only auth:', err);
    return null;
  }

  try {
    await db
      .update(devices)
      .set({
        mtlsCertSerialNumber: cert.serialNumber,
        mtlsCertExpiresAt: new Date(cert.expiresOn),
        mtlsCertIssuedAt: new Date(cert.issuedOn),
        mtlsCertCfId: cert.id,
      })
      .where(eq(devices.id, deviceId));
  } catch (dbErr) {
    console.error('[agents] mTLS cert issued but DB update failed — orphaned cert on Cloudflare:', {
      deviceId, cfCertId: cert.id, error: dbErr,
    });
    // Still return cert to agent so they can use it
  }

  return {
    certificate: cert.certificate,
    privateKey: cert.privateKey,
    expiresAt: cert.expiresOn,
    serialNumber: cert.serialNumber,
  };
}

// ============================================
// Agent Binary Download (public, no auth)
// ============================================

const VALID_OS = new Set(['linux', 'darwin', 'windows']);
const VALID_ARCH = new Set(['amd64', 'arm64']);

agentRoutes.get('/download/:os/:arch', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json(
      {
        error: 'Invalid OS',
        message: `Supported values: linux, darwin, windows. Got: ${os}`,
      },
      400
    );
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json(
      {
        error: 'Invalid architecture',
        message: `Supported values: amd64, arm64. Got: ${arch}`,
      },
      400
    );
  }

  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-agent-${os}-${arch}${extension}`;
  const filePath = join(binaryDir, filename);

  if (!existsSync(filePath)) {
    return c.json(
      {
        error: 'Binary not found',
        message: `Agent binary "${filename}" is not available. Ensure the binary has been built and placed in the configured AGENT_BINARY_DIR (${binaryDir}).`,
        hint: `Run "cd agent && GOOS=${os} GOARCH=${arch} make build" to build the binary.`,
      },
      404
    );
  }

  const stat = statSync(filePath);
  const stream = createReadStream(filePath);

  // Convert Node.js ReadableStream to a web ReadableStream for Hono
  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => {
        controller.close();
      });
      stream.on('error', (err) => {
        controller.error(err);
      });
    },
    cancel() {
      stream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Install Script (public, no auth)
// ============================================

agentRoutes.get('/install.sh', async (c) => {
  // Determine the server URL: prefer BREEZE_SERVER env, then PUBLIC_API_URL, then request origin
  const serverUrl =
    process.env.BREEZE_SERVER ||
    process.env.PUBLIC_API_URL ||
    new URL(c.req.url).origin;

  const script = generateInstallScript(serverUrl);

  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

function generateInstallScript(serverUrl: string): string {
  return `#!/usr/bin/env bash
# ============================================
# Breeze RMM Agent - One-Line Installer
# ============================================
# Usage:
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash -s -- \\
#     --server ${serverUrl} \\
#     --enrollment-secret YOUR_SECRET
#
# Or with environment variables:
#   export BREEZE_SERVER="${serverUrl}"
#   export BREEZE_ENROLLMENT_SECRET="YOUR_SECRET"
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash
# ============================================

set -euo pipefail

# ----- Colors -----
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
NC='\\033[0m' # No Color

info()    { echo -e "\${BLUE}[INFO]\${NC}  $*"; }
success() { echo -e "\${GREEN}[OK]\${NC}    $*"; }
warn()    { echo -e "\${YELLOW}[WARN]\${NC}  $*"; }
error()   { echo -e "\${RED}[ERROR]\${NC} $*" >&2; }
fatal()   { error "$*"; exit 1; }

# ----- Parse arguments -----
BREEZE_SERVER="\${BREEZE_SERVER:-}"
BREEZE_ENROLLMENT_SECRET="\${BREEZE_ENROLLMENT_SECRET:-}"
BREEZE_SITE_ID="\${BREEZE_SITE_ID:-}"

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --server)
      BREEZE_SERVER="\$2"; shift 2 ;;
    --enrollment-secret)
      BREEZE_ENROLLMENT_SECRET="\$2"; shift 2 ;;
    --site-id)
      BREEZE_SITE_ID="\$2"; shift 2 ;;
    *)
      warn "Unknown argument: \$1"; shift ;;
  esac
done

# ----- Validate required parameters -----
if [[ -z "\$BREEZE_SERVER" ]]; then
  fatal "BREEZE_SERVER is required. Pass --server URL or export BREEZE_SERVER."
fi

if [[ -z "\$BREEZE_ENROLLMENT_SECRET" ]]; then
  fatal "BREEZE_ENROLLMENT_SECRET is required. Pass --enrollment-secret SECRET or export BREEZE_ENROLLMENT_SECRET."
fi

# Strip trailing slash from server URL
BREEZE_SERVER="\${BREEZE_SERVER%/}"

# ----- Detect OS -----
detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "\$uname_s" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)       fatal "Unsupported operating system: \$uname_s. Only Linux and macOS are supported by this installer." ;;
  esac
}

# ----- Detect Architecture -----
detect_arch() {
  local uname_m
  uname_m="$(uname -m)"
  case "\$uname_m" in
    x86_64|amd64)   echo "amd64" ;;
    aarch64|arm64)   echo "arm64" ;;
    *)               fatal "Unsupported architecture: \$uname_m. Only amd64 and arm64 are supported." ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/breeze"
BINARY_NAME="breeze-agent"
DOWNLOAD_URL="\${BREEZE_SERVER}/api/v1/agents/download/\${OS}/\${ARCH}"

info "Breeze RMM Agent Installer"
info "  Server:       \$BREEZE_SERVER"
info "  OS:           \$OS"
info "  Architecture: \$ARCH"
info "  Download URL: \$DOWNLOAD_URL"
echo ""

# ----- Check root -----
if [[ "\$(id -u)" -ne 0 ]]; then
  fatal "This installer must be run as root (use sudo)."
fi

# ----- Check for curl -----
if ! command -v curl &>/dev/null; then
  fatal "curl is required but not installed. Install it and try again."
fi

# ----- Download binary -----
info "Downloading agent binary..."
TMPFILE="$(mktemp)"
trap 'rm -f "\$TMPFILE"' EXIT

HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$TMPFILE" "\$DOWNLOAD_URL" 2>/dev/null)" || true

if [[ "\$HTTP_CODE" != "200" ]]; then
  fatal "Failed to download agent binary (HTTP \$HTTP_CODE). Check that the server URL is correct and the binary is available."
fi

# Verify the download is not empty
if [[ ! -s "\$TMPFILE" ]]; then
  fatal "Downloaded file is empty. The agent binary may not be built for \$OS/\$ARCH."
fi

success "Downloaded agent binary ($(wc -c < "\$TMPFILE" | tr -d ' ') bytes)"

# ----- Install binary -----
info "Installing to \$INSTALL_DIR/\$BINARY_NAME..."
mv "\$TMPFILE" "\$INSTALL_DIR/\$BINARY_NAME"
chmod 755 "\$INSTALL_DIR/\$BINARY_NAME"
trap - EXIT
success "Installed \$INSTALL_DIR/\$BINARY_NAME"

# ----- Create config directory -----
info "Creating config directory \$CONFIG_DIR..."
mkdir -p "\$CONFIG_DIR"
chmod 0700 "\$CONFIG_DIR"
success "Config directory ready"

# ----- Enroll agent -----
info "Enrolling agent with Breeze server..."
ENROLL_ARGS=(
  enroll
  --server "\$BREEZE_SERVER"
  --enrollment-secret "\$BREEZE_ENROLLMENT_SECRET"
)
if [[ -n "\$BREEZE_SITE_ID" ]]; then
  ENROLL_ARGS+=(--site-id "\$BREEZE_SITE_ID")
fi

if ! "\$INSTALL_DIR/\$BINARY_NAME" "\${ENROLL_ARGS[@]}"; then
  fatal "Enrollment failed. Check the server URL and enrollment secret."
fi
success "Agent enrolled successfully"

# ----- Install service -----
install_systemd_service() {
  info "Installing systemd service..."
  cat > /etc/systemd/system/breeze-agent.service <<SERVICEEOF
[Unit]
Description=Breeze RMM Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/$BINARY_NAME run
Restart=always
RestartSec=10
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-agent

# Security hardening
NoNewPrivileges=false
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$CONFIG_DIR

[Install]
WantedBy=multi-user.target
SERVICEEOF

  systemctl daemon-reload
  systemctl enable breeze-agent
  systemctl start breeze-agent
  success "systemd service installed and started"
}

install_launchd_service() {
  info "Installing launchd service..."
  local plist_path="/Library/LaunchDaemons/com.breeze.agent.plist"
  cat > "\$plist_path" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$INSTALL_DIR/$BINARY_NAME</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/breeze-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/breeze-agent.err</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
PLISTEOF

  chmod 644 "\$plist_path"
  launchctl load "\$plist_path"
  success "launchd service installed and started"
}

case "\$OS" in
  linux)
    if command -v systemctl &>/dev/null; then
      install_systemd_service
    else
      warn "systemd not found. Please configure the agent to start on boot manually."
      info "Run: $INSTALL_DIR/$BINARY_NAME run"
    fi
    ;;
  darwin)
    install_launchd_service
    ;;
esac

echo ""
success "Breeze agent installation complete!"
info "The device should appear in your Breeze dashboard within 60 seconds."
info "  Check status:  sudo systemctl status breeze-agent  (Linux)"
info "                 sudo launchctl list | grep breeze    (macOS)"
info "  View logs:     sudo journalctl -u breeze-agent -f  (Linux)"
`;
}

// Agent enrollment
agentRoutes.post('/enroll', zValidator('json', enrollSchema), async (c) => {
  const data = c.req.valid('json');
  const configuredSecret = process.env.AGENT_ENROLLMENT_SECRET;
  const requireSecret = (process.env.NODE_ENV ?? 'development') === 'production'
    && typeof configuredSecret === 'string'
    && configuredSecret.length > 0;

  if (requireSecret) {
    const provided = (data.enrollmentSecret ?? c.req.header('x-agent-enrollment-secret') ?? '').trim();
    if (!provided) {
      return c.json({ error: 'Enrollment secret required' }, 403);
    }

    const providedBuf = Buffer.from(provided);
    const configuredBuf = Buffer.from(configuredSecret);
    if (providedBuf.length !== configuredBuf.length || !timingSafeEqual(providedBuf, configuredBuf)) {
      return c.json({ error: 'Invalid enrollment secret' }, 403);
    }
  }

  const hashedEnrollmentKey = hashEnrollmentKey(data.enrollmentKey);

  return withSystemDbAccessContext(async () => {
    // Atomically increment usageCount when the key is valid.
    // This prevents race conditions when maxUsage is low (e.g. one-time keys).
    const [key] = await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(
        and(
          eq(enrollmentKeys.key, hashedEnrollmentKey),
          sql`(${enrollmentKeys.expiresAt} IS NULL OR ${enrollmentKeys.expiresAt} > NOW())`,
          sql`(${enrollmentKeys.maxUsage} IS NULL OR ${enrollmentKeys.usageCount} < ${enrollmentKeys.maxUsage})`
        )
      )
      .returning();

    if (!key) {
      return c.json({ error: 'Invalid or expired enrollment key' }, 401);
    }

    const siteId = key.siteId;
    if (!siteId) {
      await db.update(enrollmentKeys).set({ usageCount: sql`${enrollmentKeys.usageCount} - 1` }).where(eq(enrollmentKeys.id, key.id));
      throw new HTTPException(400, { message: 'Enrollment key must be associated with a site' });
    }

    // Generate unique identifiers
    const agentId = generateAgentId();
    const apiKey = generateApiKey();
    // Agent bearer tokens are high-entropy random values; we store only a SHA-256 hash and never persist
    // the plaintext token.
    // lgtm[js/insufficient-password-hash]
    const tokenHash = createHash('sha256').update(apiKey).digest('hex');

    // Check for existing device with same hostname + org + site (re-enrollment)
    const [existingDevice] = await db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(
        and(
          eq(devices.hostname, data.hostname),
          eq(devices.orgId, key.orgId),
          eq(devices.siteId, siteId)
        )
      )
      .limit(1);

    if (existingDevice && existingDevice.status === 'decommissioned') {
      await db.update(enrollmentKeys).set({ usageCount: sql`${enrollmentKeys.usageCount} - 1` }).where(eq(enrollmentKeys.id, key.id));
      throw new HTTPException(403, { message: 'Device has been decommissioned. Contact an administrator.' });
    }

    // Wrap device creation + related writes in a transaction for consistency
    const device = await db.transaction(async (tx) => {
      let dev;
      if (existingDevice) {
        // Re-enrollment: update existing device with new credentials
        [dev] = await tx
          .update(devices)
          .set({
            agentId: agentId,
            agentTokenHash: tokenHash,
            osType: data.osType,
            osVersion: data.osVersion,
            architecture: data.architecture,
            agentVersion: data.agentVersion,
            status: 'online',
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(devices.id, existingDevice.id))
          .returning();
      } else {
        // New enrollment: create device record
        [dev] = await tx
          .insert(devices)
          .values({
            orgId: key.orgId,
            siteId: siteId,
            agentId: agentId,
            agentTokenHash: tokenHash,
            hostname: data.hostname,
            osType: data.osType,
            osVersion: data.osVersion,
            architecture: data.architecture,
            agentVersion: data.agentVersion,
            status: 'online',
            lastSeenAt: new Date(),
            tags: []
          })
          .returning();
      }

      if (!dev) {
        throw new Error('Failed to create device');
      }

      // Upsert hardware info if provided
      if (data.hardwareInfo) {
        await tx
          .insert(deviceHardware)
          .values({
            deviceId: dev.id,
            cpuModel: data.hardwareInfo.cpuModel,
            cpuCores: data.hardwareInfo.cpuCores,
            cpuThreads: data.hardwareInfo.cpuThreads,
            ramTotalMb: data.hardwareInfo.ramTotalMb,
            diskTotalGb: data.hardwareInfo.diskTotalGb,
            gpuModel: data.hardwareInfo.gpuModel,
            serialNumber: data.hardwareInfo.serialNumber,
            manufacturer: data.hardwareInfo.manufacturer,
            model: data.hardwareInfo.model,
            biosVersion: data.hardwareInfo.biosVersion
          })
          .onConflictDoUpdate({
            target: deviceHardware.deviceId,
            set: {
              cpuModel: data.hardwareInfo.cpuModel,
              cpuCores: data.hardwareInfo.cpuCores,
              cpuThreads: data.hardwareInfo.cpuThreads,
              ramTotalMb: data.hardwareInfo.ramTotalMb,
              diskTotalGb: data.hardwareInfo.diskTotalGb,
              gpuModel: data.hardwareInfo.gpuModel,
              serialNumber: data.hardwareInfo.serialNumber,
              manufacturer: data.hardwareInfo.manufacturer,
              model: data.hardwareInfo.model,
              biosVersion: data.hardwareInfo.biosVersion,
              updatedAt: new Date()
            }
          });
      }

      // Replace network interfaces if provided
      if (data.networkInfo && data.networkInfo.length > 0) {
        await tx.delete(deviceNetwork).where(eq(deviceNetwork.deviceId, dev.id));
        for (const nic of data.networkInfo) {
          await tx
            .insert(deviceNetwork)
            .values({
              deviceId: dev.id,
              interfaceName: nic.name,
              macAddress: nic.mac,
              ipAddress: nic.ip,
              ipType: nic.ip?.includes(':') ? 'ipv6' : 'ipv4',
              isPrimary: nic.isPrimary ?? false
            });
        }
      }

      return dev;
    });

    // Issue mTLS certificate if Cloudflare is configured (outside tx — external API call)
    const mtlsCert = await issueMtlsCertForDevice(device.id, key.orgId);

    writeAuditEvent(c, {
      orgId: key.orgId,
      actorType: 'agent',
      actorId: agentId,
      action: 'agent.enroll',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: data.hostname,
      details: {
        siteId: key.siteId,
        reenrollment: Boolean(existingDevice),
        mtlsCertIssued: mtlsCert !== null,
      },
    });

    return c.json({
      agentId: agentId,
      deviceId: device.id,
      authToken: apiKey,
      orgId: key.orgId,
      siteId: key.siteId,
      config: {
        heartbeatIntervalSeconds: 60,
        metricsCollectionIntervalSeconds: 30
      },
      mtls: mtlsCert
    }, 201);
  });
});

// Agent heartbeat
agentRoutes.post('/:id/heartbeat', zValidator('json', heartbeatSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  // Find device by agent ID
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Update device status and metrics
  await db
    .update(devices)
    .set({
      lastSeenAt: new Date(),
      status: 'online',
      agentVersion: data.agentVersion,
      updatedAt: new Date()
    })
    .where(eq(devices.id, device.id));

  // Store metrics
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

  // Get pending commands
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

  // Mark commands as sent
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

  // Check if mTLS cert needs renewal (past 2/3 of lifetime)
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

// Submit device security status
agentRoutes.put('/:id/security/status', zValidator('json', securityStatusIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await upsertSecurityStatusForDevice(device.id, payload);
  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.security_status.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      provider: payload.provider ?? null,
      threatCount: payload.threatCount ?? null,
    },
  });
  return c.json({ success: true });
});

// Submit command result
agentRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('json', commandResultSchema),
  async (c) => {
    const commandId = c.req.param('commandId');
    const data = c.req.valid('json');
    const agent = c.get('agent') as { orgId?: string; agentId?: string; deviceId?: string } | undefined;
    const agentId = c.req.param('id');

    if (!agent?.deviceId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.deviceId, agent.deviceId)
        )
      )
      .limit(1);

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    await db
      .update(deviceCommands)
      .set({
        status: data.status === 'completed' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          status: data.status,
          exitCode: data.exitCode,
          stdout: data.stdout,
          stderr: data.stderr,
          durationMs: data.durationMs,
          error: data.error
        }
      })
      .where(eq(deviceCommands.id, commandId));

    if (
      command.type === securityCommandTypes.collectStatus ||
      command.type === securityCommandTypes.scan ||
      command.type === securityCommandTypes.quarantine ||
      command.type === securityCommandTypes.remove ||
      command.type === securityCommandTypes.restore
    ) {
      try {
        await handleSecurityCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] security command post-processing failed for ${commandId}:`, err);
      }
    }

    if (command.type === filesystemAnalysisCommandType) {
      try {
        await handleFilesystemAnalysisCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] filesystem analysis post-processing failed for ${commandId}:`, err);
      }
    }

    writeAuditEvent(c, {
      orgId: agent?.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.command.result.submit',
      resourceType: 'device_command',
      resourceId: commandId,
      details: {
        commandType: command.type,
        status: data.status,
        exitCode: data.exitCode ?? null,
      },
      result: data.status === 'completed' ? 'success' : 'failure',
    });

    return c.json({ success: true });
  }
);

// Get agent config
agentRoutes.get('/:id/config', async (c) => {
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

// Update hardware info
const updateHardwareSchema = z.object({
  cpuModel: z.string().optional(),
  cpuCores: z.number().int().optional(),
  cpuThreads: z.number().int().optional(),
  ramTotalMb: z.number().int().optional(),
  diskTotalGb: z.number().int().optional(),
  serialNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  biosVersion: z.string().optional(),
  gpuModel: z.string().optional()
});

agentRoutes.put('/:id/hardware', zValidator('json', updateHardwareSchema), async (c) => {
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
    .insert(deviceHardware)
    .values({
      deviceId: device.id,
      ...data,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: deviceHardware.deviceId,
      set: {
        ...data,
        updatedAt: new Date()
      }
    });

  return c.json({ success: true });
});

// Update software inventory
const updateSoftwareSchema = z.object({
  software: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    vendor: z.string().optional(),
    installDate: z.string().optional(),
    installLocation: z.string().optional(),
    uninstallString: z.string().optional()
  }))
});

agentRoutes.put('/:id/software', zValidator('json', updateSoftwareSchema), async (c) => {
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

  // Use a transaction to replace all software entries atomically
  await db.transaction(async (tx) => {
    // Delete existing software entries for this device
    await tx
      .delete(softwareInventory)
      .where(eq(softwareInventory.deviceId, device.id));

    // Insert new software entries
    if (data.software.length > 0) {
      const now = new Date();
      await tx.insert(softwareInventory).values(
        data.software.map((item) => ({
          deviceId: device.id,
          name: item.name,
          version: item.version || null,
          vendor: item.vendor || null,
          installDate: item.installDate || null,
          installLocation: item.installLocation || null,
          uninstallString: item.uninstallString || null,
          lastSeen: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.software.length });
});

// Update disk drives inventory
const updateDisksSchema = z.object({
  disks: z.array(z.object({
    mountPoint: z.string().min(1),
    device: z.string().optional(),
    fsType: z.string().optional(),
    totalGb: z.number(),
    usedGb: z.number(),
    freeGb: z.number(),
    usedPercent: z.number(),
    health: z.string().optional()
  }))
});

agentRoutes.put('/:id/disks', zValidator('json', updateDisksSchema), async (c) => {
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

  // Use a transaction to replace all disk entries atomically
  await db.transaction(async (tx) => {
    // Delete existing disk entries for this device
    await tx
      .delete(deviceDisks)
      .where(eq(deviceDisks.deviceId, device.id));

    // Insert new disk entries
    if (data.disks.length > 0) {
      const now = new Date();
      await tx.insert(deviceDisks).values(
        data.disks.map((disk) => ({
          deviceId: device.id,
          mountPoint: disk.mountPoint,
          device: disk.device || null,
          fsType: disk.fsType || null,
          totalGb: disk.totalGb,
          usedGb: disk.usedGb,
          freeGb: disk.freeGb,
          usedPercent: disk.usedPercent,
          health: disk.health || 'healthy',
          updatedAt: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.disks.length });
});

const updateRegistryStateSchema = z.object({
  entries: z.array(z.object({
    registryPath: z.string().min(1),
    valueName: z.string().min(1),
    valueData: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    valueType: z.string().optional(),
    collectedAt: z.string().optional()
  })),
  replace: z.boolean().optional().default(true)
});

agentRoutes.put('/:id/registry-state', zValidator('json', updateRegistryStateSchema), async (c) => {
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

  await db.transaction(async (tx) => {
    if (data.replace) {
      await tx
        .delete(deviceRegistryState)
        .where(eq(deviceRegistryState.deviceId, device.id));
    }

    if (data.entries.length === 0) {
      return;
    }

    const now = new Date();
    await tx
      .insert(deviceRegistryState)
      .values(
        data.entries.map((entry) => ({
          deviceId: device.id,
          registryPath: entry.registryPath,
          valueName: entry.valueName,
          valueData: normalizeStateValue(entry.valueData),
          valueType: entry.valueType || null,
          collectedAt: parseDate(entry.collectedAt) ?? now,
          updatedAt: now
        }))
      )
      .onConflictDoUpdate({
        target: [
          deviceRegistryState.deviceId,
          deviceRegistryState.registryPath,
          deviceRegistryState.valueName
        ],
        set: {
          valueData: sql`excluded.value_data`,
          valueType: sql`excluded.value_type`,
          collectedAt: sql`excluded.collected_at`,
          updatedAt: now
        }
      });
  });

  return c.json({ success: true, count: data.entries.length });
});

const updateConfigStateSchema = z.object({
  entries: z.array(z.object({
    filePath: z.string().min(1),
    configKey: z.string().min(1),
    configValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    collectedAt: z.string().optional()
  })),
  replace: z.boolean().optional().default(true)
});

agentRoutes.put('/:id/config-state', zValidator('json', updateConfigStateSchema), async (c) => {
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

  await db.transaction(async (tx) => {
    if (data.replace) {
      await tx
        .delete(deviceConfigState)
        .where(eq(deviceConfigState.deviceId, device.id));
    }

    if (data.entries.length === 0) {
      return;
    }

    const now = new Date();
    await tx
      .insert(deviceConfigState)
      .values(
        data.entries.map((entry) => ({
          deviceId: device.id,
          filePath: entry.filePath,
          configKey: entry.configKey,
          configValue: normalizeStateValue(entry.configValue),
          collectedAt: parseDate(entry.collectedAt) ?? now,
          updatedAt: now
        }))
      )
      .onConflictDoUpdate({
        target: [
          deviceConfigState.deviceId,
          deviceConfigState.filePath,
          deviceConfigState.configKey
        ],
        set: {
          configValue: sql`excluded.config_value`,
          collectedAt: sql`excluded.collected_at`,
          updatedAt: now
        }
      });
  });

  return c.json({ success: true, count: data.entries.length });
});

// Update network adapters
const updateNetworkSchema = z.object({
  adapters: z.array(z.object({
    interfaceName: z.string().min(1),
    macAddress: z.string().optional(),
    ipAddress: z.string().optional(),
    ipType: z.enum(['ipv4', 'ipv6']).optional(),
    isPrimary: z.boolean().optional()
  }))
});

agentRoutes.put('/:id/network', zValidator('json', updateNetworkSchema), async (c) => {
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

  // Use a transaction to replace all network entries atomically
  await db.transaction(async (tx) => {
    // Delete existing network entries for this device
    await tx
      .delete(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, device.id));

    // Insert new network entries
    if (data.adapters.length > 0) {
      const now = new Date();
      await tx.insert(deviceNetwork).values(
        data.adapters.map((adapter) => ({
          deviceId: device.id,
          interfaceName: adapter.interfaceName,
          macAddress: adapter.macAddress || null,
          ipAddress: adapter.ipAddress || null,
          ipType: adapter.ipType || 'ipv4',
          isPrimary: adapter.isPrimary || false,
          updatedAt: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.adapters.length });
});

const sessionTypeSchema = z.enum(['console', 'rdp', 'ssh', 'other']);
const sessionActivityStateSchema = z.enum(['active', 'idle', 'locked', 'away', 'disconnected']);
const sessionEventTypeSchema = z.enum(['login', 'logout', 'lock', 'unlock', 'switch']);

const submitSessionsSchema = z.object({
  sessions: z.array(z.object({
    username: z.string().min(1).max(255),
    sessionType: sessionTypeSchema,
    sessionId: z.string().max(128).optional(),
    loginAt: z.string().optional(),
    idleMinutes: z.number().int().min(0).max(10080).optional(),
    activityState: sessionActivityStateSchema.optional(),
    loginPerformanceSeconds: z.number().int().min(0).max(36000).optional(),
    isActive: z.boolean().optional(),
    lastActivityAt: z.string().optional(),
  })).max(128).default([]),
  events: z.array(z.object({
    type: sessionEventTypeSchema,
    username: z.string().min(1).max(255),
    sessionType: sessionTypeSchema,
    sessionId: z.string().max(128).optional(),
    timestamp: z.string().optional(),
    activityState: sessionActivityStateSchema.optional(),
  })).max(256).optional(),
  collectedAt: z.string().optional(),
});

function getSessionIdentityKey(input: {
  username: string;
  sessionType: string;
  osSessionId: string | null;
}): string {
  return `${input.username.toLowerCase()}::${input.sessionType}::${input.osSessionId ?? ''}`;
}

agentRoutes.put('/:id/sessions', zValidator('json', submitSessionsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
    })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const now = new Date();
  const activeSessions = data.sessions.filter((session) => session.isActive !== false);

  await db.transaction(async (tx) => {
    const existingActive = await tx
      .select({
        id: deviceSessions.id,
        username: deviceSessions.username,
        sessionType: deviceSessions.sessionType,
        osSessionId: deviceSessions.osSessionId,
        loginAt: deviceSessions.loginAt,
      })
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.deviceId, device.id),
          eq(deviceSessions.isActive, true)
        )
      );

    const existingByKey = new Map(
      existingActive.map((row) => [
        getSessionIdentityKey({
          username: row.username,
          sessionType: row.sessionType,
          osSessionId: row.osSessionId ?? null,
        }),
        row,
      ])
    );
    const seenKeys = new Set<string>();

    for (const session of activeSessions) {
      const osSessionId = session.sessionId ?? null;
      const key = getSessionIdentityKey({
        username: session.username,
        sessionType: session.sessionType,
        osSessionId,
      });
      seenKeys.add(key);

      const loginAt = parseDate(session.loginAt) ?? now;
      const lastActivityAt = parseDate(session.lastActivityAt) ?? now;
      const existing = existingByKey.get(key);

      if (!existing) {
        await tx
          .insert(deviceSessions)
          .values({
            orgId: device.orgId,
            deviceId: device.id,
            username: session.username,
            sessionType: session.sessionType,
            osSessionId,
            loginAt,
            idleMinutes: session.idleMinutes ?? 0,
            activityState: session.activityState ?? 'active',
            loginPerformanceSeconds: session.loginPerformanceSeconds ?? null,
            isActive: true,
            lastActivityAt,
            updatedAt: now,
          });
        continue;
      }

      await tx
        .update(deviceSessions)
        .set({
          idleMinutes: session.idleMinutes ?? 0,
          activityState: session.activityState ?? 'active',
          loginPerformanceSeconds: session.loginPerformanceSeconds ?? null,
          isActive: true,
          lastActivityAt,
          updatedAt: now,
        })
        .where(eq(deviceSessions.id, existing.id));
    }

    for (const stale of existingActive) {
      const key = getSessionIdentityKey({
        username: stale.username,
        sessionType: stale.sessionType,
        osSessionId: stale.osSessionId ?? null,
      });
      if (seenKeys.has(key)) {
        continue;
      }

      const durationSeconds = Math.max(0, Math.floor((now.getTime() - stale.loginAt.getTime()) / 1000));
      await tx
        .update(deviceSessions)
        .set({
          isActive: false,
          logoutAt: now,
          durationSeconds,
          activityState: 'disconnected',
          updatedAt: now,
        })
        .where(eq(deviceSessions.id, stale.id));
    }
  });

  const events = data.events ?? [];
  for (const event of events) {
    if (event.type !== 'login' && event.type !== 'logout') {
      continue;
    }

    const eventType = event.type === 'login' ? 'session.login' : 'session.logout';
    try {
      await publishEvent(
        eventType,
        device.orgId,
        {
          deviceId: device.id,
          hostname: device.hostname,
          username: event.username,
          sessionType: event.sessionType,
          sessionId: event.sessionId ?? null,
          activityState: event.activityState ?? null,
          timestamp: event.timestamp ?? now.toISOString(),
        },
        'agent'
      );
    } catch (err) {
      console.error(`[agents] failed to publish ${eventType} for ${device.id}:`, err);
    }
  }

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.sessions.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      activeSessions: activeSessions.length,
      events: events.length,
    },
  });

  return c.json({
    success: true,
    activeSessions: activeSessions.length,
    events: events.length,
  });
});

// Submit available and installed patches
const submitPatchesSchema = z.object({
  patches: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    currentVersion: z.string().optional(),
    kbNumber: z.string().optional(),
    category: z.string().optional(),
    severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
    size: z.number().int().optional(),
    requiresRestart: z.boolean().optional(),
    releaseDate: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom')
  })),
  installed: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    category: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom'),
    installedAt: z.string().optional()
  })).optional()
});

agentRoutes.put('/:id/patches', zValidator('json', submitPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  const installedCount = data.installed?.length || 0;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.patches.length} pending, ${installedCount} installed`);

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.transaction(async (tx) => {
    // First, mark all existing patches for this device as "missing" (will update found ones)
    await tx
      .update(devicePatches)
      .set({ status: 'missing', lastCheckedAt: new Date() })
      .where(eq(devicePatches.deviceId, device.id));

    // Process pending patches
    for (const patchData of data.patches) {
      // Generate an external ID based on source + name + version
      const externalId = patchData.kbNumber ||
        `${patchData.source}:${patchData.name}:${patchData.version || 'latest'}`;
      const inferredOsType = inferPatchOsType(patchData.source, device.osType);

      // Upsert the patch record
      const [patch] = await tx
        .insert(patches)
        .values({
          source: patchData.source,
          externalId: externalId,
          title: patchData.name,
          description: patchData.description || null,
          severity: patchData.severity || 'unknown',
          category: patchData.category || null,
          releaseDate: patchData.releaseDate || null,
          requiresReboot: patchData.requiresRestart || false,
          downloadSizeMb: patchData.size ? Math.ceil(patchData.size / (1024 * 1024)) : null,
          ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
        })
        .onConflictDoUpdate({
          target: [patches.source, patches.externalId],
          set: {
            title: patchData.name,
            description: patchData.description || null,
            severity: patchData.severity || 'unknown',
            category: patchData.category || null,
            requiresReboot: patchData.requiresRestart || false,
            ...(inferredOsType
              ? {
                  osTypes: sql`CASE
                    WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                    THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                    ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                  END`
                }
              : {}),
            updatedAt: new Date()
          }
        })
        .returning();

      if (patch) {
        // Upsert the device-patch relationship as "pending" (available but not installed)
        await tx
          .insert(devicePatches)
          .values({
            deviceId: device.id,
            patchId: patch.id,
            status: 'pending',
            lastCheckedAt: new Date()
          })
          .onConflictDoUpdate({
            target: [devicePatches.deviceId, devicePatches.patchId],
            set: {
              status: 'pending',
              lastCheckedAt: new Date(),
              updatedAt: new Date()
            }
          });
      }
    }

    // Process installed patches
    if (data.installed && data.installed.length > 0) {
      for (const patchData of data.installed) {
        const externalId = `${patchData.source}:${patchData.name}:${patchData.version || 'installed'}`;
        const inferredOsType = inferPatchOsType(patchData.source, device.osType);

        // Upsert the patch record
        const [patch] = await tx
          .insert(patches)
          .values({
            source: patchData.source,
            externalId: externalId,
            title: patchData.name,
            severity: 'unknown',
            category: patchData.category || null,
            ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
          })
          .onConflictDoUpdate({
            target: [patches.source, patches.externalId],
            set: {
              title: patchData.name,
              category: patchData.category || null,
              ...(inferredOsType
                ? {
                    osTypes: sql`CASE
                      WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                      THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                      ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                    END`
                  }
                : {}),
              updatedAt: new Date()
            }
          })
          .returning();

        if (patch) {
          // Upsert the device-patch relationship as "installed"
          const installedAt = parseDate(patchData.installedAt);
          await tx
            .insert(devicePatches)
            .values({
              deviceId: device.id,
              patchId: patch.id,
              status: 'installed',
              installedAt: installedAt,
              installedVersion: patchData.version || null,
              lastCheckedAt: new Date()
            })
            .onConflictDoUpdate({
              target: [devicePatches.deviceId, devicePatches.patchId],
              set: {
                status: 'installed',
                installedAt: installedAt,
                installedVersion: patchData.version || null,
                lastCheckedAt: new Date(),
                updatedAt: new Date()
              }
            });
        }
      }
    }
  });

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      pendingCount: data.patches.length,
      installedCount,
    },
  });

  return c.json({ success: true, pending: data.patches.length, installed: installedCount });
});

// Submit network connections
const submitConnectionsSchema = z.object({
  connections: z.array(z.object({
    protocol: z.enum(['tcp', 'tcp6', 'udp', 'udp6']),
    localAddr: z.string().min(1),
    localPort: z.number().int().min(0).max(65535),
    remoteAddr: z.string().optional(),
    remotePort: z.number().int().min(0).max(65535).optional(),
    state: z.string().optional(),
    pid: z.number().int().optional(),
    processName: z.string().optional()
  }))
});

agentRoutes.put('/:id/connections', zValidator('json', submitConnectionsSchema), async (c) => {
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

  // Use a transaction to replace all connection entries atomically
  await db.transaction(async (tx) => {
    // Delete existing connection entries for this device
    await tx
      .delete(deviceConnections)
      .where(eq(deviceConnections.deviceId, device.id));

    // Insert new connection entries
    if (data.connections.length > 0) {
      const now = new Date();
      await tx.insert(deviceConnections).values(
        data.connections.map((conn) => ({
          deviceId: device.id,
          protocol: conn.protocol,
          localAddr: conn.localAddr,
          localPort: conn.localPort,
          remoteAddr: conn.remoteAddr || null,
          remotePort: conn.remotePort || null,
          state: conn.state || null,
          pid: conn.pid || null,
          processName: conn.processName || null,
          updatedAt: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.connections.length });
});

// Submit event logs
const submitEventLogsSchema = z.object({
  events: z.array(z.object({
    timestamp: z.string().min(1),
    level: z.enum(['info', 'warning', 'error', 'critical']),
    category: z.enum(['security', 'hardware', 'application', 'system']),
    source: z.string().min(1),
    eventId: z.string().optional(),
    message: z.string().min(1),
    details: z.record(z.any()).optional()
  }))
});

agentRoutes.put('/:id/eventlogs', zValidator('json', submitEventLogsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (data.events.length === 0) {
    return c.json({ success: true, count: 0 });
  }

  // Batch insert event logs with ON CONFLICT dedup
  const rows = data.events.map((event: any) => ({
    deviceId: device.id,
    orgId: device.orgId,
    timestamp: new Date(event.timestamp),
    level: event.level,
    category: event.category,
    source: event.source,
    eventId: event.eventId || null,
    message: event.message,
    details: event.details || null
  }));

  let inserted = 0;
  try {
    // Insert in batches of 100 to avoid oversized queries
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      await db.insert(deviceEventLogs).values(batch).onConflictDoNothing();
      inserted += batch.length;
    }
  } catch (err) {
    console.error(`[EventLogs] Error batch inserting events for device ${device.id}:`, err);
  }

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.eventlogs.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      submittedCount: data.events.length,
      insertedCount: inserted,
    },
  });

  return c.json({ success: true, count: inserted });
});

// ============================================
// mTLS Certificate Renewal
// ============================================

// POST /api/v1/agents/renew-cert
// Excluded from mTLS at WAF level (same as /enroll).
// Does inline bearer token validation (not middleware) so agents with expired certs can call it.
agentRoutes.post('/renew-cert', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (!token.startsWith('brz_')) {
    return c.json({ error: 'Invalid agent token format' }, 401);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(devices)
      .where(eq(devices.agentTokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  });

  if (!device) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  if (device.status === 'decommissioned') {
    return c.json({ error: 'Device has been decommissioned' }, 403);
  }

  if (device.status === 'quarantined') {
    return c.json({ error: 'Device quarantined', quarantined: true }, 403);
  }

  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) {
    return c.json({ error: 'mTLS not configured' }, 400);
  }

  // Check org policy for expired certs
  const mtlsSettings = await getOrgMtlsSettings(device.orgId);

  const certExpired = device.mtlsCertExpiresAt && device.mtlsCertExpiresAt.getTime() < Date.now();

  if (certExpired && mtlsSettings.expiredCertPolicy === 'quarantine') {
    await db
      .update(devices)
      .set({
        status: 'quarantined',
        quarantinedAt: new Date(),
        quarantinedReason: 'mtls_cert_expired',
        updatedAt: new Date(),
      })
      .where(eq(devices.id, device.id));

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.quarantined',
      resourceType: 'device',
      resourceId: device.id,
      details: { reason: 'mtls_cert_expired' },
    });

    return c.json({ error: 'Device quarantined', quarantined: true }, 403);
  }

  // Revoke old cert (best-effort)
  if (device.mtlsCertCfId) {
    try {
      await cfService.revokeCertificate(device.mtlsCertCfId);
    } catch (err) {
      console.warn('[agents] failed to revoke old mTLS cert, proceeding with renewal:', String(err));
    }
  }

  // Issue new cert — split into two try-catches so a DB failure
  // after successful issuance still returns the cert to the agent.
  let cert;
  try {
    cert = await cfService.issueCertificate(mtlsSettings.certLifetimeDays);
  } catch (err) {
    console.error('[agents] mTLS cert issuance failed:', String(err));
    const message = err instanceof Error && err.message.includes('rate limit')
      ? 'Certificate renewal failed: rate limited, retry later'
      : 'Certificate renewal failed';
    return c.json({ error: message }, 500);
  }

  // Persist cert metadata to DB (best-effort — cert is already issued)
  try {
    await db
      .update(devices)
      .set({
        mtlsCertSerialNumber: cert.serialNumber,
        mtlsCertExpiresAt: new Date(cert.expiresOn),
        mtlsCertIssuedAt: new Date(cert.issuedOn),
        mtlsCertCfId: cert.id,
        updatedAt: new Date(),
      })
      .where(eq(devices.id, device.id));

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renewed',
      resourceType: 'device',
      resourceId: device.id,
      details: { serialNumber: cert.serialNumber },
    });
  } catch (dbErr) {
    console.error('[agents] failed to persist renewed mTLS cert metadata to DB:', String(dbErr));
  }

  return c.json({
    mtls: {
      certificate: cert.certificate,
      privateKey: cert.privateKey,
      expiresAt: cert.expiresOn,
      serialNumber: cert.serialNumber,
    }
  });
});

// ============================================
// Admin Quarantine Management (user JWT auth)
// ============================================

// GET /api/v1/agents/quarantined — list quarantined devices in org
agentRoutes.get('/quarantined', authMiddleware, requirePermission('devices', 'read'), async (c) => {
  const auth = c.get('auth') as { orgId?: string; orgCondition?: (col: any) => any };

  const rows = await db
    .select({
      id: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      osType: devices.osType,
      quarantinedAt: devices.quarantinedAt,
      quarantinedReason: devices.quarantinedReason,
    })
    .from(devices)
    .where(
      and(
        eq(devices.status, 'quarantined'),
        auth.orgCondition ? auth.orgCondition(devices.orgId) : undefined
      )
    )
    .orderBy(desc(devices.quarantinedAt))
    .limit(100);

  return c.json({ devices: rows });
});

// POST /api/v1/agents/:id/approve — approve quarantined device
agentRoutes.post('/:id/approve', authMiddleware, requirePermission('devices', 'write'), async (c) => {
  const deviceId = c.req.param('id');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  // Issue new cert and set status to online
  const mtlsCert = await issueMtlsCertForDevice(device.id, device.orgId);

  await db
    .update(devices)
    .set({
      status: 'online',
      quarantinedAt: null,
      quarantinedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.approve',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
    details: { mtlsCertIssued: mtlsCert !== null },
  });

  return c.json({
    success: true,
    mtls: mtlsCert,
  });
});

// POST /api/v1/agents/:id/deny — deny quarantined device
agentRoutes.post('/:id/deny', authMiddleware, requirePermission('devices', 'write'), async (c) => {
  const deviceId = c.req.param('id');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  await db
    .update(devices)
    .set({
      status: 'decommissioned',
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.deny',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
  });

  return c.json({ success: true });
});

// ============================================
// Org mTLS Settings (user JWT auth)
// ============================================

// PATCH /api/v1/agents/org/:orgId/settings/mtls — update mTLS settings for an org
agentRoutes.patch(
  '/org/:orgId/settings/mtls',
  authMiddleware,
  requirePermission('orgs', 'write'),
  zValidator('json', orgMtlsSettingsSchema),
  async (c) => {
    const orgId = c.req.param('orgId');
    const data = c.req.valid('json');
    const auth = c.get('auth') as { user?: { id: string }; canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const currentSettings = isObject(org.settings) ? org.settings : {};
    const updatedSettings = {
      ...currentSettings,
      mtls: {
        certLifetimeDays: data.certLifetimeDays,
        expiredCertPolicy: data.expiredCertPolicy,
      },
    };

    await db
      .update(organizations)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));

    writeAuditEvent(c, {
      orgId,
      actorType: 'user',
      actorId: auth.user?.id ?? 'unknown',
      action: 'admin.org.mtls_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: data,
    });

    return c.json({ success: true, settings: updatedSettings.mtls });
  }
);
