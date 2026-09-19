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
import { writeAuditEvent, writeRouteAudit } from '../services/auditEvents';
import {
  beginOrgArchive,
  OrgArchiveStateError,
  restoreOrgFromArchive,
} from '../services/orgArchive';
import { partnerMemberMayReachOrg } from '../services/partnerOrgSelection';
import { PERMISSIONS } from '../services/permissions';
import { PG_UUID_REGEX } from '../utils/uuid';

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

/**
 * DURABLE twin of the org-bound route audit.
 *
 * `cascadeDeleteOrg` deletes the target org's own `audit_logs` rows at purge, so
 * an org-tenanted `org.archive.requested` is erased by the very purge it
 * authorized: 90 days later nothing records who archived the customer, what
 * retention they chose, or that a restore ever happened. Every surviving event
 * is `actorType: 'system'`. The merge path already writes `org.merge.*`
 * org-less for exactly this reason, as do this wave's own sweeper audits — the
 * entry/exit events are the ones that most obviously needed it.
 *
 * Written alongside (not instead of) the org-bound row, which is what the
 * customer's own audit view shows while the tenant still exists. `orgId: null`
 * puts it outside the cascade; the org id, name and partner ride in `details`,
 * mirroring `org.merge.*`'s shape.
 */
function writeDurableArchiveAudit(
  c: Parameters<typeof writeAuditEvent>[0] & { get: (k: 'auth') => AuthContext },
  input: {
    action: string;
    organization: ArchiveOrgRow;
    partnerId: string;
    details: Record<string, unknown>;
  },
): void {
  const user = c.get('auth')?.user;
  writeAuditEvent(c, {
    orgId: null,
    action: input.action,
    resourceType: 'organization',
    resourceId: input.organization.id,
    resourceName: input.organization.name,
    actorId: user?.id ?? null,
    actorEmail: user?.email,
    result: 'success',
    details: {
      ...input.details,
      // Repeated in details because the row is deliberately org-less: after the
      // purge these are the only surviving identifiers of the erased tenant.
      orgId: input.organization.id,
      orgName: input.organization.name,
      partnerId: input.partnerId,
      durable: true,
    },
  });
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

  // Partner ownership is NOT the whole boundary. A member with
  // `org_access='selected'` (or `'none'`) shares this partner yet may hold no
  // rights to this org at all — and because archive/restore targets are
  // deliberately outside `accessibleOrgIds`, `auth.canAccessOrg()` cannot say
  // so: it returns false for every member of the partner. So consult the RAW
  // selection, which is the one source that survives archival, exactly as
  // `canApplySuspendedOrgLifecycleTransition` does for the suspended case.
  // Without this, any partner member holding `orgs:write` + MFA could drain,
  // archive and schedule the permanent erasure of a customer they cannot even
  // open — or undo an archive their partner admin deliberately started.
  // Indistinguishable from "not found", so it is never an existence oracle.
  if (auth.scope === 'partner' && !(await partnerMemberMayReachOrg(auth, orgId))) {
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

    // Shape-check BEFORE anything touches the database. `id` is a raw path
    // segment and every lookup below feeds it to a `uuid` column, where a
    // non-UUID raises Postgres 22P02 — an uncaught 500 (and a Sentry event) that
    // any unauthenticated-shaped URL like `/organizations/undefined` can pump.
    // A malformed id cannot name a real org, so it is a 404, same as a valid id
    // for an org that doesn't exist. Mirrors the detail route in routes/orgs.ts.
    if (!PG_UUID_REGEX.test(orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

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

      const archiveDetails = {
        retentionDays: retentionDays === undefined ? 'default' : retentionDays,
        // ISO string, not the raw Date: sanitizeAuditPayload treats a Date as
        // a plain object (Object.entries(date) is empty), so an unconverted
        // Date silently persists as `{}` in the immutable audit record.
        purgeAt: result.purgeAt ? result.purgeAt.toISOString() : null,
        partnerId: authz.partnerId,
      };
      writeRouteAudit(c, {
        orgId,
        action: 'org.archive.requested',
        resourceType: 'organization',
        resourceId: orgId,
        resourceName: authz.organization.name,
        details: archiveDetails,
      });
      writeDurableArchiveAudit(c, {
        action: 'org.archive.requested',
        organization: authz.organization,
        partnerId: authz.partnerId,
        details: { ...archiveDetails, priorStatus: authz.organization.status },
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

    // Same shape-check-before-any-DB-access as the archive route above (and the
    // detail route in routes/orgs.ts): a non-UUID path segment would reach a
    // `uuid` column and raise 22P02 — a pumpable 500 plus a Sentry event.
    if (!PG_UUID_REGEX.test(orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const authz = await authorizeArchiveTarget(auth, orgId);
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    try {
      const { status, recreateRequired, aborted, uninstallsCancelled } =
        await restoreOrgFromArchive({ orgId, actor: auth.user.id });

      // `status` is the PRE-archive status, not always 'active' — a suspended
      // org restores suspended, a trial org restores to trial.
      const restoreDetails = { recreateRequired, restoredStatus: status, aborted, uninstallsCancelled };
      writeRouteAudit(c, {
        orgId,
        action: 'org.archive.restored',
        resourceType: 'organization',
        resourceId: orgId,
        resourceName: authz.organization.name,
        details: restoreDetails,
      });
      writeDurableArchiveAudit(c, {
        action: 'org.archive.restored',
        organization: authz.organization,
        partnerId: authz.partnerId,
        details: restoreDetails,
      });

      return c.json({ status, recreateRequired, aborted, uninstallsCancelled });
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
