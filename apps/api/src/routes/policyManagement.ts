import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  automationPolicies,
  automationPolicyCompliance,
  automations,
  automationRuns,
  devices,
  scripts,
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { evaluatePolicy, resolvePolicyRemediationAutomationId } from '../services/policyEvaluationService';

export const policyRoutes = new Hono();

type AuthContext = {
  scope: string;
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
  user: {
    id: string;
    email?: string;
  };
};

const listPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

const targetTypeSchema = z.enum(['all', 'sites', 'groups', 'tags', 'devices']);

const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  targets: z.any().optional(),
  targetType: targetTypeSchema.optional(),
  targetIds: z.array(z.string().uuid()).optional(),
  rules: z.any(),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  enforcementLevel: z.enum(['monitor', 'warn', 'enforce']).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(10080).default(60),
  remediationScriptId: z.string().uuid().optional(),
  type: z.string().optional(),
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  targets: z.any().optional(),
  targetType: targetTypeSchema.optional(),
  targetIds: z.array(z.string().uuid()).optional(),
  rules: z.any().optional(),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  enforcementLevel: z.enum(['monitor', 'warn', 'enforce']).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  remediationScriptId: z.string().uuid().nullable().optional(),
  type: z.string().optional(),
});

const listComplianceSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['compliant', 'non_compliant', 'pending', 'error']).optional(),
});

const policyIdSchema = z.object({ id: z.string().uuid() });

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function ensureOrgAccess(orgId: string, auth: AuthContext) {
  return auth.canAccessOrg(orgId);
}

async function getPolicyWithOrgCheck(policyId: string, auth: AuthContext) {
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

function sanitizeUuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeTargets(payload: {
  targets?: unknown;
  targetType?: z.infer<typeof targetTypeSchema>;
  targetIds?: string[];
}) {
  if (payload.targets && typeof payload.targets === 'object') {
    const rawTargets = payload.targets as Record<string, unknown>;
    const normalized = {
      ...rawTargets,
      targetType: typeof rawTargets.targetType === 'string'
        ? rawTargets.targetType
        : payload.targetType ?? 'all',
      targetIds: sanitizeUuidArray(rawTargets.targetIds) ?? payload.targetIds ?? [],
      deviceIds: sanitizeUuidArray(rawTargets.deviceIds),
      siteIds: sanitizeUuidArray(rawTargets.siteIds),
      groupIds: sanitizeUuidArray(rawTargets.groupIds),
      tags: sanitizeUuidArray(rawTargets.tags),
    };

    return normalized;
  }

  const targetType = payload.targetType ?? 'all';
  const targetIds = payload.targetIds ?? [];

  return {
    targetType,
    targetIds,
    deviceIds: targetType === 'devices' ? targetIds : [],
    siteIds: targetType === 'sites' ? targetIds : [],
    groupIds: targetType === 'groups' ? targetIds : [],
    tags: targetType === 'tags' ? targetIds : [],
  };
}

function resolveTargetInfo(targets: unknown): { targetType: string; targetIds: string[] } {
  if (!targets || typeof targets !== 'object') {
    return { targetType: 'all', targetIds: [] };
  }

  const rawTargets = targets as Record<string, unknown>;
  const explicitType = typeof rawTargets.targetType === 'string' ? rawTargets.targetType : undefined;
  const explicitIds = sanitizeUuidArray(rawTargets.targetIds);

  if (explicitType) {
    return {
      targetType: explicitType,
      targetIds: explicitIds,
    };
  }

  const deviceIds = sanitizeUuidArray(rawTargets.deviceIds);
  const siteIds = sanitizeUuidArray(rawTargets.siteIds);
  const groupIds = sanitizeUuidArray(rawTargets.groupIds);
  const tags = sanitizeUuidArray(rawTargets.tags);

  if (deviceIds.length > 0) return { targetType: 'devices', targetIds: deviceIds };
  if (siteIds.length > 0) return { targetType: 'sites', targetIds: siteIds };
  if (groupIds.length > 0) return { targetType: 'groups', targetIds: groupIds };
  if (tags.length > 0) return { targetType: 'tags', targetIds: tags };

  return { targetType: 'all', targetIds: [] };
}

function buildComplianceSummary(rows: Array<{ status: string; count: number }>) {
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

function extractViolationsFromComplianceDetails(
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

function normalizePolicyResponse(
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

async function getPolicyComplianceMap(policyIds: string[]) {
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

policyRoutes.use('*', authMiddleware);

// GET /policies
policyRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: ReturnType<typeof eq>[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(automationPolicies.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(automationPolicies.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(inArray(automationPolicies.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(automationPolicies.orgId, query.orgId));
    }

    if (query.enforcement) {
      conditions.push(eq(automationPolicies.enforcement, query.enforcement));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(automationPolicies.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationPolicies)
      .where(whereCondition);

    const total = Number(countResult[0]?.count ?? 0);

    const policiesList = await db
      .select()
      .from(automationPolicies)
      .where(whereCondition)
      .orderBy(desc(automationPolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    const complianceMap = await getPolicyComplianceMap(policiesList.map((policy) => policy.id));

    return c.json({
      data: policiesList.map((policy) => normalizePolicyResponse(policy, complianceMap.get(policy.id))),
      pagination: { page, limit, total },
    });
  }
);

// GET /policies/compliance/stats (legacy analytics shape)
policyRoutes.get(
  '/compliance/stats',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { orgId } = c.req.query();

    let orgIds: string[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgIds = [auth.orgId];
    } else if (auth.scope === 'partner') {
      if (orgId) {
        const hasAccess = ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgIds = [orgId];
      } else {
        orgIds = auth.accessibleOrgIds ?? [];
      }
    } else if (auth.scope === 'system' && orgId) {
      orgIds = [orgId];
    }

    const policyCondition = orgIds.length > 0
      ? inArray(automationPolicies.orgId, orgIds)
      : undefined;

    const policyCounts = await db
      .select({
        total: sql<number>`count(*)`,
        enabled: sql<number>`count(*) filter (where ${automationPolicies.enabled} = true)`,
      })
      .from(automationPolicies)
      .where(policyCondition);

    const policyIds = await db
      .select({ id: automationPolicies.id })
      .from(automationPolicies)
      .where(policyCondition);

    const policyIdList = policyIds.map((policy) => policy.id);

    let complianceRows: Array<{ status: string; count: number }> = [];
    if (policyIdList.length > 0) {
      complianceRows = await db
        .select({
          status: automationPolicyCompliance.status,
          count: sql<number>`count(*)`,
        })
        .from(automationPolicyCompliance)
        .where(inArray(automationPolicyCompliance.policyId, policyIdList))
        .groupBy(automationPolicyCompliance.status);
    }

    const compliance = buildComplianceSummary(complianceRows);
    const totalChecks = compliance.total;
    const complianceRate = totalChecks > 0
      ? Math.round((compliance.compliant / totalChecks) * 100)
      : 0;

    return c.json({
      data: {
        complianceRate,
        complianceScore: complianceRate,
        totalPolicies: Number(policyCounts[0]?.total ?? 0),
        enabledPolicies: Number(policyCounts[0]?.enabled ?? 0),
        complianceOverview: {
          compliant: compliance.compliant,
          non_compliant: compliance.nonCompliant,
          pending: compliance.pending + compliance.error,
        },
      },
    });
  }
);

// GET /policies/compliance/summary
policyRoutes.get(
  '/compliance/summary',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { orgId } = c.req.query();

    let orgIds: string[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgIds = [auth.orgId];
    } else if (auth.scope === 'partner') {
      if (orgId) {
        const hasAccess = ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgIds = [orgId];
      } else {
        orgIds = auth.accessibleOrgIds ?? [];
      }
    } else if (auth.scope === 'system' && orgId) {
      orgIds = [orgId];
    }

    const policyCondition = orgIds.length > 0
      ? inArray(automationPolicies.orgId, orgIds)
      : undefined;

    const policiesList = await db
      .select({
        id: automationPolicies.id,
        name: automationPolicies.name,
        enforcement: automationPolicies.enforcement,
      })
      .from(automationPolicies)
      .where(policyCondition);

    const policyIds = policiesList.map((policy) => policy.id);
    const complianceMap = await getPolicyComplianceMap(policyIds);

    const policyCounts = await db
      .select({
        total: sql<number>`count(*)`,
        enabled: sql<number>`count(*) filter (where ${automationPolicies.enabled} = true)`,
      })
      .from(automationPolicies)
      .where(policyCondition);

    const enforcementCounts = await db
      .select({
        enforcement: automationPolicies.enforcement,
        count: sql<number>`count(*)`,
      })
      .from(automationPolicies)
      .where(policyCondition)
      .groupBy(automationPolicies.enforcement);

    const policies = policiesList.map((policy) => {
      const compliance = complianceMap.get(policy.id) ?? buildComplianceSummary([]);
      return {
        policyId: policy.id,
        policyName: policy.name,
        enforcementLevel: policy.enforcement,
        compliance: {
          total: compliance.total,
          compliant: compliance.compliant,
          nonCompliant: compliance.nonCompliant,
          unknown: compliance.unknown,
        },
      };
    });

    const overall = policies.reduce(
      (acc, policy) => {
        acc.total += policy.compliance.total;
        acc.compliant += policy.compliance.compliant;
        acc.nonCompliant += policy.compliance.nonCompliant;
        acc.unknown += policy.compliance.unknown;
        return acc;
      },
      { total: 0, compliant: 0, nonCompliant: 0, unknown: 0 }
    );

    const policyIdSet = new Set(policyIds);
    let nonCompliantDevices: Array<{
      deviceId: string;
      deviceName: string;
      siteName?: string;
      status: 'non_compliant';
      violationCount: number;
      violations: Array<{
        policyId: string;
        policyName: string;
        ruleName: string;
        message: string;
      }>;
      lastCheckedAt: string;
    }> = [];

    if (policyIds.length > 0) {
      const violationRows = await db
        .select({
          policyId: automationPolicyCompliance.policyId,
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
            inArray(automationPolicyCompliance.policyId, policyIds),
            eq(automationPolicyCompliance.status, 'non_compliant')
          )
        );

      const policyNameMap = new Map(policiesList.map((policy) => [policy.id, policy.name]));
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
        if (!policyIdSet.has(row.policyId)) {
          continue;
        }

        const existing = deviceMap.get(row.deviceId) ?? {
          deviceId: row.deviceId,
          deviceName: row.hostname,
          status: 'non_compliant',
          violations: [],
          lastCheckedAt: row.lastCheckedAt?.toISOString() ?? new Date().toISOString(),
        };

        const policyName = policyNameMap.get(row.policyId) ?? 'Policy';
        existing.violations.push(
          ...extractViolationsFromComplianceDetails(
            row.details,
            row.policyId,
            policyName
          )
        );

        if (row.lastCheckedAt && row.lastCheckedAt.toISOString() > existing.lastCheckedAt) {
          existing.lastCheckedAt = row.lastCheckedAt.toISOString();
        }

        deviceMap.set(row.deviceId, existing);
      }

      nonCompliantDevices = Array.from(deviceMap.values()).map((device) => {
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

    const byEnforcement = { monitor: 0, warn: 0, enforce: 0 };
    for (const row of enforcementCounts) {
      byEnforcement[row.enforcement as keyof typeof byEnforcement] = Number(row.count);
    }

    const complianceOverview = {
      compliant: overall.compliant,
      non_compliant: overall.nonCompliant,
      pending: overall.unknown,
      error: 0,
    };

    const complianceRate = overall.total > 0
      ? Math.round((overall.compliant / overall.total) * 100)
      : 0;

    return c.json({
      totalPolicies: Number(policyCounts[0]?.total ?? 0),
      enabledPolicies: Number(policyCounts[0]?.enabled ?? 0),
      byEnforcement,
      complianceOverview,
      complianceRate,
      overall,
      trend: [],
      policies,
      nonCompliantDevices,
    });
  }
);

// GET /policies/:id
policyRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    if (['compliance'].includes(id)) {
      return c.notFound();
    }

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const complianceRows = await db
      .select({
        status: automationPolicyCompliance.status,
        count: sql<number>`count(*)`,
      })
      .from(automationPolicyCompliance)
      .where(eq(automationPolicyCompliance.policyId, id))
      .groupBy(automationPolicyCompliance.status);

    let remediationScript: { id: string; name: string } | null = null;
    if (policy.remediationScriptId) {
      const [script] = await db
        .select({ id: scripts.id, name: scripts.name })
        .from(scripts)
        .where(eq(scripts.id, policy.remediationScriptId))
        .limit(1);

      remediationScript = script ?? null;
    }

    return c.json(normalizePolicyResponse(policy, buildComplianceSummary(complianceRows), remediationScript));
  }
);

// POST /policies
policyRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const data = c.req.valid('json');

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const normalizedTargets = normalizeTargets({
      targets: data.targets,
      targetType: data.targetType,
      targetIds: data.targetIds,
    });

    if (normalizedTargets.targetType !== 'all' && (!normalizedTargets.targetIds || normalizedTargets.targetIds.length === 0)) {
      return c.json({ error: 'targetIds are required when targetType is not all' }, 400);
    }

    if (data.remediationScriptId) {
      const [script] = await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(
          and(
            eq(scripts.id, data.remediationScriptId),
            eq(scripts.orgId, orgId as string)
          )
        )
        .limit(1);

      if (!script) {
        return c.json({ error: 'Remediation script not found or belongs to different organization' }, 400);
      }
    }

    const [policy] = await db
      .insert(automationPolicies)
      .values({
        orgId: orgId as string,
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        targets: normalizedTargets,
        rules: data.rules,
        enforcement: data.enforcement ?? data.enforcementLevel ?? 'monitor',
        checkIntervalMinutes: data.checkIntervalMinutes,
        remediationScriptId: data.remediationScriptId,
        createdBy: auth.user.id,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: policy?.orgId,
      action: 'policy.create',
      resourceType: 'policy',
      resourceId: policy?.id,
      resourceName: policy?.name,
      details: {
        enabled: policy?.enabled,
        enforcement: policy?.enforcement,
      },
    });

    if (!policy) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    return c.json(normalizePolicyResponse(policy), 201);
  }
);

async function handleUpdatePolicy(c: any) {
  const auth = c.get('auth') as AuthContext;
  const policyId = c.req.param('id');
  const data = c.req.valid('json') as z.infer<typeof updatePolicySchema>;

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  const policy = await getPolicyWithOrgCheck(policyId, auth);
  if (!policy) {
    return c.json({ error: 'Policy not found' }, 404);
  }

  if (data.remediationScriptId !== undefined && data.remediationScriptId !== null) {
    const [script] = await db
      .select({ id: scripts.id })
      .from(scripts)
      .where(
        and(
          eq(scripts.id, data.remediationScriptId),
          eq(scripts.orgId, policy.orgId)
        )
      )
      .limit(1);

    if (!script) {
      return c.json({ error: 'Remediation script not found or belongs to different organization' }, 400);
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.enabled !== undefined) updates.enabled = data.enabled;
  if (data.rules !== undefined) updates.rules = data.rules;
  if (data.enforcement !== undefined) updates.enforcement = data.enforcement;
  if (data.enforcementLevel !== undefined) updates.enforcement = data.enforcementLevel;
  if (data.checkIntervalMinutes !== undefined) updates.checkIntervalMinutes = data.checkIntervalMinutes;
  if (data.remediationScriptId !== undefined) updates.remediationScriptId = data.remediationScriptId;

  if (data.targets !== undefined || data.targetType !== undefined || data.targetIds !== undefined) {
    const normalizedTargets = normalizeTargets({
      targets: data.targets,
      targetType: data.targetType,
      targetIds: data.targetIds,
    });

    if (normalizedTargets.targetType !== 'all' && (!normalizedTargets.targetIds || normalizedTargets.targetIds.length === 0)) {
      return c.json({ error: 'targetIds are required when targetType is not all' }, 400);
    }

    updates.targets = normalizedTargets;
  }

  const [updated] = await db
    .update(automationPolicies)
    .set(updates)
    .where(eq(automationPolicies.id, policyId))
    .returning();

  writeRouteAudit(c, {
    orgId: policy.orgId,
    action: 'policy.update',
    resourceType: 'policy',
    resourceId: updated?.id,
    resourceName: updated?.name,
    details: { changedFields: Object.keys(data) },
  });

  if (!updated) {
    return c.json({ error: 'Failed to update policy' }, 500);
  }

  return c.json(normalizePolicyResponse(updated));
}

// PUT /policies/:id
policyRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  zValidator('json', updatePolicySchema),
  async (c) => handleUpdatePolicy(c)
);

// PATCH /policies/:id
policyRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  zValidator('json', updatePolicySchema),
  async (c) => handleUpdatePolicy(c)
);

// DELETE /policies/:id
policyRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    await db
      .delete(automationPolicyCompliance)
      .where(eq(automationPolicyCompliance.policyId, id));

    await db
      .delete(automationPolicies)
      .where(eq(automationPolicies.id, id));

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'policy.delete',
      resourceType: 'policy',
      resourceId: policy.id,
      resourceName: policy.name,
    });

    return c.json({ success: true });
  }
);

// POST /policies/:id/activate
policyRoutes.post(
  '/:id/activate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const [updated] = await db
      .update(automationPolicies)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(automationPolicies.id, id))
      .returning();

    return c.json(updated ? normalizePolicyResponse(updated) : policy);
  }
);

// POST /policies/:id/deactivate
policyRoutes.post(
  '/:id/deactivate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const [updated] = await db
      .update(automationPolicies)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(automationPolicies.id, id))
      .returning();

    return c.json(updated ? normalizePolicyResponse(updated) : policy);
  }
);

// POST /policies/:id/evaluate
policyRoutes.post(
  '/:id/evaluate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (!policy.enabled) {
      return c.json({ error: 'Cannot evaluate disabled policy' }, 400);
    }

    const result = await evaluatePolicy(policy, {
      source: 'policies-route',
      requestRemediation: true,
    });

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'policy.evaluate',
      resourceType: 'policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: { devicesEvaluated: result.devicesEvaluated },
    });

    return c.json(result);
  }
);

// GET /policies/:id/compliance
policyRoutes.get(
  '/:id/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  zValidator('query', listComplianceSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const conditions: ReturnType<typeof eq>[] = [eq(automationPolicyCompliance.policyId, id)];

    if (query.status) {
      conditions.push(eq(automationPolicyCompliance.status, query.status));
    }

    const whereCondition = and(...conditions);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationPolicyCompliance)
      .where(whereCondition);

    const total = Number(countResult[0]?.count ?? 0);

    const rows = await db
      .select({
        id: automationPolicyCompliance.id,
        policyId: automationPolicyCompliance.policyId,
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
      .where(whereCondition)
      .orderBy(desc(automationPolicyCompliance.updatedAt))
      .limit(limit)
      .offset(offset);

    const compliance = buildComplianceSummary([
      { status: 'compliant', count: rows.filter((row) => row.status === 'compliant').length },
      { status: 'non_compliant', count: rows.filter((row) => row.status === 'non_compliant').length },
      { status: 'pending', count: rows.filter((row) => row.status === 'pending').length },
      { status: 'error', count: rows.filter((row) => row.status === 'error').length },
    ]);

    const overall = {
      total: compliance.total,
      compliant: compliance.compliant,
      nonCompliant: compliance.nonCompliant,
      unknown: compliance.unknown,
    };

    const nonCompliantDevices = rows
      .filter((row) => row.status === 'non_compliant')
      .map((row) => {
        const violations = extractViolationsFromComplianceDetails(
          row.details,
          id,
          policy.name
        );

        return {
          deviceId: row.deviceId,
          deviceName: row.deviceHostname,
          status: 'non_compliant' as const,
          violationCount: violations.length,
          violations,
          lastCheckedAt: row.lastCheckedAt?.toISOString() ?? new Date().toISOString(),
        };
      });

    return c.json({
      data: rows,
      pagination: { page, limit, total },
      overall,
      trend: [],
      policies: [
        {
          policyId: id,
          policyName: policy.name,
          enforcementLevel: policy.enforcement,
          compliance: {
            total: compliance.total,
            compliant: compliance.compliant,
            nonCompliant: compliance.nonCompliant,
            unknown: compliance.unknown,
          },
        },
      ],
      nonCompliantDevices,
      policyName: policy.name,
    });
  }
);

// POST /policies/:id/remediate - trigger remediation without evaluation
policyRoutes.post(
  '/:id/remediate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const targetAutomationId = await resolvePolicyRemediationAutomationId(policy);
    if (!targetAutomationId) {
      return c.json({
        error: 'No remediation automation is configured on this policy',
        hint: 'Set rule.remediationAutomationId, rule.remediation.automationId, or link remediationScriptId to an automation action',
      }, 400);
    }

    const [automation] = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.id, targetAutomationId),
          eq(automations.orgId, policy.orgId)
        )
      )
      .limit(1);

    if (!automation) {
      return c.json({ error: 'Remediation automation not found for this organization' }, 404);
    }

    if (!automation.enabled) {
      return c.json({ error: 'Remediation automation is disabled' }, 400);
    }

    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId: automation.id,
        triggeredBy: `policy-remediation:${policy.id}`,
        status: 'running',
        devicesTargeted: 0,
        devicesSucceeded: 0,
        devicesFailed: 0,
        logs: [{
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Triggered from policy ${policy.name}`,
          policyId: policy.id,
        }],
      })
      .returning({ id: automationRuns.id, status: automationRuns.status, startedAt: automationRuns.startedAt });

    await db
      .update(automations)
      .set({
        runCount: sql`${automations.runCount} + 1`,
        lastRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, automation.id));

    return c.json({
      message: 'Remediation automation triggered',
      policyId: policy.id,
      automationId: automation.id,
      run,
    });
  }
);
