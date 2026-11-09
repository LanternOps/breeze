import type { Hono } from 'hono';
import {
  ERROR_CODES,
  portalAccessPolicyPatchSchema,
  type PortalAccessPolicyField,
  type PortalAccessPolicyRowValues,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { requireMfa, requirePartner, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveAuditOrgIdForPartner } from '../services/auditOrgResolver';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import {
  getOrgPortalAccessPolicyView,
  getPartnerPortalAccessPolicyView,
  PartnerWideWriteDeniedError,
  PortalAccessPolicyValidationError,
  updateOrgPortalAccessPolicy,
  updatePartnerPortalAccessPolicy,
} from '../services/portalAccessPolicyWrites';
import { resolveAccessibleOrg } from './orgPortalSettings';

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
 * The service's refusals are thrown in JS before the upsert, after reads that
 * succeeded, so no SQL statement has failed when the catch below runs and the
 * request transaction still commits cleanly (no withDbTransaction needed,
 * docs/agents/tenancy-rls.md). A failed upsert is not caught: it stays a 500.
 */

type PolicyWriteRefusal =
  | { status: 400; body: { error: string; code: string; field: PortalAccessPolicyField } }
  | { status: 403; body: { error: string; code: string } };

function policyWriteRefusal(err: unknown): PolicyWriteRefusal {
  if (err instanceof PortalAccessPolicyValidationError) {
    return { status: 400, body: { error: err.message, code: err.code, field: err.field } };
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return { status: 403, body: { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: ERROR_CODES.ACCESS_DENIED } };
  }
  throw err;
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
      let result: Awaited<ReturnType<typeof updateOrgPortalAccessPolicy>>;
      try {
        result = await updateOrgPortalAccessPolicy(org, patch);
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
          details: changeDetails(result.changedFields, before.values, result.view.values),
        });
      }
      return c.json({ data: result.view });
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
      let result: Awaited<ReturnType<typeof updatePartnerPortalAccessPolicy>>;
      try {
        result = await updatePartnerPortalAccessPolicy(auth, partnerId, patch);
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
          details: changeDetails(result.changedFields, before.values, result.view.values),
        });
      }
      return c.json({ data: result.view });
    },
  );
}
