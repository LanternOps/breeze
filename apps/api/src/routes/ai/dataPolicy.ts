import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { aiDataPolicies } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { PERMISSIONS } from '../../services/permissions';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import { createAuditLogAsync } from '../../services/auditService';
import { levelRank, resolveAiDataPolicyCeiling, resolveAiDataPolicyWithCeiling } from '../../services/aiDataPolicy';
import { aiDataPolicyBodySchema, toAiDataPolicyDto } from '../partnerAiDataPolicy';

/**
 * AI data policy (#8852 W1): the ORG override half of `ai_data_policies`.
 * Tighten-only against the partner ceiling; a looser value is a 422 so the
 * saved row never lies about what is in force.
 */
const orgQuerySchema = z.object({ orgId: z.string().guid().optional() });

type TargetOrg = { orgId: string } | { error: string; status: 400 | 403 };

/**
 * Org tokens act on their own org; partner/system tokens name one with
 * `?orgId=`. A missing org is a malformed request (400); a named org the
 * caller cannot access is a well-formed request it is not allowed to make
 * (403, the `!canAccessOrg` convention).
 */
function resolveTargetOrg(auth: AuthContext, queryOrgId: string | undefined): TargetOrg {
  if (auth.scope === 'organization') {
    return auth.orgId ? { orgId: auth.orgId } : { error: 'Organization context required', status: 400 };
  }
  if (!queryOrgId) return { error: 'orgId is required', status: 400 };
  if (!auth.canAccessOrg(queryOrgId)) return { error: 'Access to this organization denied.', status: 403 };
  return { orgId: queryOrgId };
}

export const aiDataPolicyRoutes = new Hono();
aiDataPolicyRoutes.use('*', authMiddleware);

aiDataPolicyRoutes.get(
  '/data-policy',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action),
  zValidator('query', orgQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const target = resolveTargetOrg(auth, c.req.valid('query').orgId);
    if ('error' in target) return c.json({ error: target.error }, target.status);
    const { orgId } = target;
    const [row] = await db.select().from(aiDataPolicies).where(eq(aiDataPolicies.orgId, orgId)).limit(1);
    // One partner-row read for both values: for an org session it is a system
    // escape (second pooled connection), so never run two of them concurrently.
    const { effective, ceiling } = await resolveAiDataPolicyWithCeiling(orgId);
    return c.json({ policy: row ? toAiDataPolicyDto(row) : null, effective, ceiling });
  },
);

aiDataPolicyRoutes.put(
  '/data-policy',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action),
  requireMfa(),
  zValidator('query', orgQuerySchema),
  zValidator('json', aiDataPolicyBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const target = resolveTargetOrg(auth, c.req.valid('query').orgId);
    if ('error' in target) return c.json({ error: target.error }, target.status);
    const { orgId } = target;
    if (!canMutateOrgWideGovernance(auth)) return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    const body = c.req.valid('json');
    const ceiling = await resolveAiDataPolicyCeiling(orgId);
    if (body.deviceFileReadLevel && levelRank(body.deviceFileReadLevel) > levelRank(ceiling.deviceFileReadLevel)) {
      return c.json({ error: 'above_partner_ceiling', field: 'deviceFileReadLevel' }, 422);
    }
    if (
      body.toolOutputRetentionDays != null
      && ceiling.toolOutputRetentionDays !== null
      && body.toolOutputRetentionDays > ceiling.toolOutputRetentionDays
    ) {
      return c.json({ error: 'above_partner_ceiling', field: 'toolOutputRetentionDays' }, 422);
    }
    const now = new Date();
    const [row] = await db
      .insert(aiDataPolicies)
      .values({ orgId, partnerId: null, createdBy: auth.user.id, ...body })
      .onConflictDoUpdate({ target: aiDataPolicies.orgId, set: { ...body, updatedAt: now } })
      .returning();
    if (!row) return c.json({ error: 'Failed to save AI data policy' }, 500);
    await createAuditLogAsync({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'ai.data_policy.updated',
      resourceType: 'ai_data_policies',
      resourceId: row.id,
      details: { level: 'org', ...body },
      result: 'success',
      initiatedBy: 'manual',
    });
    return c.json({ policy: toAiDataPolicyDto(row) });
  },
);
