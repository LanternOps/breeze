import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../db';
import { patchPolicies } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';

export const patchPolicyRoutes = new Hono();

// ============================================
// Helper Functions
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

async function getPatchPolicyWithOrgCheck(
  policyId: string,
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [policy] = await db
    .select()
    .from(patchPolicies)
    .where(eq(patchPolicies.id, policyId))
    .limit(1);

  if (!policy) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(policy.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return policy;
}

// ============================================
// Validation Schemas
// ============================================

const listPatchPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional()
});

// ============================================
// Routes
//
// NOTE: Patch policies are now managed via the Configuration Policy system
// (configPolicyPatchSettings). These standalone patch policy routes remain
// for legacy compatibility. New integrations should use
// POST /configuration-policies/:id/patch-job instead.
// ============================================

// Apply auth middleware to all routes
patchPolicyRoutes.use('*', authMiddleware);

// GET /patch-policies - List patch policies for org
patchPolicyRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPatchPoliciesSchema),
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
      conditions.push(eq(patchPolicies.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(patchPolicies.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(patchPolicies.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(patchPolicies.orgId, query.orgId));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(patchPolicies.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patchPolicies)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const policies = await db
      .select()
      .from(patchPolicies)
      .where(whereCondition)
      .orderBy(desc(patchPolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: policies,
      pagination: { page, limit, total }
    });
  }
);

// POST, PATCH, DELETE routes have been removed.
// Patch policies are now managed via the Configuration Policy system.
// Use /configuration-policies and their feature links instead.

// GET /patch-policies/:id - Get policy details
patchPolicyRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');

    const policy = await getPatchPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Patch policy not found' }, 404);
    }

    return c.json(policy);
  }
);

