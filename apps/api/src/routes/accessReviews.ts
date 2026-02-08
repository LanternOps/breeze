import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import {
  accessReviews,
  accessReviewItems,
  users,
  roles,
  permissions,
  rolePermissions,
  partnerUsers,
  organizationUsers,
  organizations
} from '../db/schema';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';

export const accessReviewRoutes = new Hono();

accessReviewRoutes.use('*', authMiddleware);
accessReviewRoutes.use('*', async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.scope !== 'partner') {
    await next();
    return;
  }

  if (!auth.partnerId) {
    throw new HTTPException(403, { message: 'Partner context required' });
  }

  if (!Array.isArray(auth.accessibleOrgIds)) {
    await next();
    return;
  }

  const partnerOrgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, auth.partnerId));
  const hasFullPartnerAccess = partnerOrgRows.every((org) => auth.accessibleOrgIds.includes(org.id));

  if (!hasFullPartnerAccess) {
    throw new HTTPException(403, { message: 'Full partner organization access required' });
  }

  await next();
});

// Zod schemas for validation
const createReviewSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().optional(),
  dueDate: z.string().datetime().optional(),
  reviewerId: z.string().uuid().optional()
});

const updateItemSchema = z.object({
  decision: z.enum(['approved', 'revoked', 'pending']),
  notes: z.string().optional()
});

type ScopeContext =
  | { scope: 'partner'; partnerId: string }
  | { scope: 'organization'; orgId: string };

function getScopeContext(auth: { scope: string; partnerId: string | null; orgId: string | null }): ScopeContext {
  if (auth.scope === 'partner' && auth.partnerId) {
    return { scope: 'partner', partnerId: auth.partnerId };
  }

  if (auth.scope === 'organization' && auth.orgId) {
    return { scope: 'organization', orgId: auth.orgId };
  }

  throw new HTTPException(403, { message: 'Partner or organization context required' });
}

// GET /access-reviews - List access reviews
accessReviewRoutes.get(
  '/',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);

    let whereClause;
    if (scopeContext.scope === 'partner') {
      whereClause = eq(accessReviews.partnerId, scopeContext.partnerId);
    } else {
      whereClause = eq(accessReviews.orgId, scopeContext.orgId);
    }

    const reviews = await db
      .select({
        id: accessReviews.id,
        name: accessReviews.name,
        description: accessReviews.description,
        status: accessReviews.status,
        reviewerId: accessReviews.reviewerId,
        reviewerName: users.name,
        dueDate: accessReviews.dueDate,
        createdAt: accessReviews.createdAt,
        completedAt: accessReviews.completedAt
      })
      .from(accessReviews)
      .leftJoin(users, eq(accessReviews.reviewerId, users.id))
      .where(whereClause)
      .orderBy(accessReviews.createdAt);

    return c.json({ data: reviews });
  }
);

// POST /access-reviews - Create new review
accessReviewRoutes.post(
  '/',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', createReviewSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const data = c.req.valid('json');

    const result = await db.transaction(async (tx) => {
      // Create the access review
      const [review] = await tx
        .insert(accessReviews)
        .values({
          partnerId: scopeContext.scope === 'partner' ? scopeContext.partnerId : null,
          orgId: scopeContext.scope === 'organization' ? scopeContext.orgId : null,
          name: data.name,
          description: data.description,
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          reviewerId: data.reviewerId || auth.user.id,
          status: 'pending'
        })
        .returning();

      if (!review) {
        throw new HTTPException(500, { message: 'Failed to create access review' });
      }

      // Get all users in scope to generate review items
      let usersInScope: Array<{ userId: string; roleId: string }> = [];

      if (scopeContext.scope === 'partner') {
        usersInScope = await tx
          .select({
            userId: partnerUsers.userId,
            roleId: partnerUsers.roleId
          })
          .from(partnerUsers)
          .where(eq(partnerUsers.partnerId, scopeContext.partnerId));
      } else {
        usersInScope = await tx
          .select({
            userId: organizationUsers.userId,
            roleId: organizationUsers.roleId
          })
          .from(organizationUsers)
          .where(eq(organizationUsers.orgId, scopeContext.orgId));
      }

      // Create review items for each user
      if (usersInScope.length > 0) {
        await tx.insert(accessReviewItems).values(
          usersInScope.map((u) => ({
            reviewId: review.id,
            userId: u.userId,
            roleId: u.roleId,
            decision: 'pending' as const
          }))
        );
      }

      return { review, itemCount: usersInScope.length };
    });

    writeRouteAudit(c, {
      orgId: scopeContext.scope === 'organization' ? scopeContext.orgId : null,
      action: 'access_review.create',
      resourceType: 'access_review',
      resourceId: result.review.id,
      resourceName: result.review.name,
      details: { itemCount: result.itemCount }
    });

    return c.json(
      {
        id: result.review.id,
        name: result.review.name,
        status: result.review.status,
        itemCount: result.itemCount
      },
      201
    );
  }
);

// GET /access-reviews/:id - Get review with items
accessReviewRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const reviewId = c.req.param('id');

    // Get the review
    let whereClause;
    if (scopeContext.scope === 'partner') {
      whereClause = and(
        eq(accessReviews.id, reviewId),
        eq(accessReviews.partnerId, scopeContext.partnerId)
      );
    } else {
      whereClause = and(
        eq(accessReviews.id, reviewId),
        eq(accessReviews.orgId, scopeContext.orgId)
      );
    }

    const [review] = await db
      .select({
        id: accessReviews.id,
        name: accessReviews.name,
        description: accessReviews.description,
        status: accessReviews.status,
        reviewerId: accessReviews.reviewerId,
        dueDate: accessReviews.dueDate,
        createdAt: accessReviews.createdAt,
        completedAt: accessReviews.completedAt
      })
      .from(accessReviews)
      .where(whereClause)
      .limit(1);

    if (!review) {
      return c.json({ error: 'Access review not found' }, 404);
    }

    // Get the review items with user and role details
    const items = await db
      .select({
        id: accessReviewItems.id,
        userId: accessReviewItems.userId,
        userName: users.name,
        userEmail: users.email,
        lastActiveAt: users.lastLoginAt,
        roleId: accessReviewItems.roleId,
        roleName: roles.name,
        decision: accessReviewItems.decision,
        notes: accessReviewItems.notes,
        reviewedAt: accessReviewItems.reviewedAt
      })
      .from(accessReviewItems)
      .innerJoin(users, eq(accessReviewItems.userId, users.id))
      .innerJoin(roles, eq(accessReviewItems.roleId, roles.id))
      .where(eq(accessReviewItems.reviewId, reviewId));

    const roleIds = Array.from(new Set(items.map((item) => item.roleId)));
    const permissionsByRole = new Map<string, string[]>();

    if (roleIds.length > 0) {
      const rolePermissionRows = await db
        .select({
          roleId: rolePermissions.roleId,
          resource: permissions.resource,
          action: permissions.action
        })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(inArray(rolePermissions.roleId, roleIds));

      rolePermissionRows.forEach((row) => {
        const list = permissionsByRole.get(row.roleId) ?? [];
        list.push(`${row.resource}:${row.action}`);
        permissionsByRole.set(row.roleId, list);
      });
    }

    const itemsWithPermissions = items.map((item) => ({
      ...item,
      permissions: permissionsByRole.get(item.roleId) ?? []
    }));

    return c.json({
      ...review,
      items: itemsWithPermissions
    });
  }
);

// PATCH /access-reviews/:id/items/:itemId - Update decision on an item
accessReviewRoutes.patch(
  '/:id/items/:itemId',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', updateItemSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const reviewId = c.req.param('id');
    const itemId = c.req.param('itemId');
    const data = c.req.valid('json');

    // Verify the review belongs to this scope
    let whereClause;
    if (scopeContext.scope === 'partner') {
      whereClause = and(
        eq(accessReviews.id, reviewId),
        eq(accessReviews.partnerId, scopeContext.partnerId)
      );
    } else {
      whereClause = and(
        eq(accessReviews.id, reviewId),
        eq(accessReviews.orgId, scopeContext.orgId)
      );
    }

    const [review] = await db
      .select({ id: accessReviews.id, status: accessReviews.status })
      .from(accessReviews)
      .where(whereClause)
      .limit(1);

    if (!review) {
      return c.json({ error: 'Access review not found' }, 404);
    }

    if (review.status === 'completed') {
      return c.json({ error: 'Cannot modify completed review' }, 400);
    }

    // Update the item
    const [updated] = await db
      .update(accessReviewItems)
      .set({
        decision: data.decision,
        notes: data.notes,
        reviewedAt: new Date(),
        reviewedBy: auth.user.id
      })
      .where(
        and(
          eq(accessReviewItems.id, itemId),
          eq(accessReviewItems.reviewId, reviewId)
        )
      )
      .returning({
        id: accessReviewItems.id,
        decision: accessReviewItems.decision,
        notes: accessReviewItems.notes,
        reviewedAt: accessReviewItems.reviewedAt
      });

    if (!updated) {
      return c.json({ error: 'Review item not found' }, 404);
    }

    // Update review status to in_progress if still pending
    if (review.status === 'pending') {
      await db
        .update(accessReviews)
        .set({ status: 'in_progress', updatedAt: new Date() })
        .where(eq(accessReviews.id, reviewId));
    }

    writeRouteAudit(c, {
      orgId: scopeContext.scope === 'organization' ? scopeContext.orgId : null,
      action: 'access_review.item.update',
      resourceType: 'access_review_item',
      resourceId: updated.id,
      details: {
        reviewId,
        decision: data.decision
      }
    });

    return c.json(updated);
  }
);

// POST /access-reviews/:id/complete - Mark review as complete and apply revocations
accessReviewRoutes.post(
  '/:id/complete',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const reviewId = c.req.param('id');

    // Verify the review belongs to this scope
    let whereClause;
    if (scopeContext.scope === 'partner') {
      whereClause = and(
        eq(accessReviews.id, reviewId),
        eq(accessReviews.partnerId, scopeContext.partnerId)
      );
    } else {
      whereClause = and(
        eq(accessReviews.id, reviewId),
        eq(accessReviews.orgId, scopeContext.orgId)
      );
    }

    const [review] = await db
      .select({ id: accessReviews.id, status: accessReviews.status })
      .from(accessReviews)
      .where(whereClause)
      .limit(1);

    if (!review) {
      return c.json({ error: 'Access review not found' }, 404);
    }

    if (review.status === 'completed') {
      return c.json({ error: 'Review is already completed' }, 400);
    }

    // Check if there are any pending items
    const pendingItems = await db
      .select({ id: accessReviewItems.id })
      .from(accessReviewItems)
      .where(
        and(
          eq(accessReviewItems.reviewId, reviewId),
          eq(accessReviewItems.decision, 'pending')
        )
      )
      .limit(1);

    if (pendingItems.length > 0) {
      return c.json({ error: 'Cannot complete review with pending items' }, 400);
    }

    // Get all revoked items
    const revokedItems = await db
      .select({
        userId: accessReviewItems.userId
      })
      .from(accessReviewItems)
      .where(
        and(
          eq(accessReviewItems.reviewId, reviewId),
          eq(accessReviewItems.decision, 'revoked')
        )
      );

    const result = await db.transaction(async (tx) => {
      // Apply revocations - remove users from the scope
      if (revokedItems.length > 0) {
        const revokedUserIds = revokedItems.map((item) => item.userId);

        if (scopeContext.scope === 'partner') {
          await tx
            .delete(partnerUsers)
            .where(
              and(
                eq(partnerUsers.partnerId, scopeContext.partnerId),
                inArray(partnerUsers.userId, revokedUserIds)
              )
            );
        } else {
          await tx
            .delete(organizationUsers)
            .where(
              and(
                eq(organizationUsers.orgId, scopeContext.orgId),
                inArray(organizationUsers.userId, revokedUserIds)
              )
            );
        }
      }

      // Mark review as completed
      const [updatedReview] = await tx
        .update(accessReviews)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(accessReviews.id, reviewId))
        .returning({
          id: accessReviews.id,
          status: accessReviews.status,
          completedAt: accessReviews.completedAt
        });

      if (!updatedReview) {
        throw new HTTPException(500, { message: 'Failed to complete review' });
      }

      return {
        review: updatedReview,
        revokedCount: revokedItems.length
      };
    });

    writeRouteAudit(c, {
      orgId: scopeContext.scope === 'organization' ? scopeContext.orgId : null,
      action: 'access_review.complete',
      resourceType: 'access_review',
      resourceId: result.review.id,
      details: { revokedCount: result.revokedCount }
    });

    return c.json({
      id: result.review.id,
      status: result.review.status,
      completedAt: result.review.completedAt,
      revokedCount: result.revokedCount
    });
  }
);
