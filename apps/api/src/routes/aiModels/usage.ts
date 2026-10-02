/**
 * /ai/models/usage — AI spend and refusal breakdown from the invocation ledger
 * (W04, #7602). Same gate as /ai/admin/sessions: it exposes per-tech spend.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { aiUsageQuerySchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
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
