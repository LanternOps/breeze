import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  automationPolicies,
  automationPolicyCompliance,
  automations,
  automationRuns,
  deviceConfigState,
  deviceDisks,
  deviceRegistryState,
  devices,
  deviceGroupMemberships,
  deviceSoftware,
  softwareInventory,
} from '../db/schema';
import { publishEvent } from './eventBus';

export type EvaluationStatus = 'compliant' | 'non_compliant';

type PolicyRow = typeof automationPolicies.$inferSelect;

type TargetDevice = {
  id: string;
  hostname: string;
  osType: string;
  osVersion: string;
};

export type PolicyEvaluationResult = {
  deviceId: string;
  hostname: string;
  status: EvaluationStatus;
  previousStatus: string | null;
  remediationRunId?: string | null;
};

export type PolicyEvaluationResponse = {
  message: string;
  policyId: string;
  devicesEvaluated: number;
  results: PolicyEvaluationResult[];
  summary: {
    compliant: number;
    non_compliant: number;
  };
  evaluatedAt: string;
};

type EvaluatePolicyOptions = {
  source?: string;
  requestRemediation?: boolean;
};

type TargetConfig = {
  targetType?: string;
  targetIds?: string[];
  deviceIds?: string[];
  siteIds?: string[];
  groupIds?: string[];
  tags?: string[];
};

type ParsedRule = {
  type: string;
  raw: Record<string, unknown>;
};

type ParsedRulesResult = {
  rules: ParsedRule[];
  inputHadArray: boolean;
  inputLength: number;
  invalidCount: number;
};

type InstalledSoftwareRecord = {
  name: string;
  version: string | null;
};

type DiskRecord = {
  mountPoint: string;
  device: string | null;
  freeGb: number;
};

type RegistryStateRecord = {
  registryPath: string;
  valueName: string;
  valueData: string | null;
  valueType: string | null;
};

type ConfigStateRecord = {
  filePath: string;
  configKey: string;
  configValue: string | null;
};

type RuleEvaluationDetail = {
  ruleType: string;
  passed: boolean;
  message: string;
  data?: Record<string, unknown>;
};

type DeviceEvaluationContext = {
  device: TargetDevice;
  software: InstalledSoftwareRecord[];
  disks: DiskRecord[];
  registryState: RegistryStateRecord[];
  configState: ConfigStateRecord[];
};

type DeviceRuleEvaluation = {
  passed: boolean;
  details: RuleEvaluationDetail[];
};

type VersionOperator = 'any' | 'exact' | 'minimum' | 'maximum';

export type RuleEvaluationDebugInput = {
  device: {
    osType: string;
    osVersion: string;
  };
  software?: Array<{
    name: string;
    version: string | null;
  }>;
  disks?: Array<{
    mountPoint: string;
    device: string | null;
    freeGb: number;
  }>;
  registryState?: Array<{
    registryPath: string;
    valueName: string;
    valueData: string | null;
    valueType: string | null;
  }>;
  configState?: Array<{
    filePath: string;
    configKey: string;
    configValue: string | null;
  }>;
};

export type RuleEvaluationDebugOutput = {
  passed: boolean;
  details: Array<{
    ruleType: string;
    passed: boolean;
    message: string;
    data?: Record<string, unknown>;
  }>;
};

function sanitizeUuidList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeTargetConfig(targets: unknown): TargetConfig {
  if (!targets || typeof targets !== 'object') {
    return {};
  }

  const raw = targets as Record<string, unknown>;
  const targetType = typeof raw.targetType === 'string' ? raw.targetType : undefined;
  const targetIds = sanitizeUuidList(raw.targetIds);
  const deviceIds = sanitizeUuidList(raw.deviceIds);
  const siteIds = sanitizeUuidList(raw.siteIds);
  const groupIds = sanitizeUuidList(raw.groupIds);
  const tags = sanitizeUuidList(raw.tags);

  return {
    targetType,
    targetIds,
    deviceIds: deviceIds.length > 0 ? deviceIds : targetType === 'devices' ? targetIds : [],
    siteIds: siteIds.length > 0 ? siteIds : targetType === 'sites' ? targetIds : [],
    groupIds: groupIds.length > 0 ? groupIds : targetType === 'groups' ? targetIds : [],
    tags: tags.length > 0 ? tags : targetType === 'tags' ? targetIds : [],
  };
}

function parsePolicyRules(rules: unknown): ParsedRulesResult {
  if (!Array.isArray(rules)) {
    return {
      rules: [],
      inputHadArray: false,
      inputLength: 0,
      invalidCount: 0,
    };
  }

  const parsedRules: ParsedRule[] = [];
  let invalidCount = 0;

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') {
      invalidCount += 1;
      continue;
    }

    const typedRule = rule as Record<string, unknown>;
    const typeValue = typeof typedRule.type === 'string'
      ? typedRule.type
      : typeof typedRule.name === 'string'
        ? typedRule.name
        : null;

    const type = typeValue?.trim();
    if (!type) {
      invalidCount += 1;
      continue;
    }

    parsedRules.push({ type, raw: typedRule });
  }

  return {
    rules: parsedRules,
    inputHadArray: true,
    inputLength: rules.length,
    invalidCount,
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRegistryPath(path: string): string {
  return path.trim().replace(/[\\/]+/g, '\\').toLowerCase();
}

function normalizeConfigPath(path: string): string {
  return path.trim().replace(/\/+/g, '/').toLowerCase();
}

function softwareNameMatches(installedName: string, expectedName: string): boolean {
  const installed = normalizeComparable(installedName);
  const expected = normalizeComparable(expectedName);

  return installed === expected || installed.includes(expected) || expected.includes(installed);
}

function compareVersionTokens(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftNumber = Number.parseInt(left, 10);
    const rightNumber = Number.parseInt(right, 10);
    if (leftNumber > rightNumber) return 1;
    if (leftNumber < rightNumber) return -1;
    return 0;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareVersions(leftVersion: string, rightVersion: string): number {
  const leftTokens = leftVersion.split(/[^0-9a-zA-Z]+/).filter((token) => token.length > 0);
  const rightTokens = rightVersion.split(/[^0-9a-zA-Z]+/).filter((token) => token.length > 0);
  const maxLength = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftToken = leftTokens[index] ?? '0';
    const rightToken = rightTokens[index] ?? '0';
    const tokenComparison = compareVersionTokens(leftToken, rightToken);

    if (tokenComparison > 0) {
      return 1;
    }
    if (tokenComparison < 0) {
      return -1;
    }
  }

  return 0;
}

function matchesVersionRequirement(
  installedVersion: string | null,
  requiredVersion: string | null,
  operator: VersionOperator
): boolean {
  if (operator === 'any') {
    return true;
  }

  if (!requiredVersion || !installedVersion) {
    return false;
  }

  const comparison = compareVersions(installedVersion, requiredVersion);

  if (operator === 'exact') {
    return comparison === 0;
  }
  if (operator === 'minimum') {
    return comparison >= 0;
  }
  if (operator === 'maximum') {
    return comparison <= 0;
  }
  return false;
}

export function __compareVersions(leftVersion: string, rightVersion: string): number {
  return compareVersions(leftVersion, rightVersion);
}

export function __matchesVersionRequirement(
  installedVersion: string | null,
  requiredVersion: string | null,
  operator: 'any' | 'exact' | 'minimum' | 'maximum'
): boolean {
  return matchesVersionRequirement(installedVersion, requiredVersion, operator);
}

function evaluateRequiredSoftwareRule(
  rule: ParsedRule,
  context: DeviceEvaluationContext
): RuleEvaluationDetail {
  const softwareName = readString(rule.raw.softwareName);
  if (!softwareName) {
    return {
      ruleType: rule.type,
      passed: false,
      message: 'Required software rule is missing softwareName.',
    };
  }

  const matchingSoftware = context.software.filter((entry) =>
    softwareNameMatches(entry.name, softwareName)
  );

  if (matchingSoftware.length === 0) {
    return {
      ruleType: rule.type,
      passed: false,
      message: `Required software "${softwareName}" is not installed.`,
    };
  }

  const operatorValue = readString(rule.raw.versionOperator)?.toLowerCase();
  const versionOperator: VersionOperator = operatorValue === 'exact'
    || operatorValue === 'minimum'
    || operatorValue === 'maximum'
    ? operatorValue
    : 'any';

  const requiredVersion = readString(rule.raw.softwareVersion);
  if (versionOperator !== 'any' && !requiredVersion) {
    return {
      ruleType: rule.type,
      passed: false,
      message: `Version operator "${versionOperator}" requires softwareVersion.`,
      data: { softwareName },
    };
  }

  const matchingByVersion = matchingSoftware.filter((entry) =>
    matchesVersionRequirement(entry.version, requiredVersion, versionOperator)
  );

  if (matchingByVersion.length === 0) {
    return {
      ruleType: rule.type,
      passed: false,
      message: `Installed versions for "${softwareName}" do not satisfy ${versionOperator} ${requiredVersion ?? ''}.`,
      data: {
        softwareName,
        installedVersions: matchingSoftware.map((entry) => entry.version ?? 'unknown'),
        requiredVersion,
        versionOperator,
      },
    };
  }

  return {
    ruleType: rule.type,
    passed: true,
    message: `Required software "${softwareName}" is installed.`,
  };
}

function evaluateProhibitedSoftwareRule(
  rule: ParsedRule,
  context: DeviceEvaluationContext
): RuleEvaluationDetail {
  const softwareName = readString(rule.raw.softwareName);
  if (!softwareName) {
    return {
      ruleType: rule.type,
      passed: false,
      message: 'Prohibited software rule is missing softwareName.',
    };
  }

  const matchingSoftware = context.software.filter((entry) =>
    softwareNameMatches(entry.name, softwareName)
  );

  if (matchingSoftware.length === 0) {
    return {
      ruleType: rule.type,
      passed: true,
      message: `Prohibited software "${softwareName}" is not installed.`,
    };
  }

  return {
    ruleType: rule.type,
    passed: false,
    message: `Prohibited software "${softwareName}" is installed.`,
    data: {
      installedVersions: matchingSoftware.map((entry) => entry.version ?? 'unknown'),
    },
  };
}

function diskMatchesPath(disk: DiskRecord, path: string): boolean {
  const normalizedPath = normalizeComparable(path);
  const mountPoint = normalizeComparable(disk.mountPoint);
  const devicePath = disk.device ? normalizeComparable(disk.device) : '';

  return mountPoint === normalizedPath
    || mountPoint.includes(normalizedPath)
    || normalizedPath.includes(mountPoint)
    || (devicePath.length > 0 && (
      devicePath === normalizedPath
      || devicePath.includes(normalizedPath)
      || normalizedPath.includes(devicePath)
    ));
}

function evaluateDiskSpaceRule(
  rule: ParsedRule,
  context: DeviceEvaluationContext
): RuleEvaluationDetail {
  const minimumFreeGb = readNumber(rule.raw.diskSpaceGB);
  if (minimumFreeGb === null) {
    return {
      ruleType: rule.type,
      passed: false,
      message: 'Disk space rule is missing diskSpaceGB.',
    };
  }

  const diskPath = readString(rule.raw.diskPath);
  const candidateDisks = diskPath
    ? context.disks.filter((disk) => diskMatchesPath(disk, diskPath))
    : context.disks;

  if (candidateDisks.length === 0) {
    return {
      ruleType: rule.type,
      passed: false,
      message: diskPath
        ? `No disk metrics found for path "${diskPath}".`
        : 'No disk metrics found for this device.',
    };
  }

  const failingDisks = candidateDisks.filter((disk) => disk.freeGb < minimumFreeGb);
  if (failingDisks.length > 0) {
    return {
      ruleType: rule.type,
      passed: false,
      message: `${failingDisks.length} disk(s) below minimum free space of ${minimumFreeGb}GB.`,
      data: {
        minimumFreeGb,
        failingDisks: failingDisks.map((disk) => ({
          mountPoint: disk.mountPoint,
          freeGb: disk.freeGb,
        })),
      },
    };
  }

  return {
    ruleType: rule.type,
    passed: true,
    message: `Disk free space meets minimum of ${minimumFreeGb}GB.`,
  };
}

function evaluateOsVersionRule(
  rule: ParsedRule,
  context: DeviceEvaluationContext
): RuleEvaluationDetail {
  const requiredOsType = readString(rule.raw.osType)?.toLowerCase() ?? 'any';
  const requiredMinVersion = readString(rule.raw.osMinVersion);
  const currentOsType = context.device.osType.toLowerCase();

  if (requiredOsType !== 'any' && currentOsType !== requiredOsType) {
    return {
      ruleType: rule.type,
      passed: false,
      message: `Device OS type ${context.device.osType} does not match required ${requiredOsType}.`,
    };
  }

  if (requiredMinVersion) {
    const comparison = compareVersions(context.device.osVersion, requiredMinVersion);
    if (comparison < 0) {
      return {
        ruleType: rule.type,
        passed: false,
        message: `Device OS version ${context.device.osVersion} is below required ${requiredMinVersion}.`,
      };
    }
  }

  return {
    ruleType: rule.type,
    passed: true,
    message: 'OS version requirement satisfied.',
  };
}

function evaluateRegistryCheckRule(
  rule: ParsedRule,
  context: DeviceEvaluationContext
): RuleEvaluationDetail {
  const registryPath = readString(rule.raw.registryPath);
  const valueName = readString(rule.raw.registryValueName);
  const expectedValue = readString(rule.raw.registryExpectedValue);

  if (!registryPath || !valueName) {
    return {
      ruleType: rule.type,
      passed: false,
      message: 'Registry rule requires registryPath and registryValueName.',
    };
  }

  if (context.device.osType.toLowerCase() !== 'windows') {
    return {
      ruleType: rule.type,
      passed: true,
      message: 'Registry rule not applicable to non-Windows device.',
    };
  }

  const normalizedPath = normalizeRegistryPath(registryPath);
  const normalizedValueName = normalizeComparable(valueName);
  const matched = context.registryState.find((entry) =>
    normalizeRegistryPath(entry.registryPath) === normalizedPath
    && normalizeComparable(entry.valueName) === normalizedValueName
  );

  if (!matched) {
    return {
      ruleType: rule.type,
      passed: false,
      message: `Registry value not found: ${registryPath}\\${valueName}.`,
    };
  }

  if (expectedValue !== null) {
    const actualValue = matched.valueData ?? '';
    if (normalizeComparable(actualValue) !== normalizeComparable(expectedValue)) {
      return {
        ruleType: rule.type,
        passed: false,
        message: `Registry value mismatch for ${registryPath}\\${valueName}.`,
        data: {
          expectedValue,
          actualValue,
          valueType: matched.valueType,
        },
      };
    }
  }

  return {
    ruleType: rule.type,
    passed: true,
    message: `Registry value matches for ${registryPath}\\${valueName}.`,
  };
}

function evaluateConfigCheckRule(
  rule: ParsedRule,
  context: DeviceEvaluationContext
): RuleEvaluationDetail {
  const filePath = readString(rule.raw.configFilePath);
  const configKey = readString(rule.raw.configKey);
  const expectedValue = readString(rule.raw.configExpectedValue);

  if (!filePath || !configKey) {
    return {
      ruleType: rule.type,
      passed: false,
      message: 'Config rule requires configFilePath and configKey.',
    };
  }

  const normalizedFilePath = normalizeConfigPath(filePath);
  const normalizedConfigKey = normalizeComparable(configKey);
  const matched = context.configState.find((entry) =>
    normalizeConfigPath(entry.filePath) === normalizedFilePath
    && normalizeComparable(entry.configKey) === normalizedConfigKey
  );

  if (!matched) {
    return {
      ruleType: rule.type,
      passed: false,
      message: `Config key not found: ${filePath} -> ${configKey}.`,
    };
  }

  if (expectedValue !== null) {
    const actualValue = matched.configValue ?? '';
    if (normalizeComparable(actualValue) !== normalizeComparable(expectedValue)) {
      return {
        ruleType: rule.type,
        passed: false,
        message: `Config value mismatch for ${filePath} -> ${configKey}.`,
        data: {
          expectedValue,
          actualValue,
        },
      };
    }
  }

  return {
    ruleType: rule.type,
    passed: true,
    message: `Config value matches for ${filePath} -> ${configKey}.`,
  };
}

function evaluateUnsupportedRule(
  rule: ParsedRule,
  reason: string
): RuleEvaluationDetail {
  return {
    ruleType: rule.type,
    passed: false,
    message: reason,
  };
}

function evaluateRule(
  rule: ParsedRule,
  context: DeviceEvaluationContext
): RuleEvaluationDetail {
  switch (rule.type) {
    case 'required_software':
      return evaluateRequiredSoftwareRule(rule, context);
    case 'prohibited_software':
      return evaluateProhibitedSoftwareRule(rule, context);
    case 'disk_space_minimum':
      return evaluateDiskSpaceRule(rule, context);
    case 'os_version':
      return evaluateOsVersionRule(rule, context);
    case 'registry_check':
      return evaluateRegistryCheckRule(rule, context);
    case 'config_check':
      return evaluateConfigCheckRule(rule, context);
    default:
      return evaluateUnsupportedRule(
        rule,
        `Unsupported policy rule type "${rule.type}".`
      );
  }
}

function evaluateDeviceRules(
  parsedRules: ParsedRulesResult,
  context: DeviceEvaluationContext
): DeviceRuleEvaluation {
  if (!parsedRules.inputHadArray) {
    return {
      passed: false,
      details: [{
        ruleType: 'policy_rules',
        passed: false,
        message: 'Policy rules payload is invalid: expected an array.',
      }],
    };
  }

  if (parsedRules.inputLength === 0) {
    return {
      passed: false,
      details: [{
        ruleType: 'policy_rules',
        passed: false,
        message: 'Policy has no rules to evaluate.',
      }],
    };
  }

  const details = parsedRules.rules.map((rule) => evaluateRule(rule, context));
  if (parsedRules.invalidCount > 0) {
    details.push({
      ruleType: 'policy_rules',
      passed: false,
      message: `Policy contains ${parsedRules.invalidCount} invalid rule(s).`,
      data: {
        invalidRuleCount: parsedRules.invalidCount,
        totalRules: parsedRules.inputLength,
      },
    });
  }

  const passed = parsedRules.invalidCount === 0
    && parsedRules.rules.length > 0
    && details.every((detail) => detail.passed);

  return { passed, details };
}

export function __evaluateRulesForDevice(
  rules: unknown,
  input: RuleEvaluationDebugInput
): RuleEvaluationDebugOutput {
  const parsedRules = parsePolicyRules(rules);
  const evaluation = evaluateDeviceRules(parsedRules, {
    device: {
      id: 'debug-device',
      hostname: 'debug-host',
      osType: input.device.osType,
      osVersion: input.device.osVersion,
    },
    software: input.software ?? [],
    disks: input.disks ?? [],
    registryState: input.registryState ?? [],
    configState: input.configState ?? [],
  });

  return {
    passed: evaluation.passed,
    details: evaluation.details,
  };
}

function dedupeTargetDevices(rows: TargetDevice[]): TargetDevice[] {
  const byId = new Map<string, TargetDevice>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

function buildDiskMap(rows: Array<{
  deviceId: string;
  mountPoint: string;
  device: string | null;
  freeGb: number;
}>): Map<string, DiskRecord[]> {
  const disksByDevice = new Map<string, DiskRecord[]>();
  for (const row of rows) {
    const disks = disksByDevice.get(row.deviceId) ?? [];
    disks.push({
      mountPoint: row.mountPoint,
      device: row.device,
      freeGb: row.freeGb,
    });
    disksByDevice.set(row.deviceId, disks);
  }
  return disksByDevice;
}

function buildSoftwareMap(rows: Array<{
  deviceId: string;
  name: string;
  version: string | null;
}>): Map<string, InstalledSoftwareRecord[]> {
  const softwareByDevice = new Map<string, InstalledSoftwareRecord[]>();
  const softwareKeysByDevice = new Map<string, Set<string>>();

  for (const row of rows) {
    const name = readString(row.name);
    if (!name) {
      continue;
    }

    const version = readString(row.version) ?? null;
    const dedupeKey = `${normalizeComparable(name)}:${normalizeComparable(version ?? 'unknown')}`;
    const existingKeys = softwareKeysByDevice.get(row.deviceId) ?? new Set<string>();
    if (existingKeys.has(dedupeKey)) {
      continue;
    }

    const software = softwareByDevice.get(row.deviceId) ?? [];
    software.push({ name, version });
    softwareByDevice.set(row.deviceId, software);

    existingKeys.add(dedupeKey);
    softwareKeysByDevice.set(row.deviceId, existingKeys);
  }

  return softwareByDevice;
}

function buildRegistryStateMap(rows: Array<{
  deviceId: string;
  registryPath: string;
  valueName: string;
  valueData: string | null;
  valueType: string | null;
}>): Map<string, RegistryStateRecord[]> {
  const registryByDevice = new Map<string, RegistryStateRecord[]>();
  for (const row of rows) {
    const state = registryByDevice.get(row.deviceId) ?? [];
    state.push({
      registryPath: row.registryPath,
      valueName: row.valueName,
      valueData: row.valueData,
      valueType: row.valueType,
    });
    registryByDevice.set(row.deviceId, state);
  }
  return registryByDevice;
}

function buildConfigStateMap(rows: Array<{
  deviceId: string;
  filePath: string;
  configKey: string;
  configValue: string | null;
}>): Map<string, ConfigStateRecord[]> {
  const configByDevice = new Map<string, ConfigStateRecord[]>();
  for (const row of rows) {
    const state = configByDevice.get(row.deviceId) ?? [];
    state.push({
      filePath: row.filePath,
      configKey: row.configKey,
      configValue: row.configValue,
    });
    configByDevice.set(row.deviceId, state);
  }
  return configByDevice;
}

function extractRemediationAutomationId(rules: unknown): string | null {
  if (!Array.isArray(rules)) {
    return null;
  }

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') {
      continue;
    }

    const typedRule = rule as Record<string, unknown>;

    if (typeof typedRule.remediationAutomationId === 'string') {
      return typedRule.remediationAutomationId;
    }

    const remediation = typedRule.remediation;
    if (remediation && typeof remediation === 'object') {
      const remediationConfig = remediation as Record<string, unknown>;
      if (typeof remediationConfig.automationId === 'string') {
        return remediationConfig.automationId;
      }
    }
  }

  return null;
}

function extractScriptIdFromAction(action: unknown): string | null {
  if (!action || typeof action !== 'object') {
    return null;
  }

  const typedAction = action as Record<string, unknown>;
  const directScriptId = typedAction.scriptId;
  if (typeof directScriptId === 'string' && directScriptId.length > 0) {
    return directScriptId;
  }

  const snakeScriptId = typedAction.script_id;
  if (typeof snakeScriptId === 'string' && snakeScriptId.length > 0) {
    return snakeScriptId;
  }

  return null;
}

export async function resolvePolicyRemediationAutomationId(policy: PolicyRow): Promise<string | null> {
  const explicitAutomationId = extractRemediationAutomationId(policy.rules);
  if (explicitAutomationId) {
    return explicitAutomationId;
  }

  if (!policy.remediationScriptId) {
    return null;
  }

  const candidates = await db
    .select({ id: automations.id, actions: automations.actions })
    .from(automations)
    .where(
      and(
        eq(automations.orgId, policy.orgId),
        eq(automations.enabled, true)
      )
    );

  for (const candidate of candidates) {
    if (!Array.isArray(candidate.actions)) {
      continue;
    }

    for (const action of candidate.actions) {
      const scriptId = extractScriptIdFromAction(action);
      if (scriptId === policy.remediationScriptId) {
        return candidate.id;
      }
    }
  }

  return null;
}

async function resolveTargetDevices(policy: PolicyRow): Promise<TargetDevice[]> {
  const targets = normalizeTargetConfig(policy.targets);

  if (targets.deviceIds && targets.deviceIds.length > 0) {
    return db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        osType: devices.osType,
        osVersion: devices.osVersion,
      })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, policy.orgId),
          inArray(devices.id, targets.deviceIds)
        )
      );
  }

  if (targets.siteIds && targets.siteIds.length > 0) {
    return db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        osType: devices.osType,
        osVersion: devices.osVersion,
      })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, policy.orgId),
          inArray(devices.siteId, targets.siteIds)
        )
      );
  }

  if (targets.groupIds && targets.groupIds.length > 0) {
    return db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        osType: devices.osType,
        osVersion: devices.osVersion,
      })
      .from(devices)
      .innerJoin(deviceGroupMemberships, eq(deviceGroupMemberships.deviceId, devices.id))
      .where(
        and(
          eq(devices.orgId, policy.orgId),
          inArray(deviceGroupMemberships.groupId, targets.groupIds)
        )
      );
  }

  if (targets.tags && targets.tags.length > 0) {
    return db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        osType: devices.osType,
        osVersion: devices.osVersion,
      })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, policy.orgId),
          sql<boolean>`${devices.tags} && ${targets.tags}`
        )
      );
  }

  return db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      osVersion: devices.osVersion,
    })
    .from(devices)
    .where(eq(devices.orgId, policy.orgId));
}

async function triggerRemediationAutomation(
  policy: PolicyRow,
  device: TargetDevice,
  status: EvaluationStatus,
  remediationAutomationId: string | null
): Promise<string | null> {
  if (status !== 'non_compliant' || !remediationAutomationId) {
    return null;
  }

  const [automation] = await db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.id, remediationAutomationId),
        eq(automations.orgId, policy.orgId)
      )
    )
    .limit(1);

  if (!automation || !automation.enabled) {
    return null;
  }

  const [run] = await db
    .insert(automationRuns)
    .values({
      automationId: automation.id,
      triggeredBy: `policy:${policy.id}`,
      status: 'running',
      devicesTargeted: 1,
      devicesSucceeded: 0,
      devicesFailed: 0,
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Triggered by policy ${policy.name} for device ${device.hostname}`,
          policyId: policy.id,
          deviceId: device.id,
        },
      ],
    })
    .returning();

  if (!run) {
    return null;
  }

  await db
    .update(automations)
    .set({
      runCount: sql`${automations.runCount} + 1`,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(automations.id, automation.id));

  // Keep behavior consistent with manual trigger route while avoiding model coupling.
  setTimeout(async () => {
    try {
      await db
        .update(automationRuns)
        .set({
          status: 'completed',
          devicesSucceeded: 1,
          completedAt: new Date(),
          logs: [
            ...(Array.isArray(run.logs) ? run.logs : []),
            {
              timestamp: new Date().toISOString(),
              level: 'info',
              message: 'Policy remediation automation completed',
              policyId: policy.id,
              deviceId: device.id,
            },
          ],
        })
        .where(eq(automationRuns.id, run.id));
    } catch {
      // Non-critical completion simulation.
    }
  }, 1000);

  return run.id;
}

async function publishPolicyEvents(
  policy: PolicyRow,
  device: TargetDevice,
  status: EvaluationStatus,
  previousStatus: string | null,
  remediationRunId: string | null,
  source: string
): Promise<void> {
  const basePayload = {
    policyId: policy.id,
    policyName: policy.name,
    deviceId: device.id,
    hostname: device.hostname,
    status,
    previousStatus,
    enforcement: policy.enforcement,
    remediationRunId,
    evaluatedAt: new Date().toISOString(),
  };

  const publishSafely = async (eventType: 'policy.evaluated' | 'policy.violation' | 'policy.compliant' | 'policy.remediation.triggered') => {
    try {
      await publishEvent(eventType, policy.orgId, basePayload, source);
    } catch (error) {
      console.error(`[PolicyEvaluation] Failed to publish ${eventType}:`, error);
    }
  };

  await publishSafely('policy.evaluated');

  if (status === 'non_compliant') {
    await publishSafely('policy.violation');
    if (remediationRunId) {
      await publishSafely('policy.remediation.triggered');
    }
  } else {
    await publishSafely('policy.compliant');
  }
}

export async function evaluatePolicy(
  policy: PolicyRow,
  options: EvaluatePolicyOptions = {}
): Promise<PolicyEvaluationResponse> {
  const source = options.source ?? 'policy-evaluation-service';
  const requestRemediation = options.requestRemediation ?? true;
  const remediationAutomationId = requestRemediation && policy.enforcement === 'enforce'
    ? await resolvePolicyRemediationAutomationId(policy)
    : null;

  const targetDevices = dedupeTargetDevices(await resolveTargetDevices(policy));
  const targetDeviceIds = targetDevices.map((device) => device.id);
  const parsedRules = parsePolicyRules(policy.rules);
  const ruleKeys = parsedRules.rules.map((rule) => rule.type);

  let existingComplianceRows: Array<typeof automationPolicyCompliance.$inferSelect> = [];
  let diskRows: Array<{
    deviceId: string;
    mountPoint: string;
    device: string | null;
    freeGb: number;
  }> = [];
  let softwareRows: Array<{
    deviceId: string;
    name: string;
    version: string | null;
  }> = [];
  let registryRows: Array<{
    deviceId: string;
    registryPath: string;
    valueName: string;
    valueData: string | null;
    valueType: string | null;
  }> = [];
  let configRows: Array<{
    deviceId: string;
    filePath: string;
    configKey: string;
    configValue: string | null;
  }> = [];

  if (targetDeviceIds.length > 0) {
    const [
      existingRows,
      disks,
      installedSoftwareRows,
      inventoryRows,
      registryStateRows,
      configStateRows
    ] = await Promise.all([
      db
        .select()
        .from(automationPolicyCompliance)
        .where(
          and(
            eq(automationPolicyCompliance.policyId, policy.id),
            inArray(automationPolicyCompliance.deviceId, targetDeviceIds)
          )
        ),
      db
        .select({
          deviceId: deviceDisks.deviceId,
          mountPoint: deviceDisks.mountPoint,
          device: deviceDisks.device,
          freeGb: deviceDisks.freeGb,
        })
        .from(deviceDisks)
        .where(inArray(deviceDisks.deviceId, targetDeviceIds)),
      db
        .select({
          deviceId: deviceSoftware.deviceId,
          name: deviceSoftware.name,
          version: deviceSoftware.version,
        })
        .from(deviceSoftware)
        .where(inArray(deviceSoftware.deviceId, targetDeviceIds)),
      db
        .select({
          deviceId: softwareInventory.deviceId,
          name: softwareInventory.name,
          version: softwareInventory.version,
        })
        .from(softwareInventory)
        .where(inArray(softwareInventory.deviceId, targetDeviceIds)),
      db
        .select({
          deviceId: deviceRegistryState.deviceId,
          registryPath: deviceRegistryState.registryPath,
          valueName: deviceRegistryState.valueName,
          valueData: deviceRegistryState.valueData,
          valueType: deviceRegistryState.valueType,
        })
        .from(deviceRegistryState)
        .where(inArray(deviceRegistryState.deviceId, targetDeviceIds)),
      db
        .select({
          deviceId: deviceConfigState.deviceId,
          filePath: deviceConfigState.filePath,
          configKey: deviceConfigState.configKey,
          configValue: deviceConfigState.configValue,
        })
        .from(deviceConfigState)
        .where(inArray(deviceConfigState.deviceId, targetDeviceIds)),
    ]);

    existingComplianceRows = existingRows;
    diskRows = disks;
    softwareRows = [...installedSoftwareRows, ...inventoryRows];
    registryRows = registryStateRows;
    configRows = configStateRows;
  }

  const evaluationResults: PolicyEvaluationResult[] = [];
  const existingByDeviceId = new Map<string, typeof automationPolicyCompliance.$inferSelect>();
  for (const row of existingComplianceRows) {
    existingByDeviceId.set(row.deviceId, row);
  }

  const disksByDevice = buildDiskMap(diskRows);
  const softwareByDevice = buildSoftwareMap(softwareRows);
  const registryStateByDevice = buildRegistryStateMap(registryRows);
  const configStateByDevice = buildConfigStateMap(configRows);

  for (const device of targetDevices) {
    const existing = existingByDeviceId.get(device.id);
    const evaluation = evaluateDeviceRules(parsedRules, {
      device,
      software: softwareByDevice.get(device.id) ?? [],
      disks: disksByDevice.get(device.id) ?? [],
      registryState: registryStateByDevice.get(device.id) ?? [],
      configState: configStateByDevice.get(device.id) ?? [],
    });
    const status: EvaluationStatus = evaluation.passed ? 'compliant' : 'non_compliant';
    const details = {
      evaluatedAt: new Date().toISOString(),
      rules: ruleKeys,
      passed: evaluation.passed,
      ruleResults: evaluation.details,
      source,
    };

    if (existing) {
      await db
        .update(automationPolicyCompliance)
        .set({
          status,
          details,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(automationPolicyCompliance.id, existing.id));
    } else {
      await db
        .insert(automationPolicyCompliance)
        .values({
          policyId: policy.id,
          deviceId: device.id,
          status,
          details,
          lastCheckedAt: new Date(),
        });
    }

    const remediationRunId = requestRemediation
      ? await triggerRemediationAutomation(policy, device, status, remediationAutomationId)
      : null;

    evaluationResults.push({
      deviceId: device.id,
      hostname: device.hostname,
      status,
      previousStatus: existing?.status ?? null,
      remediationRunId,
    });

    await publishPolicyEvents(
      policy,
      device,
      status,
      existing?.status ?? null,
      remediationRunId,
      source
    );
  }

  await db
    .update(automationPolicies)
    .set({
      lastEvaluatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(automationPolicies.id, policy.id));

  return {
    message: 'Policy evaluation completed',
    policyId: policy.id,
    devicesEvaluated: targetDevices.length,
    results: evaluationResults,
    summary: {
      compliant: evaluationResults.filter((result) => result.status === 'compliant').length,
      non_compliant: evaluationResults.filter((result) => result.status === 'non_compliant').length,
    },
    evaluatedAt: new Date().toISOString(),
  };
}
