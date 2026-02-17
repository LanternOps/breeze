import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  automationPolicies,
  automationPolicyCompliance,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
} from '../../db/schema';
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
  getConfigPolicyComplianceRuleInfo,
  getConfigPolicyComplianceStats,
  getConfigPolicyNonCompliantDevices,
  getConfigPolicyComplianceForDevice,
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

    const configPolicyCondition = orgIds.length > 0
      ? inArray(configurationPolicies.orgId, orgIds)
      : undefined;

    const policyCounts = await db
      .select({
        total: sql<number>`count(*)`,
        enabled: sql<number>`count(*) filter (where ${automationPolicies.enabled} = true)`,
      })
      .from(automationPolicies)
      .where(policyCondition);

    const configPolicyCounts = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where ${configurationPolicies.status} = 'active')`,
      })
      .from(configurationPolicies)
      .where(configPolicyCondition);

    const policyIds = await db
      .select({ id: automationPolicies.id })
      .from(automationPolicies)
      .where(policyCondition);

    const policyIdList = policyIds.map((policy) => policy.id);

    // Legacy compliance rows
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

    // Config policy compliance rows
    const configRuleInfoMap = await getConfigPolicyComplianceRuleInfo(orgIds);
    const configFeatureLinkIds = Array.from(configRuleInfoMap.keys());
    const configComplianceResult = await getConfigPolicyComplianceStats(configFeatureLinkIds);

    // Merge legacy + config policy compliance rows
    const mergedStatusMap = new Map<string, number>();
    for (const row of complianceRows) {
      mergedStatusMap.set(row.status, (mergedStatusMap.get(row.status) ?? 0) + Number(row.count));
    }
    for (const row of configComplianceResult.complianceRows) {
      mergedStatusMap.set(row.status, (mergedStatusMap.get(row.status) ?? 0) + Number(row.count));
    }
    const mergedRows = Array.from(mergedStatusMap.entries()).map(([status, count]) => ({
      status,
      count,
    }));

    const compliance = buildComplianceSummary(mergedRows);
    const totalChecks = compliance.total;
    const complianceRate = totalChecks > 0
      ? Math.round((compliance.compliant / totalChecks) * 100)
      : 0;

    const legacyPolicyTotal = Number(policyCounts[0]?.total ?? 0);
    const configPolicyTotal = Number(configPolicyCounts[0]?.total ?? 0);
    const legacyEnabled = Number(policyCounts[0]?.enabled ?? 0);
    const configActive = Number(configPolicyCounts[0]?.active ?? 0);

    return c.json({
      data: {
        complianceRate,
        complianceScore: complianceRate,
        totalPolicies: legacyPolicyTotal + configPolicyTotal,
        enabledPolicies: legacyEnabled + configActive,
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

    const configPolicyCondition = orgIds.length > 0
      ? inArray(configurationPolicies.orgId, orgIds)
      : undefined;

    // --- Legacy automation policies ---
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

    const configPolicyCounts = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where ${configurationPolicies.status} = 'active')`,
      })
      .from(configurationPolicies)
      .where(configPolicyCondition);

    const enforcementCounts = await db
      .select({
        enforcement: automationPolicies.enforcement,
        count: sql<number>`count(*)`,
      })
      .from(automationPolicies)
      .where(policyCondition)
      .groupBy(automationPolicies.enforcement);

    // --- Config policy compliance ---
    const configRuleInfoMap = await getConfigPolicyComplianceRuleInfo(orgIds);
    const configFeatureLinkIds = Array.from(configRuleInfoMap.keys());
    const configComplianceResult = await getConfigPolicyComplianceStats(configFeatureLinkIds);

    // Build legacy policy entries
    const policies = policiesList.map((policy) => {
      const compliance = complianceMap.get(policy.id) ?? buildComplianceSummary([]);
      return {
        policyId: policy.id,
        policyName: policy.name,
        enforcementLevel: policy.enforcement,
        source: 'legacy' as const,
        compliance: {
          total: compliance.total,
          compliant: compliance.compliant,
          nonCompliant: compliance.nonCompliant,
          unknown: compliance.unknown,
        },
      };
    });

    // Build config policy compliance entries grouped by config policy
    // Multiple feature links can belong to the same config policy, so group by configPolicyId
    const configPolicyGrouped = new Map<string, {
      configPolicyId: string;
      configPolicyName: string;
      enforcementLevel: string;
      compliance: { total: number; compliant: number; nonCompliant: number; unknown: number };
    }>();

    for (const [featureLinkId, ruleInfos] of configRuleInfoMap.entries()) {
      const featureLinkCompliance = configComplianceResult.byFeatureLink.get(featureLinkId)
        ?? buildComplianceSummary([]);

      for (const ruleInfo of ruleInfos) {
        const existing = configPolicyGrouped.get(ruleInfo.configPolicyId);
        if (existing) {
          existing.compliance.total += featureLinkCompliance.total;
          existing.compliance.compliant += featureLinkCompliance.compliant;
          existing.compliance.nonCompliant += featureLinkCompliance.nonCompliant;
          existing.compliance.unknown += featureLinkCompliance.unknown;
          // Use the strictest enforcement level
          if (ruleInfo.enforcementLevel === 'enforce') {
            existing.enforcementLevel = 'enforce';
          } else if (ruleInfo.enforcementLevel === 'warn' && existing.enforcementLevel !== 'enforce') {
            existing.enforcementLevel = 'warn';
          }
        } else {
          configPolicyGrouped.set(ruleInfo.configPolicyId, {
            configPolicyId: ruleInfo.configPolicyId,
            configPolicyName: ruleInfo.configPolicyName,
            enforcementLevel: ruleInfo.enforcementLevel,
            compliance: {
              total: featureLinkCompliance.total,
              compliant: featureLinkCompliance.compliant,
              nonCompliant: featureLinkCompliance.nonCompliant,
              unknown: featureLinkCompliance.unknown,
            },
          });
        }
      }
    }

    const configPolicyEntries = Array.from(configPolicyGrouped.values()).map((entry) => ({
      policyId: entry.configPolicyId,
      policyName: entry.configPolicyName,
      enforcementLevel: entry.enforcementLevel,
      source: 'config_policy' as const,
      compliance: entry.compliance,
    }));

    // Merge all policies for summary
    const allPolicies = [...policies, ...configPolicyEntries];

    const overall = allPolicies.reduce(
      (acc, policy) => {
        acc.total += policy.compliance.total;
        acc.compliant += policy.compliance.compliant;
        acc.nonCompliant += policy.compliance.nonCompliant;
        acc.unknown += policy.compliance.unknown;
        return acc;
      },
      { total: 0, compliant: 0, nonCompliant: 0, unknown: 0 }
    );

    // --- Non-compliant devices: legacy ---
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
        if (!row.policyId || !policyIdSet.has(row.policyId)) {
          continue;
        }

        const existing = deviceMap.get(row.deviceId) ?? {
          deviceId: row.deviceId,
          deviceName: row.hostname,
          status: 'non_compliant' as const,
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

    // --- Non-compliant devices: config policy ---
    const configNonCompliantDevices = await getConfigPolicyNonCompliantDevices(
      configFeatureLinkIds,
      configRuleInfoMap
    );

    // Merge non-compliant devices from both sources
    const mergedDeviceMap = new Map<string, typeof nonCompliantDevices[number]>();
    for (const device of nonCompliantDevices) {
      mergedDeviceMap.set(device.deviceId, device);
    }
    for (const device of configNonCompliantDevices) {
      const existing = mergedDeviceMap.get(device.deviceId);
      if (existing) {
        existing.violations.push(...device.violations);
        // Deduplicate
        const dedupedViolations = Array.from(
          new Map(
            existing.violations.map((v) => [
              `${v.policyId}:${v.ruleName}:${v.message}`,
              v,
            ])
          ).values()
        );
        existing.violations = dedupedViolations;
        existing.violationCount = dedupedViolations.length;
        if (device.lastCheckedAt > existing.lastCheckedAt) {
          existing.lastCheckedAt = device.lastCheckedAt;
        }
      } else {
        mergedDeviceMap.set(device.deviceId, device);
      }
    }
    const allNonCompliantDevices = Array.from(mergedDeviceMap.values());

    // --- Enforcement counts (legacy + config policy) ---
    const byEnforcement = { monitor: 0, warn: 0, enforce: 0 };
    for (const row of enforcementCounts) {
      byEnforcement[row.enforcement as keyof typeof byEnforcement] = Number(row.count);
    }
    // Add config policy enforcement counts
    for (const entry of configPolicyGrouped.values()) {
      const key = entry.enforcementLevel as keyof typeof byEnforcement;
      if (key in byEnforcement) {
        byEnforcement[key] += 1;
      }
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

    const legacyPolicyTotal = Number(policyCounts[0]?.total ?? 0);
    const configPolicyTotal = Number(configPolicyCounts[0]?.total ?? 0);
    const legacyEnabled = Number(policyCounts[0]?.enabled ?? 0);
    const configActive = Number(configPolicyCounts[0]?.active ?? 0);

    return c.json({
      totalPolicies: legacyPolicyTotal + configPolicyTotal,
      enabledPolicies: legacyEnabled + configActive,
      byEnforcement,
      complianceOverview,
      complianceRate,
      overall,
      trend: [],
      policies: allPolicies,
      nonCompliantDevices: allNonCompliantDevices,
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

    // Try legacy automation policy first
    const policy = await getPolicyWithOrgCheck(id, auth);

    if (policy) {
      // --- Legacy automation policy compliance ---
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
            source: 'legacy' as const,
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

    // --- Try as a configuration policy ---
    const [configPolicy] = await db
      .select({
        id: configurationPolicies.id,
        orgId: configurationPolicies.orgId,
        name: configurationPolicies.name,
        status: configurationPolicies.status,
      })
      .from(configurationPolicies)
      .where(eq(configurationPolicies.id, id))
      .limit(1);

    if (!configPolicy || !ensureOrgAccess(configPolicy.orgId, auth)) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Get all feature link IDs for this config policy
    const featureLinks = await db
      .select({ id: configPolicyFeatureLinks.id })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.configPolicyId, id));

    const featureLinkIds = featureLinks.map((link) => link.id);

    // Build conditions for config policy compliance rows
    const configConditions: ReturnType<typeof eq>[] = [
      isNull(automationPolicyCompliance.policyId),
      isNotNull(automationPolicyCompliance.configPolicyId),
    ];

    if (featureLinkIds.length > 0) {
      configConditions.push(
        inArray(automationPolicyCompliance.configPolicyId, featureLinkIds)
      );
    } else {
      // No feature links, so no compliance rows possible
      const emptyCompliance = buildComplianceSummary([]);
      return c.json({
        data: [],
        pagination: { page, limit, total: 0 },
        overall: {
          total: 0,
          compliant: 0,
          nonCompliant: 0,
          unknown: 0,
        },
        trend: [],
        policies: [
          {
            policyId: id,
            policyName: configPolicy.name,
            enforcementLevel: 'monitor',
            source: 'config_policy' as const,
            compliance: {
              total: 0,
              compliant: 0,
              nonCompliant: 0,
              unknown: 0,
            },
          },
        ],
        nonCompliantDevices: [],
        policyName: configPolicy.name,
      });
    }

    if (query.status) {
      configConditions.push(eq(automationPolicyCompliance.status, query.status));
    }

    const configWhereCondition = and(...configConditions);

    const configCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationPolicyCompliance)
      .where(configWhereCondition);

    const configTotal = Number(configCountResult[0]?.count ?? 0);

    const configRows = await db
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
      .where(configWhereCondition)
      .orderBy(desc(automationPolicyCompliance.updatedAt))
      .limit(limit)
      .offset(offset);

    const configCompliance = buildComplianceSummary([
      { status: 'compliant', count: configRows.filter((row) => row.status === 'compliant').length },
      { status: 'non_compliant', count: configRows.filter((row) => row.status === 'non_compliant').length },
      { status: 'pending', count: configRows.filter((row) => row.status === 'pending').length },
      { status: 'error', count: configRows.filter((row) => row.status === 'error').length },
    ]);

    const configOverall = {
      total: configCompliance.total,
      compliant: configCompliance.compliant,
      nonCompliant: configCompliance.nonCompliant,
      unknown: configCompliance.unknown,
    };

    // Get rule info for violation display
    const ruleInfoMap = await getConfigPolicyComplianceRuleInfo([configPolicy.orgId]);

    // Determine enforcement level from compliance rules
    let enforcementLevel = 'monitor';
    for (const [, ruleInfos] of ruleInfoMap.entries()) {
      for (const info of ruleInfos) {
        if (info.configPolicyId === id) {
          if (info.enforcementLevel === 'enforce') {
            enforcementLevel = 'enforce';
          } else if (info.enforcementLevel === 'warn' && enforcementLevel !== 'enforce') {
            enforcementLevel = 'warn';
          }
        }
      }
    }

    const configNonCompliantDevices = configRows
      .filter((row) => row.status === 'non_compliant')
      .map((row) => {
        const ruleName = row.configItemName ?? 'Compliance rule';
        const violations = extractViolationsFromComplianceDetails(
          row.details,
          id,
          `${configPolicy.name}: ${ruleName}`
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
      data: configRows,
      pagination: { page, limit, total: configTotal },
      overall: configOverall,
      trend: [],
      policies: [
        {
          policyId: id,
          policyName: configPolicy.name,
          enforcementLevel,
          source: 'config_policy' as const,
          compliance: {
            total: configCompliance.total,
            compliant: configCompliance.compliant,
            nonCompliant: configCompliance.nonCompliant,
            unknown: configCompliance.unknown,
          },
        },
      ],
      nonCompliantDevices: configNonCompliantDevices,
      policyName: configPolicy.name,
    });
  }
);
