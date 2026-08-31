/**
 * Org merge HTTP endpoints (org-lifecycle Wave 2, Task 5).
 *
 * Thin HTTP shell over `services/orgMerge.ts` (the engine, Task 3) and
 * `jobs/orgMerge.ts` (the worker, Task 4):
 *
 *   POST /organizations/:id/merge-preview  — advisory row-count preview
 *   POST /organizations/:id/merge          — validate + enqueue the merge job
 *   GET  /organizations/merge-runs/:jobId  — poll a previously-enqueued job
 *
 * Mounted as a SEPARATE router under the same `/orgs` prefix as
 * `routes/orgs.ts` (see index.ts), so it applies its own `authMiddleware`
 * rather than inheriting the parent's `.use('*', ...)`.
 *
 * Tenancy note (read before touching the access checks below): partner-scope
 * `auth.canAccessOrg` is computed from `accessibleOrgIds`, which
 * `computeAccessibleOrgIds` filters to `status IN ('active','trial')`. A
 * suspended org — a perfectly legal merge LOSER — is therefore never in that
 * list, so `canAccessOrg(loserId)` would 404 every legal suspended-loser
 * merge. `authorizeMergePair` below instead checks the loaded row's own
 * `partner_id` against the caller's resolved partner for the loser, which is
 * the tenancy check that actually matters (and is exactly what RLS itself
 * checks). The survivor — always active/trial by the time it reaches the
 * engine (`validateMergePair`) — IS covered by `accessibleOrgIds`, so it gets
 * both the partner-id check AND `canAccessOrg`: a partner member with
 * `org_access='selected'` can share the caller's partner yet still lack
 * write access to this specific org, and partner-id equality alone can't
 * catch that.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { MergeValidationError, previewOrgMerge } from '../services/orgMerge';
import { enqueueOrgMerge, getOrgMergeQueue, type OrgMergeJobPayload } from '../jobs/orgMerge';

export const orgMergeRoutes = new Hono();

// This is a NEW router mounted separately from orgRoutes (index.ts:
// `api.route('/orgs', orgMergeRoutes)` right after `api.route('/orgs',
// orgRoutes)`), so it does not inherit orgRoutes's `orgRoutes.use('*',
// authMiddleware)` — it must apply its own, same as orgs.ts:288.
orgMergeRoutes.use('*', authMiddleware);

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

const mergePreviewSchema = z.object({
  survivorId: z.string().uuid(),
});

const mergeSchema = z.object({
  survivorId: z.string().uuid(),
  confirmName: z.string().min(1),
});

interface MergeOrgRow {
  id: string;
  partnerId: string;
  name: string;
}

type MergeAuthzResult =
  | { ok: true; partnerId: string; loser: MergeOrgRow; survivor: MergeOrgRow }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Load both orgs (system context — the request's own ambient RLS context may
 * not be able to see a suspended loser or a not-yet-authorized survivor) and
 * resolve + check the tenancy boundary. See the module docstring for why the
 * loser and survivor are checked differently.
 */
async function authorizeMergePair(
  auth: AuthContext,
  loserId: string,
  survivorId: string,
): Promise<MergeAuthzResult> {
  if (auth.scope === 'partner' && !auth.partnerId) {
    return { ok: false, status: 400, error: 'Partner context required to merge organizations' };
  }

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: organizations.id, partnerId: organizations.partnerId, name: organizations.name })
        .from(organizations)
        .where(inArray(organizations.id, [loserId, survivorId])),
    ),
  );
  const loser = rows.find((r) => r.id === loserId);
  const survivor = rows.find((r) => r.id === survivorId);

  if (!loser) {
    return { ok: false, status: 404, error: 'Organization not found' };
  }

  // Partner-scope callers use their OWN token partnerId as the trust anchor
  // (never a row's own partner_id — mirrors services/orgMerge.ts
  // loadAndValidate's comment). System-scope callers have no partner of
  // their own to anchor on, so the loser row IS the anchor; loadAndValidate
  // inside the engine still independently re-derives and re-checks this
  // against BOTH rows before doing anything destructive.
  const partnerId = auth.scope === 'partner' ? auth.partnerId! : loser.partnerId;

  if (loser.partnerId !== partnerId) {
    // Same response as "not found" — never confirm a cross-partner org's
    // existence via a different status code than a nonexistent one.
    return { ok: false, status: 404, error: 'Organization not found' };
  }

  if (!survivor) {
    return { ok: false, status: 404, error: 'Surviving organization not found' };
  }
  if (survivor.partnerId !== partnerId) {
    return { ok: false, status: 403, error: 'Access denied to the surviving organization' };
  }
  // The survivor is always active/trial (enforced by validateMergePair
  // inside the engine), so — unlike the loser — it IS covered by
  // accessibleOrgIds. This catches a 'selected'-access partner member whose
  // selection excludes this org even though it shares their partner.
  if (auth.scope === 'partner' && !auth.canAccessOrg(survivor.id)) {
    return { ok: false, status: 403, error: 'Access denied to the surviving organization' };
  }

  return { ok: true, partnerId, loser, survivor };
}

orgMergeRoutes.post(
  '/organizations/:id/merge-preview',
  requireScope('partner', 'system'),
  requireOrgWrite,
  requireMfa(),
  zValidator('json', mergePreviewSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const loserId = c.req.param('id')!;
    const { survivorId } = c.req.valid('json');

    const authz = await authorizeMergePair(auth, loserId, survivorId);
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    try {
      const preview = await previewOrgMerge(loserId, survivorId, authz.partnerId);
      return c.json(preview);
    } catch (err) {
      if (err instanceof MergeValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  },
);

orgMergeRoutes.post(
  '/organizations/:id/merge',
  requireScope('partner', 'system'),
  requireOrgWrite,
  requireMfa(),
  zValidator('json', mergeSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const loserId = c.req.param('id')!;
    const { survivorId, confirmName } = c.req.valid('json');

    const authz = await authorizeMergePair(auth, loserId, survivorId);
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    // Cheap, already-loaded-row check before the ~260-table preview scan
    // below. Exact (case-sensitive) match — this is a destructive
    // confirmation step, not a search box.
    if (confirmName !== authz.loser.name) {
      return c.json({ error: 'confirmName does not match the organization being merged away' }, 400);
    }

    let preview: Awaited<ReturnType<typeof previewOrgMerge>>;
    try {
      preview = await previewOrgMerge(loserId, survivorId, authz.partnerId);
    } catch (err) {
      if (err instanceof MergeValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    if (preview.verdict === 'blocked') {
      return c.json(
        {
          error: preview.blockers[0] ?? 'merge blocked by durable evidence',
          code: 'ORG_MERGE_BLOCKED',
          blockers: preview.blockers,
        },
        422,
      );
    }

    if (preview.verdict === 'too-large') {
      return c.json(
        {
          // Name the knob. The limit is a deployment-tunable guard
          // (`getMaxMovableRows` in services/orgMerge.ts), not a hard engine
          // ceiling, and a self-hosted operator hitting it has no support desk
          // to contact — telling them only to "contact support" turns a config
          // change into a dead end.
          error: 'This merge would move more rows than the org-merge engine runs inline. Self-hosted deployments can raise the ORG_MERGE_MAX_ROWS limit (default 500000) and retry; on hosted Breeze, contact support to schedule a manual/batched merge.',
          totalMovableRows: preview.totalMovableRows,
        },
        422,
      );
    }

    const { id: jobId } = await enqueueOrgMerge({
      loserOrgId: loserId,
      survivorOrgId: survivorId,
      partnerId: authz.partnerId,
      performedBy: auth.user.id,
      performedByEmail: auth.user.email,
    });

    writeRouteAudit(c, {
      orgId: survivorId,
      action: 'org.merge.requested',
      resourceType: 'organization',
      resourceId: loserId,
      resourceName: authz.loser.name,
      details: {
        survivorId,
        survivorName: authz.survivor.name,
        partnerId: authz.partnerId,
        jobId,
      },
    });

    return c.json({ jobId }, 202);
  },
);

orgMergeRoutes.get(
  '/organizations/merge-runs/:jobId',
  requireScope('partner', 'system'),
  requireOrgRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    if (auth.scope === 'partner' && !auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 400);
    }

    const jobId = c.req.param('jobId')!;
    const job = await getOrgMergeQueue().getJob(jobId);
    if (!job) {
      return c.json({ error: 'Merge run not found' }, 404);
    }

    // `jobId` is `org-merge-<loserOrgId>` — a guessable UUID, not a secret —
    // so a partner-scope caller must be denied a job belonging to another
    // partner even though BullMQ enforces nothing here on its own. System
    // scope is exempt: it already spans every partner. Reported the same as
    // "not found" so a cross-partner probe learns nothing.
    const payload = job.data as OrgMergeJobPayload | undefined;
    if (auth.scope === 'partner' && payload?.partnerId !== auth.partnerId) {
      return c.json({ error: 'Merge run not found' }, 404);
    }

    const state = await job.getState();
    return c.json({
      state,
      result: job.returnvalue,
      failedReason: job.failedReason,
    });
  },
);
