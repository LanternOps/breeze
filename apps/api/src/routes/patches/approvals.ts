import { Hono, type Context, type Next } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, desc } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { patches, patchApprovals } from '../../db/schema';
import {
  listApprovalsSchema,
  bulkApproveSchema,
  patchIdParamSchema,
  approvalActionSchema,
  deferSchema
} from './schemas';
import { getPagination, resolvePatchApprovalPartnerIdForRing, upsertPatchApproval } from './helpers';
import type { AuthContext } from '../../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';

export const approvalsRoutes = new Hono();

const requirePartnerWideApprovalAccess = async (c: Context, next: Next) => {
  if (!canManagePartnerWidePolicies(c.get('auth') as AuthContext)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  return next();
};

// GET /patches/approvals - List patch approvals for partner
approvalsRoutes.get(
  '/approvals',
  requireScope('partner', 'system'),
  zValidator('query', listApprovalsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const partnerResolution = await resolvePatchApprovalPartnerIdForRing(
      auth,
      query.partnerId ?? undefined,
      query.ringId ?? null
    );
    if ('error' in partnerResolution) {
      return c.json({ error: partnerResolution.error }, partnerResolution.status);
    }
    const targetPartnerId = partnerResolution.partnerId;

    const { page, limit, offset } = getPagination(query);

    const conditions = [eq(patchApprovals.partnerId, targetPartnerId)];
    if (query.ringId) conditions.push(eq(patchApprovals.ringId, query.ringId));
    if (query.status) conditions.push(eq(patchApprovals.status, query.status));
    if (query.patchId) conditions.push(eq(patchApprovals.patchId, query.patchId));

    const whereClause = and(...conditions);

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
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  requirePartnerWideApprovalAccess,
  zValidator('json', bulkApproveSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const partnerResolution = await resolvePatchApprovalPartnerIdForRing(
      auth,
      data.partnerId ?? c.req.query('partnerId') ?? undefined,
      data.ringId ?? null
    );
    if ('error' in partnerResolution) {
      return c.json({ error: partnerResolution.error }, partnerResolution.status);
    }
    const targetPartnerId = partnerResolution.partnerId;

    const approved: string[] = [];
    const failed: string[] = [];

    for (const patchId of data.patchIds) {
      try {
        await upsertPatchApproval({
          partnerId: targetPartnerId,
          patchId,
          ringId: data.ringId ?? null,
          status: 'approved',
          approvedBy: auth.user.id,
          approvedAt: new Date(),
          notes: data.note ?? null,
        }, auth);
        approved.push(patchId);
      } catch {
        failed.push(patchId);
      }
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'patch.bulk_approve',
      resourceType: 'patch',
      details: {
        partnerId: targetPartnerId,
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
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  requirePartnerWideApprovalAccess,
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const partnerResolution = await resolvePatchApprovalPartnerIdForRing(
      auth,
      data.partnerId ?? c.req.query('partnerId') ?? undefined,
      data.ringId ?? null
    );
    if ('error' in partnerResolution) {
      return c.json({ error: partnerResolution.error }, partnerResolution.status);
    }
    const targetPartnerId = partnerResolution.partnerId;

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
      partnerId: targetPartnerId,
      patchId: id,
      ringId: data.ringId ?? null,
      status: 'approved',
      approvedBy: auth.user.id,
      approvedAt: new Date(),
      notes: data.note ?? null,
    }, auth);

    writeRouteAudit(c, {
      orgId: null,
      action: 'patch.approve',
      resourceType: 'patch',
      resourceId: id,
      details: {
        partnerId: targetPartnerId,
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
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  requirePartnerWideApprovalAccess,
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const partnerResolution = await resolvePatchApprovalPartnerIdForRing(
      auth,
      data.partnerId ?? c.req.query('partnerId') ?? undefined,
      data.ringId ?? null
    );
    if ('error' in partnerResolution) {
      return c.json({ error: partnerResolution.error }, partnerResolution.status);
    }
    const targetPartnerId = partnerResolution.partnerId;

    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await upsertPatchApproval({
      partnerId: targetPartnerId,
      patchId: id,
      ringId: data.ringId ?? null,
      status: 'rejected',
      notes: data.note ?? null,
    }, auth);

    writeRouteAudit(c, {
      orgId: null,
      action: 'patch.decline',
      resourceType: 'patch',
      resourceId: id,
      details: {
        partnerId: targetPartnerId,
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
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  requirePartnerWideApprovalAccess,
  zValidator('param', patchIdParamSchema),
  zValidator('json', deferSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const partnerResolution = await resolvePatchApprovalPartnerIdForRing(
      auth,
      data.partnerId ?? c.req.query('partnerId') ?? undefined,
      data.ringId ?? null
    );
    if ('error' in partnerResolution) {
      return c.json({ error: partnerResolution.error }, partnerResolution.status);
    }
    const targetPartnerId = partnerResolution.partnerId;

    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await upsertPatchApproval({
      partnerId: targetPartnerId,
      patchId: id,
      ringId: data.ringId ?? null,
      status: 'deferred',
      deferUntil: new Date(data.deferUntil),
      notes: data.note ?? null,
    }, auth);

    writeRouteAudit(c, {
      orgId: null,
      action: 'patch.defer',
      resourceType: 'patch',
      resourceId: id,
      details: {
        partnerId: targetPartnerId,
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
