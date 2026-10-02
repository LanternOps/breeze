/**
 * /ai/models/usage — AI spend and refusal breakdown (W04, #7602) and the model
 * quality view (W11, #7609), both from the invocation ledger. Same gate as
 * /ai/admin/sessions: they expose per-tech spend and per-session outcomes.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { aiQualityQuerySchema, aiUsageQuerySchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { QualityQueryTimeoutError, queryAiQualityBreakdown } from '../../services/aiModels/qualityQueries';
import { defaultUsageRange, queryAiUsageBreakdown } from '../../services/aiModels/usageQueries';

export const aiModelUsageRoutes = new Hono();

aiModelUsageRoutes.get('/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.AI_SESSIONS_READ_ALL.resource, PERMISSIONS.AI_SESSIONS_READ_ALL.action),
  zValidator('query', aiUsageQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    const auth = c.get('auth');
    if (q.orgId && !auth.canAccessOrg(q.orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
    const range = defaultUsageRange();
    return c.json(await queryAiUsageBreakdown({
      groupBy: q.groupBy,
      from: q.from ?? range.from,
      to: q.to ?? range.to,
      orgId: q.orgId ?? null,
      accessibleOrgIds: auth.accessibleOrgIds,
    }));
  });

aiModelUsageRoutes.get('/quality',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.AI_SESSIONS_READ_ALL.resource, PERMISSIONS.AI_SESSIONS_READ_ALL.action),
  zValidator('query', aiQualityQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    const auth = c.get('auth');
    if (q.orgId && !auth.canAccessOrg(q.orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
    const range = defaultUsageRange();
    try {
      return c.json(await queryAiQualityBreakdown({
        groupBy: q.groupBy,
        from: q.from ?? range.from,
        to: q.to ?? range.to,
        orgId: q.orgId ?? null,
        accessibleOrgIds: auth.accessibleOrgIds,
      }));
    } catch (error) {
      if (error instanceof QualityQueryTimeoutError) {
        return c.json({ error: 'This range is too large to summarize quickly. Choose a shorter range.', code: 'quality_timeout' }, 503);
      }
      throw error;
    }
  });
