import { db } from '../db';
import { configurationPolicies, configPolicyFeatureLinks, configPolicyAssignments, automationPolicyCompliance } from '../db/schema';
import { eq, and, desc, sql, isNull, isNotNull, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  resolveEffectiveConfig,
  previewEffectiveConfig,
  assignPolicy,
  unassignPolicy,
  getConfigPolicy,
  createConfigPolicy,
  updateConfigPolicy,
  deleteConfigPolicy,
  listFeatureLinks,
  listAssignments,
} from './configurationPolicy';
import {
  getConfigPolicyComplianceRuleInfo,
  getConfigPolicyComplianceStats,
  buildComplianceSummary,
} from '../routes/policyManagement/helpers';

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

function safeHandler(
  toolName: string,
  fn: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>
): (input: Record<string, unknown>, auth: AuthContext) => Promise<string> {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[config-policy:${toolName}]`, message, err);
      return JSON.stringify({ error: `Operation failed: ${message}` });
    }
  };
}

export function registerConfigPolicyTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // 1. list_configuration_policies — Tier 1 (read)
  registerTool({
    tier: 1,
    definition: {
      name: 'list_configuration_policies',
      description: 'List available configuration policies (bundled feature settings) in the organization. Shows policy name, status, and linked feature types.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['active', 'inactive', 'archived'], description: 'Filter by status' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
      },
    },
    handler: safeHandler('list_configuration_policies', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, configurationPolicies.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.status === 'string') {
        conditions.push(eq(configurationPolicies.status, input.status as 'active' | 'inactive' | 'archived'));
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
      const rows = await db
        .select()
        .from(configurationPolicies)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(configurationPolicies.updatedAt))
        .limit(limit);

      // Get feature link counts per policy
      const policyIds = rows.map((r) => r.id);
      const links = policyIds.length > 0
        ? await db
            .select({
              configPolicyId: configPolicyFeatureLinks.configPolicyId,
              featureType: configPolicyFeatureLinks.featureType,
            })
            .from(configPolicyFeatureLinks)
            .where(sql`${configPolicyFeatureLinks.configPolicyId} = ANY(${policyIds})`)
        : [];

      const linksByPolicy = new Map<string, string[]>();
      for (const link of links) {
        const types = linksByPolicy.get(link.configPolicyId) ?? [];
        types.push(link.featureType);
        linksByPolicy.set(link.configPolicyId, types);
      }

      const policiesWithFeatures = rows.map((p) => ({
        ...p,
        featureTypes: linksByPolicy.get(p.id) ?? [],
      }));

      return JSON.stringify({ policies: policiesWithFeatures, showing: rows.length });
    }),
  });

  // 2. get_effective_configuration — Tier 1 (read)
  registerTool({
    tier: 1,
    definition: {
      name: 'get_effective_configuration',
      description: 'Resolve the effective configuration for a device by evaluating all configuration policy assignments in the hierarchy (device > group > site > org > partner). Returns the winning policy per feature type with full inheritance chain for debugging.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID to resolve configuration for' },
        },
        required: ['deviceId'],
      },
    },
    handler: safeHandler('get_effective_configuration', async (input, auth) => {
      const deviceId = input.deviceId as string;
      const result = await resolveEffectiveConfig(deviceId, auth);
      if (!result) return JSON.stringify({ error: 'Device not found or access denied' });
      return JSON.stringify(result);
    }),
  });

  // 3. preview_configuration_change — Tier 1 (read)
  registerTool({
    tier: 1,
    definition: {
      name: 'preview_configuration_change',
      description: 'Preview how adding or removing configuration policy assignments would change the effective configuration for a device. Returns current vs proposed effective config.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          add: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                configPolicyId: { type: 'string', description: 'Configuration policy UUID' },
                level: { type: 'string', enum: ['partner', 'organization', 'site', 'device_group', 'device'], description: 'Assignment level' },
                targetId: { type: 'string', description: 'Target UUID at the given level' },
                priority: { type: 'number', description: 'Priority (lower = higher)' },
              },
              required: ['configPolicyId', 'level', 'targetId'],
            },
            description: 'Assignments to add',
          },
          remove: {
            type: 'array',
            items: { type: 'string' },
            description: 'Assignment UUIDs to remove',
          },
        },
        required: ['deviceId'],
      },
    },
    handler: safeHandler('preview_configuration_change', async (input, auth) => {
      const deviceId = input.deviceId as string;
      const changes = {
        add: input.add as any[] | undefined,
        remove: input.remove as string[] | undefined,
      };

      const result = await previewEffectiveConfig(deviceId, changes, auth);
      if (!result) return JSON.stringify({ error: 'Device not found or access denied' });
      return JSON.stringify(result);
    }),
  });

  // 4. apply_configuration_policy — Tier 2 (write)
  registerTool({
    tier: 2,
    definition: {
      name: 'apply_configuration_policy',
      description: 'Assign a configuration policy to a target (partner, organization, site, device group, or device). This changes which policies are applied at that hierarchy level.',
      input_schema: {
        type: 'object' as const,
        properties: {
          configPolicyId: { type: 'string', description: 'Configuration policy UUID' },
          level: { type: 'string', enum: ['partner', 'organization', 'site', 'device_group', 'device'], description: 'Assignment level' },
          targetId: { type: 'string', description: 'Target UUID at the given level' },
          priority: { type: 'number', description: 'Priority (lower = higher priority, default 0)' },
        },
        required: ['configPolicyId', 'level', 'targetId'],
      },
    },
    handler: safeHandler('apply_configuration_policy', async (input, auth) => {
      const conditions: SQL[] = [eq(configurationPolicies.id, input.configPolicyId as string)];
      const oc = orgWhere(auth, configurationPolicies.orgId);
      if (oc) conditions.push(oc);

      const [policy] = await db.select().from(configurationPolicies).where(and(...conditions)).limit(1);
      if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });

      try {
        const assignment = await assignPolicy(
          input.configPolicyId as string,
          input.level as any,
          input.targetId as string,
          Number(input.priority) || 0,
          auth.user.id
        );

        return JSON.stringify({
          success: true,
          message: `Policy "${policy.name}" assigned to ${input.level} ${input.targetId}`,
          assignmentId: assignment.id,
        });
      } catch (err: any) {
        if (err?.code === '23505') {
          return JSON.stringify({ error: 'This policy is already assigned to this target at this level' });
        }
        throw err;
      }
    }),
  });

  // 5. remove_configuration_policy_assignment — Tier 2 (write)
  registerTool({
    tier: 2,
    definition: {
      name: 'remove_configuration_policy_assignment',
      description: 'Remove a configuration policy assignment, undoing its effect on the target and all devices beneath it in the hierarchy.',
      input_schema: {
        type: 'object' as const,
        properties: {
          assignmentId: { type: 'string', description: 'The assignment UUID to remove' },
        },
        required: ['assignmentId'],
      },
    },
    handler: safeHandler('remove_configuration_policy_assignment', async (input, auth) => {
      // First verify the assignment belongs to an accessible policy (with org isolation)
      const conditions: SQL[] = [eq(configPolicyAssignments.id, input.assignmentId as string)];
      const oc = orgWhere(auth, configurationPolicies.orgId);
      if (oc) conditions.push(oc);

      const [assignment] = await db
        .select({
          id: configPolicyAssignments.id,
          configPolicyId: configPolicyAssignments.configPolicyId,
          policyName: configurationPolicies.name,
          level: configPolicyAssignments.level,
          targetId: configPolicyAssignments.targetId,
        })
        .from(configPolicyAssignments)
        .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
        .where(and(...conditions))
        .limit(1);

      if (!assignment) return JSON.stringify({ error: 'Assignment not found' });

      const deleted = await unassignPolicy(input.assignmentId as string, assignment.configPolicyId);
      if (!deleted) return JSON.stringify({ error: 'Assignment not found' });

      return JSON.stringify({
        success: true,
        message: `Removed "${assignment.policyName}" assignment from ${assignment.level} ${assignment.targetId}`,
      });
    }),
  });

  // 6. get_configuration_policy — Tier 1 (read)
  registerTool({
    tier: 1,
    definition: {
      name: 'get_configuration_policy',
      description: 'Get a single configuration policy by ID with its feature links (bundled feature settings) and assignment count.',
      input_schema: {
        type: 'object' as const,
        properties: {
          policyId: { type: 'string', description: 'Configuration policy UUID' },
        },
        required: ['policyId'],
      },
    },
    handler: safeHandler('get_configuration_policy', async (input, auth) => {
      const policyId = input.policyId as string;
      const policy = await getConfigPolicy(policyId, auth);
      if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });

      const featureLinks = await listFeatureLinks(policyId);
      const assignments = await listAssignments(policyId);

      return JSON.stringify({
        policy,
        featureLinks,
        assignmentCount: assignments.length,
        assignments,
      });
    }),
  });

  // 7. manage_configuration_policy — Tier 1 base, action-escalated
  registerTool({
    tier: 1,
    definition: {
      name: 'manage_configuration_policy',
      description: 'Create, update, activate, deactivate, or delete configuration policies. Configuration policies bundle feature settings (patch, alert, compliance, etc.) and are assigned to targets in the hierarchy.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'activate', 'deactivate', 'delete'], description: 'The action to perform' },
          policyId: { type: 'string', description: 'Configuration policy UUID (required for update/activate/deactivate/delete)' },
          name: { type: 'string', description: 'Policy name (required for create)' },
          description: { type: 'string', description: 'Policy description' },
          status: { type: 'string', enum: ['active', 'inactive', 'archived'], description: 'Policy status (for create/update)' },
          orgId: { type: 'string', description: 'Organization UUID (for create; defaults to current org)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_configuration_policy', async (input, auth) => {
      const action = input.action as string;

      if (action === 'create') {
        const orgId = (input.orgId as string) || getOrgId(auth);
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (!input.name) return JSON.stringify({ error: 'name is required for create' });

        const policy = await createConfigPolicy(orgId, {
          name: input.name as string,
          description: input.description as string | undefined,
          status: (input.status as 'active' | 'inactive' | 'archived') ?? 'active',
        }, auth.user.id);

        return JSON.stringify({ success: true, policy });
      }

      if (action === 'update') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required for update' });
        const updates: { name?: string; description?: string; status?: 'active' | 'inactive' | 'archived' } = {};
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (typeof input.status === 'string') updates.status = input.status as 'active' | 'inactive' | 'archived';

        const updated = await updateConfigPolicy(input.policyId as string, updates, auth);
        if (!updated) return JSON.stringify({ error: 'Configuration policy not found or access denied' });
        return JSON.stringify({ success: true, policy: updated });
      }

      if (action === 'activate' || action === 'deactivate') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const newStatus = action === 'activate' ? 'active' : 'inactive';
        const updated = await updateConfigPolicy(input.policyId as string, { status: newStatus }, auth);
        if (!updated) return JSON.stringify({ error: 'Configuration policy not found or access denied' });
        return JSON.stringify({ success: true, message: `Policy "${updated.name}" ${action}d`, policy: updated });
      }

      if (action === 'delete') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required for delete' });
        const deleted = await deleteConfigPolicy(input.policyId as string, auth);
        if (!deleted) return JSON.stringify({ error: 'Configuration policy not found or access denied' });
        return JSON.stringify({ success: true, message: `Policy "${deleted.name}" deleted` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // 8. configuration_policy_compliance — Tier 1 (read)
  registerTool({
    tier: 1,
    definition: {
      name: 'configuration_policy_compliance',
      description: 'Check compliance status for configuration policies. Use "summary" for org-wide compliance overview across all config policies, or "status" for per-device compliance details for a specific config policy.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['summary', 'status'], description: 'summary = org-wide overview, status = per-policy device compliance' },
          policyId: { type: 'string', description: 'Configuration policy UUID (required for status)' },
          limit: { type: 'number', description: 'Max results for status (default 50)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('configuration_policy_compliance', async (input, auth) => {
      const action = input.action as string;

      if (action === 'summary') {
        // Get all config policies for this org
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, configurationPolicies.orgId);
        if (oc) conditions.push(oc);

        const policies = await db
          .select({ id: configurationPolicies.id, name: configurationPolicies.name, status: configurationPolicies.status })
          .from(configurationPolicies)
          .where(conditions.length > 0 ? and(...conditions) : undefined);

        if (policies.length === 0) {
          return JSON.stringify({ summary: [], message: 'No configuration policies found' });
        }

        // Get all feature links for these policies
        const policyIds = policies.map((p) => p.id);
        const links = await db
          .select({ id: configPolicyFeatureLinks.id, configPolicyId: configPolicyFeatureLinks.configPolicyId, featureType: configPolicyFeatureLinks.featureType })
          .from(configPolicyFeatureLinks)
          .where(inArray(configPolicyFeatureLinks.configPolicyId, policyIds));

        const featureLinkIds = links.map((l) => l.id);

        // Get compliance stats per feature link
        const { byFeatureLink } = featureLinkIds.length > 0
          ? await getConfigPolicyComplianceStats(featureLinkIds)
          : { byFeatureLink: new Map() };

        // Aggregate stats per config policy
        const summary = policies.map((policy) => {
          const policyLinks = links.filter((l) => l.configPolicyId === policy.id);
          let total = 0, compliant = 0, nonCompliant = 0, pending = 0, error = 0;

          for (const link of policyLinks) {
            const stats = byFeatureLink.get(link.id);
            if (stats) {
              total += stats.total;
              compliant += stats.compliant;
              nonCompliant += stats.nonCompliant;
              pending += stats.pending;
              error += stats.error;
            }
          }

          return {
            policyId: policy.id,
            policyName: policy.name,
            status: policy.status,
            featureCount: policyLinks.length,
            compliance: { total, compliant, nonCompliant, pending, error },
          };
        });

        return JSON.stringify({ summary });
      }

      if (action === 'status') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required for status' });
        const policyId = input.policyId as string;

        // Verify access to this policy
        const policy = await getConfigPolicy(policyId, auth);
        if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });

        // Get feature links for this policy
        const links = await listFeatureLinks(policyId);
        const featureLinkIds = links.map((l) => l.id);

        if (featureLinkIds.length === 0) {
          return JSON.stringify({ policyId, policyName: policy.name, devices: [], message: 'No feature links configured' });
        }

        // Get per-device compliance rows for these feature links
        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        const rows = await db
          .select({
            configPolicyId: automationPolicyCompliance.configPolicyId,
            configItemName: automationPolicyCompliance.configItemName,
            deviceId: automationPolicyCompliance.deviceId,
            status: automationPolicyCompliance.status,
            details: automationPolicyCompliance.details,
            lastCheckedAt: automationPolicyCompliance.lastCheckedAt,
            remediationAttempts: automationPolicyCompliance.remediationAttempts,
          })
          .from(automationPolicyCompliance)
          .where(
            and(
              isNull(automationPolicyCompliance.policyId),
              isNotNull(automationPolicyCompliance.configPolicyId),
              inArray(automationPolicyCompliance.configPolicyId, featureLinkIds)
            )
          )
          .limit(limit);

        return JSON.stringify({
          policyId,
          policyName: policy.name,
          devices: rows,
          showing: rows.length,
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
