import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db } from '../../db';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import {
  devices,
  deviceCommands,
  deviceDisks,
  deviceFilesystemSnapshots,
  automationPolicies,
  securityStatus,
  securityThreats,
  securityScans,
  organizations,
} from '../../db/schema';
import { queueCommandForExecution } from '../../services/commandQueue';
import {
  getFilesystemScanState,
  mergeFilesystemAnalysisPayload,
  parseFilesystemAnalysisStdout,
  readCheckpointPendingDirectories,
  readHotDirectories,
  saveFilesystemSnapshot,
  upsertFilesystemScanState,
} from '../../services/filesystemAnalysis';
import { CloudflareMtlsService } from '../../services/cloudflareMtls';
import {
  type SecurityProviderValue,
  type SecurityStatusPayload,
  type PolicyRegistryProbeUpdate,
  type PolicyConfigProbeUpdate,
  type PolicyProbeConfigUpdate,
  commandResultSchema,
  securityStatusIngestSchema,
  securityCommandTypes,
  filesystemAnalysisCommandType,
  filesystemDiskThresholdPercent,
  filesystemThresholdCooldownMinutes,
  filesystemAutoResumeMaxRuns,
  uuidRegex,
} from './schemas';

// Re-export for convenience — route files import as AgentContext
export type AgentContext = AgentAuthContext;

// ============================================
// Generic Utilities
// ============================================

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

export function asInt(value: unknown, defaultValue = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return defaultValue;
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeStateValue(value: unknown): string | null {
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

export function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidRegex.test(value);
}

export function parseResultJson(stdout: string | undefined): Record<string, unknown> | undefined {
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    console.warn('[agents] Failed to parse command result JSON:', stdout?.slice(0, 500));
    return undefined;
  }
}

// ============================================
// Normalization
// ============================================

export function normalizeAgentArchitecture(architecture: string | null | undefined): 'amd64' | 'arm64' | null {
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

export function normalizeProvider(raw: unknown): SecurityProviderValue {
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

export function normalizeEncryptionStatus(raw: unknown): string | null {
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

export function normalizeSeverity(raw: unknown): 'low' | 'medium' | 'high' | 'critical' {
  if (typeof raw !== 'string') return 'medium';
  const value = raw.trim().toLowerCase();
  if (value === 'critical') return 'critical';
  if (value === 'high') return 'high';
  if (value === 'low') return 'low';
  return 'medium';
}

export function normalizeKnownOsType(raw: unknown): 'windows' | 'macos' | 'linux' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'windows' || value === 'macos' || value === 'linux') {
    return value;
  }
  return null;
}

export function inferPatchOsType(source: string, deviceOs: unknown): 'windows' | 'macos' | 'linux' | null {
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

// ============================================
// Version Comparison
// ============================================

export function parseComparableVersion(raw: string): { core: number[]; prerelease: string | null } | null {
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

export function compareAgentVersions(leftRaw: string, rightRaw: string): number {
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

// ============================================
// Policy Probe Processing
// ============================================

export function sortPolicyRegistryProbes(probes: PolicyRegistryProbeUpdate[]): PolicyRegistryProbeUpdate[] {
  return [...probes].sort((left, right) => {
    const pathCompare = left.registry_path.localeCompare(right.registry_path);
    if (pathCompare !== 0) return pathCompare;
    return left.value_name.localeCompare(right.value_name);
  });
}

export function sortPolicyConfigProbes(probes: PolicyConfigProbeUpdate[]): PolicyConfigProbeUpdate[] {
  return [...probes].sort((left, right) => {
    const pathCompare = left.file_path.localeCompare(right.file_path);
    if (pathCompare !== 0) return pathCompare;
    return left.config_key.localeCompare(right.config_key);
  });
}

export function derivePolicyStateProbesFromRules(rules: unknown): {
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

export async function buildPolicyProbeConfigUpdate(orgId: string | null | undefined): Promise<PolicyProbeConfigUpdate | null> {
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

// ============================================
// Security Operations
// ============================================

export function getSecurityStatusFromResult(resultData: Record<string, unknown> | undefined): SecurityStatusPayload | undefined {
  if (!resultData) return undefined;

  const nested = isObject(resultData.status) ? resultData.status : undefined;
  const candidate = nested ?? resultData;
  const parsed = securityStatusIngestSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data;
}

export async function upsertSecurityStatusForDevice(deviceId: string, payload: SecurityStatusPayload): Promise<void> {
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

export async function handleSecurityCommandResult(
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

// ============================================
// Filesystem Analysis
// ============================================

export function getFilesystemThresholdScanPath(osType: unknown): string {
  if (osType === 'windows') return 'C:\\';
  return '/';
}

export async function maybeQueueThresholdFilesystemAnalysis(
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

export async function handleFilesystemAnalysisCommandResult(
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

export function extractHotDirectoriesFromSnapshotPayload(payload: Record<string, unknown>, limit: number): string[] {
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

// ============================================
// Enrollment / Auth
// ============================================

export function generateAgentId(): string {
  return randomBytes(32).toString('hex');
}

export function generateApiKey(): string {
  return `brz_${randomBytes(32).toString('hex')}`;
}

// ============================================
// mTLS
// ============================================

export async function getOrgHelperSettings(orgId: string): Promise<{ enabled: boolean }> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const settings = isObject(org?.settings) ? org.settings : {};
  const helper = isObject(settings.helper) ? settings.helper : {};
  const enabled = typeof helper.enabled === 'boolean' ? helper.enabled : false;
  return { enabled };
}

export async function getOrgMtlsSettings(orgId: string): Promise<{ certLifetimeDays: number; expiredCertPolicy: 'auto_reissue' | 'quarantine' }> {
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

export async function issueMtlsCertForDevice(deviceId: string, orgId: string): Promise<{
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
  }

  return {
    certificate: cert.certificate,
    privateKey: cert.privateKey,
    expiresAt: cert.expiresOn,
    serialNumber: cert.serialNumber,
  };
}
