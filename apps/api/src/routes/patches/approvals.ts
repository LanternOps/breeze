import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';
import { patches, patchApprovals } from '../../db/schema';
import {
  listApprovalsSchema,
  bulkApproveSchema,
  patchIdParamSchema,
  approvalActionSchema,
  deferSchema
} from './schemas';
import { getPagination, resolvePatchApprovalOrgId, upsertPatchApproval } from './helpers';

export const approvalsRoutes = new Hono();

// GET /patches/approvals - List patch approvals for org
approvalsRoutes.get(
  '/approvals',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listApprovalsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // Check org access
    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const { page, limit, offset } = getPagination(query);

    const conditions = [];
    const orgCond = auth.orgCondition(patchApprovals.orgId);
    if (orgCond) conditions.push(orgCond);
    if (query.orgId) conditions.push(eq(patchApprovals.orgId, query.orgId));
    if (query.ringId) conditions.push(eq(patchApprovals.ringId, query.ringId));
    if (query.status) conditions.push(eq(patchApprovals.status, query.status));
    if (query.patchId) conditions.push(eq(patchApprovals.patchId, query.patchId));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const approvals = await db
      .select()
      .from(patchApprovals)
      .where(whereClause)
      .orderBy(desc(patchApprovals.createdAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patchApprovals)
      .where(whereClause);

    return c.json({
      data: approvals,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// POST /patches/bulk-approve - Bulk approve patches
approvalsRoutes.post(
  '/bulk-approve',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', bulkApproveSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

    const approved: string[] = [];
    const failed: string[] = [];

    for (const patchId of data.patchIds) {
      try {
        await upsertPatchApproval({
          orgId: targetOrgId,
          patchId,
          ringId: data.ringId ?? null,
          status: 'approved',
          approvedBy: auth.user.id,
          approvedAt: new Date(),
          notes: data.note ?? null,
        });
        approved.push(patchId);
      } catch {
        failed.push(patchId);
      }
    }

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.bulk_approve',
      resourceType: 'patch',
      details: {
        approvedCount: approved.length,
        failedCount: failed.length,
        patchIds: data.patchIds,
        ringId: data.ringId ?? null
      }
    });

    return c.json({ success: true, approved, failed });
  }
);

// POST /patches/:id/approve - Approve patch
approvalsRoutes.post(
  '/:id/approve',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

    // Verify patch exists
    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await upsertPatchApproval({
      orgId: targetOrgId,
      patchId: id,
      ringId: data.ringId ?? null,
      status: 'approved',
      approvedBy: auth.user.id,
      approvedAt: new Date(),
      notes: data.note ?? null,
    });

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.approve',
      resourceType: 'patch',
      resourceId: id,
      details: {
        note: data.note ?? null,
        ringId: data.ringId ?? null
      }
    });

    return c.json({ id, status: 'approved', ringId: data.ringId ?? null });
  }
);

// POST /patches/:id/decline - Decline patch
approvalsRoutes.post(
  '/:id/decline',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await upsertPatchApproval({
      orgId: targetOrgId,
      patchId: id,
      ringId: data.ringId ?? null,
      status: 'rejected',
      notes: data.note ?? null,
    });

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.decline',
      resourceType: 'patch',
      resourceId: id,
      details: {
        note: data.note ?? null,
        ringId: data.ringId ?? null
      }
    });

    return c.json({ id, status: 'declined', ringId: data.ringId ?? null });
  }
);

// POST /patches/:id/defer - Defer patch to later date
approvalsRoutes.post(
  '/:id/defer',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', deferSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await upsertPatchApproval({
      orgId: targetOrgId,
      patchId: id,
      ringId: data.ringId ?? null,
      status: 'deferred',
      deferUntil: new Date(data.deferUntil),
      notes: data.note ?? null,
    });

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.defer',
      resourceType: 'patch',
      resourceId: id,
      details: {
        deferUntil: data.deferUntil,
        note: data.note ?? null,
        ringId: data.ringId ?? null
      }
    });

    return c.json({
      id,
      status: 'deferred',
      deferUntil: data.deferUntil,
      ringId: data.ringId ?? null
    });
  }
);
