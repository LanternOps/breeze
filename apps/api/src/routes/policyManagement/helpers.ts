import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, automationPolicyCompliance } from '../../db/schema';
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
