import { z } from 'zod';
import { monitorKindSchema } from '@breeze/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { escalationPolicies, notificationRoutingRules, organizations, sites } from '../../db/schema';
import { siteAccessCheck, type AuthContext } from '../../middleware/auth';
import { canReadPartnerWideRows } from '../partnerWideAccess';
import { escalationStepsSchema, type EscalationStep } from './escalationSteps';
import { validateEscalationUsers } from './escalationExecution';
import type { RoutingOwner } from './routingRuleWrites';

// Evaluated keys only (spec §Data model "Routing"): `conditionTypes` and
// `deviceTags` were accepted for two years and never read by the dispatcher;
// `.strict()` turns a write of either into a 400 instead of a silent no-op.
const routingConditionsSchema = z.object({
  severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
  monitorKinds: z.array(monitorKindSchema).optional(),
  siteIds: z.array(z.string().guid()).optional(),
}).strict();

export const createRoutingRuleSchema = z.object({
  // 'partner' creates a partner-wide ("all orgs") routing rule: orgId NULL,
  // partnerId = caller's partner (#2130). Create-only.
  ownerScope: z.enum(['organization', 'partner']).optional(),
  name: z.string().min(1).max(255),
  priority: z.number().int().min(0),
  conditions: routingConditionsSchema,
  channelIds: z.array(z.string().guid()).min(1),
  escalationPolicyId: z.string().guid().nullable().optional(),
  enabled: z.boolean().optional().default(true),
});

export const updateRoutingRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  priority: z.number().int().min(0).optional(),
  conditions: routingConditionsSchema.optional(),
  // No .min(1): the Everything else row may be emptied (inbox only). Non-default
  // rows are re-checked in the handler.
  channelIds: z.array(z.string().guid()).optional(),
  escalationPolicyId: z.string().guid().nullable().optional(),
  enabled: z.boolean().optional(),
});

export const upsertDefaultRowSchema = z.object({
  ownerScope: z.enum(['organization', 'partner']).optional(),
  channelIds: z.array(z.string().guid()),
  escalationPolicyId: z.string().guid().nullable().optional(),
});

export const createPolicySchema = z.object({
  orgId: z.string().guid().optional(),
  // 'partner' creates a partner-wide ("all orgs") escalation policy (#2130).
  ownerScope: z.enum(['organization', 'partner']).optional(),
  name: z.string().min(1).max(255),
  steps: escalationStepsSchema
});

export const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  steps: escalationStepsSchema.optional()
});

export function ensureOrgAccess(orgId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  return auth.canAccessOrg(orgId);
}

/**
 * Resolve the org a mutating alerts request should write to, honouring an
 * explicit (query-param) orgId for partner/system callers.
 *
 * Org-scoped callers are pinned to their own org (an explicit orgId that
 * disagrees is rejected). Partner/system callers select via the request orgId,
 * which is access-checked; with no orgId, a partner with exactly one accessible
 * org is disambiguated to it, otherwise the request is genuinely ambiguous (400)
 * — and an org-scoped caller with no org context is 403. Tenant isolation is
 * unchanged: the resolved orgId is always canAccessOrg-checked and RLS still
 * backstops.
 */
export function resolveWriteOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    accessibleOrgIds: string[] | null;
    canAccessOrg: (orgId: string) => boolean;
  },
  requestedOrgId?: string
): { orgId?: string; error?: string; status?: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!ensureOrgAccess(requestedOrgId, auth)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required when the caller can access multiple organizations', status: 400 };
}

export async function getEscalationPolicyWithOrgCheck(
  policyId: string,
  auth: { canAccessOrg: (orgId: string) => boolean; scope?: string; partnerId?: string | null }
) {
  const [policy] = await db
    .select()
    .from(escalationPolicies)
    .where(eq(escalationPolicies.id, policyId))
    .limit(1);

  if (!policy) {
    return null;
  }

  // Dual-axis access (#2130) — see getNotificationChannelWithOrgCheck.
  const hasAccess = policy.orgId !== null
    ? ensureOrgAccess(policy.orgId, auth)
    : canReadPartnerWideRows({ scope: auth.scope ?? '', partnerId: auth.partnerId ?? null }, policy.partnerId);
  if (!hasAccess) {
    return null;
  }

  return policy;
}

type RoutingSiteAuth = { allowedSiteIds?: string[] };
type RoutingRuleOwner = { orgId: string | null; partnerId: string | null };

export function routingSiteIds(conditions: unknown): string[] {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return [];
  const value = (conditions as Record<string, unknown>).siteIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

export async function canAccessRoutingSites(
  auth: RoutingSiteAuth,
  owner: RoutingRuleOwner,
  siteIds: string[],
  validateOwnership: boolean
): Promise<boolean> {
  const uniqueSiteIds = [...new Set(siteIds)];
  if (uniqueSiteIds.length === 0) return auth.allowedSiteIds === undefined;
  if (!validateOwnership && auth.allowedSiteIds === undefined) return true;

  const ownershipCondition = owner.orgId !== null
    ? eq(sites.orgId, owner.orgId)
    : owner.partnerId
      ? sql`${sites.orgId} IN (SELECT ${organizations.id} FROM ${organizations} WHERE ${organizations.partnerId} = ${owner.partnerId})`
      : undefined;
  if (!ownershipCondition) return false;

  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(inArray(sites.id, uniqueSiteIds), ownershipCondition));
  if (rows.length !== uniqueSiteIds.length) return false;

  const canAccessSite = siteAccessCheck(auth.allowedSiteIds);
  return rows.every((row) => canAccessSite(row.id));
}

// Dual-axis by-id lookup (#2130): org-owned rules via org access; partner-wide
// rules (orgId NULL) via the caller's own partner (or system scope). Writes are
// additionally gated on canManagePartnerWidePolicies at the routes.
export async function getRoutingRuleWithAccess(
  ruleId: string,
  auth: { scope?: string; partnerId?: string | null; canAccessOrg: (orgId: string) => boolean }
) {
  const [rule] = await db
    .select()
    .from(notificationRoutingRules)
    .where(eq(notificationRoutingRules.id, ruleId))
    .limit(1);

  if (!rule) {
    return null;
  }

  // Dual-axis access (#2130): partner-wide rules (orgId NULL) via
  // canReadPartnerWideRows (system scope, or the owning partner's own
  // PARTNER-scoped token). Org tokens carry a partnerId too, so matching on
  // partnerId alone (sweep 2026-09-08 G6-4) handed every partner-wide rule's
  // existence to every org user under that partner.
  const hasAccess = rule.orgId !== null
    ? ensureOrgAccess(rule.orgId, auth)
    : canReadPartnerWideRows({ scope: auth.scope ?? '', partnerId: auth.partnerId ?? null }, rule.partnerId);
  return hasAccess ? rule : null;
}


/** Share caller-aware target validation between HTTP and AI policy writes. */
export async function validatePolicyUsers(
  steps: EscalationStep[],
  owner: RoutingOwner,
  auth: AuthContext,
  storedSteps?: unknown
): Promise<void> {
  // Org callers may retain targets configured by an MSP technician, but
  // may only add users from their own org. Validate against stored IDs.
  const storedUserIds = new Set<string>(Array.isArray(storedSteps)
    ? storedSteps.flatMap(step => Array.isArray(step?.userIds)
      ? step.userIds.filter((id: unknown): id is string => typeof id === 'string') : [])
    : []);
  const stepsToValidate = auth.scope === 'organization'
    ? steps.map(step => ({ ...step, userIds: step.userIds.filter(id => !storedUserIds.has(id)) }))
    : steps;
  await validateEscalationUsers(stepsToValidate, owner, db, { includePartnerUsers: auth.scope !== 'organization' });
}
