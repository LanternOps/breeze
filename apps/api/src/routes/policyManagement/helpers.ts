import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  automationPolicies,
  automationPolicyCompliance,
  configPolicyFeatureLinks,
  configPolicyComplianceRules,
  configurationPolicies,
  devices,
} from '../../db/schema';
import { AuthContext, TargetType, targetTypeSchema, uuidRegex } from './schemas';

export { getPagination } from '../../utils/pagination';

export function ensureOrgAccess(orgId: string, auth: AuthContext) {
  if (typeof auth.canAccessOrg === 'function') {
    return auth.canAccessOrg(orgId);
  }

  if (auth.scope === 'system') {
    return true;
  }

  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    return orgIds.includes(orgId);
  }

  return false;
}

export async function getPolicyWithOrgCheck(policyId: string, auth: AuthContext) {
  const [policy] = await db
    .select()
    .from(automationPolicies)
    .where(eq(automationPolicies.id, policyId))
    .limit(1);

  if (!policy) {
    return null;
  }

  const hasAccess = ensureOrgAccess(policy.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return policy;
}

export function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function sanitizeUuidArray(value: unknown): string[] {
  return sanitizeStringArray(value).filter((item) => uuidRegex.test(item));
}

export function coerceTargetType(value: unknown, fallback: TargetType = 'all'): TargetType {
  const parsed = targetTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function validateTargetIdsForType(targetType: string, targetIds: string[]): string | null {
  if (targetType === 'all') {
    return null;
  }

  if (targetIds.length === 0) {
    return 'targetIds are required when targetType is not all';
  }

  if (targetType === 'tags') {
    return null;
  }

  if (targetIds.some((id) => !uuidRegex.test(id))) {
    return `targetIds must be UUIDs when targetType is ${targetType}`;
  }

  return null;
}

export function normalizeTargets(payload: {
  targets?: unknown;
  targetType?: TargetType;
  targetIds?: string[];
}) {
  if (payload.targets && typeof payload.targets === 'object') {
    const rawTargets = payload.targets as Record<string, unknown>;
    const payloadTargetType = payload.targetType ?? 'all';
    const targetType = coerceTargetType(rawTargets.targetType, payloadTargetType);
    const candidateTargetIds = sanitizeStringArray(rawTargets.targetIds);
    const targetIds = candidateTargetIds.length > 0
      ? candidateTargetIds
      : sanitizeStringArray(payload.targetIds);

    const tags = sanitizeStringArray(rawTargets.tags);
    const normalizedTags = tags.length > 0
      ? tags
      : targetType === 'tags'
        ? targetIds
        : [];

    const normalized = {
      ...rawTargets,
      targetType,
      targetIds,
      deviceIds: sanitizeUuidArray(rawTargets.deviceIds),
      siteIds: sanitizeUuidArray(rawTargets.siteIds),
      groupIds: sanitizeUuidArray(rawTargets.groupIds),
      tags: normalizedTags,
    };

    if (normalized.deviceIds.length === 0 && targetType === 'devices') {
      normalized.deviceIds = sanitizeUuidArray(targetIds);
    }
    if (normalized.siteIds.length === 0 && targetType === 'sites') {
      normalized.siteIds = sanitizeUuidArray(targetIds);
    }
    if (normalized.groupIds.length === 0 && targetType === 'groups') {
      normalized.groupIds = sanitizeUuidArray(targetIds);
    }

    return normalized;
  }

  const targetType = payload.targetType ?? 'all';
  const targetIds = sanitizeStringArray(payload.targetIds);

  return {
    targetType,
    targetIds,
    deviceIds: targetType === 'devices' ? sanitizeUuidArray(targetIds) : [],
    siteIds: targetType === 'sites' ? sanitizeUuidArray(targetIds) : [],
    groupIds: targetType === 'groups' ? sanitizeUuidArray(targetIds) : [],
    tags: targetType === 'tags' ? targetIds : [],
  };
}

export function resolveTargetInfo(targets: unknown): { targetType: string; targetIds: string[] } {
  if (!targets || typeof targets !== 'object') {
    return { targetType: 'all', targetIds: [] };
  }

  const rawTargets = targets as Record<string, unknown>;
  const explicitType = typeof rawTargets.targetType === 'string' ? rawTargets.targetType : undefined;
  const explicitIds = sanitizeStringArray(rawTargets.targetIds);

  if (explicitType) {
    return {
      targetType: explicitType,
      targetIds: explicitIds,
    };
  }

  const deviceIds = sanitizeUuidArray(rawTargets.deviceIds);
  const siteIds = sanitizeUuidArray(rawTargets.siteIds);
  const groupIds = sanitizeUuidArray(rawTargets.groupIds);
  const tags = sanitizeStringArray(rawTargets.tags);

  if (deviceIds.length > 0) return { targetType: 'devices', targetIds: deviceIds };
  if (siteIds.length > 0) return { targetType: 'sites', targetIds: siteIds };
  if (groupIds.length > 0) return { targetType: 'groups', targetIds: groupIds };
  if (tags.length > 0) return { targetType: 'tags', targetIds: tags };

  return { targetType: 'all', targetIds: [] };
}

export function buildComplianceSummary(rows: Array<{ status: string; count: number }>) {
  let compliant = 0;
  let nonCompliant = 0;
  let pending = 0;
  let error = 0;

  for (const row of rows) {
    const count = Number(row.count);
    if (row.status === 'compliant') compliant += count;
    else if (row.status === 'non_compliant') nonCompliant += count;
    else if (row.status === 'pending') pending += count;
    else if (row.status === 'error') error += count;
  }

  const unknown = pending + error;
  const total = compliant + nonCompliant + unknown;

  return {
    total,
    compliant,
    nonCompliant,
    non_compliant: nonCompliant,
    unknown,
    pending,
    error,
  };
}

type PolicyViolation = {
  policyId: string;
  policyName: string;
  ruleName: string;
  message: string;
};

export function extractViolationsFromComplianceDetails(
  details: unknown,
  policyId: string,
  policyName: string
): PolicyViolation[] {
  if (!details || typeof details !== 'object') {
    return [{
      policyId,
      policyName,
      ruleName: 'Policy evaluation',
      message: 'Device is non-compliant with this policy.',
    }];
  }

  const detailsRecord = details as Record<string, unknown>;
  if (!Array.isArray(detailsRecord.ruleResults)) {
    return [{
      policyId,
      policyName,
      ruleName: 'Policy evaluation',
      message: 'Device is non-compliant with this policy.',
    }];
  }

  const failedViolations = detailsRecord.ruleResults
    .flatMap((ruleResult): PolicyViolation[] => {
      if (!ruleResult || typeof ruleResult !== 'object') {
        return [];
      }

      const typedResult = ruleResult as Record<string, unknown>;
      if (typedResult.passed !== false) {
        return [];
      }

      const ruleType = typeof typedResult.ruleType === 'string' && typedResult.ruleType.length > 0
        ? typedResult.ruleType
        : 'Policy rule';
      const message = typeof typedResult.message === 'string' && typedResult.message.length > 0
        ? typedResult.message
        : 'Device failed a policy rule.';

      return [{
        policyId,
        policyName,
        ruleName: ruleType,
        message,
      }];
    });

  if (failedViolations.length === 0) {
    return [{
      policyId,
      policyName,
      ruleName: 'Policy evaluation',
      message: 'Device is non-compliant with this policy.',
    }];
  }

  const deduped = new Map<string, PolicyViolation>();
  for (const violation of failedViolations) {
    const key = `${violation.policyId}:${violation.ruleName}:${violation.message}`;
    deduped.set(key, violation);
  }
  return Array.from(deduped.values());
}

export function normalizePolicyResponse(
  policy: typeof automationPolicies.$inferSelect,
  compliance?: ReturnType<typeof buildComplianceSummary>,
  remediationScript?: { id: string; name: string } | null
) {
  const targetInfo = resolveTargetInfo(policy.targets);
  const rulesCount = Array.isArray(policy.rules) ? policy.rules.length : 0;

  return {
    ...policy,
    enforcementLevel: policy.enforcement,
    targetType: targetInfo.targetType,
    targetIds: targetInfo.targetIds,
    rulesCount,
    compliance: compliance ?? {
      total: 0,
      compliant: 0,
      nonCompliant: 0,
      non_compliant: 0,
      unknown: 0,
      pending: 0,
      error: 0,
    },
    remediationScript: remediationScript ?? null,
  };
}

export async function getPolicyComplianceMap(policyIds: string[]) {
  if (policyIds.length === 0) {
    return new Map<string, ReturnType<typeof buildComplianceSummary>>();
  }

  const rows = await db
    .select({
      policyId: automationPolicyCompliance.policyId,
      status: automationPolicyCompliance.status,
      count: sql<number>`count(*)`,
    })
    .from(automationPolicyCompliance)
    .where(inArray(automationPolicyCompliance.policyId, policyIds))
    .groupBy(automationPolicyCompliance.policyId, automationPolicyCompliance.status);

  const grouped = new Map<string, Array<{ status: string; count: number }>>();
  for (const row of rows) {
    if (!row.policyId) continue;
    const policyRows = grouped.get(row.policyId) ?? [];
    policyRows.push({ status: row.status, count: Number(row.count) });
    grouped.set(row.policyId, policyRows);
  }

  const complianceMap = new Map<string, ReturnType<typeof buildComplianceSummary>>();
  for (const [policyId, policyRows] of grouped.entries()) {
    complianceMap.set(policyId, buildComplianceSummary(policyRows));
  }

  return complianceMap;
}

// ============================================
// Config Policy Compliance Helpers
// ============================================

export type ConfigPolicyComplianceInfo = {
  configPolicyId: string;
  configPolicyName: string;
  featureLinkId: string;
  complianceRuleId: string;
  complianceRuleName: string;
  enforcementLevel: string;
};

/**
 * Fetches config policy compliance rule metadata for config policies within the given org IDs.
 * Returns a map keyed by featureLinkId (which is stored as configPolicyId in automationPolicyCompliance).
 */
export async function getConfigPolicyComplianceRuleInfo(
  orgIds: string[]
): Promise<Map<string, ConfigPolicyComplianceInfo[]>> {
  if (orgIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      configPolicyId: configurationPolicies.id,
      configPolicyName: configurationPolicies.name,
      featureLinkId: configPolicyFeatureLinks.id,
      complianceRuleId: configPolicyComplianceRules.id,
      complianceRuleName: configPolicyComplianceRules.name,
      enforcementLevel: configPolicyComplianceRules.enforcementLevel,
    })
    .from(configPolicyComplianceRules)
    .innerJoin(
      configPolicyFeatureLinks,
      eq(configPolicyComplianceRules.featureLinkId, configPolicyFeatureLinks.id)
    )
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .where(inArray(configurationPolicies.orgId, orgIds));

  const infoMap = new Map<string, ConfigPolicyComplianceInfo[]>();
  for (const row of rows) {
    const existing = infoMap.get(row.featureLinkId) ?? [];
    existing.push({
      configPolicyId: row.configPolicyId,
      configPolicyName: row.configPolicyName,
      featureLinkId: row.featureLinkId,
      complianceRuleId: row.complianceRuleId,
      complianceRuleName: row.complianceRuleName,
      enforcementLevel: row.enforcementLevel,
    });
    infoMap.set(row.featureLinkId, existing);
  }

  return infoMap;
}

/**
 * Gets aggregate compliance stats for config policy compliance rows (those with policyId IS NULL
 * and configPolicyId IS NOT NULL), scoped to a set of featureLinkIds.
 */
export async function getConfigPolicyComplianceStats(
  featureLinkIds: string[]
): Promise<{
  complianceRows: Array<{ status: string; count: number }>;
  byFeatureLink: Map<string, ReturnType<typeof buildComplianceSummary>>;
}> {
  if (featureLinkIds.length === 0) {
    return {
      complianceRows: [],
      byFeatureLink: new Map(),
    };
  }

  const rows = await db
    .select({
      configPolicyId: automationPolicyCompliance.configPolicyId,
      status: automationPolicyCompliance.status,
      count: sql<number>`count(*)`,
    })
    .from(automationPolicyCompliance)
    .where(
      and(
        isNull(automationPolicyCompliance.policyId),
        isNotNull(automationPolicyCompliance.configPolicyId),
        inArray(automationPolicyCompliance.configPolicyId, featureLinkIds)
      )
    )
    .groupBy(automationPolicyCompliance.configPolicyId, automationPolicyCompliance.status);

  // Aggregate totals
  const aggregateMap = new Map<string, number>();
  const byFeatureLinkGrouped = new Map<string, Array<{ status: string; count: number }>>();

  for (const row of rows) {
    if (!row.configPolicyId) continue;
    const count = Number(row.count);

    // Aggregate across all feature links
    aggregateMap.set(row.status, (aggregateMap.get(row.status) ?? 0) + count);

    // Per feature link
    const featureLinkRows = byFeatureLinkGrouped.get(row.configPolicyId) ?? [];
    featureLinkRows.push({ status: row.status, count });
    byFeatureLinkGrouped.set(row.configPolicyId, featureLinkRows);
  }

  const complianceRows = Array.from(aggregateMap.entries()).map(([status, count]) => ({
    status,
    count,
  }));

  const byFeatureLink = new Map<string, ReturnType<typeof buildComplianceSummary>>();
  for (const [featureLinkId, statusRows] of byFeatureLinkGrouped.entries()) {
    byFeatureLink.set(featureLinkId, buildComplianceSummary(statusRows));
  }

  return { complianceRows, byFeatureLink };
}

/**
 * Fetches non-compliant config policy compliance rows with device info, scoped to featureLinkIds.
 */
export async function getConfigPolicyNonCompliantDevices(
  featureLinkIds: string[],
  ruleInfoMap: Map<string, ConfigPolicyComplianceInfo[]>
) {
  if (featureLinkIds.length === 0) {
    return [];
  }

  const violationRows = await db
    .select({
      configPolicyId: automationPolicyCompliance.configPolicyId,
      configItemName: automationPolicyCompliance.configItemName,
      status: automationPolicyCompliance.status,
      details: automationPolicyCompliance.details,
      lastCheckedAt: automationPolicyCompliance.lastCheckedAt,
      deviceId: devices.id,
      hostname: devices.hostname,
    })
    .from(automationPolicyCompliance)
    .innerJoin(devices, eq(automationPolicyCompliance.deviceId, devices.id))
    .where(
      and(
        isNull(automationPolicyCompliance.policyId),
        isNotNull(automationPolicyCompliance.configPolicyId),
        inArray(automationPolicyCompliance.configPolicyId, featureLinkIds),
        eq(automationPolicyCompliance.status, 'non_compliant')
      )
    );

  const deviceMap = new Map<string, {
    deviceId: string;
    deviceName: string;
    status: 'non_compliant';
    violations: Array<{
      policyId: string;
      policyName: string;
      ruleName: string;
      message: string;
    }>;
    lastCheckedAt: string;
  }>();

  for (const row of violationRows) {
    if (!row.configPolicyId) continue;

    const ruleInfos = ruleInfoMap.get(row.configPolicyId) ?? [];
    // Find the matching rule info by configItemName
    const matchingInfo = ruleInfos.find((info) => info.complianceRuleName === row.configItemName);
    const policyName = matchingInfo?.configPolicyName ?? 'Configuration Policy';
    const ruleName = row.configItemName ?? 'Compliance rule';
    const policyIdForDisplay = matchingInfo?.configPolicyId ?? row.configPolicyId;

    const existing = deviceMap.get(row.deviceId) ?? {
      deviceId: row.deviceId,
      deviceName: row.hostname,
      status: 'non_compliant' as const,
      violations: [],
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? new Date().toISOString(),
    };

    const violations = extractViolationsFromComplianceDetails(
      row.details,
      policyIdForDisplay,
      `${policyName}: ${ruleName}`
    );
    existing.violations.push(...violations);

    if (row.lastCheckedAt && row.lastCheckedAt.toISOString() > existing.lastCheckedAt) {
      existing.lastCheckedAt = row.lastCheckedAt.toISOString();
    }

    deviceMap.set(row.deviceId, existing);
  }

  return Array.from(deviceMap.values()).map((device) => {
    const dedupedViolations = Array.from(
      new Map(
        device.violations.map((violation) => [
          `${violation.policyId}:${violation.ruleName}:${violation.message}`,
          violation,
        ])
      ).values()
    );

    return {
      ...device,
      violations: dedupedViolations,
      violationCount: dedupedViolations.length,
    };
  });
}

/**
 * Gets config policy compliance results for a specific device.
 */
export async function getConfigPolicyComplianceForDevice(
  deviceId: string,
  orgIds: string[]
) {
  if (orgIds.length === 0) {
    return { rows: [], ruleInfoMap: new Map<string, ConfigPolicyComplianceInfo[]>() };
  }

  const rows = await db
    .select({
      id: automationPolicyCompliance.id,
      policyId: automationPolicyCompliance.policyId,
      configPolicyId: automationPolicyCompliance.configPolicyId,
      configItemName: automationPolicyCompliance.configItemName,
      deviceId: automationPolicyCompliance.deviceId,
      status: automationPolicyCompliance.status,
      details: automationPolicyCompliance.details,
      lastCheckedAt: automationPolicyCompliance.lastCheckedAt,
      remediationAttempts: automationPolicyCompliance.remediationAttempts,
      updatedAt: automationPolicyCompliance.updatedAt,
      deviceHostname: devices.hostname,
      deviceStatus: devices.status,
      deviceOsType: devices.osType,
    })
    .from(automationPolicyCompliance)
    .leftJoin(devices, eq(automationPolicyCompliance.deviceId, devices.id))
    .where(
      and(
        eq(automationPolicyCompliance.deviceId, deviceId),
        isNull(automationPolicyCompliance.policyId),
        isNotNull(automationPolicyCompliance.configPolicyId)
      )
    );

  // Get the featureLinkIds from the results and load rule info
  const featureLinkIds = [...new Set(rows.map((r) => r.configPolicyId).filter(Boolean) as string[])];
  const ruleInfoMap = featureLinkIds.length > 0
    ? await getConfigPolicyComplianceRuleInfo(orgIds)
    : new Map<string, ConfigPolicyComplianceInfo[]>();

  return { rows, ruleInfoMap };
}
