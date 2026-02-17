import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, automationPolicyCompliance, scripts } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import {
  AuthContext,
  listPoliciesSchema,
  policyIdSchema,
} from './schemas';
import {
  getPagination,
  ensureOrgAccess,
  getPolicyWithOrgCheck,
  normalizePolicyResponse,
  getPolicyComplianceMap,
  buildComplianceSummary,
} from './helpers';

export const crudRoutes = new Hono();

// GET /policies (read-only)
crudRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: ReturnType<typeof eq>[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(automationPolicies.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(automationPolicies.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(inArray(automationPolicies.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(automationPolicies.orgId, query.orgId));
    }

    if (query.enforcement) {
      conditions.push(eq(automationPolicies.enforcement, query.enforcement));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(automationPolicies.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationPolicies)
      .where(whereCondition);

    const total = Number(countResult[0]?.count ?? 0);

    const policiesList = await db
      .select()
      .from(automationPolicies)
      .where(whereCondition)
      .orderBy(desc(automationPolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    const complianceMap = await getPolicyComplianceMap(policiesList.map((policy) => policy.id));

    return c.json({
      data: policiesList.map((policy) => normalizePolicyResponse(policy, complianceMap.get(policy.id))),
      pagination: { page, limit, total },
    });
  }
);

// GET /policies/:id (read-only)
crudRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    if (['compliance'].includes(id)) {
      return c.notFound();
    }

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const complianceRows = await db
      .select({
        status: automationPolicyCompliance.status,
        count: sql<number>`count(*)`,
      })
      .from(automationPolicyCompliance)
      .where(eq(automationPolicyCompliance.policyId, id))
      .groupBy(automationPolicyCompliance.status);

    let remediationScript: { id: string; name: string } | null = null;
    if (policy.remediationScriptId) {
      const [script] = await db
        .select({ id: scripts.id, name: scripts.name })
        .from(scripts)
        .where(eq(scripts.id, policy.remediationScriptId))
        .limit(1);

      remediationScript = script ?? null;
    }

    return c.json(normalizePolicyResponse(policy, buildComplianceSummary(complianceRows), remediationScript));
  }
);

// POST, PUT, PATCH, DELETE routes have been removed.
// Compliance/automation policies are now managed via the configuration policy system.
// Use POST/PUT/PATCH/DELETE on /configuration-policies and their feature links instead.
// The GET routes above are preserved as read-only for backward compatibility.
