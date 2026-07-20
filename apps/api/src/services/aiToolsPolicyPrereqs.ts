/**
 * AI Policy Prerequisite Tools
 *
 * MCP tools for managing standalone policy entities that configuration policies
 * link to via featurePolicyId: update rings, software policies, peripheral policies,
 * and backup configs. These must be created before they can be linked to a config policy.
 */

import { db } from '../db';
import { pgErrorCode } from '../utils/pgErrors';
import { patchPolicies } from '../db/schema/patches';
import { softwarePolicies } from '../db/schema/softwarePolicies';
import { peripheralPolicies } from '../db/schema/peripheralControl';
import { backupConfigs, backupProfiles } from '../db/schema/backup';
import { configPolicyBackupSettings } from '../db/schema/configurationPolicies';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { ringAutoApproveSchema, backupProfileSelectionsSchema } from '@breeze/shared/validators';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { sanitizeThrownToolError } from './aiToolErrors';

/**
 * Defense-in-depth (#1317): the manage_update_rings AI tool writes `autoApprove`
 * straight to the rings JSONB. Without this, the AI could persist the fail-open
 * shape (`enabled: true` with an empty/missing severity set) — harmless today
 * because the read path (patchApprovalEvaluator) fail-closes such rows, but we
 * still reject it at the WRITE boundary so the tool can never store a row that's
 * more permissive than one written through the route's `ringAutoApproveSchema`.
 *
 * Returns the validated/normalized autoApprove object, or an error message
 * string mirroring the route schema's refinement when the input is invalid.
 */
function validateRingAutoApprove(
  raw: unknown
): { value: Record<string, unknown> } | { error: string } {
  const parsed = ringAutoApproveSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid autoApprove configuration.';
    return { error: message };
  }
  return { value: parsed.data as Record<string, unknown> };
}

type AiToolTier = 1 | 2 | 3 | 4;

type Handler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

function getPartnerId(auth: AuthContext): string | null {
  return auth.partnerId ?? null;
}

function partnerWhere(auth: AuthContext, partnerIdCol: any): SQL | undefined {
  if (auth.scope === 'system') return undefined; // all partners
  if (auth.partnerId) return eq(partnerIdCol, auth.partnerId);
  // org scope or partnerless: match nothing
  return sql`false`;
}

// Dual-axis access for peripheral_policies (#2131): same shape as
// softwarePolicyWhere — org-owned rows the caller can reach OR partner-wide
// rows (org_id NULL) owned by the caller's own partner.
function peripheralPolicyWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, peripheralPolicies.orgId);
  if (!oc) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${peripheralPolicies.orgId} IS NULL AND ${peripheralPolicies.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

// Dual-axis access for software_policies (#2126): org-owned rows the caller can
// reach OR partner-wide rows (org_id NULL) owned by the caller's own partner.
// Mirrors softwarePolicyAccessCondition in routes/softwarePolicies.ts.
function softwarePolicyWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, softwarePolicies.orgId);
  if (!oc) return undefined; // system scope
  // Partner scope only — RLS's breeze_has_partner_access is false for
  // org-scope tokens even when they carry a partnerId.
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${softwarePolicies.orgId} IS NULL AND ${softwarePolicies.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

// Mirrors profileAccessCondition in routes/backup/profiles.ts.
function backupProfileWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, backupProfiles.orgId);
  if (!oc) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${backupProfiles.orgId} IS NULL AND ${backupProfiles.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

function safeHandler(toolName: string, fn: Handler): Handler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err: unknown) {
      const code = pgErrorCode(err);
      // Log BEFORE the pg-code early returns — those branches return without
      // reaching sanitizeThrownToolError, so without this they log nothing.
      console.error(`[policy-prereq:${toolName}]`, input.action, code ?? '', err);
      if (code === '23503') return JSON.stringify({ error: 'Referenced record not found.' });
      if (code === '23505') return JSON.stringify({ error: 'Duplicate entry — a record with this name already exists.' });
      if (code === '22P02') return JSON.stringify({ error: 'Invalid ID format — expected a valid UUID.' });
      // Fail closed: anything else may embed the query/column list (#2603).
      return JSON.stringify({
        error: sanitizeThrownToolError(`policy-prereq:${toolName}`, err, { action: input.action }),
      });
    }
  };
}

// ============================================
// Register all policy prerequisite tools
// ============================================

export function registerPolicyPrereqTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. manage_update_rings — Update Rings (Patch Policies)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_update_rings',
      description: 'Manage update rings (patch approval policies). Update rings control patch deferral, deadlines, and auto-approval. Create an update ring first, then link it to a configuration policy\'s patch feature via manage_policy_feature_link with featureType "patch" and featurePolicyId. Actions: list, get, create, update.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'update'], description: 'Action to perform. Use list/get to query, create/update to modify.' },
          ringId: { type: 'string', description: 'Update ring UUID (required for get/update)' },
          name: { type: 'string', description: 'Ring name (required for create)' },
          description: { type: 'string', description: 'Ring description' },
          deferralDays: { type: 'number', description: 'Days to defer patches before auto-approval (default: 0)' },
          deadlineDays: { type: 'number', description: 'Days after approval before forced install (optional)' },
          gracePeriodHours: { type: 'number', description: 'Hours after deadline before reboot is forced (default: 4)' },
          categories: { type: 'array', items: { type: 'string' }, description: 'Patch categories to include (e.g. ["critical","important","security"])' },
          excludeCategories: { type: 'array', items: { type: 'string' }, description: 'Patch categories to exclude' },
          sources: { type: 'array', items: { type: 'string' }, description: 'Patch sources: ["os","third_party"]' },
          autoApprove: { type: 'object', description: 'Auto-approval rules (e.g. { enabled: true, severities: ["critical","important"], deferralDays: 0 }). severities must be a subset of ["critical","important","moderate","low"]. If enabled is true you MUST list at least one severity — an enabled rule with an empty severity set is rejected (it would auto-approve nothing).' },
          enabled: { type: 'boolean', description: 'Whether ring is active (for update)' },
          limit: { type: 'number', description: 'Max results for list (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_update_rings', async (input, auth) => {
      const action = input.action as string;

      if (auth.scope === 'organization') {
        return JSON.stringify({ error: 'Update rings are managed at partner scope. Switch to a partner/admin context.' });
      }

      const partnerId = getPartnerId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const pc = partnerWhere(auth, patchPolicies.partnerId);
        if (pc) conditions.push(pc);
        conditions.push(eq(patchPolicies.enabled, true));
        conditions.push(eq(patchPolicies.kind, 'ring'));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: patchPolicies.id,
          name: patchPolicies.name,
          description: patchPolicies.description,
          deferralDays: patchPolicies.deferralDays,
          deadlineDays: patchPolicies.deadlineDays,
          gracePeriodHours: patchPolicies.gracePeriodHours,
          categories: patchPolicies.categories,
          sources: patchPolicies.sources,
          autoApprove: patchPolicies.autoApprove,
          ringOrder: patchPolicies.ringOrder,
          createdAt: patchPolicies.createdAt,
        }).from(patchPolicies)
          .where(and(...conditions))
          .orderBy(patchPolicies.ringOrder)
          .limit(limit);

        return JSON.stringify({
          rings: rows,
          showing: rows.length,
          hint: 'Use a ring id with manage_policy_feature_link featureType "patch" and featurePolicyId to link to a configuration policy.',
        });
      }

      if (action === 'get') {
        if (!input.ringId) return JSON.stringify({ error: 'ringId is required' });
        const conditions: SQL[] = [eq(patchPolicies.id, input.ringId as string), eq(patchPolicies.kind, 'ring')];
        const pc = partnerWhere(auth, patchPolicies.partnerId);
        if (pc) conditions.push(pc);

        const [ring] = await db.select().from(patchPolicies).where(and(...conditions)).limit(1);
        if (!ring) return JSON.stringify({ error: 'Update ring not found or access denied' });
        return JSON.stringify({ ring });
      }

      if (action === 'create') {
        if (!partnerId) return JSON.stringify({ error: 'Partner context required' });
        if (!input.name) return JSON.stringify({ error: 'name is required' });

        // Fail-closed autoApprove (#1317): reject enabled-without-severity at the
        // write boundary, mirroring the route's ringAutoApproveSchema. Omitted →
        // auto-approve nothing ({}).
        let autoApprove: Record<string, unknown> = {};
        if (input.autoApprove != null) {
          const validated = validateRingAutoApprove(input.autoApprove);
          if ('error' in validated) return JSON.stringify({ error: validated.error });
          autoApprove = validated.value;
        }

        const rows = await db.insert(patchPolicies).values({
          partnerId,
          kind: 'ring',
          name: input.name as string,
          description: (input.description as string) ?? null,
          deferralDays: Number(input.deferralDays) || 0,
          deadlineDays: input.deadlineDays != null ? Number(input.deadlineDays) : null,
          gracePeriodHours: Number(input.gracePeriodHours) || 4,
          categories: (input.categories as string[]) ?? [],
          excludeCategories: (input.excludeCategories as string[]) ?? [],
          sources: (input.sources as any[]) ?? undefined,
          autoApprove,
          createdBy: auth.user.id,
        }).returning();
        const ring = rows[0];
        if (!ring) return JSON.stringify({ error: 'Failed to create update ring' });

        return JSON.stringify({
          success: true,
          ringId: ring.id,
          name: ring.name,
          hint: 'Now link this ring to a configuration policy using manage_policy_feature_link with featureType "patch" and featurePolicyId: "' + ring.id + '"',
        });
      }

      if (action === 'update') {
        if (!input.ringId) return JSON.stringify({ error: 'ringId is required' });
        const conditions: SQL[] = [eq(patchPolicies.id, input.ringId as string), eq(patchPolicies.kind, 'ring')];
        const pc = partnerWhere(auth, patchPolicies.partnerId);
        if (pc) conditions.push(pc);

        const [existing] = await db.select().from(patchPolicies).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Update ring not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (input.deferralDays != null) updates.deferralDays = Number(input.deferralDays);
        if (input.deadlineDays != null) updates.deadlineDays = Number(input.deadlineDays);
        if (input.gracePeriodHours != null) updates.gracePeriodHours = Number(input.gracePeriodHours);
        if (input.categories) updates.categories = input.categories;
        if (input.excludeCategories) updates.excludeCategories = input.excludeCategories;
        if (input.sources) updates.sources = input.sources;
        if (input.autoApprove != null) {
          // Fail-closed autoApprove (#1317): reject enabled-without-severity at
          // the write boundary, mirroring the route's ringAutoApproveSchema.
          const validated = validateRingAutoApprove(input.autoApprove);
          if ('error' in validated) return JSON.stringify({ error: validated.error });
          updates.autoApprove = validated.value;
        }
        if (typeof input.enabled === 'boolean') updates.enabled = input.enabled;

        await db
          .update(patchPolicies)
          .set(updates)
          .where(and(eq(patchPolicies.id, existing.id), eq(patchPolicies.kind, 'ring')));
        return JSON.stringify({ success: true, message: `Update ring "${existing.name}" updated` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 2. manage_software_policies — Software Policies
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_software_policies',
      description: 'Manage software policies (allowlist/blocklist/audit). Create a software policy first, then link it to a configuration policy\'s software_policy feature via manage_policy_feature_link with featureType "software_policy" and featurePolicyId. Actions: list, get, create, update.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'update'], description: 'Action to perform' },
          policyId: { type: 'string', description: 'Software policy UUID (required for get/update)' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'Ownership for create: "organization" (default, owned by the current org) or "partner" (partner-wide "all orgs" template usable by every org under the partner; requires full partner org access)' },
          name: { type: 'string', description: 'Policy name (required for create)' },
          description: { type: 'string', description: 'Policy description' },
          mode: { type: 'string', enum: ['allowlist', 'blocklist', 'audit'], description: 'Policy mode (required for create)' },
          rules: { type: 'object', description: 'Rules definition: { software: [{ name, vendor?, minVersion?, maxVersion?, catalogId?, reason? }], allowUnknown?: false }' },
          enforceMode: { type: 'boolean', description: 'Whether to enforce (block/uninstall) or just alert (default: false)' },
          remediationOptions: { type: 'object', description: '{ autoUninstall?: false, notifyUser?: true, gracePeriod?: number, cooldownMinutes?: 30, maintenanceWindowOnly?: false }' },
          isActive: { type: 'boolean', description: 'Active state (for update)' },
          limit: { type: 'number', description: 'Max results for list (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_software_policies', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const access = softwarePolicyWhere(auth);
        if (access) conditions.push(access);
        if (typeof input.mode === 'string') conditions.push(eq(softwarePolicies.mode, input.mode as any));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: softwarePolicies.id,
          name: softwarePolicies.name,
          description: softwarePolicies.description,
          mode: softwarePolicies.mode,
          isActive: softwarePolicies.isActive,
          enforceMode: softwarePolicies.enforceMode,
          createdAt: softwarePolicies.createdAt,
        }).from(softwarePolicies)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(softwarePolicies.updatedAt))
          .limit(limit);

        return JSON.stringify({
          policies: rows,
          showing: rows.length,
          hint: 'Use a policy id with manage_policy_feature_link featureType "software_policy" and featurePolicyId to link to a configuration policy.',
        });
      }

      if (action === 'get') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
        const access = softwarePolicyWhere(auth);
        if (access) conditions.push(access);

        const [policy] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
        if (!policy) return JSON.stringify({ error: 'Software policy not found or access denied' });
        return JSON.stringify({ policy });
      }

      if (action === 'create') {
        // Ownership axis (#2126): partner-wide templates apply to every org
        // under the partner, so creation is gated on the same capability as
        // the HTTP route. The partner is derived from the caller's own token.
        let owner: { orgId: string | null; partnerId: string | null };
        if (input.ownerScope === 'partner') {
          if (!auth.partnerId) return JSON.stringify({ error: 'Partner-wide software policies require partner scope' });
          if (!canManagePartnerWidePolicies(auth)) {
            return JSON.stringify({ error: 'Partner-wide software policies require full partner org access (orgAccess must be "all")' });
          }
          owner = { orgId: null, partnerId: auth.partnerId };
        } else {
          if (!orgId) return JSON.stringify({ error: 'Organization context required' });
          owner = { orgId, partnerId: null };
        }
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.mode) return JSON.stringify({ error: 'mode is required (allowlist, blocklist, or audit)' });

        const rows = await db.insert(softwarePolicies).values({
          orgId: owner.orgId,
          partnerId: owner.partnerId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          mode: input.mode as any,
          rules: (input.rules as any) ?? { software: [], allowUnknown: false },
          enforceMode: input.enforceMode === true,
          remediationOptions: (input.remediationOptions as any) ?? null,
          isActive: input.isActive !== false,
          createdBy: auth.user.id,
        }).returning();
        const policy = rows[0];
        if (!policy) return JSON.stringify({ error: 'Failed to create software policy' });

        return JSON.stringify({
          success: true,
          policyId: policy.id,
          name: policy.name,
          hint: 'Now link this policy to a configuration policy using manage_policy_feature_link with featureType "software_policy" and featurePolicyId: "' + policy.id + '"',
        });
      }

      if (action === 'update') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
        const access = softwarePolicyWhere(auth);
        if (access) conditions.push(access);

        const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Software policy not found or access denied' });

        // Partner-wide templates are readable partner-wide but administrable
        // only with the partner-wide capability (same gate as the HTTP route).
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")' });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (typeof input.mode === 'string') updates.mode = input.mode;
        if (input.rules) updates.rules = input.rules;
        if (typeof input.enforceMode === 'boolean') updates.enforceMode = input.enforceMode;
        if (input.remediationOptions) updates.remediationOptions = input.remediationOptions;
        if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;

        await db.update(softwarePolicies).set(updates).where(eq(softwarePolicies.id, existing.id));
        return JSON.stringify({ success: true, message: `Software policy "${existing.name}" updated` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 3. manage_peripheral_policies — Peripheral Control Policies
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_peripheral_policies',
      description: 'Manage peripheral control policies (USB, Bluetooth, Thunderbolt). Create a peripheral policy first, then link it to a configuration policy\'s peripheral_control feature via manage_policy_feature_link with featureType "peripheral_control" and featurePolicyId. Actions: list, get, create, update.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'update'], description: 'Action to perform' },
          policyId: { type: 'string', description: 'Peripheral policy UUID (required for get/update)' },
          name: { type: 'string', description: 'Policy name (required for create)' },
          deviceClass: { type: 'string', enum: ['storage', 'all_usb', 'bluetooth', 'thunderbolt'], description: 'Device class to control (required for create)' },
          action_type: { type: 'string', enum: ['allow', 'block', 'read_only', 'alert'], description: 'Action to take (required for create). Named action_type to avoid collision with action param.' },
          exceptions: { type: 'array', items: { type: 'object' }, description: 'Exception rules: [{ vendor?, product?, serialNumber?, allow: true, reason?, expiresAt? }]' },
          isActive: { type: 'boolean', description: 'Active state (for update)' },
          limit: { type: 'number', description: 'Max results for list (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_peripheral_policies', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = peripheralPolicyWhere(auth);
        if (oc) conditions.push(oc);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: peripheralPolicies.id,
          name: peripheralPolicies.name,
          deviceClass: peripheralPolicies.deviceClass,
          action: peripheralPolicies.action,
          isActive: peripheralPolicies.isActive,
          exceptions: peripheralPolicies.exceptions,
          createdAt: peripheralPolicies.createdAt,
        }).from(peripheralPolicies)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(peripheralPolicies.updatedAt))
          .limit(limit);

        return JSON.stringify({
          policies: rows,
          showing: rows.length,
          hint: 'Use a policy id with manage_policy_feature_link featureType "peripheral_control" and featurePolicyId to link to a configuration policy.',
        });
      }

      if (action === 'get') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(peripheralPolicies.id, input.policyId as string)];
        const oc = peripheralPolicyWhere(auth);
        if (oc) conditions.push(oc);

        const [policy] = await db.select().from(peripheralPolicies).where(and(...conditions)).limit(1);
        if (!policy) return JSON.stringify({ error: 'Peripheral policy not found or access denied' });
        return JSON.stringify({ policy });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.deviceClass) return JSON.stringify({ error: 'deviceClass is required (storage, all_usb, bluetooth, thunderbolt)' });
        if (!input.action_type) return JSON.stringify({ error: 'action_type is required (allow, block, read_only, alert)' });

        const rows = await db.insert(peripheralPolicies).values({
          orgId,
          name: input.name as string,
          deviceClass: input.deviceClass as any,
          action: input.action_type as any,
          targetType: 'organization' as any,
          targetIds: {} as any,
          exceptions: (input.exceptions as any[]) ?? [],
          isActive: input.isActive !== false,
          createdBy: auth.user.id,
        }).returning();
        const policy = rows[0];
        if (!policy) return JSON.stringify({ error: 'Failed to create peripheral policy' });

        return JSON.stringify({
          success: true,
          policyId: policy.id,
          name: policy.name,
          hint: 'Now link this policy to a configuration policy using manage_policy_feature_link with featureType "peripheral_control" and featurePolicyId: "' + policy.id + '"',
        });
      }

      if (action === 'update') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(peripheralPolicies.id, input.policyId as string)];
        const oc = peripheralPolicyWhere(auth);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(peripheralPolicies).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Peripheral policy not found or access denied' });

        // Partner-wide templates are administrable only with the partner-wide
        // capability (same gate as the HTTP route, #2131).
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide peripheral policy requires full partner org access (orgAccess must be "all")' });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.deviceClass === 'string') updates.deviceClass = input.deviceClass;
        if (typeof input.action_type === 'string') updates.action = input.action_type;
        if (input.exceptions) updates.exceptions = input.exceptions;
        if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;

        await db.update(peripheralPolicies).set(updates).where(eq(peripheralPolicies.id, existing.id));
        return JSON.stringify({ success: true, message: `Peripheral policy "${existing.name}" updated` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 3b. manage_backup_profiles — Backup Selection Profiles (spec 2026-07-13)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_backup_profiles',
      description: 'Manage backup selection profiles — reusable "what to protect" bundles (file paths/excludes, System State, SQL Server, Hyper-V) for a device class, e.g. "Server". Link a profile to a configuration policy via manage_policy_feature_link with featureType "backup" and featurePolicyId = the profile id; the policy carries schedule/retention/destination. Profiles are org-owned or partner-wide ("all orgs"). Actions: list, get, create, update, delete.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: 'Action to perform' },
          profileId: { type: 'string', description: 'Backup profile UUID (required for get/update/delete)' },
          name: { type: 'string', description: 'Profile name (required for create)' },
          description: { type: 'string', description: 'Optional description' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'create only: "organization" (default, current org) or "partner" ("all orgs" — requires full partner access)' },
          selections: { type: 'object', description: 'Data sources: { file?: { enabled, paths[], excludes[] }, system_image?: { enabled, includeSystemState? }, mssql?: { enabled, backupType?: "full"|"differential"|"log", excludeDatabases[] }, hyperv?: { enabled, consistencyType?: "application"|"crash", excludeVms[] } }. At least one source enabled; file requires paths.' },
          isActive: { type: 'boolean', description: 'Active state' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_backup_profiles', async (input, auth) => {
      const action = input.action as string;

      if (action === 'list') {
        const where = backupProfileWhere(auth);
        const rows = await db
          .select({
            id: backupProfiles.id,
            name: backupProfiles.name,
            description: backupProfiles.description,
            orgId: backupProfiles.orgId,
            partnerId: backupProfiles.partnerId,
            selections: backupProfiles.selections,
            isActive: backupProfiles.isActive,
          })
          .from(backupProfiles)
          .where(where)
          .orderBy(desc(backupProfiles.updatedAt))
          .limit(100);
        return JSON.stringify({
          profiles: rows.map((row) => ({
            ...row,
            scope: row.partnerId ? 'partner (all orgs)' : 'organization',
          })),
          hint: 'Link a profile with manage_policy_feature_link featureType "backup", featurePolicyId = profile id.',
        });
      }

      if (action === 'get') {
        if (!input.profileId) return JSON.stringify({ error: 'profileId is required' });
        const conditions: SQL[] = [eq(backupProfiles.id, input.profileId as string)];
        const where = backupProfileWhere(auth);
        if (where) conditions.push(where);
        const [profile] = await db.select().from(backupProfiles).where(and(...conditions)).limit(1);
        if (!profile) return JSON.stringify({ error: 'Backup profile not found or access denied' });
        const [usage] = await db
          .select({ count: sql<number>`count(*)` })
          .from(configPolicyBackupSettings)
          .where(eq(configPolicyBackupSettings.backupProfileId, profile.id));
        return JSON.stringify({ profile, inUseByPolicies: Number(usage?.count ?? 0) });
      }

      if (action === 'create') {
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.selections) return JSON.stringify({ error: 'selections is required' });
        const parsed = backupProfileSelectionsSchema.safeParse(input.selections);
        if (!parsed.success) {
          return JSON.stringify({ error: 'Invalid selections', issues: parsed.error.issues });
        }
        let owner: { orgId: string | null; partnerId: string | null };
        if (input.ownerScope === 'partner') {
          if (!auth.partnerId || !canManagePartnerWidePolicies(auth)) {
            return JSON.stringify({ error: 'Partner-wide backup profiles require full partner org access' });
          }
          owner = { orgId: null, partnerId: auth.partnerId };
        } else {
          const orgId = getOrgId(auth);
          if (!orgId) return JSON.stringify({ error: 'Organization context required' });
          owner = { orgId, partnerId: null };
        }
        const [profile] = await db
          .insert(backupProfiles)
          .values({
            orgId: owner.orgId,
            partnerId: owner.partnerId,
            name: input.name as string,
            description: (input.description as string) ?? null,
            selections: parsed.data,
            isActive: input.isActive !== false,
          })
          .returning();
        if (!profile) return JSON.stringify({ error: 'Failed to create backup profile' });
        return JSON.stringify({
          success: true,
          profileId: profile.id,
          scope: profile.partnerId ? 'partner (all orgs)' : 'organization',
          hint: 'Link it with manage_policy_feature_link featureType "backup", featurePolicyId: "' + profile.id + '"',
        });
      }

      if (action === 'update') {
        if (!input.profileId) return JSON.stringify({ error: 'profileId is required' });
        const conditions: SQL[] = [eq(backupProfiles.id, input.profileId as string)];
        const where = backupProfileWhere(auth);
        if (where) conditions.push(where);
        const [existing] = await db.select().from(backupProfiles).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Backup profile not found or access denied' });
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide backup profile requires full partner org access' });
        }
        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (input.name !== undefined) updateData.name = input.name;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.isActive !== undefined) updateData.isActive = input.isActive;
        if (input.selections !== undefined) {
          const parsed = backupProfileSelectionsSchema.safeParse(input.selections);
          if (!parsed.success) {
            return JSON.stringify({ error: 'Invalid selections', issues: parsed.error.issues });
          }
          updateData.selections = parsed.data;
        }
        const [updated] = await db
          .update(backupProfiles)
          .set(updateData)
          .where(eq(backupProfiles.id, existing.id))
          .returning();
        // Under forced RLS a write that matches nothing is a silent no-op, not
        // a throw — safeHandler would never see it. Never tell the model the
        // update landed when it didn't.
        if (!updated) {
          return JSON.stringify({ error: 'Backup profile not found or access denied' });
        }
        return JSON.stringify({ success: true, profile: updated });
      }

      if (action === 'delete') {
        if (!input.profileId) return JSON.stringify({ error: 'profileId is required' });
        const conditions: SQL[] = [eq(backupProfiles.id, input.profileId as string)];
        const where = backupProfileWhere(auth);
        if (where) conditions.push(where);
        const [existing] = await db.select().from(backupProfiles).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Backup profile not found or access denied' });
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Deleting a partner-wide backup profile requires full partner org access' });
        }
        const [usage] = await db
          .select({ count: sql<number>`count(*)` })
          .from(configPolicyBackupSettings)
          .where(eq(configPolicyBackupSettings.backupProfileId, existing.id));
        const inUse = Number(usage?.count ?? 0);
        if (inUse > 0) {
          return JSON.stringify({ error: `Backup profile is in use by ${inUse} configuration polic${inUse === 1 ? 'y' : 'ies'} — unlink it first` });
        }
        const deleted = await db
          .delete(backupProfiles)
          .where(eq(backupProfiles.id, existing.id))
          .returning({ id: backupProfiles.id });
        if (deleted.length === 0) {
          return JSON.stringify({ error: 'Backup profile not found or access denied' });
        }
        return JSON.stringify({ success: true, deleted: existing.name });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 4. manage_backup_configs — Backup Configurations
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_backup_configs',
      description: 'Manage backup configurations (storage provider settings). Create a backup config first, then link it to a configuration policy\'s backup feature via manage_policy_feature_link with featureType "backup" and featurePolicyId. Use query_backups to list existing jobs and trigger_backup for on-demand backups. Actions: list, get, create, update.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'update'], description: 'Action to perform' },
          configId: { type: 'string', description: 'Backup config UUID (required for get/update)' },
          name: { type: 'string', description: 'Config name (required for create)' },
          type: { type: 'string', enum: ['file', 'system_image', 'database', 'application'], description: 'Backup type (required for create)' },
          provider: { type: 'string', enum: ['s3', 'azure_blob', 'google_cloud', 'backblaze', 'local'], description: 'Storage provider (required for create)' },
          providerConfig: { type: 'object', description: 'Provider settings. S3: { bucket, region, accessKey, secretKey, endpoint? }. Local: { path }' },
          schedule: { type: 'object', description: 'Schedule config: { frequency: "daily"|"weekly"|"monthly", time: "02:00", dayOfWeek?, dayOfMonth? }' },
          retention: { type: 'object', description: 'Retention config: { days: 30, versions: 5 }' },
          compression: { type: 'boolean', description: 'Enable compression (default: true)' },
          encryption: { type: 'boolean', description: 'Enable encryption (default: true)' },
          isActive: { type: 'boolean', description: 'Active state (for update)' },
          limit: { type: 'number', description: 'Max results for list (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_backup_configs', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, backupConfigs.orgId);
        if (oc) conditions.push(oc);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: backupConfigs.id,
          name: backupConfigs.name,
          type: backupConfigs.type,
          provider: backupConfigs.provider,
          isActive: backupConfigs.isActive,
          compression: backupConfigs.compression,
          encryption: backupConfigs.encryption,
          createdAt: backupConfigs.createdAt,
        }).from(backupConfigs)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(backupConfigs.updatedAt))
          .limit(limit);

        return JSON.stringify({
          configs: rows,
          showing: rows.length,
          hint: 'Use a config id with manage_policy_feature_link featureType "backup" and featurePolicyId to link to a configuration policy.',
        });
      }

      if (action === 'get') {
        if (!input.configId) return JSON.stringify({ error: 'configId is required' });
        const conditions: SQL[] = [eq(backupConfigs.id, input.configId as string)];
        const oc = orgWhere(auth, backupConfigs.orgId);
        if (oc) conditions.push(oc);

        const [config] = await db.select().from(backupConfigs).where(and(...conditions)).limit(1);
        if (!config) return JSON.stringify({ error: 'Backup config not found or access denied' });
        // Redact sensitive provider config fields
        const safeConfig = { ...config, providerConfig: config.providerConfig ? { ...config.providerConfig as Record<string, unknown>, secretKey: undefined, accessKey: undefined, encryptionKey: undefined } : null };
        return JSON.stringify({ config: safeConfig });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.type) return JSON.stringify({ error: 'type is required (file, system_image, database, application)' });
        if (!input.provider) return JSON.stringify({ error: 'provider is required (s3, azure_blob, google_cloud, backblaze, local)' });
        if (!input.providerConfig) return JSON.stringify({ error: 'providerConfig is required (provider-specific settings)' });

        const rows = await db.insert(backupConfigs).values({
          orgId,
          name: input.name as string,
          type: input.type as any,
          provider: input.provider as any,
          providerConfig: input.providerConfig as any,
          schedule: (input.schedule as any) ?? null,
          retention: (input.retention as any) ?? null,
          compression: input.compression !== false,
          encryption: input.encryption !== false,
          isActive: input.isActive !== false,
        }).returning();
        const config = rows[0];
        if (!config) return JSON.stringify({ error: 'Failed to create backup config' });

        return JSON.stringify({
          success: true,
          configId: config.id,
          name: config.name,
          hint: 'Now link this config to a configuration policy using manage_policy_feature_link with featureType "backup" and featurePolicyId: "' + config.id + '"',
        });
      }

      if (action === 'update') {
        if (!input.configId) return JSON.stringify({ error: 'configId is required' });
        const conditions: SQL[] = [eq(backupConfigs.id, input.configId as string)];
        const oc = orgWhere(auth, backupConfigs.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(backupConfigs).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Backup config not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.type === 'string') updates.type = input.type;
        if (typeof input.provider === 'string') updates.provider = input.provider;
        if (input.providerConfig) updates.providerConfig = input.providerConfig;
        if (input.schedule) updates.schedule = input.schedule;
        if (input.retention) updates.retention = input.retention;
        if (typeof input.compression === 'boolean') updates.compression = input.compression;
        if (typeof input.encryption === 'boolean') updates.encryption = input.encryption;
        if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;

        await db.update(backupConfigs).set(updates).where(eq(backupConfigs.id, existing.id));
        return JSON.stringify({ success: true, message: `Backup config "${existing.name}" updated` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
