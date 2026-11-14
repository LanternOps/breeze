import type { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { runOutsideDbContext } from '../db';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  PortalDirectoryIdentityError,
  applyRun,
  dismissHeldRun,
  getPortalDirectoryStatus,
  removeDisabledPortalIdentity,
  restorePortalIdentity,
} from '../services/portalDirectory';
import { resolveAccessibleOrg } from './orgPortalSettings';

/**
 * MSP routes for portal directory deprovisioning (portal registration W8
 * #11385, plan Task 8; D7, D8, D9, OD3): the status and preview of each
 * directory's runs, Apply / Dismiss of a held run, Restore of a disabled
 * sign-in method, and removal of one disabled by the customer's directory.
 *
 * Registered onto orgRoutes so every route inherits its authMiddleware. Gates
 * as the portal-users routes: partner|system scope; ORGS_READ to read;
 * ORGS_WRITE + MFA to change anything.
 *
 * DB contexts. The org is authorized under the request's own context
 * (resolveAccessibleOrg). Every service then runs through runOutsideDbContext:
 * each opens its own system-scope transaction (and refuses a held context),
 * so a `PortalDirectoryIdentityError` caught below was thrown either in JS
 * before any write or from a statement on the service's own connection, whose
 * transaction has already rolled back. Mapping it to a 4xx therefore cannot
 * turn into a 500 at the request's commit (docs/agents/tenancy-rls.md, "A
 * catch around a query needs withDbTransaction"); no withDbTransaction here.
 *
 * Audit. The services write their rows in the decision's own transaction —
 * `organization.portal_directory.run.apply` / `.dismiss` (runDecisions.ts),
 * `organization.portal_user.identity.restore` (+ `organization.portal_user.update`
 * on reactivation) and `organization.portal_user.identity.remove`
 * (identityDisable.ts) — and mark the request audited, so these routes write
 * none of their own.
 */

/** sha256 hex, as `impactDigestOf` builds it (runStore.ts). */
const decisionBodySchema = z.object({
  impactDigest: z.string().regex(/^[0-9a-f]{64}$/, 'impactDigest must be the run\'s 64-character digest'),
}).strict();

const restoreBodySchema = z.object({
  reactivateAccount: z.boolean(),
  confirmMspDisabled: z.boolean().optional(),
}).strict();

/** A typed refusal → `{ error, code }` with its status; anything else is rethrown (a 500). */
async function mapRefusal(c: any, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PortalDirectoryIdentityError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
}

export function registerOrgPortalDirectoryRoutes(orgRoutes: Hono): void {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/portal-directory',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      return c.json({ data: await runOutsideDbContext(() => getPortalDirectoryStatus(org.id)) });
    },
  );

  // D8d: apply a held run. The service checks the run belongs to this org
  // (404), is held, fresh and carries the digest the MSP saw (409), and
  // refuses in report mode (409 PORTAL_DIRECTORY_ENFORCEMENT_OFF).
  orgRoutes.post(
    '/organizations/:id/portal-directory/runs/:runId/apply',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', decisionBodySchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const { impactDigest } = c.req.valid('json');
      const runId = c.req.param('runId');
      return mapRefusal(c, async () => {
        const result = await runOutsideDbContext(() =>
          applyRun({ orgId: org.id, runId, actor: { userId: auth.user.id, impactDigest } }));
        return c.json({ data: result });
      });
    },
  );

  // D8e: dismiss a held run (same refusals as Apply).
  orgRoutes.post(
    '/organizations/:id/portal-directory/runs/:runId/dismiss',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', decisionBodySchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const { impactDigest } = c.req.valid('json');
      const runId = c.req.param('runId');
      return mapRefusal(c, async () => {
        await runOutsideDbContext(() =>
          dismissHeldRun({ orgId: org.id, runId, actorUserId: auth.user.id, impactDigest }));
        return c.body(null, 204);
      });
    },
  );

  // D9: clear every blocker of one identity; reactivating an account the MSP
  // disabled needs `confirmMspDisabled` too (409 PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM).
  orgRoutes.post(
    '/organizations/:id/portal-users/:userId/identities/:identityId/restore',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', restoreBodySchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const body = c.req.valid('json');
      const portalUserId = c.req.param('userId');
      const identityId = c.req.param('identityId');
      return mapRefusal(c, async () => {
        const result = await runOutsideDbContext(() => restorePortalIdentity({
          orgId: org.id,
          portalUserId,
          identityId,
          reactivateAccount: body.reactivateAccount,
          confirmMspDisabled: body.confirmMspDisabled ?? false,
          actorUserId: auth.user.id,
        }));
        return c.json({ data: result });
      });
    },
  );

  // OD3: delete ONE identity disabled by a directory blocker (a person deleted
  // and recreated in the directory has a new subject; the old disabled row
  // would otherwise block linking the new one). 409
  // PORTAL_IDENTITY_NOT_DIRECTORY_DISABLED for anything else.
  //
  // After removal the person relinks through the sign-in link step (an
  // invite-bound or link flow). Known follow-up (W08b / docs): an account
  // whose auth_method is 'entra' is still refused by the invite writers, so
  // the MSP cannot re-invite it from the portal-users list yet.
  orgRoutes.delete(
    '/organizations/:id/portal-users/:userId/identities/:identityId',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const portalUserId = c.req.param('userId')!;
      const identityId = c.req.param('identityId')!;
      return mapRefusal(c, async () => {
        const result = await runOutsideDbContext(() => removeDisabledPortalIdentity({
          orgId: org.id,
          portalUserId,
          identityId,
          actorUserId: auth.user.id,
        }));
        return c.json({ data: result });
      });
    },
  );
}
