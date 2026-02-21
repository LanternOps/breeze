import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  deviceGroupMemberships,
  deviceGroups,
  devices,
  softwareComplianceStatus,
  softwareInventory,
  softwarePolicies,
  softwarePolicyAudit,
  type SoftwarePolicyRuleDefinition,
  type SoftwarePolicyRulesDefinition,
  type SoftwarePolicyViolation,
} from '../db/schema';

const BULK_CHUNK_SIZE = 500;

type SoftwarePolicyRow = typeof softwarePolicies.$inferSelect;

export type SoftwareInventoryRow = {
  name: string;
  version: string | null;
  vendor: string | null;
  catalogId: string | null;
};

export type SoftwarePolicyComplianceStatus = 'compliant' | 'violation' | 'unknown';
export type SoftwarePolicyRemediationStatus = 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';

export type SoftwareComplianceUpsertInput = {
  deviceId: string;
  policyId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: SoftwarePolicyViolation[];
  checkedAt?: Date;
  remediationStatus?: SoftwarePolicyRemediationStatus;
};

type DeviceSoftwareInventoryRow = SoftwareInventoryRow & {
  deviceId: string;
};

function chunkArray<T>(items: T[], size = BULK_CHUNK_SIZE): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareVersionTokens(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    const leftNum = Number.parseInt(left, 10);
    const rightNum = Number.parseInt(right, 10);
    if (leftNum > rightNum) return 1;
    if (leftNum < rightNum) return -1;
    return 0;
  }

  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function compareSoftwareVersions(leftVersion: string, rightVersion: string): number {
  const leftTokens = leftVersion.split(/[^0-9a-zA-Z]+/).filter((token) => token.length > 0);
  const rightTokens = rightVersion.split(/[^0-9a-zA-Z]+/).filter((token) => token.length > 0);
  const maxLength = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = leftTokens[index] ?? '0';
    const right = rightTokens[index] ?? '0';
    const comparison = compareVersionTokens(left, right);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function violationFingerprint(violation: SoftwarePolicyViolation): string {
  const type = violation.type.toLowerCase();
  if (violation.type === 'unauthorized') {
    const name = normalizeComparable(violation.software?.name ?? '');
    const version = normalizeComparable(violation.software?.version ?? '');
    return `${type}:software:${name}:${version}`;
  }

  const ruleName = normalizeComparable(violation.rule?.name ?? '');
  const minVersion = normalizeComparable(violation.rule?.minVersion ?? '');
  const maxVersion = normalizeComparable(violation.rule?.maxVersion ?? '');
  return `${type}:rule:${ruleName}:${minVersion}:${maxVersion}`;
}

export function withStableViolationTimestamps(
  nextViolations: SoftwarePolicyViolation[],
  previousViolations: unknown
): SoftwarePolicyViolation[] {
  if (!Array.isArray(previousViolations) || nextViolations.length === 0) {
    return nextViolations;
  }

  const previousByKey = new Map<string, string>();
  for (const raw of previousViolations) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as SoftwarePolicyViolation;
    const key = violationFingerprint(candidate);
    if (!key) continue;
    const detectedAt = candidate.detectedAt;
    if (typeof detectedAt !== 'string') continue;
    const normalized = new Date(detectedAt);
    if (Number.isNaN(normalized.getTime())) continue;
    const existing = previousByKey.get(key);
    if (!existing || normalized.getTime() < new Date(existing).getTime()) {
      previousByKey.set(key, normalized.toISOString());
    }
  }

  return nextViolations.map((violation) => {
    const key = violationFingerprint(violation);
    const previousDetectedAt = previousByKey.get(key);
    if (!previousDetectedAt) return violation;
    return {
      ...violation,
      detectedAt: previousDetectedAt,
    };
  });
}

export function normalizeSoftwarePolicyRules(rules: unknown): SoftwarePolicyRulesDefinition {
  if (!rules || typeof rules !== 'object') {
    return { software: [], allowUnknown: false };
  }

  const raw = rules as Record<string, unknown>;
  const rawSoftware = Array.isArray(raw.software) ? raw.software : [];

  const software = rawSoftware
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => {
      const name = readOptionalString(entry.name);
      if (!name) {
        return null;
      }

      const rule: SoftwarePolicyRuleDefinition = { name };
      const vendor = readOptionalString(entry.vendor);
      const minVersion = readOptionalString(entry.minVersion);
      const maxVersion = readOptionalString(entry.maxVersion);
      const catalogId = readOptionalString(entry.catalogId);
      const reason = readOptionalString(entry.reason);

      if (vendor) rule.vendor = vendor;
      if (minVersion) rule.minVersion = minVersion;
      if (maxVersion) rule.maxVersion = maxVersion;
      if (catalogId) rule.catalogId = catalogId;
      if (reason) rule.reason = reason;

      return rule;
    })
    .filter((entry): entry is SoftwarePolicyRuleDefinition => entry !== null);

  return {
    software,
    allowUnknown: raw.allowUnknown === true,
  };
}

export function matchesSoftwareRule(
  installed: SoftwareInventoryRow,
  rule: SoftwarePolicyRuleDefinition
): boolean {
  if (rule.catalogId && installed.catalogId && installed.catalogId !== rule.catalogId) {
    return false;
  }

  const pattern = `^${escapeRegExp(rule.name).replace(/\\\*/g, '.*')}$`;
  const nameRegex = new RegExp(pattern, 'i');
  if (!nameRegex.test(installed.name)) {
    return false;
  }

  if (rule.vendor && normalizeComparable(installed.vendor ?? '') !== normalizeComparable(rule.vendor)) {
    return false;
  }

  if (rule.minVersion) {
    if (!installed.version) return false;
    if (compareSoftwareVersions(installed.version, rule.minVersion) < 0) return false;
  }

  if (rule.maxVersion) {
    if (!installed.version) return false;
    if (compareSoftwareVersions(installed.version, rule.maxVersion) > 0) return false;
  }

  return true;
}

export function evaluateSoftwareInventory(
  mode: typeof softwarePolicies.$inferSelect.mode,
  rules: SoftwarePolicyRulesDefinition,
  inventory: SoftwareInventoryRow[]
): SoftwarePolicyViolation[] {
  const violations: SoftwarePolicyViolation[] = [];
  const detectedAt = new Date().toISOString();
  const softwareRules = rules.software ?? [];
  const allowUnknown = rules.allowUnknown === true;

  if (mode === 'allowlist') {
    for (const installed of inventory) {
      const allowed = softwareRules.some((rule) => matchesSoftwareRule(installed, rule));
      if (!allowed && !allowUnknown) {
        violations.push({
          type: 'unauthorized',
          software: {
            name: installed.name,
            version: installed.version,
            vendor: installed.vendor,
          },
          severity: 'medium',
          detectedAt,
        });
      }
    }

    for (const rule of softwareRules) {
      const found = inventory.some((installed) => matchesSoftwareRule(installed, rule));
      if (!found) {
        violations.push({
          type: 'missing',
          rule: {
            name: rule.name,
            minVersion: rule.minVersion,
            maxVersion: rule.maxVersion,
          },
          severity: 'high',
          detectedAt,
        });
      }
    }

    return violations;
  }

  // Audit mode uses blocklist-style detection but does not auto-remediate.
  for (const installed of inventory) {
    const matchedRule = softwareRules.find((rule) => matchesSoftwareRule(installed, rule));
    if (!matchedRule) continue;

    violations.push({
      type: 'unauthorized',
      software: {
        name: installed.name,
        version: installed.version,
        vendor: installed.vendor,
      },
      rule: {
        name: matchedRule.name,
        minVersion: matchedRule.minVersion,
        maxVersion: matchedRule.maxVersion,
        reason: matchedRule.reason,
      },
      severity: mode === 'blocklist' ? 'critical' : 'medium',
      detectedAt,
    });
  }

  return violations;
}

export function evaluateSoftwarePolicyAgainstInventory(
  policy: Pick<typeof softwarePolicies.$inferSelect, 'mode' | 'rules'>,
  inventory: SoftwareInventoryRow[]
): {
  status: Exclude<SoftwarePolicyComplianceStatus, 'unknown'>;
  violations: SoftwarePolicyViolation[];
} {
  const rules = normalizeSoftwarePolicyRules(policy.rules);
  const violations = evaluateSoftwareInventory(policy.mode, rules, inventory);
  return {
    status: violations.length > 0 ? 'violation' : 'compliant',
    violations,
  };
}

export async function resolveTargetDeviceIdsForPolicy(
  policy: Pick<typeof softwarePolicies.$inferSelect, 'orgId' | 'targetType' | 'targetIds'>
): Promise<string[]> {
  const targetIds = Array.isArray(policy.targetIds)
    ? policy.targetIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  if (policy.targetType === 'devices') {
    if (targetIds.length === 0) return [];
    const rows = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.orgId, policy.orgId),
        inArray(devices.id, targetIds),
      ));
    return rows.map((row) => row.id);
  }

  if (policy.targetType === 'site' || policy.targetType === 'sites') {
    if (targetIds.length === 0) return [];
    const rows = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.orgId, policy.orgId),
        inArray(devices.siteId, targetIds),
      ));
    return rows.map((row) => row.id);
  }

  if (policy.targetType === 'device_group' || policy.targetType === 'groups') {
    if (targetIds.length === 0) return [];
    const rows = await db
      .selectDistinct({ id: devices.id })
      .from(deviceGroupMemberships)
      .innerJoin(deviceGroups, eq(deviceGroupMemberships.groupId, deviceGroups.id))
      .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
      .where(and(
        eq(deviceGroups.orgId, policy.orgId),
        eq(devices.orgId, policy.orgId),
        inArray(deviceGroupMemberships.groupId, targetIds),
      ));
    return rows.map((row) => row.id);
  }

  console.warn(
    `[softwarePolicyService] resolveTargetDeviceIdsForPolicy: unrecognized targetType "${policy.targetType}" for policy in org ${policy.orgId} — returning empty device list`
  );
  return [];
}

function isHigherPrecedencePolicy(
  candidate: Pick<typeof softwarePolicies.$inferSelect, 'id' | 'priority' | 'updatedAt'>,
  baseline: Pick<typeof softwarePolicies.$inferSelect, 'id' | 'priority' | 'updatedAt'>
): boolean {
  if (candidate.priority !== baseline.priority) {
    return candidate.priority > baseline.priority;
  }

  const candidateUpdatedAt = candidate.updatedAt?.getTime() ?? 0;
  const baselineUpdatedAt = baseline.updatedAt?.getTime() ?? 0;
  if (candidateUpdatedAt !== baselineUpdatedAt) {
    return candidateUpdatedAt > baselineUpdatedAt;
  }

  return candidate.id.localeCompare(baseline.id) > 0;
}

export async function resolveEffectivePolicyDeviceIds(
  policy: Pick<typeof softwarePolicies.$inferSelect, 'id' | 'orgId' | 'targetType' | 'targetIds' | 'priority' | 'updatedAt'>,
  targetDeviceIds: string[]
): Promise<{
  effectiveDeviceIds: string[];
  shadowedByDeviceId: Map<string, string>;
}> {
  const normalizedTargetIds = Array.from(
    new Set(targetDeviceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
  );
  if (normalizedTargetIds.length === 0) {
    return { effectiveDeviceIds: [], shadowedByDeviceId: new Map() };
  }

  const activePolicies = await db
    .select({
      id: softwarePolicies.id,
      orgId: softwarePolicies.orgId,
      targetType: softwarePolicies.targetType,
      targetIds: softwarePolicies.targetIds,
      priority: softwarePolicies.priority,
      updatedAt: softwarePolicies.updatedAt,
    })
    .from(softwarePolicies)
    .where(and(
      eq(softwarePolicies.orgId, policy.orgId),
      eq(softwarePolicies.isActive, true),
    ));

  const higherPrecedencePolicies = activePolicies.filter((candidate) => {
    if (candidate.id === policy.id) return false;
    return isHigherPrecedencePolicy(candidate, policy);
  });

  if (higherPrecedencePolicies.length === 0) {
    return {
      effectiveDeviceIds: normalizedTargetIds,
      shadowedByDeviceId: new Map(),
    };
  }

  const targetDeviceIdSet = new Set(normalizedTargetIds);
  const shadowedByDeviceId = new Map<string, string>();

  for (const higherPolicy of higherPrecedencePolicies) {
    const higherTargetDeviceIds = await resolveTargetDeviceIdsForPolicy(higherPolicy);
    for (const deviceId of higherTargetDeviceIds) {
      if (!targetDeviceIdSet.has(deviceId) || shadowedByDeviceId.has(deviceId)) {
        continue;
      }
      shadowedByDeviceId.set(deviceId, higherPolicy.id);
    }
  }

  const effectiveDeviceIds = normalizedTargetIds.filter((deviceId) => !shadowedByDeviceId.has(deviceId));
  return {
    effectiveDeviceIds,
    shadowedByDeviceId,
  };
}

export async function getSoftwareInventoryByDeviceIds(
  deviceIds: string[]
): Promise<Map<string, SoftwareInventoryRow[]>> {
  const normalizedDeviceIds = Array.from(
    new Set(deviceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
  );
  const byDeviceId = new Map<string, SoftwareInventoryRow[]>();
  if (normalizedDeviceIds.length === 0) {
    return byDeviceId;
  }

  for (const deviceId of normalizedDeviceIds) {
    byDeviceId.set(deviceId, []);
  }

  for (const chunk of chunkArray(normalizedDeviceIds)) {
    const rows = await db
      .select({
        deviceId: softwareInventory.deviceId,
        name: softwareInventory.name,
        version: softwareInventory.version,
        vendor: softwareInventory.vendor,
        catalogId: softwareInventory.catalogId,
      })
      .from(softwareInventory)
      .where(inArray(softwareInventory.deviceId, chunk));

    for (const row of rows as DeviceSoftwareInventoryRow[]) {
      const bucket = byDeviceId.get(row.deviceId);
      if (!bucket) continue;
      bucket.push({
        name: row.name,
        version: row.version,
        vendor: row.vendor,
        catalogId: row.catalogId,
      });
    }
  }

  return byDeviceId;
}

export async function evaluateSoftwarePolicyForDevice(
  policy: typeof softwarePolicies.$inferSelect,
  deviceId: string
): Promise<{
  status: Exclude<SoftwarePolicyComplianceStatus, 'unknown'>;
  violations: SoftwarePolicyViolation[];
}> {
  const inventory = await db
    .select({
      name: softwareInventory.name,
      version: softwareInventory.version,
      vendor: softwareInventory.vendor,
      catalogId: softwareInventory.catalogId,
    })
    .from(softwareInventory)
    .where(eq(softwareInventory.deviceId, deviceId));

  return evaluateSoftwarePolicyAgainstInventory(policy, inventory);
}

export async function upsertSoftwareComplianceStatuses(
  inputs: SoftwareComplianceUpsertInput[]
): Promise<void> {
  if (inputs.length === 0) return;

  const normalized = inputs.filter((input) => (
    typeof input.deviceId === 'string'
    && input.deviceId.length > 0
    && typeof input.policyId === 'string'
    && input.policyId.length > 0
  ));
  if (normalized.length === 0) return;

  const withRemediationStatus = normalized.filter((input) => input.remediationStatus !== undefined);
  const withoutRemediationStatus = normalized.filter((input) => input.remediationStatus === undefined);

  for (const chunk of chunkArray(withoutRemediationStatus)) {
    if (chunk.length === 0) continue;
    await db
      .insert(softwareComplianceStatus)
      .values(chunk.map((input) => ({
        deviceId: input.deviceId,
        policyId: input.policyId,
        status: input.status,
        violations: input.violations,
        lastChecked: input.checkedAt ?? new Date(),
      })))
      .onConflictDoUpdate({
        target: [softwareComplianceStatus.deviceId, softwareComplianceStatus.policyId],
        set: {
          status: sql`excluded.status`,
          violations: sql`excluded.violations`,
          lastChecked: sql`excluded.last_checked`,
        },
      });
  }

  for (const chunk of chunkArray(withRemediationStatus)) {
    if (chunk.length === 0) continue;
    await db
      .insert(softwareComplianceStatus)
      .values(chunk.map((input) => ({
        deviceId: input.deviceId,
        policyId: input.policyId,
        status: input.status,
        violations: input.violations,
        lastChecked: input.checkedAt ?? new Date(),
        remediationStatus: input.remediationStatus,
      })))
      .onConflictDoUpdate({
        target: [softwareComplianceStatus.deviceId, softwareComplianceStatus.policyId],
        set: {
          status: sql`excluded.status`,
          violations: sql`excluded.violations`,
          lastChecked: sql`excluded.last_checked`,
          remediationStatus: sql`excluded.remediation_status`,
        },
      });
  }
}

export async function upsertSoftwareComplianceStatus(params: {
  deviceId: string;
  policyId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: SoftwarePolicyViolation[];
  remediationStatus?: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';
}): Promise<void> {
  await upsertSoftwareComplianceStatuses([{
    deviceId: params.deviceId,
    policyId: params.policyId,
    status: params.status,
    violations: params.violations,
    checkedAt: new Date(),
    remediationStatus: params.remediationStatus,
  }]);
}

export async function recordSoftwarePolicyAudit(input: {
  orgId: string;
  policyId?: string | null;
  deviceId?: string | null;
  action: string;
  actor: 'user' | 'system' | 'ai';
  actorId?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(softwarePolicyAudit).values({
      orgId: input.orgId,
      policyId: input.policyId ?? null,
      deviceId: input.deviceId ?? null,
      action: input.action,
      actor: input.actor,
      actorId: input.actorId ?? null,
      details: input.details ?? null,
    });
  } catch (err) {
    console.error('[softwarePolicyService] Failed to write policy audit record', {
      orgId: input.orgId,
      policyId: input.policyId,
      deviceId: input.deviceId,
      action: input.action,
      error: err,
    });
  }
}
