import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../db';
import { patchPolicies, organizations } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const patchPolicyRoutes = new Hono();

// ============================================
// Helper Functions
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getPatchPolicyWithOrgCheck(policyId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
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

const patchSourceValues = ['microsoft', 'apple', 'linux', 'third_party', 'custom'] as const;

const listPatchPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional()
});

const createPatchPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  targets: z.any(),
  sources: z.array(z.enum(patchSourceValues)).min(1),
  autoApprove: z.any().optional(),
  schedule: z.any(),
  rebootPolicy: z.any().optional(),
  enabled: z.boolean().optional(),
  rollbackOnFailure: z.boolean().optional(),
  preInstallScript: z.string().uuid().optional(),
  postInstallScript: z.string().uuid().optional(),
  notifyOnComplete: z.boolean().optional()
});

const updatePatchPolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  targets: z.any().optional(),
  sources: z.array(z.enum(patchSourceValues)).min(1).optional(),
  autoApprove: z.any().optional(),
  schedule: z.any().optional(),
  rebootPolicy: z.any().optional(),
  enabled: z.boolean().optional(),
  rollbackOnFailure: z.boolean().optional(),
  preInstallScript: z.string().uuid().nullable().optional(),
  postInstallScript: z.string().uuid().nullable().optional(),
  notifyOnComplete: z.boolean().optional()
});

// ============================================
// Routes
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
        // Get patch policies from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
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

// POST /patch-policies - Create policy
patchPolicyRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPatchPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [policy] = await db
      .insert(patchPolicies)
      .values({
        orgId: orgId!,
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        targets: data.targets,
        sources: data.sources,
        autoApprove: data.autoApprove,
        schedule: data.schedule,
        rebootPolicy: data.rebootPolicy,
        rollbackOnFailure: data.rollbackOnFailure,
        preInstallScript: data.preInstallScript,
        postInstallScript: data.postInstallScript,
        notifyOnComplete: data.notifyOnComplete,
        createdBy: auth.user.id
      })
      .returning();

    return c.json(policy, 201);
  }
);

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

// PATCH /patch-policies/:id - Update policy
patchPolicyRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updatePatchPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const policy = await getPatchPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Patch policy not found' }, 404);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.targets !== undefined) updates.targets = data.targets;
    if (data.sources !== undefined) updates.sources = data.sources;
    if (data.autoApprove !== undefined) updates.autoApprove = data.autoApprove;
    if (data.schedule !== undefined) updates.schedule = data.schedule;
    if (data.rebootPolicy !== undefined) updates.rebootPolicy = data.rebootPolicy;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.rollbackOnFailure !== undefined) updates.rollbackOnFailure = data.rollbackOnFailure;
    if (data.preInstallScript !== undefined) updates.preInstallScript = data.preInstallScript;
    if (data.postInstallScript !== undefined) updates.postInstallScript = data.postInstallScript;
    if (data.notifyOnComplete !== undefined) updates.notifyOnComplete = data.notifyOnComplete;

    const [updated] = await db
      .update(patchPolicies)
      .set(updates)
      .where(eq(patchPolicies.id, policyId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /patch-policies/:id - Delete policy
patchPolicyRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');

    const policy = await getPatchPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Patch policy not found' }, 404);
    }

    await db
      .delete(patchPolicies)
      .where(eq(patchPolicies.id, policyId));

    return c.json({ success: true });
  }
);
