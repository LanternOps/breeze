import { db } from '../db';
import { configurationPolicies, configPolicyFeatureLinks, configPolicyAssignments } from '../db/schema';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  resolveEffectiveConfig,
  previewEffectiveConfig,
  assignPolicy,
  unassignPolicy,
} from './configurationPolicy';

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
}
