import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db } from '../../db';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import {
  devices,
  deviceCommands,
  deviceDisks,
  deviceFilesystemSnapshots,
  automationPolicies,
  cisBaselines,
  cisBaselineResults,
  cisRemediationActions,
  softwareComplianceStatus,
  softwarePolicies,
  securityStatus,
  securityThreats,
  securityScans,
  sensitiveDataFindings,
  sensitiveDataScans,
  organizations,
  partners,
  deviceGroupMemberships,
  configPolicyAssignments,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyEventLogSettings,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  configPolicyOnedriveSettings,
  configPolicyOnedriveLibraries,
  onedriveDeviceState,
  pamOrgConfig,
  agentVersions,
} from '../../db/schema';
import { getRedis } from '../../services/redis';
import { publishEvent } from '../../services/eventBus';
import { scheduleSoftwareComplianceCheck } from '../../jobs/softwareComplianceWorker';
import {
  recordSensitiveDataFinding,
  recordSensitiveDataRemediationDecision,
  recordSoftwareRemediationDecision
} from '../metrics';
import { queueCommandForExecution } from '../../services/commandQueue';
import { parseCisCollectorOutput } from '../../services/cisHardening';
import {
  getFilesystemScanState,
  mergeFilesystemAnalysisPayload,
  parseFilesystemAnalysisStdout,
  readCheckpointPendingDirectories,
  readHotDirectories,
  saveFilesystemSnapshot,
  upsertFilesystemScanState,
} from '../../services/filesystemAnalysis';
import { recordSoftwarePolicyAudit } from '../../services/softwarePolicyService';
import { resolvePatchConfigForDevice } from '../../services/featureConfigResolver';
import { resolveUserGroupMembershipCached } from '../../services/onedriveGraph';
import { captureException } from '../../services/sentry';
import { redactSecretsDeep, redactOptionalSecretText } from '../../services/secretRedaction';
import { CloudflareMtlsService } from '../../services/cloudflareMtls';
import { isAllowedPolicyConfigProbe } from './policyProbeSafety';
import { PAM_DEFAULTS, parsePamSettings, type PamSettings } from './pamSettings';
import {
  normalizeAgentUpdatePolicy,
  type AgentUpdateSettings,
} from './agentUpdatePolicy';
import { isAlwaysMaintenanceWindow, parseMaintenanceWindow, normalizeVersionPin } from '@breeze/shared';
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
  sensitiveDataCommandTypes,
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

/**
 * Validates a string is a valid ISO 8601 date (YYYY-MM-DD) suitable for a
 * PostgreSQL `date` column.  Returns the date string or null.
 */
export function sanitizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const d = new Date(trimmed + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : trimmed;
}

/**
 * Strict timestamp parser that requires ISO 8601 / RFC 3339 format before
 * accepting — rejects ambiguous locale-dependent strings that `new Date()`
 * might parse inconsistently across JS engines.
 * Returns a Date or null (never throws).
 */
export function sanitizeTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  // Must start with an ISO date prefix to rule out locale strings
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
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
    case 'elastic_defend':
    case 'elastic_endpoint':
    case 'elastic_agent':
    case 'elastic':
      return 'elastic_defend';
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
      if (!filePath || !configKey || !isAllowedPolicyConfigProbe(filePath, configKey)) {
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

  // Dual-ownership (#2129): the device's probe list must also cover
  // partner-wide compliance policies (org_id NULL) owned by this org's
  // partner — the evaluation worker fans those out to this device, so the
  // agent has to collect their registry/config state too.
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const ownershipCondition = org?.partnerId
    ? or(
        eq(automationPolicies.orgId, orgId),
        and(isNull(automationPolicies.orgId), eq(automationPolicies.partnerId, org.partnerId))
      )
    : eq(automationPolicies.orgId, orgId);

  const policyRows = await db
    .select({ rules: automationPolicies.rules })
    .from(automationPolicies)
    .where(
      and(
        ownershipCondition,
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

export async function upsertSecurityStatusForDevice(deviceId: string, orgId: string, payload: SecurityStatusPayload): Promise<void> {
  const avProducts = Array.isArray(payload.avProducts) ? payload.avProducts : [];
  const preferredProduct = avProducts.find((p) => p.realTimeProtection) ?? avProducts[0];
  const provider = normalizeProvider(payload.provider ?? preferredProduct?.provider);

  await db
    .insert(securityStatus)
    .values({
      deviceId,
      orgId,
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
  const [deviceRow] = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, command.deviceId))
    .limit(1);
  const orgId = deviceRow?.orgId;
  if (!orgId) return;

  const resultJson = parseResultJson(resultData.stdout);
  const parsedStatus = getSecurityStatusFromResult(resultJson);
  if (parsedStatus) {
    await upsertSecurityStatusForDevice(command.deviceId, orgId, parsedStatus);
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
    const durationSeconds = Math.max(0, Math.round((resultData.durationMs ?? 0) / 1000));

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
        orgId,
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
          orgId,
          provider,
          threatName: asString(threat.name) ?? asString(threat.threatName) ?? 'Unknown Threat',
          threatType: asString(threat.type) ?? asString(threat.threatType) ?? asString(threat.category) ?? null,
          severity: normalizeSeverity(threat.severity),
          status: 'detected',
          filePath: asString(threat.path) ?? asString(threat.filePath) ?? null,
          processName: asString(threat.processName) ?? null,
          detectedAt: completedAt,
          // #2434: `threat` is the raw agent/AV threat object parsed out of
          // stdout (stdout is deliberately NOT redacted at the ingest
          // chokepoint). AV records routinely embed the offending command line
          // or script fragment, so redact every string in the blob.
          details: redactSecretsDeep(threat)
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
// Sensitive Data Discovery
// ============================================

const sensitiveDataTypeValues = new Set(['pii', 'pci', 'phi', 'credential', 'financial']);
const sensitiveDataRiskValues = new Set(['low', 'medium', 'high', 'critical']);

function normalizeSensitiveDataType(value: unknown): 'pii' | 'pci' | 'phi' | 'credential' | 'financial' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!sensitiveDataTypeValues.has(normalized)) return null;
  return normalized as 'pii' | 'pci' | 'phi' | 'credential' | 'financial';
}

function normalizeSensitiveRisk(value: unknown, dataType: string): 'low' | 'medium' | 'high' | 'critical' {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (sensitiveDataRiskValues.has(normalized)) {
      return normalized as 'low' | 'medium' | 'high' | 'critical';
    }
  }

  if (dataType === 'credential' || dataType === 'pci') return 'critical';
  if (dataType === 'phi' || dataType === 'financial') return 'high';
  if (dataType === 'pii') return 'medium';
  return 'low';
}

function normalizeSensitiveConfidence(value: unknown, dataType: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  switch (dataType) {
    case 'credential':
      return 0.95;
    case 'pci':
      return 0.9;
    case 'phi':
      return 0.8;
    case 'financial':
      return 0.78;
    case 'pii':
      return 0.72;
    default:
      return 0.5;
  }
}

function mapRemediationActionFromCommandType(commandType: string): 'encrypt' | 'secure_delete' | 'quarantine' | null {
  if (commandType === sensitiveDataCommandTypes.encrypt) return 'encrypt';
  if (commandType === sensitiveDataCommandTypes.secureDelete) return 'secure_delete';
  if (commandType === sensitiveDataCommandTypes.quarantine) return 'quarantine';
  return null;
}

export async function handleSensitiveDataCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  if (
    command.type !== sensitiveDataCommandTypes.scan
    && command.type !== sensitiveDataCommandTypes.encrypt
    && command.type !== sensitiveDataCommandTypes.secureDelete
    && command.type !== sensitiveDataCommandTypes.quarantine
  ) {
    return;
  }

  const payload = isObject(command.payload) ? command.payload : {};
  const resultJson = parseResultJson(resultData.stdout);
  const now = new Date();

  if (command.type === sensitiveDataCommandTypes.scan) {
    const scanId = asString(resultJson?.scanId) ?? asString(payload.scanId);
    if (!isUuid(scanId)) {
      return;
    }

    const [scan] = await db
      .select({
        id: sensitiveDataScans.id,
        orgId: sensitiveDataScans.orgId,
        deviceId: sensitiveDataScans.deviceId,
        summary: sensitiveDataScans.summary
      })
      .from(sensitiveDataScans)
      .where(and(eq(sensitiveDataScans.id, scanId), eq(sensitiveDataScans.deviceId, command.deviceId)))
      .limit(1);

    if (!scan) {
      return;
    }

    const existingSummary = isObject(scan.summary) ? scan.summary : {};
    const scanSummary = isObject(resultJson?.summary) ? resultJson.summary : {};
    const findingsRaw = Array.isArray(resultJson?.findings) ? resultJson.findings : [];

    const normalizedFindings: Array<{
      filePath: string;
      dataType: 'pii' | 'pci' | 'phi' | 'credential' | 'financial';
      patternId: string;
      matchCount: number;
      risk: 'low' | 'medium' | 'high' | 'critical';
      confidence: number;
      fileOwner: string | null;
      fileModifiedAt: Date | null;
    }> = [];
    for (const rawFinding of findingsRaw) {
      if (!isObject(rawFinding)) continue;
      const filePath = readTrimmedString(rawFinding.filePath);
      const dataType = normalizeSensitiveDataType(rawFinding.dataType);
      if (!filePath || !dataType) continue;

      const patternId = readTrimmedString(rawFinding.patternId) ?? 'unknown';
      const matchCount = Math.max(1, asInt(rawFinding.matchCount, 1));
      const risk = normalizeSensitiveRisk(rawFinding.risk, dataType);
      const confidence = normalizeSensitiveConfidence(rawFinding.confidence, dataType);
      normalizedFindings.push({
        filePath,
        dataType,
        patternId,
        matchCount,
        risk,
        confidence,
        fileOwner: readTrimmedString(rawFinding.fileOwner),
        fileModifiedAt: parseDate(rawFinding.fileModifiedAt),
      });
    }

    const dedupedFindings = Array.from(
      new Map(
        normalizedFindings.map((finding) => [
          `${finding.filePath}::${finding.dataType}::${finding.patternId}`,
          finding
        ])
      ).values()
    );

    const byRisk: Record<string, number> = {};
    const byStatus: Record<string, number> = { open: dedupedFindings.length };
    for (const finding of dedupedFindings) {
      byRisk[finding.risk] = (byRisk[finding.risk] ?? 0) + 1;
    }

    await db
      .update(sensitiveDataScans)
      .set({
        status: resultData.status === 'completed' ? 'completed' : 'failed',
        completedAt: now,
        summary: {
          ...existingSummary,
          commandId: command.id,
          commandStatus: resultData.status,
          // #2434: agent-supplied summary blob parsed from raw stdout.
          agentSummary: redactSecretsDeep(scanSummary),
          findingsCount: dedupedFindings.length,
          findings: {
            total: dedupedFindings.length,
            byRisk,
            byStatus,
          },
          completedAt: now.toISOString(),
        }
      })
      .where(eq(sensitiveDataScans.id, scan.id));

    if (resultData.status !== 'completed') {
      return;
    }

    for (const finding of dedupedFindings) {
      const [existingOpen] = await db
        .select({
          id: sensitiveDataFindings.id,
          occurrenceCount: sensitiveDataFindings.occurrenceCount,
        })
        .from(sensitiveDataFindings)
        .where(and(
          eq(sensitiveDataFindings.orgId, scan.orgId),
          eq(sensitiveDataFindings.deviceId, scan.deviceId),
          eq(sensitiveDataFindings.filePath, finding.filePath),
          eq(sensitiveDataFindings.dataType, finding.dataType),
          eq(sensitiveDataFindings.patternId, finding.patternId),
          eq(sensitiveDataFindings.status, 'open')
        ))
        .limit(1);

      if (existingOpen) {
        await db
          .update(sensitiveDataFindings)
          .set({
            matchCount: finding.matchCount,
            risk: finding.risk,
            confidence: finding.confidence,
            fileOwner: finding.fileOwner,
            fileModifiedAt: finding.fileModifiedAt,
            lastSeenAt: now,
            occurrenceCount: (existingOpen.occurrenceCount ?? 1) + 1,
          })
          .where(eq(sensitiveDataFindings.id, existingOpen.id));
        continue;
      }

      await db.insert(sensitiveDataFindings).values({
        orgId: scan.orgId,
        deviceId: scan.deviceId,
        scanId: scan.id,
        filePath: finding.filePath,
        dataType: finding.dataType,
        patternId: finding.patternId,
        matchCount: finding.matchCount,
        risk: finding.risk,
        confidence: finding.confidence,
        fileOwner: finding.fileOwner,
        fileModifiedAt: finding.fileModifiedAt,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        status: 'open'
      });
    }

    const credentialFindings = dedupedFindings.filter((finding) => finding.dataType === 'credential');
    if (dedupedFindings.length > 0) {
      const findingMetricCounts = new Map<string, number>();
      for (const finding of dedupedFindings) {
        const key = `${finding.dataType}::${finding.risk}`;
        findingMetricCounts.set(key, (findingMetricCounts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of findingMetricCounts.entries()) {
        const [dataType, risk] = key.split('::');
        recordSensitiveDataFinding(dataType ?? 'unknown', risk ?? 'unknown', count);
      }

      await publishEvent(
        'compliance.sensitive_data_found',
        scan.orgId,
        {
          deviceId: scan.deviceId,
          scanId: scan.id,
          findingCount: dedupedFindings.length,
          criticalCount: dedupedFindings.filter((finding) => finding.risk === 'critical').length,
        },
        'agents.command.result'
      );
    }

    if (credentialFindings.length > 0) {
      await publishEvent(
        'compliance.credential_exposed',
        scan.orgId,
        {
          deviceId: scan.deviceId,
          scanId: scan.id,
          findingCount: credentialFindings.length,
          criticalCount: credentialFindings.filter((finding) => finding.risk === 'critical').length,
        },
        'agents.command.result'
      );
    }
    return;
  }

  const findingId = asString(payload.findingId);
  const action = mapRemediationActionFromCommandType(command.type);
  if (!isUuid(findingId) || !action) {
    return;
  }

  const [finding] = await db
    .select({
      id: sensitiveDataFindings.id,
      orgId: sensitiveDataFindings.orgId,
      deviceId: sensitiveDataFindings.deviceId,
      scanId: sensitiveDataFindings.scanId
    })
    .from(sensitiveDataFindings)
    .where(and(
      eq(sensitiveDataFindings.id, findingId),
      eq(sensitiveDataFindings.deviceId, command.deviceId)
    ))
    .limit(1);

  if (!finding) {
    return;
  }

  await db
    .update(sensitiveDataFindings)
    .set({
      remediationAction: action,
      status: resultData.status === 'completed' ? 'remediated' : 'open',
      remediatedAt: resultData.status === 'completed' ? now : null,
      remediationMetadata: {
        commandId: command.id,
        commandStatus: resultData.status,
        completedAt: now.toISOString(),
        keyRef: readTrimmedString(payload.encryptionKeyRef),
        keyVersion: readTrimmedString(payload.encryptionKeyVersion),
        provider: readTrimmedString(payload.encryptionProvider),
      }
    })
    .where(eq(sensitiveDataFindings.id, finding.id));

  if (resultData.status === 'completed') {
    recordSensitiveDataRemediationDecision(`${action}_completed`, 1);
    await publishEvent(
      'compliance.sensitive_data_remediated',
      finding.orgId,
      {
        findingId: finding.id,
        scanId: finding.scanId,
        deviceId: finding.deviceId,
        action,
        remediatedAt: now.toISOString(),
      },
      'agents.command.result'
    );
  } else {
    recordSensitiveDataRemediationDecision(`${action}_failed`, 1);
  }
}

// ============================================
// Software Remediation
// ============================================

const softwareUninstallCommandType = 'software_uninstall';
const cisBenchmarkCommandType = 'cis_benchmark';
const cisRemediationCommandType = 'apply_cis_remediation';

export async function handleSoftwareRemediationCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  if (command.type !== softwareUninstallCommandType) {
    return;
  }

  const payload = isObject(command.payload) ? command.payload : {};
  const policyId = readTrimmedString(payload.policyId);
  if (!policyId || !isUuid(policyId)) {
    console.warn(
      `[agents/helpers] software_uninstall command ${command.id} for device ${command.deviceId} ` +
      `has missing or invalid policyId — cannot update compliance status`
    );
    return;
  }

  const softwareName = readTrimmedString(payload.name) ?? 'unknown';
  const softwareVersion = readTrimmedString(payload.version);
  const [policy] = await db
    .select({
      id: softwarePolicies.id,
      orgId: softwarePolicies.orgId,
      name: softwarePolicies.name,
    })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.id, policyId))
    .limit(1);

  if (!policy) {
    return;
  }

  const [compliance] = await db
    .select({
      id: softwareComplianceStatus.id,
      remediationErrors: softwareComplianceStatus.remediationErrors,
    })
    .from(softwareComplianceStatus)
    .where(and(
      eq(softwareComplianceStatus.policyId, policyId),
      eq(softwareComplianceStatus.deviceId, command.deviceId),
    ))
    .limit(1);

  if (!compliance) {
    return;
  }

  if (resultData.status !== 'completed') {
    const existingErrors = Array.isArray(compliance.remediationErrors)
      ? compliance.remediationErrors
      : [];
    const entry = {
      commandId: command.id,
      softwareName,
      softwareVersion: softwareVersion ?? null,
      // #2434: self-redact rather than depend on the ingest chokepoint two
      // modules away (idempotent — already-redacted text passes through).
      message: redactOptionalSecretText(resultData.error)
        ?? redactOptionalSecretText(resultData.stderr)
        ?? 'Uninstall command failed',
      status: resultData.status,
      exitCode: resultData.exitCode ?? null,
      failedAt: new Date().toISOString(),
    };
    const nextErrors = [...existingErrors, entry].slice(-25);

    await db
      .update(softwareComplianceStatus)
      .set({
        remediationStatus: 'failed',
        lastRemediationAttempt: new Date(),
        remediationErrors: nextErrors,
      })
      .where(eq(softwareComplianceStatus.id, compliance.id));

    recordSoftwarePolicyAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      deviceId: command.deviceId,
      action: 'remediation_command_failed',
      actor: 'system',
      details: {
        commandId: command.id,
        policyName: policy.name,
        softwareName,
        softwareVersion: softwareVersion ?? null,
        commandStatus: resultData.status,
        exitCode: resultData.exitCode ?? null,
        // #2434: self-redact (see above) — this lands in audit_logs.details.
        error: redactOptionalSecretText(resultData.error) ?? null,
      },
    }).catch((err) => {
      console.error('[agents/helpers] Audit write failed for remediation_command_failed:', err);
    });
    recordSoftwareRemediationDecision('command_result_failed');
    return;
  }

  await db
    .update(softwareComplianceStatus)
    .set({
      // Mark the current remediation attempt as completed and trigger a verification scan.
      // If violations remain after verification, the next evaluation can queue remediation again.
      remediationStatus: 'completed',
      lastRemediationAttempt: new Date(),
      remediationErrors: null,
    })
    .where(eq(softwareComplianceStatus.id, compliance.id));

  let verificationJobId: string | undefined;
  try {
    verificationJobId = await scheduleSoftwareComplianceCheck(policy.id, [command.deviceId]);
  } catch (err) {
    console.error('[agents/helpers] Failed to schedule verification scan after remediation:', err);
  }

  recordSoftwarePolicyAudit({
    orgId: policy.orgId,
    policyId: policy.id,
    deviceId: command.deviceId,
    action: 'software_uninstalled',
    actor: 'system',
    details: {
      commandId: command.id,
      policyName: policy.name,
      softwareName,
      softwareVersion: softwareVersion ?? null,
      verificationJobId: verificationJobId ?? 'schedule_failed',
    },
  }).catch((err) => {
    console.error('[agents/helpers] Audit write failed for software_uninstalled:', err);
  });
  recordSoftwareRemediationDecision('command_result_completed');
}

export async function handleCisCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  if (command.type !== cisBenchmarkCommandType && command.type !== cisRemediationCommandType) {
    return;
  }

  const payload = isObject(command.payload) ? command.payload : {};

  if (command.type === cisBenchmarkCommandType) {
    const baselineId = readTrimmedString(payload.baselineId);
    if (!baselineId || !isUuid(baselineId)) {
      console.warn(`[agents/helpers] cis_benchmark command ${command.id} missing valid baselineId`);
      return;
    }

    const [baseline] = await db
      .select({
        id: cisBaselines.id,
        orgId: cisBaselines.orgId,
        name: cisBaselines.name,
      })
      .from(cisBaselines)
      .where(eq(cisBaselines.id, baselineId))
      .limit(1);

    if (!baseline) {
      console.warn(`[agents/helpers] cis_benchmark command ${command.id}: baseline ${baselineId} not found`);
      return;
    }

    // Defense-in-depth: verify baseline org matches device org
    const [deviceRow] = await db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, command.deviceId))
      .limit(1);
    if (!deviceRow || deviceRow.orgId !== baseline.orgId) {
      console.warn(
        `[agents/helpers] cis_benchmark command ${command.id}: org mismatch baseline.orgId=${baseline.orgId} device.orgId=${deviceRow?.orgId}`,
      );
      return;
    }

    // Idempotency guard: prevent duplicate result rows if the agent delivers the same command result more than once
    const [existingForCommand] = await db
      .select({ id: cisBaselineResults.id })
      .from(cisBaselineResults)
      .where(and(
        eq(cisBaselineResults.baselineId, baseline.id),
        eq(cisBaselineResults.deviceId, command.deviceId),
        sql`${cisBaselineResults.summary} ->> 'commandId' = ${command.id}`,
      ))
      .limit(1);

    if (existingForCommand) {
      console.debug(`[agents/helpers] cis_benchmark command ${command.id}: duplicate result skipped (idempotency)`);
      return;
    }

    const [previousResult] = await db
      .select({
        score: cisBaselineResults.score,
      })
      .from(cisBaselineResults)
      .where(and(
        eq(cisBaselineResults.baselineId, baseline.id),
        eq(cisBaselineResults.deviceId, command.deviceId),
      ))
      .orderBy(desc(cisBaselineResults.checkedAt))
      .limit(1);

    // #2434: the success path parses findings out of RAW stdout (stdout is not
    // redacted at the ingest chokepoint), and each finding carries free-text
    // `message` / `evidence` / `remediation` produced by the collector — a
    // failing check's evidence can quote the very config value (connection
    // string, service-account password) that made it fail.
    //
    // Redact only the JSON-safe sub-parts. Do NOT hand the whole object to
    // redactSecretsDeep: `checkedAt` is a Date, and a generic object walk
    // would rebuild it as `{}` (Object.entries(new Date()) === []), which
    // makes Drizzle's timestamp mapper throw on insert — a throw the caller
    // swallows, so successful scans would silently stop persisting while
    // failed ones (which rebuild checkedAt below) kept working.
    const collected = parseCisCollectorOutput(resultData.stdout);
    let parsed: ReturnType<typeof parseCisCollectorOutput> = {
      ...collected,
      findings: redactSecretsDeep(collected.findings) as typeof collected.findings,
      rawSummary: redactSecretsDeep(collected.rawSummary) as typeof collected.rawSummary,
    };
    if (resultData.status !== 'completed') {
      // #2434: error/stderr arrive already-redacted from the ingest chokepoint,
      // but redact again here rather than depending on a caller two modules
      // away — this handler is reachable from both ingest legs and the
      // failure branch writes agent text straight into a user-visible finding.
      // Every sibling persistence service (backup/restore/vault) self-redacts
      // for the same reason; redaction is idempotent, so this is free.
      const failureError = redactOptionalSecretText(resultData.error);
      const failureStderr = redactOptionalSecretText(resultData.stderr);
      parsed = {
        checkedAt: new Date(),
        findings: [{
          checkId: 'collector.runtime',
          title: 'CIS collector execution',
          severity: 'high',
          status: 'fail',
          message: failureError ?? failureStderr ?? 'CIS collector execution failed',
          evidence: null,
          remediation: null,
        }],
        totalChecks: 1,
        passedChecks: 0,
        failedChecks: 1,
        score: 0,
        rawSummary: {
          error: failureError ?? null,
          stderr: failureStderr ?? null,
          status: resultData.status,
        },
      };
    }

    const summary = {
      ...(parsed.rawSummary ?? {}),
      commandId: command.id,
      commandStatus: resultData.status,
    };

    const [inserted] = await db
      .insert(cisBaselineResults)
      .values({
        orgId: baseline.orgId,
        deviceId: command.deviceId,
        baselineId: baseline.id,
        checkedAt: parsed.checkedAt,
        totalChecks: parsed.totalChecks,
        passedChecks: parsed.passedChecks,
        failedChecks: parsed.failedChecks,
        score: parsed.score,
        findings: parsed.findings,
        summary,
      })
      .returning({
        id: cisBaselineResults.id,
        score: cisBaselineResults.score,
        failedChecks: cisBaselineResults.failedChecks,
        checkedAt: cisBaselineResults.checkedAt,
      });

    if (!inserted) {
      console.error(
        `[agents/helpers] cis_benchmark command ${command.id}: failed to insert baseline result (baseline=${baseline.id}, device=${command.deviceId})`,
      );
      return;
    }

    if (inserted.failedChecks > 0) {
      publishEvent(
        'compliance.cis_deviation',
        baseline.orgId,
        {
          baselineId: baseline.id,
          baselineName: baseline.name,
          deviceId: command.deviceId,
          resultId: inserted.id,
          failedChecks: inserted.failedChecks,
          checkedAt: inserted.checkedAt.toISOString(),
        },
        'agent-command-result'
      ).catch((error) => {
        console.error('[agents/helpers] Failed to publish compliance.cis_deviation:', error);
        captureException(error);
      });
    }

    const previousScore = previousResult?.score ?? null;
    if (previousScore === null || previousScore !== inserted.score) {
      publishEvent(
        'compliance.cis_score_changed',
        baseline.orgId,
        {
          baselineId: baseline.id,
          baselineName: baseline.name,
          deviceId: command.deviceId,
          previousScore,
          currentScore: inserted.score,
          delta: previousScore === null ? null : inserted.score - previousScore,
          resultId: inserted.id,
          checkedAt: inserted.checkedAt.toISOString(),
        },
        'agent-command-result'
      ).catch((error) => {
        console.error('[agents/helpers] Failed to publish compliance.cis_score_changed:', error);
        captureException(error);
      });
    }

    return;
  }

  const actionId = readTrimmedString(payload.actionId);
  if (!actionId || !isUuid(actionId)) {
    console.warn(`[agents/helpers] apply_cis_remediation command ${command.id} missing valid actionId`);
    return;
  }

  const [action] = await db
    .select({
      id: cisRemediationActions.id,
      orgId: cisRemediationActions.orgId,
      baselineId: cisRemediationActions.baselineId,
      baselineResultId: cisRemediationActions.baselineResultId,
      checkId: cisRemediationActions.checkId,
      actionName: cisRemediationActions.action,
      details: cisRemediationActions.details,
      beforeState: cisRemediationActions.beforeState,
      afterState: cisRemediationActions.afterState,
      rollbackHint: cisRemediationActions.rollbackHint,
    })
    .from(cisRemediationActions)
    .where(eq(cisRemediationActions.id, actionId))
    .limit(1);

  if (!action) {
    console.warn(`[agents/helpers] apply_cis_remediation command ${command.id}: remediation action ${actionId} not found`);
    return;
  }

  const completed = resultData.status === 'completed';
  const payloadDetails = isObject(payload.details) ? payload.details : null;
  const resultPayload = parseResultJson(resultData.stdout);
  const resultDetails = resultPayload && isObject(resultPayload.details)
    ? resultPayload.details
    : null;
  const beforeStateFromResult = resultPayload && isObject(resultPayload.beforeState)
    ? resultPayload.beforeState
    : resultPayload && isObject(resultPayload.before_state)
      ? resultPayload.before_state
      : null;
  const afterStateFromResult = resultPayload && isObject(resultPayload.afterState)
    ? resultPayload.afterState
    : resultPayload && isObject(resultPayload.after_state)
      ? resultPayload.after_state
      : null;
  const rollbackHint = readTrimmedString(
    (resultPayload?.rollbackHint as unknown)
      ?? (resultPayload?.rollback_hint as unknown)
      ?? (resultDetails?.rollbackHint as unknown)
      ?? (resultDetails?.rollback_hint as unknown)
      ?? (payloadDetails?.rollbackHint as unknown)
      ?? (payloadDetails?.rollback_hint as unknown)
      ?? action.rollbackHint
  );

  const updatedDetails = {
    ...(action.details ?? {}),
    ...(payloadDetails ?? {}),
    ...(resultDetails ?? {}),
    commandId: command.id,
    commandStatus: resultData.status,
    exitCode: resultData.exitCode ?? null,
    error: resultData.error ?? null,
    stderr: resultData.stderr ?? null,
    completedAt: new Date().toISOString(),
  };

  // #2434: resultDetails / beforeState / afterState / rollbackHint are all
  // derived from RAW stdout (unredacted at the chokepoint). before/afterState
  // hold the ACTUAL values of the registry keys or config the remediation
  // changed — a service-account password living in a registry value would be
  // persisted verbatim and rendered in the CIS UI. Redaction is idempotent, so
  // the already-redacted error/stderr in updatedDetails pass through unharmed.
  await db
    .update(cisRemediationActions)
    .set({
      status: completed ? 'completed' : 'failed',
      executedAt: new Date(),
      details: redactSecretsDeep(updatedDetails) as Record<string, unknown>,
      beforeState: redactSecretsDeep(beforeStateFromResult ?? action.beforeState ?? null) as Record<string, unknown> | null,
      afterState: redactSecretsDeep(afterStateFromResult ?? action.afterState ?? null) as Record<string, unknown> | null,
      rollbackHint: redactOptionalSecretText(rollbackHint ?? null),
    })
    .where(eq(cisRemediationActions.id, action.id));

  if (completed) {
    publishEvent(
      'compliance.cis_remediation_applied',
      action.orgId,
      {
        actionId: action.id,
        baselineId: action.baselineId,
        baselineResultId: action.baselineResultId,
        deviceId: command.deviceId,
        checkId: action.checkId,
        action: action.actionName,
        commandId: command.id,
      },
      'agent-command-result'
    ).catch((error) => {
      console.error('[agents/helpers] Failed to publish compliance.cis_remediation_applied:', error);
      captureException(error);
    });
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
  resultData: z.infer<typeof commandResultSchema>,
  orgId: string
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
    // A completed scan whose stdout is empty or non-JSON produces no snapshot,
    // which surfaces to the user as an empty Disk Cleanup tab with no error.
    console.warn(
      `[agents/helpers] filesystem_analysis command ${command.id} (device ${command.deviceId}) completed with unparseable/empty stdout (len=${resultData.stdout?.length ?? 0}); no snapshot written`
    );
    return;
  }

  // orgId comes from the caller's agent-auth context, which already resolved
  // the device's org — no need to re-query devices here.

  // The scan-state read and the disk-usage read are independent; run them
  // together. The disk figure is only consumed by the scan-state upsert below.
  const [currentState, diskRows] = await Promise.all([
    getFilesystemScanState(command.deviceId),
    db
      .select({ usedPercent: deviceDisks.usedPercent })
      .from(deviceDisks)
      .where(eq(deviceDisks.deviceId, command.deviceId))
      .limit(1),
  ]);
  const currentDiskUsedPercent =
    typeof diskRows[0]?.usedPercent === 'number' ? diskRows[0].usedPercent : null;

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

  await saveFilesystemSnapshot(command.deviceId, orgId, snapshotTrigger, snapshotPayload);

  const hotFromRun = extractHotDirectoriesFromSnapshotPayload(snapshotPayload, 24);
  const mergedHotDirectories = Array.from(
    new Set([
      ...hotFromRun,
      ...readHotDirectories(currentState?.hotDirectories, 24),
    ])
  ).slice(0, 24);

  // Baseline completion is defined solely by having no pending checkpoint
  // directories left to resume. The snapshot's `partial` flag must NOT gate
  // this: `partial` is also set (and stays sticky across merges) for routine
  // max-depth truncation, which is not a resumable condition — folding it in
  // here left `lastBaselineCompletedAt` permanently null on any deep tree, which
  // forced every subsequent scan back to a full baseline and defeated the
  // incremental hot-directory path.
  const baselineCompleted = scanMode === 'baseline' && pendingDirs.length === 0;
  await upsertFilesystemScanState(command.deviceId, orgId, {
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
// Event Log Policy Settings
// ============================================

export type EventLogLevel = 'info' | 'warning' | 'error' | 'critical';
export type EventLogCategory = 'security' | 'hardware' | 'application' | 'system';

export interface EventLogSettings {
  retentionDays: number;
  maxEventsPerCycle: number;
  collectCategories: EventLogCategory[];
  minimumLevel: EventLogLevel;
  collectionIntervalMinutes: number;
  rateLimitPerHour: number;
}

export const EVENT_LOG_DEFAULTS: EventLogSettings = {
  retentionDays: 30,
  maxEventsPerCycle: 100,
  collectCategories: ['security', 'hardware', 'application', 'system'],
  minimumLevel: 'info',
  // 15m default (was 5m) — issue #2390 subprocess-churn backoff. Keep in sync
  // with eventLogInlineSettingsSchema (shared validators) and the agent's
  // NewEventLogCollector default.
  collectionIntervalMinutes: 15,
  rateLimitPerHour: 12000,
};

const LEVEL_PRIORITY: Record<string, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

async function resolveDeviceEventLogSettings(deviceId: string): Promise<EventLogSettings> {
  // 1. Load device
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return EVENT_LOG_DEFAULTS;

  // 2. Load org (for partnerId)
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions
  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // 5. Single query: assignments → active policies → event_log feature link → settings
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      retentionDays: configPolicyEventLogSettings.retentionDays,
      maxEventsPerCycle: configPolicyEventLogSettings.maxEventsPerCycle,
      collectCategories: configPolicyEventLogSettings.collectCategories,
      minimumLevel: configPolicyEventLogSettings.minimumLevel,
      collectionIntervalMinutes: configPolicyEventLogSettings.collectionIntervalMinutes,
      rateLimitPerHour: configPolicyEventLogSettings.rateLimitPerHour,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'event_log'),
    ))
    .innerJoin(configPolicyEventLogSettings, eq(configPolicyEventLogSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));

  if (rows.length === 0) return EVENT_LOG_DEFAULTS;

  // 6. Sort by level priority DESC, then assignment priority ASC — first match wins
  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  const winner = rows[0];
  if (!winner) return EVENT_LOG_DEFAULTS;
  return {
    retentionDays: winner.retentionDays,
    maxEventsPerCycle: winner.maxEventsPerCycle,
    collectCategories: winner.collectCategories as EventLogCategory[],
    minimumLevel: winner.minimumLevel as EventLogLevel,
    collectionIntervalMinutes: winner.collectionIntervalMinutes,
    rateLimitPerHour: winner.rateLimitPerHour,
  };
}

const EVENT_LOG_CACHE_TTL_SECONDS = 120; // 2 minutes

/**
 * Resolve event_log policy settings for a device via full hierarchy.
 * Uses Redis cache with 2-min TTL. Falls back to defaults if no policy found.
 */
export async function getDeviceEventLogSettings(deviceId: string): Promise<EventLogSettings> {
  const redis = getRedis();
  const cacheKey = `eventlog:settings:device:${deviceId}`;

  // Try cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as EventLogSettings;
      }
    } catch (cacheErr) {
      console.warn(`[eventlog] Redis cache read failed for device ${deviceId}:`, cacheErr);
    }
  }

  // Resolve via full hierarchy: device → device_group → site → org → partner
  const settings = await resolveDeviceEventLogSettings(deviceId);

  // Cache the result
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(settings), 'EX', EVENT_LOG_CACHE_TTL_SECONDS);
    } catch (cacheErr) {
      console.warn(`[eventlog] Redis cache write failed for device ${deviceId}:`, cacheErr);
    }
  }

  return settings;
}

/**
 * Build event_log config update payload for heartbeat response.
 * Returns agent-facing settings, including defaults when no policy is assigned.
 * This ensures stale non-default agent settings get reset after policy removal.
 */
export async function buildEventLogConfigUpdate(deviceId: string): Promise<{
  max_events_per_cycle: number;
  collect_categories: string[];
  minimum_level: string;
  collection_interval_minutes: number;
}> {
  const settings = await getDeviceEventLogSettings(deviceId);

  return {
    max_events_per_cycle: settings.maxEventsPerCycle,
    collect_categories: settings.collectCategories,
    minimum_level: settings.minimumLevel,
    collection_interval_minutes: settings.collectionIntervalMinutes,
  };
}

/**
 * Org-level retention lookup for the retention worker.
 * Returns the retention days from the highest-priority org-level event_log policy,
 * or 30 days if none is configured.
 */
export async function getOrgEventLogRetentionDays(orgId: string): Promise<number> {
  const [row] = await db
    .select({ retentionDays: configPolicyEventLogSettings.retentionDays })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'event_log'),
    ))
    .innerJoin(configPolicyEventLogSettings, eq(configPolicyEventLogSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      eq(configPolicyAssignments.level, 'organization'),
      eq(configPolicyAssignments.targetId, orgId),
      eq(configurationPolicies.status, 'active'),
    ))
    .orderBy(configPolicyAssignments.priority)
    .limit(1);

  return row?.retentionDays ?? 30;
}

// ============================================
// Monitoring (Service & Process) Policy Settings
// ============================================

export interface MonitoringWatchConfig {
  watch_type: 'service' | 'process';
  name: string;
  alert_on_stop: boolean;
  alert_after_consecutive_failures: number;
  auto_restart: boolean;
  max_restart_attempts: number;
  restart_cooldown_seconds: number;
  cpu_threshold_percent?: number;
  memory_threshold_mb?: number;
  threshold_duration_seconds?: number;
}

export interface MonitoringConfigUpdate {
  check_interval_seconds: number;
  watches: MonitoringWatchConfig[];
}

async function resolveDeviceMonitoringSettings(deviceId: string): Promise<MonitoringConfigUpdate | null> {
  // 1. Load device
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;

  // 2. Load org (for partnerId)
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions
  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // 5. Single query: assignments → active policies → monitoring feature link → settings
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      settingsId: configPolicyMonitoringSettings.id,
      checkIntervalSeconds: configPolicyMonitoringSettings.checkIntervalSeconds,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'monitoring'),
    ))
    .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));

  if (rows.length === 0) return null;

  // 6. Sort by level priority DESC, then assignment priority ASC — first match wins
  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  const winner = rows[0];
  if (!winner) return null;

  // 7. Load watches for the winning settings row
  const watches = await db
    .select()
    .from(configPolicyMonitoringWatches)
    .where(and(
      eq(configPolicyMonitoringWatches.settingsId, winner.settingsId),
      eq(configPolicyMonitoringWatches.enabled, true),
    ))
    .orderBy(configPolicyMonitoringWatches.sortOrder);

  if (watches.length === 0) return null;

  return {
    check_interval_seconds: winner.checkIntervalSeconds,
    watches: watches.map((w) => {
      const entry: MonitoringWatchConfig = {
        watch_type: w.watchType,
        name: w.name,
        alert_on_stop: w.alertOnStop,
        alert_after_consecutive_failures: w.alertAfterConsecutiveFailures,
        auto_restart: w.autoRestart,
        max_restart_attempts: w.maxRestartAttempts,
        restart_cooldown_seconds: w.restartCooldownSeconds,
      };
      if (w.cpuThresholdPercent != null) entry.cpu_threshold_percent = w.cpuThresholdPercent;
      if (w.memoryThresholdMb != null) entry.memory_threshold_mb = w.memoryThresholdMb;
      if (w.thresholdDurationSeconds) entry.threshold_duration_seconds = w.thresholdDurationSeconds;
      return entry;
    }),
  };
}

const MONITORING_CACHE_TTL_SECONDS = 120; // 2 minutes

export async function buildMonitoringConfigUpdate(deviceId: string): Promise<MonitoringConfigUpdate | null> {
  const redis = getRedis();
  const cacheKey = `monitoring:settings:device:${deviceId}`;

  // Try cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as MonitoringConfigUpdate;
      }
    } catch (cacheErr) {
      console.warn(`[monitoring] Redis cache read failed for device ${deviceId}:`, cacheErr);
    }
  }

  const settings = await resolveDeviceMonitoringSettings(deviceId);

  // Cache the result when non-null (null results are not cached to allow quick policy activation)
  if (redis && settings) {
    try {
      await redis.set(cacheKey, JSON.stringify(settings), 'EX', MONITORING_CACHE_TTL_SECONDS);
    } catch (cacheErr) {
      console.warn(`[monitoring] Redis cache write failed for device ${deviceId}:`, cacheErr);
    }
  }

  return settings;
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

// Per-process dedup for the malformed-maintenance-window warning. The read
// below runs on the heartbeat hot path; without this, a single misconfigured
// org would emit one warn per device per heartbeat. Cleared by tests.
const warnedMalformedWindowOrgs = new Set<string>();

// Same rationale for the "pinned build missing for platform/arch" fail-closed
// path (issue #2124): a persistent misconfig would otherwise fire per device per
// heartbeat. Deduped per (component, platform, arch, version) so Sentry sees the
// freeze ONCE per process rather than a flood. Cleared by tests.
const warnedMissingPinBuilds = new Set<string>();

/** Test-only: reset the malformed-window + missing-pin warn dedup between cases. */
export function __resetMalformedWindowWarnCache(): void {
  warnedMalformedWindowOrgs.clear();
  warnedMissingPinBuilds.clear();
}

/** Pull the `defaults` sub-object out of a settings JSONB blob (safe for null). */
function extractSettingsDefaults(settings: unknown): Record<string, unknown> {
  const root = isObject(settings) ? settings : {};
  return isObject(root.defaults) ? root.defaults : {};
}

/**
 * Effective per-component update version pins (issue #2124). `null` means "no
 * pin" → track the globally promoted latest version (historical behaviour).
 */
export interface AgentVersionPins {
  agent: string | null;
  watchdog: string | null;
}

/**
 * The full effective agent-update config for an org: the update-policy gate
 * inputs PLUS the version pins. Both are resolved from the SAME single org⋈
 * partner join (see getOrgAgentUpdateConfig) so the heartbeat hot path pays one
 * round trip for everything it needs.
 */
export interface AgentUpdateConfig {
  settings: AgentUpdateSettings;
  pins: AgentVersionPins;
}

/**
 * Resolve the EFFECTIVE agent update config for an org (Org > General). The
 * update-POLICY fields (`agentUpdatePolicy`, `maintenanceWindow`) use the same
 * partner-locks precedence as the settings UI / `getEffectiveOrgSettings`: a
 * partner-set field wins and locks; the org value applies only where the partner
 * has not set it (merged independently per field).
 *
 * `agentVersionPins` deliberately uses DIFFERENT, weaker precedence —
 * INHERIT-WITH-OVERRIDE (issue #2124, per maintainer): a partner pin is an
 * inherited DEFAULT, but an org-set pin WINS for that org, per component and by
 * presence (so an org may pin 'latest' to override a partner pin back to global
 * latest). Pins are intentionally exempt from the partner lock model in v1 — this
 * is what lets a partner pilot a new version on one org without unsetting the
 * fleet-wide default. See the assertNotLocked exemption in routes/orgs.ts.
 *
 * Returns a normalized policy + raw maintenance-window string (the gating
 * decision lives in `shouldSendAgentUpgrade`) AND the normalized version pins
 * (the heartbeat turns these into concrete upgrade targets, fail-closed when a
 * pinned version has no build for the device's platform/arch). Orgs (and
 * partners) that never configured a field resolve to permissive/no-pin defaults,
 * preserving historical behaviour.
 *
 * Hot path: this runs once per device per heartbeat, so org + partner settings
 * are fetched in a single joined round trip rather than two queries. A thrown
 * error propagates to the heartbeat gate, which fails CLOSED (#2125); a missing
 * org/partner row is NOT an error — it falls back to the permissive default like
 * an unconfigured org, matching the pre-effective-settings behaviour.
 *
 * Issue #2123: before this, the gate read org-local `settings.defaults` only, so
 * a partner-locked policy (e.g. Manual) had zero runtime effect and unconfigured
 * child orgs fell back to the permissive default despite the partner lock.
 * Issue #2124 rides version pins on top of the exact same join and precedence so
 * there is one resolver, not two.
 */
export async function getOrgAgentUpdateConfig(orgId: string): Promise<AgentUpdateConfig> {
  // LEFT JOIN so a missing partner (shouldn't happen) still returns the org row
  // and falls back to org-local settings rather than dropping the whole lookup.
  const [row] = await db
    .select({ orgSettings: organizations.settings, partnerSettings: partners.settings })
    .from(organizations)
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .where(eq(organizations.id, orgId))
    .limit(1);

  const orgDefaults = extractSettingsDefaults(row?.orgSettings);
  const partnerDefaults = extractSettingsDefaults(row?.partnerSettings);

  // Effective merge, per field (mirrors effectiveSettings.mergeCategory): a
  // partner-set field wins and locks; the org value fills the gap only where the
  // partner has not set that field. `in` (not truthiness) matches mergeCategory,
  // which locks any key the partner has present.
  const effectivePolicy =
    'agentUpdatePolicy' in partnerDefaults
      ? partnerDefaults.agentUpdatePolicy
      : orgDefaults.agentUpdatePolicy;
  const effectiveWindow =
    'maintenanceWindow' in partnerDefaults
      ? partnerDefaults.maintenanceWindow
      : orgDefaults.maintenanceWindow;
  // Version pins: inherit-with-override, per component (issue #2124). An org-set
  // component wins for that org; where the org has NOT set a component the partner
  // default is inherited; unset at both levels → global promoted latest. Keyed by
  // PRESENCE ('agent' in orgPins), NOT truthiness, so an org can store 'latest' to
  // deliberately override a partner pin back to the global latest. Agent and
  // watchdog are independent.
  const orgPins = isObject(orgDefaults.agentVersionPins) ? orgDefaults.agentVersionPins : {};
  const partnerPins = isObject(partnerDefaults.agentVersionPins)
    ? partnerDefaults.agentVersionPins
    : {};
  const pins: AgentVersionPins = {
    agent: normalizeVersionPin('agent' in orgPins ? orgPins.agent : partnerPins.agent),
    watchdog: normalizeVersionPin('watchdog' in orgPins ? orgPins.watchdog : partnerPins.watchdog),
  };

  const policy = normalizeAgentUpdatePolicy(effectivePolicy);
  const rawWindow = typeof effectiveWindow === 'string' ? effectiveWindow.trim() : '';
  // The explicit "24/7"/empty always-state means "no restriction" → null, same
  // as an absent window. Only a real window string is carried through to the gate.
  const maintenanceWindow = rawWindow && !isAlwaysMaintenanceWindow(rawWindow) ? rawWindow : null;
  // New writes are validated at save time (issue #1963), but a legacy malformed
  // value still parses to null in the gate and fails open (lifts the time
  // restriction). Surface that so the silently-lifted restriction is observable
  // rather than an invisible 24/7-updates surprise. This runs on the heartbeat
  // hot path (once per device per heartbeat), so dedupe per org for the process
  // lifetime — otherwise one misconfigured org spams the log every heartbeat.
  if (
    maintenanceWindow !== null &&
    parseMaintenanceWindow(maintenanceWindow) === null &&
    !warnedMalformedWindowOrgs.has(orgId)
  ) {
    warnedMalformedWindowOrgs.add(orgId);
    console.warn(
      `[agents/helpers] Ignoring malformed maintenance window for org ${orgId}; ` +
      `agent updates are NOT time-restricted (failing open). value=${JSON.stringify(maintenanceWindow)}`,
    );
  }
  return { settings: { policy, maintenanceWindow }, pins };
}

/**
 * Back-compat thin wrapper: resolve only the update-policy gate settings.
 * Retained so existing callers/tests that only need the gate keep their surface;
 * the heartbeat resolves the full config (settings + pins) via
 * getOrgAgentUpdateConfig in a single round trip.
 */
export async function getOrgAgentUpdatePolicy(orgId: string): Promise<AgentUpdateSettings> {
  return (await getOrgAgentUpdateConfig(orgId)).settings;
}

/**
 * Resolve the candidate upgrade-target version for a component on a device's
 * platform/arch, honoring an effective version pin (issue #2124).
 *
 *  - `pin === null` → the globally promoted latest build (`is_latest = true`),
 *    or `null` if none is registered. This is byte-for-byte the pre-#2124
 *    behaviour, so unpinned tenants are unaffected.
 *  - `pin === '<version>'` → that EXACT version, but only if a build is
 *    registered for (component, platform, arch). If not, returns `null` and
 *    logs — a pin whose build is missing for this platform/arch **fails closed**
 *    (withholds the upgrade) rather than silently falling back to latest, which
 *    would defeat the holdback/rollback intent of the pin.
 *
 * Returns only the candidate version string. The caller keeps the existing
 * decision to actually send it (dev-build guard, update-policy gate, version
 * comparison) so heartbeat semantics are otherwise unchanged. `agentVersions`
 * is a global (non-tenant) table, so this is safe to call in any DB context.
 */
export async function resolvePinnedUpgradeTarget(args: {
  component: string;
  platform: string;
  architecture: string;
  pin: string | null;
  agentId?: string;
}): Promise<string | null> {
  const { component, platform, architecture, pin, agentId } = args;

  if (pin === null) {
    const [latest] = await db
      .select({ version: agentVersions.version })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, architecture),
          eq(agentVersions.component, component),
          eq(agentVersions.isLatest, true),
        ),
      )
      .orderBy(desc(agentVersions.createdAt)) // newest first if multiple isLatest rows exist
      .limit(1);
    return latest?.version ?? null;
  }

  const [pinned] = await db
    .select({ version: agentVersions.version })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.platform, platform),
        eq(agentVersions.architecture, architecture),
        eq(agentVersions.component, component),
        eq(agentVersions.version, pin),
      ),
    )
    .limit(1);

  if (!pinned) {
    // Fail-closed, but loudly: an operator pinned a version with no build for
    // this platform/arch (typo, or a build that was never published). Withhold
    // the upgrade AND surface it. Per-heartbeat stdout alone is not enough — this
    // is the same class of invisible, fleet-wide freeze the #2125 gate catch
    // routes to Sentry, so match that bar. Deduped per (component/platform/arch/
    // version) so a persistent misconfig captures ONCE per process, not per beat.
    console.warn(
      `[agents] update withheld for ${agentId ?? 'device'}: pinned ${component} version ` +
        `"${pin}" has no registered build for ${platform}/${architecture} (fail closed)`,
    );
    const key = `${component}:${platform}:${architecture}:${pin}`;
    if (!warnedMissingPinBuilds.has(key)) {
      warnedMissingPinBuilds.add(key);
      captureException(
        new Error(
          `Agent update withheld (#2124): pinned ${component} version "${pin}" has no ` +
            `registered build for ${platform}/${architecture}; fleet freeze until a build ` +
            `is published or the pin is corrected.`,
        ),
      );
    }
    return null;
  }
  return pinned.version;
}

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

// ============================================
// Helper Settings (policy-driven)
// ============================================

export interface HelperSettings {
  enabled: boolean;
  showOpenPortal: boolean;
  showDeviceInfo: boolean;
  showRequestSupport: boolean;
  portalUrl?: string;
}

const HELPER_DEFAULTS: HelperSettings = {
  enabled: false,
  showOpenPortal: true,
  showDeviceInfo: true,
  showRequestSupport: true,
};

async function resolveDeviceHelperSettings(deviceId: string): Promise<HelperSettings> {
  // 1. Load device
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return HELPER_DEFAULTS;

  // 2. Load org (for partnerId)
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions
  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // 5. Single query: assignments → active policies → helper feature link (pure JSONB)
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'helper'),
    ))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));

  if (rows.length === 0) return HELPER_DEFAULTS;

  // 6. Sort by level priority DESC, then assignment priority ASC — first match wins
  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  const winner = rows[0];
  if (!winner?.inlineSettings) return HELPER_DEFAULTS;

  const s = winner.inlineSettings as Record<string, unknown>;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : HELPER_DEFAULTS.enabled,
    showOpenPortal: typeof s.showOpenPortal === 'boolean' ? s.showOpenPortal : HELPER_DEFAULTS.showOpenPortal,
    showDeviceInfo: typeof s.showDeviceInfo === 'boolean' ? s.showDeviceInfo : HELPER_DEFAULTS.showDeviceInfo,
    showRequestSupport: typeof s.showRequestSupport === 'boolean' ? s.showRequestSupport : HELPER_DEFAULTS.showRequestSupport,
    portalUrl: typeof s.portalUrl === 'string' && s.portalUrl ? s.portalUrl : undefined,
  };
}

const HELPER_CACHE_TTL_SECONDS = 120;

/**
 * Build helper config update payload for heartbeat response.
 * Resolves helper policy settings via the config policy hierarchy.
 * Falls back to org-level helperEnabled for backward compatibility,
 * then to defaults if no policy found.
 */
export async function buildHelperConfigUpdate(deviceId: string, orgId: string): Promise<HelperSettings> {
  const redis = getRedis();
  const cacheKey = `helper:settings:device:${deviceId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as HelperSettings;
    } catch (cacheErr) {
      console.warn(`[helper] Redis cache read failed for device ${deviceId}:`, cacheErr);
    }
  }

  // Try config policy resolution first
  let settings = await resolveDeviceHelperSettings(deviceId);

  // Fallback: if no policy found, check org-level settings for backward compat
  if (!settings.enabled) {
    try {
      const orgSettings = await getOrgHelperSettings(orgId);
      if (orgSettings.enabled) {
        settings = { ...HELPER_DEFAULTS, enabled: true };
      }
    } catch {
      // ignore — defaults are fine
    }
  }

  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(settings), 'EX', HELPER_CACHE_TTL_SECONDS);
    } catch (cacheErr) {
      console.warn(`[helper] Redis cache write failed for device ${deviceId}:`, cacheErr);
    }
  }

  return settings;
}

// ============================================
// PAM Settings (policy-driven)
// ============================================

/**
 * Org-level fallback when no 'pam' config-policy feature link resolves for the
 * device. Orgs that had deliberately configured PAM before the opt-in switch
 * carry an explicit uac_interception_enabled=true on their pam_org_config row
 * (grandfathered by migration 2026-07-01); everyone else falls to PAM_DEFAULTS
 * (opt-in: off). An explicit config-policy feature link always wins over this.
 */
async function resolveOrgPamFallback(orgId: string): Promise<PamSettings> {
  const [cfg] = await db
    .select({ enabled: pamOrgConfig.uacInterceptionEnabled })
    .from(pamOrgConfig)
    .where(eq(pamOrgConfig.orgId, orgId))
    .limit(1);
  if (cfg && typeof cfg.enabled === 'boolean') {
    return { uacInterceptionEnabled: cfg.enabled };
  }
  return PAM_DEFAULTS;
}

async function resolveDevicePamSettings(deviceId: string): Promise<PamSettings> {
  // 1. Load device
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return PAM_DEFAULTS;

  // 2. Load org (for partnerId)
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions
  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // 5. Single query: assignments → active policies → pam feature link (pure JSONB)
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'pam'),
    ))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));

  if (rows.length === 0) return resolveOrgPamFallback(device.orgId);

  // 6. Sort by level priority DESC, then assignment priority ASC — first match wins
  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  const winner = rows[0];
  if (!winner?.inlineSettings) return resolveOrgPamFallback(device.orgId);

  return parsePamSettings(winner.inlineSettings);
}

const PAM_CACHE_TTL_SECONDS = 120;

/**
 * Build PAM config update payload for heartbeat response.
 * Resolves pam policy settings via the config policy hierarchy, then the
 * org-level grandfather flag, then PAM_DEFAULTS (uacInterceptionEnabled: false).
 * Cached per-device in Redis for 120s — policy changes propagate within ~2min + heartbeat interval.
 */
export async function buildPamConfigUpdate(deviceId: string): Promise<PamSettings> {
  const redis = getRedis();
  const cacheKey = `pam:settings:device:${deviceId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as PamSettings;
    } catch (cacheErr) {
      console.warn(`[pam] Redis cache read failed for device ${deviceId}:`, cacheErr);
    }
  }

  const settings = await resolveDevicePamSettings(deviceId);

  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(settings), 'EX', PAM_CACHE_TTL_SECONDS);
    } catch (cacheErr) {
      console.warn(`[pam] Redis cache write failed for device ${deviceId}:`, cacheErr);
    }
  }

  return settings;
}

// ============================================
// Patch Source Enforcement Config (#1872)
// ============================================

export interface PatchSourceSettings {
  /**
   * When true the Windows agent suppresses the native Windows Update
   * automatic-install channel (NoAutoUpdate=1) so updates flow only through
   * Breeze's approval rings. False explicitly tells the agent to revert any
   * enforcement Breeze previously applied (a pre-existing admin GPO is left
   * untouched, agent-side). Breeze's own WUA-driven install path is unaffected.
   */
  exclusiveWindowsUpdate: boolean;
}

/**
 * Resolves the patch feature link for the device and surfaces the
 * sole-source-enforcement flag for the heartbeat config push. A device with no
 * patch policy assigned resolves to `false`, which the agent treats as "revert
 * any prior Breeze enforcement" — so removing the policy cleanly reverts the
 * endpoint. The caller (heartbeat) omits the block entirely on a resolver error
 * so a transient failure never triggers an unintended revert.
 */
export async function buildPatchSourceConfigUpdate(deviceId: string): Promise<PatchSourceSettings> {
  const patch = await resolvePatchConfigForDevice(deviceId);
  return { exclusiveWindowsUpdate: patch?.exclusiveWindowsUpdate ?? false };
}

// ============================================
// OneDrive Helper Config
// ============================================

export interface OnedriveConfigUpdate {
  base: {
    silentAccountConfig: boolean;
    filesOnDemand: boolean;
    kfmSilentOptIn: boolean;
    kfmFolders: string[];
    kfmBlockOptOut: boolean;
    tenantAssociationId: string | null;
    restartOnChange: boolean;
  };
  libraries: Array<{
    libraryId: string;
    displayName: string;
    siteUrl: string | null;
    targetingMode: string;
    groupId: string | null;
    groupName: string | null;
    hiveScope: string;
    allowedUpns: string[];
  }>;
}

async function resolveDeviceOnedriveSettings(deviceId: string): Promise<OnedriveConfigUpdate | null> {
  // 1. Load device
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;

  // 2. Load org (for partnerId)
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions (closest-level-wins hierarchy)
  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // 5. Single query: assignments → active policies → onedrive_helper feature link → settings
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      settingsId: configPolicyOnedriveSettings.id,
      silentAccountConfig: configPolicyOnedriveSettings.silentAccountConfig,
      filesOnDemand: configPolicyOnedriveSettings.filesOnDemand,
      kfmSilentOptIn: configPolicyOnedriveSettings.kfmSilentOptIn,
      kfmFolders: configPolicyOnedriveSettings.kfmFolders,
      kfmBlockOptOut: configPolicyOnedriveSettings.kfmBlockOptOut,
      tenantAssociationId: configPolicyOnedriveSettings.tenantAssociationId,
      restartOnChange: configPolicyOnedriveSettings.restartOnChange,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'onedrive_helper'),
    ))
    .innerJoin(configPolicyOnedriveSettings, eq(configPolicyOnedriveSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));

  if (rows.length === 0) return null;

  // 6. Sort by level priority DESC, then assignment priority ASC — first match wins
  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  const winner = rows[0];
  if (!winner) return null;

  // 7. Load enabled libraries for the winning settings row, in sort order
  const libs = await db
    .select()
    .from(configPolicyOnedriveLibraries)
    .where(and(
      eq(configPolicyOnedriveLibraries.settingsId, winner.settingsId),
      eq(configPolicyOnedriveLibraries.enabled, true),
    ))
    .orderBy(configPolicyOnedriveLibraries.sortOrder);

  const [state] = libs.length > 0
    ? await db
      .select()
      .from(onedriveDeviceState)
      .where(eq(onedriveDeviceState.deviceId, deviceId))
      .limit(1)
    : [];

  // Phase 4: tag enabled graph_group libraries with the reported UPNs whose
  // transitive Entra membership includes the rule's groupId. Fail closed:
  // no UPNs / no groupId / Graph error → no tag → the agent never mounts it.
  const graphRules = libs.filter((l) => l.targetingMode === 'graph_group' && l.groupId);
  // Guard the jsonb shape: a corrupt/non-array signedInUpns value degrades to
  // no-tagging (delivery of non-graph libraries must survive) instead of throwing.
  // zod validates ingest, so a non-array here means an out-of-band write — worth a log.
  const rawUpns = state?.signedInUpns;
  if (rawUpns != null && !Array.isArray(rawUpns)) {
    console.warn(`[agents] graph_group tagging: signed_in_upns is not an array for device ${deviceId}; treating as empty`);
  }
  const reportedUpns = (Array.isArray(rawUpns) ? rawUpns : []).filter(
    (u): u is string => typeof u === 'string' && u.length > 0
  );
  // Dedupe case-insensitively, keeping the first occurrence's casing: the agent already
  // dedupes case-insensitively via EqualFold before reporting, so which casing survives
  // here is cosmetic. This is defense-in-depth against a stale agent version or an
  // out-of-band write — each duplicate otherwise costs a Graph resolution and produces
  // duplicate allowedUpns entries on the wire.
  const seenUpns = new Set<string>();
  const upns = reportedUpns.filter((u) => {
    const key = u.toLowerCase();
    if (seenUpns.has(key)) return false;
    seenUpns.add(key);
    return true;
  });
  // Group ids are GUIDs from two sources (Graph responses vs. the stored rule,
  // which future entry paths may brace/uppercase) — normalize both sides so a
  // formatting mismatch can't silently fail-close the library forever.
  const normalizeGuid = (g: string) => g.replace(/^\{|\}$/g, '').toLowerCase();
  const allowedByLib = new Map<string, string[]>();
  if (graphRules.length > 0 && upns.length > 0) {
    // Aggregate deadline: per-call timeouts bound each round-trip, but 16 UPNs
    // × (token + up to 5 membership pages) can still sum past the agent's
    // heartbeat client timeout — which would drop the WHOLE response including
    // already-claimed commands. Past the budget, remaining UPNs stay untagged
    // this cycle (fail closed) and retry next heartbeat against a warm cache.
    const taggingDeadline = Date.now() + 15_000;
    for (const upn of upns) {
      if (Date.now() > taggingDeadline) {
        console.warn(`[agents] graph_group tagging: time budget exhausted for device ${deviceId}; remaining UPNs untagged this cycle`);
        break;
      }
      const res = await resolveUserGroupMembershipCached(device.orgId, upn);
      if (res.kind !== 'ok') {
        // Deliberately no UPN in the log line — it's end-user PII; the code +
        // deviceId is enough to triage.
        console.warn(`[agents] graph_group tagging: membership lookup failed for device ${deviceId}: ${res.code}`);
        continue;
      }
      const groupIds = new Set(res.data.groupIds.map(normalizeGuid));
      for (const rule of graphRules) {
        if (rule.groupId && groupIds.has(normalizeGuid(rule.groupId))) {
          const arr = allowedByLib.get(rule.id) ?? [];
          arr.push(upn);
          allowedByLib.set(rule.id, arr);
        }
      }
    }
  }

  return {
    base: {
      silentAccountConfig: winner.silentAccountConfig,
      filesOnDemand: winner.filesOnDemand,
      kfmSilentOptIn: winner.kfmSilentOptIn,
      kfmFolders: (winner.kfmFolders as string[]) ?? [],
      kfmBlockOptOut: winner.kfmBlockOptOut,
      tenantAssociationId: winner.tenantAssociationId,
      restartOnChange: winner.restartOnChange,
    },
    libraries: libs.map((l) => ({
      libraryId: l.libraryId,
      displayName: l.displayName,
      siteUrl: l.siteUrl,
      targetingMode: l.targetingMode,
      groupId: l.groupId,
      groupName: l.groupName,
      hiveScope: l.hiveScope,
      allowedUpns: allowedByLib.get(l.id) ?? [],
    })),
  };
}

export async function buildOnedriveHelperConfigUpdate(deviceId: string): Promise<OnedriveConfigUpdate | null> {
  return resolveDeviceOnedriveSettings(deviceId);
}
