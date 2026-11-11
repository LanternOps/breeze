import type { Hono } from 'hono';
import {
  ERROR_CODES,
  portalAccessPolicyPatchSchema,
  type PortalAccessPolicyField,
  type PortalAccessPolicyRowValues,
} from '@breeze/shared';
import { runAfterDbContextCommit } from '../db';
import { zValidator } from '../lib/validation';
import { requireMfa, requirePartner, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveAuditOrgIdForPartner } from '../services/auditOrgResolver';
import { purgeClientAiSessionsForUsers } from '../services/clientAiSessionStore';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import {
  getOrgPortalAccessPolicyView,
  getPartnerPortalAccessPolicyView,
  PartnerWideWriteDeniedError,
  PortalAccessPolicyConfirmRequiredError,
  PortalAccessPolicyValidationError,
  updateOrgPortalAccessPolicy,
  updatePartnerPortalAccessPolicy,
  type PortalAccessPolicySsoOnlyImpact,
  type PortalAccessPolicyWriteResult,
} from '../services/portalAccessPolicyWrites';
import { computeSsoOnlyFlips, listSsoOnlyStranded, ssoOnlyImpactDigest } from '../services/portalSsoOnly';
import { getRedis } from '../services/redis';
import { resolveAccessibleOrg } from './orgPortalSettings';
import { purgePortalSessionsForUsers } from './portal/helpers';

/**
 * Customer portal sign-in & registration policy (portal registration W3 #11380;
 * spec §4, §5.3): the org override (org settings › Portal › Sign-in &
 * registration) and the partner default (partner settings › Customer portal).
 * The resolver is resolvePortalAccessPolicy (services/portalAccessPolicy.ts).
 *
 * Registered onto orgRoutes so every route inherits its authMiddleware.
 * Validation and the partner-wide write gate live in the service
 * (portalAccessPolicyWrites.ts); this file maps their errors and audits.
 *
 * Each service update runs in its own `withDbTransaction` (W4 #11381 D12: the
 * sso_only impact, the upsert and the hash clearing commit together), and the
 * catch below sits OUTSIDE it: a refusal or a failed statement has already
 * rolled back its savepoint, so the request transaction still commits cleanly
 * (docs/agents/tenancy-rls.md). Anything not mapped is rethrown: a 500.
 *
 * D12 routes: `?acknowledge=<impactDigest>` on both PATCHes; the impact
 * previews (`sso-only-impact`, POST with the PATCH body, read-only); the
 * stranded list.
 */

type PolicyWriteRefusal =
  | { status: 400; body: { error: string; code: string; field: PortalAccessPolicyField } }
  | { status: 403; body: { error: string; code: string } }
  | { status: 409; body: { error: string; code: string; impact: PortalAccessPolicySsoOnlyImpact } };

function policyWriteRefusal(err: unknown): PolicyWriteRefusal {
  if (err instanceof PortalAccessPolicyValidationError) {
    return { status: 400, body: { error: err.message, code: err.code, field: err.field } };
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return { status: 403, body: { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: ERROR_CODES.ACCESS_DENIED } };
  }
  if (err instanceof PortalAccessPolicyConfirmRequiredError) {
    return { status: 409, body: { error: err.message, code: err.code, impact: err.impact } };
  }
  throw err;
}

/**
 * D12: the cleared accounts' epochs were bumped in the save's transaction, which
 * is what refuses their sessions; deleting the cached sessions is cleanup, so it
 * runs only once that transaction has committed.
 */
function purgeClearedSessionsAfterCommit(result: PortalAccessPolicyWriteResult): void {
  const userIds = result.ssoOnly?.clearedUserIds ?? [];
  if (userIds.length === 0) return;
  runAfterDbContextCommit('portalAccessPolicy.ssoOnly.purgeSessions', async () => {
    await purgePortalSessionsForUsers(userIds);
    const redis = getRedis();
    if (redis) await purgeClientAiSessionsForUsers(redis, userIds);
  });
}

/** Audit `details.ssoOnly` (D12): which orgs this save flipped, and how many hashes it cleared. */
function ssoOnlyDetails(result: PortalAccessPolicyWriteResult): { ssoOnly?: { orgIds: string[]; passwordsCleared: number } } {
  if (!result.ssoOnly) return {};
  return { ssoOnly: { orgIds: result.ssoOnly.orgIds, passwordsCleared: result.ssoOnly.passwordsCleared } };
}

/** Audit details carry only the fields that actually changed, before and after. */
function changeDetails(
  changedFields: PortalAccessPolicyField[],
  before: PortalAccessPolicyRowValues,
  after: PortalAccessPolicyRowValues,
): { changedFields: PortalAccessPolicyField[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const only = (row: PortalAccessPolicyRowValues) => Object.fromEntries(changedFields.map((f) => [f, row[f]]));
  return { changedFields, before: only(before), after: only(after) };
}

const NO_UPDATES = { error: 'No updates provided', code: ERROR_CODES.NO_UPDATES_PROVIDED } as const;

export function registerPortalAccessPolicyRoutes(orgRoutes: Hono): void {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/portal-access-policy',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      return c.json({ data: await getOrgPortalAccessPolicyView(org) });
    },
  );

  orgRoutes.patch(
    '/organizations/:id/portal-access-policy',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', portalAccessPolicyPatchSchema),
    async (c) => {
      const patch = c.req.valid('json');
      if (Object.keys(patch).length === 0) return c.json(NO_UPDATES, 400);
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      // The previous values, for the audit's `before` (the service returns only the result).
      const before = await getOrgPortalAccessPolicyView(org);
      let result: PortalAccessPolicyWriteResult;
      try {
        // D12: the digest the caller acknowledged; any value but the current one is stale.
        result = await updateOrgPortalAccessPolicy(org, patch, { acknowledgeSsoOnly: c.req.query('acknowledge') ?? null });
      } catch (err) {
        const refusal = policyWriteRefusal(err);
        return c.json(refusal.body, refusal.status);
      }

      if (result.changedFields.length > 0) {
        writeRouteAudit(c, {
          orgId: org.id,
          action: 'organization.portal_access_policy.update',
          resourceType: 'organization',
          resourceId: org.id,
          details: { ...changeDetails(result.changedFields, before.values, result.view.values), ...ssoOnlyDetails(result) },
        });
      }
      purgeClearedSessionsAfterCommit(result);
      return c.json({ data: result.view });
    },
  );

  // D12 preview: what saving `patch` here would flip, its digest (the PATCH's
  // `?acknowledge=`), and this org's stranded accounts. Reads only.
  orgRoutes.post(
    '/organizations/:id/portal-access-policy/sso-only-impact',
    requireScope('partner', 'system'),
    requireOrgRead,
    zValidator('json', portalAccessPolicyPatchSchema),
    async (c) => {
      const patch = c.req.valid('json');
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const flips = await computeSsoOnlyFlips({ kind: 'org', orgId: org.id, partnerId: org.partnerId }, patch);
      const stranded = await listSsoOnlyStranded(org.id);
      return c.json({ data: { flips, impactDigest: ssoOnlyImpactDigest(flips), stranded } });
    },
  );

  orgRoutes.get(
    '/organizations/:id/portal-access-policy/stranded',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      return c.json({ data: await listSsoOnlyStranded(org.id) });
    },
  );

  orgRoutes.get(
    '/partners/me/portal-access-policy',
    requireScope('partner'),
    requirePartner,
    requireOrgRead,
    async (c) => {
      const auth = c.get('auth') as AuthContext;
      return c.json({ data: await getPartnerPortalAccessPolicyView(auth, auth.partnerId as string) });
    },
  );

  orgRoutes.patch(
    '/partners/me/portal-access-policy',
    requireScope('partner'),
    requirePartner,
    requireOrgWrite,
    requireMfa(),
    zValidator('json', portalAccessPolicyPatchSchema),
    async (c) => {
      const patch = c.req.valid('json');
      if (Object.keys(patch).length === 0) return c.json(NO_UPDATES, 400);
      const auth = c.get('auth') as AuthContext;
      const partnerId = auth.partnerId as string;

      // The previous values, for the audit's `before`. The partner-wide gate is the
      // service's (it throws PartnerWideWriteDeniedError before anything is written).
      const before = await getPartnerPortalAccessPolicyView(auth, partnerId);
      let result: PortalAccessPolicyWriteResult;
      try {
        result = await updatePartnerPortalAccessPolicy(auth, partnerId, patch, { acknowledgeSsoOnly: c.req.query('acknowledge') ?? null });
      } catch (err) {
        const refusal = policyWriteRefusal(err);
        return c.json(refusal.body, refusal.status);
      }

      if (result.changedFields.length > 0) {
        writeRouteAudit(c, {
          orgId: await resolveAuditOrgIdForPartner(partnerId),
          action: 'partner.portal_access_policy.update',
          resourceType: 'partner',
          resourceId: partnerId,
          details: { ...changeDetails(result.changedFields, before.values, result.view.values), ...ssoOnlyDetails(result) },
        });
      }
      purgeClearedSessionsAfterCommit(result);
      return c.json({ data: result.view });
    },
  );

  // D12 preview over every org of the partner this caller's context reaches
  // (the same set a partner save would clear; portalSsoOnly.ts header).
  orgRoutes.post(
    '/partners/me/portal-access-policy/sso-only-impact',
    requireScope('partner'),
    requirePartner,
    requireOrgRead,
    zValidator('json', portalAccessPolicyPatchSchema),
    async (c) => {
      const patch = c.req.valid('json');
      const auth = c.get('auth') as AuthContext;
      const flips = await computeSsoOnlyFlips({ kind: 'partner', partnerId: auth.partnerId as string }, patch);
      return c.json({ data: { flips, impactDigest: ssoOnlyImpactDigest(flips) } });
    },
  );
}
