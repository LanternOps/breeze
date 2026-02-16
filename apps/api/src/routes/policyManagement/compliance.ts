import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, automationPolicyCompliance, devices } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import {
  AuthContext,
  listComplianceSchema,
  policyIdSchema,
} from './schemas';
import {
  getPagination,
  ensureOrgAccess,
  getPolicyWithOrgCheck,
  getPolicyComplianceMap,
  buildComplianceSummary,
  extractViolationsFromComplianceDetails,
} from './helpers';

export const complianceRoutes = new Hono();

// GET /policies/compliance/stats (legacy analytics shape)
complianceRoutes.get(
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
complianceRoutes.get(
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

// GET /policies/:id/compliance
complianceRoutes.get(
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
