import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { TOUCH_CLASSES, riskTierRank, type EffectiveScriptPolicyDto, type ScriptLaneStateDto, type ScriptPolicyDto } from '@breeze/shared';
import { db } from '../../db';
import { aiScriptLaneState, type AiScriptLaneStateRow } from '../../db/schema/aiScriptLaneState';
import { aiScriptPolicies, type AiScriptPolicyRow } from '../../db/schema/aiScriptPolicies';
import { ENABLE_2FA } from '../auth/schemas';
import { zValidator } from '../../lib/validation';
import { authMiddleware, hasSatisfiedMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { getUserEpochs } from '../../services/authEpochs';
import { createAuditLogAsync } from '../../services/auditService';
import { consumeStepUpGrant, scriptLanePolicyResourceDigest, type StepUpGrantBinding } from '../../services/mfaStepUpGrant';
import { PERMISSIONS, userCanDecideApprovals } from '../../services/permissions';
import { resolveEffectiveScriptPolicy, type EffectiveScriptPolicy } from '../../services/scriptProposals/policy';

/**
 * AI script authoring W04 (#5612): the ORG GRANT half of the unattended lane
 * policy (spec §4.1 `ai_script_policies`), and the per-org lane circuit.
 *
 * Reading needs `ai_agents:read` (the same surface as the rest of Settings →
 * AI). Writing anything needs `ai_agents:write`. Flipping `unattended_enabled`
 * TO TRUE additionally needs `approvals:decide`, a satisfied MFA claim, and —
 * when 2FA is enabled — a fresh `ai_script_lane_grant` step-up grant bound to
 * `{ orgId, unattendedEnabled: true }`, mirroring act-mode enablement.
 * Turning it OFF needs no step-up: reducing authority is never gated behind a
 * second factor. Resetting an open lane is the same privileged transition.
 *
 * Every value is tighten-only against the effective partner ceiling; storing
 * a wider value would make the saved row lie about what is in force and
 * would silently take effect if the partner later widened.
 */
const protectedResourcesSchema = z.object({
  services: z.array(z.string().trim().min(1).max(200)).max(200),
  paths: z.array(z.string().trim().min(1).max(500)).max(200),
  registryKeys: z.array(z.string().trim().min(1).max(500)).max(200),
  deviceTags: z.array(z.string().trim().min(1).max(100)).max(200),
});

const orgUpdateSchema = z
  .object({
    proposingEnabled: z.boolean().optional(),
    unattendedEnabled: z.boolean().optional(),
    maxUnattendedRiskTier: z.enum(['low', 'medium']).optional(),
    unattendedAllowedClasses: z.array(z.enum(TOUCH_CLASSES)).max(TOUCH_CLASSES.length).optional(),
    maxUnattendedPerHour: z.number().int().min(0).max(100).optional(),
    protectedResources: protectedResourcesSchema.optional(),
    reviewerModel: z.string().trim().min(1).max(200).nullable().optional(),
    stepUpGrant: z.string().min(1).max(200).optional(),
  })
  .strict();

const orgQuerySchema = z.object({ orgId: z.string().guid().optional() });
const resetBodySchema = z.object({ stepUpGrant: z.string().min(1).max(200).optional() }).strict();

const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

export const aiScriptPolicyRoutes = new Hono();
aiScriptPolicyRoutes.use('*', authMiddleware);

/** Org tokens act on their own org; partner/system tokens name one with `?orgId=`. */
function resolveTargetOrgId(auth: AuthContext, queryOrgId: string | undefined): string | null {
  if (auth.scope === 'organization') return auth.orgId ?? null;
  if (!queryOrgId) return null;
  return auth.canAccessOrg(queryOrgId) ? queryOrgId : null;
}

export function toScriptPolicyDto(row: AiScriptPolicyRow): ScriptPolicyDto {
  return {
    ownerScope: row.orgId ? 'organization' : 'partner',
    proposingEnabled: row.proposingEnabled,
    ...(row.orgId ? { unattendedEnabled: row.unattendedEnabled } : { unattendedAllowed: row.unattendedAllowed }),
    maxUnattendedRiskTier: row.maxUnattendedRiskTier,
    unattendedAllowedClasses: row.unattendedAllowedClasses,
    maxUnattendedPerHour: row.maxUnattendedPerHour,
    protectedResources: {
      services: row.protectedResources?.services ?? [],
      paths: row.protectedResources?.paths ?? [],
      registryKeys: row.protectedResources?.registryKeys ?? [],
      deviceTags: row.protectedResources?.deviceTags ?? [],
    },
    reviewerModel: row.reviewerModel,
    unattendedEnabledAt: row.unattendedEnabledAt?.toISOString() ?? null,
  };
}

function toEffectiveDto(e: EffectiveScriptPolicy): EffectiveScriptPolicyDto {
  return {
    proposingEnabled: e.proposingEnabled,
    unattendedEnabled: e.unattendedEnabled,
    maxUnattendedRiskTier: e.maxUnattendedRiskTier,
    unattendedAllowedClasses: e.unattendedAllowedClasses,
    maxUnattendedPerHour: e.maxUnattendedPerHour,
  };
}

function toLaneStateDto(row: AiScriptLaneStateRow | undefined): ScriptLaneStateDto {
  return {
    state: row?.state ?? 'closed',
    consecutiveFailedVerifications: row?.consecutiveFailedVerifications ?? 0,
    openedAt: row?.openedAt?.toISOString() ?? null,
    openedReason: row?.openedReason ?? null,
    resetAt: row?.resetAt?.toISOString() ?? null,
  };
}

/**
 * The privileged-transition gate shared by "enable" and "reset": approvals:decide
 * on the caller's resolved permissions, a satisfied MFA claim, and (under 2FA)
 * a consumed, resource-bound step-up grant. Returns a response to send, or
 * null when the caller may proceed.
 */
async function requireLaneGrant(
  c: Parameters<Parameters<typeof aiScriptPolicyRoutes.post>[1]>[0],
  auth: AuthContext,
  orgId: string,
  stepUpGrant: string | undefined,
  resource: { unattendedEnabled: boolean; reset?: boolean },
) {
  const perms = c.get('permissions');
  if (!perms || !userCanDecideApprovals(perms)) {
    return c.json({ error: 'approvals:decide is required for this change', code: 'APPROVALS_DECIDE_REQUIRED' }, 403);
  }
  if (!hasSatisfiedMfa(auth)) {
    return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }
  if (!ENABLE_2FA) return null;
  if (!stepUpGrant) return c.json(STEP_UP_REQUIRED_BODY, 403);
  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!epochs || !sid) return c.json({ error: 'Service temporarily unavailable' }, 503);
  const binding: StepUpGrantBinding = {
    userId: auth.user.id,
    operation: 'ai_script_lane_grant',
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest: scriptLanePolicyResourceDigest({ orgId, ...resource }),
  };
  if (!(await consumeStepUpGrant(stepUpGrant, binding))) return c.json(STEP_UP_REQUIRED_BODY, 403);
  return null;
}

aiScriptPolicyRoutes.get(
  '/script-policy',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action),
  zValidator('query', orgQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveTargetOrgId(auth, c.req.valid('query').orgId);
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const [policy] = await db.select().from(aiScriptPolicies).where(eq(aiScriptPolicies.orgId, orgId)).limit(1);
    const [laneState] = await db.select().from(aiScriptLaneState).where(eq(aiScriptLaneState.orgId, orgId)).limit(1);
    const effective = await resolveEffectiveScriptPolicy(orgId);
    return c.json({
      policy: policy ? toScriptPolicyDto(policy) : null,
      // The ceiling is surfaced so the UI can DISABLE what the partner forbids
      // rather than letting a tech save a value the API then 422s. A missing
      // partner row means no ceiling has been granted at all.
      effective: toEffectiveDto(effective),
      partnerCeilingPresent: effective.source.partnerRowId !== null,
      laneState: toLaneStateDto(laneState),
    });
  },
);

aiScriptPolicyRoutes.put(
  '/script-policy',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action),
  zValidator('query', orgQuerySchema),
  zValidator('json', orgUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveTargetOrgId(auth, c.req.valid('query').orgId);
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);
    const body = c.req.valid('json');

    const effective = await resolveEffectiveScriptPolicy(orgId);
    if (body.maxUnattendedRiskTier && riskTierRank(body.maxUnattendedRiskTier) > riskTierRank(effective.maxUnattendedRiskTier)) {
      return c.json({ error: 'above_partner_ceiling', field: 'maxUnattendedRiskTier' }, 422);
    }
    if (body.unattendedAllowedClasses?.some((cl) => !effective.unattendedAllowedClasses.includes(cl))) {
      return c.json({ error: 'above_partner_ceiling', field: 'unattendedAllowedClasses' }, 422);
    }
    if (body.maxUnattendedPerHour !== undefined && body.maxUnattendedPerHour > effective.maxUnattendedPerHour) {
      return c.json({ error: 'above_partner_ceiling', field: 'maxUnattendedPerHour' }, 422);
    }

    // Enabling is the privileged transition. Disabling is not.
    if (body.unattendedEnabled === true) {
      const denied = await requireLaneGrant(c, auth, orgId, body.stepUpGrant, { unattendedEnabled: true });
      if (denied) return denied;
    }

    const { stepUpGrant: _grant, ...columns } = body;
    const now = new Date();
    const enableStamp = body.unattendedEnabled === true
      ? { unattendedEnabledBy: auth.user.id, unattendedEnabledAt: now }
      : {};
    const [row] = await db
      .insert(aiScriptPolicies)
      .values({ orgId, createdBy: auth.user.id, ...columns, ...enableStamp })
      .onConflictDoUpdate({
        target: aiScriptPolicies.orgId,
        set: { ...columns, ...enableStamp, updatedAt: now },
      })
      .returning();
    if (!row) return c.json({ error: 'Failed to save script policy' }, 500);

    await createAuditLogAsync({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: body.unattendedEnabled === true ? 'ai.script_lane.enabled' : 'ai.script_policy.updated',
      resourceType: 'ai_script_policies',
      resourceId: row.id,
      details: { ...columns },
      result: 'success',
      initiatedBy: 'manual',
    });
    return c.json({ policy: toScriptPolicyDto(row) });
  },
);

aiScriptPolicyRoutes.post(
  '/script-lane/reset',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.APPROVALS_DECIDE.resource, PERMISSIONS.APPROVALS_DECIDE.action),
  zValidator('query', orgQuerySchema),
  zValidator('json', resetBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveTargetOrgId(auth, c.req.valid('query').orgId);
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const denied = await requireLaneGrant(c, auth, orgId, c.req.valid('json').stepUpGrant, { unattendedEnabled: true, reset: true });
    if (denied) return denied;

    const now = new Date();
    const [row] = await db
      .insert(aiScriptLaneState)
      .values({ orgId, state: 'closed', consecutiveFailedVerifications: 0, resetByUserId: auth.user.id, resetAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: aiScriptLaneState.orgId,
        set: {
          state: 'closed',
          consecutiveFailedVerifications: 0,
          openedAt: null,
          openedReason: null,
          resetByUserId: auth.user.id,
          resetAt: now,
          updatedAt: now,
        },
      })
      .returning();

    await createAuditLogAsync({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'ai.script_lane.reset',
      resourceType: 'ai_script_lane_state',
      resourceId: orgId,
      details: {},
      result: 'success',
      initiatedBy: 'manual',
    });
    return c.json({ laneState: toLaneStateDto(row) });
  },
);
