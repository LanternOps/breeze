import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { TOUCH_CLASSES } from '@breeze/shared';
import { db } from '../db';
import { aiScriptPolicies } from '../db/schema/aiScriptPolicies';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireScope } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
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
 * truth for partner-wide write authority, #2135 step 2).
 */
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
    reviewerModel: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

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
  });
});

partnerAiScriptPolicyRoutes.put('/', zValidator('json', partnerUpdateSchema), async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
  const body = c.req.valid('json');
  const now = new Date();

  const [row] = await db
    .insert(aiScriptPolicies)
    .values({ partnerId: auth.partnerId, orgId: null, createdBy: auth.user.id, ...body })
    .onConflictDoUpdate({
      target: aiScriptPolicies.partnerId,
      set: { ...body, updatedAt: now },
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
    details: { partnerId: auth.partnerId, ...body },
    result: 'success',
    initiatedBy: 'manual',
  });
  return c.json({ policy: toScriptPolicyDto(row) });
});
