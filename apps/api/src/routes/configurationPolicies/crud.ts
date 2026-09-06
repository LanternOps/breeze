import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { organizations } from '../../db/schema';
import {
  createConfigPolicy,
  getConfigPolicy,
  listConfigPolicies,
  updateConfigPolicy,
  deleteConfigPolicy,
  listEligibleParentPolicies,
  getParentLinkFeatureTypes,
  canManagePartnerWidePolicies,
  PartnerWideWriteDeniedError,
  InvalidParentPolicyError,
  PolicyHasChildrenError,
} from '../../services/configurationPolicy';
import { invalidateRemoteAccessCache } from '../../services/remoteAccessPolicy';
import { MFA_GATED_FEATURE_TYPES } from './featureLinks';
import {
  createConfigPolicySchema,
  updateConfigPolicySchema,
  listConfigPoliciesSchema,
  idParamSchema,
  eligibleParentsQuerySchema,
} from './schemas';

export const crudRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireConfigPolicyWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

// GET / — list configuration policies
crudRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('query', listConfigPoliciesSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(Math.max(1, Number(query.limit) || 25), 100);

    const result = await listConfigPolicies(auth, {
      status: query.status,
      search: query.search,
      orgId: query.orgId,
    }, { page, limit });

    return c.json(result);
  }
);

// POST / — create configuration policy
crudRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('json', createConfigPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const data = c.req.valid('json');

    // MFA follows EFFECTIVENESS, not the verb (#5080). Creating a child of a
    // parent that carries a patch or maintenance link makes that link effective
    // on the new policy immediately — the same capability the direct
    // POST /:id/features gate protects, reached through a second door.
    // Session-claim strength (hasSatisfiedMfa), matching the adjacent gates.
    if (data.parentPolicyId) {
      const parentTypes = await getParentLinkFeatureTypes(data.parentPolicyId);
      if (parentTypes.some((t) => MFA_GATED_FEATURE_TYPES.has(t)) && !hasSatisfiedMfa(auth)) {
        return c.json({ error: 'MFA required' }, 403);
      }
    }

    // Partner-wide / all-orgs policy (#1724). The partner is ALWAYS derived from
    // the caller's own token — never from a client-supplied value — so a caller
    // cannot create a policy owned by another partner. Org-scope callers have no
    // partner of their own and cannot own partner-wide policies.
    if (data.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide policies require partner scope' }, 403);
      }
      // Guard: partner-wide policies affect devices in ALL orgs under the partner.
      // A user with orgAccess='selected' or 'none' only has visibility into a
      // subset of orgs — granting them partner-wide policy create would silently
      // push config (remote_access, PAM, monitoring, patch) to orgs they cannot
      // access. Only orgAccess='all' partner users (and system scope) may create
      // partner-wide policies. The same gate protects update/delete (enforced in
      // the service) and feature-link/assignment writes (route gates).
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: 'Partner-wide policies require full partner org access (orgAccess must be "all")' }, 403);
      }
      let policy;
      try {
        policy = await createConfigPolicy({ partnerId: auth.partnerId }, data, auth.user.id);
      } catch (err) {
        if (err instanceof InvalidParentPolicyError) {
          return c.json({ error: err.code, message: err.message }, 400);
        }
        throw err;
      }
      writeRouteAudit(c, {
        orgId: null,
        action: 'config_policy.create',
        resourceType: 'configuration_policy',
        resourceId: policy.id,
        resourceName: policy.name,
        // Library model (#2280): partner-owned policies are created empty and
        // applied via explicit assignments on the Organizations panel.
        details: {
          ownerScope: 'partner',
          partnerId: auth.partnerId,
          parentPolicyId: policy.parentPolicyId ?? null,
        },
      });
      return c.json(policy, 201);
    }

    let orgId = data.orgId;
    if (auth.scope === 'organization') {
      // Org scope always owns the policy in its own org — a client-supplied
      // orgId is ignored so an org user can't create a policy in another org.
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        const accessibleOrgs = auth.accessibleOrgIds ?? [];
        const [onlyOrg] = accessibleOrgs;
        if (accessibleOrgs.length === 1 && onlyOrg) {
          orgId = onlyOrg;
        } else {
          // Distinguish "nothing to own it" from "ambiguous which org" so the
          // caller gets an actionable message rather than a misleading one.
          return c.json(
            {
              error:
                accessibleOrgs.length === 0
                  ? 'No accessible organization to own this policy'
                  : 'orgId is required when the partner has multiple organizations',
            },
            400
          );
        }
      }
      if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access to this organization denied' }, 403);
    } else if (auth.scope === 'system') {
      if (!orgId) return c.json({ error: 'orgId is required' }, 400);
      // System scope bypasses the org-access checks above, so a non-existent
      // orgId would otherwise fail as a raw FK 500 at insert time. Surface a
      // clean 404 instead. (System context sees all orgs — no RLS filter.)
      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!org) return c.json({ error: 'Organization not found' }, 404);
    }

    // Org-owned policies are intentionally NOT auto-assigned: an org policy is
    // commonly meant for a specific site/group/device, so auto-assigning it at
    // the org level would silently over-apply to every device in the org.
    // Library policies (#2280) — org-owned or partner-owned — are always
    // created empty; the user assigns them to a target explicitly afterward.
    let policy;
    try {
      policy = await createConfigPolicy({ orgId: orgId as string }, data, auth.user.id);
    } catch (err) {
      // One 400 for not-found / not-eligible / cross-tenant / has-own-parent, so
      // the response is not an existence oracle for policy ids.
      if (err instanceof InvalidParentPolicyError) {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      throw err;
    }

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.create',
      resourceType: 'configuration_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: { parentPolicyId: policy.parentPolicyId ?? null },
    });

    return c.json(policy, 201);
  }
);

// GET /eligible-parents — root policies this caller could inherit from.
//
// MUST stay above `GET /:id`, or Hono captures "eligible-parents" as an id.
// Returns NAMES ONLY. For an org-scoped caller this includes their partner's
// partner-wide policies — the one narrow widening of org-scoped read
// visibility, and the whole point of the feature (an org tech inheriting the
// MSP baseline). policyAccessCondition is NOT relaxed anywhere else.
crudRoutes.get(
  '/eligible-parents',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('query', eligibleParentsQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const sel = c.req.valid('query');

    if (sel.ownerScope === 'partner') {
      // An org token carries a partnerId but has no business enumerating the
      // partner library as a partner-wide author would.
      if (!auth.partnerId || auth.scope === 'organization') {
        return c.json({ error: 'Partner scope required' }, 403);
      }
    } else if (!auth.canAccessOrg(sel.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    return c.json({ data: await listEligibleParentPolicies(auth, sel) });
  }
);

// GET /:id — get configuration policy with feature links
crudRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    return c.json(policy);
  }
);

// PATCH /:id — update configuration policy metadata
crudRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', idParamSchema),
  zValidator('json', updateConfigPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    let updated;
    try {
      updated = await updateConfigPolicy(id, data, auth);
    } catch (err) {
      if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!updated) return c.json({ error: 'Configuration policy not found' }, 404);

    invalidateRemoteAccessCache();

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'config_policy.update',
      resourceType: 'configuration_policy',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(data) },
    });

    return c.json(updated);
  }
);

// DELETE /:id — delete configuration policy (cascades)
crudRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    let deleted;
    try {
      deleted = await deleteConfigPolicy(id, auth);
    } catch (err) {
      if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: err.message }, 403);
      // Deleting a baseline would un-configure every policy inheriting from it.
      // Name the blockers so the confirm modal can explain the refusal.
      if (err instanceof PolicyHasChildrenError) {
        return c.json({ error: err.code, children: err.children }, 409);
      }
      throw err;
    }
    if (!deleted) return c.json({ error: 'Configuration policy not found' }, 404);

    invalidateRemoteAccessCache();

    writeRouteAudit(c, {
      orgId: deleted.orgId,
      action: 'config_policy.delete',
      resourceType: 'configuration_policy',
      resourceId: deleted.id,
      resourceName: deleted.name,
    });

    return c.json({ success: true });
  }
);
