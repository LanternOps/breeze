/**
 * AI Browser Security Tools
 *
 * Tools for querying browser extension inventory and managing browser policies.
 * - get_browser_security (Tier 1): Browser extension risk summary and policy violations
 * - manage_browser_policy (Tier 3): Create, update, list, and apply browser extension policies
 */

import { db } from '../db';
import {
  devices,
  browserExtensions,
  browserPolicies,
  browserPolicyViolations
} from '../db/schema';
import { eq, and, desc, sql, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { publishEvent } from './eventBus';
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';
import { aiDispatchDeviceCommand } from './aiDispatch';
import { deviceScopeCondition, resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';

type AiToolTier = 1 | 2 | 3 | 4;

function resolveWritableToolOrgId(
  auth: AuthContext,
  inputOrgId?: string
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required' };
    if (inputOrgId && inputOrgId !== auth.orgId) {
      return { error: 'Cannot access another organization' };
    }
    return { orgId: auth.orgId };
  }

  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: inputOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this operation' };
}

// A site-restricted caller may only mutate policies that target sites entirely
// within their allowlist. Org/group/device/tag targets are not site-bounded, so
// a site-restricted caller cannot confirm scope over them and is denied.
//
// An EXACT-DEVICE caller (`allowedDeviceIds`, set on every device-bound agent
// run) is denied outright: a browser policy targets sites/orgs/groups, never a
// single device, so such a caller can never confirm scope over one. Callers
// with NEITHER restriction always pass. Mirrors the route-layer
// browserSecurity.ts helper (AuthContext flavour).
export function policyWithinSiteWriteScope(
  auth: AuthContext,
  targetType: string,
  targetIds: string[] | null | undefined,
): boolean {
  if (auth.allowedDeviceIds) return false;
  if (!auth.allowedSiteIds || !auth.canAccessSite) return true;
  if (targetType !== 'site') return false;
  const ids = targetIds ?? [];
  if (ids.length === 0) return false;
  return ids.every((id) => auth.canAccessSite!(id));
}

/**
 * READ counterpart of `policyWithinSiteWriteScope` for the policy LIST branch.
 *
 * The write helper denies an exact-device caller outright, which is right for a
 * mutation but would hide every policy from a device-bound run on read. The
 * leak a list has to close is narrower: a DEVICE-targeted policy names sibling
 * devices in `targetIds`, so listing one discloses devices outside the run's
 * allowlist (#6086 finding 10). Org/site/group/tag targets are not
 * device-attributable and stay visible; the site axis keeps its existing read
 * behaviour (policies are org-keyed, and the write path guards mutations).
 *
 * Callers with no `allowedDeviceIds` are unaffected.
 */
export function policyWithinDeviceReadScope(
  auth: AuthContext,
  targetType: string,
  targetIds: string[] | null | undefined,
): boolean {
  if (!auth.allowedDeviceIds) return true;
  if (targetType !== 'device') return true;
  return (targetIds ?? []).every((id) => auth.allowedDeviceIds!.includes(id));
}

export function registerBrowserTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // get_browser_security - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_browser_security',
      description: 'Get browser extension inventory risk summary and active browser policy violations.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Organization UUID (required for partner/system contexts with multiple orgs)' },
          deviceId: { type: 'string', description: 'Optional device UUID filter' },
          browser: { type: 'string', enum: ['chrome', 'edge', 'firefox', 'safari', 'brave', 'other'], description: 'Optional browser filter' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Optional risk filter' },
          includeViolations: { type: 'boolean', description: 'Include unresolved policy violations (default true)' },
          limit: { type: 'number', description: 'Max extension rows to return (default 100, max 500)' }
        }
      }
    },
    handler: async (input, auth) => {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(browserExtensions.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (typeof input.orgId === 'string') {
        if (!auth.canAccessOrg(input.orgId)) {
          return JSON.stringify({ error: 'Access denied to this organization' });
        }
        conditions.push(eq(browserExtensions.orgId, input.orgId));
      }
      if (typeof input.deviceId === 'string') {
        conditions.push(eq(browserExtensions.deviceId, input.deviceId));
      }
      if (typeof input.browser === 'string') {
        conditions.push(eq(browserExtensions.browser, input.browser));
      }
      if (typeof input.riskLevel === 'string') {
        conditions.push(eq(browserExtensions.riskLevel, input.riskLevel));
      }

      // Site axis: a site-restricted caller may only read rows for devices in
      // their allowed sites (RLS does NOT enforce site). Narrow both the
      // extension and violation reads to that device set; short-circuit to empty
      // when the caller has no in-scope devices.
      //
      // The EXACT-DEVICE axis is pushed first and unconditionally: it needs no
      // org lookup, and the site branch below is gated on `allowedSiteIds`,
      // which a device-less analysis run never carries — that shape read every
      // sibling device's extensions (#6086, same class as finding 10).
      const extDeviceCond = deviceScopeCondition(auth, browserExtensions.deviceId);
      if (extDeviceCond) conditions.push(extDeviceCond);

      const siteScopeOrgId = auth.orgId ?? (typeof input.orgId === 'string' ? input.orgId : null);
      let siteAllowedDeviceIds: string[] | null = null;
      if ((auth.allowedSiteIds || auth.allowedDeviceIds) && siteScopeOrgId) {
        siteAllowedDeviceIds = await resolveSiteAllowedDeviceIds(siteScopeOrgId, auth);
        if (typeof input.deviceId === 'string' && !siteAllowedDeviceIds!.includes(input.deviceId)) {
          return JSON.stringify({ error: 'Device not found or access denied' });
        }
        if (!siteAllowedDeviceIds || siteAllowedDeviceIds.length === 0) {
          return JSON.stringify({
            summary: { total: 0, low: 0, medium: 0, high: 0, critical: 0, sideloaded: 0 },
            extensions: [],
            violations: [],
          });
        }
        conditions.push(inArray(browserExtensions.deviceId, siteAllowedDeviceIds));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);

      const [summaryRows, extensions] = await Promise.all([
        db
          .select({
            total: sql<number>`count(*)::int`,
            low: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'low' then 1 else 0 end), 0)::int`,
            medium: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'medium' then 1 else 0 end), 0)::int`,
            high: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'high' then 1 else 0 end), 0)::int`,
            critical: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'critical' then 1 else 0 end), 0)::int`,
            sideloaded: sql<number>`coalesce(sum(case when ${browserExtensions.source} = 'sideloaded' then 1 else 0 end), 0)::int`
          })
          .from(browserExtensions)
          .where(where),
        db
          .select({
            orgId: browserExtensions.orgId,
            deviceId: browserExtensions.deviceId,
            deviceName: devices.hostname,
            browser: browserExtensions.browser,
            extensionId: browserExtensions.extensionId,
            name: browserExtensions.name,
            version: browserExtensions.version,
            source: browserExtensions.source,
            riskLevel: browserExtensions.riskLevel,
            enabled: browserExtensions.enabled,
            lastSeenAt: browserExtensions.lastSeenAt
          })
          .from(browserExtensions)
          .innerJoin(devices, eq(browserExtensions.deviceId, devices.id))
          .where(where)
          .orderBy(desc(browserExtensions.lastSeenAt))
          .limit(limit)
      ]);

      const summaryRow = summaryRows[0];
      const includeViolations = input.includeViolations !== false;
      let violations: Array<Record<string, unknown>> = [];
      if (includeViolations) {
        const violationConditions: SQL[] = [sql`${browserPolicyViolations.resolvedAt} is null`];
        const violationOrgCondition = auth.orgCondition(browserPolicyViolations.orgId);
        if (violationOrgCondition) violationConditions.push(violationOrgCondition);
        if (typeof input.orgId === 'string') violationConditions.push(eq(browserPolicyViolations.orgId, input.orgId));
        if (typeof input.deviceId === 'string') violationConditions.push(eq(browserPolicyViolations.deviceId, input.deviceId));
        // Same site-axis narrowing as the extension read above.
        if (siteAllowedDeviceIds) violationConditions.push(inArray(browserPolicyViolations.deviceId, siteAllowedDeviceIds));
        const violationDeviceCond = deviceScopeCondition(auth, browserPolicyViolations.deviceId);
        if (violationDeviceCond) violationConditions.push(violationDeviceCond);

        const rows = await db
          .select({
            id: browserPolicyViolations.id,
            orgId: browserPolicyViolations.orgId,
            deviceId: browserPolicyViolations.deviceId,
            deviceName: devices.hostname,
            policyId: browserPolicyViolations.policyId,
            violationType: browserPolicyViolations.violationType,
            details: browserPolicyViolations.details,
            detectedAt: browserPolicyViolations.detectedAt
          })
          .from(browserPolicyViolations)
          .innerJoin(devices, eq(browserPolicyViolations.deviceId, devices.id))
          .where(and(...violationConditions))
          .orderBy(desc(browserPolicyViolations.detectedAt))
          .limit(Math.min(limit, 100));
        violations = rows;
      }

      return JSON.stringify({
        summary: {
          total: Number(summaryRow?.total ?? 0),
          low: Number(summaryRow?.low ?? 0),
          medium: Number(summaryRow?.medium ?? 0),
          high: Number(summaryRow?.high ?? 0),
          critical: Number(summaryRow?.critical ?? 0),
          sideloaded: Number(summaryRow?.sideloaded ?? 0)
        },
        extensions,
        violations
      });
    }
  });

  // ============================================
  // manage_browser_policy - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'manage_browser_policy',
      description: 'Create, update, list, and apply browser extension compliance policies.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'apply'], description: 'Policy action' },
          policyId: { type: 'string', description: 'Policy UUID for update/apply' },
          orgId: { type: 'string', description: 'Organization UUID for create/list (if needed by scope)' },
          name: { type: 'string', description: 'Policy name for create/update' },
          targetType: { type: 'string', enum: ['org', 'site', 'group', 'device', 'tag'], description: 'Target scope for create/update' },
          targetIds: { type: 'array', items: { type: 'string' }, description: 'Target IDs for create/update' },
          allowedExtensions: { type: 'array', items: { type: 'string' } },
          blockedExtensions: { type: 'array', items: { type: 'string' } },
          requiredExtensions: { type: 'array', items: { type: 'string' } },
          settings: { type: 'object', additionalProperties: true },
          isActive: { type: 'boolean' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Explicit device IDs for apply; defaults to org-wide when targetType=org' }
        },
        required: ['action']
      }
    },
    handler: async (input, auth) => {
      const action = input.action as 'list' | 'create' | 'update' | 'apply';
      const normalizeArray = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        return value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      };

      if (action === 'list') {
        const conditions: SQL[] = [];
        const orgCondition = auth.orgCondition(browserPolicies.orgId);
        if (orgCondition) conditions.push(orgCondition);
        if (typeof input.orgId === 'string') {
          if (!auth.canAccessOrg(input.orgId)) {
            return JSON.stringify({ error: 'Access denied to this organization' });
          }
          conditions.push(eq(browserPolicies.orgId, input.orgId));
        }

        const policies = await db
          .select()
          .from(browserPolicies)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(browserPolicies.updatedAt))
          .limit(200);

        // Exact-device axis: drop policies that name a device outside this
        // caller's allowlist (no-op for an unrestricted caller).
        const visible = policies.filter((policy) =>
          policyWithinDeviceReadScope(auth, policy.targetType, policy.targetIds));

        return JSON.stringify({ policies: visible });
      }

      if (action === 'create') {
        const resolved = resolveWritableToolOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
        if (resolved.error || !resolved.orgId) {
          return JSON.stringify({ error: resolved.error ?? 'orgId is required' });
        }
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const targetType = typeof input.targetType === 'string' ? input.targetType : '';
        if (!name) return JSON.stringify({ error: 'name is required for create' });
        if (!['org', 'site', 'group', 'device', 'tag'].includes(targetType)) {
          return JSON.stringify({ error: 'targetType must be one of org|site|group|device|tag' });
        }
        // Site axis: a site-restricted caller may only create policies that
        // target sites entirely within their allowlist (never org/group/device/tag).
        if (!policyWithinSiteWriteScope(auth, targetType, normalizeArray(input.targetIds))) {
          return JSON.stringify({ error: 'Access denied: policy target is outside your site scope' });
        }

        const [policy] = await db
          .insert(browserPolicies)
          .values({
            orgId: resolved.orgId,
            name,
            targetType,
            targetIds: normalizeArray(input.targetIds),
            allowedExtensions: normalizeArray(input.allowedExtensions),
            blockedExtensions: normalizeArray(input.blockedExtensions),
            requiredExtensions: normalizeArray(input.requiredExtensions),
            settings: (typeof input.settings === 'object' && input.settings && !Array.isArray(input.settings))
              ? input.settings as Record<string, unknown>
              : null,
            isActive: typeof input.isActive === 'boolean' ? input.isActive : true,
            createdBy: auth.user.id
          })
          .returning();

        if (!policy) {
          return JSON.stringify({ error: 'Failed to create browser policy' });
        }

        let scheduleWarning: string | undefined;
        try {
        } catch (error) {
          scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule browser policy evaluation';
        }
        return JSON.stringify({
          success: true,
          policy,
          ...(scheduleWarning ? { warning: scheduleWarning } : {}),
        });
      }

      if (action === 'update') {
        const policyId = typeof input.policyId === 'string' ? input.policyId : '';
        if (!policyId) return JSON.stringify({ error: 'policyId is required for update' });

        const updateConditions: SQL[] = [eq(browserPolicies.id, policyId)];
        const updateOrgCondition = auth.orgCondition(browserPolicies.orgId);
        if (updateOrgCondition) updateConditions.push(updateOrgCondition);

        const [existing] = await db
          .select()
          .from(browserPolicies)
          .where(and(...updateConditions))
          .limit(1);
        if (!existing) {
          return JSON.stringify({ error: 'Policy not found or access denied' });
        }
        // Site axis: a site-restricted caller may edit a policy only if it is
        // already within their site scope, and may not retarget it outside.
        if (!policyWithinSiteWriteScope(auth, existing.targetType, existing.targetIds)) {
          return JSON.stringify({ error: 'Access denied: policy is outside your site scope' });
        }
        if (typeof input.targetType === 'string' || Array.isArray(input.targetIds)) {
          const nextTargetType = typeof input.targetType === 'string' ? input.targetType : existing.targetType;
          const nextTargetIds = Array.isArray(input.targetIds) ? normalizeArray(input.targetIds) : existing.targetIds;
          if (!policyWithinSiteWriteScope(auth, nextTargetType, nextTargetIds)) {
            return JSON.stringify({ error: 'Access denied: target is outside your site scope' });
          }
        }

        const [updated] = await db
          .update(browserPolicies)
          .set({
            name: typeof input.name === 'string' ? input.name.trim() || existing.name : existing.name,
            targetType: typeof input.targetType === 'string' ? input.targetType : existing.targetType,
            targetIds: Array.isArray(input.targetIds) ? normalizeArray(input.targetIds) : existing.targetIds,
            allowedExtensions: Array.isArray(input.allowedExtensions) ? normalizeArray(input.allowedExtensions) : existing.allowedExtensions,
            blockedExtensions: Array.isArray(input.blockedExtensions) ? normalizeArray(input.blockedExtensions) : existing.blockedExtensions,
            requiredExtensions: Array.isArray(input.requiredExtensions) ? normalizeArray(input.requiredExtensions) : existing.requiredExtensions,
            settings: (typeof input.settings === 'object' && input.settings && !Array.isArray(input.settings))
              ? input.settings as Record<string, unknown>
              : existing.settings,
            isActive: typeof input.isActive === 'boolean' ? input.isActive : existing.isActive,
            updatedAt: new Date()
          })
          .where(eq(browserPolicies.id, existing.id))
          .returning();

        let scheduleWarning: string | undefined;
        try {
        } catch (error) {
          scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule browser policy evaluation';
        }
        return JSON.stringify({
          success: true,
          policy: updated ?? existing,
          ...(scheduleWarning ? { warning: scheduleWarning } : {}),
        });
      }

      if (action === 'apply') {
        const policyId = typeof input.policyId === 'string' ? input.policyId : '';
        if (!policyId) return JSON.stringify({ error: 'policyId is required for apply' });

        const applyConditions: SQL[] = [eq(browserPolicies.id, policyId)];
        const applyOrgCondition = auth.orgCondition(browserPolicies.orgId);
        if (applyOrgCondition) applyConditions.push(applyOrgCondition);

        const [policy] = await db
          .select()
          .from(browserPolicies)
          .where(and(...applyConditions))
          .limit(1);
        if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });
        if (!policy.isActive) return JSON.stringify({ error: 'Policy is inactive' });
        // Site axis: a site-restricted caller may apply only policies within
        // their site scope (org/group/device/tag-targeted policies are denied).
        if (!policyWithinSiteWriteScope(auth, policy.targetType, policy.targetIds)) {
          return JSON.stringify({ error: 'Access denied: policy is outside your site scope' });
        }

        const requestedDeviceIds = normalizeArray(input.deviceIds);
        let targetDevices: Array<{ id: string; hostname: string }> = [];

        if (requestedDeviceIds.length > 0) {
          targetDevices = await db
            .select({ id: devices.id, hostname: devices.hostname })
            .from(devices)
            .where(and(
              eq(devices.orgId, policy.orgId),
              inArray(devices.id, requestedDeviceIds),
              sql`${devices.status} <> 'decommissioned'`
            ));
        } else if (policy.targetType === 'org') {
          targetDevices = await db
            .select({ id: devices.id, hostname: devices.hostname })
            .from(devices)
            .where(and(eq(devices.orgId, policy.orgId), sql`${devices.status} <> 'decommissioned'`));
        } else {
          return JSON.stringify({ error: 'deviceIds are required for apply when targetType is not org' });
        }

        if (targetDevices.length === 0) {
          return JSON.stringify({ error: 'No target devices found' });
        }

        try {
          for (const device of targetDevices) {
            await assertDeviceExecuteAllowed(device.id, 'apply_browser_policy', auth.user.id);
          }
        } catch (error) {
          if (!(error instanceof TrustDeniedError)) throw error;
          return JSON.stringify({
            error: error.code,
            message: 'Remote control and device changes are not available until this account is verified.',
          });
        }

        // #5022 W01: this was a hand-rolled multi-row insert straight into the
        // device_commands table that bypassed `queueCommand`, `dispatchDeviceCommand` AND
        // `resolveCommandCreatedBy` -- so it could also write a `created_by`
        // that is not a `users` row. Routed through the AI dispatch adapter per
        // device instead, which stamps the AI origin and runs the created_by
        // probe. `aiDispatch.contract.test.ts` now forbids the raw shape.
        //
        // Per-device aggregation and the tool's return shape are preserved
        // exactly: `queued` still holds one entry per SUCCESSFULLY queued
        // command, so `queuedCommands: queued.length` is unchanged for the
        // all-succeed case and now correctly under-counts a partial failure
        // instead of over-counting it.
        const browserPolicyPayload = {
          policyId: policy.id,
          name: policy.name,
          allowedExtensions: policy.allowedExtensions,
          blockedExtensions: policy.blockedExtensions,
          requiredExtensions: policy.requiredExtensions,
          settings: policy.settings
        };
        const queued: Array<{ id: string; deviceId: string }> = [];
        const queueFailures: Array<{ deviceId: string; error: string }> = [];
        for (const device of targetDevices) {
          // Persist browser policies for delivery on the next device check-in.
          const result = await aiDispatchDeviceCommand(auth, 'manage_browser_policy', {
            deviceId: device.id,
            type: 'apply_browser_policy',
            payload: browserPolicyPayload,
            userId: auth.user.id,
            expectedOrgId: policy.orgId,
          });
          if (result.ok) {
            queued.push({ id: result.command.id, deviceId: result.command.deviceId });
          } else {
            queueFailures.push({ deviceId: device.id, error: result.error });
          }
        }

        let scheduleWarning: string | undefined;
        try {
        } catch (error) {
          scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule browser policy evaluation';
        }

        let eventWarning: string | undefined;
        try {
          await publishEvent(
            'compliance.browser_policy_applied',
            policy.orgId,
            {
              policyId: policy.id,
              policyName: policy.name,
              targetDeviceCount: targetDevices.length,
              commandCount: queued.length
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          eventWarning = error instanceof Error ? error.message : 'Failed to publish browser policy applied event';
        }

        return JSON.stringify({
          success: true,
          policyId: policy.id,
          targetDeviceCount: targetDevices.length,
          queuedCommands: queued.length,
          // Surfaced rather than swallowed: before #5022 W01 a multi-row insert
          // either wrote every row or threw, so there was no partial state to
          // report. There is now, and a silent under-count would read as
          // success.
          ...(queueFailures.length > 0 ? { queueFailures } : {}),
          warning: scheduleWarning ?? eventWarning
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  });
}
