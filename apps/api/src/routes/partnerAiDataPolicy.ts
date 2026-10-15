import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { aiDataPolicies, AI_DEVICE_FILE_READ_LEVELS } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { createAuditLogAsync } from '../services/auditService';
import { AI_DATA_POLICY_DEFAULTS } from '../services/aiDataPolicy';

/**
 * AI data policy (#8852 W1): the PARTNER default half of `ai_data_policies`.
 * Writes are gated on `canManagePartnerWidePolicies` (#2135), `ai_agents:write`
 * and a satisfied MFA claim. A NULL column means "no opinion" (device-file level
 * falls to the built-in default; retention NULL on a partner row = keep forever).
 */
export const aiDataPolicyBodySchema = z.object({
  deviceFileReadLevel: z.enum(AI_DEVICE_FILE_READ_LEVELS).nullable().optional(),
  toolOutputRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
}).strict();

export function toAiDataPolicyDto(row: typeof aiDataPolicies.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    partnerId: row.partnerId,
    deviceFileReadLevel: row.deviceFileReadLevel,
    toolOutputRetentionDays: row.toolOutputRetentionDays,
    updatedAt: row.updatedAt,
  };
}

export const partnerAiDataPolicyRoutes = new Hono();
partnerAiDataPolicyRoutes.use('*', authMiddleware);
partnerAiDataPolicyRoutes.use('*', requireScope('partner', 'system'));

partnerAiDataPolicyRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
  const [row] = await db
    .select()
    .from(aiDataPolicies)
    .where(and(isNull(aiDataPolicies.orgId), eq(aiDataPolicies.partnerId, auth.partnerId)))
    .limit(1);
  return c.json({
    policy: row ? toAiDataPolicyDto(row) : null,
    canManage: canManagePartnerWidePolicies(auth),
    defaults: AI_DATA_POLICY_DEFAULTS,
  });
});

partnerAiDataPolicyRoutes.put(
  '/',
  requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action),
  requireMfa(),
  zValidator('json', aiDataPolicyBodySchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
    if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const body = c.req.valid('json');
    const now = new Date();
    const [row] = await db
      .insert(aiDataPolicies)
      .values({ partnerId: auth.partnerId, orgId: null, createdBy: auth.user.id, ...body })
      .onConflictDoUpdate({ target: aiDataPolicies.partnerId, set: { ...body, updatedAt: now } })
      .returning();
    if (!row) return c.json({ error: 'Failed to save AI data policy' }, 500);
    await createAuditLogAsync({
      orgId: null,
      partnerId: auth.partnerId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'ai.data_policy.updated',
      resourceType: 'ai_data_policies',
      resourceId: row.id,
      details: { level: 'partner', ...body },
      result: 'success',
      initiatedBy: 'manual',
    });
    return c.json({ policy: toAiDataPolicyDto(row) });
  },
);
