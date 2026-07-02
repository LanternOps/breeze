import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../../db';
import { escalationPolicies } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { listPoliciesSchema, createPolicySchema, updatePolicySchema } from './schemas';
import { getPagination, ensureOrgAccess, getEscalationPolicyWithOrgCheck } from './helpers';
import { PERMISSIONS } from '../../services/permissions';

export const policiesRoutes = new Hono();

const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

// GET /alerts/policies - List escalation policies
policiesRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(escalationPolicies.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(escalationPolicies.orgId, query.orgId));
      } else {
        // "All orgs" view: org-owned policies across accessible orgs PLUS
        // this partner's own partner-wide policies (org_id NULL, #2130).
        const orgIds = auth.accessibleOrgIds ?? [];
        const orgCondition = orgIds.length > 0
          ? inArray(escalationPolicies.orgId, orgIds)
          : undefined;
        const partnerCondition = auth.partnerId
          ? and(isNull(escalationPolicies.orgId), eq(escalationPolicies.partnerId, auth.partnerId))
          : undefined;
        const ownership = orgCondition && partnerCondition
          ? or(orgCondition, partnerCondition)
          : (orgCondition ?? partnerCondition);
        if (!ownership) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(ownership as ReturnType<typeof eq>);
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(escalationPolicies.orgId, query.orgId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(escalationPolicies)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get policies
    const policiesList = await db
      .select()
      .from(escalationPolicies)
      .where(whereCondition)
      .orderBy(desc(escalationPolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: policiesList,
      pagination: { page, limit, total }
    });
  }
);

// POST /alerts/policies - Create escalation policy
policiesRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Resolve the ownership axis (#2130): partner-wide creation requires the
    // partner-wide capability; the default path stays org-owned.
    let owner: { orgId: string | null; partnerId: string | null };
    if (data.ownerScope === 'partner') {
      if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      let orgId = data.orgId;
      if (auth.scope === 'organization') {
        if (!auth.orgId) {
          return c.json({ error: 'Organization context required' }, 403);
        }
        orgId = auth.orgId;
      } else if (auth.scope === 'partner') {
        if (!orgId) {
          const singleOrg = auth.accessibleOrgIds?.[0];
          if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
            orgId = singleOrg;
          } else {
            return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
          }
        }
        const hasAccess = ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
      } else if (auth.scope === 'system' && !orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }
      owner = { orgId: orgId!, partnerId: null };
    }

    const [policy] = await db
      .insert(escalationPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: data.name,
        steps: data.steps
      })
      .returning();
    if (!policy) {
      return c.json({ error: 'Failed to create escalation policy' }, 500);
    }

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'escalation_policy.create',
      resourceType: 'escalation_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: {
        stepCount: Array.isArray(policy.steps) ? policy.steps.length : undefined,
      },
    });

    return c.json(policy, 201);
  }
);

// PUT /alerts/policies/:id - Update escalation policy
policiesRoutes.put(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const policy = await getEscalationPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Escalation policy not found' }, 404);
    }

    // Partner-wide escalation policies are administrable only with the
    // partner-wide capability (#2130).
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.steps !== undefined) updates.steps = data.steps;

    const [updated] = await db
      .update(escalationPolicies)
      .set(updates)
      .where(eq(escalationPolicies.id, policyId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to update escalation policy' }, 500);
    }

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'escalation_policy.update',
      resourceType: 'escalation_policy',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(data),
      },
    });

    return c.json(updated);
  }
);

// DELETE /alerts/policies/:id - Delete escalation policy
policiesRoutes.delete(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id')!;

    const policy = await getEscalationPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Escalation policy not found' }, 404);
    }

    // Partner-wide escalation policies are administrable only with the
    // partner-wide capability (#2130).
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    await db
      .delete(escalationPolicies)
      .where(eq(escalationPolicies.id, policyId));

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'escalation_policy.delete',
      resourceType: 'escalation_policy',
      resourceId: policy.id,
      resourceName: policy.name,
    });

    return c.json({ success: true });
  }
);
