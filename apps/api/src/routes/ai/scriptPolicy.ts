import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { TOUCH_CLASSES, riskTierRank, type EffectiveScriptPolicyDto, type ScriptLaneStateDto, type ScriptPolicyDto } from '@breeze/shared';
import { db } from '../../db';
import { aiScriptLaneState, type AiScriptLaneStateRow } from '../../db/schema/aiScriptLaneState';
import { aiScriptPolicies, type AiScriptPolicyRow } from '../../db/schema/aiScriptPolicies';
import { ENABLE_2FA } from '../auth/schemas';
import { zValidator } from '../../lib/validation';
import { authMiddleware, hasSatisfiedMfa, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { getUserEpochs } from '../../services/authEpochs';
import { createAuditLogAsync } from '../../services/auditService';
import { consumeStepUpGrant, scriptLanePolicyResourceDigest, type ScriptLaneWideningDelta, type StepUpGrantBinding } from '../../services/mfaStepUpGrant';
import { PERMISSIONS, userCanDecideApprovals } from '../../services/permissions';
import { resolveEffectiveScriptPolicy, resolvePartnerCeiling, type EffectiveScriptPolicy } from '../../services/scriptProposals/policy';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';

/**
 * AI script authoring W04 (#5612): the ORG GRANT half of the unattended lane
 * policy (spec §4.1 `ai_script_policies`), and the per-org lane circuit.
 *
 * Reading needs `ai_agents:read` (the same surface as the rest of Settings →
 * AI). Writing anything needs `ai_agents:write` AND a satisfied MFA claim
 * (`requireMfa()` — org-wide AI-execution governance is not a claim-optional
 * surface, even for a save that does not touch the lane). Flipping
 * `unattended_enabled` TO TRUE, and any WIDENING save while it is already
 * true (raising tier/classes/rate, emptying protectedResources, or changing
 * reviewerModel/proposingEnabled), additionally needs `approvals:decide` and
 * — when 2FA is enabled — a fresh `ai_script_lane_grant` step-up grant bound
 * to the exact values being saved, mirroring act-mode enablement. Turning it
 * OFF, or only tightening an already-enabled lane, needs no step-up: reducing
 * authority is never gated behind a second factor. Resetting an open lane is
 * the same privileged transition.
 *
 * A site-restricted (or exact-device-ceiled) caller may never touch this
 * object at all (`canMutateOrgWideGovernance`): the lane and its policy
 * reach every device in the org regardless of site, so there is nothing for
 * a site ceiling to narrow.
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
    /** Legacy, accepted and IGNORED for one wave (stripped before the write): the reviewer's model is now the
     * script_reviewer assignment under /ai/models, gated by approvals:decide. W08 drops the key. */
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

function protectedResourcesEmpty(pr: { services: string[]; paths: string[]; registryKeys: string[]; deviceTags: string[] } | null | undefined): boolean {
  if (!pr) return true;
  return pr.services.length === 0 && pr.paths.length === 0 && pr.registryKeys.length === 0 && pr.deviceTags.length === 0;
}

/** The row's actual column defaults (aiScriptPolicies schema) — the implicit
 * baseline for a grant that has never been saved before. */
const GRANT_SCHEMA_DEFAULTS = {
  maxUnattendedRiskTier: 'low' as const,
  unattendedAllowedClasses: [] as string[],
  maxUnattendedPerHour: 0,
  protectedResources: { services: [] as string[], paths: [] as string[], registryKeys: [] as string[], deviceTags: [] as string[] },
  reviewerModel: null as string | null,
  proposingEnabled: true,
};

/**
 * The full effective grant values this request will persist, regardless of
 * whether they count as a "widening" relative to `existing` — used to bind
 * an ENABLING save's step-up grant to the exact tier/classes/rate/
 * reviewerModel/proposingEnabled it is arming, not just the boolean. Falls
 * back to the row's real column defaults when there is no existing row
 * (first-ever save for this org).
 */
function effectiveGrantValues(
  existing: AiScriptPolicyRow | undefined,
  body: z.infer<typeof orgUpdateSchema>,
): ScriptLaneWideningDelta {
  const base = existing ?? GRANT_SCHEMA_DEFAULTS;
  return {
    maxUnattendedRiskTier: body.maxUnattendedRiskTier ?? base.maxUnattendedRiskTier,
    unattendedAllowedClasses: body.unattendedAllowedClasses ?? base.unattendedAllowedClasses,
    maxUnattendedPerHour: body.maxUnattendedPerHour ?? base.maxUnattendedPerHour,
    protectedResourcesEmptied: protectedResourcesEmpty(body.protectedResources ?? base.protectedResources),
    reviewerModel: null,
    proposingEnabled: body.proposingEnabled ?? base.proposingEnabled,
  };
}

/**
 * True when `body`, applied on top of `existing`, WIDENS the org grant while
 * it is (or remains) enabled: raises the tier/classes/rate above the row's
 * own prior value, empties a previously non-empty protectedResources,
 * or turns proposingEnabled on. `existing` values —
 * never the partner ceiling — are the comparison baseline: the ceiling check
 * above already stops anything above the ceiling; this is about what the
 * operator who last saved THIS row actually saw and approved.
 */
function computeWidening(
  existing: AiScriptPolicyRow,
  body: z.infer<typeof orgUpdateSchema>,
): ScriptLaneWideningDelta | null {
  const tierWidened = body.maxUnattendedRiskTier !== undefined
    && riskTierRank(body.maxUnattendedRiskTier) > riskTierRank(existing.maxUnattendedRiskTier);
  const classesWidened = body.unattendedAllowedClasses !== undefined
    && body.unattendedAllowedClasses.some((cl) => !existing.unattendedAllowedClasses.includes(cl));
  const rateWidened = body.maxUnattendedPerHour !== undefined && body.maxUnattendedPerHour > existing.maxUnattendedPerHour;
  const protectedResourcesEmptied = body.protectedResources !== undefined
    && !protectedResourcesEmpty(existing.protectedResources)
    && protectedResourcesEmpty(body.protectedResources);
  const proposingWidened = body.proposingEnabled === true && existing.proposingEnabled !== true;

  if (!tierWidened && !classesWidened && !rateWidened && !protectedResourcesEmptied && !proposingWidened) {
    return null;
  }
  return {
    maxUnattendedRiskTier: body.maxUnattendedRiskTier ?? existing.maxUnattendedRiskTier,
    unattendedAllowedClasses: body.unattendedAllowedClasses ?? existing.unattendedAllowedClasses,
    maxUnattendedPerHour: body.maxUnattendedPerHour ?? existing.maxUnattendedPerHour,
    protectedResourcesEmptied,
    reviewerModel: null,
    proposingEnabled: body.proposingEnabled ?? existing.proposingEnabled,
  };
}

/**
 * The privileged-transition gate shared by "enable", "widen" and "reset":
 * approvals:decide on the caller's resolved permissions, a satisfied MFA
 * claim, and (under 2FA) a consumed, resource-bound step-up grant. Returns a
 * response to send, or null when the caller may proceed.
 */
async function requireLaneGrant(
  c: Context,
  auth: AuthContext,
  orgId: string,
  stepUpGrant: string | undefined,
  resource: { unattendedEnabled: boolean; reset?: boolean; widening?: ScriptLaneWideningDelta },
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
  requireMfa(),
  zValidator('query', orgQuerySchema),
  zValidator('json', orgUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveTargetOrgId(auth, c.req.valid('query').orgId);
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const body = c.req.valid('json');

    // Checked against the PARTNER CEILING, never the effective merge: the
    // merge already folds this org's own current row in, so a value the org
    // once lowered could never be raised back inside the partner's real
    // ceiling.
    const ceiling = await resolvePartnerCeiling(orgId);
    if (body.maxUnattendedRiskTier && riskTierRank(body.maxUnattendedRiskTier) > riskTierRank(ceiling.maxUnattendedRiskTier)) {
      return c.json({ error: 'above_partner_ceiling', field: 'maxUnattendedRiskTier' }, 422);
    }
    if (body.unattendedAllowedClasses?.some((cl) => !ceiling.unattendedAllowedClasses.includes(cl))) {
      return c.json({ error: 'above_partner_ceiling', field: 'unattendedAllowedClasses' }, 422);
    }
    if (body.maxUnattendedPerHour !== undefined && body.maxUnattendedPerHour > ceiling.maxUnattendedPerHour) {
      return c.json({ error: 'above_partner_ceiling', field: 'maxUnattendedPerHour' }, 422);
    }

    const [existing] = await db.select().from(aiScriptPolicies).where(eq(aiScriptPolicies.orgId, orgId)).limit(1);

    // Enabling is the privileged transition. Disabling is not.
    if (body.unattendedEnabled === true) {
      // Bind the FULL effective parameter set being saved in this same
      // request — not just the boolean — so "disable then re-enable wider"
      // (or a first enable straight at the widest allowed values) goes through
      // the same value-binding the widen branch below already has.
      const widening = effectiveGrantValues(existing, body);
      const denied = await requireLaneGrant(c, auth, orgId, body.stepUpGrant, { unattendedEnabled: true, widening });
      if (denied) return denied;
    } else if (existing && (body.unattendedEnabled ?? existing.unattendedEnabled)) {
      // The lane is already enabled (and stays enabled by this save): any
      // WIDENING of what it may do is the same privileged transition as
      // enabling it in the first place.
      const widening = computeWidening(existing, body);
      if (widening) {
        const denied = await requireLaneGrant(c, auth, orgId, body.stepUpGrant, {
          unattendedEnabled: existing.unattendedEnabled,
          widening,
        });
        if (denied) return denied;
      }
    }

    const { stepUpGrant: _grant, reviewerModel: _ignoredReviewerModel, ...columns } = body;
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
