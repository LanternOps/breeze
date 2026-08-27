/**
 * Organization archive lifecycle endpoints (org-lifecycle Wave 4, Task 2).
 *
 * This router is mounted separately under `/orgs`, so it owns the same auth
 * middleware and mutation gates as the main organization router.
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  beginOrgArchive,
  OrgArchiveStateError,
  restoreOrgFromArchive,
} from '../services/orgArchive';
import { PERMISSIONS } from '../services/permissions';

export const orgArchiveRoutes = new Hono();

orgArchiveRoutes.use('*', authMiddleware);

const requireOrgWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action,
);

const archiveSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});

interface ArchiveOrgRow {
  id: string;
  partnerId: string;
  name: string;
  status: string;
}

type ArchiveAuthzResult =
  | { ok: true; partnerId: string; organization: ArchiveOrgRow }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Load through system context because suspended/archived/purging orgs are
 * intentionally absent from the request's normal accessible-org set. The
 * loaded row's partner remains the tenant boundary; a cross-partner target is
 * reported exactly like a missing target.
 */
async function loadArchiveOrg(orgId: string): Promise<ArchiveOrgRow | undefined> {
  const [organization] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: organizations.id,
          partnerId: organizations.partnerId,
          name: organizations.name,
          status: organizations.status,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    ),
  );
  return organization;
}

async function authorizeArchiveTarget(
  auth: AuthContext,
  orgId: string,
): Promise<ArchiveAuthzResult> {
  if (auth.scope === 'partner' && !auth.partnerId) {
    return {
      ok: false,
      status: 400,
      error: 'Partner context required to manage organization archives',
    };
  }

  const organization = await loadArchiveOrg(orgId);
  if (!organization) {
    return { ok: false, status: 404, error: 'Organization not found' };
  }

  const partnerId =
    auth.scope === 'partner' ? auth.partnerId! : organization.partnerId;
  if (organization.partnerId !== partnerId) {
    return { ok: false, status: 404, error: 'Organization not found' };
  }

  return { ok: true, partnerId, organization };
}

orgArchiveRoutes.post(
  '/organizations/:id/archive',
  requireScope('partner', 'system'),
  requireOrgWrite,
  requireMfa(),
  zValidator('json', archiveSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const orgId = c.req.param('id')!;
    const { retentionDays } = c.req.valid('json');
    const authz = await authorizeArchiveTarget(auth, orgId);
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    try {
      const result = await beginOrgArchive({
        orgId,
        retentionDays,
        actor: auth.user.id,
      });

      writeRouteAudit(c, {
        orgId,
        action: 'org.archive.requested',
        resourceType: 'organization',
        resourceId: orgId,
        resourceName: authz.organization.name,
        details: {
          retentionDays: retentionDays === undefined ? 'default' : retentionDays,
          purgeAt: result.purgeAt,
          partnerId: authz.partnerId,
        },
      });

      return c.json(result, 202);
    } catch (err) {
      if (err instanceof RangeError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof OrgArchiveStateError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  },
);

orgArchiveRoutes.post(
  '/organizations/:id/restore',
  requireScope('partner', 'system'),
  requireOrgWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const orgId = c.req.param('id')!;
    const authz = await authorizeArchiveTarget(auth, orgId);
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    try {
      const { recreateRequired } = await restoreOrgFromArchive({
        orgId,
        actor: auth.user.id,
      });

      writeRouteAudit(c, {
        orgId,
        action: 'org.archive.restored',
        resourceType: 'organization',
        resourceId: orgId,
        resourceName: authz.organization.name,
        details: { recreateRequired },
      });

      return c.json({ status: 'active' as const, recreateRequired });
    } catch (err) {
      if (err instanceof OrgArchiveStateError) {
        const currentStatus =
          err.currentStatus ?? (await loadArchiveOrg(orgId))?.status ?? null;
        if (currentStatus === 'purging') {
          return c.json(
            {
              error:
                'Organization is already purging and can no longer be restored',
            },
            410,
          );
        }
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  },
);
