/**
 * Full-control W11 (#6781): `manage_security_policies` (the AI twin of
 * GET / POST / PUT /security/policies) and `manage_compliance_policies` (the AI
 * twin of POST /policies/:id/deactivate).
 *
 * Security policies (`security_policies`, org XOR partner-wide) carry AV/EDR
 * settings. Today no endpoint reads them (the security-scan resolver reads the
 * configuration policy's feature-link settings; plan fact 5), and REST has no
 * delete: an org create is supervised, a partner-wide create four-eyes, an
 * update supervised (guardrails, W11-D13). Stricter than REST: a site- or
 * device-restricted caller cannot write one (W11-D6), every write is audited,
 * and the update never copies `name` into the settings JSON.
 *
 * Compliance policies (`automation_policies`): deactivate is irreversible in the
 * product (nothing re-enables one; plan fact 3), so it is supervised for an org
 * row and four-eyes for a partner-wide row. Ownership is DB state, so the model
 * asserts `ownerScope` (that is what the guardrail classifies) and this handler
 * refuses an assertion that does not match the row, re-checking ownership in the
 * UPDATE itself (W11-D4, quorum QW11). MFA, the site ceiling and the partner-wide
 * gate are the route's.
 */
import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { automationPolicies, securityPolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { resolveWritableToolOrgId } from './aiToolWriteOrg';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { invalidateOrgPolicyProbeCache } from './agentOrgSettingsCache';
import { scheduleComplianceAlertReconcile } from './complianceAlertReconcileTrigger';
import { securityPolicyAccessCondition } from '../routes/security/policies';
import { createPolicySchema, updatePolicySchema } from '../routes/security/schemas';
import { getPolicyWithOrgCheck } from '../routes/policyManagement/helpers';
import { parseData } from './aiToolsTicketOpsShared';
import { COMPLIANCE_POLICY_ACTIONS, POLICY_OWNER_SCOPES, SECURITY_POLICY_ACTIONS } from './aiToolSchemasSecurityPolicy';
import {
  auditToolWrite, bounded, defined, json, jsonError, notFound, orgWideWriteDenied, requireFields, str, thrown,
} from './aiToolsSecurityPolicyShared';

type SecurityPolicyAction = (typeof SECURITY_POLICY_ACTIONS)[number];
const SECURITY_TOOL = 'manage_security_policies';
const COMPLIANCE_TOOL = 'manage_compliance_policies';
const LIST_CAP = 200;

const SETTING_KEYS = ['description', 'providerId', 'scanSchedule', 'realTimeProtection', 'autoQuarantine', 'severityThreshold', 'exclusions'] as const;

function projectPolicy(row: typeof securityPolicies.$inferSelect) {
  const s = (row.settings ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    orgId: row.orgId,
    partnerWide: row.orgId === null,
    name: row.name,
    description: typeof s.description === 'string' ? s.description : null,
    providerId: typeof s.providerId === 'string' ? s.providerId : null,
    scanSchedule: typeof s.scanSchedule === 'string' ? s.scanSchedule : 'weekly',
    realTimeProtection: typeof s.realTimeProtection === 'boolean' ? s.realTimeProtection : true,
    autoQuarantine: typeof s.autoQuarantine === 'boolean' ? s.autoQuarantine : true,
    severityThreshold: typeof s.severityThreshold === 'string' ? s.severityThreshold : 'medium',
    exclusions: Array.isArray(s.exclusions) ? s.exclusions.filter((v): v is string => typeof v === 'string') : [],
    createdAt: row.createdAt.toISOString(),
  };
}

function settingsFrom(input: Record<string, unknown>): Record<string, unknown> {
  return defined(Object.fromEntries(SETTING_KEYS.map((key) => [key, input[key]])));
}

export function registerSecurityPolicyTools(aiTools: Map<string, AiTool>): void {
  registerSecurityPolicyTool(aiTools);
  registerCompliancePolicyTool(aiTools);
}

// Each registration precedes its own handler so source scanners (aiTools.userOwnedRelease.contract) attribute
// every write to the right tool.
function registerSecurityPolicyTool(aiTools: Map<string, AiTool>): void {
  aiTools.set(SECURITY_TOOL, {
    tier: 1,
    domain: 'security',
    searchHint: 'security policies: antivirus/EDR scan schedule, real-time protection, auto-quarantine, exclusions',
    deviceArgs: [],
    definition: {
      name: 'manage_security_policies',
      description:
        'Antivirus/EDR security policy templates. Actions: list, create (name; ownerScope partner = every organization), update (policyId). There is no delete. Writes need approval; partner-wide create needs a second approver.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SECURITY_POLICY_ACTIONS], description: 'The action to perform' },
          policyId: { type: 'string', description: 'update: security policy UUID' },
          orgId: { type: 'string', description: 'create: owning organization UUID (org policies)' },
          ownerScope: { type: 'string', enum: [...POLICY_OWNER_SCOPES], description: "create: 'organization' (default) or 'partner' (every organization)" },
          name: { type: 'string', description: 'create / update: policy name (max 255)' },
          description: { type: 'string', description: 'create / update: description (max 2000)' },
          providerId: { type: 'string', description: 'create / update / list filter: AV provider id' },
          scanSchedule: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'manual'], description: 'create / update / list filter: scan schedule' },
          realTimeProtection: { type: 'boolean', description: 'create / update: real-time protection on' },
          autoQuarantine: { type: 'boolean', description: 'create / update: quarantine detections automatically' },
          severityThreshold: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'create / update: minimum severity to act on' },
          exclusions: { type: 'array', items: { type: 'string' }, description: 'create / update: scan exclusions (max 200, replaces the list)' },
          search: { type: 'string', description: 'list: name or description contains' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        return await securityPolicyHandler(input, auth);
      } catch (error) {
        return thrown(SECURITY_TOOL, error);
      }
    },
  });
}

async function securityPolicyHandler(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const action = input.action as SecurityPolicyAction;
  if (!SECURITY_POLICY_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);

  if (action === 'list') {
    const access = securityPolicyAccessCondition(auth);
    const rows = await db.select().from(securityPolicies).where(access).orderBy(securityPolicies.createdAt).limit(LIST_CAP + 1);
    const search = str(input.search)?.toLowerCase();
    const policies = rows.slice(0, LIST_CAP).map(projectPolicy).filter((p) =>
      (!input.providerId || p.providerId === input.providerId)
      && (!input.scanSchedule || p.scanSchedule === input.scanSchedule)
      && (!search || p.name.toLowerCase().includes(search) || (p.description ?? '').toLowerCase().includes(search)));
    return bounded({ policies, showing: policies.length, truncated: rows.length > LIST_CAP });
  }

  const denied = orgWideWriteDenied(auth, 'A security policy');
  if (denied) return denied;

  if (action === 'create') {
    const missing = requireFields(input, ['name'], action);
    if (missing) return missing;
    const parsed = parseData(createPolicySchema, defined({ name: input.name, ownerScope: input.ownerScope, ...settingsFrom(input) }));
    if ('error' in parsed) return parsed.error;
    const body = parsed.value;
    let owner: { orgId: string | null; partnerId: string | null };
    if (body.ownerScope === 'partner') {
      if (!auth.partnerId) return jsonError('Partner-wide security policies require partner scope', 'ACCESS_DENIED');
      if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
      if (str(input.orgId)) return jsonError('orgId does not apply to a partner-wide policy', 'VALIDATION_ERROR');
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const resolved = resolveWritableToolOrgId(auth, str(input.orgId));
      if (!resolved.orgId) return jsonError(resolved.error ?? 'orgId is required', 'VALIDATION_ERROR');
      owner = { orgId: resolved.orgId, partnerId: null };
    }
    const [row] = await db.insert(securityPolicies).values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      name: body.name,
      settings: {
        description: body.description, providerId: body.providerId, scanSchedule: body.scanSchedule,
        realTimeProtection: body.realTimeProtection, autoQuarantine: body.autoQuarantine,
        severityThreshold: body.severityThreshold, exclusions: body.exclusions,
      },
    }).returning();
    if (!row) return jsonError('Failed to create policy');
    auditToolWrite(auth, {
      orgId: row.orgId, partnerId: row.partnerId, action: 'security.policy.create', resourceType: 'security_policy',
      resourceId: row.id, resourceName: row.name, details: { partnerWide: row.orgId === null },
    });
    return json({ created: true, policy: projectPolicy(row) });
  }

  // update
  const missing = requireFields(input, ['policyId'], action);
  if (missing) return missing;
  if (input.ownerScope !== undefined) return jsonError('ownerScope is set at create and cannot change', 'VALIDATION_ERROR');
  const parsed = parseData(updatePolicySchema, defined({ name: input.name, ...settingsFrom(input) }));
  if ('error' in parsed) return parsed.error;
  const { name, ...settingsPatch } = parsed.value;
  if (name === undefined && Object.keys(settingsPatch).length === 0) return jsonError('Nothing to update', 'VALIDATION_ERROR');
  const conditions: SQL[] = [eq(securityPolicies.id, String(input.policyId))];
  const access = securityPolicyAccessCondition(auth);
  if (access) conditions.push(access);
  const [existing] = await db.select().from(securityPolicies).where(and(...conditions)).limit(1);
  if (!existing) return notFound('Security policy');
  if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
  const [row] = await db.update(securityPolicies).set({
    name: name ?? existing.name,
    settings: { ...((existing.settings ?? {}) as Record<string, unknown>), ...settingsPatch },
  }).where(eq(securityPolicies.id, existing.id)).returning();
  if (!row) return notFound('Security policy');
  auditToolWrite(auth, {
    orgId: row.orgId, partnerId: row.partnerId, action: 'security.policy.update', resourceType: 'security_policy',
    resourceId: row.id, resourceName: row.name, details: { changed: [...(name !== undefined ? ['name'] : []), ...Object.keys(settingsPatch)] },
  });
  return json({ updated: true, policy: projectPolicy(row) });
}

function registerCompliancePolicyTool(aiTools: Map<string, AiTool>): void {
  aiTools.set(COMPLIANCE_TOOL, {
    tier: 3,
    domain: 'security',
    searchHint: 'deactivate (turn off) a compliance policy permanently; pairs with query_compliance_policies',
    deviceArgs: [],
    definition: {
      name: 'manage_compliance_policies',
      description:
        "Deactivate a compliance policy (find it with query_compliance_policies). Permanent: nothing re-enables it. Closes its alerts. ownerScope must match the policy: 'organization', or 'partner' for a partner-wide one (needs a second approver).",
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...COMPLIANCE_POLICY_ACTIONS], description: 'The action to perform' },
          policyId: { type: 'string', description: 'Compliance policy UUID' },
          ownerScope: { type: 'string', enum: [...POLICY_OWNER_SCOPES], description: "Who owns the policy: 'organization' or 'partner' (partner-wide)" },
        },
        required: ['action', 'policyId', 'ownerScope'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        return await compliancePolicyHandler(input, auth);
      } catch (error) {
        return thrown(COMPLIANCE_TOOL, error);
      }
    },
  });
}

async function compliancePolicyHandler(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (!(COMPLIANCE_POLICY_ACTIONS as readonly unknown[]).includes(input.action)) return jsonError(`Unknown action: ${String(input.action)}`);
  const mfa = mfaGatedToolError(COMPLIANCE_TOOL, 'deactivate', auth);
  if (mfa) return mfa;
  const denied = orgWideWriteDenied(auth, 'A compliance policy');
  if (denied) return denied;
  const missing = requireFields(input, ['policyId', 'ownerScope'], 'deactivate');
  if (missing) return missing;
  const ownerScope = input.ownerScope;
  if (!(POLICY_OWNER_SCOPES as readonly unknown[]).includes(ownerScope)) return jsonError("ownerScope must be 'organization' or 'partner'", 'VALIDATION_ERROR');

  const policy = await getPolicyWithOrgCheck(String(input.policyId), auth);
  if (!policy) return notFound('Compliance policy');
  const partnerWide = policy.orgId === null;
  // The guardrail classified this call by the asserted owner; a mismatch would let the cheaper scope reach the
  // wider effect (or misdescribe the approval), so it is refused before anything is written.
  if (partnerWide !== (ownerScope === 'partner')) {
    return jsonError(
      `ownerScope does not match this policy: it is ${partnerWide ? 'partner-wide (every organization)' : 'owned by one organization'}; call again with ownerScope '${partnerWide ? 'partner' : 'organization'}'`,
      'OWNER_SCOPE_MISMATCH',
    );
  }
  if (partnerWide && !canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');

  // Ownership re-checked in the write itself (QW11).
  const [updated] = await db.update(automationPolicies)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(automationPolicies.id, policy.id), partnerWide ? isNull(automationPolicies.orgId) : isNotNull(automationPolicies.orgId)))
    .returning({ id: automationPolicies.id, name: automationPolicies.name, orgId: automationPolicies.orgId, partnerId: automationPolicies.partnerId });
  if (!updated) return notFound('Compliance policy');

  const owner = updated.orgId !== null ? { orgId: updated.orgId } : updated.partnerId ? { partnerId: updated.partnerId } : null;
  if (owner) scheduleComplianceAlertReconcile(owner, 'automation-policy-deactivate');
  invalidateOrgPolicyProbeCache(updated.orgId ?? undefined);
  auditToolWrite(auth, {
    orgId: updated.orgId, partnerId: updated.partnerId, action: 'policy.deactivate', resourceType: 'policy',
    resourceId: updated.id, resourceName: updated.name, details: { enabled: { from: policy.enabled, to: false }, partnerWide },
  });
  return json({ deactivated: true, policyId: updated.id, name: updated.name, partnerWide, wasEnabled: policy.enabled, permanent: true });
}
