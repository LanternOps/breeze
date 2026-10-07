import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { TOUCH_CLASSES, retiredAiModelField } from '@breeze/shared';
import { db } from '../db';
import { aiScriptPolicies, type AiScriptPolicyRow } from '../db/schema/aiScriptPolicies';
import { zValidator } from '../lib/validation';
import { authMiddleware, hasSatisfiedMfa, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { getUserEpochs } from '../services/authEpochs';
import { createAuditLogAsync } from '../services/auditService';
import { consumeStepUpGrant, partnerScriptCeilingResourceDigest, type ScriptLaneWideningDelta, type StepUpGrantBinding } from '../services/mfaStepUpGrant';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { PERMISSIONS, userCanDecideApprovals } from '../services/permissions';
import { ENABLE_2FA } from './auth/schemas';
import { toScriptPolicyDto } from './ai/scriptPolicy';

/**
 * AI script authoring W04 (#5612): the partner CEILING half of
 * `ai_script_policies` (spec §4.1, D10). `unattended_allowed` lives only
 * here, and `unattended_enabled` deliberately does NOT: a partner enabling
 * the lane for every org under it in one write is precisely the
 * blanket-enablement hazard D10 splits the ceiling from the grant to prevent
 * (the `.strict()` schema is what 422s it).
 *
 * `max_unattended_risk_tier` is capped at `medium` — a high/critical script
 * is never lane-eligible at any level (spec §4.6 invariant 3).
 *
 * Writes are gated on `canManagePartnerWidePolicies` (the single source of
 * truth for partner-wide write authority, #2135 step 2), on
 * `ai_agents:write` (`requirePermission`), and on `requireMfa()` — a
 * read-only or non-MFA partner user must not be able to raise this ceiling.
 * Setting `unattendedAllowed` true, and any WIDENING save while it is
 * already true (tier/classes/rate/emptied protectedResources/proposingEnabled),
 * is the same privileged transition as the org-scope grant
 * (`routes/ai/scriptPolicy.ts`'s `requireLaneGrant`) and needs
 * `approvals:decide` plus a fresh, resource-bound step-up grant.
 */
const RISK_TIER_RANK: Record<'low' | 'medium', number> = { low: 0, medium: 1 };
const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;
const protectedResourcesSchema = z.object({
  services: z.array(z.string().trim().min(1).max(200)).max(200),
  paths: z.array(z.string().trim().min(1).max(500)).max(200),
  registryKeys: z.array(z.string().trim().min(1).max(500)).max(200),
  deviceTags: z.array(z.string().trim().min(1).max(100)).max(200),
});

const partnerUpdateSchema = z
  .object({
    proposingEnabled: z.boolean().optional(),
    unattendedAllowed: z.boolean().optional(),
    maxUnattendedRiskTier: z.enum(['low', 'medium']).optional(),
    unattendedAllowedClasses: z.array(z.enum(TOUCH_CLASSES)).max(TOUCH_CLASSES.length).optional(),
    maxUnattendedPerHour: z.number().int().min(0).max(100).optional(),
    protectedResources: protectedResourcesSchema.optional(),
    /** Retired (W08, #7606): rejected with 400 naming its replacement, the script_reviewer
     * assignment under /ai/models. Declared so the strict schema names the field, not "unrecognized key". */
    reviewerModel: retiredAiModelField('reviewerModel'),
    stepUpGrant: z.string().min(1).max(200).optional(),
  })
  .strict();

function protectedResourcesEmpty(pr: { services: string[]; paths: string[]; registryKeys: string[]; deviceTags: string[] } | null | undefined): boolean {
  if (!pr) return true;
  return pr.services.length === 0 && pr.paths.length === 0 && pr.registryKeys.length === 0 && pr.deviceTags.length === 0;
}

/** The row's actual column defaults (aiScriptPolicies schema) — the implicit
 * baseline for a ceiling that has never been saved before. */
const CEILING_SCHEMA_DEFAULTS = {
  maxUnattendedRiskTier: 'low' as const,
  unattendedAllowedClasses: [] as string[],
  maxUnattendedPerHour: 0,
  protectedResources: { services: [] as string[], paths: [] as string[], registryKeys: [] as string[], deviceTags: [] as string[] },
  proposingEnabled: true,
};

/**
 * The full effective ceiling values this request will persist, regardless
 * of whether they count as a "widening" relative to `existing` — used to
 * bind an ENABLING save's step-up grant to the exact tier/classes/rate/
 * protectedResources/proposingEnabled it is arming, not just the boolean. Falls
 * back to the row's real column defaults when there is no existing row
 * (first-ever save for this partner).
 */
function effectiveCeilingValues(
  existing: AiScriptPolicyRow | undefined,
  body: z.infer<typeof partnerUpdateSchema>,
): ScriptLaneWideningDelta {
  const base = existing ?? CEILING_SCHEMA_DEFAULTS;
  return {
    maxUnattendedRiskTier: body.maxUnattendedRiskTier ?? base.maxUnattendedRiskTier,
    unattendedAllowedClasses: body.unattendedAllowedClasses ?? base.unattendedAllowedClasses,
    maxUnattendedPerHour: body.maxUnattendedPerHour ?? base.maxUnattendedPerHour,
    protectedResourcesEmptied: protectedResourcesEmpty(body.protectedResources ?? base.protectedResources),
    proposingEnabled: body.proposingEnabled ?? base.proposingEnabled,
  };
}

/**
 * True when `body`, applied on top of `existing`, WIDENS the partner ceiling
 * while it is (or remains) allowed: raises the tier/classes/rate above the
 * ceiling's own prior value, empties a previously non-empty
 * protectedResources, or turns proposingEnabled on.
 * Mirrors `routes/ai/scriptPolicy.ts`'s org-scope widening check exactly.
 */
function computeWidening(
  existing: AiScriptPolicyRow,
  body: z.infer<typeof partnerUpdateSchema>,
): ScriptLaneWideningDelta | null {
  const tierWidened = body.maxUnattendedRiskTier !== undefined
    && RISK_TIER_RANK[body.maxUnattendedRiskTier] > RISK_TIER_RANK[existing.maxUnattendedRiskTier as 'low' | 'medium'];
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
    proposingEnabled: body.proposingEnabled ?? existing.proposingEnabled,
  };
}

/**
 * The privileged-transition gate: `approvals:decide` on the caller's
 * resolved permissions, a satisfied MFA claim, and (under 2FA) a consumed,
 * resource-bound step-up grant. Mirrors `routes/ai/scriptPolicy.ts`'s
 * `requireLaneGrant`. Returns a response to send, or null when the caller
 * may proceed.
 */
async function requirePartnerLaneGrant(
  c: Context,
  auth: AuthContext,
  partnerId: string,
  stepUpGrant: string | undefined,
  resource: { unattendedAllowed: boolean; widening?: ScriptLaneWideningDelta },
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
    operation: 'ai_partner_script_ceiling_grant',
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest: partnerScriptCeilingResourceDigest({ partnerId, ...resource }),
  };
  if (!(await consumeStepUpGrant(stepUpGrant, binding))) return c.json(STEP_UP_REQUIRED_BODY, 403);
  return null;
}

export const partnerAiScriptPolicyRoutes = new Hono();
partnerAiScriptPolicyRoutes.use('*', authMiddleware);
partnerAiScriptPolicyRoutes.use('*', requireScope('partner', 'system'));

partnerAiScriptPolicyRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
  const [policy] = await db
    .select()
    .from(aiScriptPolicies)
    .where(and(isNull(aiScriptPolicies.orgId), eq(aiScriptPolicies.partnerId, auth.partnerId)))
    .limit(1);
  return c.json({
    policy: policy ? toScriptPolicyDto(policy) : null,
    canManage: canManagePartnerWidePolicies(auth),
    // The web binds the ceiling's step-up grant to this id (#8112) and has no
    // other source for it on a partner-scope session.
    partnerId: auth.partnerId,
  });
});

partnerAiScriptPolicyRoutes.put(
  '/',
  requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action),
  requireMfa(),
  zValidator('json', partnerUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
    const body = c.req.valid('json');
    const { stepUpGrant, ...columns } = body;

    const [existing] = await db
      .select()
      .from(aiScriptPolicies)
      .where(and(isNull(aiScriptPolicies.orgId), eq(aiScriptPolicies.partnerId, auth.partnerId)))
      .limit(1);

    if (columns.unattendedAllowed === true) {
      // Bind the FULL effective parameter set being saved in this same
      // request — not just the boolean — so "disable then re-enable wider"
      // (or a first enable straight at the widest allowed values) goes through
      // the same value-binding the widen branch below already has.
      const widening = effectiveCeilingValues(existing, body);
      const denied = await requirePartnerLaneGrant(c, auth, auth.partnerId, stepUpGrant, { unattendedAllowed: true, widening });
      if (denied) return denied;
    } else if (existing && (columns.unattendedAllowed ?? existing.unattendedAllowed)) {
      const widening = computeWidening(existing, body);
      if (widening) {
        const denied = await requirePartnerLaneGrant(c, auth, auth.partnerId, stepUpGrant, {
          unattendedAllowed: existing.unattendedAllowed,
          widening,
        });
        if (denied) return denied;
      }
    }

    const now = new Date();
    const [row] = await db
      .insert(aiScriptPolicies)
      .values({ partnerId: auth.partnerId, orgId: null, createdBy: auth.user.id, ...columns })
      .onConflictDoUpdate({
        target: aiScriptPolicies.partnerId,
        set: { ...columns, updatedAt: now },
      })
      .returning();
    if (!row) return c.json({ error: 'Failed to save partner script policy' }, 500);

    await createAuditLogAsync({
      orgId: null,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'ai.script_policy.partner_updated',
      resourceType: 'ai_script_policies',
      resourceId: row.id,
      details: { partnerId: auth.partnerId, ...columns },
      result: 'success',
      initiatedBy: 'manual',
    });
    return c.json({ policy: toScriptPolicyDto(row) });
  },
);
