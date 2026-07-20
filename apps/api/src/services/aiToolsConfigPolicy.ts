import { db } from '../db';
import { ORG_SCOPED_ONLY_FEATURE_TYPES, type ConfigFeatureType } from '@breeze/shared/constants';
import { configurationPolicies, configPolicyFeatureLinks, configPolicyAssignments, automationPolicyCompliance } from '../db/schema';
import { eq, and, desc, isNull, isNotNull, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { onedriveHelperInlineSettingsSchema } from '@breeze/shared/validators';
import { sanitizeThrownToolError } from './aiToolErrors';
import {
  resolveEffectiveConfig,
  previewEffectiveConfig,
  assignPolicy,
  unassignPolicy,
  getConfigPolicy,
  createConfigPolicy,
  updateConfigPolicy,
  deleteConfigPolicy,
  addFeatureLink,
  updateFeatureLink,
  removeFeatureLink,
  listFeatureLinks,
  listAssignments,
  validateAssignmentTarget,
  authorizeAssignmentTarget,
  canManagePartnerWidePolicies,
  policyAccessCondition,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from './configurationPolicy';
import {
  getConfigPolicyComplianceRuleInfo,
  getConfigPolicyComplianceStats,
  buildComplianceSummary,
} from '../routes/policyManagement/helpers';

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

/**
 * addFeatureLink/updateFeatureLink keep the feature link's inlineSettings JSONB
 * as a compatibility/UI mirror alongside the normalized settings tables. For
 * onedrive_helper, decomposeInlineSettings runs the raw input back through
 * onedriveHelperInlineSettingsSchema.parse when writing the normalized row, so
 * that row always carries schema defaults — but the JSONB mirror gets whatever
 * was passed in. Without pre-normalizing here, the AI path would leave the
 * mirror storing un-defaulted raw input while the normalized row (and every
 * other write path) gets defaults filled in. Mirrors validateRingAutoApprove's
 * shape (aiToolsPolicyPrereqs.ts).
 */
function validateOnedriveHelperInlineSettings(
  raw: unknown
): { value: unknown } | { error: string } {
  const parsed = onedriveHelperInlineSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid onedrive_helper inline settings.';
    return { error: message };
  }
  return { value: parsed.data };
}

function safeHandler(
  toolName: string,
  fn: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>
): (input: Record<string, unknown>, auth: AuthContext) => Promise<string> {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      // Fail closed: `message` may be a raw driver string (#2603).
      return JSON.stringify({
        error: sanitizeThrownToolError(`config-policy:${toolName}`, err),
      });
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
      description: 'List available configuration policies (bundled feature settings) visible to the caller — organization-owned policies plus, for partner-scoped callers, partner-wide ("all orgs") policies. Shows policy name, status, and linked feature types.',
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
      // Dual-axis visibility (#1724): a partner-scoped caller must also see
      // partner-OWNED policies (org_id NULL), which auth.orgCondition alone
      // excludes. policyAccessCondition is the same reader the HTTP routes use.
      const oc = policyAccessCondition(auth);
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
            .where(inArray(configPolicyFeatureLinks.configPolicyId, policyIds))
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
    deviceArgs: ['deviceId'],
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
    deviceArgs: ['deviceId'],
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
      description: 'Assign a configuration policy to a target (partner, organization, site, device group, or device). Use roleFilter and osFilter to scope the assignment to specific device types. The "partner" level is reserved for partner-OWNED policies (a reusable library, #2280, assignable to all orgs or a subset) — an org-owned policy can only be assigned at organization/site/device_group/device level.',
      input_schema: {
        type: 'object' as const,
        properties: {
          configPolicyId: { type: 'string', description: 'Configuration policy UUID' },
          level: { type: 'string', enum: ['partner', 'organization', 'site', 'device_group', 'device'], description: 'Assignment level' },
          targetId: { type: 'string', description: 'Target UUID at the given level. Required for organization/site/device_group/device; omit for the "partner" level, where the target is derived server-side (the policy\'s own partner).' },
          priority: { type: 'number', description: 'Priority (lower = higher priority, default 0)' },
          roleFilter: { type: 'array', items: { type: 'string' }, description: 'Only apply to devices with these roles (e.g. ["workstation","server"]). Omit for all roles.' },
          osFilter: { type: 'array', items: { type: 'string' }, description: 'Only apply to devices with these OS types (e.g. ["windows","macos","linux"]). Omit for all OS.' },
        },
        required: ['configPolicyId', 'level'],
      },
    },
    handler: safeHandler('apply_configuration_policy', async (input, auth) => {
      // Dual-axis reader so a partner-scoped caller can reach a partner-OWNED
      // policy (org_id NULL) to assign it — auth.orgCondition alone hid these.
      const conditions: SQL[] = [eq(configurationPolicies.id, input.configPolicyId as string)];
      const oc = policyAccessCondition(auth);
      if (oc) conditions.push(oc);

      const [policy] = await db.select().from(configurationPolicies).where(and(...conditions)).limit(1);
      if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });

      // Partner-owned policies (org_id NULL) are the partner library (#2280).
      // ANY assignment on one — at any level, not just 'partner' — pushes
      // config into orgs the caller may not fully control, so all writes
      // require full partner org access. Mirrors the HTTP route's gate
      // (routes/configurationPolicies/assignments.ts).
      if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      }

      // At the partner level the target is the partner itself, derived
      // server-side — never from a client-supplied value (#1724). It's the
      // policy's own partner (or the caller's, for a fresh partner-owned
      // policy). An org-owned policy also reaches this block, but its
      // auth.partnerId fallback target is rejected downstream by
      // validateAssignmentTarget, so the fallback only ever serves partner-owned
      // policies.
      let targetId = input.targetId as string;
      if (input.level === 'partner') {
        const derived = policy.partnerId ?? auth.partnerId;
        if (!derived) {
          return JSON.stringify({ error: 'Partner-wide assignments require partner scope' });
        }
        targetId = derived;
      }
      if (!targetId) {
        return JSON.stringify({ error: 'targetId is required for this assignment level' });
      }

      const targetValidation = await validateAssignmentTarget(
        { orgId: policy.orgId, partnerId: policy.partnerId },
        input.level as any,
        targetId
      );
      if (!targetValidation.valid) {
        return JSON.stringify({ error: targetValidation.error });
      }

      // Site sub-axis (SR5-07): RLS does not enforce the site allowlist, so a
      // site-restricted caller must be blocked from assigning to org/partner
      // targets or to a site/group/device outside their allowed sites.
      const siteAuth = await authorizeAssignmentTarget(auth, input.level as any, targetId);
      if (!siteAuth.valid) {
        return JSON.stringify({ error: siteAuth.error });
      }

      // assignPolicy returns null (instead of throwing) on a duplicate — see
      // the comment on its onConflictDoNothing insert in configurationPolicy.ts
      // for why the raised-violation catch pattern doesn't work inside this
      // tool call's withDbAccessContext transaction.
      const assignment = await assignPolicy(
        input.configPolicyId as string,
        input.level as any,
        targetId,
        Number(input.priority) || 0,
        auth.user.id,
        (input.roleFilter as string[] | undefined),
        (input.osFilter as string[] | undefined)
      );

      if (!assignment) {
        return JSON.stringify({ error: 'This policy is already assigned to this target at this level' });
      }

      return JSON.stringify({
        success: true,
        message: `Policy "${policy.name}" assigned to ${input.level} ${targetId}`,
        assignmentId: assignment.id,
      });
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
      // Verify the assignment belongs to a policy the caller can see. The
      // dual-axis reader keeps partner-OWNED policies (org_id NULL) reachable
      // for partner-scoped callers; policyOrgId is selected so the partner-wide
      // write gate below can fire.
      const conditions: SQL[] = [eq(configPolicyAssignments.id, input.assignmentId as string)];
      const oc = policyAccessCondition(auth);
      if (oc) conditions.push(oc);

      const [assignment] = await db
        .select({
          id: configPolicyAssignments.id,
          configPolicyId: configPolicyAssignments.configPolicyId,
          policyName: configurationPolicies.name,
          policyOrgId: configurationPolicies.orgId,
          level: configPolicyAssignments.level,
          targetId: configPolicyAssignments.targetId,
        })
        .from(configPolicyAssignments)
        .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
        .where(and(...conditions))
        .limit(1);

      if (!assignment) return JSON.stringify({ error: 'Assignment not found' });

      // Any assignment on a partner-owned library policy (#2280) — partner-level
      // (all orgs) or a narrower org/site/group/device row — is a partner-wide-
      // access capability: the delete may strip config from one org or every org
      // under the partner. Same blast radius as assigning, so the same gate applies.
      if (assignment.policyOrgId === null && !canManagePartnerWidePolicies(auth)) {
        return JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      }

      // Site sub-axis (SR5-07): re-check against the stored target so a
      // site-restricted caller can't remove an assignment reaching a site,
      // group, or device outside their allowlist (RLS does not enforce site).
      const siteAuth = await authorizeAssignmentTarget(auth, assignment.level as any, assignment.targetId);
      if (!siteAuth.valid) {
        return JSON.stringify({ error: siteAuth.error });
      }

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
      description: 'Create, update, activate, deactivate, or delete configuration policies. Configuration policies bundle feature settings (patch, alert, compliance, etc.) and are assigned to targets in the hierarchy. On create, ownerScope "partner" makes a reusable partner-owned library policy that applies to NO organizations until assigned (partner-wide, or a subset of orgs) via apply_configuration_policy (requires full partner org access); "organization" (default) owns it in a single org.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'activate', 'deactivate', 'delete'], description: 'The action to perform' },
          policyId: { type: 'string', description: 'Configuration policy UUID (required for update/activate/deactivate/delete)' },
          name: { type: 'string', description: 'Policy name (required for create)' },
          description: { type: 'string', description: 'Policy description' },
          status: { type: 'string', enum: ['active', 'inactive', 'archived'], description: 'Policy status (for create/update)' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'Ownership for create: "organization" (default, owned by one org) or "partner" (a reusable partner-owned library policy, created empty and applied to orgs later via apply_configuration_policy; requires full partner org access)' },
          orgId: { type: 'string', description: 'Organization UUID (for org-scoped create; defaults to current org). Ignored when ownerScope is "partner".' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_configuration_policy', async (input, auth) => {
      const action = input.action as string;

      if (action === 'create') {
        if (!input.name) return JSON.stringify({ error: 'name is required for create' });

        // Partner-wide ("all orgs") policy (#1724). The partner is ALWAYS derived
        // from the caller's own token — never a client-supplied value — so a
        // caller cannot create a policy owned by another partner. A partner-wide
        // policy pushes config to EVERY org under the partner, so only callers
        // with full partner org access (orgAccess='all', or system scope) may
        // create one — the same gate the HTTP route enforces.
        if (input.ownerScope === 'partner') {
          if (!auth.partnerId) {
            return JSON.stringify({ error: 'Partner-wide policies require partner scope' });
          }
          if (!canManagePartnerWidePolicies(auth)) {
            return JSON.stringify({ error: 'Partner-wide policies require full partner org access (orgAccess must be "all")' });
          }

          // Duplicate-name check within the partner's own partner-wide policies.
          const [existing] = await db.select({ id: configurationPolicies.id, status: configurationPolicies.status })
            .from(configurationPolicies)
            .where(and(
              eq(configurationPolicies.partnerId, auth.partnerId),
              eq(configurationPolicies.name, input.name as string),
            ))
            .limit(1);
          if (existing) {
            return JSON.stringify({
              error: `A partner-wide configuration policy named "${input.name}" already exists (id: ${existing.id}, status: ${existing.status}). Use get_configuration_policy to view it, or choose a different name.`,
            });
          }

          const policy = await createConfigPolicy({ partnerId: auth.partnerId }, {
            name: input.name as string,
            description: input.description as string | undefined,
            status: (input.status as 'active' | 'inactive' | 'archived') ?? 'active',
          }, auth.user.id);

          // Library model (#2280): partner-owned policies are created EMPTY —
          // no auto-seeded assignment. It's applied to orgs later via explicit
          // apply_configuration_policy calls (partner-wide, or a subset of
          // orgs). Mirrors the HTTP create route
          // (routes/configurationPolicies/crud.ts), which stopped auto-seeding
          // the partner-level assignment for the same reason.
          return JSON.stringify({ success: true, policy });
        }

        const orgId = (input.orgId as string) || getOrgId(auth);
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (input.orgId && !auth.canAccessOrg(input.orgId as string)) {
          return JSON.stringify({ error: 'Access denied to this organization' });
        }

        // Check for duplicate name in same org
        const [existing] = await db.select({ id: configurationPolicies.id, status: configurationPolicies.status })
          .from(configurationPolicies)
          .where(and(
            eq(configurationPolicies.orgId, orgId),
            eq(configurationPolicies.name, input.name as string),
          ))
          .limit(1);
        if (existing) {
          return JSON.stringify({
            error: `A configuration policy named "${input.name}" already exists (id: ${existing.id}, status: ${existing.status}). Use get_configuration_policy to view it, or choose a different name.`,
          });
        }

        const policy = await createConfigPolicy({ orgId }, {
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
        // Get all config policies the caller can see — org-owned AND partner-wide
        // (org_id NULL) for partner-scoped callers, via the dual-axis reader.
        const conditions: SQL[] = [];
        const oc = policyAccessCondition(auth);
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

  // 9. manage_policy_feature_link — Tier 2 (write)
  registerTool({
    tier: 2,
    definition: {
      name: 'manage_policy_feature_link',
      description: `Add, update, remove, or list feature links on a configuration policy. Feature links define the actual settings bundled into a policy. Each policy can have one link per feature type. This is the STANDARD way to configure all device management features.

Inline settings shapes by feature type:
- patch: { sources: ["os","third_party"], autoApprove: true, autoApproveSeverities: ["critical","important"], scheduleFrequency: "daily"|"weekly"|"monthly", scheduleTime: "02:00", scheduleDayOfWeek?: "tue", scheduleDayOfMonth?: 1, rebootPolicy: "never"|"if_required"|"always"|"maintenance_window" }
- alert_rule: { items: [{ name, severity: "critical"|"high"|"medium"|"low"|"info", conditions: [{ type: "threshold"|"offline"|"event_log", metric?: "cpuPercent"|"ramPercent"|"diskPercent", operator?: "gt"|"lt"|"gte"|"lte", value?: number, durationMinutes?: number, level?: "error"|"warning"|"critical", category?: "security"|"hardware"|"application"|"system", countThreshold?: number, windowMinutes?: number, messagePattern?: string }], cooldownMinutes?: 15, autoResolve?: false }] }
- monitoring: { checkIntervalSeconds: 60, watches: [{ watchType: "service"|"process", name: "wuauserv", displayName?: "Windows Update", enabled: true, alertOnStop: true, alertAfterConsecutiveFailures: 2, alertSeverity: "critical"|"high"|"medium"|"low"|"info", cpuThresholdPercent?: 90, memoryThresholdMb?: 500, thresholdDurationSeconds: 300, autoRestart: false, maxRestartAttempts: 3, restartCooldownSeconds: 300 }], eventLogAlerts?: [{ name, category: "security"|"hardware"|"application"|"system", level: "warning"|"error"|"critical", sourcePattern?, messagePattern?, countThreshold: 1, windowMinutes: 15, severity: "high", enabled: true }] }
- maintenance: { recurrence: "once"|"daily"|"weekly"|"monthly", windowStart?: "ISO-8601 (for once)", durationHours: 1-72, timezone: "America/New_York", suppressAlerts: true, suppressPatching: true, suppressAutomations: false, suppressScripts: false, notifyBeforeMinutes?: 15, notifyOnStart: true, notifyOnEnd: true }
- automation: { items: [{ name, enabled: true, triggerType: "schedule"|"event"|"manual", cronExpression?: "0 2 * * *", timezone?: "America/New_York", eventType?: "device.offline"|"alert.triggered"|"compliance.failed"|"patch.available", actions: [{ type: "run_script"|"send_notification"|"create_alert"|"execute_command", scriptId?|channelId?|severity?|message?|command? }], onFailure: "stop"|"continue"|"notify" }] }
- event_log: { retentionDays: 30, maxEventsPerCycle: 100, collectCategories: ["security","hardware","application","system"], minimumLevel: "info"|"warning"|"error"|"critical", collectionIntervalMinutes: 15, rateLimitPerHour: 12000 }
- compliance: { items: [{ name, enforcementLevel: "monitor"|"warn"|"enforce", checkIntervalMinutes: 60, rules: [{ type: "required_software"|"prohibited_software"|"disk_space_minimum"|"os_version"|"registry_check"|"config_file_check", name?|minGb?|osType?|path?|valueName?|expectedValue?|minVersion? }] }] }
- security: { realTimeProtection: true, behavioralMonitoring: true, cloudLookup: true, scheduledScans: true, scanHour: "2", scanMinute: "0", scanDayOfWeek: "*", scanDayOfMonth: "*", autoQuarantine: true, notifyUser: true, blockUntrustedUsb: false, exclusions: [] }
- backup: { scheduleFrequency: "daily"|"weekly"|"monthly", scheduleTime: "02:00", scheduleDayOfWeek?: "tue", retentionPreset: "standard"|"extended"|"compliance"|"custom", retentionDays?: 30, retentionVersions?: 5, compression: true, encryption: true, paths: [], excludePatterns: [], notifyOnFailure: true, notifyOnSuccess: false, notifyOnMissed: true }
- sensitive_data: { detectionClasses: ["credential","pci","phi","pii","financial"], includePaths: [], excludePaths: [], fileTypes: [], maxFileSizeBytes: 104857600, workers: 4, timeoutSeconds: 300, scheduleType: "manual"|"interval"|"cron", intervalMinutes?: 60, cron?: "...", timezone: "UTC" }
- warranty: { enabled: true, warnDays: 90, criticalDays: 30 }
- helper: { enabled: true, showOpenPortal: true, showDeviceInfo: true, showRequestSupport: true, portalUrl?: "" }
- pam: inlineSettings {uacInterceptionEnabled: boolean} — Windows UAC elevation prompt capture (default false / opt-in: capture is OFF when no policy assigns this feature). PAM rules/approvals are managed separately in the /pam console, not via config policies.
- vulnerability: inlineSettings {enabled: boolean} — per-device CVE correlation / vulnerability scanning (default false / opt-in: devices with no policy are NOT scanned). Findings appear in the /vulnerabilities console; correlation runs daily.
- remote_access: { webrtcDesktop: true, vncRelay: false, remoteTools: true, clipboardHostToViewer: true, clipboardViewerToHost: true, enableProxy: false, defaultAllowedPorts: [80,443], autoEnableProxy: false, maxConcurrentTunnels: 5, idleTimeoutMinutes: 5, maxSessionDurationHours: 8, sessionPromptMode?: "off"|"notify"|"consent", consentUnavailableBehavior?: "proceed"|"block", notifyOnSessionEnd?: true, showActiveIndicator?: true, technicianIdentityLevel?: "name_email"|"name"|"generic" } — all fields optional; updates MERGE over the currently stored settings, so send only the fields to change. Unknown keys are stripped, never applied — use exactly these key names.
- onedrive_helper: { silentAccountConfig?, filesOnDemand?, kfmSilentOptIn?, kfmFolders? (Desktop/Documents/Pictures), kfmBlockOptOut?, tenantAssociationId?, restartOnChange?, libraries?: [{ libraryId, displayName, targetingMode (everyone|graph_group|local_ad_group), groupId?, groupName?, siteUrl? }] }

For link-only types, set featurePolicyId instead of inlineSettings:
- software_policy: featurePolicyId → existing software policy UUID
- peripheral_control: featurePolicyId → existing peripheral policy UUID
- backup: featurePolicyId → backup PROFILE UUID (manage_backup_profiles — "what to protect"), combined with inlineSettings { schedule, retention, destinationConfigId? } (destination omitted = the device org's default destination). Legacy links with featurePolicyId → backup config UUID still work. Partner-wide policies may link partner-wide profiles; their destination always resolves per device org.
- patch: can also use featurePolicyId → existing update ring UUID (for approval deferral), combined with inlineSettings for schedule/reboot`,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'remove', 'list'], description: 'The action to perform' },
          configPolicyId: { type: 'string', description: 'Configuration policy UUID' },
          featureLinkId: { type: 'string', description: 'Feature link UUID (required for update/remove)' },
          featureType: {
            type: 'string',
            enum: [
              'patch', 'alert_rule', 'backup', 'security', 'monitoring',
              'maintenance', 'compliance', 'automation', 'event_log',
              'software_policy', 'sensitive_data', 'peripheral_control',
              'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper', 'vulnerability',
            ],
            description: 'Feature type (required for add)',
          },
          featurePolicyId: { type: 'string', description: 'Standalone policy UUID to link (for linked policy types)' },
          inlineSettings: { type: 'object', description: 'Inline configuration settings (see description for shapes per feature type)' },
        },
        required: ['action', 'configPolicyId'],
      },
    },
    handler: safeHandler('manage_policy_feature_link', async (input, auth) => {
      const action = input.action as string;
      const configPolicyId = input.configPolicyId as string;

      // Verify access to the parent policy
      const policy = await getConfigPolicy(configPolicyId, auth);
      if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });

      if (action === 'list') {
        const links = await listFeatureLinks(configPolicyId);
        return JSON.stringify({ configPolicyId, policyName: policy.name, featureLinks: links });
      }

      // Feature-link writes on a partner-wide policy (org_id NULL) push config
      // to every org under the partner — same capability gate as the HTTP
      // routes. (The add/update/remove services below don't take auth, so this
      // handler is the enforcement point for the AI path.)
      if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      }

      if (action === 'add') {
        const featureType = input.featureType as string | undefined;
        if (!featureType) return JSON.stringify({ error: 'featureType is required for add' });

        // Org-scoped-only features (backup, onedrive_helper) can't be authored
        // on a partner-wide policy — mirror the HTTP route's 400 rejection
        // (featureLinks.ts) here, since addFeatureLink itself doesn't know the
        // policy's owner. Shared source of truth: ORG_SCOPED_ONLY_FEATURE_TYPES.
        if (policy.orgId === null && ORG_SCOPED_ONLY_FEATURE_TYPES.has(featureType as ConfigFeatureType)) {
          return JSON.stringify({
            error: `The "${featureType}" feature is not supported on partner-wide policies; it must be configured on an organization-scoped policy.`,
          });
        }

        let inlineSettings: unknown = input.inlineSettings;
        if (featureType === 'onedrive_helper' && inlineSettings !== undefined && inlineSettings !== null) {
          const validated = validateOnedriveHelperInlineSettings(inlineSettings);
          if ('error' in validated) return JSON.stringify({ error: validated.error });
          inlineSettings = validated.value;
        }

        // addFeatureLink returns null (instead of throwing) on a duplicate —
        // see the comment on its onConflictDoNothing insert in
        // configurationPolicy.ts for why the raised-violation catch pattern
        // doesn't work inside this tool call's withDbAccessContext transaction.
        const link = await addFeatureLink(
          configPolicyId,
          featureType as any,
          (input.featurePolicyId as string) ?? null,
          inlineSettings ?? null
        );
        if (!link) {
          return JSON.stringify({ error: `Feature type "${featureType}" already exists on this policy. Use update action instead.` });
        }
        return JSON.stringify({ success: true, featureLink: link });
      }

      if (action === 'update') {
        const featureLinkId = input.featureLinkId as string | undefined;
        if (!featureLinkId) return JSON.stringify({ error: 'featureLinkId is required for update' });

        const updates: { featurePolicyId?: string | null; inlineSettings?: unknown } = {};
        if (input.featurePolicyId !== undefined) updates.featurePolicyId = input.featurePolicyId as string | null;
        if (input.inlineSettings !== undefined) {
          let inlineSettings: unknown = input.inlineSettings;
          // update doesn't take featureType, so look up the existing link's
          // type to know whether onedrive_helper's normalize-via-schema
          // applies (same reasoning as the 'add' branch above).
          const [existingLink] = await db
            .select({ featureType: configPolicyFeatureLinks.featureType })
            .from(configPolicyFeatureLinks)
            .where(and(eq(configPolicyFeatureLinks.id, featureLinkId), eq(configPolicyFeatureLinks.configPolicyId, configPolicyId)))
            .limit(1);
          if (existingLink?.featureType === 'onedrive_helper' && inlineSettings !== null) {
            const validated = validateOnedriveHelperInlineSettings(inlineSettings);
            if ('error' in validated) return JSON.stringify({ error: validated.error });
            inlineSettings = validated.value;
          }
          updates.inlineSettings = inlineSettings;
        }

        const updated = await updateFeatureLink(featureLinkId, updates, configPolicyId);
        if (!updated) return JSON.stringify({ error: 'Feature link not found' });
        return JSON.stringify({ success: true, featureLink: updated });
      }

      if (action === 'remove') {
        const featureLinkId = input.featureLinkId as string | undefined;
        if (!featureLinkId) return JSON.stringify({ error: 'featureLinkId is required for remove' });

        const deleted = await removeFeatureLink(featureLinkId, configPolicyId);
        if (!deleted) return JSON.stringify({ error: 'Feature link not found' });
        return JSON.stringify({ success: true, message: `Feature link removed` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
