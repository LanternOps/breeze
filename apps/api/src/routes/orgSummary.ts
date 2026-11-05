/**
 * Organization record page summary (#5075 W01, wave-5076).
 *
 * A single aggregate endpoint backing the org detail page's overview cards.
 * Mounted separately under `/orgs`, mirroring the sibling-router pattern
 * established by orgArchive.ts — it owns the same auth middleware as the
 * main organization router.
 *
 * The aggregate and its per-section permission rules live in
 * services/orgSummary.ts (full-control W18, #6789), shared with the
 * `get_org_summary` AI tool.
 */
import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { resolveOrgSummary } from '../services/orgSummary';

export type { OrgSummary } from '../services/orgSummary';

export const orgSummaryRoutes = new Hono();

orgSummaryRoutes.use('*', authMiddleware);

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

orgSummaryRoutes.get(
  '/organizations/:id/summary',
  requireScope('partner', 'system'),
  requireOrgRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id')!;

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const can = (grant: { resource: string; action: string }) =>
      Boolean(permissions && hasPermission(permissions, grant.resource, grant.action));

    const summary = await resolveOrgSummary(auth, id, can);
    if (!summary) {
      return c.json({ error: 'Organization not found' }, 404);
    }
    return c.json(summary);
  },
);
